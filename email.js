// Email via SMTP. Built the same way as sms.js: no npm dependency, just a small
// client speaking SMTP over TLS. Google Workspace, Outlook and most hosts work with
// the same four values — host, port, username, app password.
//
// Two outbound identities, because routine correspondence and a serious late notice
// should not arrive from the same place:
//
//   servicing  — statements, receipts, payoff quotes, general correspondence
//   legal      — late notices at LEGAL_NOTICE_DAYS or more past due
//
// A company's own settings win; the environment is the fallback, so the platform can
// carry a default while each servicer can still use their own domain.
//
// Nothing blocks on email being configured. If it isn't, the notice is still recorded,
// still lands in the buyer's app, and still pushes — the email is an extra channel,
// never the only one.

const tls = require('node:tls');
const net = require('node:net');
const crypto = require('node:crypto');
const { get, run } = require('./db');

// ---------- credentials ----------
// identity is 'servicing' or 'legal'. The legal address may carry its own username and
// password (two separate mailboxes), or share the main account (one mailbox with a
// "send as" alias configured). Both setups are common; both work here.
function creds(company, identity = 'servicing') {
  const co = company || {};
  const host = co.smtp_host || process.env.SMTP_HOST;
  const port = Number(co.smtp_port || process.env.SMTP_PORT || 465);
  const user = co.smtp_user || process.env.SMTP_USER;
  const pass = co.smtp_pass || process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  const servicingFrom = co.email_from_servicing || process.env.EMAIL_FROM_SERVICING || user;
  const legalFrom = co.email_from_legal || process.env.EMAIL_FROM_LEGAL || servicingFrom;

  if (identity === 'legal') {
    return {
      host, port,
      user: co.email_legal_user || process.env.EMAIL_LEGAL_USER || user,
      pass: co.email_legal_pass || process.env.EMAIL_LEGAL_PASS || pass,
      from: legalFrom,
      replyTo: co.email_reply_to || process.env.EMAIL_REPLY_TO || servicingFrom,
      source: co.smtp_host ? 'company' : 'env',
    };
  }
  return {
    host, port, user, pass,
    from: servicingFrom,
    replyTo: null,
    source: co.smtp_host ? 'company' : 'env',
  };
}

const emailEnabled = (company) => !!creds(company);

// ---------- which identity sends this ----------
// The single place that decides. Called at SEND time, not when a message is queued —
// something drafted at day 28 that goes out at day 31 must come from the legal address.
const LEGAL_KINDS = new Set(['legal_notice', 'default_notice', 'forfeiture_notice']);

function identityFor({ kind, daysPastDue, identity } = {}) {
  // An explicit choice wins — the late-notice ladder names the address it wants for
  // each rung rather than inferring it.
  if (identity === 'legal' || identity === 'servicing') return identity;
  if (kind && LEGAL_KINDS.has(kind)) return 'legal';
  const threshold = Number(process.env.LEGAL_NOTICE_DAYS || 30);
  if (typeof daysPastDue === 'number' && daysPastDue >= threshold) return 'legal';
  return 'servicing';
}

// ---------- address handling ----------
function validAddress(raw) {
  const s = String(raw || '').trim();
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s) ? s : null;
}

// RFC 2047 for non-ASCII subjects and display names, so accented characters survive.
function encodeHeader(text) {
  const s = String(text || '');
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function formatFrom(address, displayName) {
  return displayName ? `${encodeHeader(displayName)} <${address}>` : address;
}

// Quoted-printable keeps long HTML inside SMTP's 998-character line limit without
// base64's size penalty, and leaves the body readable in a raw dump.
function quotedPrintable(input) {
  const bytes = Buffer.from(String(input), 'utf8');
  let out = '';
  let lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let chunk;
    if (b === 13) continue;                       // strip CR; we re-add CRLF below
    if (b === 10) { out += '\r\n'; lineLen = 0; continue; }
    if (b === 61) chunk = '=3D';                  // '='
    else if (b >= 33 && b <= 126) chunk = String.fromCharCode(b);
    else if (b === 32 || b === 9) {
      // a trailing space or tab must be encoded, otherwise it is stripped in transit
      const next = bytes[i + 1];
      chunk = (next === 10 || next === 13 || next === undefined)
        ? '=' + b.toString(16).toUpperCase().padStart(2, '0')
        : String.fromCharCode(b);
    } else chunk = '=' + b.toString(16).toUpperCase().padStart(2, '0');

    if (lineLen + chunk.length > 75) { out += '=\r\n'; lineLen = 0; }
    out += chunk;
    lineLen += chunk.length;
  }
  return out;
}

function buildMessage({ from, fromName, to, replyTo, subject, text, html }) {
  const boundary = 'pp_' + crypto.randomBytes(16).toString('hex');
  const domain = String(from).split('@')[1] || 'porchpay.local';
  const headers = [
    `From: ${formatFrom(from, fromName)}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',   // stops out-of-office loops
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');

  const plain = text || String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(plain),
  ];
  if (html) {
    parts.push(
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(html),
    );
  }
  parts.push(`--${boundary}--`, '');
  return headers + '\r\n\r\n' + parts.join('\r\n');
}

// ---------- minimal SMTP conversation ----------
// Port 465 is implicit TLS; anything else starts plain and upgrades with STARTTLS.
// Both paths refuse to send credentials over an unencrypted socket.
function smtpConverse({ host, port, user, pass, from, to, data, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const implicitTls = Number(port) === 465;
    let socket = implicitTls
      ? tls.connect({ host, port: Number(port), servername: host })
      : net.connect({ host, port: Number(port) });

    let buffer = '';
    let settled = false;
    let queue = [];
    let step = 0;
    let secure = implicitTls;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch {}
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(
        `No answer from ${host} on port ${port} within ${timeoutMs / 1000} seconds. ` +
        `If port 465 is blocked where this is hosted, try 587 instead.`)),
      timeoutMs);

    const send = (line) => socket.write(line + '\r\n');

    // AUTH LOGIN is the widest-supported mechanism and is what Google expects with
    // an app password. PLAIN is offered as a fallback for hosts that prefer it.
    const buildQueue = () => ([
      { expect: 250, send: `EHLO ${host}` },
      ...(secure ? [] : [{ expect: 220, send: 'STARTTLS', upgrade: true }]),
      { expect: 334, send: 'AUTH LOGIN' },
      { expect: 334, send: Buffer.from(user, 'utf8').toString('base64') },
      { expect: 235, send: Buffer.from(pass, 'utf8').toString('base64') },
      { expect: 250, send: `MAIL FROM:<${from}>` },
      { expect: 250, send: `RCPT TO:<${to}>` },
      { expect: 354, send: 'DATA' },
      // SMTP ends the body with a lone dot, so any line that is already a lone dot
      // has to be escaped or it truncates the message.
      { expect: 250, send: data.replace(/\r\n\./g, '\r\n..') + '\r\n.' },
      { expect: 221, send: 'QUIT' },
    ]);

    const attach = () => {
      socket.setEncoding('utf8');
      socket.on('data', onData);
      socket.on('error', (e) => { clearTimeout(timer); finish(new Error(smtpError(e.message, null, e.code))); });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) finish(new Error('The mail server closed the connection unexpectedly.'));
      });
    };

    function onData(chunk) {
      buffer += chunk;
      // A reply is complete when a line reads "250 text" rather than "250-text".
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || /^\d{3}-/.test(last)) return;
      const code = Number(last.slice(0, 3));
      const text = lines.join(' ');
      buffer = '';

      if (step === 0) {
        if (code !== 220) { clearTimeout(timer); return finish(new Error(smtpError(text, code))); }
        queue = buildQueue();
        step = 1;
        return send(queue[0].send);
      }

      const current = queue[step - 1];
      if (code !== current.expect) {
        clearTimeout(timer);
        return finish(new Error(smtpError(text, code)));
      }

      if (current.upgrade) {
        socket.removeAllListeners('data');
        socket = tls.connect({ socket, host, servername: host }, () => {
          secure = true;
          queue = buildQueue();          // re-EHLO over the encrypted channel
          step = 1;
          attach();
          send(queue[0].send);
        });
        socket.on('error', (e) => { clearTimeout(timer); finish(new Error(smtpError(e.message, null, e.code))); });
        step = 1;
        return;
      }

      if (step >= queue.length) { clearTimeout(timer); return finish(null, { ok: true }); }
      const next = queue[step];
      step += 1;
      send(next.send);
    }

    attach();
  });
}

// SMTP codes are as opaque as Twilio's. Translate the ones that actually happen.
function smtpError(text, code, errCode) {
  const t = String(text || '');
  if (/535|Username and Password not accepted|BadCredentials/i.test(t)) {
    return 'The mail server rejected the username or password. For Google Workspace you must use a 16-character App Password, not your normal account password — and 2-Step Verification has to be on first.';
  }
  if (/534|Application-specific password required/i.test(t)) {
    return 'Google needs an App Password for this account. Turn on 2-Step Verification, then create one under Google Account → Security → App passwords.';
  }
  if (/550|5\.7\.1|not allowed to send as/i.test(t)) {
    return 'The server refused the "from" address. If you are sending as an alias, add it in Gmail under Settings → Accounts → Send mail as, and verify it.';
  }
  if (/553|5\.1\.[78]/i.test(t)) return 'The "from" address was rejected as invalid by the mail server.';
  if (/552|5\.3\.4|message too large/i.test(t)) return 'The message was too large for the mail server.';
  if (/421|4\.7\.0|Try again later|rate/i.test(t)) {
    return 'The mail server is rate limiting. Google Workspace caps how many messages an account can send per day — space out the send or use a dedicated sending account.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(t)) return 'That mail server hostname could not be found. Check the SMTP host.';
  if (/ECONNREFUSED/i.test(t)) return 'The mail server refused the connection. Check the port — Google Workspace uses 465.';
  if (/ETIMEDOUT|timed out/i.test(t)) return 'The mail server did not respond. Check the host and port.';
  if (/self.signed|certificate/i.test(t)) return 'The mail server presented a certificate that could not be verified.';

  // Network-level failures arrive as a code with little or no text. Say what the code
  // means rather than passing an empty string up to the screen.
  const byCode = {
    ECONNREFUSED: 'The mail server refused the connection. Check the port — Google Workspace uses 465, or try 587.',
    ETIMEDOUT: 'The connection timed out. Some hosts block outbound mail ports; if 465 is blocked, try 587.',
    ECONNRESET: 'The connection was closed by the other end before anything was sent. This is usually an outbound port being blocked.',
    EHOSTUNREACH: 'That mail server could not be reached from this network.',
    ENETUNREACH: 'That mail server could not be reached from this network.',
    EAI_AGAIN: 'The mail server hostname could not be looked up. Check the spelling of the mail server.',
    ENOTFOUND: 'That mail server hostname does not exist. Check the spelling.',
    EPIPE: 'The connection dropped mid-conversation.',
  };
  if (errCode && byCode[errCode]) return byCode[errCode];
  if (code) return `Mail server error ${code}: ${t}`.slice(0, 300);
  if (t.trim()) return t.slice(0, 300);
  // Last resort: never hand back an empty string.
  return `The mail server closed the connection without explaining why${errCode ? ` (${errCode})` : ''}. ` +
    'This most often means the outbound mail port is blocked where the app is hosted.';
}

// ---------- public API ----------
// kind and daysPastDue pick the identity. Everything is logged either way, because for a
// late notice the record that it was sent is part of the file.
async function sendEmail(to, { subject, text, html, kind, daysPastDue, identity: want, loanId, companyId }, company) {
  const address = validAddress(to);
  const identity = identityFor({ kind, daysPastDue, identity: want });
  const c = creds(company, identity);

  const logFailure = (message) => {
    try {
      run(`INSERT INTO email_log (company_id, loan_id, identity, to_address, subject, kind, status, error)
           VALUES (?,?,?,?,?,?, 'failed', ?)`,
        companyId || (company && company.id) || null, loanId || null, identity,
        String(to || ''), subject || '', kind || null, message);
    } catch {}
  };

  if (!address) { logFailure('Invalid email address'); throw new Error('That email address does not look valid'); }
  if (!c) {
    logFailure('Email not connected');
    throw new Error('Email is not connected yet — add your mail settings under Settings → Email');
  }

  const fromName = (company && (company.mgmt_company_name || company.name)) || process.env.COMPANY_NAME || 'Porch Pay';
  const data = buildMessage({
    from: c.from, fromName, to: address, replyTo: c.replyTo, subject, text, html,
  });

  try {
    await smtpConverse({ host: c.host, port: c.port, user: c.user, pass: c.pass,
                         from: c.from, to: address, data });
  } catch (e) {
    logFailure(e.message);
    throw e;
  }

  try {
    run(`INSERT INTO email_log (company_id, loan_id, identity, to_address, from_address, subject, kind, status)
         VALUES (?,?,?,?,?,?,?, 'sent')`,
      companyId || (company && company.id) || null, loanId || null, identity,
      address, c.from, subject || '', kind || null);
  } catch {}

  return { ok: true, to: address, from: c.from, identity };
}

// Credential check that proves the whole path without mailing a stranger: it opens the
// session, authenticates, then quits before any message is queued.
async function verifyCreds({ host, port, user, pass, from }) {
  if (!host || !user || !pass) throw new Error('Host, username and password are all needed');
  const address = validAddress(from || user);
  if (!address) throw new Error('The "from" address does not look valid');
  await smtpConverse({
    host, port: port || 465, user, pass, from: address, to: address,
    data: buildMessage({ from: address, fromName: 'Porch Pay',
      to: address, subject: 'Porch Pay connection test',
      text: 'This message confirms Porch Pay can send email from this account.' }),
  });
  return { host, from: address };
}

module.exports = {
  emailEnabled, sendEmail, verifyCreds, creds, identityFor,
  validAddress, buildMessage, quotedPrintable,
};
