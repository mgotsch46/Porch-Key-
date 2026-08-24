// Loan Servicing App — Express server
// Tenant buyer app served at "/", admin portal at "/admin".
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, get, all, run, hashPassword, verifyPassword } = require('./db');
const loanEngine = require('./loan');
const pay = require('./payments');
const ai = require('./ai');
const sms = require('./sms');
const email = require('./email');
const reports = require('./reports');
const tpl = require('./templates');
const addr = require('./address');
const notify = require('./notify');
const journal = require('./journal');

// Double-entry books. Created on boot alongside everything else in db.js, so an
// existing deployment picks them up on the next restart with nothing to run by hand.
journal.initSchema();

// Migrate the old money tables into the journal the first time only. The old tables
// stay in charge until the reconciliation is clean and reads are switched over, so a
// bad migration cannot take the app down with it.
const backfill = require('./backfill');
backfill.maybeRunOnBoot();

const pdfDoc = require('./pdf');
const lob = require('./lob');
const dc101 = require('./dc101');
const guide = require('./guide');
const escrow = require('./escrow');
escrow.initSchema();

// Bills that are coming get a task fifteen working days ahead of them. Runs on boot and
// once a day; it is idempotent, so running it often costs nothing.
function syncAllPrepTasks() {
  for (const co of all('SELECT id FROM companies')) {
    try {
      const n = escrow.syncPrepTasks(co.id);
      if (n) console.log(`Created ${n} tax/insurance prep task(s) for company ${co.id}`);
    } catch (e) { console.error('Prep task sync failed for company', co.id, e.message); }
  }
}
setTimeout(syncAllPrepTasks, 8000);
setInterval(syncAllPrepTasks, 24 * 60 * 60 * 1000);

const payoff = require('./payoff');
payoff.initSchema();

const noticeRules = require('./notices');
noticeRules.initSchema();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- auth ----------
function secret() {
  let s = get("SELECT value FROM settings WHERE key='secret'");
  if (!s) {
    const v = crypto.randomBytes(32).toString('hex');
    run("INSERT INTO settings (key,value) VALUES ('secret',?)", v);
    return v;
  }
  return s.value;
}
const SECRET = process.env.APP_SECRET || secret();

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
  if (payload.exp < Date.now()) return null;
  return payload;
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
// Current published version of the buyer Terms + Privacy Policy. Bump this string
// whenever the legal text changes and every buyer is re-prompted to accept.
const TERMS_VERSION = process.env.TERMS_VERSION || '2026-08-09';

// roles: 'super_admin' (platform), 'owner'/'admin' (a servicing company), 'tenant' (buyer)
const ADMIN_ROLES = ['owner', 'admin'];
function auth(kind) {
  return (req, res, next) => {
    const payload = verifyToken(getCookie(req, 'session'));
    if (!payload) return res.status(401).json({ error: 'Not signed in' });
    const user = get(`SELECT id, company_id, email, role, name, phone, must_change_password,
      terms_accepted_at, terms_version, location_consent_at, deleted_at, archived_at
      FROM users WHERE id=?`, payload.uid);
    if (!user || user.deleted_at) return res.status(401).json({ error: 'Not signed in' });
    if (user.archived_at) return res.status(403).json({ error: 'This account is archived. Contact your servicer.' });
    if (kind === 'admin' && !ADMIN_ROLES.includes(user.role)) return res.status(403).json({ error: 'Forbidden' });
    if (kind === 'owner' && user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    if (kind === 'super' && user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    if (kind === 'tenant' && user.role !== 'tenant') return res.status(403).json({ error: 'Forbidden' });
    if (ADMIN_ROLES.includes(user.role)) {
      const co = get('SELECT status FROM companies WHERE id=?', user.company_id);
      if (co && co.status === 'suspended') return res.status(403).json({ error: 'This account is suspended.' });
    }
    req.user = user;
    req.companyId = user.company_id;
    next();
  };
}
const adminOnly = auth('admin');
const ownerOnly = auth('owner');
const superOnly = auth('super');
const tenantOnly = auth('tenant');
const anyUser = auth(null);

// Buyers must accept Terms + Privacy before any loan data, messaging, or payment route.
function requireTerms(req, res, next) {
  if (req.user.role === 'tenant' && (!req.user.terms_accepted_at || req.user.terms_version !== TERMS_VERSION)) {
    return res.status(451).json({ error: 'Terms acceptance required', terms_version: TERMS_VERSION });
  }
  next();
}
const tenantReady = [tenantOnly, requireTerms];

// Every admin read/write is scoped to the signed-in user's company. These helpers make
// that the default path so a missing WHERE clause can't leak another company's data.
function ownedLoan(req, id) {
  return get('SELECT * FROM loans WHERE id=? AND company_id=?', id, req.companyId);
}
function ownedProperty(req, id) {
  return get('SELECT * FROM properties WHERE id=? AND company_id=?', id, req.companyId);
}

// ---------- stripe webhook needs raw body, mount before json parser ----------
app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const payload = req.body.toString('utf8');
  if (whSecret && !pay.verifyStripeSignature(payload, req.headers['stripe-signature'], whSecret)) {
    return res.status(400).send('Bad signature');
  }
  try {
    const event = JSON.parse(payload);
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.payment_status === 'paid' && s.metadata && s.metadata.loan_id) {
        postStripePayment(s);
      }
    }
    res.json({ received: true });
  } catch (e) {
    res.status(400).send('Bad payload');
  }
});

// ---------- email delivery webhook, also raw-body for its signature ----------
// What became of each notice. For an ordinary receipt this is a nicety; for a 30-day
// default notice, "delivered at 09:14 on the 3rd" is the difference between believing
// it arrived and being able to show it did. Bounces matter as much — an address that
// hard-bounces means the buyer never got the notice, and carrying on as though they
// did is how a forfeiture gets unwound.
app.post('/api/email/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const payload = req.body.toString('utf8');
  let ev;
  try { ev = JSON.parse(payload); } catch { return res.status(400).send('Bad payload'); }

  const messageId = ev && ev.data && ev.data.email_id;
  if (!messageId) return res.json({ received: true });

  const row = get('SELECT id, company_id FROM email_log WHERE provider_message_id=?', messageId);
  if (!row) return res.json({ received: true });   // not ours, or already pruned

  // Signature is checked against the secret belonging to the company that sent it, so
  // one tenant's secret cannot be used to write delivery history onto another's mail.
  const co = get('SELECT email_webhook_secret FROM companies WHERE id=?', row.company_id);
  const secret = (co && co.email_webhook_secret) || process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const okSig = email.verifyWebhook({
      secret, body: payload,
      id: req.headers['svix-id'], timestamp: req.headers['svix-timestamp'],
      signature: req.headers['svix-signature'],
    });
    if (!okSig) return res.status(400).send('Bad signature');
  }

  try {
    const t = (ev.created_at || new Date().toISOString()).slice(0, 19).replace('T', ' ');
    if (ev.type === 'email.delivered') {
      run('UPDATE email_log SET delivered_at=? WHERE id=? AND delivered_at IS NULL', t, row.id);
    } else if (ev.type === 'email.bounced' || ev.type === 'email.complained') {
      const why = (ev.data && (ev.data.reason || (ev.data.bounce && ev.data.bounce.message)))
        || (ev.type === 'email.complained' ? 'Marked as spam by the recipient' : 'Bounced');
      run('UPDATE email_log SET bounced_at=?, bounce_reason=? WHERE id=?', t, String(why).slice(0, 300), row.id);
    }
  } catch (e) { console.error('Email webhook:', e.message); }
  res.json({ received: true });
});

app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: false }));   // Twilio posts form-encoded

// Twilio inbound webhook. The invitation number is send-only, so anyone who texts it
// back gets one automatic answer pointing them into the app rather than silence.
// Point Twilio's "A message comes in" setting at POST {your domain}/sms/incoming.
// Twilio handles STOP/START/HELP itself, before this ever runs.
app.post('/sms/incoming', (req, res) => {
  const from = sms.normalizePhone(req.body && req.body.From);
  const body = String((req.body && req.body.Body) || '').trim();
  const bare = from ? from.replace(/^\+1/, '') : '';
  const digitsOf = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},'-',''),' ',''),'(',''),')',''),'+1','')`;

  // A vendor writing back. Their reply belongs in the thread, not in an auto-response —
  // this is a real two-way conversation and somebody is waiting on the answer.
  if (bare) {
    const contact = get(`SELECT * FROM contacts WHERE archived_at IS NULL AND phone IS NOT NULL
      AND ${digitsOf('phone')} = ? ORDER BY id LIMIT 1`, bare);
    if (contact) {
      const lastProp = get(`SELECT property_id FROM contact_messages
        WHERE contact_id=? AND property_id IS NOT NULL ORDER BY id DESC LIMIT 1`, contact.id);
      run(`INSERT INTO contact_messages (company_id, contact_id, property_id, direction, phone, body, status)
           VALUES (?,?,?,'in',?,?,'received')`,
        contact.company_id, contact.id, lastProp ? lastProp.property_id : null, from, body);
      // Tell the staff who can act on it.
      for (const u of all(`SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin')
          AND deleted_at IS NULL`, contact.company_id)) {
        notify.notify(u.id, {
          kind: 'message',
          title: `💬 ${contact.name}`,
          body: body.slice(0, 140),
          url: '/admin#contacts',
        }).catch(() => {});
      }
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  }

  // A buyer texting back. Their words belong in the message thread on their loan,
  // marked as having arrived by text — not swallowed by an auto-reply.
  if (bare && body) {
    const buyer = get(`SELECT u.* FROM users u WHERE u.role='tenant' AND u.deleted_at IS NULL
      AND u.phone IS NOT NULL AND ${digitsOf('u.phone')} = ? LIMIT 1`, bare);
    if (buyer) {
      const loan = get("SELECT * FROM loans WHERE tenant_user_id=? AND status='active' ORDER BY id DESC LIMIT 1", buyer.id)
        || get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', buyer.id);
      if (loan) {
        run(`INSERT INTO messages (loan_id, sender_user_id, body, read_by_tenant, channels)
             VALUES (?,?,?,1,'sms')`, loan.id, buyer.id, body);
        for (const u of all(`SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL`, loan.company_id)) {
          notify.notify(u.id, {
            kind: 'message', title: `📲 Text from ${buyer.name}`,
            body: body.slice(0, 140), url: '/admin#msgs',
          }).catch(() => {});
        }
        return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      }
    }
  }

  // Otherwise it is a stranger or an invitation reply. Point them at the app.
  let companyName = null;
  if (bare) {
    const u = get(`SELECT c.name, c.mgmt_company_name FROM users u JOIN companies c ON c.id=u.company_id
      WHERE u.phone IS NOT NULL AND u.deleted_at IS NULL
        AND ${digitsOf('u.phone')} = ? LIMIT 1`, bare);
    if (u) companyName = u.mgmt_company_name || u.name;
  }
  res.type('text/xml').send(sms.autoReplyTwiml(companyName));
});
app.use(express.static(path.join(__dirname, 'public')));

const today = () => new Date().toISOString().slice(0, 10);
const money = c => (c / 100).toFixed(2);

// ---------- servicing helpers ----------
function assessRecurringCharges(loan) {
  const charges = all('SELECT * FROM charges WHERE loan_id=? AND recurring=1 AND active=1', loan.id);
  for (const ch of charges) {
    const start = ch.start_date || loan.first_payment_date;
    const end = ch.end_date && ch.end_date < today() ? ch.end_date : today();
    let d = new Date(start + 'T00:00:00Z');
    const now = new Date(end + 'T00:00:00Z');
    while (d <= now) {
      const period = d.toISOString().slice(0, 7); // YYYY-MM
      const tag = `charge:${ch.id}:${period}`;
      const exists = get('SELECT id FROM ledger WHERE loan_id=? AND memo=?', loan.id, tag);
      if (!exists) {
        run(`INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo)
             VALUES (?,?,?,?,?)`, loan.id, d.toISOString().slice(0, 10), 'fee', -ch.amount_cents, tag);
        run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', ch.amount_cents, loan.id);
      }
      d = loanEngine.addMonthsUTC(d, 1);
    }
  }
  return get('SELECT * FROM loans WHERE id=?', loan.id);
}

function postPayment(loanId, amountCents, method, entryDate, externalId, memo, createdBy, feeCents) {
  let loan = get('SELECT * FROM loans WHERE id=?', loanId);
  if (!loan) throw new Error('Loan not found');
  loan = assessRecurringCharges(loan);
  if (externalId && get('SELECT id FROM ledger WHERE external_id=?', externalId)) {
    return { duplicate: true };
  }
  // What was owed the moment before this payment — the fact a partial-payment
  // receipt is built on, so it is measured here and not reconstructed later.
  const rowsBefore = all('SELECT * FROM ledger WHERE loan_id=?', loanId);
  const owedBefore = loanEngine.loanStatus(loan, rowsBefore, entryDate).owed_now_cents;
  const alloc = loanEngine.allocatePayment(loan, amountCents, entryDate);
  const newPrincipal = loan.principal_balance_cents - alloc.to_principal_cents;
  const newEscrow = loan.escrow_balance_cents + alloc.to_escrow_cents + alloc.unapplied_cents;
  const newFees = loan.fees_due_cents - alloc.to_fees_cents;
  const newInterestDue = alloc.interest_shortfall_cents;
  run(`INSERT INTO ledger (loan_id, entry_date, type, method, amount_cents, to_interest_cents,
        to_principal_cents, to_escrow_cents, to_fees_cents, principal_balance_after_cents, memo, external_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    loanId, entryDate, 'payment', method, amountCents, alloc.to_interest_cents,
    alloc.to_principal_cents, alloc.to_escrow_cents + alloc.unapplied_cents, alloc.to_fees_cents,
    newPrincipal, memo || null, externalId || null, createdBy || null);
  if (feeCents) run('UPDATE ledger SET fee_cents=? WHERE id=(SELECT MAX(id) FROM ledger WHERE loan_id=?)', feeCents, loanId);
  if (loan.tenant_user_id) {
    notify.notify(loan.tenant_user_id, {
      kind: 'payment_received', title: 'Payment received',
      body: `We applied $${(amountCents / 100).toFixed(2)} to your loan. Balance is now $${(newPrincipal / 100).toFixed(2)}.`,
      url: '/?tab=activity',
    }).catch(() => {});
  }
  run(`UPDATE loans SET principal_balance_cents=?, escrow_balance_cents=?, fees_due_cents=?,
        interest_due_cents=?, status=CASE WHEN ?<=0 THEN 'paid_off' ELSE status END WHERE id=?`,
    newPrincipal, newEscrow, newFees, newInterestDue, newPrincipal, loanId);
  // A payment that leaves a Michigan default standing gets its receipt written in the
  // same breath the money lands — the reservation of rights only protects if it is
  // contemporaneous. A receipt that fails to generate must never block a payment.
  try {
    if (owedBefore > 0 && amountCents < owedBefore) {
      miPartialReceipt({ loan, alloc, amountCents, method, entryDate, owedBefore });
    }
  } catch (e) { console.error('Partial-payment receipt not filed:', e.message); }
  return { alloc, newPrincipal };
}

function postStripePayment(session) {
  const loanId = Number(session.metadata.loan_id);
  const fee = Number((session.metadata && session.metadata.fee_cents) || 0);
  const amount = Number(session.metadata.amount_cents || ((session.amount_total || 0) - fee));
  const pmType = (session.payment_method_types && session.payment_method_types[0]) || 'card';
  const method = pmType === 'cashapp' ? 'stripe_cashapp' : pmType === 'us_bank_account' ? 'stripe_ach' : 'stripe_card';
  return postPayment(loanId, amount, method, today(), `stripe:${session.id}`, 'Online payment', null, fee);
}

// ---------- the late-notice ladder ----------
// Driven by notice_rules, so the days and the wording are yours to change without a
// deploy. Every rung fires on the app, by text and by email at the same moment — a
// buyer should not find out about a default notice from whichever channel they happen
// to open first.
const LEGAL_NOTICE_DAYS = Number(process.env.LEGAL_NOTICE_DAYS || 30);

async function sendLadderNotice({ rule, loan, property, tenant, co, status, dueDate, period, daysPast,
                                  reserveRights, feeCharged, wordingOverride }) {
  // Precedence: a subject/body the company typed onto the rule wins; then a
  // state-specific template (Michigan's own notice packet); then the default.
  const wording = (rule.subject && rule.body)
    ? { subject: rule.subject, body: rule.body }
    : wordingOverride || noticeRules.defaultWording(rule, {
        loan, property, tenant, amountCents: status.owed_now_cents, dueDate, daysPast,
        reserveRights, feeCharged });

  const paras = wording.body.split('\n\n').map(par => `<p>${tpl.escapeHtml(par)}</p>`).join('');
  const baseUrl = process.env.BASE_URL || '';
  const appHtml = tpl.brandedShell({ company: co, subject: wording.subject, bodyHtml: paras, baseUrl });
  const channels = String(rule.channels || 'app,sms,email').split(',').map(c => c.trim());
  const delivery = {};

  // 1. The record. This is the delivery that cannot fail, and the one with the read
  //    receipt on it.
  const ins = run(`INSERT INTO notices (loan_id, type, period, stage, subject, body, body_html, days_past_due)
    VALUES (?,?,?,?,?,?,?,?)`,
    loan.id, rule.notice_type, period, rule.stage, wording.subject, wording.body, appHtml, daysPast);
  const noticeId = ins.lastInsertRowid;
  delivery.app = { ok: true };

  // 2. In the message thread, so it is where they already look.
  const adminId = get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id LIMIT 1", loan.company_id);
  if (adminId) {
    run(`INSERT INTO messages (loan_id, sender_user_id, body, body_html, subject, read_by_admin, channels)
      VALUES (?,?,?,?,?,1,?)`, loan.id, adminId.id, wording.body, appHtml, wording.subject,
      channels.join(','));
  }
  notify.notify(loan.tenant_user_id, {
    kind: 'notice', title: wording.subject, body: 'Open the app to read this notice.',
    url: '/', dedupeKey: `notice:${rule.stage}:${period}:${loan.id}`,
  }).catch(() => {});

  // 3. Email, from whichever address this rung names.
  if (channels.includes('email')) {
    if (!tenant || !tenant.email) delivery.email = { ok: false, error: 'No email address on file' };
    else if (!email.emailEnabled(co)) delivery.email = { ok: false, error: 'Email is not connected' };
    else {
      try {
        const mailHtml = tpl.emailShell({
          company: co, subject: wording.subject, bodyHtml: paras, baseUrl, tone: 'notice',
          preheader: `${property ? property.address : 'Your account'} — $${(status.owed_now_cents / 100).toFixed(2)} past due.`,
        });
        const r = await email.sendEmail(tenant.email, {
          subject: wording.subject, text: wording.body, html: mailHtml,
          kind: rule.notice_type, daysPastDue: daysPast,
          identity: rule.email_identity, loanId: loan.id, companyId: loan.company_id,
        }, co);
        delivery.email = { ok: true, to: r.to, from: r.from, identity: r.identity };
      } catch (e) { delivery.email = { ok: false, error: e.message }; }
    }
  }

  // 4. Text. Short, and pointing at the full notice rather than trying to be it.
  if (channels.includes('sms')) {
    if (!tenant || !tenant.phone) delivery.sms = { ok: false, error: 'No mobile number on file' };
    else if (!sms.smsEnabled(co)) delivery.sms = { ok: false, error: 'Texting is not connected' };
    else {
      const short = `${wording.subject}\n\n$${(status.owed_now_cents / 100).toFixed(2)} is ${daysPast} days past due on ` +
        `${property ? property.address : 'your account'}. The full notice is in your app: ${baseUrl || ''}/`;
      try {
        await sms.sendSms(tenant.phone, short, co);
        delivery.sms = { ok: true, to: tenant.phone };
      } catch (e) { delivery.sms = { ok: false, error: e.message }; }
    }
  }

  // 5. Certified mail, for the 30-day rung only. That is the notice a forfeiture
  //    case leans on, and "certified" is what turns it from a claim into a tracking
  //    number with delivery scans. The idempotency key means a sweep that crashes and
  //    reruns cannot mail — or bill — the same notice twice.
  if (rule.stage === 'late_30' && lob.lobEnabled(co)) {
    if (!property || !property.address) {
      delivery.mail = { ok: false, error: 'No property address to mail to' };
    } else {
      try {
        const sent = await lob.sendCertifiedLetter(co, {
          to: { name: (tenant && tenant.name) || 'Occupant', address_line1: property.address,
                address_city: property.city, address_state: property.state, address_zip: property.zip },
          subject: wording.subject, body: wording.body,
          description: `30-day notice — loan ${loan.id} ${period}`,
          idempotencyKey: `notice-${loan.id}-${rule.stage}-${period}`,
        });
        run(`UPDATE notices SET lob_id=?, lob_tracking=?, lob_status='created', lob_expected=?, lob_cost_cents=? WHERE id=?`,
          sent.id, sent.tracking_number, sent.expected_delivery_date, sent.cost_cents || null, noticeId);
        delivery.mail = { ok: true, lob_id: sent.id, tracking: sent.tracking_number, test: sent.test };

        // A copy of what was mailed, filed on the loan. Evidence, not correspondence
        // for the buyer — they got the notice itself through every other channel.
        try {
          const pdfBuf = pdfDoc.letter({ company: co, subject: wording.subject, bodyText: wording.body, sentAt: today() });
          const stored = crypto.randomUUID() + '.pdf';
          fs.writeFileSync(path.join(UPLOAD_DIR, stored), pdfBuf);
          run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
               VALUES (?,?,?,?,?,?,?,?,?,0)`,
            loan.company_id, loan.id, loan.property_id, 'other', 'private',
            `Certified mail — ${rule.label} (${sent.tracking_number || sent.id})`,
            `certified-${rule.stage}-${period}.pdf`, stored, 'application/pdf');
        } catch (e) { console.error('Certified copy not filed:', e.message); }

        // The pass-through: what Lob charges becomes a collection fee on the loan,
        // tagged with the tracking number so the ledger line is auditable. Only when
        // a real cost is configured, and never for test-mode letters.
        if (sent.cost_cents > 0 && !sent.test) {
          run(`INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo)
               VALUES (?,?, 'fee', ?, ?)`, loan.id, today(), -sent.cost_cents,
            `Collection fee — certified mail, 30-day notice (${sent.tracking_number || sent.id})`);
          run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', sent.cost_cents, loan.id);
        }
      } catch (e) { delivery.mail = { ok: false, error: e.message }; }
    }
  }

  run('UPDATE notices SET delivery_json=? WHERE id=?', JSON.stringify(delivery), noticeId);
  const failed = Object.entries(delivery).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log(`${rule.label} sent for loan ${loan.id} (${period}, day ${daysPast})` +
    (failed.length ? ` — ${failed.join(' and ')} did not go` : ''));
  return noticeId;
}

// ---------- the Michigan forfeiture track ----------
// Land contracts in Michigan get the statutory sequence instead of the generic
// ladder: day 6 a 5-day late notice with non-waiver language (and the contractual
// late fee, charged once per missed payment), day 10 a DC 101 forfeiture notice —
// prepared on the official SCAO form, reviewed by a human, and served by certified
// mail with one click. Service starts a cure clock of at least 15 days; when it runs
// out unpaid, a File-DC 102 task appears with that district court's own filing
// checklist. The complaint itself is filed by a person, never by a cron job.

function missedDueDatesFor(loan, status) {
  const first = new Date(loan.first_payment_date + 'T00:00:00Z');
  const dates = [];
  for (let i = status.payments_made_equiv; i < status.payments_due; i++) {
    dates.push(loanEngine.addMonthsUTC(first, i).toISOString().slice(0, 10));
  }
  return dates;
}

function notifyAdmins(companyId, payload) {
  for (const a of all("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL", companyId)) {
    notify.notify(a.id, payload).catch(() => {});
  }
}

// Draft the DC 101 — fill the form from what the app knows, park it as a prepared
// notice, and ask a human to look before anything is mailed. A wrong arrears figure
// on this document can sink the forfeiture case; ten seconds of eyes on it is cheap.
function prepareDc101(loan, { period, status, property, tenant, co }) {
  // One live DC 101 per default cycle: an unserved draft is reused, and once one has
  // been served the legal track owns the account until it is cured or filed.
  const open = get(`SELECT * FROM notices WHERE loan_id=? AND stage='mi_dc101' AND served_at IS NULL AND prepared=1`, loan.id);
  if (open) return open;
  const served = get(`SELECT id FROM notices WHERE loan_id=? AND stage='mi_dc101' AND served_at IS NOT NULL ORDER BY id DESC LIMIT 1`, loan.id);
  if (served) return null;

  const court = noticeRules.miCourtFor(property);
  const values = dc101.buildValues({
    company: co, property, tenant,
    missedDueDates: missedDueDatesFor(loan, status),
    pastDueCents: Math.max(0, status.owed_now_cents - status.fees_due_cents),
    feesCents: status.fees_due_cents,
    courtDistrict: property.court_district || (court && court.district) || '',
    courtAddress: property.court_address || (court && court.address) || '',
    courtPhone: property.court_phone || (court && court.phone) || '',
    contractDate: loan.contract_date || '',
    cureDays: 15,
    signerName: '', serviceDate: '',
  });

  const subject = `Forfeiture Notice (DC 101) — ${property.address}`;
  const body = `Prepared for review. $${(status.owed_now_cents / 100).toFixed(2)} past due; ` +
    `serve by certified mail to start the 15-day cure period. Not yet served.`;
  const ins = run(`INSERT INTO notices (loan_id, type, period, stage, subject, body, days_past_due, prepared, fill_json)
    VALUES (?,?,?,?,?,?,?,1,?)`, loan.id, 'legal_notice', period, 'mi_dc101', subject, body,
    null, JSON.stringify(values));
  const noticeId = ins.lastInsertRowid;

  try {
    run(`INSERT INTO tasks (company_id, property_id, loan_id, title, notes, category, priority, due_date, source_key)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      loan.company_id, loan.property_id, loan.id,
      `Review & serve DC 101 — ${property.address}`,
      `The forfeiture notice is filled out and waiting on the loan page. Check the amounts and the ` +
      `court details, then serve it by certified mail with one click. Service starts the 15-day cure clock.`,
      'legal', 'high', today(), `dc101-prep-${noticeId}`);
  } catch (e) { /* task already exists */ }

  notifyAdmins(loan.company_id, {
    kind: 'notice', title: `DC 101 ready to review — ${property.address}`,
    body: 'The Michigan forfeiture notice is prepared. Review and serve it from the loan page.',
    url: '/admin', dedupeKey: `dc101-prep-${noticeId}`,
  });
  console.log(`DC 101 prepared for loan ${loan.id} (${property.address})`);
  return get('SELECT * FROM notices WHERE id=?', noticeId);
}

// Two documents file themselves the moment the 5-day notice goes out, straight from
// the delivery record. The first is the notice exactly as sent, on letterhead — the
// top item on any evidence checklist. The second is the Certificate of Delivery from
// the company's notice packet, its channel-by-channel entries filled from what
// actually happened: which email address, which phone number, which app account, and
// how each attempt ended. A year from now, this is what makes the delivery provable.
function fileMiFiveDayEvidence({ co, loan, property, tenant, noticeId, period }) {
  const n = get('SELECT * FROM notices WHERE id=?', noticeId);
  if (!n) return;
  const delivery = JSON.parse(n.delivery_json || '{}');
  const logo = companyLogo(co);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const fileDoc = (buf, title, filename) => {
    const stored = crypto.randomUUID() + '.pdf';
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
    run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
         VALUES (?,?,?,?,?,?,?,?,?,0)`,
      loan.company_id, loan.id, loan.property_id, 'other', 'private', title, filename, stored, 'application/pdf');
  };

  fileDoc(
    pdfDoc.letter({ company: co, subject: n.subject, bodyText: n.body, sentAt: today(), logo }),
    `Notice as sent — 5-day late notice (${period})`, `mi-5day-notice-${noticeId}.pdf`);

  const line = (label, value) => `${label}: ${value}`;
  const ch = [];
  ch.push('CHANNEL — MOBILE APP MESSAGE\n' + [
    line('Date and time sent', stamp),
    line('Platform', 'PorchPay buyer portal'),
    line('Purchaser account', tenant ? `${tenant.name} <${tenant.email || 'no email'}> (user #${tenant.id})` : 'not linked'),
    line('Message thread', `Loan #${loan.id} message thread; notice #${noticeId}`),
    line('Delivery status', 'Posted to the account. Read receipt is recorded on the notice when the purchaser opens it.'),
  ].join('\n'));
  const em = delivery.email;
  ch.push('CHANNEL — EMAIL\n' + (em
    ? (em.ok ? [
        line('Date and time sent', stamp),
        line('Sent to', em.to || (tenant && tenant.email) || ''),
        line('Sent from', em.from || `${em.identity || 'servicing'} address`),
        line('Subject line', n.subject),
        line('Delivery confirmation', 'Accepted by the email provider'),
      ].join('\n') : [
        line('Attempted', stamp),
        line('Result', `NOT DELIVERED — ${em.error}`),
      ].join('\n'))
    : 'Not attempted on this notice.'));
  const sm = delivery.sms;
  ch.push('CHANNEL — TEXT MESSAGE\n' + (sm
    ? (sm.ok ? [
        line('Date and time sent', stamp),
        line('Sent to', sm.to || (tenant && tenant.phone) || ''),
        line('Content', 'Short-form alert pointing to the full notice in the app'),
      ].join('\n') : [
        line('Attempted', stamp),
        line('Result', `NOT DELIVERED — ${sm.error}`),
      ].join('\n'))
    : 'Not attempted on this notice.'));
  ch.push('CHANNEL — FIRST-CLASS U.S. MAIL\n' +
    'Not sent automatically with this notice. If mailed from the notice screen, the mailed copy and ' +
    'its tracking are filed separately alongside this certificate.');

  const certBody =
`Retain in the seller's deal file. Not filed with the court.

I delivered a true copy of the Notice of Late Payment and Default described above by each of the channels recorded below.

${ch.join('\n\n')}

ATTESTATION
I am authorized to act on behalf of Seller. The deliveries recorded above were made through PorchPay, and the entries were generated from its live delivery records at the moment of sending. These records are kept in the ordinary course of Seller's business.

Signature: _______________________________
Printed name: ____________________________
Title: ___________________________________
Date: ____________________________________

NOTE — Email and app delivery do not satisfy MCL 600.5730. This certificate covers the contractual courtesy notice only. The statutory Notice of Forfeiture (Form DC 101) must be served by a method permitted under MCL 600.5730; PorchPay serves it by first-class certified mail with USPS tracking.

Generated by PorchPay on ${stamp}.`;

  fileDoc(
    pdfDoc.letter({
      company: co, subject: 'CERTIFICATE OF DELIVERY — Notice of Late Payment and Default', logo,
      sentAt: today(),
      meta: [['Deal', `Loan #${loan.id}`], ['Property', `${property.address}, ${property.city}, MI ${property.zip}`],
             ['Purchaser(s)', (tenant && tenant.name) || '—'], ['Notice date', today()], ['Arrears month', period]],
      bodyText: certBody,
    }),
    `Certificate of delivery — 5-day notice (${period})`, `mi-5day-certificate-${noticeId}.pdf`);
}

// The partial-payment acknowledgment and non-waiver receipt, from the company's
// notice packet. Issued the instant a payment smaller than the arrears lands on a
// Michigan loan in default: the receipt PDF files itself on the loan, and the
// reservation of rights is delivered to the purchaser in the message thread — a
// written, timestamped record that accepting the money forgave nothing. If a DC 101
// is pending, the receipt says plainly that its cure deadline is unchanged.
function miPartialReceipt({ loan, alloc, amountCents, method, entryDate, owedBefore }) {
  const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
  if (!noticeRules.isMichigan(property)) return;
  const co = get('SELECT * FROM companies WHERE id=?', loan.company_id);
  const tenant = loan.tenant_user_id ? get('SELECT * FROM users WHERE id=?', loan.tenant_user_id) : null;
  const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const remaining = owedBefore - amountCents;
  const seller = property.trust_name || (co && (co.mgmt_company_name || co.name)) || 'Seller';
  const servicer = (co && (co.mgmt_company_name || co.name)) || 'Loan Servicing';
  const methodLabel = ({ cash: 'Cash', check: 'Check', money_order: 'Money order',
    stripe_card: 'Card (online)', stripe_ach: 'Bank transfer (online)', stripe_cashapp: 'Cash App Pay (online)',
  })[method] || method || 'Payment';

  const dc = get(`SELECT * FROM notices WHERE loan_id=? AND stage='mi_dc101' AND served_at IS NOT NULL
                  ORDER BY id DESC LIMIT 1`, loan.id);
  const dcSection = dc
    ? `4. EFFECT ON THE PENDING DC 101 FORFEITURE NOTICE
A DC 101 forfeiture notice is pending on this account, served ${dc.served_at} with a cure deadline of ${dc.cure_deadline}. This payment does NOT fully cure that notice — the notice remains in effect, and the existing cure deadline is unchanged. This receipt does not extend it.`
    : `4. EFFECT ON ANY PENDING NOTICE
No DC 101 forfeiture notice is currently pending on this account. If one is served, only payment of the full amount demanded within its cure period will cure it.`;

  const body =
`PARTIAL PAYMENT ACKNOWLEDGMENT AND NON-WAIVER RECEIPT
Michigan Land Contract

Property: ${property.address}, ${property.city}, Michigan ${property.zip}${loan.contract_date ? `\nLand contract dated: ${loan.contract_date}` : ''}
Purchaser(s): ${(tenant && tenant.name) || '—'}

1. PAYMENT RECEIVED
Amount received: ${money(amountCents)}
Date received: ${entryDate}
Form of payment: ${methodLabel}
Total amount that was due: ${money(owedBefore)}
REMAINING BALANCE STILL DUE: ${money(remaining)}

2. APPLICATION OF FUNDS
Late charges and fees: ${money(alloc.to_fees_cents)}
Accrued interest: ${money(alloc.to_interest_cents)}
Escrow (taxes and insurance): ${money(alloc.to_escrow_cents + alloc.unapplied_cents)}
Principal: ${money(alloc.to_principal_cents)}
TOTAL APPLIED: ${money(amountCents)}

3. EXPRESS CONDITIONS — NON-WAIVER
${noticeRules.MI_PARTIAL_NON_WAIVER}

${dcSection}

Seller: ${servicer}, servicing agent for ${seller}

Purchaser acknowledgment (signature useful but not required — Seller's written reservation of rights stands on its own):
Signature: _______________________________   Date: ____________`;

  const buf = pdfDoc.letter({
    company: co, subject: 'Partial Payment Acknowledgment and Non-Waiver Receipt',
    sentAt: entryDate, logo: companyLogo(co), bodyText: body,
  });
  const stored = crypto.randomUUID() + '.pdf';
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
       VALUES (?,?,?,?,?,?,?,?,?,0)`,
    loan.company_id, loan.id, loan.property_id, 'other', 'private',
    `Partial payment non-waiver receipt — ${money(amountCents)} (${entryDate})`,
    `mi-partial-receipt-${loan.id}-${entryDate}.pdf`, stored, 'application/pdf');

  // Delivery is what gives the reservation teeth: the purchaser is told, in the
  // thread, the moment the money is accepted.
  const adminId = get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id LIMIT 1", loan.company_id);
  if (adminId && tenant) {
    const msg =
`Payment received — with reservation of rights

We received your payment of ${money(amountCents)} on ${entryDate}. It has been applied to your balance; ${money(remaining)} remains past due.

This payment is accepted on the express condition that it does not cure the existing default, does not waive any of Seller's rights under the land contract or Michigan law, and does not modify your payment terms.${dc ? ` The pending forfeiture notice remains in effect and its cure deadline of ${dc.cure_deadline} is unchanged.` : ''} All rights are expressly reserved.

To resolve the default, the full past-due balance of ${money(remaining)} must be received. If you want to discuss a written arrangement, message us here.`;
    run(`INSERT INTO messages (loan_id, sender_user_id, body, subject, read_by_admin, channels)
         VALUES (?,?,?,?,1,'app')`, loan.id, adminId.id, msg, 'Payment received — with reservation of rights');
    notify.notify(tenant.id, {
      kind: 'notice', title: 'Payment received — balance still due',
      body: `${money(amountCents)} received; ${money(remaining)} remains past due.`,
      url: '/', dedupeKey: `mi-partial-${loan.id}-${entryDate}-${amountCents}`,
    }).catch(() => {});
  }
  console.log(`Non-waiver receipt filed for loan ${loan.id}: ${money(amountCents)} of ${money(owedBefore)}`);
}

// The morning after the cure deadline dies unpaid, the next move belongs on the task
// list — with the right courthouse and that court's own quirks attached.
function createDc102Task(notice, loan, property, status) {
  const court = noticeRules.miCourtFor(property);
  const filing = (court && court.filing) ||
    'File with the district court for the property’s district — call ahead for fee and copy count.';
  try {
    const r = run(`INSERT INTO tasks (company_id, property_id, loan_id, title, notes, category, priority, due_date, source_key)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      loan.company_id, loan.property_id, loan.id,
      `File DC 102 — land contract forfeiture (${property.address})`,
      `The DC 101 cure deadline (${notice.cure_deadline}) has passed and ` +
      `$${(status.owed_now_cents / 100).toFixed(2)} is still owed.\n\n${filing}\n\n` +
      `The served DC 101 with its certificate of service and certified-mail tracking number is filed ` +
      `under this loan's documents. Case No. and Judge are assigned at filing — leave them blank on your copies.\n\n` +
      `After judgment: the court sets a hearing within 30 days of the summons (MCL 600.5735); the purchaser's ` +
      `redemption period is 90 days if less than half the purchase price has been paid, 6 months if half or more ` +
      `(MCL 600.5744(4)). Forfeiture returns the property but produces no money judgment for the balance.`,
      'legal', 'high', today(), `dc102-${notice.id}`);
    if (r.changes > 0) {
      notifyAdmins(loan.company_id, {
        kind: 'notice', title: `Cure period expired — ${property.address}`,
        body: 'The DC 101 cure deadline passed unpaid. A filing task with the court checklist is on your list.',
        url: '/admin', dedupeKey: `dc102-${notice.id}`,
      });
      console.log(`DC 102 filing task created for loan ${loan.id}`);
    }
  } catch (e) { /* unique source_key — already created */ }
}

async function runNoticeSweep() {
  const loans = all("SELECT * FROM loans WHERE status='active' AND tenant_user_id IS NOT NULL");
  const nowDate = new Date(today() + 'T00:00:00Z');
  for (let loan of loans) {
    try {
      loan = assessRecurringCharges(loan);
      const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
      const status = loanEngine.loanStatus(loan, ledger, today());
      if (!status.is_past_due) continue;

      const idx = status.payments_made_equiv;
      const first = new Date(loan.first_payment_date + 'T00:00:00Z');
      const dueDateObj = loanEngine.addMonthsUTC(first, idx);
      const dueDate = dueDateObj.toISOString().slice(0, 10);
      const period = dueDate.slice(0, 7);
      const daysPast = Math.floor((nowDate - dueDateObj) / 86400000);

      // Never inside the grace period their agreement gives them.
      if (daysPast <= (loan.grace_days || 0)) continue;

      const co0 = get('SELECT * FROM companies WHERE id=?', loan.company_id);

      // The ladder stops once the matter is with a lawyer. From here the notices that
      // count are the statutory ones counsel serves, and an automated one arriving in
      // the middle of that is at best confusing.
      if (loan.legal_hold_at) continue;

      // Paying the arrears ends the cycle on its own — the account stops being past due
      // and the check above has already sent us on. What is left is the partial payment,
      // and that is a judgement rather than a rule: a token amount should not be able to
      // silence a real default for ever. So it buys quiet for a set number of days, which
      // each company sets for itself and which is zero unless somebody turns it on.
      // The pause is a per-loan exception — an arrangement made with one buyer about
      // one house. A loan with no rule runs on normal timing; nothing is inherited
      // from a company-wide setting. The minimum stops the obvious abuse: without one,
      // a dollar would buy the same quiet as eight hundred, repeatably. Payments
      // inside the window are summed, so paying twice in a week counts as its total.
      const pauseDays = Number(loan.notice_pause_days) || 0;
      if (pauseDays > 0) {
        const paid = get(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM ledger
          WHERE loan_id=? AND type='payment' AND entry_date >= date('now', ?)`,
          loan.id, `-${pauseDays} days`);
        const minCents = Number(loan.notice_pause_min_cents) || 0;
        if (paid && paid.c > 0 && paid.c >= minCents) continue;
      }

      const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
      const tenant = get('SELECT * FROM users WHERE id=?', loan.tenant_user_id);
      const co = co0;

      // Michigan runs its own statutory track and never touches the generic ladder.
      if (noticeRules.isMichigan(property)) {
        noticeRules.seedLadder(loan.company_id);

        // Once the DC 101 is out the door, the only automated job left is watching
        // the cure clock. More notices mid-forfeiture are noise a court can quote.
        const served = get(`SELECT * FROM notices WHERE loan_id=? AND stage='mi_dc101'
          AND served_at IS NOT NULL ORDER BY id DESC LIMIT 1`, loan.id);
        if (served) {
          if (served.cure_deadline && served.cure_deadline < today()) {
            createDc102Task(served, loan, property, status);
          }
          continue;
        }

        // Day 6: the 5-day late notice, with non-waiver language, and the
        // contractual late fee charged once per missed payment — the notice then
        // states the fee as charged, not as a maybe.
        if (daysPast >= 6 && !get(`SELECT id FROM notices WHERE loan_id=? AND period=? AND stage='late_5'`, loan.id, period)) {
          let feeCharged = false;
          if (loan.late_fee_cents > 0 &&
              !get(`SELECT id FROM ledger WHERE loan_id=? AND type='late_fee' AND memo LIKE ?`, loan.id, `%${period}%`)) {
            run(`INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo)
                 VALUES (?,?, 'late_fee', ?, ?)`, loan.id, today(), -loan.late_fee_cents,
              `Late fee — ${period} missed payment (5-day notice)`);
            run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', loan.late_fee_cents, loan.id);
            loan = get('SELECT * FROM loans WHERE id=?', loan.id);
            feeCharged = true;
          }
          const freshStatus = loanEngine.loanStatus(loan, all('SELECT * FROM ledger WHERE loan_id=?', loan.id), today());
          const rule = get(`SELECT * FROM notice_rules WHERE company_id=? AND stage='late_5'`, loan.company_id);
          if (rule) {
            const wordingOverride = (rule.subject && rule.body) ? null
              : noticeRules.miLateNoticeWording({
                  company: co, loan, property, tenant, status: freshStatus, dueDate,
                  missedDates: missedDueDatesFor(loan, freshStatus), feeCharged, todayIso: today() });
            const noticeId = await sendLadderNotice({ rule, loan, property, tenant, co, status: freshStatus,
              dueDate, period, daysPast, reserveRights: true, feeCharged, wordingOverride });
            // Evidence, filed the moment it exists: the notice exactly as sent, on the
            // company's paper, and a certificate of delivery recording every channel.
            try { fileMiFiveDayEvidence({ co, loan, property, tenant, noticeId, period }); }
            catch (e) { console.error('MI 5-day evidence not filed:', e.message); }
          }
        }

        // Day 10: fill the DC 101 and put it in front of a human.
        if (daysPast >= 10) {
          const freshLedger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
          const freshStatus = loanEngine.loanStatus(loan, freshLedger, today());
          prepareDc101(loan, { period, status: freshStatus, property, tenant, co });
        }
        continue;
      }

      noticeRules.seedLadder(loan.company_id);
      const due = noticeRules.dueRule(loan.company_id, loan.id, period, daysPast);
      if (!due) continue;

      // Rungs that came due while nothing was running are recorded, not sent. Four
      // notices arriving together about one missed payment helps nobody.
      for (const skipped of due.skip) {
        run(`INSERT INTO notices (loan_id, type, period, stage, subject, body, days_past_due, delivery_json)
          VALUES (?,?,?,?,?,?,?,?)`, loan.id, skipped.notice_type, period, skipped.stage,
          `${skipped.label} (superseded)`,
          `Not sent: the account had already reached ${due.fire.label} by the time this was evaluated.`,
          daysPast, JSON.stringify({ skipped: true }));
      }

      await sendLadderNotice({ rule: due.fire, loan, property, tenant, co, status, dueDate, period, daysPast });
    } catch (e) { console.error('Notice sweep error for loan', loan.id, e.message); }
  }
}
// A payoff statement is only good through its date; sweep the expired ones with the notices.
setInterval(() => { try { payoff.expireStale(); } catch (e) { console.error('Payoff expiry:', e.message); } },
  60 * 60 * 1000);
setInterval(() => { runNoticeSweep().catch(e => console.error('Notice sweep:', e.message)); }, 60 * 60 * 1000);
setTimeout(() => { runNoticeSweep().catch(e => console.error('Notice sweep:', e.message)); }, 5000);

function loanFull(loan) {
  loan = assessRecurringCharges(loan);
  const ledger = all('SELECT * FROM ledger WHERE loan_id=? ORDER BY entry_date, id', loan.id);
  const status = loanEngine.loanStatus(loan, ledger, today());
  const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
  const tenant = loan.tenant_user_id ? get('SELECT id,name,email,phone FROM users WHERE id=?', loan.tenant_user_id) : null;
  const charges = all('SELECT * FROM charges WHERE loan_id=? AND active=1', loan.id);
  return { loan, ledger, status, property, tenant, charges };
}

// ---------- login throttling ----------
// Counts failures per email+IP. Short lockout that grows with repeated failures, so a
// script guessing passwords gets nowhere while a person who fat-fingers theirs waits seconds.
const loginFails = new Map();
function throttleKey(req, email) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return `${ip}|${String(email || '').toLowerCase()}`;
}
function throttleCheck(key) {
  const rec = loginFails.get(key);
  if (!rec) return null;
  if (Date.now() > rec.until) { loginFails.delete(key); return null; }
  if (rec.count < 5) return null;
  return Math.ceil((rec.until - Date.now()) / 1000);
}
function throttleFail(key) {
  const rec = loginFails.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  // 5 strikes, then 30s, 1m, 2m, 4m… capped at 15 minutes.
  const backoff = Math.min(30 * Math.pow(2, Math.max(0, rec.count - 5)), 900);
  rec.until = Date.now() + backoff * 1000;
  loginFails.set(key, rec);
}
function throttleClear(key) { loginFails.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFails) if (now > v.until + 3600000) loginFails.delete(k);
}, 600000);

// ---------- auth routes ----------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const key = throttleKey(req, email);
  const wait = throttleCheck(key);
  if (wait) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.` });
  }
  const user = get('SELECT * FROM users WHERE email=? AND deleted_at IS NULL',
    String(email || '').toLowerCase().trim());
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    throttleFail(key);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  throttleClear(key);
  if (user.archived_at) return res.status(403).json({ error: 'This account is archived. Contact your servicer.' });
  const token = sign({ uid: user.id, exp: Date.now() + 30 * 86400000 });
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
  res.json({ id: user.id, name: user.name, role: user.role, email: user.email, must_change_password: !!user.must_change_password });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', anyUser, (req, res) => res.json(req.user));
app.post('/api/change-password', anyUser, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(password), req.user.id);
  run("UPDATE invitations SET status='accepted', accepted_at=datetime('now') WHERE user_id=? AND status<>'accepted'", req.user.id);
  res.json({ ok: true });
});

// ---------- admin: summary ----------
app.get('/api/admin/summary', adminOnly, (req, res) => {
  const loans = all("SELECT * FROM loans WHERE status='active' AND company_id=?", req.companyId);
  let totalBalance = 0, pastDue = 0, owedNow = 0;
  const loanCards = loans.map(l => {
    const f = loanFull(l);
    totalBalance += f.loan.principal_balance_cents;
    if (f.status.is_past_due) { pastDue++; owedNow += f.status.owed_now_cents; }
    return {
      id: l.id, address: f.property ? f.property.address : '', tenant: f.tenant ? f.tenant.name : '(unassigned)',
      balance_cents: f.loan.principal_balance_cents, owed_now_cents: f.status.owed_now_cents,
      next_due_date: f.status.next_due_date, is_past_due: f.status.is_past_due, payment_cents: l.payment_cents + l.escrow_cents,
    };
  });
  // Money going OUT to private lenders, so the dashboard shows both sides.
  const pmlRows = all(`SELECT pl.*, p.address FROM pml_loans pl
    LEFT JOIN properties p ON p.id=pl.property_id
    WHERE pl.company_id=? AND pl.status='active' ORDER BY pl.id DESC`, req.companyId);
  const pmlCards = pmlRows.map(pl => ({
    id: pl.id, lender_name: pl.lender_name, address: pl.address || '',
    balance_cents: pl.principal_balance_cents, payment_cents: pl.payment_cents,
    rate_bps: pl.interest_rate_bps, lien_position: pl.lien_position,
    payment_type: pl.payment_type, autopay_enabled: !!pl.autopay_enabled,
    next_due_date: loanEngine.nextDueDate(pl, today()),
    balloon_date: pl.balloon_date,
  }));
  const pmlTotalBalance = pmlCards.reduce((t, x) => t + x.balance_cents, 0);
  const pmlTotalMonthly = pmlCards.reduce((t, x) => t + x.payment_cents, 0);
  const tbTotalMonthly = loans.reduce((t, l) => t + l.payment_cents + l.escrow_cents, 0);

  const unreadMsgs = get(`SELECT COUNT(*) c FROM messages m JOIN loans l ON l.id=m.loan_id
    WHERE m.read_by_admin=0 AND l.company_id=?`, req.companyId).c;
  const unassigned = get("SELECT COUNT(*) c FROM expenses WHERE status='unassigned' AND company_id=?", req.companyId).c;
  const company = get('SELECT id, name FROM companies WHERE id=?', req.companyId);
  res.json({
    company: { ...company, setup_complete: !!get('SELECT setup_complete FROM companies WHERE id=?', req.companyId).setup_complete },
    user: { name: req.user.name, role: req.user.role },
    active_loans: loans.length, total_balance_cents: totalBalance, past_due_count: pastDue,
    owed_now_cents: owedNow, unread_messages: unreadMsgs, unassigned_expenses: unassigned,
    loans: loanCards,
    pml_loans: pmlCards,
    property_counts: (() => {
      const rows = all(`SELECT COALESCE(phase,'acquired') phase, COUNT(*) c FROM properties
        WHERE company_id=? GROUP BY 1`, req.companyId);
      const by = {}; let total = 0;
      for (const r of rows) { by[r.phase] = r.c; total += r.c; }
      return { total, by_phase: by,
        owned: total - (by.sold || 0) - (by.paid_off || 0),
        sold: (by.sold || 0) + (by.paid_off || 0) };
    })(),
    income: (() => {
      const y = today().slice(0, 4);
      const ytd = reports.profitAndLoss(req.companyId, `${y}-01-01`, today());
      const life = reports.profitAndLoss(req.companyId, null, null);
      return {
        ytd_gross_cents: ytd.revenue.total_cents,
        ytd_expenses_cents: ytd.expenses.total_cents,
        ytd_net_cents: ytd.net_operating_income_cents,
        lifetime_gross_cents: life.revenue.total_cents,
        lifetime_net_cents: life.net_operating_income_cents,
        year: y,
      };
    })(),
    pml_total_balance_cents: pmlTotalBalance,
    pml_total_monthly_cents: pmlTotalMonthly,
    tb_total_monthly_cents: tbTotalMonthly,
    monthly_spread_cents: tbTotalMonthly - pmlTotalMonthly,
    properties_in_progress: all(`SELECT id, address, phase FROM properties
      WHERE company_id=? AND COALESCE(phase,'acquired') NOT IN ('sold','paid_off') ORDER BY id DESC`, req.companyId),
    integrations: { stripe: pay.stripeEnabled(), ai: ai.aiEnabled(), sms: sms.smsEnabled(myCompany(req)) },
    pending_invitations: get("SELECT COUNT(*) c FROM invitations WHERE company_id=? AND status IN ('pending','failed')", req.companyId).c,
    overdue_tasks: get(`SELECT COUNT(*) c FROM tasks WHERE company_id=? AND status='open'
      AND due_date IS NOT NULL AND due_date < date('now')`, req.companyId).c,
    tasks_today: get(`SELECT COUNT(*) c FROM tasks WHERE company_id=? AND status='open'
      AND due_date = date('now')`, req.companyId).c,
    unread_vendor_texts: get(`SELECT COUNT(*) c FROM contact_messages
      WHERE company_id=? AND direction='in' AND read_at IS NULL`, req.companyId).c,
  });
});

// ---------- company & staff management ----------
// Only contact prefill lives at the company level. Late fee, grace period and the
// payment date are set per property, because they come out of that property's contract.
app.get('/api/admin/defaults', adminOnly, (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.companyId);
  res.json({
    buyer_email: c.default_buyer_email || '',
    buyer_phone: c.default_buyer_phone || '',
    owner_name: c.mgmt_company_name || c.name || '',
    mgmt_company_name: c.mgmt_company_name || '',
    rep_name: c.rep_name || '', rep_phone: c.rep_phone || '',
    mailing_address: c.mailing_address || '', mailing_city: c.mailing_city || '',
    mailing_state: c.mailing_state || '', mailing_zip: c.mailing_zip || '',
    owner_types: OWNER_TYPES,
  });
});
app.get('/api/admin/company', adminOnly, (req, res) => {
  const company = get('SELECT * FROM companies WHERE id=?', req.companyId);
  const staff = all(`SELECT id, name, email, role, archived_at, created_at FROM users
    WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id`, req.companyId);
  res.json({ company, staff, is_owner: req.user.role === 'owner' });
});
app.put('/api/admin/company', ownerOnly, (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.companyId);
  run('UPDATE companies SET name=?, contact_email=?, contact_phone=? WHERE id=?',
    req.body.name || c.name, req.body.contact_email ?? c.contact_email,
    req.body.contact_phone !== undefined ? addr.formatPhone(req.body.contact_phone) : c.contact_phone, c.id);
  res.json(get('SELECT * FROM companies WHERE id=?', c.id));
});
app.post('/api/admin/staff', ownerOnly, (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (get('SELECT id FROM users WHERE email=?', email.toLowerCase().trim()))
    return res.status(400).json({ error: 'That email is already in use' });
  const temp = 'ST-' + crypto.randomInt(100000, 999999) + '!';
  const r = run(`INSERT INTO users (company_id, email, password_hash, role, name, must_change_password)
    VALUES (?,?,?,?,?,1)`, req.companyId, email.toLowerCase().trim(), hashPassword(temp), 'admin', name);
  res.json({ id: r.lastInsertRowid, name, email, temp_password: temp });
});
app.delete('/api/admin/staff/:id', ownerOnly, (req, res, next) => {
  const u = get("SELECT * FROM users WHERE id=? AND company_id=? AND role='admin' AND deleted_at IS NULL",
    req.params.id, req.companyId);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  try { eraseUser(u.id, 'admin'); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---------- first-run setup wizard ----------
app.get('/api/admin/setup-state', adminOnly, (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.companyId);
  // Belt and braces: if this company is clearly already in use — real name, and the
  // owner has set their own password — treat setup as done even if the flag went
  // missing. Nobody should be walked through setup twice.
  if (!c.setup_complete && c.name && c.name !== 'My Company' && !req.user.must_change_password) {
    run('UPDATE companies SET setup_complete=1 WHERE id=?', c.id);
    c.setup_complete = 1;
  }
  res.json({
    setup_complete: !!c.setup_complete,
    must_change_password: !!req.user.must_change_password,
    company: { name: c.name, contact_email: c.contact_email, contact_phone: c.contact_phone,
      logo_path: c.logo_path, pass_fees_to_buyer: c.pass_fees_to_buyer,
      mgmt_company_name: c.mgmt_company_name, rep_name: c.rep_name, rep_phone: c.rep_phone,
      mailing_address: c.mailing_address, mailing_city: c.mailing_city,
      mailing_state: c.mailing_state, mailing_zip: c.mailing_zip,
      fee_label: c.fee_label },
    user: { name: req.user.name, phone: req.user.phone, email: req.user.email },
  });
});
app.post('/api/admin/setup-skip', adminOnly, (req, res) => {
  run('UPDATE companies SET setup_complete=1 WHERE id=?', req.companyId);
  res.json({ ok: true });
});

app.post('/api/admin/setup', adminOnly, (req, res, next) => {
  const b = req.body || {};
  try {
    if (b.password) {
      if (b.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(b.password), req.user.id);
    }
    if (b.name || b.phone !== undefined) {
      run('UPDATE users SET name=COALESCE(?,name), phone=? WHERE id=?',
        b.name || null, b.phone !== undefined ? addr.formatPhone(b.phone) : req.user.phone, req.user.id);
    }
    if (b.logo_base64 && b.logo_filename) {
      const stored = 'logo-' + crypto.randomUUID() + path.extname(b.logo_filename);
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), Buffer.from(b.logo_base64, 'base64'));
      run('UPDATE companies SET logo_path=? WHERE id=?', stored, req.companyId);
    }
    const c = get('SELECT * FROM companies WHERE id=?', req.companyId);
    run(`UPDATE companies SET name=?, contact_email=?, contact_phone=?,
          pass_fees_to_buyer=?, fee_label=?,
          mgmt_company_name=?, rep_name=?, rep_phone=?,
          mailing_address=?, mailing_city=?, mailing_state=?, mailing_zip=? WHERE id=?`,
      b.company_name || c.name, b.contact_email ?? c.contact_email, b.contact_phone ?? c.contact_phone,
      b.pass_fees_to_buyer === undefined ? c.pass_fees_to_buyer : (b.pass_fees_to_buyer ? 1 : 0),
      b.fee_label || c.fee_label,
      b.mgmt_company_name ?? c.mgmt_company_name, b.rep_name ?? c.rep_name,
      b.rep_phone !== undefined ? addr.formatPhone(b.rep_phone) : c.rep_phone,
      b.mailing_address ?? c.mailing_address, b.mailing_city ?? c.mailing_city,
      b.mailing_state ?? c.mailing_state, b.mailing_zip ?? c.mailing_zip, req.companyId);
    if (b.default_buyer_email !== undefined || b.default_buyer_phone !== undefined) {
      run('UPDATE companies SET default_buyer_email=?, default_buyer_phone=? WHERE id=?',
        b.default_buyer_email ?? c.default_buyer_email, b.default_buyer_phone ?? c.default_buyer_phone, req.companyId);
    }
    if (b.finish) run('UPDATE companies SET setup_complete=1 WHERE id=?', req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/company-logo/:companyId', (req, res) => {
  const c = get('SELECT logo_path FROM companies WHERE id=?', req.params.companyId);
  if (!c || !c.logo_path) return res.status(404).end();
  const f = path.join(UPLOAD_DIR, c.logo_path);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

// ---------- admin financial sync: link bank / credit card accounts ----------
app.get('/api/admin/linked-accounts', adminOnly, (req, res) => {
  res.json({
    stripe: pay.stripeEnabled(),
    accounts: all(`SELECT id, institution_name, display_name, last4, category, status, last_synced_at
      FROM linked_accounts WHERE company_id=? ORDER BY id`, req.companyId),
  });
});
app.post('/api/admin/linked-accounts/session', adminOnly, async (req, res, next) => {
  if (!pay.stripeEnabled()) return res.status(400).json({ error: 'Connect Stripe first — set STRIPE_SECRET_KEY.' });
  try {
    const customerId = await customerFor(req.user);
    const session = await pay.createFinancialConnectionsSession({ customerId, baseUrl: baseUrlOf(req) });
    res.json({ client_secret: session.client_secret, session_id: session.id });
  } catch (e) { next(e); }
});
app.post('/api/admin/linked-accounts/finish', adminOnly, async (req, res, next) => {
  try {
    const accounts = await pay.listFinancialAccounts(req.body.session_id);
    let added = 0;
    for (const a of accounts) {
      if (get('SELECT id FROM linked_accounts WHERE stripe_account_id=?', a.id)) continue;
      run(`INSERT INTO linked_accounts (company_id, stripe_account_id, institution_name,
            display_name, last4, category) VALUES (?,?,?,?,?,?)`,
        req.companyId, a.id, a.institution_name || null, a.display_name || null,
        a.last4 || null, a.category || a.subcategory || null);
      added++;
    }
    res.json({ added });
  } catch (e) { next(e); }
});
app.post('/api/admin/linked-accounts/:id/sync', adminOnly, async (req, res, next) => {
  const acct = get('SELECT * FROM linked_accounts WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  try {
    try { await pay.refreshAccountTransactions(acct.stripe_account_id); } catch {}
    const txns = await pay.listAccountTransactions(acct.stripe_account_id, 200);
    let imported = 0;
    for (const t of txns) {
      if (t.amount >= 0) continue;                                   // money in, not an expense
      const ext = `fc:${t.id}`;
      if (get('SELECT id FROM expenses WHERE external_id=?', ext)) continue;
      run(`INSERT INTO expenses (company_id, property_id, txn_date, description, amount_cents,
            category, status, linked_account_id, external_id) VALUES (?,?,?,?,?,?,?,?,?)`,
        req.companyId, null,
        new Date((t.transacted_at || t.posted_at || Date.now()/1000) * 1000).toISOString().slice(0,10),
        t.description || '(no description)', Math.abs(t.amount), null, 'unassigned', acct.id, ext);
      imported++;
    }
    run("UPDATE linked_accounts SET last_synced_at=datetime('now') WHERE id=?", acct.id);
    res.json({ imported });
  } catch (e) { next(e); }
});
app.delete('/api/admin/linked-accounts/:id', adminOnly, (req, res) => {
  const acct = get('SELECT * FROM linked_accounts WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  run("UPDATE linked_accounts SET status='disconnected' WHERE id=?", acct.id);
  res.json({ ok: true });
});

// ---------- company signup (new servicing company self-onboards) ----------
app.post('/api/signup', (req, res) => {
  if (process.env.SIGNUPS_OPEN === 'false') return res.status(403).json({ error: 'Signups are closed' });
  const { company_name, name, email, password } = req.body || {};
  if (!company_name || !name || !email || !password)
    return res.status(400).json({ error: 'Company name, your name, email, and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const em = String(email).toLowerCase().trim();
  if (get('SELECT id FROM users WHERE email=?', em)) return res.status(400).json({ error: 'That email is already registered' });
  const co = run('INSERT INTO companies (name, contact_email) VALUES (?,?)', company_name, em);
  const u = run(`INSERT INTO users (company_id, email, password_hash, role, name) VALUES (?,?,?,?,?)`,
    co.lastInsertRowid, em, hashPassword(password), 'owner', name);
  const token = sign({ uid: u.lastInsertRowid, exp: Date.now() + 30 * 86400000 });
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
  res.json({ id: u.lastInsertRowid, name, role: 'owner', company_id: co.lastInsertRowid });
});

// ---------- platform super admin ----------
app.get('/api/super/companies', superOnly, (req, res) => {
  res.json(all(`SELECT c.*,
    (SELECT COUNT(*) FROM loans WHERE company_id=c.id) AS loan_count,
    (SELECT COUNT(*) FROM users WHERE company_id=c.id AND role='tenant') AS buyer_count,
    (SELECT email FROM users WHERE company_id=c.id AND role='owner' ORDER BY id LIMIT 1) AS owner_email
    FROM companies c ORDER BY c.id DESC`));
});
app.put('/api/super/companies/:id', superOnly, (req, res) => {
  const status = req.body.status;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  run('UPDATE companies SET status=? WHERE id=?', status, req.params.id);
  res.json({ ok: true });
});

// ---------- admin: properties ----------
app.get('/api/admin/properties', adminOnly, (req, res) => {
  const props = all(`SELECT * FROM properties WHERE company_id=?
    AND (archived_at IS NULL OR ?='1') ORDER BY id DESC`,
    req.companyId, req.query.archived === '1' ? '1' : '0');
  for (const p of props) {
    p.expense_total_cents = get("SELECT COALESCE(SUM(amount_cents),0) s FROM expenses WHERE property_id=? AND status='assigned'", p.id).s;
    p.cost_basis_cents = propertyBasis(p.id).total_cents;
    p.all_in_cents = p.cost_basis_cents + p.expense_total_cents;
    const l = get("SELECT id, sale_price_cents, principal_balance_cents FROM loans WHERE property_id=? AND status='active' ORDER BY id DESC LIMIT 1", p.id);
    p.loan = l || null;
  }
  res.json(props);
});
app.post('/api/admin/properties', adminOnly, (req, res) => {
  const { address, city, state, zip, trust_name, trustee, notes } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Address required' });
  const r = run(`INSERT INTO properties (company_id, address, city, state, zip, trust_name, trustee, notes, lat, lng, county)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    req.companyId, address, city || null, state || null, zip || null, trust_name || null,
    trustee || null, notes || null, req.body.lat || null, req.body.lng || null, req.body.county || null);
  res.json(get('SELECT * FROM properties WHERE id=?', r.lastInsertRowid));
});
// ---------- listing ----------
// Only http and https are stored. A link is rendered as something a person clicks, so
// anything else — javascript:, data: — has no business being saved in the first place.
function cleanListingUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw new Error('That does not look like a web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('A listing link has to start with http:// or https://');
  }
  return u.toString();
}
function listingSource(url) {
  const h = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  if (/zillow\./i.test(h)) return 'zillow';
  if (/facebook\.|fb\./i.test(h)) return 'facebook';
  if (/realtor\.|redfin\.|trulia\./i.test(h)) return 'other';
  return h ? 'website' : 'other';
}

app.put('/api/admin/properties/:id/listing', adminOnly, (req, res, next) => {
  try {
    const p = ownedProperty(req, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const url = cleanListingUrl(b.listing_url);
    const num = (v) => (v === '' || v == null ? null : Math.round(Number(v)));
    run(`UPDATE properties SET listing_url=?, listing_source=?, listing_price_cents=?,
         listing_down_cents=?, listing_payment_cents=?, listing_rate_bps=?,
         listing_notes=?, listing_captured_at=? WHERE id=?`,
      url, url ? (b.listing_source || listingSource(url)) : null,
      num(b.listing_price_cents), num(b.listing_down_cents),
      num(b.listing_payment_cents), num(b.listing_rate_bps),
      b.listing_notes || null,
      url ? (p.listing_captured_at || new Date().toISOString()) : null, p.id);
    res.json(get('SELECT * FROM properties WHERE id=?', p.id));
  } catch (e) { next(e); }
});

app.put('/api/admin/properties/:id', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = { ...p, ...req.body };
  const n = (v) => (v === '' || v == null ? null : Math.round(Number(v)));
  run(`UPDATE properties SET address=?, city=?, state=?, zip=?, county=?, trust_name=?, trustee=?,
       notes=?, lat=?, lng=?, owner_name=?, owner_type=?, beds=?, baths=?, sqft=?, year_built=?,
       acquired_date=?, purchase_price_cents=?, target_sale_price_cents=?,
       late_fee_cents=?, grace_days=?, due_day=?,
       insurance_carrier=?, insurance_expires=?, tax_due_date=?, tax_due_date2=? WHERE id=?`,
    b.address, b.city, b.state, b.zip, b.county ?? null, b.trust_name, b.trustee,
    b.notes, b.lat ?? null, b.lng ?? null, b.owner_name ?? null, b.owner_type ?? null,
    n(b.beds), b.baths === '' || b.baths == null ? null : Number(b.baths), n(b.sqft), n(b.year_built),
    b.acquired_date || null, n(b.purchase_price_cents), n(b.target_sale_price_cents),
    n(b.late_fee_cents), n(b.grace_days), n(b.due_day),
    b.insurance_carrier || null, b.insurance_expires || null, b.tax_due_date || null, b.tax_due_date2 || null, p.id);
  res.json(get('SELECT * FROM properties WHERE id=?', p.id));
});

// ---------- archive / delete ----------
// Archiving is the safe one: the house drops out of your lists and nothing else changes.
app.post('/api/admin/properties/:id/archive', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.archived_at) return res.status(400).json({ error: 'Already archived' });
  const activeLoan = get("SELECT id FROM loans WHERE property_id=? AND status='active'", p.id);
  if (activeLoan) {
    return res.status(400).json({
      error: 'This house still has an active loan on it. Archiving would hide a buyer who is still paying you.' });
  }
  run("UPDATE properties SET archived_at=datetime('now'), archived_reason=? WHERE id=?",
    (req.body && req.body.reason) || null, p.id);
  res.json({ ok: true });
});

app.post('/api/admin/properties/:id/restore', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  run('UPDATE properties SET archived_at=NULL, archived_reason=NULL WHERE id=?', p.id);
  res.json({ ok: true });
});

// What a house is carrying, so a delete can refuse for a reason rather than just refusing.
function propertyTies(id) {
  const c = (sql, ...a) => get(sql, ...a).c;
  return {
    loans: c('SELECT COUNT(*) c FROM loans WHERE property_id=?', id),
    pml_loans: c('SELECT COUNT(*) c FROM pml_loans WHERE property_id=?', id),
    journal_entries: c('SELECT COUNT(*) c FROM journal_entries WHERE property_id=?', id),
    costs: c('SELECT COUNT(*) c FROM property_costs WHERE property_id=?', id),
    documents: c('SELECT COUNT(*) c FROM documents WHERE property_id=?', id),
    expenses: c('SELECT COUNT(*) c FROM expenses WHERE property_id=?', id),
  };
}

app.get('/api/admin/properties/:id/ties', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const t = propertyTies(p.id);
  const blocking = t.loans + t.pml_loans + t.journal_entries;
  res.json({ ...t, can_delete: blocking === 0, blocking });
});

// Deleting is only allowed for a house that never became a deal. Once there is a loan
// or a single journal entry against it, the record is part of the books and archiving
// is the right answer — a deleted property would leave money pointing at nothing.
app.delete('/api/admin/properties/:id', adminOnly, (req, res, next) => {
  try {
    const p = ownedProperty(req, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    // Two confirmations exist: DELETE for a clean house, DELETE EVERYTHING for a purge.
    // Either gets past this gate; the purge branch checks for its own stronger phrase.
    if (!req.body || (req.body.confirm !== 'DELETE' && req.body.confirm !== 'DELETE EVERYTHING')) {
      return res.status(400).json({ error: 'Type DELETE to confirm' });
    }
    const t = propertyTies(p.id);
    if (t.loans || t.pml_loans || t.journal_entries) {
      // The financial file exists. Without the purge flag: the same refusal as always.
      // With it: the owner is tearing up the whole file — a test property being reset —
      // so back up everything, then remove loan by loan, entry by entry, until the
      // property row itself can go. Both sides of every journal entry leave together,
      // so what remains still balances.
      if (!req.body || !req.body.purge) {
        const why = [
          t.loans ? `${t.loans} loan${t.loans === 1 ? '' : 's'}` : null,
          t.pml_loans ? `${t.pml_loans} lender loan${t.pml_loans === 1 ? '' : 's'}` : null,
          t.journal_entries ? `${t.journal_entries} ledger entr${t.journal_entries === 1 ? 'y' : 'ies'}` : null,
        ].filter(Boolean).join(', ');
        return res.status(400).json({
          error: `This house has ${why} against it. Deleting it would leave money in your books pointing at nothing. ` +
                 `Archive it instead — or, if this was a test property, the owner can purge the whole file, ` +
                 `backed up first.`,
          ties: t, purgeable: true,
        });
      }
      if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can purge a property with money against it' });
      if (req.body.confirm !== 'DELETE EVERYTHING') return res.status(400).json({ error: 'Type DELETE EVERYTHING to confirm' });

      const loans = all('SELECT * FROM loans WHERE property_id=?', p.id);
      const pmls = all('SELECT * FROM pml_loans WHERE property_id=?', p.id);
      const loanIds = loans.map(l => l.id);
      const inLoans = loanIds.length ? `(${loanIds.join(',')})` : '(NULL)';
      const pmlIds = pmls.map(l => l.id);
      const inPmls = pmlIds.length ? `(${pmlIds.join(',')})` : '(NULL)';

      // Everything first, into one backup filed as a company document.
      const backup = {
        purged_at: new Date().toISOString(), purged_by: req.user.email,
        property: p, loans, pml_loans: pmls,
        pml_ledger: all(`SELECT * FROM pml_ledger WHERE pml_loan_id IN ${inPmls}`),
        journal_entries: all(`SELECT * FROM journal_entries WHERE property_id=? OR loan_id IN ${inLoans} OR pml_loan_id IN ${inPmls}`, p.id),
        costs: all('SELECT * FROM property_costs WHERE property_id=?', p.id),
        recurring_costs: all('SELECT * FROM recurring_costs WHERE property_id=?', p.id),
        contacts: all('SELECT * FROM property_contacts WHERE property_id=?', p.id),
        tasks: all('SELECT * FROM tasks WHERE property_id=? OR loan_id IN ' + inLoans, p.id),
        notes: all('SELECT * FROM notes WHERE property_id=? OR loan_id IN ' + inLoans, p.id),
        documents: all('SELECT * FROM documents WHERE property_id=? OR loan_id IN ' + inLoans, p.id),
      };
      for (const tbl of ['ledger', 'notices', 'charges', 'messages', 'escrow_items', 'escrow_analyses',
                         'escrow_disbursements', 'payoff_quotes', 'cash_slips', 'invitations', 'autopay', 'email_log']) {
        backup[tbl] = all(`SELECT * FROM ${tbl} WHERE loan_id IN ${inLoans}`);
      }
      const stored = crypto.randomUUID() + '.json';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), JSON.stringify(backup, null, 2));
      run(`INSERT INTO documents (company_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
           VALUES (?,?,?,?,?,?,?,0)`,
        req.companyId, 'other', 'private',
        `Backup — purged property ${p.address || ('#' + p.id)} (${new Date().toISOString().slice(0, 10)})`,
        `purged-property-${p.id}.json`, stored, 'application/json');

      // The removal: journal first (lines with their entries), then every loan child,
      // then the loans, the lender loans, the property attachments, the property.
      run(`DELETE FROM journal_lines WHERE entry_id IN
             (SELECT id FROM journal_entries WHERE property_id=? OR loan_id IN ${inLoans} OR pml_loan_id IN ${inPmls})`, p.id);
      run(`DELETE FROM journal_entries WHERE property_id=? OR loan_id IN ${inLoans} OR pml_loan_id IN ${inPmls}`, p.id);
      for (const tbl of ['ledger', 'notices', 'charges', 'messages', 'escrow_items', 'escrow_analyses',
                         'escrow_disbursements', 'payoff_quotes', 'cash_slips', 'invitations', 'autopay', 'email_log',
                         'tasks', 'notes']) {
        run(`DELETE FROM ${tbl} WHERE loan_id IN ${inLoans}`);
      }
      for (const d of all(`SELECT * FROM documents WHERE property_id=? OR loan_id IN ${inLoans}`, p.id)) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch {}
        run('DELETE FROM documents WHERE id=?', d.id);
      }
      run(`DELETE FROM pml_ledger WHERE pml_loan_id IN ${inPmls}`);
      run(`DELETE FROM pml_loans WHERE property_id=?`, p.id);
      run(`DELETE FROM loans WHERE property_id=?`, p.id);
      run('DELETE FROM property_costs WHERE property_id=?', p.id);
      run('DELETE FROM recurring_costs WHERE property_id=?', p.id);
      run('UPDATE expenses SET property_id=NULL, status=\'unassigned\' WHERE property_id=?', p.id);
      run('DELETE FROM property_contacts WHERE property_id=?', p.id);
      run('DELETE FROM tasks WHERE property_id=?', p.id);
      run('DELETE FROM notes WHERE property_id=?', p.id);
      run('DELETE FROM properties WHERE id=?', p.id);
      return res.json({ ok: true, purged: true });
    }
    // Safe to remove financially — but "safe" is not the same as "worthless". Costs,
    // documents and notes took time to enter, and a delete typed on autopilot should
    // not be able to destroy the only copy. So: everything this delete removes goes
    // into a JSON backup first, filed as a company document. The backup keeps each
    // document row's stored filename, and the files themselves are never unlinked,
    // so a deleted property's paperwork can be re-filed from Settings later.
    const backup = {
      deleted_at: new Date().toISOString(), deleted_by: req.user.email,
      property: p,
      costs: all('SELECT * FROM property_costs WHERE property_id=?', p.id),
      recurring_costs: all('SELECT * FROM recurring_costs WHERE property_id=?', p.id),
      contacts: all('SELECT * FROM property_contacts WHERE property_id=?', p.id),
      tasks: all('SELECT * FROM tasks WHERE property_id=?', p.id),
      notes: all('SELECT * FROM notes WHERE property_id=?', p.id),
      documents: all('SELECT * FROM documents WHERE property_id=?', p.id),
    };
    const hasAnything = Object.values(backup).some(v => Array.isArray(v) && v.length);
    if (hasAnything) {
      const stored = crypto.randomUUID() + '.json';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), JSON.stringify(backup, null, 2));
      run(`INSERT INTO documents (company_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
           VALUES (?,?,?,?,?,?,?,0)`,
        req.companyId, 'other', 'private',
        `Backup — deleted property ${p.address || ('#' + p.id)} (${new Date().toISOString().slice(0, 10)})`,
        `deleted-property-${p.id}.json`, stored, 'application/json');
    }
    run('DELETE FROM property_costs WHERE property_id=?', p.id);
    run('DELETE FROM recurring_costs WHERE property_id=?', p.id);
    run('UPDATE expenses SET property_id=NULL, status=\'unassigned\' WHERE property_id=?', p.id);
    run('DELETE FROM property_contacts WHERE property_id=?', p.id);
    run('DELETE FROM tasks WHERE property_id=?', p.id);
    run('DELETE FROM notes WHERE property_id=?', p.id);
    run('DELETE FROM documents WHERE property_id=?', p.id);
    run('DELETE FROM properties WHERE id=?', p.id);
    res.json({ ok: true, backed_up: hasAnything });
  } catch (e) { next(e); }
});

// ---------- orphaned file recovery ----------
// Document rows can die while their files live on — nothing here ever unlinked a
// property's files on delete. These endpoints find those files and let the owner
// re-file them, which is how paperwork comes back after a delete that shouldn't
// have happened.
app.get('/api/admin/orphan-files', ownerOnly, (req, res, next) => {
  try {
    const known = new Set(all('SELECT stored_name FROM documents').map(d => d.stored_name));
    const files = fs.readdirSync(UPLOAD_DIR)
      .filter(f => !known.has(f) && !f.startsWith('.'))
      .map(f => {
        const st = fs.statSync(path.join(UPLOAD_DIR, f));
        return { stored_name: f, size: st.size, modified: st.mtime.toISOString(),
                 ext: path.extname(f).toLowerCase() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ files });
  } catch (e) { next(e); }
});
// Look at one orphan to identify it. basename() strips any path tricks; the file must
// actually be in the uploads directory and unreferenced paths cannot escape it.
app.get('/api/admin/orphan-files/:name/view', ownerOnly, (req, res, next) => {
  try {
    const name = path.basename(req.params.name);
    const full = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
    const mime = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
                   '.jpeg': 'image/jpeg', '.json': 'application/json', '.txt': 'text/plain' }[path.extname(name).toLowerCase()];
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.send(fs.readFileSync(full));
  } catch (e) { next(e); }
});
// Or throw the stranded file away — the owner already has the original elsewhere.
// Only files no document row references can be deleted this way.
app.delete('/api/admin/orphan-files/:name', ownerOnly, (req, res, next) => {
  try {
    const name = path.basename(req.params.name);
    const full = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
    if (get('SELECT id FROM documents WHERE stored_name=?', name)) {
      return res.status(400).json({ error: 'That file is filed on a document — delete the document instead' });
    }
    fs.unlinkSync(full);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/admin/orphan-files/:name/restore', ownerOnly, (req, res, next) => {
  try {
    const name = path.basename(req.params.name);
    if (!fs.existsSync(path.join(UPLOAD_DIR, name))) return res.status(404).json({ error: 'Not found' });
    if (get('SELECT id FROM documents WHERE stored_name=?', name)) return res.status(400).json({ error: 'That file is already filed' });
    const b = req.body || {};
    const propertyId = b.property_id && ownedProperty(req, b.property_id) ? Number(b.property_id) : null;
    const r = run(`INSERT INTO documents (company_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
         VALUES (?,?,?,?,?,?,?,?,0)`,
      req.companyId, propertyId, 'other', 'private',
      b.title || `Recovered file (${name.slice(0, 8)})`,
      b.filename || ('recovered' + path.extname(name)), name,
      { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(name).toLowerCase()] || null);
    res.json(get('SELECT id, title, filename FROM documents WHERE id=?', r.lastInsertRowid));
  } catch (e) { next(e); }
});

// ---------- tasks & calendar ----------
// A to-do list that knows about your properties. Tasks are internal: nothing here is
// ever visible to a buyer. Anything with a date shows on the calendar; the calendar
// also layers in dates the app already knows — payments due, lender payments out, and
// insurance and tax renewals — each of which can be switched off.

const TASK_CATEGORIES = {
  general: { label: 'General', icon: '📌' },
  rehab: { label: 'Rehab / repairs', icon: '🔨' },
  bog: { label: 'Boots on the ground', icon: '👟' },
  showing: { label: 'Showing / marketing', icon: '🪧' },
  closing: { label: 'Closing', icon: '🖊️' },
  filing: { label: 'Filing & recording', icon: '🗂️' },
  insurance: { label: 'Insurance', icon: '🛡️' },
  taxes: { label: 'Taxes', icon: '🏛️' },
  legal: { label: 'Legal', icon: '⚖️' },
  collections: { label: 'Collections', icon: '📞' },
  inspection: { label: 'Inspection', icon: '🔍' },
};

const todayStr = () => new Date().toISOString().slice(0, 10);

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonthsStr(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));   // 31st in a 30-day month lands on the 30th
  return d.toISOString().slice(0, 10);
}
// When a repeating task is ticked off, this is when the next one is due.
function nextOccurrence(dateStr, repeat) {
  if (!dateStr || repeat === 'none') return null;
  switch (repeat) {
    case 'weekly': return addDaysStr(dateStr, 7);
    case 'biweekly': return addDaysStr(dateStr, 14);
    case 'monthly': return addMonthsStr(dateStr, 1);
    case 'quarterly': return addMonthsStr(dateStr, 3);
    case 'yearly': return addMonthsStr(dateStr, 12);
    default: return null;
  }
}

function taskRow(t) {
  const cat = TASK_CATEGORIES[t.category] || TASK_CATEGORIES.general;
  return {
    ...t,
    category_label: cat.label,
    category_icon: cat.icon,
    is_overdue: t.status === 'open' && !!t.due_date && t.due_date < todayStr(),
    is_today: t.status === 'open' && t.due_date === todayStr(),
  };
}

const TASK_SELECT = `SELECT t.*, p.address AS property_address, p.city AS property_city,
  u.name AS assigned_name, cu.name AS completed_by_name
  FROM tasks t
  LEFT JOIN properties p ON p.id = t.property_id
  LEFT JOIN users u ON u.id = t.assigned_to
  LEFT JOIN users cu ON cu.id = t.completed_by`;

app.get('/api/admin/tasks', adminOnly, (req, res) => {
  const q = req.query;
  const where = ['t.company_id = ?'];
  const args = [req.companyId];
  if (q.property_id) { where.push('t.property_id = ?'); args.push(q.property_id); }
  if (q.status && q.status !== 'all') { where.push('t.status = ?'); args.push(q.status); }
  if (q.category) { where.push('t.category = ?'); args.push(q.category); }
  if (q.assigned_to) { where.push('t.assigned_to = ?'); args.push(q.assigned_to); }
  if (q.from) { where.push('t.due_date >= ?'); args.push(q.from); }
  if (q.to) { where.push('t.due_date <= ?'); args.push(q.to); }
  // Undated tasks last, then soonest first, then high priority first.
  const rows = all(`${TASK_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY t.status ASC, (t.due_date IS NULL) ASC, t.due_date ASC,
      CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.id DESC`, ...args)
    .map(taskRow);

  const today = todayStr();
  res.json({
    tasks: rows,
    categories: TASK_CATEGORIES,
    counts: {
      open: rows.filter(t => t.status === 'open').length,
      overdue: rows.filter(t => t.is_overdue).length,
      today: rows.filter(t => t.is_today).length,
      week: rows.filter(t => t.status === 'open' && t.due_date && t.due_date >= today
        && t.due_date <= addDaysStr(today, 7)).length,
      undated: rows.filter(t => t.status === 'open' && !t.due_date).length,
    },
  });
});

app.post('/api/admin/tasks', adminOnly, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Give the task a title' });
  if (b.property_id && !ownedProperty(req, b.property_id)) {
    return res.status(400).json({ error: 'That property is not yours' });
  }
  const r = run(`INSERT INTO tasks (company_id, property_id, loan_id, title, notes, category,
      priority, due_date, due_time, assigned_to, repeat_every, repeat_until, remind_days_before, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.companyId, b.property_id || null, b.loan_id || null, title, b.notes || null,
    b.category || 'general', b.priority || 'normal', b.due_date || null, b.due_time || null,
    b.assigned_to || null, b.repeat_every || 'none', b.repeat_until || null,
    b.remind_days_before != null ? Number(b.remind_days_before) : null, req.user.id);
  res.json(taskRow(get(`${TASK_SELECT} WHERE t.id=?`, r.lastInsertRowid)));
});

app.put('/api/admin/tasks/:id', adminOnly, (req, res) => {
  const t = get('SELECT * FROM tasks WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const b = req.body || {};
  if (b.property_id && !ownedProperty(req, b.property_id)) {
    return res.status(400).json({ error: 'That property is not yours' });
  }
  const allowed = ['property_id', 'loan_id', 'title', 'notes', 'category', 'priority',
    'due_date', 'due_time', 'assigned_to', 'repeat_every', 'repeat_until', 'remind_days_before'];
  const sets = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(b[k] === '' ? null : b[k]); }
  // Moving the date should let the reminder fire again for the new one.
  if (b.due_date !== undefined && b.due_date !== t.due_date) { sets.push('reminded_at=?'); vals.push(null); }
  if (sets.length) run(`UPDATE tasks SET ${sets.join(',')} WHERE id=?`, ...vals, t.id);
  res.json(taskRow(get(`${TASK_SELECT} WHERE t.id=?`, t.id)));
});

// Tick off. A repeating task quietly creates its next occurrence so the chain continues.
app.post('/api/admin/tasks/:id/complete', adminOnly, (req, res) => {
  const t = get('SELECT * FROM tasks WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const reopen = req.body && req.body.reopen;
  if (reopen) {
    run("UPDATE tasks SET status='open', completed_at=NULL, completed_by=NULL WHERE id=?", t.id);
    return res.json({ task: taskRow(get(`${TASK_SELECT} WHERE t.id=?`, t.id)), next: null });
  }
  run("UPDATE tasks SET status='done', completed_at=datetime('now'), completed_by=? WHERE id=?",
    req.user.id, t.id);

  let next = null;
  const nextDate = nextOccurrence(t.due_date, t.repeat_every);
  if (nextDate && (!t.repeat_until || nextDate <= t.repeat_until)) {
    const r = run(`INSERT INTO tasks (company_id, property_id, loan_id, title, notes, category,
        priority, due_date, due_time, assigned_to, repeat_every, repeat_until, remind_days_before, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.company_id, t.property_id, t.loan_id, t.title, t.notes, t.category, t.priority,
      nextDate, t.due_time, t.assigned_to, t.repeat_every, t.repeat_until,
      t.remind_days_before, req.user.id);
    next = taskRow(get(`${TASK_SELECT} WHERE t.id=?`, r.lastInsertRowid));
  }
  res.json({ task: taskRow(get(`${TASK_SELECT} WHERE t.id=?`, t.id)), next });
});

app.delete('/api/admin/tasks/:id', adminOnly, (req, res) => {
  const t = get('SELECT id FROM tasks WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  run('DELETE FROM tasks WHERE id=?', t.id);
  res.json({ ok: true });
});

// ---------- the calendar ----------
// Your tasks, plus three layers the app can work out for itself. Each layer is a
// query parameter so the front end can switch it off and show only what you put there.
app.get('/api/admin/calendar', adminOnly, (req, res) => {
  const from = req.query.from || todayStr();
  const to = req.query.to || addDaysStr(from, 60);
  const want = (name) => req.query[name] !== '0' && req.query[name] !== 'false';
  const events = [];

  // 1. Tasks with a date on them.
  if (want('tasks')) {
    for (const t of all(`${TASK_SELECT} WHERE t.company_id=? AND t.due_date BETWEEN ? AND ?`,
      req.companyId, from, to)) {
      const cat = TASK_CATEGORIES[t.category] || TASK_CATEGORIES.general;
      events.push({
        source: 'task', id: 'task-' + t.id, task_id: t.id,
        date: t.due_date, time: t.due_time || null,
        title: t.title, icon: cat.icon, category: t.category,
        property_id: t.property_id, property_address: t.property_address,
        status: t.status, priority: t.priority,
        overdue: t.status === 'open' && t.due_date < todayStr(),
      });
    }
  }

  // 2. What buyers owe, on their own due day.
  if (want('payments')) {
    const loans = all(`SELECT l.*, p.address, u.name AS buyer_name FROM loans l
      JOIN properties p ON p.id=l.property_id
      LEFT JOIN users u ON u.id=l.tenant_user_id
      WHERE l.company_id=? AND l.status='active'`, req.companyId);
    for (const l of loans) {
      const ledger = all('SELECT * FROM ledger WHERE loan_id=? ORDER BY entry_date, id', l.id);
      const status = loanEngine.loanStatus(l, ledger, today());
      for (const d of monthlyDatesBetween(l.first_payment_date, l.due_day, from, to, l.term_months)) {
        const past = d < todayStr();
        events.push({
          source: 'payment', id: `pay-${l.id}-${d}`, loan_id: l.id, date: d, time: null,
          title: `${l.buyer_name || 'Buyer'} — payment due`,
          amount_cents: l.payment_cents + (l.escrow_cents || 0),
          icon: '💵', property_id: l.property_id, property_address: l.address,
          overdue: past && status.is_past_due,
        });
      }
    }
  }

  // 3. What you owe your lenders.
  if (want('pml')) {
    const pmls = all(`SELECT pl.*, p.address FROM pml_loans pl
      JOIN properties p ON p.id=pl.property_id
      WHERE pl.company_id=? AND pl.status='active'`, req.companyId);
    for (const pl of pmls) {
      for (const d of monthlyDatesBetween(pl.first_payment_date, null, from, to, pl.term_months)) {
        events.push({
          source: 'pml', id: `pml-${pl.id}-${d}`, pml_loan_id: pl.id, date: d, time: null,
          title: `Pay ${pl.lender_name}`, amount_cents: pl.payment_cents,
          icon: '🏦', property_id: pl.property_id, property_address: pl.address,
          overdue: false,
        });
      }
      if (pl.balloon_date && pl.balloon_date >= from && pl.balloon_date <= to) {
        events.push({
          source: 'pml', id: `pml-balloon-${pl.id}`, pml_loan_id: pl.id, date: pl.balloon_date,
          title: `BALLOON due — ${pl.lender_name}`, amount_cents: pl.principal_balance_cents,
          icon: '🎈', property_id: pl.property_id, property_address: pl.address, overdue: false,
        });
      }
    }
  }

  // 4. Escrow bills that are actually scheduled, which is more precise than the
  //    single renewal date on the property.
  if (want('renewals')) {
    for (const d of all(`SELECT d.*, l.property_id, p.address, ei.item_type
      FROM escrow_disbursements d
      JOIN loans l ON l.id = d.loan_id
      LEFT JOIN properties p ON p.id = l.property_id
      LEFT JOIN escrow_items ei ON ei.id = d.escrow_item_id
      WHERE l.company_id=? AND d.scheduled_date >= ? AND d.scheduled_date <= ?`,
      req.companyId, from, to)) {
      const tax = d.item_type !== 'hazard_insurance' && d.item_type !== 'flood_insurance';
      events.push({
        source: 'renewal', id: `esc-${d.id}`, date: d.scheduled_date,
        icon: tax ? '🏛️' : '🛡️',
        title: `${tax ? 'Property tax' : 'Insurance'} ${d.status === 'paid' ? 'paid' : 'due'} — ` +
               `$${(d.amount_cents / 100).toFixed(2)}${d.payee ? ' to ' + d.payee : ''}`,
        property_id: d.property_id, property_address: d.address,
        overdue: d.status === 'scheduled' && d.scheduled_date < todayStr(),
      });
    }
  }

  // 5. Renewals that belong to the house.
  if (want('renewals')) {
    for (const p of all(`SELECT id, address, insurance_expires, insurance_carrier, tax_due_date, tax_due_date2
      FROM properties WHERE company_id=?`, req.companyId)) {
      if (p.insurance_expires && p.insurance_expires >= from && p.insurance_expires <= to) {
        events.push({
          source: 'renewal', id: `ins-${p.id}`, date: p.insurance_expires, icon: '🛡️',
          title: `Insurance expires${p.insurance_carrier ? ' — ' + p.insurance_carrier : ''}`,
          property_id: p.id, property_address: p.address,
          overdue: p.insurance_expires < todayStr(),
        });
      }
      for (const [n, d] of [[1, p.tax_due_date], [2, p.tax_due_date2]]) {
        if (d && d >= from && d <= to) {
          events.push({
            source: 'renewal', id: `tax-${p.id}-${n}`, date: d, icon: '🏛️',
            title: `Property taxes due${p.tax_due_date && p.tax_due_date2 ? ` (${n === 1 ? '1st' : '2nd'} installment)` : ''}`,
            property_id: p.id, property_address: p.address,
            overdue: d < todayStr(),
          });
        }
      }
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  res.json({ from, to, events, categories: TASK_CATEGORIES });
});

// Every occurrence of a monthly obligation that falls inside a window.
function monthlyDatesBetween(firstDate, dueDay, from, to, termMonths) {
  if (!firstDate) return [];
  const out = [];
  let d = firstDate;
  // Jump forward in whole months rather than stepping one at a time from the start.
  const monthsApart = (a, b) => {
    const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
  };
  const skip = Math.max(0, monthsApart(firstDate, from));
  if (skip) d = addMonthsStr(firstDate, skip);
  let n = skip;
  while (d <= to && (!termMonths || n < termMonths)) {
    if (d >= from) {
      // due_day overrides the day-of-month when the property sets one.
      out.push(dueDay ? d.slice(0, 8) + String(dueDay).padStart(2, '0') : d);
    }
    n += 1;
    d = addMonthsStr(firstDate, n);
  }
  return out.filter(x => x >= from && x <= to);
}

// Tasks coming up get the same pop-up treatment as payment reminders.
async function runTaskReminderSweep() {
  const today = todayStr();
  const due = all(`SELECT t.*, p.address FROM tasks t LEFT JOIN properties p ON p.id=t.property_id
    WHERE t.status='open' AND t.due_date IS NOT NULL AND t.remind_days_before IS NOT NULL
      AND t.reminded_at IS NULL
      AND date(t.due_date, '-' || t.remind_days_before || ' days') <= ?`, today);
  for (const t of due) {
    const who = t.assigned_to || t.created_by;
    if (!who) continue;
    const when = t.due_date === today ? 'today' : `on ${t.due_date}`;
    try {
      await notify.notify(who, {
        kind: 'general',
        title: (TASK_CATEGORIES[t.category] || TASK_CATEGORIES.general).icon + ' ' + t.title,
        body: `Due ${when}${t.address ? ' · ' + t.address : ''}`,
        url: '/admin#tasks',
        dedupeKey: `task-${t.id}-${t.due_date}`,
      });
    } catch (e) { console.error('Task reminder failed', t.id, e.message); }
    run("UPDATE tasks SET reminded_at=datetime('now') WHERE id=?", t.id);
  }
  return due.length;
}
setInterval(runTaskReminderSweep, 6 * 60 * 60 * 1000);
setTimeout(runTaskReminderSweep, 45000);
app.post('/api/admin/tasks/run-reminders', adminOnly, async (req, res, next) => {
  try { res.json({ ok: true, sent: await runTaskReminderSweep() }); } catch (e) { next(e); }
});

// ---------- contacts & vendor texting ----------
// Two different kinds of texting live in this app and they behave differently on purpose.
// Buyers get one outbound invitation from a send-only number. Vendors — boots on the
// ground, the attorney, the agent — get a real two-way conversation, because you need
// their reply. Inbound texts from a known contact land in their thread; anything from an
// unknown number still gets the automatic "use the app" answer.

// The signed-in admin's own company — texting credentials hang off it.
function myCompany(req) { return get('SELECT * FROM companies WHERE id=?', req.companyId); }

const CONTACT_ROLES = {
  bog: { label: 'Boots on the ground', icon: '👟' },
  contractor: { label: 'Contractor', icon: '🔨' },
  legal: { label: 'Attorney / legal', icon: '⚖️' },
  title: { label: 'Title / closing', icon: '🖊️' },
  insurance: { label: 'Insurance agent', icon: '🛡️' },
  lender: { label: 'Private money lender', icon: '🏦' },
  inspector: { label: 'Inspector', icon: '🔍' },
  agent: { label: 'Real estate agent', icon: '🪧' },
  tax: { label: 'Tax / accounting', icon: '🏛️' },
  utility: { label: 'Utility company', icon: '💡' },
  other: { label: 'Other', icon: '📇' },
};

const contactRow = (c) => ({
  ...c,
  role_label: (CONTACT_ROLES[c.role] || CONTACT_ROLES.other).label,
  role_icon: (CONTACT_ROLES[c.role] || CONTACT_ROLES.other).icon,
});

app.get('/api/admin/contacts', adminOnly, (req, res) => {
  const showArchived = req.query.archived === '1';
  const rows = all(`SELECT c.*,
      (SELECT COUNT(*) FROM property_contacts pc WHERE pc.contact_id=c.id) AS property_count,
      (SELECT COUNT(*) FROM contact_messages m WHERE m.contact_id=c.id) AS message_count,
      (SELECT COUNT(*) FROM contact_messages m WHERE m.contact_id=c.id
         AND m.direction='in' AND m.read_at IS NULL) AS unread_count
    FROM contacts c
    WHERE c.company_id=? AND c.archived_at IS ${showArchived ? 'NOT' : ''} NULL
    ORDER BY c.name`, req.companyId).map(contactRow);
  res.json({ contacts: rows, roles: CONTACT_ROLES, sms_enabled: sms.smsEnabled(myCompany(req)) });
});

app.post('/api/admin/contacts', adminOnly, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the contact a name' });
  if (!b.phone && !b.email) return res.status(400).json({ error: 'Add a phone number or an email' });
  const r = run(`INSERT INTO contacts (company_id, name, role, business_name, phone, email,
      address, city, state, zip, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    req.companyId, name, b.role || 'other', b.business_name || null,
    addr.formatPhone(b.phone) || null, b.email ? String(b.email).trim() : null,
    b.address || null, b.city || null, b.state || null, b.zip || null, b.notes || null);
  const c = contactRow(get('SELECT * FROM contacts WHERE id=?', r.lastInsertRowid));
  // Created from inside a property? Attach it there and then.
  if (b.property_id && ownedProperty(req, b.property_id)) {
    run('INSERT OR IGNORE INTO property_contacts (property_id, contact_id, role_note) VALUES (?,?,?)',
      b.property_id, c.id, b.role_note || null);
  }
  res.json(c);
});

app.put('/api/admin/contacts/:id', adminOnly, (req, res) => {
  const c = get('SELECT * FROM contacts WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  const b = { ...c, ...req.body };
  run(`UPDATE contacts SET name=?, role=?, business_name=?, phone=?, email=?,
       address=?, city=?, state=?, zip=?, notes=? WHERE id=?`,
    b.name, b.role, b.business_name, addr.formatPhone(b.phone) || null, b.email,
    b.address, b.city, b.state, b.zip, b.notes, c.id);
  res.json(contactRow(get('SELECT * FROM contacts WHERE id=?', c.id)));
});

// Archive rather than delete — the text history stays readable.
app.post('/api/admin/contacts/:id/archive', adminOnly, (req, res) => {
  const c = get('SELECT id FROM contacts WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  run(req.body && req.body.restore
    ? 'UPDATE contacts SET archived_at=NULL WHERE id=?'
    : "UPDATE contacts SET archived_at=datetime('now') WHERE id=?", c.id);
  res.json({ ok: true });
});

// ---------- who works on this house ----------
app.get('/api/admin/properties/:id/contacts', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const rows = all(`SELECT c.*, pc.role_note, pc.id AS link_id,
      (SELECT COUNT(*) FROM contact_messages m WHERE m.contact_id=c.id AND m.property_id=?) AS message_count,
      (SELECT body FROM contact_messages m WHERE m.contact_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM contact_messages m WHERE m.contact_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message_at,
      (SELECT COUNT(*) FROM contact_messages m WHERE m.contact_id=c.id
         AND m.direction='in' AND m.read_at IS NULL) AS unread_count
    FROM property_contacts pc JOIN contacts c ON c.id=pc.contact_id
    WHERE pc.property_id=? AND c.archived_at IS NULL
    ORDER BY c.role, c.name`, p.id, p.id).map(contactRow);
  res.json({ contacts: rows, roles: CONTACT_ROLES, sms_enabled: sms.smsEnabled(myCompany(req)) });
});

app.post('/api/admin/properties/:id/contacts', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const c = get('SELECT id FROM contacts WHERE id=? AND company_id=?', req.body.contact_id, req.companyId);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  run('INSERT OR IGNORE INTO property_contacts (property_id, contact_id, role_note) VALUES (?,?,?)',
    p.id, c.id, req.body.role_note || null);
  res.json({ ok: true });
});

app.delete('/api/admin/properties/:pid/contacts/:cid', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.pid);
  if (!p) return res.status(404).json({ error: 'Not found' });
  run('DELETE FROM property_contacts WHERE property_id=? AND contact_id=?', p.id, req.params.cid);
  res.json({ ok: true });
});

// ---------- texting a contact ----------
app.get('/api/admin/contacts/:id/messages', adminOnly, (req, res) => {
  const c = get('SELECT * FROM contacts WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  const rows = all(`SELECT m.*, p.address AS property_address, u.name AS sent_by_name
    FROM contact_messages m
    LEFT JOIN properties p ON p.id=m.property_id
    LEFT JOIN users u ON u.id=m.sent_by
    WHERE m.contact_id=? ORDER BY m.id`, c.id);
  run("UPDATE contact_messages SET read_at=datetime('now') WHERE contact_id=? AND direction='in' AND read_at IS NULL", c.id);
  res.json({ contact: contactRow(c), messages: rows, sms_enabled: sms.smsEnabled(myCompany(req)) });
});

app.post('/api/admin/contacts/:id/messages', adminOnly, async (req, res, next) => {
  const c = get('SELECT * FROM contacts WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Nothing to send' });
  const phone = sms.normalizePhone(req.body.phone || c.phone);
  if (!phone) return res.status(400).json({ error: 'No mobile number on this contact' });
  const propertyId = req.body.property_id && ownedProperty(req, req.body.property_id)
    ? req.body.property_id : null;

  // Sign it, so the vendor knows who is texting before they answer.
  const co = myCompany(req);
  const prop = propertyId ? get('SELECT address FROM properties WHERE id=?', propertyId) : null;
  const text = [
    prop ? `${prop.address}:` : null,
    body,
    `— ${req.user.name || tpl.outboundName(co)}, ${tpl.outboundName(co)}`,
  ].filter(Boolean).join('\n');

  if (!sms.smsEnabled(myCompany(req))) {
    // No Twilio yet: record it and hand back the text to send from a phone.
    const r = run(`INSERT INTO contact_messages (company_id, contact_id, property_id, direction,
        phone, body, status, sent_by) VALUES (?,?,?,'out',?,?,'not_sent',?)`,
      req.companyId, c.id, propertyId, phone, text, req.user.id);
    return res.status(400).json({
      error: 'Texting is not connected yet — copy this and send it from your phone',
      text, phone, message_id: r.lastInsertRowid, sms_enabled: false,
    });
  }
  try {
    await sms.sendSms(phone, text, myCompany(req));
    const r = run(`INSERT INTO contact_messages (company_id, contact_id, property_id, direction,
        phone, body, status, sent_by) VALUES (?,?,?,'out',?,?,'sent',?)`,
      req.companyId, c.id, propertyId, phone, text, req.user.id);
    res.json({ ok: true, message: get('SELECT * FROM contact_messages WHERE id=?', r.lastInsertRowid) });
  } catch (e) {
    run(`INSERT INTO contact_messages (company_id, contact_id, property_id, direction,
        phone, body, status, error, sent_by) VALUES (?,?,?,'out',?,?,'failed',?,?)`,
      req.companyId, c.id, propertyId, phone, text, e.message, req.user.id);
    next(e);
  }
});

// Text several people about one property in a single action — the whole crew at once.
app.post('/api/admin/properties/:id/broadcast', adminOnly, async (req, res, next) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const body = String((req.body && req.body.body) || '').trim();
  const ids = (req.body && req.body.contact_ids) || [];
  if (!body) return res.status(400).json({ error: 'Nothing to send' });
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one contact' });
  const co = myCompany(req);
  const results = [];
  for (const id of ids) {
    const c = get('SELECT * FROM contacts WHERE id=? AND company_id=?', id, req.companyId);
    if (!c) { results.push({ id, ok: false, error: 'Not found' }); continue; }
    const phone = sms.normalizePhone(c.phone);
    if (!phone) { results.push({ id, name: c.name, ok: false, error: 'No mobile number' }); continue; }
    const text = `${p.address}:\n${body}\n— ${req.user.name || tpl.outboundName(co)}, ${tpl.outboundName(co)}`;
    try {
      if (!sms.smsEnabled(myCompany(req))) throw new Error('Texting is not connected yet');
      await sms.sendSms(phone, text, myCompany(req));
      run(`INSERT INTO contact_messages (company_id, contact_id, property_id, direction,
          phone, body, status, sent_by) VALUES (?,?,?,'out',?,?,'sent',?)`,
        req.companyId, c.id, p.id, phone, text, req.user.id);
      results.push({ id, name: c.name, ok: true });
    } catch (e) {
      run(`INSERT INTO contact_messages (company_id, contact_id, property_id, direction,
          phone, body, status, error, sent_by) VALUES (?,?,?,'out',?,?,'failed',?,?)`,
        req.companyId, c.id, p.id, phone, text, e.message, req.user.id);
      results.push({ id, name: c.name, ok: false, error: e.message });
    }
  }
  res.json({ results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
});

// Everything unread from vendors, wherever it came from.
app.get('/api/admin/contact-inbox', adminOnly, (req, res) => {
  res.json({
    unread: all(`SELECT m.*, c.name AS contact_name, c.role, p.address AS property_address
      FROM contact_messages m
      LEFT JOIN contacts c ON c.id=m.contact_id
      LEFT JOIN properties p ON p.id=m.property_id
      WHERE m.company_id=? AND m.direction='in' AND m.read_at IS NULL
      ORDER BY m.id DESC`, req.companyId),
  });
});

// ---------- notes ----------
// Pinned notes float to the top; everything else is newest first. Notes are internal —
// a buyer never sees one.
const NOTE_SELECT = `SELECT n.*, u.name AS author_name, p.address AS property_address
  FROM notes n LEFT JOIN users u ON u.id=n.created_by
  LEFT JOIN properties p ON p.id=n.property_id`;

app.get('/api/admin/notes', adminOnly, (req, res) => {
  const where = ['n.company_id = ?'];
  const args = [req.companyId];
  if (req.query.property_id) { where.push('n.property_id = ?'); args.push(req.query.property_id); }
  if (req.query.loan_id) { where.push('n.loan_id = ?'); args.push(req.query.loan_id); }
  if (req.query.contact_id) { where.push('n.contact_id = ?'); args.push(req.query.contact_id); }
  res.json({
    notes: all(`${NOTE_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY n.pinned DESC, n.id DESC LIMIT 200`, ...args),
  });
});

app.post('/api/admin/notes', adminOnly, (req, res) => {
  const b = req.body || {};
  const body = String(b.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write something first' });
  if (b.property_id && !ownedProperty(req, b.property_id)) {
    return res.status(400).json({ error: 'That property is not yours' });
  }
  if (b.loan_id && !ownedLoan(req, b.loan_id)) {
    return res.status(400).json({ error: 'That loan is not yours' });
  }
  const r = run(`INSERT INTO notes (company_id, property_id, loan_id, contact_id, body, pinned, created_by)
    VALUES (?,?,?,?,?,?,?)`,
    req.companyId, b.property_id || null, b.loan_id || null, b.contact_id || null,
    body, b.pinned ? 1 : 0, req.user.id);
  res.json(get(`${NOTE_SELECT} WHERE n.id=?`, r.lastInsertRowid));
});

app.put('/api/admin/notes/:id', adminOnly, (req, res) => {
  const n = get('SELECT * FROM notes WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!n) return res.status(404).json({ error: 'Note not found' });
  const b = req.body || {};
  const body = b.body !== undefined ? String(b.body).trim() : n.body;
  if (!body) return res.status(400).json({ error: 'A note cannot be empty' });
  run("UPDATE notes SET body=?, pinned=?, edited_at=datetime('now') WHERE id=?",
    body, b.pinned !== undefined ? (b.pinned ? 1 : 0) : n.pinned, n.id);
  res.json(get(`${NOTE_SELECT} WHERE n.id=?`, n.id));
});

app.delete('/api/admin/notes/:id', adminOnly, (req, res) => {
  const n = get('SELECT id FROM notes WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!n) return res.status(404).json({ error: 'Note not found' });
  run('DELETE FROM notes WHERE id=?', n.id);
  res.json({ ok: true });
});

// ---------- reports: P&L, balance sheet, returns ----------
app.get('/api/admin/reports/pl', adminOnly, (req, res) => {
  res.json(reports.profitAndLoss(req.companyId, req.query.from || null, req.query.to || null));
});
app.get('/api/admin/reports/balance-sheet', adminOnly, (req, res) => {
  res.json(reports.balanceSheet(req.companyId, req.query.as_of || null));
});
app.get('/api/admin/reports/returns', adminOnly, (req, res) => {
  res.json(reports.portfolioReturns(req.companyId));
});
app.get('/api/admin/reports/returns/:propertyId', adminOnly, (req, res) => {
  const r = reports.propertyReturns(req.companyId, req.params.propertyId);
  if (!r) return res.status(404).json({ error: 'Property not found' });
  res.json(r);
});

// ---------- address lookup ----------
app.get('/api/admin/address-suggest', adminOnly, async (req, res, next) => {
  try { res.json(await addr.suggest(req.query.q || '')); } catch (e) { next(e); }
});
app.get('/api/admin/address-details', adminOnly, async (req, res, next) => {
  try { res.json(await addr.details(req.query.id, req.query.provider) || {}); } catch (e) { next(e); }
});

// ---------- amortization calculator ----------
// Give any three of principal, rate, term and payment; get the fourth plus the schedule.
app.get('/api/admin/amortize', adminOnly, (req, res) => {
  const q = req.query;
  const r = loanEngine.solveLoan({
    principal_cents: q.principal_cents, payment_cents: q.payment_cents,
    interest_rate_bps: q.interest_rate_bps, term_months: q.term_months,
    first_payment_date: q.first_payment_date,
  });
  if (r.schedule) r.schedule_yearly = loanEngine.yearlySchedule(r.schedule);
  res.json(r);
});

// Final payment date from a start date and term, and the reverse.
app.get('/api/admin/maturity', adminOnly, (req, res) => {
  const { first_payment_date, term_months, final_payment_date } = req.query;
  if (final_payment_date && first_payment_date) {
    return res.json({ term_months: loanEngine.termFromDates(first_payment_date, final_payment_date) });
  }
  res.json({ final_payment_date: loanEngine.finalPaymentDate(first_payment_date, Number(term_months)) });
});

// Live principal & interest calculation for the sale form.
app.get('/api/admin/calc-payment', adminOnly, (req, res) => {
  const principal = Number(req.query.principal_cents) || 0;
  const rate = Number(req.query.interest_rate_bps) || 0;
  const term = Number(req.query.term_months) || 0;
  if (!principal || !term) return res.json({ payment_cents: 0 });
  res.json({ payment_cents: loanEngine.calcPayment(principal, rate, term) });
});

// ---------- property profile: costs, basis, and the sale ----------
const COST_LABELS = {
  purchase: 'Purchase price', closing: 'Closing costs', filing: 'Filing & recording fees',
  rehab: 'Rehab / repairs', bog: 'Boots on the ground', lawncare: 'Lawn care', insurance: 'Insurance',
  taxes: 'Property taxes', utilities: 'Utilities', marketing: 'Marketing',
  legal: 'Legal / title', other: 'Other',
};

function propertyBasis(propertyId) {
  const rows = all(`SELECT category, SUM(amount_cents) AS total FROM property_costs
    WHERE property_id=? GROUP BY category`, propertyId);
  const by = {};
  let total = 0;
  for (const r of rows) { by[r.category] = r.total; total += r.total; }
  return { by_category: by, total_cents: total };
}

app.get('/api/admin/properties/:id', adminOnly, (req, res) => {
  const prop = ownedProperty(req, req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });
  const basis = propertyBasis(prop.id);
  const loan = get(`SELECT * FROM loans WHERE property_id=? ORDER BY id DESC LIMIT 1`, prop.id);
  const tenant = loan && loan.tenant_user_id
    ? get('SELECT id, name, email, phone FROM users WHERE id=?', loan.tenant_user_id) : null;
  const pml = all('SELECT * FROM pml_loans WHERE property_id=?', prop.id);
  const expenses = get(`SELECT COALESCE(SUM(amount_cents),0) s FROM expenses
    WHERE property_id=? AND status='assigned'`, prop.id).s;
  res.json({
    property: prop,
    costs: all('SELECT * FROM property_costs WHERE property_id=? ORDER BY cost_date DESC, id DESC', prop.id),
    recurring_costs: all('SELECT * FROM recurring_costs WHERE property_id=? AND active=1 ORDER BY next_date', prop.id),
    cost_labels: COST_LABELS,
    basis,
    returns: reports.propertyReturns(req.companyId, prop.id),
    assigned_expenses_cents: expenses,
    all_in_cents: basis.total_cents + expenses,
    loan: loan || null,
    tenant,
    pml_loans: pml,
    pml_balance_cents: pml.filter(p => p.status === 'active').reduce((t, p) => t + p.principal_balance_cents, 0),
    phases: PHASES, phase_labels: PHASE_LABELS, owner_types: OWNER_TYPES,
    doc_folders: (() => {
      const docs = all(`SELECT id, filename, category, title, effective_date, visible_to_tenant, created_at
        FROM documents WHERE property_id=? OR loan_id=? ORDER BY id DESC`, prop.id, loan ? loan.id : -1);
      const folders = {};
      for (const c of [...ADMIN_CATEGORIES, ...SHARED_CATEGORIES]) {
        folders[c] = { label: CATEGORY_LABELS[c], shared: SHARED_CATEGORIES.includes(c), documents: [] };
      }
      for (const d of docs) (folders[d.category] || folders.private).documents.push(d);
      return folders;
    })(),
  });
});

app.post('/api/admin/properties/:id/phase', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!PHASES.includes(req.body.phase)) return res.status(400).json({ error: 'Unknown phase' });
  run("UPDATE properties SET phase=?, phase_updated_at=datetime('now') WHERE id=?", req.body.phase, p.id);
  res.json({ ok: true, phase: req.body.phase });
});

app.put('/api/admin/properties/:id/details', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  run(`UPDATE properties SET status=?, acquired_date=?, purchase_price_cents=?,
        target_sale_price_cents=?, beds=?, baths=?, sqft=?, year_built=?, notes=?,
        late_fee_cents=?, grace_days=?, due_day=?,
        owner_name=?, owner_type=?, trustee=?,
        insurance_expires=?, insurance_carrier=?, tax_due_date=?, tax_due_date2=? WHERE id=?`,
    b.status || p.status, b.acquired_date ?? p.acquired_date,
    b.purchase_price_cents ?? p.purchase_price_cents, b.target_sale_price_cents ?? p.target_sale_price_cents,
    b.beds ?? p.beds, b.baths ?? p.baths, b.sqft ?? p.sqft, b.year_built ?? p.year_built,
    b.notes ?? p.notes, b.late_fee_cents ?? p.late_fee_cents, b.grace_days ?? p.grace_days,
    b.due_day ?? p.due_day,
    b.owner_name ?? p.owner_name, b.owner_type ?? p.owner_type, b.trustee ?? p.trustee,
    b.insurance_expires ?? p.insurance_expires, b.insurance_carrier ?? p.insurance_carrier,
    b.tax_due_date ?? p.tax_due_date, b.tax_due_date2 ?? p.tax_due_date2, p.id);
  res.json(get('SELECT * FROM properties WHERE id=?', p.id));
});

// ---------- recurring costs ----------
// The rule says "every week/fortnight/month/quarter/year"; the sweep turns each due
// date into an ordinary property_costs row. Everything downstream — cost basis,
// margins, the books — sees plain cost rows and needs no idea recurrence exists.
const CADENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annually'];
function advanceCadence(dateStr, cadence) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (cadence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
  else return loanEngine.addMonthsUTC(d, cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12)
    .toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}
function runRecurringCosts() {
  const due = all("SELECT * FROM recurring_costs WHERE active=1 AND next_date <= ?", today());
  for (const rule of due) {
    let next = rule.next_date, made = 0;
    // Cap the catch-up: a rule created a year back does not get to flood the ledger
    // in one boot beyond a plausible backlog.
    while (next <= today() && made < 120) {
      if (rule.end_date && next > rule.end_date) break;
      run(`INSERT INTO property_costs (company_id, property_id, category, description, vendor,
             amount_cents, cost_date, created_by) VALUES (?,?,?,?,?,?,?,?)`,
        rule.company_id, rule.property_id, rule.category, rule.description,
        rule.vendor, rule.amount_cents, next, rule.created_by);
      made++;
      next = advanceCadence(next, rule.cadence);
    }
    const retired = rule.end_date && next > rule.end_date;
    run('UPDATE recurring_costs SET next_date=?, active=? WHERE id=?', next, retired ? 0 : 1, rule.id);
    if (made) console.log(`Recurring cost "${rule.description}" posted ${made} occurrence(s) on property ${rule.property_id}`);
  }
}
setInterval(() => { try { runRecurringCosts(); } catch (e) { console.error('Recurring costs:', e.message); } }, 6 * 60 * 60 * 1000);
setTimeout(() => { try { runRecurringCosts(); } catch (e) { console.error('Recurring costs:', e.message); } }, 7000);

app.post('/api/admin/properties/:id/costs', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { category, description, vendor, amount_cents, cost_date, cadence, end_date, document_id } = req.body || {};
  if (!description || !amount_cents) return res.status(400).json({ error: 'Description and amount required' });
  // A receipt attaches by document id — the file itself goes through the normal
  // document upload first, so it lives in the document center like everything else.
  if (document_id && !get('SELECT id FROM documents WHERE id=? AND company_id=?', document_id, req.companyId)) {
    return res.status(404).json({ error: 'Receipt document not found' });
  }

  // A cadence turns this into a rule. The first occurrence lands on the given date
  // (materialized immediately if that date has arrived), then the schedule takes over.
  if (cadence) {
    if (!CADENCES.includes(cadence)) return res.status(400).json({ error: 'Repeat must be weekly, biweekly, monthly, quarterly or annually' });
    if (end_date && end_date < (cost_date || today())) return res.status(400).json({ error: 'The end date is before the start date' });
    const r = run(`INSERT INTO recurring_costs (company_id, property_id, category, description, vendor,
        amount_cents, cadence, next_date, end_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      req.companyId, p.id, category || 'other', description, vendor || null,
      amount_cents, cadence, cost_date || today(), end_date || null, req.user.id);
    runRecurringCosts();
    return res.json({ recurring: true, rule: get('SELECT * FROM recurring_costs WHERE id=?', r.lastInsertRowid) });
  }

  const r = run(`INSERT INTO property_costs (company_id, property_id, category, description,
      vendor, amount_cents, cost_date, document_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    req.companyId, p.id, category || 'other', description, vendor || null,
    amount_cents, cost_date || today(), document_id || null, req.user.id);
  // Keep the headline purchase price on the property in step with a "purchase" cost line.
  if ((category || '') === 'purchase') {
    run('UPDATE properties SET purchase_price_cents=? WHERE id=?', amount_cents, p.id);
  }
  res.json(get('SELECT * FROM property_costs WHERE id=?', r.lastInsertRowid));
});

// Stopping a rule keeps every cost it already posted — those happened.
app.delete('/api/admin/recurring-costs/:id', adminOnly, (req, res) => {
  const rule = get('SELECT * FROM recurring_costs WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  run('DELETE FROM recurring_costs WHERE id=?', rule.id);
  res.json({ ok: true });
});

// Fix a typo'd amount, wrong date, wrong bucket — a cost row is data entry, not a
// posted journal line, so editing it in place is the honest correction.
app.put('/api/admin/costs/:id', adminOnly, (req, res) => {
  const c = get('SELECT * FROM property_costs WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const amount = b.amount_cents !== undefined ? Math.round(Number(b.amount_cents)) : c.amount_cents;
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be more than zero' });
  const category = b.category || c.category;
  let docId = c.document_id;
  if (b.document_id !== undefined) {
    if (b.document_id && !get('SELECT id FROM documents WHERE id=? AND company_id=?', b.document_id, req.companyId)) {
      return res.status(404).json({ error: 'Receipt document not found' });
    }
    docId = b.document_id || null;
  }
  run(`UPDATE property_costs SET category=?, description=?, vendor=?, amount_cents=?, cost_date=?, document_id=? WHERE id=?`,
    category,
    b.description !== undefined ? String(b.description) : c.description,
    b.vendor !== undefined ? (b.vendor || null) : c.vendor,
    amount, b.cost_date || c.cost_date, docId, c.id);
  // The headline purchase price follows its cost line, same as on create.
  if (category === 'purchase') run('UPDATE properties SET purchase_price_cents=? WHERE id=?', amount, c.property_id);
  res.json(get('SELECT * FROM property_costs WHERE id=?', c.id));
});

app.delete('/api/admin/costs/:id', adminOnly, (req, res) => {
  const c = get('SELECT * FROM property_costs WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  run('DELETE FROM property_costs WHERE id=?', c.id);
  res.json({ ok: true });
});

// Sell the property to a tenant buyer: creates their login, opens the loan, and
// prepares the text invitation in one action.
app.post('/api/admin/properties/:id/sell', adminOnly, async (req, res, next) => {
  const prop = ownedProperty(req, req.params.id);
  if (!prop) return res.status(404).json({ error: 'Property not found' });
  const b = req.body || {};
  for (const f of ['buyer_name', 'buyer_email', 'sale_price_cents', 'principal_cents',
                   'interest_rate_bps', 'term_months', 'first_payment_date']) {
    if (!b[f]) return res.status(400).json({ error: `Missing ${f}` });
  }
  const email = String(b.buyer_email).toLowerCase().trim();
  if (get('SELECT id FROM users WHERE email=?', email)) {
    return res.status(400).json({ error: 'That buyer email already has an account' });
  }
  try {
    const co = get('SELECT * FROM companies WHERE id=?', req.companyId);
    const temp = 'TB-' + crypto.randomInt(100000, 999999) + '!';
    const u = run(`INSERT INTO users (company_id, email, password_hash, role, name, phone, must_change_password)
      VALUES (?,?,?,?,?,?,1)`, req.companyId, email, hashPassword(temp), 'tenant',
      b.buyer_name, addr.formatPhone(b.buyer_phone) || null);
    // Principal & interest is computed from the note terms unless you deliberately override it.
    const payment = b.payment_cents ||
      loanEngine.calcPayment(b.principal_cents, b.interest_rate_bps, b.term_months);
    const taxes = b.monthly_taxes_cents || 0;
    const insurance = b.monthly_insurance_cents || 0;
    const utilities = b.monthly_utilities_cents || 0;
    const servicing = b.monthly_servicing_cents || 0;
    const misc = b.monthly_misc_cents || 0;
    // Taxes and insurance are the buyer's money until disbursed, so they sit in escrow.
    const escrow = taxes + insurance;
    const l = run(`INSERT INTO loans (company_id, property_id, tenant_user_id, loan_type,
        sale_price_cents, down_payment_cents, principal_cents, interest_rate_bps, term_months,
        payment_cents, escrow_cents, late_fee_cents, grace_days, first_payment_date, due_day,
        principal_balance_cents, beneficial_interest_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.companyId, prop.id, u.lastInsertRowid, b.loan_type || 'land_contract',
      b.sale_price_cents, b.down_payment_cents || 0, b.principal_cents, b.interest_rate_bps,
      b.term_months, payment, escrow,
      b.late_fee_cents ?? prop.late_fee_cents ?? 0,
      b.grace_days ?? prop.grace_days ?? 5,
      b.first_payment_date,
      b.due_day ?? prop.due_day ?? Number(String(b.first_payment_date).slice(8, 10)),
      b.principal_cents, b.beneficial_interest_pct || null);
    const loanId = l.lastInsertRowid;
    run('UPDATE loans SET final_payment_date=? WHERE id=?',
      loanEngine.finalPaymentDate(b.first_payment_date, b.term_months), loanId);
    run(`UPDATE loans SET monthly_taxes_cents=?, monthly_insurance_cents=?, monthly_utilities_cents=?,
          monthly_servicing_cents=?, monthly_misc_cents=?, misc_label=? WHERE id=?`,
      taxes, insurance, utilities, servicing, misc, b.misc_label || 'Other monthly charge', loanId);
    // Utilities, the servicing fee and anything miscellaneous are billed as recurring
    // charges — they are income to you, not money held for the buyer.
    for (const [amount, category, label] of [
      [utilities, 'utilities', 'Utilities'],
      [servicing, 'servicing_fee', 'Servicing fee'],
      [misc, 'other', b.misc_label || 'Other monthly charge'],
    ]) {
      if (amount > 0) {
        run(`INSERT INTO charges (loan_id, description, category, amount_cents, recurring, start_date)
             VALUES (?,?,?,?,1,?)`, loanId, label, category, amount, b.first_payment_date);
      }
    }
    run("UPDATE properties SET status='sold', phase='sold', phase_updated_at=datetime('now') WHERE id=?", prop.id);

    const phone = sms.normalizePhone(b.buyer_phone);
    const inv = run(`INSERT INTO invitations (company_id, loan_id, user_id, phone, temp_password, channel)
      VALUES (?,?,?,?,?,?)`, req.companyId, l.lastInsertRowid, u.lastInsertRowid,
      phone, temp, b.buyer_phone ? 'sms' : 'manual');

    // Text it now. Recording a sale and inviting the buyer are one action, not two —
    // there is no reason to make somebody go and press a second button.
    let invite = { sent: false, error: null };
    if (phone && sms.smsEnabled(co)) {
      const d = inviteBody(req, inv.lastInsertRowid);
      try {
        await sms.sendSms(phone, d.text, co);
        run("UPDATE invitations SET status='sent', sent_at=datetime('now'), error=NULL WHERE id=?",
          inv.lastInsertRowid);
        invite = { sent: true, error: null, phone };
      } catch (e) {
        run("UPDATE invitations SET status='failed', error=? WHERE id=?", e.message, inv.lastInsertRowid);
        invite = { sent: false, error: e.message, phone };
      }
    } else if (!phone) {
      invite.error = 'No mobile number for this buyer, so nothing could be texted.';
    } else {
      invite.error = 'Texting is not connected yet — add your Twilio details under Settings → Texting.';
    }

    res.json({
      loan_id: l.lastInsertRowid, tenant_user_id: u.lastInsertRowid,
      invitation_id: inv.lastInsertRowid, temp_password: temp,
      sms_enabled: sms.smsEnabled(co), invite,
    });
  } catch (e) { next(e); }
});

// ---------- texting setup ----------
// Credentials are entered in the app rather than on the host, because the person who
// needs texting working is not the person with access to the deployment.
app.get('/api/admin/texting', adminOnly, (req, res) => {
  const co = myCompany(req);
  const c = sms.creds(co);
  res.json({
    connected: !!c,
    source: c ? c.source : null,          // 'company' = entered here, 'env' = set on the host
    from: c ? c.from : null,
    sid_tail: co.twilio_sid ? '…' + co.twilio_sid.slice(-4) : null,
    webhook_url: baseUrlOf(req) + '/sms/incoming',
    voice_configured: !!(co.voice_api_key_sid && co.voice_api_key_secret && co.voice_twiml_app_sid),
    voice_url: baseUrlOf(req) + '/api/voice/outgoing',
    incoming_url: baseUrlOf(req) + '/api/voice/incoming',
    record_calls: !!co.record_calls,
    forward_calls: !!co.forward_calls,
    voicemail_greeting: co.voicemail_greeting || '',
    voice_intel_set: !!co.voice_intel_sid,
  });
});

// The three values the browser softphone needs, saved separately from the main Twilio
// credentials so texting keeps working while calling is still being set up.
app.put('/api/admin/voice', ownerOnly, (req, res) => {
  const b = req.body || {};
  const key = String(b.api_key_sid || '').trim();
  const secret = String(b.api_key_secret || '').trim();
  const appSid = String(b.twiml_app_sid || '').trim();
  if (!key || !secret || !appSid) return res.status(400).json({ error: 'All three values are needed' });
  if (!/^SK[0-9a-f]{32}$/i.test(key)) return res.status(400).json({ error: 'The API key SID starts with SK and is 34 characters' });
  if (!/^AP[0-9a-f]{32}$/i.test(appSid)) return res.status(400).json({ error: 'The TwiML App SID starts with AP and is 34 characters' });
  run('UPDATE companies SET voice_api_key_sid=?, voice_api_key_secret=?, voice_twiml_app_sid=? WHERE id=?',
    key, secret, appSid, req.companyId);
  res.json({ ok: true });
});

app.put('/api/admin/texting', ownerOnly, async (req, res, next) => {
  const b = req.body || {};
  const sid = String(b.sid || '').trim();
  const token = String(b.token || '').trim();
  const from = sms.normalizePhone(b.from);
  if (!sid || !token || !from) return res.status(400).json({ error: 'All three values are needed' });
  if (!/^AC[0-9a-f]{32}$/i.test(sid)) {
    return res.status(400).json({ error: 'That does not look like an Account SID — it starts with AC and is 34 characters' });
  }
  try {
    const info = await sms.verifyCreds({ sid, token, from });   // fail before saving
    run('UPDATE companies SET twilio_sid=?, twilio_token=?, twilio_from=? WHERE id=?',
      sid, token, from, req.companyId);
    res.json({ ok: true, account: info.account, status: info.status, from });
  } catch (e) { next(e); }
});

app.delete('/api/admin/texting', ownerOnly, (req, res) => {
  run(`UPDATE companies SET twilio_sid=NULL, twilio_token=NULL, twilio_from=NULL,
       voice_api_key_sid=NULL, voice_api_key_secret=NULL, voice_twiml_app_sid=NULL WHERE id=?`, req.companyId);
  res.json({ ok: true });
});

// ---------- browser softphone ----------
// Calls placed and answered entirely inside the app, going out from the business
// number. Twilio's browser SDK needs a short-lived access token, which is just a JWT
// signed with the API key secret — three base64url parts and an HMAC, no SDK required
// on our side.
app.get('/api/admin/voice-token', adminOnly, (req, res) => {
  const co = myCompany(req);
  const accountSid = co.twilio_sid || (sms.creds(co) || {}).sid;
  if (!accountSid || !co.voice_api_key_sid || !co.voice_api_key_secret || !co.voice_twiml_app_sid) {
    return res.status(400).json({ error: 'not_configured', not_configured: true });
  }
  const token = sms.voiceToken({
    accountSid, keySid: co.voice_api_key_sid, keySecret: co.voice_api_key_secret,
    appSid: co.voice_twiml_app_sid, identity: 'admin-' + req.user.id,
  });
  res.json({ token, from: co.twilio_from || (sms.creds(co) || {}).from });
});

// The TwiML app points its Voice URL here. Twilio asks "the browser wants to call To —
// what do I do?", and the answer is: dial it, presenting the business number. When
// recording is on, the callee hears an announcement before connecting — several of
// this portfolio's states require every party to know.
const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
app.post('/api/voice/outgoing', (req, res) => {
  const appSid = req.body && req.body.ApplicationSid;
  const co = appSid ? get('SELECT * FROM companies WHERE voice_twiml_app_sid=?', appSid) : null;
  const to = sms.normalizePhone(req.body && req.body.To);
  res.type('text/xml');
  if (!co || !to) {
    return res.send('<Response><Say>This call cannot be completed.</Say></Response>');
  }
  const base = baseUrlOf(req);
  const rec = co.record_calls
    ? ` record="record-from-answer-dual" recordingStatusCallback="${xesc(base)}/api/voice/recording?co=${co.id}&amp;kind=call"`
    : '';
  const whisper = co.record_calls ? ` url="${xesc(base)}/api/voice/announce"` : '';
  res.send(`<Response><Dial callerId="${xesc(co.twilio_from)}" answerOnBridge="true"${rec}>` +
           `<Number${whisper}>${xesc(to)}</Number></Dial></Response>`);
});

// Played to the person being called, before the legs join.
app.post('/api/voice/announce', (req, res) => {
  res.type('text/xml').send('<Response><Say voice="alice">This call may be recorded.</Say></Response>');
});

// Inbound calls to the business number. Optionally ring the owner's cell first; the
// rest — or everything — goes to voicemail, transcribed by Twilio as it is recorded.
function voicemailTwiml(co, base) {
  const greeting = co.voicemail_greeting ||
    `You have reached ${co.mgmt_company_name || co.name}. Please leave a message with your name and property address, and we will get back to you.`;
  return `<Response><Say voice="alice">${xesc(greeting)}</Say>` +
    `<Record maxLength="120" playBeep="true" transcribe="true"` +
    ` transcribeCallback="${xesc(base)}/api/voice/vm-transcript?co=${co.id}"` +
    ` recordingStatusCallback="${xesc(base)}/api/voice/recording?co=${co.id}&amp;kind=voicemail"/>` +
    `<Say voice="alice">We did not receive a recording. Goodbye.</Say></Response>`;
}
app.post('/api/voice/incoming', (req, res) => {
  const toNum = sms.normalizePhone(req.body && req.body.To);
  const co = toNum ? get(`SELECT c.* FROM companies c WHERE c.twilio_from=?`, toNum) : null;
  res.type('text/xml');
  if (!co) return res.send('<Response><Say>This number is not in service.</Say></Response>');
  const base = baseUrlOf(req);
  const owner = get(`SELECT phone FROM users WHERE company_id=? AND role='owner' AND phone IS NOT NULL AND deleted_at IS NULL LIMIT 1`, co.id);
  if (co.forward_calls && owner && owner.phone) {
    // Ring the owner briefly; unanswered rolls to voicemail via the action URL.
    return res.send(`<Response><Dial timeout="18" callerId="${xesc(co.twilio_from)}"` +
      ` action="${xesc(base)}/api/voice/vm-fallback?co=${co.id}">` +
      `<Number>${xesc(sms.normalizePhone(owner.phone))}</Number></Dial></Response>`);
  }
  res.send(voicemailTwiml(co, base));
});
app.post('/api/voice/vm-fallback', (req, res) => {
  const co = get('SELECT * FROM companies WHERE id=?', Number(req.query.co));
  res.type('text/xml');
  if (!co) return res.send('<Response/>');
  if ((req.body && req.body.DialCallStatus) === 'completed') return res.send('<Response/>');
  res.send(voicemailTwiml(co, baseUrlOf(req)));
});

// A recording finished — a call's or a voicemail's. Remember it, and hang it on the
// loan whose buyer was on the other end when there is one.
app.post('/api/voice/recording', (req, res) => {
  const coId = Number(req.query.co);
  const kind = req.query.kind === 'voicemail' ? 'voicemail' : 'call';
  const b = req.body || {};
  if (coId && b.RecordingSid) {
    const fromN = sms.normalizePhone(b.From) || b.From || null;
    const toN = sms.normalizePhone(b.To) || b.To || null;
    const bare = (n) => (n || '').replace(/^\+1/, '');
    const digitsOf = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},'-',''),' ',''),'(',''),')',''),'+1','')`;
    const counterpart = kind === 'voicemail' ? bare(fromN) : bare(toN);
    const buyer = counterpart ? get(`SELECT id FROM users WHERE role='tenant' AND deleted_at IS NULL
      AND phone IS NOT NULL AND ${digitsOf('phone')}=? LIMIT 1`, counterpart) : null;
    const loan = buyer ? get('SELECT id FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', buyer.id) : null;
    run(`INSERT INTO call_recordings (company_id, kind, call_sid, recording_sid, from_number, to_number, duration_sec, loan_id)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(recording_sid) DO UPDATE SET duration_sec=excluded.duration_sec`,
      coId, kind, b.CallSid || null, b.RecordingSid, fromN, toN,
      Number(b.RecordingDuration) || null, loan ? loan.id : null);
    if (kind === 'voicemail') {
      for (const u of all(`SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL`, coId)) {
        notify.notify(u.id, { kind: 'message', title: '📞 New voicemail',
          body: `From ${fromN || 'unknown'} — ${b.RecordingDuration || '?'}s`, url: '/admin#settings' }).catch(() => {});
      }
    }
  }
  res.type('text/xml').send('<Response/>');
});

// Twilio's built-in transcription for voicemails (recordings under two minutes).
app.post('/api/voice/vm-transcript', (req, res) => {
  const b = req.body || {};
  if (b.RecordingSid) {
    run(`UPDATE call_recordings SET transcript=?, transcript_status=? WHERE recording_sid=?`,
      b.TranscriptionText || null,
      b.TranscriptionStatus === 'completed' ? 'done' : 'failed',
      b.RecordingSid);
  }
  res.type('text/xml').send('<Response/>');
});

// ---------- recordings for the admin ----------
app.get('/api/admin/recordings', adminOnly, (req, res) => {
  res.json({ recordings: all(`SELECT r.*, p.address FROM call_recordings r
      LEFT JOIN loans l ON l.id=r.loan_id LEFT JOIN properties p ON p.id=l.property_id
      WHERE r.company_id=? ORDER BY r.id DESC LIMIT 100`, req.companyId) });
});
// The audio itself lives at Twilio behind basic auth; proxy it so the browser's
// audio tag can just play it.
app.get('/api/admin/recordings/:id/audio', adminOnly, async (req, res, next) => {
  try {
    const r = get('SELECT * FROM call_recordings WHERE id=? AND company_id=?', req.params.id, req.companyId);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const c = sms.creds(myCompany(req));
    if (!c) return res.status(400).json({ error: 'Twilio is not connected' });
    const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Recordings/${r.recording_sid}.mp3`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') },
    });
    if (!tw.ok) return res.status(502).json({ error: 'Twilio would not hand over the recording' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(await tw.arrayBuffer()));
  } catch (e) { next(e); }
});
// Call transcripts go through Twilio Intelligence, which needs a one-time service
// (its SID pasted in Settings). Create on demand, poll for sentences.
app.post('/api/admin/recordings/:id/transcribe', adminOnly, async (req, res, next) => {
  try {
    const r = get('SELECT * FROM call_recordings WHERE id=? AND company_id=?', req.params.id, req.companyId);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.transcript_status === 'done') return res.json({ status: 'done', transcript: r.transcript });
    const co = myCompany(req);
    if (!co.voice_intel_sid) {
      return res.status(400).json({ error: 'Call transcripts need a Twilio Intelligence service — create one in the ' +
        'Twilio console under AI & Machine Learning → Voice Intelligence, and paste its GA-prefixed SID in Settings.' });
    }
    const c = sms.creds(co);
    if (!c) return res.status(400).json({ error: 'Twilio is not connected' });
    if (!r.transcript_sid) {
      const params = new URLSearchParams({
        ServiceSid: co.voice_intel_sid,
        Channel: JSON.stringify({ media_properties: { source_sid: r.recording_sid } }),
      });
      const tw = await fetch('https://intelligence.twilio.com/v2/Transcripts', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'),
                   'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const json = await tw.json();
      if (!tw.ok) return res.status(502).json({ error: (json && json.message) || 'Twilio refused to start the transcript' });
      run('UPDATE call_recordings SET transcript_sid=?, transcript_status=? WHERE id=?', json.sid, 'pending', r.id);
      return res.json({ status: 'pending' });
    }
    // Poll for the finished sentences.
    const tw = await fetch(`https://intelligence.twilio.com/v2/Transcripts/${r.transcript_sid}/Sentences?PageSize=500`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') },
    });
    const json = await tw.json();
    if (!tw.ok) return res.status(502).json({ error: (json && json.message) || 'Could not fetch the transcript' });
    const sentences = (json.sentences || []).map(s => `${s.media_channel === 1 ? 'You' : 'Them'}: ${s.transcript}`).join('\n');
    if (sentences) {
      run("UPDATE call_recordings SET transcript=?, transcript_status='done' WHERE id=?", sentences, r.id);
      return res.json({ status: 'done', transcript: sentences });
    }
    res.json({ status: 'pending' });
  } catch (e) { next(e); }
});
// Recording / voicemail / transcript configuration.
app.put('/api/admin/voice-settings', ownerOnly, (req, res) => {
  const b = req.body || {};
  run(`UPDATE companies SET record_calls=?, forward_calls=?, voicemail_greeting=?, voice_intel_sid=? WHERE id=?`,
    b.record_calls ? 1 : 0, b.forward_calls ? 1 : 0,
    String(b.voicemail_greeting || '').slice(0, 500) || null,
    String(b.voice_intel_sid || '').trim() || null, req.companyId);
  res.json({ ok: true });
});

// ---------- downloads ----------
// Any message or notice, as a letter on the company's paper. A buyer who wants to show
// something to a lawyer, a lender or a relative should not have to screenshot the app.
function sendPdf(res, buf, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\- ]/g, '')}"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}

// The company's own logo for the letterhead. If none has been uploaded the letter goes
// out with the name alone — better a plain letterhead than Porch Pay's mark on paper
// that is meant to be theirs.
function companyLogo(co) {
  if (!co || !co.logo_path) return null;
  try {
    const f = path.join(UPLOAD_DIR, co.logo_path);
    if (!f.startsWith(UPLOAD_DIR)) return null;      // no traversing out of uploads
    return fs.readFileSync(f);
  } catch { return null; }
}

function messagePdf(msg, loan) {
  const co = get('SELECT * FROM companies WHERE id=?', loan.company_id);
  const prop = get('SELECT * FROM properties WHERE id=?', loan.property_id);
  const meta = [];
  if (prop) meta.push(['Property', [prop.address, prop.city, prop.state].filter(Boolean).join(', ')]);
  meta.push(['Sent', String(msg.created_at || '').slice(0, 10)]);
  return pdfDoc.letter({
    company: co, logo: companyLogo(co),
    subject: msg.subject || 'Message',
    bodyHtml: msg.body_html || null,
    bodyText: msg.body_html ? null : msg.body,
    meta, sentAt: msg.created_at,
  });
}

function noticePdf(notice, loan) {
  const co = get('SELECT * FROM companies WHERE id=?', loan.company_id);
  const prop = get('SELECT * FROM properties WHERE id=?', loan.property_id);
  const meta = [];
  if (prop) meta.push(['Property', [prop.address, prop.city, prop.state].filter(Boolean).join(', ')]);
  meta.push(['Notice type', notice.type === 'legal_notice' ? 'Notice of Default'
    : notice.type === 'late_notice' ? 'Late Payment Notice' : 'Notice']);
  meta.push(['Date issued', String(notice.sent_at || notice.created_at || '').slice(0, 10)]);
  return pdfDoc.letter({
    company: co, logo: companyLogo(co),
    subject: notice.subject, bodyText: notice.body,
    meta, sentAt: notice.sent_at || notice.created_at,
    footer: 'This notice was delivered through Porch Pay and recorded with the date and time it was sent.',
  });
}

app.get('/api/admin/messages/:id/pdf', adminOnly, (req, res, next) => {
  try {
    const m = get(`SELECT m.* FROM messages m JOIN loans l ON l.id=m.loan_id
      WHERE m.id=? AND l.company_id=?`, Number(req.params.id), req.companyId);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const loan = get('SELECT * FROM loans WHERE id=?', m.loan_id);
    sendPdf(res, messagePdf(m, loan), `message-${m.id}.pdf`);
  } catch (e) { next(e); }
});

app.get('/api/tenant/messages/:id/pdf', tenantReady, (req, res, next) => {
  try {
    const loan = tenantLoan(req);
    if (!loan) return res.status(404).json({ error: 'No loan' });
    const m = get('SELECT * FROM messages WHERE id=? AND loan_id=?', Number(req.params.id), loan.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    sendPdf(res, messagePdf(m, loan), `message-${m.id}.pdf`);
  } catch (e) { next(e); }
});

app.get('/api/admin/notices/:id/pdf', adminOnly, (req, res, next) => {
  try {
    const n = get(`SELECT n.* FROM notices n JOIN loans l ON l.id=n.loan_id
      WHERE n.id=? AND l.company_id=?`, Number(req.params.id), req.companyId);
    if (!n) return res.status(404).json({ error: 'Not found' });
    const loan = get('SELECT * FROM loans WHERE id=?', n.loan_id);
    sendPdf(res, noticePdf(n, loan), `notice-${n.id}.pdf`);
  } catch (e) { next(e); }
});

app.get('/api/tenant/notices/:id/pdf', tenantReady, (req, res, next) => {
  try {
    const loan = tenantLoan(req);
    if (!loan) return res.status(404).json({ error: 'No loan' });
    const n = get('SELECT * FROM notices WHERE id=? AND loan_id=? AND COALESCE(prepared,0)=0', Number(req.params.id), loan.id);
    if (!n) return res.status(404).json({ error: 'Not found' });
    sendPdf(res, noticePdf(n, loan), `notice-${n.id}.pdf`);
  } catch (e) { next(e); }
});

// ---------- legal hold ----------
// Marks an account as being handled through the courts. Nothing automated goes out
// after this, on any channel, until it is lifted.
app.post('/api/admin/loans/:id/legal-hold', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.legal_hold_at) return res.status(400).json({ error: 'This account is already on legal hold' });
  run(`UPDATE loans SET legal_hold_at=datetime('now'), legal_hold_reason=?, legal_hold_by=? WHERE id=?`,
    (req.body && req.body.reason) || null, req.user.id, loan.id);
  run(`INSERT INTO notes (company_id, loan_id, property_id, body, created_by)
    VALUES (?,?,?,?,?)`, req.companyId, loan.id, loan.property_id,
    `Legal hold placed — automated late notices stopped.${req.body && req.body.reason ? ' ' + req.body.reason : ''}`,
    req.user.id);
  res.json({ ok: true });
});

app.delete('/api/admin/loans/:id/legal-hold', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  run('UPDATE loans SET legal_hold_at=NULL, legal_hold_reason=NULL, legal_hold_by=NULL WHERE id=?', loan.id);
  run(`INSERT INTO notes (company_id, loan_id, property_id, body, created_by)
    VALUES (?,?,?,?,?)`, req.companyId, loan.id, loan.property_id,
    'Legal hold lifted — automated late notices resume.', req.user.id);
  res.json({ ok: true });
});

// The ladder as it stands, and what has already gone out on this loan.
app.get('/api/admin/loans/:id/notice-ladder', adminOnly, (req, res, next) => {
  try {
    const loan = ownedLoan(req, req.params.id);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    noticeRules.seedLadder(req.companyId);
    res.json({
      rules: noticeRules.rulesFor(req.companyId),
      legal_hold_at: loan.legal_hold_at,
      legal_hold_reason: loan.legal_hold_reason,
      grace_days: loan.grace_days,
      pause_days: Number(loan.notice_pause_days) || 0,
      pause_min_cents: Number(loan.notice_pause_min_cents) || 0,
      sent: all(`SELECT id, type, stage, period, subject, days_past_due, sent_at, read_at, delivery_json
        FROM notices WHERE loan_id=? ORDER BY id DESC LIMIT 30`, loan.id),
    });
  } catch (e) { next(e); }
});

// Company-wide notice settings: the ladder as configured. The payment pause used to
// live here too; it is a per-loan exception now, set on the loan itself.
app.get('/api/admin/notice-settings', adminOnly, (req, res, next) => {
  try {
    noticeRules.seedLadder(req.companyId);
    res.json({
      rules: noticeRules.rulesFor(req.companyId),
      is_owner: req.user.role === 'owner',
    });
  } catch (e) { next(e); }
});

// The pause on one loan: an arrangement with one buyer, visible where the loan is.
app.put('/api/admin/loans/:id/notice-pause', adminOnly, (req, res, next) => {
  try {
    const loan = ownedLoan(req, req.params.id);
    if (!loan) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const days = Math.max(0, Math.min(365, Math.round(Number(b.pause_days) || 0)));
    const minCents = Math.max(0, Math.round(Number(b.pause_min_cents) || 0));
    // A pause with no floor lets any amount at all buy quiet, and buy it again next
    // week. Rather than silently accept a setting that behaves like a bug, say so.
    if (days > 0 && minCents <= 0) {
      return res.status(400).json({
        error: 'Set a minimum payment as well. Without one, a $1 payment pauses notices ' +
               'for the same number of days as a $1,000 one, and can do it again every time.',
      });
    }
    run('UPDATE loans SET notice_pause_days=?, notice_pause_min_cents=? WHERE id=?',
      days > 0 ? days : null, days > 0 ? minCents : null, loan.id);
    res.json({ pause_days: days, pause_min_cents: days > 0 ? minCents : 0 });
  } catch (e) { next(e); }
});

app.put('/api/admin/notice-rules/:id', adminOnly, (req, res) => {
  const r = get('SELECT * FROM notice_rules WHERE id=? AND company_id=?', Number(req.params.id), req.companyId);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const day = b.trigger_day == null ? r.trigger_day : Math.max(1, Math.round(Number(b.trigger_day)));
  const identity = b.email_identity === 'legal' ? 'legal'
    : b.email_identity === 'servicing' ? 'servicing' : r.email_identity;
  const chans = Array.isArray(b.channels) ? b.channels.filter(c => ['app','sms','email'].includes(c)) : null;
  run(`UPDATE notice_rules SET trigger_day=?, email_identity=?, channels=?, subject=?, body=?, active=?
       WHERE id=?`,
    day, identity, chans && chans.length ? ['app', ...chans.filter(c => c !== 'app')].join(',') : r.channels,
    b.subject !== undefined ? (b.subject || null) : r.subject,
    b.body !== undefined ? (b.body || null) : r.body,
    b.active === undefined ? r.active : (b.active ? 1 : 0), r.id);
  res.json(get('SELECT * FROM notice_rules WHERE id=?', r.id));
});

// ---------- payoff letters ----------
// The letter someone wires money against. Built from the figures stored when the quote
// was issued, never recalculated — a payoff letter that quietly changes is worse than
// no letter at all.
function payoffPdf(q, loan) {
  const co = get('SELECT * FROM companies WHERE id=?', loan.company_id);
  const prop = get('SELECT * FROM properties WHERE id=?', loan.property_id);
  const buyer = loan.tenant_user_id ? get('SELECT name FROM users WHERE id=?', loan.tenant_user_id) : null;
  const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const { charges, credits } = payoff.letterLines(q);

  const d = new pdfDoc.Doc({
    title: `Payoff statement ${q.quote_number}`,
    footer: `${q.quote_number} · issued ${String(q.issued_at || '').slice(0, 10)} · good through ${q.good_through_date}`,
  });
  d.letterhead(co, { logo: companyLogo(co) });
  d.space(6);
  d.text('PAYOFF STATEMENT', { size: 15, bold: true, gap: 8 });

  d.row('Statement number', q.quote_number, { size: 9.5 });
  d.row('Statement date', q.quote_date, { size: 9.5 });
  d.row('Good through', q.good_through_date, { size: 9.5, bold: true });
  if (buyer) d.row('Buyer', buyer.name, { size: 9.5 });
  if (prop) d.row('Property', [prop.address, prop.city, prop.state].filter(Boolean).join(', '), { size: 9.5 });
  d.space(6); d.rule();

  d.space(4);
  d.text('Amount required to pay this account in full', { size: 11, bold: true, gap: 8 });
  for (const [label, amount] of charges) d.row(label, money(amount), { size: 10 });
  if (credits.length) {
    d.space(2);
    for (const [label, amount] of credits) d.row(label, '(' + money(-amount) + ')', { size: 10 });
  }
  d.space(4); d.rule('0.2 0.2 0.2');
  d.row('TOTAL DUE', money(q.total_cents), { size: 12, bold: true });
  d.space(8);

  d.text(`If payment is received after ${q.good_through_date}, add ${money(q.per_diem_cents)} for each ` +
    `additional day. This statement is void after that date and a new one must be requested.`,
    { size: 10, gap: 5 });
  d.space(6);

  d.heading('How to pay', 11);
  d.text('Payment must be by wire, cashier\'s check or certified funds. Personal checks are not ' +
    'accepted for a payoff. Contact us for wire instructions before sending funds.', { size: 10, gap: 5 });
  d.space(4);

  // Paying off a contract for deed means conveying title, not releasing a lien — the
  // buyer needs to know what they get and when.
  d.heading('What happens when this is paid', 11);
  d.text('On receipt of the full amount in cleared funds, we will prepare and deliver a deed ' +
    'conveying title to you, and record the documents needed to show this contract satisfied. ' +
    'Any escrow balance remaining after the payoff is refunded to you within 20 days, not counting ' +
    'weekends or public holidays.', { size: 10, gap: 5 });
  d.space(6);

  d.heading('Please read', 11);
  d.text('This statement assumes no further payments, returned payments, advances or fees between ' +
    'the statement date and the date the payoff is received. If any occur, the amount will change. ' +
    'Funds received after 2:00 PM local time are credited the next business day.', { size: 9, gap: 4 });
  return d.build();
}

app.get('/api/admin/loans/:id/payoff', adminOnly, (req, res, next) => {
  try {
    const loan = ownedLoan(req, Number(req.params.id));
    if (!loan) return res.status(404).json({ error: 'No such loan' });
    res.json({
      preview: payoff.calculate(loan.id),
      quotes: all('SELECT * FROM payoff_quotes WHERE loan_id=? ORDER BY id DESC LIMIT 20', loan.id),
    });
  } catch (e) { next(e); }
});

app.post('/api/admin/loans/:id/payoff', adminOnly, (req, res, next) => {
  try {
    const loan = ownedLoan(req, Number(req.params.id));
    if (!loan) return res.status(404).json({ error: 'No such loan' });
    const b = req.body || {};
    const q = payoff.issue(loan.id, {
      goodThroughDate: b.good_through_date,
      releaseFeeCents: Math.round(b.release_fee_cents || 0),
      requestedBy: b.requested_by || 'admin',
      requesterNote: b.note,
      createdBy: req.user.id,
    });
    res.json(q);
  } catch (e) { next(e); }
});

app.get('/api/admin/payoffs/:id/pdf', adminOnly, (req, res, next) => {
  try {
    const q = get(`SELECT q.* FROM payoff_quotes q WHERE q.id=? AND q.company_id=?`,
      Number(req.params.id), req.companyId);
    if (!q) return res.status(404).json({ error: 'Not found' });
    const loan = get('SELECT * FROM loans WHERE id=?', q.loan_id);
    sendPdf(res, payoffPdf(q, loan), `payoff-${q.quote_number}.pdf`);
  } catch (e) { next(e); }
});

// Send the statement to the buyer, with the letter attached as a link they can open.
app.post('/api/admin/payoffs/:id/send', adminOnly, async (req, res, next) => {
  try {
    const q = get('SELECT * FROM payoff_quotes WHERE id=? AND company_id=?', Number(req.params.id), req.companyId);
    if (!q) return res.status(404).json({ error: 'Not found' });
    const loan = get('SELECT * FROM loans WHERE id=?', q.loan_id);
    const co = myCompany(req);
    const buyer = loan.tenant_user_id ? get('SELECT * FROM users WHERE id=?', loan.tenant_user_id) : null;
    const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const delivery = {};
    const base = process.env.BASE_URL || baseUrlOf(req);
    const subject = `Payoff statement ${q.quote_number} — good through ${q.good_through_date}`;
    const bodyHtml = `<p>Here is the payoff statement you asked for.</p>
      <p><b>Total due: ${money(q.total_cents)}</b>, good through <b>${q.good_through_date}</b>.
      After that date add ${money(q.per_diem_cents)} per day.</p>
      <p>The full statement is in your app, and can be downloaded as a PDF.</p>`;

    if (buyer && buyer.email && email.emailEnabled(co)) {
      try {
        const html = tpl.emailShell({ company: co, subject, bodyHtml, baseUrl: base,
          preheader: `Total due ${money(q.total_cents)}` });
        const r = await email.sendEmail(buyer.email, { subject, html,
          text: tpl.htmlToText(bodyHtml), kind: 'payoff', loanId: loan.id, companyId: req.companyId }, co);
        delivery.email = { ok: true, to: r.to };
      } catch (e) { delivery.email = { ok: false, error: e.message }; }
    }
    // Always drop it in the app thread so the buyer has it wherever they look.
    run(`INSERT INTO messages (loan_id, sender_user_id, body, body_html, subject, read_by_admin, channels)
      VALUES (?,?,?,?,?,1,?)`, loan.id, req.user.id, tpl.htmlToText(bodyHtml),
      tpl.brandedShell({ company: co, subject, bodyHtml, baseUrl: base }), subject,
      Object.keys(delivery).length ? 'app,email' : 'app');

    run("UPDATE payoff_quotes SET delivered_at=datetime('now'), delivery_json=? WHERE id=?",
      JSON.stringify(delivery), q.id);
    if (loan.tenant_user_id) {
      notify.notify(loan.tenant_user_id, { kind: 'general', title: subject,
        body: `Total due ${money(q.total_cents)}`, url: '/?tab=loan' }).catch(() => {});
    }
    res.json({ ok: true, delivery });
  } catch (e) { next(e); }
});

// Quotes still open, oldest first — the seven business days are running on each.
app.get('/api/admin/payoffs/sla', adminOnly, (req, res, next) => {
  try { res.json(payoff.slaWatch(req.companyId)); } catch (e) { next(e); }
});

// ---------- buyer self-serve ----------
// A buyer asking what it costs to pay off their own home should not have to wait on
// somebody to get to it.
app.get('/api/tenant/payoff', tenantReady, (req, res, next) => {
  try {
    const loan = tenantLoan(req);
    if (!loan) return res.status(404).json({ error: 'No loan' });
    res.json({
      quotes: all(`SELECT id, quote_number, quote_date, good_through_date, total_cents,
        per_diem_cents, status, issued_at FROM payoff_quotes
        WHERE loan_id=? AND status IN ('issued','honored') ORDER BY id DESC LIMIT 5`, loan.id),
      can_request: !get(`SELECT id FROM payoff_quotes WHERE loan_id=? AND status='issued'
        AND request_received_at > datetime('now','-7 days')`, loan.id),
    });
  } catch (e) { next(e); }
});

app.post('/api/tenant/payoff/request', tenantReady, (req, res, next) => {
  try {
    const loan = tenantLoan(req);
    if (!loan) return res.status(404).json({ error: 'No loan' });
    // One a week is plenty. More than that and nobody knows which number is current.
    const recent = get(`SELECT * FROM payoff_quotes WHERE loan_id=? AND status='issued'
      AND request_received_at > datetime('now','-7 days') ORDER BY id DESC LIMIT 1`, loan.id);
    if (recent) return res.json({ ok: true, quote: recent, reused: true });

    const days = Math.min(60, Math.max(1, Number(req.body && req.body.days) || 30));
    const good = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const q = payoff.issue(loan.id, {
      goodThroughDate: good, requestedBy: 'buyer', requestedByUserId: req.user.id,
      requesterNote: (req.body && req.body.note) || null,
    });
    for (const a of all("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL AND archived_at IS NULL", loan.company_id)) {
      notify.notify(a.id, { kind: 'general', title: 'A buyer requested a payoff statement',
        body: `${q.quote_number} — good through ${q.good_through_date}`, url: '/admin' }).catch(() => {});
    }
    // The formal statement is delivered, not merely downloadable: the PDF lands in
    // the buyer's documents and the thread says so. A payoff quote is the kind of
    // paper a title company asks the buyer to produce — it should already be filed.
    try {
      const co = get('SELECT * FROM companies WHERE id=?', loan.company_id);
      const buf = payoffPdf(q, loan);
      const stored = crypto.randomUUID() + '.pdf';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
      run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
           VALUES (?,?,?,?,?,?,?,?,?,1)`,
        loan.company_id, loan.id, loan.property_id, 'other', 'misc_shared',
        `Payoff statement ${q.quote_number} — good through ${q.good_through_date}`,
        `payoff-${q.quote_number}.pdf`, stored, 'application/pdf');
      const adminId = get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id LIMIT 1", loan.company_id);
      if (adminId) {
        run(`INSERT INTO messages (loan_id, sender_user_id, body, subject, read_by_admin, channels)
             VALUES (?,?,?,?,1,'app')`, loan.id, adminId.id,
          `Your payoff statement ${q.quote_number} is ready and filed in your Documents. ` +
          `The amount is good through ${q.good_through_date}; after that date a new statement is needed.`,
          `Payoff statement ${q.quote_number}`);
      }
    } catch (e) { console.error('Payoff statement not filed:', e.message); }
    res.json({ ok: true, quote: q, reused: false });
  } catch (e) { next(e); }
});

app.get('/api/tenant/payoffs/:id/pdf', tenantReady, (req, res, next) => {
  try {
    const loan = tenantLoan(req);
    if (!loan) return res.status(404).json({ error: 'No loan' });
    const q = get('SELECT * FROM payoff_quotes WHERE id=? AND loan_id=?', Number(req.params.id), loan.id);
    if (!q) return res.status(404).json({ error: 'Not found' });
    sendPdf(res, payoffPdf(q, loan), `payoff-${q.quote_number}.pdf`);
  } catch (e) { next(e); }
});

// ---------- payment methods ----------
// Money that arrives outside Stripe still has to land on the ledger, and it matters
// which way it came — a Zelle transfer and a handful of cash are not the same thing
// when you are reconciling a bank statement a year later.
const MANUAL_METHODS = {
  cash:     'Cash',
  check:    'Check',
  zelle:    'Zelle',
  venmo:    'Venmo',
  applepay: 'Apple Pay',
  paypal:   'PayPal',
  other:    'Other',
};
// Everything the ledger can show, including the Stripe methods and two retired ones
// kept so old rows still read properly rather than turning into "Payment".
const ALL_METHOD_LABELS = {
  stripe_card: 'Card', stripe_ach: 'Bank transfer', stripe_cashapp: 'Cash App Pay',
  ...MANUAL_METHODS,
  cash_retail: 'Cash at store (retired)', cashapp_manual: 'Cash App (retired)',
};

app.get('/api/admin/payment-methods', adminOnly, (req, res) => {
  res.json({ manual: MANUAL_METHODS, all: ALL_METHOD_LABELS });
});

// ---------- escrow ----------
// Escrow is the buyer's money held for their taxes and insurance. Everything here runs
// through the trust side of the journal, so a bill can never be paid with somebody
// else's escrow.
app.get('/api/admin/loans/:id/escrow', adminOnly, (req, res, next) => {
  try {
    const loan = ownedLoan(req, Number(req.params.id));
    if (!loan) return res.status(404).json({ error: 'No such loan' });
    res.json({
      items: all('SELECT * FROM escrow_items WHERE loan_id=? AND active=1 ORDER BY id', loan.id),
      analysis: escrow.analyze(loan.id),
      last_saved: get('SELECT * FROM escrow_analyses WHERE loan_id=? ORDER BY id DESC LIMIT 1', loan.id),
      disbursements: all(`SELECT d.*, doc.filename receipt_filename
        FROM escrow_disbursements d
        LEFT JOIN documents doc ON doc.id = d.receipt_document_id
        WHERE d.loan_id=? ORDER BY d.scheduled_date DESC, d.id DESC LIMIT 40`, loan.id),
      held_cents: journal.balance('2100', { loan_id: loan.id }),
      advanced_cents: journal.balance('1260', { loan_id: loan.id }),
    });
  } catch (e) { next(e); }
});

app.post('/api/admin/loans/:id/escrow/items', adminOnly, (req, res, next) => {
  try {
    const loan = ownedLoan(req, Number(req.params.id));
    if (!loan) return res.status(404).json({ error: 'No such loan' });
    const b = req.body || {};
    const months = escrow.monthsOf(b.due_months);
    if (!months.length) return res.status(400).json({ error: 'Say which month or months the bill is due, e.g. 2,8' });
    if (!b.annual_amount_cents) return res.status(400).json({ error: 'How much is it for the year?' });
    const r = run(`INSERT INTO escrow_items (loan_id,item_type,payee,account_number,
      annual_amount_cents,due_months) VALUES (?,?,?,?,?,?)`,
      loan.id, b.item_type || 'property_tax', b.payee || null, b.account_number || null,
      Math.round(b.annual_amount_cents), months.join(','));
    escrow.rebuildSchedule(loan.id);
    res.json(get('SELECT * FROM escrow_items WHERE id=?', r.lastInsertRowid));
  } catch (e) { next(e); }
});

app.delete('/api/admin/escrow/items/:id', adminOnly, (req, res, next) => {
  try {
    const it = get(`SELECT ei.* FROM escrow_items ei JOIN loans l ON l.id=ei.loan_id
      WHERE ei.id=? AND l.company_id=?`, Number(req.params.id), req.companyId);
    if (!it) return res.status(404).json({ error: 'Not found' });
    run('UPDATE escrow_items SET active=0 WHERE id=?', it.id);
    run("DELETE FROM escrow_disbursements WHERE escrow_item_id=? AND status='scheduled'", it.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Run the analysis and keep it, because the statement you send has to be reproducible.
app.post('/api/admin/loans/:id/escrow/analyze', adminOnly, (req, res, next) => {
  try {
    const loan = ownedLoan(req, Number(req.params.id));
    if (!loan) return res.status(404).json({ error: 'No such loan' });
    const a = escrow.analyze(loan.id);
    const id = escrow.saveAnalysis(a);
    if (req.body && req.body.apply) {
      run('UPDATE loans SET escrow_cents=? WHERE id=?', a.new_monthly_cents, loan.id);
    }
    escrow.rebuildSchedule(loan.id);
    res.json({ ...a, saved_id: id, applied: !!(req.body && req.body.apply) });
  } catch (e) { next(e); }
});

app.post('/api/admin/escrow/disbursements/:id/pay', adminOnly, (req, res, next) => {
  try {
    const d = get(`SELECT d.* FROM escrow_disbursements d JOIN loans l ON l.id=d.loan_id
      WHERE d.id=? AND l.company_id=?`, Number(req.params.id), req.companyId);
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(escrow.payDisbursement(d.id, { ...(req.body || {}), created_by: req.user.id }));
  } catch (e) { next(e); }
});

// Bills coming up that escrow will not cover. You still have to pay them — this is
// notice to get the money ready, not permission to let a tax bill lapse.
app.get('/api/admin/escrow/shortfalls', adminOnly, (req, res, next) => {
  try { res.json(escrow.upcomingShortfalls(req.companyId, Number(req.query.days) || 45)); }
  catch (e) { next(e); }
});

// ---------- books ----------
// Whether the double-entry journal agrees with the old tables, loan by loan. Until this
// reads clean, nothing on any screen is served from the journal.
app.get('/api/admin/books', adminOnly, (req, res) => {
  const rec = backfill.reconcile(req.companyId);
  res.json({
    ...rec,
    entries: get('SELECT COUNT(*) c FROM journal_entries WHERE company_id=?', req.companyId).c,
    accounts: all(`SELECT a.code, a.name, a.type, a.fund,
        COALESCE(SUM(jl.debit_cents),0) dr, COALESCE(SUM(jl.credit_cents),0) cr
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_code = a.code
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.company_id = ?
      GROUP BY a.code ORDER BY a.code`, req.companyId)
      .map(a => ({ ...a, balance_cents: journal.signed(a.type, a.dr, a.cr) }))
      .filter(a => a.balance_cents !== 0),
  });
});

// Everything that has happened on one house — the buyer's note and the lender's note
// side by side, which is the whole point of putting them in one journal.
app.get('/api/admin/properties/:id/ledger', adminOnly, (req, res, next) => {
  try {
    const p = ownedProperty(req, Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'No such property' });
    res.json({
      property: p,
      summary: journal.propertySummary(p.id),
      rows: journal.propertyLedger(p.id, { from: req.query.from, to: req.query.to }),
    });
  } catch (e) { next(e); }
});

// ---------- email setup ----------
// Same shape as texting. Two from-addresses: routine correspondence goes out under the
// servicing address, and anything LEGAL_NOTICE_DAYS or more past due goes out under the
// legal one. The password is never sent back to the browser.
app.get('/api/admin/email', adminOnly, (req, res) => {
  const co = myCompany(req);
  const c = email.creds(co);
  const legal = email.creds(co, 'legal');
  res.json({
    connected: !!c,
    source: c ? c.source : null,
    provider: email.providerOf(co),
    api_key_set: !!co.email_api_key,
    webhook_secret_set: !!co.email_webhook_secret,
    webhook_url: baseUrlOf(req) + '/api/email/webhook',
    delivery: get(`SELECT
        COUNT(*) sent,
        SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) delivered,
        SUM(CASE WHEN bounced_at   IS NOT NULL THEN 1 ELSE 0 END) bounced
      FROM email_log WHERE company_id=? AND status='sent'`, req.companyId),
    host: co.smtp_host || process.env.SMTP_HOST || null,
    port: co.smtp_port || Number(process.env.SMTP_PORT || 465),
    user: co.smtp_user || process.env.SMTP_USER || null,
    from_servicing: c ? c.from : null,
    from_legal: legal ? legal.from : null,
    reply_to: legal ? legal.replyTo : null,
    legal_has_own_login: !!co.email_legal_user,
    legal_notice_days: LEGAL_NOTICE_DAYS,
    recent: all(`SELECT id, identity, to_address, subject, kind, status, error, created_at,
                        delivered_at, bounced_at, bounce_reason
                 FROM email_log WHERE company_id=? ORDER BY id DESC LIMIT 20`, req.companyId),
  });
});

app.put('/api/admin/email', ownerOnly, async (req, res, next) => {
  const b = req.body || {};

  // The HTTPS path. Kept first and separate because it shares nothing with SMTP except
  // the from-addresses — no host, no port, no per-mailbox password.
  if (String(b.provider || '').toLowerCase() === 'resend') {
    const co = myCompany(req);
    const key = String(b.api_key || '').trim() || co.email_api_key;
    const servicingR = email.validAddress(b.from_servicing);
    const legalR = email.validAddress(b.from_legal) || servicingR;
    const replyToR = b.reply_to ? email.validAddress(b.reply_to) : null;
    if (!key) return res.status(400).json({ error: 'An API key is needed' });
    if (!servicingR) return res.status(400).json({ error: 'The servicing "from" address does not look valid' });
    try {
      await email.verifyApiKey({ key, from: servicingR, fromName: tpl.outboundName(co) });
      // Only check the legal address separately when it is a different one — otherwise
      // connecting would send two identical test messages to the same inbox.
      if (legalR && legalR !== servicingR) {
        await email.verifyApiKey({ key, from: legalR, fromName: tpl.outboundName(co) });
      }
      run(`UPDATE companies SET email_provider='resend', email_api_key=?,
             email_from_servicing=?, email_from_legal=?, email_reply_to=?,
             email_webhook_secret=? WHERE id=?`,
        key, servicingR, legalR, replyToR,
        String(b.webhook_secret || '').trim() || co.email_webhook_secret || null, req.companyId);
      return res.json({ ok: true, provider: 'resend', from_servicing: servicingR, from_legal: legalR });
    } catch (e) { return next(e); }
  }

  const host = String(b.host || '').trim();
  const port = Number(b.port || 465);
  const user = String(b.user || '').trim();
  const pass = String(b.pass || '').trim();
  const servicing = email.validAddress(b.from_servicing || user);
  const legalAddr = email.validAddress(b.from_legal) || servicing;
  const replyTo = b.reply_to ? email.validAddress(b.reply_to) : null;
  const legalUser = String(b.legal_user || '').trim() || null;
  const legalPass = String(b.legal_pass || '').trim() || null;

  if (!host || !user || !pass) {
    return res.status(400).json({ error: 'Mail server, username and password are all needed' });
  }
  if (!servicing) return res.status(400).json({ error: 'The servicing "from" address does not look valid' });

  try {
    await email.verifyCreds({ host, port, user, pass, from: servicing });   // fail before saving
    // A separate legal mailbox is checked on its own, so a typo there surfaces now
    // rather than the first time a real notice needs to go out.
    if (legalUser && legalPass) {
      await email.verifyCreds({ host, port, user: legalUser, pass: legalPass, from: legalAddr });
    }
    run(`UPDATE companies SET smtp_host=?, smtp_port=?, smtp_user=?, smtp_pass=?,
           email_from_servicing=?, email_from_legal=?, email_reply_to=?,
           email_legal_user=?, email_legal_pass=? WHERE id=?`,
      host, port, user, pass, servicing, legalAddr, replyTo, legalUser, legalPass, req.companyId);
    res.json({ ok: true, host, from_servicing: servicing, from_legal: legalAddr });
  } catch (e) { next(e); }
});

app.delete('/api/admin/email', ownerOnly, (req, res) => {
  run(`UPDATE companies SET smtp_host=NULL, smtp_port=NULL, smtp_user=NULL, smtp_pass=NULL,
       email_from_servicing=NULL, email_from_legal=NULL, email_reply_to=NULL,
       email_legal_user=NULL, email_legal_pass=NULL,
       email_provider='smtp', email_api_key=NULL, email_webhook_secret=NULL WHERE id=?`, req.companyId);
  res.json({ ok: true });
});

// ---------- certified mail (Lob) ----------
app.get('/api/admin/lob', adminOnly, (req, res) => {
  const co = myCompany(req);
  res.json({
    connected: lob.lobEnabled(co),
    key_set: !!co.lob_api_key,
    test_mode: /^test_/.test(co.lob_api_key || ''),
    cost_cents: Number(co.lob_cost_cents) || 0,
    auto_certified_cents: lob.estimateCostCents({ service: 'certified' }),
    auto_first_class_cents: lob.estimateCostCents({ service: 'first_class' }),
    mail_address_line1: co.mail_address_line1 || null,
    mail_address_city: co.mail_address_city || null,
    mail_address_state: co.mail_address_state || null,
    mail_address_zip: co.mail_address_zip || null,
  });
});
app.put('/api/admin/lob', ownerOnly, async (req, res, next) => {
  try {
    const co = myCompany(req);
    const b = req.body || {};
    const key = String(b.api_key || '').trim() || co.lob_api_key;
    if (!key) return res.status(400).json({ error: 'A Lob API key is needed' });
    for (const f of ['line1', 'city', 'state', 'zip']) {
      if (!String(b['mail_address_' + f] || '').trim()) {
        return res.status(400).json({ error: 'A full return address is needed — certified mail has to say who it is from.' });
      }
    }
    await lob.verifyKey(key);                                 // fail before saving
    run(`UPDATE companies SET lob_api_key=?, lob_cost_cents=?,
           mail_address_line1=?, mail_address_city=?, mail_address_state=?, mail_address_zip=? WHERE id=?`,
      key, Math.max(0, Math.round(Number(b.cost_cents) || 0)),
      String(b.mail_address_line1).trim(), String(b.mail_address_city).trim(),
      String(b.mail_address_state).trim().toUpperCase().slice(0, 2), String(b.mail_address_zip).trim(),
      req.companyId);
    res.json({ ok: true, test_mode: /^test_/.test(key) });
  } catch (e) { next(e); }
});
app.delete('/api/admin/lob', ownerOnly, (req, res) => {
  run('UPDATE companies SET lob_api_key=NULL WHERE id=?', req.companyId);
  res.json({ ok: true });
});
// Mail any notice by hand — certified when it needs to be provable, regular first
// class when it just needs to arrive. Cost is computed from Lob's published rates
// (or the settings override), posted as a collection fee on live sends.
app.post('/api/admin/notices/:id/mail', adminOnly, async (req, res, next) => {
  try {
    const n = get(`SELECT n.* FROM notices n JOIN loans l ON l.id=n.loan_id
                   WHERE n.id=? AND l.company_id=?`, req.params.id, req.companyId);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (n.lob_id) return res.status(400).json({ error: 'This notice already went by mail — its tracking is on the notice' });
    if (n.stage === 'mi_dc101') return res.status(400).json({ error: 'A DC 101 is served from its review screen, not mailed as a letter' });
    const service = req.body && req.body.service === 'first_class' ? 'first_class' : 'certified';
    const co = myCompany(req);
    const loan = get('SELECT * FROM loans WHERE id=?', n.loan_id);
    const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
    const tenant = loan.tenant_user_id ? get('SELECT * FROM users WHERE id=?', loan.tenant_user_id) : null;
    if (!property || !property.address) return res.status(400).json({ error: 'No property address to mail to' });
    const sent = await lob.sendLetter(co, {
      to: { name: (tenant && tenant.name) || 'Occupant', address_line1: property.address,
            address_city: property.city, address_state: property.state, address_zip: property.zip },
      subject: n.subject, body: n.body,
      description: `${n.stage || n.type} — loan ${loan.id}`, service,
      idempotencyKey: `manual-${n.id}-${service}`,
    });
    run(`UPDATE notices SET lob_id=?, lob_tracking=?, lob_status='created', lob_expected=?, lob_cost_cents=? WHERE id=?`,
      sent.id, sent.tracking_number, sent.expected_delivery_date, sent.cost_cents || null, n.id);
    // The same evidence trail the automatic send keeps: a PDF copy of what was
    // mailed, filed on the loan, so nothing about mail ever requires Lob's website.
    try {
      const pdfBuf = pdfDoc.letter({ company: co, subject: n.subject, bodyText: n.body, sentAt: today() });
      const stored = crypto.randomUUID() + '.pdf';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), pdfBuf);
      run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
           VALUES (?,?,?,?,?,?,?,?,?,0)`,
        loan.company_id, loan.id, loan.property_id, 'other', 'private',
        `${service === 'certified' ? 'Certified' : 'First-class'} mail — ${n.subject || 'notice'} (${sent.tracking_number || sent.id})`,
        `mailed-notice-${n.id}.pdf`, stored, 'application/pdf');
    } catch (e) { console.error('Mailed copy not filed:', e.message); }
    if (sent.cost_cents > 0 && !sent.test) {
      run(`INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo) VALUES (?,?, 'fee', ?, ?)`,
        loan.id, today(), -sent.cost_cents,
        `Collection fee — ${service === 'certified' ? 'certified' : 'first-class'} mail (${sent.tracking_number || sent.id})`);
      run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', sent.cost_cents, loan.id);
    }
    res.json({ ok: true, service, tracking: sent.tracking_number, cost_cents: sent.cost_cents, test: sent.test });
  } catch (e) { next(e); }
});

// Ask USPS (via Lob) where a certified letter is now, and remember the answer.
app.get('/api/admin/notices/:id/mail-status', adminOnly, async (req, res, next) => {
  try {
    const n = get(`SELECT n.* FROM notices n JOIN loans l ON l.id=n.loan_id
                   WHERE n.id=? AND l.company_id=?`, req.params.id, req.companyId);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (!n.lob_id) return res.status(400).json({ error: 'This notice did not go by certified mail' });
    const s = await lob.getLetterStatus(myCompany(req), n.lob_id);
    run('UPDATE notices SET lob_status=?, lob_tracking=?, lob_expected=? WHERE id=?',
      s.status, s.tracking_number, s.expected_delivery_date, n.id);
    res.json(s);
  } catch (e) { next(e); }
});

// ---------- DC 101: review, preview, serve ----------
// The Michigan forfeiture notice moves in three steps that are deliberately human:
// the sweep (or a button) prepares it, the admin reviews the filled form and can edit
// any line, and one click serves it by certified mail. Court details typed here are
// remembered on the property; the contract date is remembered on the loan.

function dc101ValuesFrom(n, posted) {
  const values = JSON.parse(n.fill_json || '{}');
  if (posted && typeof posted === 'object') {
    const known = new Set(dc101.fieldNames);
    for (const [k, v] of Object.entries(posted)) {
      if (known.has(k)) values[k] = v;
    }
  }
  return values;
}

function getDc101(req) {
  return get(`SELECT n.* FROM notices n JOIN loans l ON l.id=n.loan_id
              WHERE n.id=? AND l.company_id=? AND n.stage='mi_dc101'`, req.params.id, req.companyId);
}

// Start (or fetch) the draft by hand — the sweep does this on day 10, but nothing
// stops an admin starting earlier when the situation is already clear.
app.post('/api/admin/loans/:id/dc101/prepare', adminOnly, (req, res, next) => {
  try {
    let loan = get('SELECT * FROM loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
    if (!noticeRules.isMichigan(property)) {
      return res.status(400).json({ error: 'DC 101 is a Michigan form — this property is not in Michigan' });
    }
    loan = assessRecurringCharges(loan);
    const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
    const status = loanEngine.loanStatus(loan, ledger, today());
    if (!status.is_past_due) return res.status(400).json({ error: 'This loan is current — nothing to forfeit' });
    const tenant = loan.tenant_user_id ? get('SELECT * FROM users WHERE id=?', loan.tenant_user_id) : null;
    const idx = status.payments_made_equiv;
    const period = loanEngine.addMonthsUTC(new Date(loan.first_payment_date + 'T00:00:00Z'), idx)
      .toISOString().slice(0, 7);
    const n = prepareDc101(loan, { period, status, property, tenant, co: myCompany(req) });
    if (!n) return res.status(400).json({ error: 'A DC 101 has already been served for this default — the cure clock is running' });
    res.json({ ok: true, notice_id: n.id, values: JSON.parse(n.fill_json || '{}') });
  } catch (e) { next(e); }
});

// The review screen's read: current values plus the court suggestion for the district.
app.get('/api/admin/notices/:id/dc101', adminOnly, (req, res, next) => {
  try {
    const n = getDc101(req);
    if (!n) return res.status(404).json({ error: 'Not found' });
    const loan = get('SELECT * FROM loans WHERE id=?', n.loan_id);
    const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
    const court = noticeRules.miCourtFor(property);
    res.json({
      id: n.id, loan_id: n.loan_id, prepared: n.prepared, served_at: n.served_at,
      cure_deadline: n.cure_deadline, lob_tracking: n.lob_tracking, lob_status: n.lob_status,
      values: JSON.parse(n.fill_json || '{}'),
      court_suggestion: court, contract_date: loan.contract_date,
      mail_cost_cents: lob.estimateCostCents({ service: 'certified', pages: 3 }),
      lob_ready: lob.lobEnabled(myCompany(req)),
    });
  } catch (e) { next(e); }
});

// Save edits without serving — the draft keeps whatever the admin last reviewed.
app.put('/api/admin/notices/:id/dc101', adminOnly, (req, res, next) => {
  try {
    const n = getDc101(req);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (n.served_at) return res.status(400).json({ error: 'Already served — the form cannot change after service' });
    const values = dc101ValuesFrom(n, req.body && req.body.values);
    run('UPDATE notices SET fill_json=? WHERE id=?', JSON.stringify(values), n.id);
    res.json({ ok: true, values });
  } catch (e) { next(e); }
});

// The form exactly as it stands — before service a draft preview, after service the
// court copy with the certificate of service and tracking number on it.
app.get('/api/admin/notices/:id/dc101.pdf', adminOnly, (req, res, next) => {
  try {
    const n = getDc101(req);
    if (!n) return res.status(404).json({ error: 'Not found' });
    const values = dc101ValuesFrom(n, null);
    const buf = dc101.render(values);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dc101-${n.id}.pdf"`);
    res.send(buf);
  } catch (e) { next(e); }
});

// Serve it. One certified letter, one started cure clock, one filed court copy.
app.post('/api/admin/notices/:id/serve-dc101', adminOnly, async (req, res, next) => {
  try {
    const n = getDc101(req);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (n.served_at) return res.status(400).json({ error: 'Already served — the cure clock is running' });
    const co = myCompany(req);
    if (!lob.lobEnabled(co)) {
      return res.status(400).json({ error: 'Certified mail is not set up — add the Lob key and your mailing address in Settings' });
    }
    const loan = get('SELECT * FROM loans WHERE id=?', n.loan_id);
    const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
    const tenant = loan.tenant_user_id ? get('SELECT * FROM users WHERE id=?', loan.tenant_user_id) : null;
    if (!property || !property.address) return res.status(400).json({ error: 'No property address to serve at' });

    const values = dc101ValuesFrom(n, req.body && req.body.values);
    // Service date and signer are stamped at the moment of service, not before.
    values['date'] = values['date'] || undefined;
    const serviceDate = today();
    const usService = `${Number(serviceDate.slice(5, 7))}/${Number(serviceDate.slice(8, 10))}/${serviceDate.slice(0, 4)}`;
    values['date'] = usService;
    if (!values['signature']) values['signature'] = `${req.user.name || 'Agent'}, agent for seller`;

    // Court details and the contract date, remembered for the next time this house —
    // or this loan — needs paperwork.
    run('UPDATE properties SET court_district=COALESCE(?,court_district), court_address=COALESCE(?,court_address), court_phone=COALESCE(?,court_phone) WHERE id=?',
      values['judicial district'] || null, values['court address'] || null, values['court telephone no'] || null, property.id);
    if (req.body && req.body.contract_date) {
      run('UPDATE loans SET contract_date=? WHERE id=?', req.body.contract_date, loan.id);
    }

    const buyerPdf = dc101.render(values);
    const sent = await lob.sendLetter(co, {
      to: { name: (tenant && tenant.name) || 'Occupant', address_line1: property.address,
            address_city: property.city, address_state: property.state, address_zip: property.zip },
      pdf: buyerPdf, pdfPages: 2,
      description: `DC 101 forfeiture notice — loan ${loan.id}`,
      idempotencyKey: `dc101-${n.id}`, service: 'certified',
    });

    const cureDays = Math.max(15, parseInt(values['cured or paid within days'], 10) || 15);
    const cure = new Date(serviceDate + 'T00:00:00Z');
    cure.setUTCDate(cure.getUTCDate() + cureDays);
    const cureDeadline = cure.toISOString().slice(0, 10);

    run(`UPDATE notices SET prepared=0, served_at=?, cure_deadline=?, fill_json=?,
          subject=?, body=?, lob_id=?, lob_tracking=?, lob_status='created', lob_expected=?, lob_cost_cents=?,
          delivery_json=? WHERE id=?`,
      serviceDate, cureDeadline, JSON.stringify(values),
      `Forfeiture Notice (DC 101) — ${property.address}`,
      `Served by certified mail on ${usService}. Cure deadline ${cureDeadline}. Tracking ${sent.tracking_number || sent.id}.`,
      sent.id, sent.tracking_number, sent.expected_delivery_date, sent.cost_cents || null,
      JSON.stringify({ mail: { ok: true, lob_id: sent.id, tracking: sent.tracking_number, test: sent.test } }), n.id);

    // The court copy: same form, certificate of service completed with the tracking
    // number. This is the exhibit that goes with the DC 102.
    try {
      const courtPdf = dc101.render({
        ...values,
        ...dc101.certificateValues({ tenant, property, mailedAt: serviceDate,
          tracking: sent.tracking_number, signerName: values['signature'] }),
      });
      const stored = crypto.randomUUID() + '.pdf';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), courtPdf);
      run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
           VALUES (?,?,?,?,?,?,?,?,?,0)`,
        loan.company_id, loan.id, loan.property_id, 'other', 'private',
        `DC 101 served ${usService} — certified (${sent.tracking_number || sent.id})`,
        `dc101-served-${n.id}.pdf`, stored, 'application/pdf');
    } catch (e) { console.error('DC 101 court copy not filed:', e.message); }

    if (sent.cost_cents > 0 && !sent.test) {
      run(`INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo) VALUES (?,?, 'fee', ?, ?)`,
        loan.id, today(), -sent.cost_cents, `Collection fee — DC 101 certified mail (${sent.tracking_number || sent.id})`);
      run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', sent.cost_cents, loan.id);
    }
    run(`UPDATE tasks SET status='done', completed_at=datetime('now') WHERE source_key=? AND status='open'`, `dc101-prep-${n.id}`);

    res.json({ ok: true, tracking: sent.tracking_number, cost_cents: sent.cost_cents,
      cure_deadline: cureDeadline, test: sent.test });
  } catch (e) { next(e); }
});

// Send a real email to yourself to prove the path works. `identity` lets you test the
// legal address specifically, since that is the one nobody notices is broken until a
// notice has to go out.
app.post('/api/admin/email/test', adminOnly, async (req, res, next) => {
  const co = myCompany(req);
  const to = email.validAddress(req.body && req.body.to);
  const identity = (req.body && req.body.identity) === 'legal' ? 'legal' : 'servicing';
  if (!to) return res.status(400).json({ error: 'Give an email address to test with' });
  if (!email.emailEnabled(co)) return res.status(400).json({ error: 'Connect email first' });
  try {
    const r = await email.sendEmail(to, {
      subject: `Porch Pay test — ${identity} address`,
      text: `This is a test from ${tpl.outboundName(co)}.\n\nEmail is working, and this message was sent from the ${identity} address.`,
      kind: identity === 'legal' ? 'legal_notice' : 'general',
      companyId: req.companyId,
    }, co);
    res.json({ ok: true, to: r.to, from: r.from, identity: r.identity });
  } catch (e) { next(e); }
});

// The in-app dialer. The app rings the admin's own phone, then bridges to the target;
// the target sees the business number. my_phone, when sent, is remembered on the user
// so the question is only ever asked once.
app.post('/api/admin/call', adminOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const to = sms.normalizePhone(b.to);
    if (!to) return res.status(400).json({ error: 'No valid number to call' });
    if (b.my_phone) {
      const mine = sms.normalizePhone(b.my_phone);
      if (!mine) return res.status(400).json({ error: 'Your own phone number does not look valid' });
      run('UPDATE users SET phone=? WHERE id=?', mine, req.user.id);
      req.user.phone = mine;
    }
    if (!req.user.phone) {
      return res.status(400).json({ error: 'need_phone', need_phone: true });
    }
    const co = myCompany(req);
    const r = await sms.placeCall(to, req.user.phone, co,
      { announce: b.name, record: !!co.record_calls, baseUrl: baseUrlOf(req) });
    res.json({ ok: true, my_phone: r.my_phone });
  } catch (e) { next(e); }
});

// Send a real text to yourself to prove the whole path works.
app.post('/api/admin/texting/test', adminOnly, async (req, res, next) => {
  const co = myCompany(req);
  const to = sms.normalizePhone(req.body && req.body.to);
  if (!to) return res.status(400).json({ error: 'Give a mobile number to test with' });
  if (!sms.smsEnabled(co)) return res.status(400).json({ error: 'Connect Twilio first' });
  try {
    await sms.sendSms(to, `Porch Pay test from ${tpl.outboundName(co)}. Texting is working.`, co);
    res.json({ ok: true, to });
  } catch (e) { next(e); }
});

// ---------- invitations ----------
function inviteBody(req, invId) {
  const inv = get('SELECT * FROM invitations WHERE id=? AND company_id=?', invId, req.companyId);
  if (!inv) return null;
  const u = get('SELECT * FROM users WHERE id=?', inv.user_id);
  const co = get('SELECT * FROM companies WHERE id=?', inv.company_id);
  const loan = inv.loan_id ? get('SELECT * FROM loans WHERE id=?', inv.loan_id) : null;
  const prop = loan ? get('SELECT * FROM properties WHERE id=?', loan.property_id) : null;
  return {
    inv, user: u,
    text: sms.inviteMessage({
      buyerName: u ? u.name : '', companyName: tpl.outboundName(co),
      address: prop ? prop.address : 'your new home',
      url: baseUrlOf(req) + '/', email: u ? u.email : '',
      tempPassword: inv.temp_password,
    }),
  };
}
app.get('/api/admin/invitations', adminOnly, (req, res) => {
  res.json({
    sms_enabled: sms.smsEnabled(myCompany(req)),
    invitations: all(`SELECT i.*, u.name AS buyer_name, u.email AS buyer_email, p.address
      FROM invitations i LEFT JOIN users u ON u.id=i.user_id
      LEFT JOIN loans l ON l.id=i.loan_id LEFT JOIN properties p ON p.id=l.property_id
      WHERE i.company_id=? ORDER BY i.id DESC`, req.companyId),
  });
});
app.get('/api/admin/invitations/:id/preview', adminOnly, (req, res) => {
  const d = inviteBody(req, req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ text: d.text, phone: d.inv.phone, sms_enabled: sms.smsEnabled(myCompany(req)),
    buyer_name: d.user ? d.user.name : '', status: d.inv.status });
});
app.post('/api/admin/invitations/:id/send', adminOnly, async (req, res, next) => {
  const d = inviteBody(req, req.params.id);
  // One text per buyer. Resending needs a deliberate override so a stray double-click
  // cannot text somebody twice — and so a temporary password is not sprayed around.
  if (d.inv && d.inv.status === 'sent' && !req.body.resend) {
    return res.status(409).json({
      error: 'This buyer was already texted their invitation on ' + (d.inv.sent_at || 'a previous date') +
             '. Send it again only if it never arrived.',
      already_sent: true,
    });
  }
  if (!d) return res.status(404).json({ error: 'Not found' });
  const phone = sms.normalizePhone(req.body.phone || d.inv.phone);
  if (!phone) return res.status(400).json({ error: 'No mobile number on file for this buyer' });
  if (!sms.smsEnabled(myCompany(req))) {
    return res.status(400).json({ error: 'Texting is not set up yet. Copy the message and send it from your phone, or add your Twilio details.', text: d.text });
  }
  try {
    await sms.sendSms(phone, d.text, myCompany(req));
    run("UPDATE invitations SET status='sent', phone=?, sent_at=datetime('now'), error=NULL WHERE id=?", phone, d.inv.id);
    res.json({ ok: true });
  } catch (e) {
    run("UPDATE invitations SET status='failed', error=? WHERE id=?", e.message, d.inv.id);
    next(e);
  }
});
app.post('/api/admin/invitations/:id/mark-sent', adminOnly, (req, res) => {
  const inv = get('SELECT * FROM invitations WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  run("UPDATE invitations SET status='sent', channel='manual', sent_at=datetime('now') WHERE id=?", inv.id);
  res.json({ ok: true });
});

// ---------- admin: tenant buyers ----------
app.get('/api/admin/tenants', adminOnly, (req, res) => {
  const archived = req.query.archived === '1';
  const rows = all(`SELECT id, name, email, phone, terms_accepted_at, location_consent_at,
      archived_at, archived_reason, created_at
    FROM users WHERE role='tenant' AND company_id=? AND deleted_at IS NULL
      AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY id DESC`, req.companyId);
  for (const t of rows) {
    const loan = get(`SELECT l.id, p.address FROM loans l LEFT JOIN properties p ON p.id=l.property_id
      WHERE l.tenant_user_id=? AND l.company_id=? ORDER BY l.id DESC LIMIT 1`, t.id, req.companyId);
    t.loan = loan || null;
  }
  res.json(rows);
});
app.post('/api/admin/tenants', adminOnly, (req, res) => {
  const { name, email, phone } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (get('SELECT id FROM users WHERE email=?', email.toLowerCase().trim())) return res.status(400).json({ error: 'Email already exists' });
  const temp = 'TB-' + crypto.randomInt(100000, 999999) + '!';
  const r = run('INSERT INTO users (company_id, email, password_hash, role, name, phone, must_change_password) VALUES (?,?,?,?,?,?,1)',
    req.companyId, email.toLowerCase().trim(), hashPassword(temp), 'tenant', name, addr.formatPhone(phone) || null);
  res.json({ id: r.lastInsertRowid, name, email, phone, temp_password: temp });
});
// Edit a buyer's details. Email changes move their login, so it is checked for clashes.
app.put('/api/admin/tenants/:id', adminOnly, (req, res) => {
  const u = get("SELECT * FROM users WHERE id=? AND role='tenant' AND company_id=? AND deleted_at IS NULL",
    req.params.id, req.companyId);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  const b = req.body || {};
  const email = b.email ? String(b.email).toLowerCase().trim() : u.email;
  if (email !== u.email && get('SELECT id FROM users WHERE email=?', email)) {
    return res.status(400).json({ error: 'That email is already in use' });
  }
  run('UPDATE users SET name=?, email=?, phone=? WHERE id=?',
    b.name || u.name, email, b.phone !== undefined ? addr.formatPhone(b.phone) : u.phone, u.id);
  res.json(get('SELECT id, name, email, phone FROM users WHERE id=?', u.id));
});

app.post('/api/admin/tenants/:id/reset-password', adminOnly, (req, res) => {
  const u = get("SELECT id FROM users WHERE id=? AND role='tenant' AND company_id=?", req.params.id, req.companyId);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  const temp = 'TB-' + crypto.randomInt(100000, 999999) + '!';
  run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', hashPassword(temp), u.id);
  res.json({ temp_password: temp });
});

// ---------- admin: archive, restore, delete users ----------
// Archiving is reversible and keeps every record — use it for a paid-off buyer or a
// staffer who left. Deleting erases personal data permanently and cannot be undone.
function companyUser(req, id, roles) {
  return get(`SELECT * FROM users WHERE id=? AND company_id=? AND deleted_at IS NULL
    AND role IN (${roles.map(() => '?').join(',')})`, id, req.companyId, ...roles);
}
app.post('/api/admin/tenants/:id/archive', adminOnly, (req, res) => {
  const u = companyUser(req, req.params.id, ['tenant']);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  if (u.archived_at) return res.status(400).json({ error: 'Already archived' });
  run("UPDATE users SET archived_at=datetime('now'), archived_reason=? WHERE id=?",
    req.body.reason || null, u.id);
  res.json({ ok: true });
});
app.post('/api/admin/tenants/:id/restore', adminOnly, (req, res) => {
  const u = companyUser(req, req.params.id, ['tenant']);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  run('UPDATE users SET archived_at=NULL, archived_reason=NULL WHERE id=?', u.id);
  res.json({ ok: true });
});
app.delete('/api/admin/tenants/:id', adminOnly, (req, res, next) => {
  const u = companyUser(req, req.params.id, ['tenant']);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  if (req.body && req.body.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm' });
  }
  try { eraseUser(u.id, 'tenant'); res.json({ ok: true }); } catch (e) { next(e); }
});
app.post('/api/admin/staff/:id/archive', ownerOnly, (req, res) => {
  const u = companyUser(req, req.params.id, ['admin']);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  run("UPDATE users SET archived_at=datetime('now'), archived_reason=? WHERE id=?",
    req.body.reason || null, u.id);
  res.json({ ok: true });
});
app.post('/api/admin/staff/:id/restore', ownerOnly, (req, res) => {
  const u = companyUser(req, req.params.id, ['admin']);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  run('UPDATE users SET archived_at=NULL, archived_reason=NULL WHERE id=?', u.id);
  res.json({ ok: true });
});

// ---------- admin: loans ----------
app.get('/api/admin/loans', adminOnly, (req, res) => {
  const loans = all('SELECT * FROM loans WHERE company_id=? ORDER BY id DESC', req.companyId);
  res.json(loans.map(l => {
    const f = loanFull(l);
    // City and email come along so the loans list can be searched by them.
    return { ...f.loan,
      address: f.property ? f.property.address : '',
      city: f.property ? f.property.city : null,
      tenant_name: f.tenant ? f.tenant.name : null,
      tenant_email: f.tenant ? f.tenant.email : null,
      status_info: f.status };
  }));
});
app.post('/api/admin/loans', adminOnly, (req, res) => {
  const b = req.body || {};
  const req_fields = ['property_id', 'sale_price_cents', 'principal_cents', 'interest_rate_bps', 'term_months', 'first_payment_date'];
  for (const f of req_fields) if (b[f] === undefined || b[f] === null || b[f] === '') return res.status(400).json({ error: `Missing ${f}` });
  if (!ownedProperty(req, b.property_id)) return res.status(404).json({ error: 'Property not found' });
  if (b.tenant_user_id && !get("SELECT id FROM users WHERE id=? AND role='tenant' AND company_id=?", b.tenant_user_id, req.companyId))
    return res.status(404).json({ error: 'Buyer not found' });
  const payment = b.payment_cents || loanEngine.calcPayment(b.principal_cents, b.interest_rate_bps, b.term_months);
  const r = run(`INSERT INTO loans (company_id, property_id, tenant_user_id, loan_type, sale_price_cents, down_payment_cents,
      principal_cents, interest_rate_bps, term_months, payment_cents, escrow_cents, late_fee_cents, grace_days,
      first_payment_date, due_day, principal_balance_cents, beneficial_interest_pct, escrow_structure)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.companyId, b.property_id, b.tenant_user_id || null, b.loan_type || 'land_contract', b.sale_price_cents,
    b.down_payment_cents || 0, b.principal_cents, b.interest_rate_bps, b.term_months, payment,
    b.escrow_cents || 0, b.late_fee_cents || 0, b.grace_days ?? 5, b.first_payment_date,
    b.due_day || Number(b.first_payment_date.slice(8, 10)), b.principal_cents, b.beneficial_interest_pct || null,
    b.escrow_structure === 'pit' ? 'pit' : 'piti');
  res.json(loanFull(get('SELECT * FROM loans WHERE id=?', r.lastInsertRowid)));
});

// Send (or re-send) the welcome guide by hand — for buyers who joined before the
// guide existed, or after the loan's PIT/PITI designation changes.
app.post('/api/admin/loans/:id/homebuyer-guide', adminOnly, (req, res, next) => {
  try {
    const loan = get('SELECT * FROM loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (!loan.tenant_user_id) return res.status(400).json({ error: 'No buyer is linked to this loan yet' });
    const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
    if (!noticeRules.isMichigan(property)) return res.status(400).json({ error: 'The welcome guide covers Michigan properties' });
    const r = sendHomebuyerGuide(loan.tenant_user_id, { force: true });
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});
app.get('/api/admin/loans/:id', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const f = loanFull(loan);
  f.schedule = loanEngine.amortizationSchedule(loan);
  f.schedule_yearly = loanEngine.yearlySchedule(f.schedule);
  f.payoff = loanEngine.payoffQuote(f.loan, today());
  f.documents = all('SELECT id, filename, kind, visible_to_tenant, created_at FROM documents WHERE loan_id=?', loan.id);
  res.json(f);
});
app.put('/api/admin/loans/:id', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  // Everything on the note can be corrected. Posted ledger entries are never rewritten —
  // changing terms affects how future payments are applied, not history.
  const allowed = ['tenant_user_id', 'status', 'escrow_cents', 'late_fee_cents', 'grace_days', 'escrow_structure',
    'loan_type', 'beneficial_interest_pct', 'payment_cents', 'sale_price_cents', 'down_payment_cents',
    'principal_cents', 'interest_rate_bps', 'term_months', 'first_payment_date', 'due_day',
    'principal_balance_cents', 'escrow_balance_cents', 'fees_due_cents',
    'monthly_taxes_cents', 'monthly_insurance_cents', 'monthly_utilities_cents',
    'monthly_servicing_cents', 'monthly_misc_cents', 'misc_label'];
  const b = req.body || {};
  if (b.escrow_structure !== undefined) b.escrow_structure = b.escrow_structure === 'pit' ? 'pit' : 'piti';
  const sets = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(b[k]); }

  // Escrow is taxes + insurance, so keep it in step when either changes.
  const taxes = b.monthly_taxes_cents ?? loan.monthly_taxes_cents ?? 0;
  const insurance = b.monthly_insurance_cents ?? loan.monthly_insurance_cents ?? 0;
  if (b.monthly_taxes_cents !== undefined || b.monthly_insurance_cents !== undefined) {
    sets.push('escrow_cents=?'); vals.push(taxes + insurance);
  }
  // Recompute P&I from the terms when asked.
  if (b.recalc_payment) {
    const principal = b.principal_cents ?? loan.principal_cents;
    const rate = b.interest_rate_bps ?? loan.interest_rate_bps;
    const term = b.term_months ?? loan.term_months;
    sets.push('payment_cents=?'); vals.push(loanEngine.calcPayment(principal, rate, term));
  }
  const first = b.first_payment_date ?? loan.first_payment_date;
  const term2 = b.term_months ?? loan.term_months;
  sets.push('final_payment_date=?'); vals.push(loanEngine.finalPaymentDate(first, term2));

  if (sets.length) run(`UPDATE loans SET ${sets.join(',')} WHERE id=?`, ...vals, loan.id);
  if (b.status === 'cancelled') unstampSoldIfNoLoans(loan.property_id);
  // A change to the tax or insurance figures changes the buyer's monthly payment —
  // that news arrives as a formal escrow update statement, not as a surprise on the
  // first of the month.
  try {
    const after = get('SELECT * FROM loans WHERE id=?', loan.id);
    const taxChanged = (after.monthly_taxes_cents || 0) !== (loan.monthly_taxes_cents || 0);
    const insChanged = (after.monthly_insurance_cents || 0) !== (loan.monthly_insurance_cents || 0);
    if ((taxChanged || insChanged) && after.tenant_user_id) escrowUpdateStatement(loan, after);
  } catch (e) { console.error('Escrow update statement:', e.message); }
  res.json(loanFull(get('SELECT * FROM loans WHERE id=?', loan.id)));
});

// The escrow update: old and new tax and insurance figures side by side, the new
// monthly total, and when it takes effect — filed into the buyer's documents and
// announced in the thread the moment the numbers change.
function escrowUpdateStatement(before, after) {
  const property = get('SELECT * FROM properties WHERE id=?', after.property_id);
  const co = get('SELECT * FROM companies WHERE id=?', after.company_id);
  const tenant = get('SELECT * FROM users WHERE id=?', after.tenant_user_id);
  if (!tenant) return;
  const money = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ledger = all('SELECT * FROM ledger WHERE loan_id=?', after.id);
  const status = loanEngine.loanStatus(after, ledger, today());
  const effective = status.next_due_date || 'your next payment';
  const oldTotal = (before.payment_cents || 0) + (before.escrow_cents || 0);
  const newTotal = (after.payment_cents || 0) + (after.escrow_cents || 0);
  const piti = (after.escrow_structure || 'piti') !== 'pit';

  const body =
`ESCROW UPDATE — TAXES AND INSURANCE
${property ? `${property.address}, ${property.city}, ${property.state} ${property.zip}` : ''}

Your escrow figures have been updated. Here is exactly what changed and what your payment is now.

WHAT CHANGED
Monthly taxes: ${money(before.monthly_taxes_cents)}  →  ${money(after.monthly_taxes_cents)}
Monthly insurance: ${money(before.monthly_insurance_cents)}  →  ${money(after.monthly_insurance_cents)}
Monthly escrow total: ${money(before.escrow_cents)}  →  ${money(after.escrow_cents)}

YOUR MONTHLY PAYMENT
Principal & interest (unchanged): ${money(after.payment_cents)}
Escrow (taxes${piti ? ' and insurance' : ''}): ${money(after.escrow_cents)}
NEW TOTAL MONTHLY PAYMENT: ${money(newTotal)}
Previous total: ${money(oldTotal)}

EFFECTIVE
The new amount applies beginning with the payment due ${effective}. If you are enrolled in autopay, the drafted amount updates automatically — nothing to do on your end.

Questions about how these figures were calculated? Message us in the app and we will walk you through the tax bill or insurance premium behind them.`;

  const buf = pdfDoc.letter({
    company: co, subject: 'Escrow Update — Taxes and Insurance', sentAt: today(),
    logo: companyLogo(co), bodyText: body,
  });
  const stored = crypto.randomUUID() + '.pdf';
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
    after.company_id, after.id, after.property_id, 'other', 'misc_shared',
    `Escrow update — new payment ${money(newTotal)} (${today()})`,
    `escrow-update-${after.id}-${today()}.pdf`, stored, 'application/pdf');

  const adminId = get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id LIMIT 1", after.company_id);
  if (adminId) {
    run(`INSERT INTO messages (loan_id, sender_user_id, body, subject, read_by_admin, channels)
         VALUES (?,?,?,?,1,'app')`, after.id, adminId.id,
      `Your escrow has been updated. Your new total monthly payment is ${money(newTotal)} ` +
      `(was ${money(oldTotal)}), effective with the payment due ${effective}. The full breakdown is in ` +
      `your Documents — Escrow update.`, 'Escrow update — your new payment amount');
  }
  notify.notify(tenant.id, {
    kind: 'notice', title: 'Your escrow was updated',
    body: `New total monthly payment: ${money(newTotal)}. The statement is in your documents.`,
    url: '/?tab=docs', dedupeKey: `escrow-update-${after.id}-${today()}`,
  }).catch(() => {});
  console.log(`Escrow update statement filed for loan ${after.id}: ${money(oldTotal)} -> ${money(newTotal)}`);
}
// Selling stamps the property 'sold'. When the loan that made it sold goes away —
// deleted, purged, cancelled — and no live loan remains, the stamp has to come off,
// or the dashboard keeps counting a sale that no longer exists.
function unstampSoldIfNoLoans(propertyId) {
  run(`UPDATE properties SET status='owned', phase='ready', phase_updated_at=datetime('now')
       WHERE id=? AND status='sold'
         AND NOT EXISTS (SELECT 1 FROM loans WHERE property_id=? AND status IN ('active','paid_off','default'))`,
    propertyId, propertyId);
}
// Self-heal on boot: any property already stranded as 'sold' with nothing behind the
// claim goes back to owned. Idempotent; fixes rows the old behavior left wrong.
try {
  const healed = all(`SELECT id FROM properties WHERE status='sold'
    AND NOT EXISTS (SELECT 1 FROM loans WHERE loans.property_id=properties.id AND loans.status IN ('active','paid_off','default'))`);
  for (const hp of healed) { unstampSoldIfNoLoans(hp.id); console.log(`Property ${hp.id}: cleared a 'sold' stamp with no loan behind it`); }
} catch (e) { console.error('Sold-stamp heal:', e.message); }

// Deleting a loan comes in two strengths. A loan with no history deletes with a typed
// DELETE — that is a typo being corrected. A loan WITH history — payments, journal
// entries, notices — can also be removed (test data happens, wrong buyer happens), but
// that is destroying records, so it asks more: owner only, a stronger confirmation,
// and a full JSON backup of everything filed on the property before anything goes.
app.delete('/api/admin/loans/:id', adminOnly, (req, res, next) => {
  try {
    const loan = ownedLoan(req, req.params.id);
    if (!loan) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const t = loanTies(loan.id);
    const hasHistory = !!(t.ledger || t.journal_entries || t.notices);

    // Every table that references loans(id). Foreign keys are enforced, so any child
    // row left behind turns the delete into "FOREIGN KEY constraint failed" — an error
    // that names nothing. One list, used by both delete paths, so a new table with a
    // loan_id gets added HERE or the delete breaks loudly in tests.
    const LOAN_CHILDREN = ['journal-special', 'ledger', 'notices', 'charges', 'messages',
      'escrow_items', 'escrow_analyses', 'escrow_disbursements', 'payoff_quotes',
      'cash_slips', 'invitations', 'autopay', 'email_log', 'tasks', 'notes'];
    const clearChildren = () => {
      run('DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE loan_id=?)', loan.id);
      run('DELETE FROM journal_entries WHERE loan_id=?', loan.id);
      for (const tbl of LOAN_CHILDREN.slice(1)) run(`DELETE FROM ${tbl} WHERE loan_id=?`, loan.id);
      // Documents uploaded to the loan: the purge removes them (they are in the backup);
      // the light delete keeps the files but re-files them on the property.
    };

    if (!hasHistory) {
      if (b.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
      clearChildren();
      run('UPDATE documents SET loan_id=NULL, property_id=COALESCE(property_id, ?) WHERE loan_id=?', loan.property_id, loan.id);
      run('DELETE FROM loans WHERE id=?', loan.id);
      unstampSoldIfNoLoans(loan.property_id);
      return res.json({ ok: true });
    }

    // History exists. Without the purge flag, describe what is here and how to proceed —
    // the same refusal as before, now with the door named.
    if (!b.purge) {
      const why = [
        t.payments ? `${t.payments} payment${t.payments === 1 ? '' : 's'}` : null,
        t.ledger - t.payments > 0 ? `${t.ledger - t.payments} other ledger entr${t.ledger - t.payments === 1 ? 'y' : 'ies'}` : null,
        t.journal_entries ? `${t.journal_entries} journal entr${t.journal_entries === 1 ? 'y' : 'ies'}` : null,
        t.notices ? `${t.notices} notice${t.notices === 1 ? '' : 's'} sent` : null,
      ].filter(Boolean).join(', ');
      return res.status(400).json({
        error: `This loan has ${why} against it. Cancelling it keeps the record; deleting it destroys ` +
               `the record. To delete anyway, the owner can purge it — everything is backed up to a ` +
               `file on the property first.`,
        ties: t, purgeable: true,
      });
    }
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can purge a loan with history' });
    if (b.confirm !== 'DELETE EVERYTHING') return res.status(400).json({ error: 'Type DELETE EVERYTHING to confirm' });

    // The backup first: every row this purge is about to remove, in one JSON file,
    // filed on the property where the loan lived. If the purge turns out to be a
    // mistake, the numbers still exist somewhere a human can read them.
    const backup = {
      purged_at: new Date().toISOString(), purged_by: req.user.email,
      loan,
      ledger: all('SELECT * FROM ledger WHERE loan_id=?', loan.id),
      notices: all('SELECT * FROM notices WHERE loan_id=?', loan.id),
      charges: all('SELECT * FROM charges WHERE loan_id=?', loan.id),
      escrow_items: all('SELECT * FROM escrow_items WHERE loan_id=?', loan.id),
      payoff_quotes: all('SELECT * FROM payoff_quotes WHERE loan_id=?', loan.id),
      messages: all('SELECT * FROM messages WHERE loan_id=?', loan.id),
      escrow_analyses: all('SELECT * FROM escrow_analyses WHERE loan_id=?', loan.id),
      escrow_disbursements: all('SELECT * FROM escrow_disbursements WHERE loan_id=?', loan.id),
      cash_slips: all('SELECT * FROM cash_slips WHERE loan_id=?', loan.id),
      autopay: all('SELECT * FROM autopay WHERE loan_id=?', loan.id),
      tasks: all('SELECT * FROM tasks WHERE loan_id=?', loan.id),
      notes: all('SELECT * FROM notes WHERE loan_id=?', loan.id),
      email_log: all('SELECT * FROM email_log WHERE loan_id=?', loan.id),
      journal_entries: all('SELECT * FROM journal_entries WHERE loan_id=?', loan.id),
      journal_lines: all('SELECT * FROM journal_lines WHERE loan_id=? OR entry_id IN (SELECT id FROM journal_entries WHERE loan_id=?)', loan.id, loan.id),
      documents: all('SELECT id, filename, category, title, created_at FROM documents WHERE loan_id=?', loan.id),
    };
    const stored = crypto.randomUUID() + '.json';
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), JSON.stringify(backup, null, 2));
    run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
         VALUES (?,?,?,?,?,?,?,?,?,0)`,
      loan.company_id, null, loan.property_id, 'other', 'private',
      `Backup — purged loan #${loan.id} (${new Date().toISOString().slice(0, 10)})`,
      `purged-loan-${loan.id}.json`, stored, 'application/json');

    // Now the removal, children before parent. Journal lines go with their entries so
    // the books stay balanced — both sides of every entry leave together.
    clearChildren();
    for (const d of all('SELECT * FROM documents WHERE loan_id=?', loan.id)) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch {}
      run('DELETE FROM documents WHERE id=?', d.id);
    }
    run('DELETE FROM loans WHERE id=?', loan.id);
    unstampSoldIfNoLoans(loan.property_id);
    res.json({ ok: true, purged: true, backup: `Backup filed on the property's documents` });
  } catch (e) { next(e); }
});

app.post('/api/admin/loans/:id/payments', adminOnly, (req, res) => {
  const { amount_cents, method, entry_date, memo } = req.body || {};
  if (!ownedLoan(req, req.params.id)) return res.status(404).json({ error: 'Loan not found' });
  if (!amount_cents || amount_cents <= 0) return res.status(400).json({ error: 'Amount required' });
  const m = method || 'cash';
  // The method is free text in the database, so it is checked here instead. A typo
  // saved once would show as an unlabelled "Payment" on that row for ever.
  if (!MANUAL_METHODS[m]) {
    return res.status(400).json({ error: `Not a payment method we recognise: ${m}` });
  }
  const result = postPayment(Number(req.params.id), amount_cents, m, entry_date || today(), null, memo, req.user.id);
  res.json(result);
});
app.post('/api/admin/loans/:id/latefee', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const amt = req.body.amount_cents || loan.late_fee_cents;
  if (!amt) return res.status(400).json({ error: 'No late fee configured' });
  run('INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo, created_by) VALUES (?,?,?,?,?,?)',
    loan.id, today(), 'late_fee', -amt, req.body.memo || 'Late fee', req.user.id);
  run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', amt, loan.id);
  res.json({ ok: true });
});
app.post('/api/admin/loans/:id/charges', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const { description, amount_cents, recurring, start_date, end_date, category } = req.body || {};
  if (!description || !amount_cents) return res.status(400).json({ error: 'Description and amount required' });
  const r = run('INSERT INTO charges (loan_id, description, category, amount_cents, recurring, start_date, end_date) VALUES (?,?,?,?,?,?,?)',
    loan.id, description, category || 'other', amount_cents, recurring ? 1 : 0, start_date || today(), end_date || null);
  if (!recurring) {
    run('INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo, created_by) VALUES (?,?,?,?,?,?)',
      loan.id, today(), 'fee', -amount_cents, description, req.user.id);
    run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', amount_cents, loan.id);
  }
  res.json(get('SELECT * FROM charges WHERE id=?', r.lastInsertRowid));
});
app.delete('/api/admin/charges/:id', adminOnly, (req, res) => {
  const ch = get(`SELECT c.id FROM charges c JOIN loans l ON l.id=c.loan_id WHERE c.id=? AND l.company_id=?`, req.params.id, req.companyId);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  run('UPDATE charges SET active=0 WHERE id=?', ch.id);
  res.json({ ok: true });
});

// ---------- admin: documents & AI ----------
// Shared folders both the admin and the tenant buyer can see, plus the admin-only vault.
// Folders the buyer can see once the house is theirs.
const SHARED_CATEGORIES = ['loan_docs', 'closing_receipts', 'insurance', 'taxes', 'utilities', 'correspondence', 'misc_shared'];
// Folders only you see — the paperwork from your side of the deal. Trust documents
// live here: the trust agreement is the ownership structure, not the buyer's file.
const ADMIN_CATEGORIES = ['trust_docs', 'acquisition', 'pml_docs', 'sale_closing', 'misc_admin', 'private'];
const CATEGORY_LABELS = {
  acquisition: 'Acquisition closing docs', pml_docs: 'Private money loan docs',
  sale_closing: 'Sale closing docs', loan_docs: 'Loan Documents',
  trust_docs: 'Trust documents', closing_receipts: 'Closing receipts', insurance: 'Insurance',
  taxes: 'Taxes', utilities: 'Utilities', correspondence: 'Correspondence',
  misc_shared: 'Misc — shared with buyer', misc_admin: 'Misc — admin only',
  private: 'Private (admin only)', statement: 'Statements',
  unsorted: 'Unsorted — just uploaded', other: 'Other',
};

// Property lifecycle. Selling to a buyer moves it to 'sold' automatically.
const OWNER_TYPES = {
  individual: 'Individual', llc: 'LLC', land_trust: 'Land Trust',
  corporation: 'Corporation', partnership: 'Partnership', other: 'Other',
};
const PHASES = ['acquired', 'rehab', 'ready', 'listed', 'sold', 'paid_off'];
const PHASE_LABELS = {
  acquired: 'Acquired', rehab: 'In rehab', ready: 'Ready to sell',
  listed: 'Listed', sold: 'Sold — servicing', paid_off: 'Paid off',
};

app.post('/api/admin/documents', adminOnly, (req, res) => {
  const { filename, mime, data_base64, kind, loan_id, property_id, visible_to_tenant, category, title, effective_date } = req.body || {};
  if (!filename || !data_base64) return res.status(400).json({ error: 'File required' });
  if (loan_id && !ownedLoan(req, loan_id)) return res.status(404).json({ error: 'Loan not found' });
  if (property_id && !ownedProperty(req, property_id)) return res.status(404).json({ error: 'Property not found' });
  const cat = category || 'other';
  // Anything filed as "private" is admin-only regardless of the flag sent, and nothing
  // in the unsorted tray is shown to a buyer — sharing is a decision made per document
  // when it is filed, not a side effect of a batch upload.
  const shared = !ADMIN_CATEGORIES.includes(cat) && cat !== 'statement' && cat !== 'unsorted' && visible_to_tenant ? 1 : 0;
  const stored = crypto.randomUUID() + path.extname(filename);
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), Buffer.from(data_base64, 'base64'));
  const r = run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, effective_date,
      filename, stored_name, mime, visible_to_tenant, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, req.companyId, loan_id || null, property_id || null, kind || 'closing', cat,
    title || null, effective_date || null, filename, stored, mime || null, shared, req.user.id);
  if (shared && loan_id) {
    const ln = get('SELECT tenant_user_id FROM loans WHERE id=?', loan_id);
    if (ln && ln.tenant_user_id) {
      notify.notify(ln.tenant_user_id, {
        kind: 'document', title: 'A new document was shared with you',
        body: title || filename, url: '/?tab=docs',
      }).catch(() => {});
    }
  }
  res.json(get('SELECT id, filename, kind, category, title, visible_to_tenant, created_at FROM documents WHERE id=?', r.lastInsertRowid));
});

// Admin document center for a loan: every shared folder plus the private vault.
app.get('/api/admin/loans/:id/documents', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const docs = all(`SELECT id, filename, kind, category, title, effective_date, mime, visible_to_tenant, created_at
    FROM documents WHERE loan_id=? OR (property_id IS NOT NULL AND property_id=?)
    ORDER BY COALESCE(effective_date, created_at) DESC, id DESC`, loan.id, loan.property_id);
  const folders = {};
  // The unsorted tray comes first so a batch upload is the first thing on the screen,
  // asking to be filed. Documents group by their folder regardless of sharing — an
  // unshared insurance policy is still an insurance policy — and each carries its own
  // visible_to_tenant flag, which the UI shows as a per-document share toggle.
  for (const c of ['unsorted', ...SHARED_CATEGORIES, ...ADMIN_CATEGORIES]) {
    folders[c] = { label: CATEGORY_LABELS[c], shared: SHARED_CATEGORIES.includes(c), documents: [] };
  }
  for (const d of docs) {
    const key = folders[d.category] ? d.category
      : d.visible_to_tenant ? 'loan_docs' : 'private';   // legacy 'other'/'statement' rows
    folders[key].documents.push(d);
  }
  if (!folders.unsorted.documents.length) delete folders.unsorted;
  res.json(folders);
});

// Same shape for a property, so the documents page can stand on its own instead of
// being carved out of the property payload.
app.get('/api/admin/properties/:id/documents', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const docs = all(`SELECT id, filename, kind, category, title, effective_date, mime, visible_to_tenant, created_at
    FROM documents WHERE property_id=? OR loan_id IN (SELECT id FROM loans WHERE property_id=?)
    ORDER BY COALESCE(effective_date, created_at) DESC, id DESC`, p.id, p.id);
  const folders = {};
  for (const c of ['unsorted', ...ADMIN_CATEGORIES, ...SHARED_CATEGORIES]) {
    folders[c] = { label: CATEGORY_LABELS[c], shared: SHARED_CATEGORIES.includes(c), documents: [] };
  }
  for (const d of docs) (folders[d.category] || folders.private).documents.push(d);
  if (!folders.unsorted.documents.length) delete folders.unsorted;
  res.json(folders);
});

app.put('/api/admin/documents/:id', adminOnly, (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const category = req.body.category !== undefined ? req.body.category : doc.category;
  const vis = req.body.visible_to_tenant !== undefined ? (req.body.visible_to_tenant ? 1 : 0) : doc.visible_to_tenant;
  const shared = (ADMIN_CATEGORIES.includes(category) || category === 'unsorted') ? 0 : vis;
  run('UPDATE documents SET category=?, visible_to_tenant=?, title=?, effective_date=? WHERE id=?',
    category, shared, req.body.title !== undefined ? req.body.title : doc.title,
    req.body.effective_date !== undefined ? req.body.effective_date : doc.effective_date, doc.id);
  res.json(get('SELECT id, filename, category, title, visible_to_tenant FROM documents WHERE id=?', doc.id));
});

app.delete('/api/admin/documents/:id', adminOnly, (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, doc.stored_name)); } catch {}
  run('DELETE FROM documents WHERE id=?', doc.id);
  res.json({ ok: true });
});

// Tenant buyer document center — shared folders only, always present as placeholders.
app.get('/api/tenant/documents', tenantReady, (req, res) => {
  const loan = get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
  const folders = SHARED_CATEGORIES.map(c => ({ category: c, label: CATEGORY_LABELS[c], documents: [] }));
  if (!loan) return res.json(folders);
  const docs = all(`SELECT id, filename, category, title, effective_date, created_at FROM documents
    WHERE visible_to_tenant=1 AND (loan_id=? OR (property_id IS NOT NULL AND property_id=?))
    ORDER BY COALESCE(effective_date, created_at) DESC, id DESC`, loan.id, loan.property_id);
  for (const d of docs) {
    const f = folders.find(x => x.category === d.category) || folders[0];
    f.documents.push(d);
  }
  res.json(folders);
});
// One authorization for both ways of getting at a file. An admin sees everything in
// their company; a buyer sees only documents on their own loan that were shared.
function authorizedDoc(req, res) {
  const doc = get('SELECT * FROM documents WHERE id=?', req.params.id);
  if (!doc) { res.status(404).json({ error: 'Not found' }); return null; }
  if (doc.company_id !== req.user.company_id) { res.status(403).json({ error: 'Forbidden' }); return null; }
  if (req.user.role === 'tenant') {
    const loan = get('SELECT * FROM loans WHERE id=? AND tenant_user_id=?', doc.loan_id, req.user.id);
    if (!loan || !doc.visible_to_tenant) { res.status(403).json({ error: 'Forbidden' }); return null; }
  }
  return doc;
}
app.get('/api/documents/:id/download', anyUser, (req, res) => {
  const doc = authorizedDoc(req, res);
  if (!doc) return;
  res.setHeader('Content-Disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
  if (doc.mime) res.setHeader('Content-Type', doc.mime);
  res.send(fs.readFileSync(path.join(UPLOAD_DIR, doc.stored_name)));
});
// The same file, shown rather than saved. `inline` lets the browser render PDFs and
// images in place; nosniff stops it guessing its way into treating an upload as HTML,
// which is what would turn a hostile upload into script running on this origin.
app.get('/api/documents/:id/view', anyUser, (req, res) => {
  const doc = authorizedDoc(req, res);
  if (!doc) return;
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const safe = /^(application\/pdf|image\/|text\/plain)/.test(doc.mime || '');
  res.setHeader('Content-Type', safe ? doc.mime : 'application/octet-stream');
  res.send(fs.readFileSync(path.join(UPLOAD_DIR, doc.stored_name)));
});
// AI: extract loan terms from one or more closing docs
app.post('/api/admin/ai/extract-loan', adminOnly, async (req, res) => {
  if (!ai.aiEnabled()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY on the server.' });
  const ids = req.body.document_ids || [];
  if (!ids.length) return res.status(400).json({ error: 'document_ids required' });
  try {
    const files = ids.map(id => {
      const doc = get('SELECT * FROM documents WHERE id=? AND company_id=?', id, req.companyId);
      if (!doc) throw new Error('Document not found');
      return { buffer: fs.readFileSync(path.join(UPLOAD_DIR, doc.stored_name)), mime: doc.mime || 'application/pdf', filename: doc.filename };
    });
    const extracted = await ai.extractLoanTerms(files);
    run('UPDATE documents SET extracted_json=? WHERE id=?', JSON.stringify(extracted), ids[0]);
    res.json(extracted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// AI: extract transactions from a bank/CC statement -> expenses for review
app.post('/api/admin/ai/extract-transactions', adminOnly, async (req, res) => {
  if (!ai.aiEnabled()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY on the server.' });
  const doc = get('SELECT * FROM documents WHERE id=? AND company_id=?', req.body.document_id, req.companyId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  try {
    const props = all('SELECT id, address, city FROM properties WHERE company_id=?', req.companyId);
    const file = { buffer: fs.readFileSync(path.join(UPLOAD_DIR, doc.stored_name)), mime: doc.mime || 'application/pdf', filename: doc.filename };
    const out = await ai.extractTransactions(file, props);
    let count = 0;
    for (const t of out.transactions || []) {
      const sugg = t.suggested_property_id && ownedProperty(req, t.suggested_property_id) ? t.suggested_property_id : null;
      run(`INSERT INTO expenses (company_id, property_id, document_id, txn_date, description, amount_cents, category, status)
           VALUES (?,?,?,?,?,?,?,?)`,
        req.companyId, sugg, doc.id, t.date || null, t.description || '(no description)',
        Math.round((t.amount || 0) * 100), t.category || null, 'unassigned');
      count++;
    }
    res.json({ imported: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- admin: expenses ----------
app.get('/api/admin/expenses', adminOnly, (req, res) => {
  const status = req.query.status;
  const rows = status
    ? all(`SELECT e.*, p.address FROM expenses e LEFT JOIN properties p ON p.id=e.property_id
           WHERE e.status=? AND e.company_id=? ORDER BY e.txn_date DESC, e.id DESC`, status, req.companyId)
    : all(`SELECT e.*, p.address FROM expenses e LEFT JOIN properties p ON p.id=e.property_id
           WHERE e.company_id=? ORDER BY e.txn_date DESC, e.id DESC`, req.companyId);
  res.json(rows);
});
app.post('/api/admin/expenses', adminOnly, (req, res) => {
  const { property_id, txn_date, description, amount_cents, category } = req.body || {};
  if (!description || !amount_cents) return res.status(400).json({ error: 'Description and amount required' });
  if (property_id && !ownedProperty(req, property_id)) return res.status(404).json({ error: 'Property not found' });
  const r = run('INSERT INTO expenses (company_id, property_id, txn_date, description, amount_cents, category, status) VALUES (?,?,?,?,?,?,?)',
    req.companyId, property_id || null, txn_date || today(), description, amount_cents, category || null, property_id ? 'assigned' : 'unassigned');
  res.json(get('SELECT * FROM expenses WHERE id=?', r.lastInsertRowid));
});
app.put('/api/admin/expenses/:id', adminOnly, (req, res) => {
  const e = get('SELECT * FROM expenses WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const property_id = req.body.property_id !== undefined ? req.body.property_id : e.property_id;
  if (property_id && !ownedProperty(req, property_id)) return res.status(404).json({ error: 'Property not found' });
  const status = req.body.status || (property_id ? 'assigned' : e.status);
  run('UPDATE expenses SET property_id=?, status=?, category=? WHERE id=?',
    property_id, status, req.body.category !== undefined ? req.body.category : e.category, e.id);
  res.json(get('SELECT * FROM expenses WHERE id=?', e.id));
});

// ---------- message templates ----------
// Everything a template needs to render for a given loan: company, buyer, balances.
function mergeContextForLoan(req, loanId) {
  const loan = loanId ? get('SELECT * FROM loans WHERE id=?', loanId) : null;
  const company = get('SELECT * FROM companies WHERE id=?', req.companyId);
  const property = loan ? get('SELECT * FROM properties WHERE id=?', loan.property_id) : null;
  const buyer = loan && loan.tenant_user_id ? get('SELECT * FROM users WHERE id=?', loan.tenant_user_id) : null;
  let status = null, payoff = null;
  if (loan) {
    const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
    status = loanEngine.loanStatus(loan, ledger, today());
    payoff = loanEngine.payoffQuote(loan, today());
  }
  return { company, buyer, loan, property, status, payoff, baseUrl: baseUrlOf(req) };
}

app.get('/api/admin/templates', adminOnly, (req, res) => {
  tpl.seedTemplates(req.companyId);
  res.json({
    merge_fields: tpl.MERGE_FIELDS,
    templates: all(`SELECT * FROM message_templates WHERE company_id=? AND archived=0
      ORDER BY is_starter DESC, name`, req.companyId),
  });
});
app.post('/api/admin/templates', adminOnly, (req, res) => {
  const { name, subject, body_html, category } = req.body || {};
  if (!name || !body_html) return res.status(400).json({ error: 'Name and message body are required' });
  const r = run(`INSERT INTO message_templates (company_id, name, category, subject, body_html)
    VALUES (?,?,?,?,?)`, req.companyId, name, category || 'general', subject || null,
    tpl.sanitizeHtml(body_html));
  res.json(get('SELECT * FROM message_templates WHERE id=?', r.lastInsertRowid));
});
app.put('/api/admin/templates/:id', adminOnly, (req, res) => {
  const t = get('SELECT * FROM message_templates WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  run(`UPDATE message_templates SET name=?, category=?, subject=?, body_html=? WHERE id=?`,
    b.name || t.name, b.category || t.category, b.subject ?? t.subject,
    b.body_html ? tpl.sanitizeHtml(b.body_html) : t.body_html, t.id);
  res.json(get('SELECT * FROM message_templates WHERE id=?', t.id));
});
app.delete('/api/admin/templates/:id', adminOnly, (req, res) => {
  const t = get('SELECT * FROM message_templates WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!t) return res.status(404).json({ error: 'Not found' });
  run('UPDATE message_templates SET archived=1 WHERE id=?', t.id);
  res.json({ ok: true });
});
// Preview a template with real values merged in, in the branded shell.
app.post('/api/admin/templates/preview', adminOnly, (req, res) => {
  const ctx = mergeContextForLoan(req, req.body.loan_id || null);
  const values = tpl.buildMergeValues(ctx);
  const bodyRaw = req.body.body_html || '';
  const subject = tpl.applyMerge(req.body.subject || '', values);
  const merged = tpl.applyMerge(tpl.sanitizeHtml(bodyRaw), values);
  res.json({
    subject,
    html: tpl.brandedShell({ company: ctx.company, bodyHtml: merged, subject, baseUrl: ctx.baseUrl }),
    text: tpl.htmlToText(merged),
    values,
  });
});

// ---------- messages (shared) ----------
app.get('/api/admin/messages', adminOnly, (req, res) => {
  const threads = all(`
    SELECT l.id AS loan_id, p.address, u.name AS tenant_name,
      (SELECT body FROM messages WHERE loan_id=l.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE loan_id=l.id ORDER BY id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages WHERE loan_id=l.id AND read_by_admin=0) AS unread
    FROM loans l LEFT JOIN properties p ON p.id=l.property_id LEFT JOIN users u ON u.id=l.tenant_user_id
    WHERE l.tenant_user_id IS NOT NULL AND l.company_id=? ORDER BY last_at DESC`, req.companyId);
  res.json(threads);
});
app.get('/api/admin/loans/:id/messages', adminOnly, (req, res) => {
  if (!ownedLoan(req, req.params.id)) return res.status(404).json({ error: 'Loan not found' });
  run('UPDATE messages SET read_by_admin=1 WHERE loan_id=?', req.params.id);
  res.json(all('SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m JOIN users u ON u.id=m.sender_user_id WHERE m.loan_id=? ORDER BY m.id', req.params.id));
});
app.post('/api/admin/loans/:id/messages', adminOnly, async (req, res, next) => {
  try {
    const loan = ownedLoan(req, req.params.id);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const b = req.body || {};
    if (!b.body && !b.body_html) return res.status(400).json({ error: 'Message required' });

    const co = myCompany(req);
    const ctx = mergeContextForLoan(req, loan.id);
    const values = tpl.buildMergeValues(ctx);
    const buyer = loan.tenant_user_id
      ? get('SELECT id, name, email, phone FROM users WHERE id=?', loan.tenant_user_id) : null;

    // The in-app copy is always written — it is the one delivery that cannot fail.
    // Text and email are extra ways to reach the same message.
    const wanted = Array.isArray(b.channels) && b.channels.length ? b.channels : ['app'];
    const channels = ['app', ...wanted.filter(c => c === 'sms' || c === 'email')];

    let subject = null, merged = null, storedHtml = null, plain;
    if (b.body_html) {
      subject = tpl.applyMerge(b.subject || '', values);
      merged = tpl.applyMerge(tpl.sanitizeHtml(b.body_html), values);
      storedHtml = tpl.brandedShell({ company: ctx.company, bodyHtml: merged, subject, baseUrl: ctx.baseUrl });
      plain = tpl.htmlToText(merged);
    } else {
      subject = b.subject ? tpl.applyMerge(b.subject, values) : null;
      plain = tpl.applyMerge(b.body, values);
    }

    const ins = run(`INSERT INTO messages (loan_id, sender_user_id, body, body_html, subject,
      template_id, read_by_admin, channels) VALUES (?,?,?,?,?,?,1,?)`,
      loan.id, req.user.id, plain, storedHtml, subject || null,
      b.template_id || null, channels.join(','));
    const messageId = ins.lastInsertRowid;

    const delivery = { app: { ok: true } };

    if (channels.includes('email')) {
      if (!buyer || !buyer.email) delivery.email = { ok: false, error: 'No email address on file for this buyer' };
      else if (!email.emailEnabled(co)) delivery.email = { ok: false, error: 'Email is not connected — see Settings → Email' };
      else {
        // The company's own letterhead, built for mail clients rather than the app.
        const html = tpl.emailShell({
          company: ctx.company, subject: subject || `A message from ${tpl.outboundName(co)}`,
          bodyHtml: merged || plain.split('\n\n').map(p => `<p>${tpl.escapeHtml(p)}</p>`).join(''),
          baseUrl: ctx.baseUrl, preheader: plain.slice(0, 120),
        });
        try {
          const r = await email.sendEmail(buyer.email, {
            subject: subject || `A message from ${tpl.outboundName(co)}`,
            text: plain, html, kind: 'message', loanId: loan.id, companyId: req.companyId,
          }, co);
          delivery.email = { ok: true, to: r.to, from: r.from };
        } catch (e) { delivery.email = { ok: false, error: e.message }; }
      }
    }

    if (channels.includes('sms')) {
      if (!buyer || !buyer.phone) delivery.sms = { ok: false, error: 'No mobile number on file for this buyer' };
      else if (!sms.smsEnabled(co)) delivery.sms = { ok: false, error: 'Texting is not connected — see Settings → Texting' };
      else {
        // A text is a nudge, not the message. Long HTML would arrive as a wall of
        // fragments, so it points back at the app where the whole thing lives.
        const short = plain.length > 300
          ? `${subject ? subject + '\n\n' : ''}${plain.slice(0, 240).trim()}…\n\nRead it in full: ${ctx.baseUrl || ''}/`
          : `${subject ? subject + '\n\n' : ''}${plain}`;
        try {
          await sms.sendSms(buyer.phone, short, co);
          delivery.sms = { ok: true, to: buyer.phone };
        } catch (e) { delivery.sms = { ok: false, error: e.message }; }
      }
    }

    run('UPDATE messages SET delivery_json=? WHERE id=?', JSON.stringify(delivery), messageId);

    if (loan.tenant_user_id) {
      notify.notify(loan.tenant_user_id, {
        kind: 'message', title: `New message from ${co ? tpl.outboundName(co) : 'your servicer'}`,
        body: subject || plain.slice(0, 120), url: '/?tab=msgs',
      }).catch(() => {});
    }

    // Report what actually happened per channel rather than a blanket ok.
    const failures = Object.entries(delivery).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.error}`);
    res.json({ ok: true, message_id: messageId, delivery, failures });
  } catch (e) { next(e); }
});

// ---------- PML loans (admin only — never exposed to tenant routes) ----------
app.get('/api/admin/pml', adminOnly, (req, res) => {
  const rows = all(`SELECT pl.*, p.address FROM pml_loans pl LEFT JOIN properties p ON p.id=pl.property_id
    WHERE pl.company_id=? ORDER BY pl.id DESC`, req.companyId);
  for (const r of rows) {
    const tb = get("SELECT payment_cents, escrow_cents FROM loans WHERE property_id=? AND status='active' AND company_id=? ORDER BY id DESC LIMIT 1", r.property_id, req.companyId);
    r.tb_payment_cents = tb ? tb.payment_cents + tb.escrow_cents : 0;
    r.monthly_spread_cents = r.tb_payment_cents - r.payment_cents;
    r.next_due_date = loanEngine.nextDueDate(r, today());
  }
  res.json(rows);
});
app.post('/api/admin/pml', adminOnly, (req, res) => {
  const b = req.body || {};
  for (const f of ['property_id', 'lender_name', 'principal_cents', 'interest_rate_bps', 'term_months', 'first_payment_date'])
    if (!b[f]) return res.status(400).json({ error: `Missing ${f}` });
  const type = b.payment_type || 'amortized';
  let payment = b.payment_cents;
  if (!payment) {
    payment = type === 'interest_only'
      ? Math.round(b.principal_cents * (b.interest_rate_bps / 10000) / 12)
      : loanEngine.calcPayment(b.principal_cents, b.interest_rate_bps, b.term_months);
  }
  if (!ownedProperty(req, b.property_id)) return res.status(404).json({ error: 'Property not found' });
  const r = run(`INSERT INTO pml_loans (company_id, property_id, lender_name, lender_contact, lender_phone, lender_email, lien_position, principal_cents,
      interest_rate_bps, term_months, payment_type, payment_cents, balloon_date, first_payment_date,
      principal_balance_cents, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.companyId, b.property_id, b.lender_name, b.lender_contact || null,
    b.lender_phone ? addr.formatPhone(b.lender_phone) : null, b.lender_email || null,
    b.lien_position || 1, b.principal_cents,
    b.interest_rate_bps, b.term_months, type, payment, b.balloon_date || null, b.first_payment_date,
    b.principal_cents, b.notes || null);
  res.json(get('SELECT * FROM pml_loans WHERE id=?', r.lastInsertRowid));
});
app.get('/api/admin/pml/:id', adminOnly, (req, res) => {
  const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!pml) return res.status(404).json({ error: 'Not found' });
  const property = get('SELECT * FROM properties WHERE id=?', pml.property_id);
  const ledger = all('SELECT * FROM pml_ledger WHERE pml_loan_id=? ORDER BY entry_date, id', pml.id);
  const tb = get("SELECT * FROM loans WHERE property_id=? AND status='active' AND company_id=? ORDER BY id DESC LIMIT 1", pml.property_id, req.companyId);
  const schedule = pml.payment_type === 'amortized' ? loanEngine.amortizationSchedule({
    first_payment_date: pml.first_payment_date, principal_cents: pml.principal_cents,
    interest_rate_bps: pml.interest_rate_bps, term_months: pml.term_months, payment_cents: pml.payment_cents,
  }) : [];
  res.json({
    pml, property, ledger, schedule,
    schedule_yearly: schedule.length ? loanEngine.yearlySchedule(schedule) : [],
    payoff: loanEngine.payoffQuote({ ...pml, fees_due_cents: 0, escrow_balance_cents: 0 }, today()),
    next_due_date: loanEngine.nextDueDate(pml, today()),
    tb_loan: tb ? { id: tb.id, payment_cents: tb.payment_cents + tb.escrow_cents, balance_cents: tb.principal_balance_cents } : null,
    monthly_spread_cents: (tb ? tb.payment_cents + tb.escrow_cents : 0) - pml.payment_cents,
    equity_spread_cents: (tb ? tb.principal_balance_cents : 0) - pml.principal_balance_cents,
  });
});
// What a loan has against it. Deleting one with money behind it would leave journal
// entries and payments pointing at a row that no longer exists, so the answer is to
// mark it paid off or cancelled instead — the history stays, the loan stops being live.
function loanTies(id) {
  const c = (sql, ...a) => get(sql, ...a).c;
  return {
    payments: c("SELECT COUNT(*) c FROM ledger WHERE loan_id=? AND type='payment'", id),
    ledger: c('SELECT COUNT(*) c FROM ledger WHERE loan_id=?', id),
    journal_entries: c('SELECT COUNT(*) c FROM journal_entries WHERE loan_id=?', id),
    notices: c('SELECT COUNT(*) c FROM notices WHERE loan_id=?', id),
  };
}
function pmlTies(id) {
  const c = (sql, ...a) => get(sql, ...a).c;
  return {
    ledger: c('SELECT COUNT(*) c FROM pml_ledger WHERE pml_loan_id=?', id),
    journal_entries: c('SELECT COUNT(*) c FROM journal_entries WHERE pml_loan_id=?', id),
  };
}

app.put('/api/admin/pml/:id', adminOnly, (req, res, next) => {
  try {
    const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
    if (!pml) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const num = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : Number(v));

    const principal = num(b.principal_cents, pml.principal_cents);
    const rate = num(b.interest_rate_bps, pml.interest_rate_bps);
    const term = num(b.term_months, pml.term_months);
    const type = b.payment_type || pml.payment_type;
    if (!(principal > 0)) return res.status(400).json({ error: 'Principal must be more than zero' });
    if (!(term > 0)) return res.status(400).json({ error: 'Term must be at least one month' });
    if (rate < 0) return res.status(400).json({ error: 'Interest rate cannot be negative' });

    // The loan can move to another of your houses — a refinance secured elsewhere, or
    // an entry error being fixed. Its ledger travels with it, since the ledger hangs
    // off the loan and not the property.
    let propertyId = pml.property_id;
    if (b.property_id !== undefined && Number(b.property_id) !== pml.property_id) {
      if (!ownedProperty(req, Number(b.property_id))) return res.status(404).json({ error: 'Property not found' });
      propertyId = Number(b.property_id);
    }

    // Recalculate the payment only when asked, or when it was never set by hand. Quietly
    // changing what a lender is owed because the rate was edited is not a favour.
    let payment = num(b.payment_cents, pml.payment_cents);
    if (b.recalc_payment) {
      payment = type === 'interest_only'
        ? Math.round(principal * (rate / 10000) / 12)
        : loanEngine.calcPayment(principal, rate, term);
    }

    // The balance moves with the principal only when nothing has been paid yet. Once
    // there are payments, the balance is a fact the ledger owns, not a field to retype.
    const paidAnything = pmlTies(pml.id).ledger > 0;
    const balance = paidAnything ? pml.principal_balance_cents
      : num(b.principal_balance_cents, principal);

    run(`UPDATE pml_loans SET property_id=?, lender_name=?, lender_contact=?, lender_phone=?, lender_email=?, lien_position=?, status=?,
           principal_cents=?, interest_rate_bps=?, term_months=?, payment_type=?, payment_cents=?,
           balloon_date=?, first_payment_date=?, principal_balance_cents=?, notes=? WHERE id=?`,
      propertyId,
      String(b.lender_name || pml.lender_name).trim(),
      b.lender_contact !== undefined ? (b.lender_contact || null) : pml.lender_contact,
      b.lender_phone !== undefined ? (b.lender_phone ? addr.formatPhone(b.lender_phone) : null) : pml.lender_phone,
      b.lender_email !== undefined ? (b.lender_email || null) : pml.lender_email,
      num(b.lien_position, pml.lien_position), b.status || pml.status,
      principal, rate, term, type, payment,
      b.balloon_date !== undefined ? (b.balloon_date || null) : pml.balloon_date,
      b.first_payment_date || pml.first_payment_date, balance,
      b.notes !== undefined ? (b.notes || null) : pml.notes, pml.id);

    res.json({ ...get('SELECT * FROM pml_loans WHERE id=?', pml.id), balance_locked: paidAnything });
  } catch (e) { next(e); }
});

app.delete('/api/admin/pml/:id', adminOnly, (req, res, next) => {
  try {
    const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
    if (!pml) return res.status(404).json({ error: 'Not found' });
    if (!req.body || req.body.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
    const t = pmlTies(pml.id);
    if (t.ledger || t.journal_entries) {
      return res.status(400).json({
        error: `This lender loan has ${t.ledger} ledger entr${t.ledger === 1 ? 'y' : 'ies'} and ` +
               `${t.journal_entries} journal entr${t.journal_entries === 1 ? 'y' : 'ies'} against it. ` +
               `Deleting it would leave money in your books pointing at nothing. Mark it paid off instead.`,
        ties: t,
      });
    }
    run('DELETE FROM pml_loans WHERE id=?', pml.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/admin/pml/:id/payments', adminOnly, (req, res) => {
  const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!pml) return res.status(404).json({ error: 'Not found' });
  const amount = Number(req.body.amount_cents);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });
  const r = pml.interest_rate_bps / 10000 / 12;
  const interestOwed = pml.interest_due_cents || Math.round(pml.principal_balance_cents * r);
  const toInterest = Math.min(amount, interestOwed);
  const toPrincipal = Math.min(amount - toInterest, pml.principal_balance_cents);
  const newBal = pml.principal_balance_cents - toPrincipal;
  run(`INSERT INTO pml_ledger (pml_loan_id, entry_date, type, amount_cents, to_interest_cents,
        to_principal_cents, principal_balance_after_cents, memo, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    pml.id, req.body.entry_date || today(), 'payment', amount, toInterest, toPrincipal, newBal,
    req.body.memo || null, req.user.id);
  run(`UPDATE pml_loans SET principal_balance_cents=?, interest_due_cents=?,
        status=CASE WHEN ?<=0 THEN 'paid_off' ELSE status END WHERE id=?`,
    newBal, Math.max(0, interestOwed - toInterest), newBal, pml.id);
  res.json({ to_interest_cents: toInterest, to_principal_cents: toPrincipal, balance_cents: newBal });
});
// Scheduling for lender payments. This does NOT move money — see the note in the UI.
// It tracks when each payment is due, reminds you, and can auto-record a payment you
// have already set up to go out from your bank so the ledger stays accurate.
app.put('/api/admin/pml/:id/schedule', adminOnly, (req, res) => {
  const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!pml) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  run(`UPDATE pml_loans SET payment_day=?, autopay_enabled=?, autopay_method=?, autopay_note=? WHERE id=?`,
    b.payment_day ?? pml.payment_day, b.autopay_enabled ? 1 : 0,
    b.autopay_method || pml.autopay_method || 'bank_transfer',
    b.autopay_note ?? pml.autopay_note, pml.id);
  res.json(get('SELECT * FROM pml_loans WHERE id=?', pml.id));
});

// What is due to lenders, and what is overdue to be recorded.
app.get('/api/admin/pml-due', adminOnly, (req, res) => {
  const rows = all(`SELECT pl.*, p.address FROM pml_loans pl LEFT JOIN properties p ON p.id=pl.property_id
    WHERE pl.company_id=? AND pl.status='active'`, req.companyId);
  const period = today().slice(0, 7);
  const out = rows.map(pl => {
    const paidThisPeriod = get(`SELECT COUNT(*) c FROM pml_ledger
      WHERE pml_loan_id=? AND type='payment' AND substr(entry_date,1,7)=?`, pl.id, period).c > 0;
    const due = loanEngine.nextDueDate(pl, today());
    return {
      id: pl.id, lender_name: pl.lender_name, address: pl.address || '',
      payment_cents: pl.payment_cents, next_due_date: due,
      paid_this_period: paidThisPeriod, autopay_enabled: !!pl.autopay_enabled,
      autopay_method: pl.autopay_method, payment_day: pl.payment_day,
      balance_cents: pl.principal_balance_cents,
    };
  });
  res.json({ period, loans: out, unpaid_count: out.filter(x => !x.paid_this_period).length });
});

// Records payments for lenders you have flagged as autopay — the transfer itself is set up
// at your bank; this keeps the ledger and your reports in step with it.
function runPmlAutoRecord() {
  const period = today().slice(0, 7);
  const day = new Date().getUTCDate();
  const rows = all(`SELECT * FROM pml_loans WHERE status='active' AND autopay_enabled=1`);
  for (const pl of rows) {
    try {
      if (pl.autopay_last_period === period) continue;
      const dueDay = pl.payment_day || Number(String(pl.first_payment_date).slice(8, 10)) || 1;
      if (day < dueDay) continue;
      const already = get(`SELECT COUNT(*) c FROM pml_ledger WHERE pml_loan_id=? AND type='payment'
        AND substr(entry_date,1,7)=?`, pl.id, period).c;
      if (already) { run('UPDATE pml_loans SET autopay_last_period=? WHERE id=?', period, pl.id); continue; }
      const r = pl.interest_rate_bps / 10000 / 12;
      const interestOwed = pl.interest_due_cents || Math.round(pl.principal_balance_cents * r);
      const amount = pl.payment_cents;
      const toInterest = Math.min(amount, interestOwed);
      const toPrincipal = Math.min(amount - toInterest, pl.principal_balance_cents);
      const newBal = pl.principal_balance_cents - toPrincipal;
      run(`INSERT INTO pml_ledger (pml_loan_id, entry_date, type, amount_cents, to_interest_cents,
            to_principal_cents, principal_balance_after_cents, memo)
           VALUES (?,?,?,?,?,?,?,?)`, pl.id, today(), 'payment', amount, toInterest, toPrincipal,
        newBal, `Scheduled payment ${period}`);
      run(`UPDATE pml_loans SET principal_balance_cents=?, interest_due_cents=?, autopay_last_period=?,
            status=CASE WHEN ?<=0 THEN 'paid_off' ELSE status END WHERE id=?`,
        newBal, Math.max(0, interestOwed - toInterest), period, newBal, pl.id);
      console.log(`Recorded scheduled lender payment for ${pl.lender_name} ${period}`);
    } catch (e) { console.error('PML auto-record failed for', pl.id, e.message); }
  }
}
setInterval(runPmlAutoRecord, 6 * 60 * 60 * 1000);
setTimeout(runPmlAutoRecord, 25000);
app.post('/api/admin/pml-auto-record', adminOnly, (req, res) => { runPmlAutoRecord(); res.json({ ok: true }); });

app.post('/api/admin/pml/:id/draw', adminOnly, (req, res) => {
  const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!pml) return res.status(404).json({ error: 'Not found' });
  const amount = Number(req.body.amount_cents);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });
  const newBal = pml.principal_balance_cents + amount;
  run(`INSERT INTO pml_ledger (pml_loan_id, entry_date, type, amount_cents, principal_balance_after_cents, memo, created_by)
       VALUES (?,?,?,?,?,?,?)`, pml.id, req.body.entry_date || today(), 'draw', amount, newBal, req.body.memo || 'Additional draw', req.user.id);
  run('UPDATE pml_loans SET principal_balance_cents=? WHERE id=?', newBal, pml.id);
  res.json({ balance_cents: newBal });
});

// ---------- notices ----------
app.get('/api/admin/loans/:id/notices', adminOnly, (req, res) => {
  if (!ownedLoan(req, req.params.id)) return res.status(404).json({ error: 'Loan not found' });
  res.json(all('SELECT * FROM notices WHERE loan_id=? ORDER BY id DESC', req.params.id));
});
app.post('/api/admin/loans/:id/notices', adminOnly, (req, res) => {
  const { subject, body } = req.body || {};
  if (!ownedLoan(req, req.params.id)) return res.status(404).json({ error: 'Loan not found' });
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });
  const co = get('SELECT * FROM companies WHERE id=?', req.companyId);
  const html = tpl.brandedShell({ company: co, subject,
    bodyHtml: String(body).split('\n\n').map(par => `<p>${tpl.escapeHtml(par)}</p>`).join(''),
    baseUrl: baseUrlOf(req) });
  run('INSERT INTO notices (loan_id, type, subject, body, body_html) VALUES (?,?,?,?,?)',
    req.params.id, 'custom', subject, body, html);
  run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin) VALUES (?,?,?,1)',
    req.params.id, req.user.id, `📄 ${subject} — open the Notices section on your Home screen to read this notice.`);
  res.json({ ok: true });
});
// Awaits the sweep, so a caller that asks for it and then reads the notices sees the
// result rather than racing it.
app.post('/api/admin/notice-sweep', adminOnly, async (req, res, next) => {
  try { await runNoticeSweep(); res.json({ ok: true }); } catch (e) { next(e); }
});
app.get('/api/tenant/notices', tenantReady, (req, res) => {
  const loan = get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
  if (!loan) return res.json([]);
  // A prepared-but-unserved DC 101 is a draft on the admin's desk, not a notice.
  res.json(all('SELECT * FROM notices WHERE loan_id=? AND COALESCE(prepared,0)=0 ORDER BY id DESC', loan.id));
});
app.post('/api/tenant/notices/:id/read', tenantReady, (req, res) => {
  const loan = get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  run("UPDATE notices SET read_at=datetime('now') WHERE id=? AND loan_id=? AND read_at IS NULL", req.params.id, loan.id);
  res.json({ ok: true });
});

// ---------- processing fees ----------
// The buyer's loan is always credited the full payment amount; the fee rides on top of the
// charge and covers the processor. Cash at retail already charges the buyer at the register,
// so we add nothing there.
function feeSettings(companyId) {
  const c = get('SELECT * FROM companies WHERE id=?', companyId) || {};
  return {
    pass: c.pass_fees_to_buyer === undefined ? 1 : c.pass_fees_to_buyer,
    label: c.fee_label || 'Processing fee',
    card_bps: c.fee_card_bps ?? 290, card_fixed: c.fee_card_fixed_cents ?? 30,
    ach_bps: c.fee_ach_bps ?? 80, ach_fixed: c.fee_ach_fixed_cents ?? 0,
    ach_cap: c.fee_ach_cap_cents ?? 500,
  };
}
// method: 'card' | 'cashapp' | 'ach' | 'cash'
function calcFee(companyId, amountCents, method) {
  const f = feeSettings(companyId);
  if (!f.pass || method === 'cash') return 0;
  if (method === 'ach') {
    const raw = Math.round(amountCents * f.ach_bps / 10000) + f.ach_fixed;
    return f.ach_cap ? Math.min(raw, f.ach_cap) : raw;
  }
  return Math.round(amountCents * f.card_bps / 10000) + f.card_fixed;
}
app.get('/api/tenant/fee-quote', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  const amount = Number(req.query.amount_cents) || 0;
  const f = feeSettings(loan.company_id);
  res.json({
    pass_fees: !!f.pass, label: f.label, amount_cents: amount,
    card: { fee_cents: calcFee(loan.company_id, amount, 'card'), total_cents: amount + calcFee(loan.company_id, amount, 'card') },
    cashapp: { fee_cents: calcFee(loan.company_id, amount, 'cashapp'), total_cents: amount + calcFee(loan.company_id, amount, 'cashapp') },
    ach: { fee_cents: calcFee(loan.company_id, amount, 'ach'), total_cents: amount + calcFee(loan.company_id, amount, 'ach') },
    cash: { fee_cents: 0, total_cents: amount, note: 'The store charges its own fee at the register.' },
  });
});

// ---------- saved payment methods (tokenized via Stripe) ----------
function customerFor(user) {
  return pay.getOrCreateCustomer(user, (id) =>
    run('UPDATE users SET stripe_customer_id=? WHERE id=?', id, user.id));
}
function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return process.env.BASE_URL || `${proto}://${req.headers.host}`;
}

app.get('/api/tenant/payment-methods', tenantReady, (req, res) => {
  res.json(all(`SELECT id, type, brand, last4, exp_month, exp_year, is_default
    FROM payment_methods WHERE user_id=? ORDER BY is_default DESC, id DESC`, req.user.id));
});

// Opens Stripe Checkout in "setup" mode — Stripe collects and stores the card/bank.
app.post('/api/tenant/payment-methods/setup', tenantReady, async (req, res, next) => {
  if (!pay.stripeEnabled()) return res.status(400).json({ error: 'Online payments are not enabled yet. Ask your servicer.' });
  try {
    const customerId = await customerFor(req.user);
    const session = await pay.createSetupSession({ customerId, baseUrl: baseUrlOf(req) });
    res.json({ url: session.url });
  } catch (e) { next(e); }
});

// Called after the redirect back — pulls the saved method into our table.
app.get('/api/tenant/payment-methods/confirm', tenantReady, async (req, res, next) => {
  if (!pay.stripeEnabled()) return res.json({ ok: false });
  try {
    const sess = await pay.retrieveSession(req.query.setup_session);
    if (!sess.setup_intent) return res.json({ ok: false });
    const si = await pay.retrieveSetupIntent(
      typeof sess.setup_intent === 'string' ? sess.setup_intent : sess.setup_intent.id);
    if (!si.payment_method) return res.json({ ok: false });
    const pm = await pay.retrievePaymentMethod(
      typeof si.payment_method === 'string' ? si.payment_method : si.payment_method.id);
    savePaymentMethod(req.user.id, si.customer, pm);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function savePaymentMethod(userId, customerId, pm) {
  if (get('SELECT id FROM payment_methods WHERE stripe_payment_method_id=?', pm.id)) return;
  const isCard = pm.type === 'card';
  const d = isCard ? pm.card : pm.us_bank_account;
  const hasDefault = get('SELECT id FROM payment_methods WHERE user_id=? AND is_default=1', userId);
  run(`INSERT INTO payment_methods (user_id, stripe_customer_id, stripe_payment_method_id,
        type, brand, last4, exp_month, exp_year, is_default) VALUES (?,?,?,?,?,?,?,?,?)`,
    userId, customerId, pm.id, pm.type,
    isCard ? (d && d.brand) : (d && d.bank_name),
    d && d.last4, isCard && d ? d.exp_month : null, isCard && d ? d.exp_year : null,
    hasDefault ? 0 : 1);
}

app.post('/api/tenant/payment-methods/:id/default', tenantReady, (req, res) => {
  const pm = get('SELECT * FROM payment_methods WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!pm) return res.status(404).json({ error: 'Not found' });
  run('UPDATE payment_methods SET is_default=0 WHERE user_id=?', req.user.id);
  run('UPDATE payment_methods SET is_default=1 WHERE id=?', pm.id);
  res.json({ ok: true });
});

app.delete('/api/tenant/payment-methods/:id', tenantReady, async (req, res, next) => {
  const pm = get('SELECT * FROM payment_methods WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!pm) return res.status(404).json({ error: 'Not found' });
  const loan = tenantLoan(req);
  const ap = loan ? get('SELECT * FROM autopay WHERE loan_id=?', loan.id) : null;
  if (ap && ap.payment_method_id === pm.id && ap.enabled) {
    return res.status(400).json({ error: 'This method is used for autopay. Turn autopay off first, or switch it to another method.' });
  }
  try { if (pay.stripeEnabled()) await pay.detachPaymentMethod(pm.stripe_payment_method_id); } catch {}
  run('DELETE FROM payment_methods WHERE id=?', pm.id);
  if (pm.is_default) {
    const next_ = get('SELECT id FROM payment_methods WHERE user_id=? ORDER BY id LIMIT 1', req.user.id);
    if (next_) run('UPDATE payment_methods SET is_default=1 WHERE id=?', next_.id);
  }
  res.json({ ok: true });
});

// One-tap payment with a stored method (buyer present).
app.post('/api/tenant/pay/saved', tenantReady, async (req, res, next) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  if (!pay.stripeEnabled()) return res.status(400).json({ error: 'Online payments are not enabled yet.' });
  const amount = Number(req.body.amount_cents);
  const pm = get('SELECT * FROM payment_methods WHERE id=? AND user_id=?', req.body.payment_method_id, req.user.id);
  if (!pm) return res.status(404).json({ error: 'Payment method not found' });
  if (!amount || amount < 100) return res.status(400).json({ error: 'Enter a valid amount' });
  try {
    const feeKind = pm.type === 'card' ? 'card' : 'ach';
    const fee = calcFee(loan.company_id, amount, feeKind);
    const pi = await pay.chargeSavedMethod({
      customerId: pm.stripe_customer_id, paymentMethodId: pm.stripe_payment_method_id,
      amountCents: amount + fee, description: `Loan payment — loan #${loan.id}`,
      idempotencyKey: `pay-${loan.id}-${Date.now()}`,
    });
    if (pi.status === 'succeeded' || pi.status === 'processing') {
      const method = pm.type === 'card' ? 'stripe_card' : 'stripe_ach';
      postPayment(loan.id, amount, method, today(), `stripe:${pi.id}`,
        pi.status === 'processing' ? 'Bank payment — clearing' : 'Saved method payment', null, fee);
      return res.json({ ok: true, status: pi.status, fee_cents: fee });
    }
    res.status(400).json({ error: 'Payment could not be completed. Try another method.' });
  } catch (e) { next(e); }
});

// ---------- autopay ----------
app.get('/api/tenant/autopay', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.json({ enabled: false });
  const ap = get('SELECT * FROM autopay WHERE loan_id=?', loan.id);
  if (!ap) return res.json({ enabled: false });
  const pm = get('SELECT id, type, brand, last4 FROM payment_methods WHERE id=?', ap.payment_method_id);
  res.json({ ...ap, enabled: !!ap.enabled, payment_method: pm });
});
app.post('/api/tenant/autopay', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  const { payment_method_id, amount_mode, fixed_amount_cents, extra_principal_cents, days_before_due } = req.body || {};
  const pm = get('SELECT * FROM payment_methods WHERE id=? AND user_id=?', payment_method_id, req.user.id);
  if (!pm) return res.status(400).json({ error: 'Choose a saved payment method first' });
  run(`INSERT INTO autopay (loan_id, payment_method_id, enabled, amount_mode, fixed_amount_cents,
        extra_principal_cents, days_before_due) VALUES (?,?,1,?,?,?,?)
       ON CONFLICT(loan_id) DO UPDATE SET payment_method_id=excluded.payment_method_id, enabled=1,
        amount_mode=excluded.amount_mode, fixed_amount_cents=excluded.fixed_amount_cents,
        extra_principal_cents=excluded.extra_principal_cents, days_before_due=excluded.days_before_due,
        last_error=NULL`,
    loan.id, pm.id, amount_mode || 'full', fixed_amount_cents || null,
    extra_principal_cents || 0, days_before_due || 0);
  res.json({ ok: true });
});
app.delete('/api/tenant/autopay', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (loan) run('UPDATE autopay SET enabled=0 WHERE loan_id=?', loan.id);
  res.json({ ok: true });
});

// Daily sweep: charge enrolled loans on/after their due date.
async function runAutopaySweep() {
  if (!pay.stripeEnabled()) return;
  const rows = all(`SELECT a.*, l.id AS loan_id, l.company_id FROM autopay a
    JOIN loans l ON l.id=a.loan_id WHERE a.enabled=1 AND l.status='active'`);
  for (const ap of rows) {
    try {
      let loan = get('SELECT * FROM loans WHERE id=?', ap.loan_id);
      loan = assessRecurringCharges(loan);
      const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
      const status = loanEngine.loanStatus(loan, ledger, today());
      const period = today().slice(0, 7);
      if (ap.last_run_period === period) continue;          // already charged this month
      const due = status.owed_now_cents;
      if (due <= 0) continue;                                 // nothing owed yet
      const charges = all('SELECT * FROM charges WHERE loan_id=? AND recurring=1 AND active=1', loan.id)
        .reduce((t, c) => t + c.amount_cents, 0);
      let amount = ap.amount_mode === 'fixed' ? (ap.fixed_amount_cents || 0)
                 : ap.amount_mode === 'minimum' ? Math.min(due, loan.payment_cents + loan.escrow_cents + charges)
                 : due;
      amount += ap.extra_principal_cents || 0;
      if (amount < 100) continue;
      const pm = get('SELECT * FROM payment_methods WHERE id=?', ap.payment_method_id);
      if (!pm) { run('UPDATE autopay SET last_error=? WHERE loan_id=?', 'Saved payment method was removed', loan.id); continue; }
      const fee = calcFee(loan.company_id, amount, pm.type === 'card' ? 'card' : 'ach');
      const pi = await pay.chargeSavedMethod({
        customerId: pm.stripe_customer_id, paymentMethodId: pm.stripe_payment_method_id,
        amountCents: amount + fee, description: `Autopay — loan #${loan.id} ${period}`,
        idempotencyKey: `autopay-${loan.id}-${period}`,
      });
      if (pi.status === 'succeeded' || pi.status === 'processing') {
        postPayment(loan.id, amount, pm.type === 'card' ? 'stripe_card' : 'stripe_ach', today(),
          `stripe:${pi.id}`, `Autopay ${period}`, null, fee);
        run("UPDATE autopay SET last_run_period=?, last_error=NULL WHERE loan_id=?", period, loan.id);
        run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin) VALUES (?,?,?,1)',
          loan.id, get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') ORDER BY id LIMIT 1", loan.company_id).id,
          `✅ Autopay processed your payment of $${(amount/100).toFixed(2)}.`);
        console.log(`Autopay charged loan ${loan.id} ${period}: $${(amount/100).toFixed(2)}`);
      }
    } catch (e) {
      run('UPDATE autopay SET last_error=? WHERE loan_id=?', e.message, ap.loan_id);
      const loan = get('SELECT * FROM loans WHERE id=?', ap.loan_id);
      if (loan) run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin) VALUES (?,?,?,1)',
        loan.id, get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') ORDER BY id LIMIT 1", loan.company_id).id,
        `⚠️ Autopay could not process your payment: ${e.message}. Please make a payment in the app.`);
      console.error('Autopay failed for loan', ap.loan_id, e.message);
    }
  }
}
setInterval(runAutopaySweep, 6 * 60 * 60 * 1000);   // every 6 hours
setTimeout(runAutopaySweep, 20000);
app.post('/api/admin/autopay-sweep', adminOnly, async (req, res, next) => {
  try { await runAutopaySweep(); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---------- payment reminders the admin configures ----------
const DEFAULT_REMINDERS = [
  { name: 'Coming up', offset_days: -5, channel: 'push', only_if_unpaid: 1,
    title: 'Payment due in 5 days',
    body: 'Your payment of {{monthly_payment}} for {{property_address}} is due {{due_date}}.' },
  { name: 'Due today', offset_days: 0, channel: 'both', only_if_unpaid: 1,
    title: 'Payment due today',
    body: 'Your payment of {{amount_due}} is due today. You can pay in the app in under a minute.' },
  { name: 'Past due', offset_days: 5, channel: 'both', only_if_unpaid: 1,
    title: 'Payment past due',
    body: 'We have not received your payment of {{amount_due}} for {{property_address}}. A late fee of {{late_fee}} may apply.' },
];

function seedReminders(companyId) {
  if (get('SELECT COUNT(*) c FROM reminder_rules WHERE company_id=?', companyId).c) return;
  for (const r of DEFAULT_REMINDERS) {
    run(`INSERT INTO reminder_rules (company_id, name, offset_days, title, body, channel, only_if_unpaid)
         VALUES (?,?,?,?,?,?,?)`, companyId, r.name, r.offset_days, r.title, r.body, r.channel, r.only_if_unpaid);
  }
}

app.get('/api/admin/reminders', adminOnly, (req, res) => {
  seedReminders(req.companyId);
  res.json({
    merge_fields: tpl.MERGE_FIELDS,
    rules: all('SELECT * FROM reminder_rules WHERE company_id=? ORDER BY offset_days', req.companyId),
  });
});
app.post('/api/admin/reminders', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.title || !b.body) return res.status(400).json({ error: 'Name, title and message are required' });
  const r = run(`INSERT INTO reminder_rules (company_id, name, offset_days, title, body, channel, only_if_unpaid, enabled)
    VALUES (?,?,?,?,?,?,?,?)`, req.companyId, b.name, Number(b.offset_days) || 0, b.title, b.body,
    b.channel || 'push', b.only_if_unpaid === false ? 0 : 1, b.enabled === false ? 0 : 1);
  res.json(get('SELECT * FROM reminder_rules WHERE id=?', r.lastInsertRowid));
});
app.put('/api/admin/reminders/:id', adminOnly, (req, res) => {
  const rule = get('SELECT * FROM reminder_rules WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  run(`UPDATE reminder_rules SET name=?, offset_days=?, title=?, body=?, channel=?, enabled=?, only_if_unpaid=? WHERE id=?`,
    b.name ?? rule.name, b.offset_days ?? rule.offset_days, b.title ?? rule.title, b.body ?? rule.body,
    b.channel ?? rule.channel, b.enabled === undefined ? rule.enabled : (b.enabled ? 1 : 0),
    b.only_if_unpaid === undefined ? rule.only_if_unpaid : (b.only_if_unpaid ? 1 : 0), rule.id);
  res.json(get('SELECT * FROM reminder_rules WHERE id=?', rule.id));
});
app.delete('/api/admin/reminders/:id', adminOnly, (req, res) => {
  const rule = get('SELECT * FROM reminder_rules WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  run('DELETE FROM reminder_rules WHERE id=?', rule.id);
  res.json({ ok: true });
});

// Send one buyer a reminder right now, from a rule or free text.
app.post('/api/admin/loans/:id/remind', adminOnly, async (req, res, next) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!loan.tenant_user_id) return res.status(400).json({ error: 'No buyer on this loan yet' });
  try {
    const ctx = mergeContextForLoan(req, loan.id);
    const values = tpl.buildMergeValues(ctx);
    let title = req.body.title, body = req.body.body;
    if (req.body.rule_id) {
      const rule = get('SELECT * FROM reminder_rules WHERE id=? AND company_id=?', req.body.rule_id, req.companyId);
      if (!rule) return res.status(404).json({ error: 'Reminder not found' });
      title = rule.title; body = rule.body;
    }
    if (!title) return res.status(400).json({ error: 'Nothing to send' });
    await notify.notify(loan.tenant_user_id, {
      kind: 'payment_due',
      title: tpl.applyMerge(title, values),
      body: tpl.applyMerge(body || '', values),
      url: '/?tab=pay',
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Daily sweep that fires every enabled rule at its offset from the due date.
async function runReminderSweep() {
  const today_ = today();
  const loans = all("SELECT * FROM loans WHERE status='active' AND tenant_user_id IS NOT NULL");
  for (const raw of loans) {
    try {
      const loan = assessRecurringCharges(raw);
      const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
      const status = loanEngine.loanStatus(loan, ledger, today_);
      const due = status.next_due_date || loanEngine.nextDueDate(loan, today_);
      if (!due) continue;
      const rules = all('SELECT * FROM reminder_rules WHERE company_id=? AND enabled=1', loan.company_id);
      if (!rules.length) continue;

      const company = get('SELECT * FROM companies WHERE id=?', loan.company_id);
      const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
      const buyer = get('SELECT * FROM users WHERE id=?', loan.tenant_user_id);
      if (!buyer || buyer.deleted_at || buyer.archived_at) continue;
      const values = tpl.buildMergeValues({ company, buyer, loan, property, status,
        payoff: loanEngine.payoffQuote(loan, today_), baseUrl: process.env.BASE_URL || '' });

      for (const rule of rules) {
        // The day this rule wants to fire, relative to the due date.
        const fireOn = new Date(new Date(due + 'T00:00:00Z').getTime() + rule.offset_days * 86400000)
          .toISOString().slice(0, 10);
        if (fireOn !== today_) continue;
        if (rule.only_if_unpaid && status.owed_now_cents <= 0 && rule.offset_days >= 0) continue;

        const title = tpl.applyMerge(rule.title, values);
        const body = tpl.applyMerge(rule.body, values);
        const dedupe = `rule:${rule.id}:${due}`;

        if (rule.channel === 'push' || rule.channel === 'both') {
          await notify.notify(loan.tenant_user_id, { kind: rule.offset_days > 0 ? 'payment_late' : 'payment_due',
            title, body, url: '/?tab=pay', dedupeKey: dedupe });
        }
        if (rule.channel === 'message' || rule.channel === 'both') {
          const already = get("SELECT id FROM messages WHERE loan_id=? AND subject=? AND date(created_at)=?",
            loan.id, title, today_);
          if (!already) {
            const html = tpl.brandedShell({ company, subject: title,
              bodyHtml: `<p>${tpl.escapeHtml(body)}</p>`, baseUrl: process.env.BASE_URL || '' });
            const sender = get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id LIMIT 1", loan.company_id);
            if (sender) run(`INSERT INTO messages (loan_id, sender_user_id, body, body_html, subject, read_by_admin)
              VALUES (?,?,?,?,?,1)`, loan.id, sender.id, body, html, title);
          }
        }
      }
    } catch (e) { console.error('Reminder sweep failed for loan', raw.id, e.message); }
  }
}
setInterval(runReminderSweep, 6 * 60 * 60 * 1000);
setTimeout(runReminderSweep, 30000);
app.post('/api/admin/reminder-sweep', adminOnly, async (req, res, next) => {
  try { await runReminderSweep(); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---------- notifications ----------
app.get('/api/push/public-key', anyUser, (req, res) => res.json({ key: notify.vapid().publicKey }));
app.post('/api/push/subscribe', anyUser, (req, res, next) => {
  try { notify.subscribe(req.user.id, req.body.subscription); res.json({ ok: true }); }
  catch (e) { next(e); }
});
app.post('/api/push/unsubscribe', anyUser, (req, res) => {
  if (req.body.endpoint) notify.unsubscribe(req.body.endpoint);
  res.json({ ok: true });
});
app.get('/api/notifications', anyUser, (req, res) => {
  res.json({ counts: notify.unreadCount(req.user.id), items: notify.list(req.user.id) });
});
app.post('/api/notifications/read', anyUser, (req, res) => {
  notify.markRead(req.user.id, { id: req.body.id, kind: req.body.kind });
  res.json({ counts: notify.unreadCount(req.user.id) });
});
app.get('/api/notifications/prefs', anyUser, (req, res) => res.json(notify.prefsFor(req.user.id)));
app.post('/api/notifications/prefs', anyUser, (req, res) => {
  notify.setPrefs(req.user.id, req.body || {});
  res.json(notify.prefsFor(req.user.id));
});

// ---------- consent: terms, privacy, messaging, location ----------
// Apple 5.1.1 and Google Play both require clear consent before collecting personal data,
// and Play requires a prominent disclosure before any location permission prompt.
function logConsent(req, kind, version) {
  run('INSERT INTO consents (user_id, kind, version, ip, user_agent) VALUES (?,?,?,?,?)',
    req.user.id, kind, version || null,
    (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    (req.headers['user-agent'] || '').slice(0, 300));
}
app.get('/api/terms-version', (req, res) => res.json({ version: TERMS_VERSION }));
app.post('/api/tenant/accept-terms', tenantOnly, (req, res) => {
  if (!req.body.accept_terms || !req.body.accept_privacy) {
    return res.status(400).json({ error: 'You must accept both the Terms of Use and the Privacy Policy to continue.' });
  }
  run("UPDATE users SET terms_accepted_at=datetime('now'), terms_version=? WHERE id=?", TERMS_VERSION, req.user.id);
  logConsent(req, 'terms', TERMS_VERSION);
  logConsent(req, 'privacy', TERMS_VERSION);
  logConsent(req, 'messaging', TERMS_VERSION);   // in-app messaging + electronic notices
  // First moment the buyer is really "in" the app — the welcome guide goes out now.
  try { sendHomebuyerGuide(req.user.id); } catch (e) { console.error('Welcome guide:', e.message); }
  res.json({ ok: true, terms_version: TERMS_VERSION });
});

// The welcome guide, generated for this buyer's city and this loan's structure,
// filed in their shared documents and announced in the thread. Once per loan —
// re-accepting terms after an update must not send a second copy (the admin
// button can, deliberately).
function sendHomebuyerGuide(tenantUserId, { force } = {}) {
  const loan = get("SELECT * FROM loans WHERE tenant_user_id=? AND status='active' ORDER BY id DESC LIMIT 1", tenantUserId);
  if (!loan) return null;
  const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
  if (!noticeRules.isMichigan(property)) return null;
  if (!force && get(`SELECT id FROM documents WHERE loan_id=? AND title LIKE 'Welcome guide%'`, loan.id)) return null;
  const co = get('SELECT * FROM companies WHERE id=?', loan.company_id);
  const tenant = get('SELECT * FROM users WHERE id=?', tenantUserId);

  const buf = guide.render({ company: co, loan, property, tenant, logo: companyLogo(co) });
  const stored = crypto.randomUUID() + '.pdf';
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  const cityLabel = (guide.cityFor(property) || { label: 'Michigan' }).label;
  const structure = (loan.escrow_structure || 'piti').toUpperCase();
  run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, filename, stored_name, mime, visible_to_tenant)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
    loan.company_id, loan.id, loan.property_id, 'other', 'misc_shared',
    `Welcome guide — your new home (${cityLabel}, ${structure})`,
    `welcome-guide-${loan.id}.pdf`, stored, 'application/pdf');

  const adminId = get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id LIMIT 1", loan.company_id);
  if (adminId && tenant) {
    run(`INSERT INTO messages (loan_id, sender_user_id, body, subject, read_by_admin, channels)
         VALUES (?,?,?,?,1,'app')`, loan.id, adminId.id,
      `Welcome to your new home! 🏡\n\nYour homeowner's guide is in your Documents — everything you need for ` +
      `your first weeks: utilities to switch over, your city's property rules, how your payment works, and your ` +
      `insurance requirements.\n\nRemember: all payments are made right here in the app, and if you enroll in ` +
      `autopay your $50.00 servicing fee is removed.`,
      'Your homeowner welcome guide');
    notify.notify(tenant.id, {
      kind: 'notice', title: 'Your homeowner welcome guide is here',
      body: 'Everything for your first weeks in the home — open Documents to read it.',
      url: '/?tab=docs', dedupeKey: `welcome-guide-${loan.id}`,
    }).catch(() => {});
  }
  console.log(`Welcome guide (${cityLabel}, ${structure}) filed for loan ${loan.id}`);
  return { loan_id: loan.id, city: cityLabel, structure };
}
app.get('/api/tenant/consents', tenantOnly, (req, res) => {
  res.json({
    terms_accepted_at: req.user.terms_accepted_at,
    terms_version: req.user.terms_version,
    current_version: TERMS_VERSION,
    location_consent_at: req.user.location_consent_at,
    history: all('SELECT kind, version, created_at FROM consents WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id),
  });
});

// ---------- account: data export & deletion (App Store 5.1.1(v) / Play Data deletion) ----------
app.get('/api/account/export', anyUser, (req, res) => {
  const u = get('SELECT id, name, email, phone, role, created_at, terms_accepted_at, terms_version FROM users WHERE id=?', req.user.id);
  const out = { account: u, exported_at: new Date().toISOString() };
  if (req.user.role === 'tenant') {
    const loan = get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
    if (loan) {
      out.loan = loan;
      out.property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
      out.payment_history = all('SELECT * FROM ledger WHERE loan_id=? ORDER BY id', loan.id);
      out.messages = all('SELECT body, created_at, sender_user_id FROM messages WHERE loan_id=? ORDER BY id', loan.id);
      out.notices = all('SELECT type, subject, body, sent_at, read_at FROM notices WHERE loan_id=? AND COALESCE(prepared,0)=0 ORDER BY id', loan.id);
      out.documents = all('SELECT filename, category, created_at FROM documents WHERE loan_id=? AND visible_to_tenant=1', loan.id);
    }
  }
  out.consent_history = all('SELECT kind, version, created_at FROM consents WHERE user_id=? ORDER BY id', req.user.id);
  out.location_history = all('SELECT lat, lng, created_at FROM location_pings WHERE user_id=? ORDER BY id', req.user.id);
  res.setHeader('Content-Disposition', 'attachment; filename="my-data-export.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(out, null, 2));
});

// Erase a user's personal data. Ledger entries, notices, and messages reference the user
// row by foreign key and carry legal retention duties, so the row is kept as an anonymized
// tombstone: every piece of personal information is overwritten, the login is destroyed,
// and the account can never be signed into again. Runs as one transaction so a failure
// can't leave the account half-erased.
function eraseUser(uid, role) {
  const tomb = `deleted-${crypto.randomUUID()}@deleted.invalid`;
  db.exec('BEGIN');
  try {
    run('DELETE FROM location_pings WHERE user_id=?', uid);
    run('DELETE FROM consents WHERE user_id=?', uid);
    run('DELETE FROM notifications WHERE user_id=?', uid);
    run('DELETE FROM push_subscriptions WHERE user_id=?', uid);
    run('UPDATE messages SET body=? WHERE sender_user_id=?', '[message removed at user request]', uid);
    if (role === 'tenant') run('UPDATE loans SET tenant_user_id=NULL WHERE tenant_user_id=?', uid);
    run(`UPDATE users SET email=?, name='Deleted user', phone=NULL,
           password_hash=?, must_change_password=0, location_consent_at=NULL,
           terms_accepted_at=NULL, terms_version=NULL, deleted_at=datetime('now')
         WHERE id=?`, tomb, hashPassword(crypto.randomUUID()), uid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

app.post('/api/account/delete', anyUser, (req, res, next) => {
  if (req.body.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  if (req.user.role === 'owner') {
    return res.status(400).json({ error: 'Company owners cannot self-delete. Transfer ownership or contact support.' });
  }
  try {
    eraseUser(req.user.id, req.user.role);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true, message: 'Your account and personal data have been deleted.' });
  } catch (e) { next(e); }
});

// ---------- tenant routes ----------
function tenantLoan(req) {
  return get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
}
app.get('/api/tenant/loan', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan is linked to your account yet. Contact your servicer.' });
  const f = loanFull(loan);
  f.schedule = loanEngine.amortizationSchedule(loan);
  f.payoff = loanEngine.payoffQuote(f.loan, today());
  f.documents = all('SELECT id, filename, created_at FROM documents WHERE loan_id=? AND visible_to_tenant=1', loan.id);
  f.stripe_enabled = pay.stripeEnabled();
  f.location_consent_at = req.user.location_consent_at;
  f.terms_accepted_at = req.user.terms_accepted_at;
  f.fee_settings = feeSettings(loan.company_id);
  f.autopay = get('SELECT * FROM autopay WHERE loan_id=?', loan.id) || null;
  f.payment_methods = all(`SELECT id, type, brand, last4, exp_month, exp_year, is_default
    FROM payment_methods WHERE user_id=? ORDER BY is_default DESC, id DESC`, req.user.id);
  res.json(f);
});
app.post('/api/tenant/pay/checkout', tenantReady, async (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  if (!pay.stripeEnabled()) return res.status(400).json({ error: 'Online payments are not enabled yet. Ask your servicer.' });
  const amount = Number(req.body.amount_cents);
  if (!amount || amount < 100) return res.status(400).json({ error: 'Enter a valid amount' });
  try {
    const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = process.env.BASE_URL || `${proto}://${req.headers.host}`;
    const fee = calcFee(loan.company_id, amount, 'card');
    const session = await pay.createCheckoutSession({
      loan: { ...loan, address: property ? property.address : 'your home' },
      amountCents: amount, baseUrl, tenantEmail: req.user.email,
      feeCents: fee, feeLabel: feeSettings(loan.company_id).label,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Confirm after redirect (covers local/dev where webhooks can't reach the server)
app.get('/api/tenant/pay/confirm', tenantReady, async (req, res) => {
  if (!pay.stripeEnabled()) return res.json({ ok: false, reason: 'stripe_not_configured' });
  try {
    const s = await pay.retrieveSession(req.query.session_id);
    if (s.payment_status === 'paid' && s.metadata && Number(s.metadata.loan_id)) {
      const result = postStripePayment(s);
      return res.json({ ok: true, duplicate: !!result.duplicate });
    }
    res.json({ ok: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/tenant/messages', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.json([]);
  run('UPDATE messages SET read_by_tenant=1 WHERE loan_id=?', loan.id);
  res.json(all('SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m JOIN users u ON u.id=m.sender_user_id WHERE m.loan_id=? ORDER BY m.id', loan.id));
});
app.post('/api/tenant/messages', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  if (!req.body.body) return res.status(400).json({ error: 'Message required' });
  run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_tenant) VALUES (?,?,?,1)', loan.id, req.user.id, req.body.body);
  const property = get('SELECT address FROM properties WHERE id=?', loan.property_id);
  for (const a of all("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL AND archived_at IS NULL", loan.company_id)) {
    notify.notify(a.id, { kind: 'message', title: `${req.user.name} sent a message`,
      body: `${property ? property.address + ' — ' : ''}${String(req.body.body).slice(0, 120)}`,
      url: '/admin' }).catch(() => {});
  }
  res.json({ ok: true });
});

// ---------- location sharing (opt-in with recorded consent) ----------
app.post('/api/tenant/location/consent', tenantReady, (req, res) => {
  if (req.body.consent) {
    run("UPDATE users SET location_consent_at=datetime('now') WHERE id=?", req.user.id);
    logConsent(req, 'location_on', TERMS_VERSION);
  } else {
    run('UPDATE users SET location_consent_at=NULL WHERE id=?', req.user.id);
    run('DELETE FROM location_pings WHERE user_id=?', req.user.id); // revoke deletes history
    logConsent(req, 'location_off', TERMS_VERSION);
  }
  res.json({ ok: true });
});
app.post('/api/tenant/location', tenantReady, (req, res) => {
  const u = get('SELECT location_consent_at FROM users WHERE id=?', req.user.id);
  if (!u.location_consent_at) return res.status(403).json({ error: 'Location sharing not enabled' });
  const { lat, lng, accuracy_m } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng required' });
  run('INSERT INTO location_pings (user_id, lat, lng, accuracy_m) VALUES (?,?,?,?)', req.user.id, lat, lng, accuracy_m || null);
  // keep only latest 50 pings per user
  run('DELETE FROM location_pings WHERE user_id=? AND id NOT IN (SELECT id FROM location_pings WHERE user_id=? ORDER BY id DESC LIMIT 50)', req.user.id, req.user.id);
  res.json({ ok: true });
});
// Straight-line distance between two points, in miles. Enough to answer the only
// question that matters here: was the buyer at the home or somewhere else.
function milesBetween(lat1, lng1, lat2, lng2) {
  const R = 3958.8, rad = (d) => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

app.get('/api/admin/tenants/:id/location', adminOnly, (req, res) => {
  const u = get("SELECT location_consent_at FROM users WHERE id=? AND company_id=? AND role='tenant'",
    req.params.id, req.companyId);
  if (!u) return res.status(404).json({ error: 'Not found' });

  const history = all(`SELECT lat, lng, accuracy_m, created_at FROM location_pings
    WHERE user_id=? ORDER BY id DESC LIMIT 60`, req.params.id);
  const last = history[0] || null;

  // The home this buyer is buying, so distance means something.
  const home = get(`SELECT p.address, p.city, p.state, p.lat, p.lng FROM loans l
    JOIN properties p ON p.id=l.property_id
    WHERE l.tenant_user_id=? AND l.company_id=? ORDER BY l.id DESC LIMIT 1`,
    req.params.id, req.companyId);

  const withDistance = history.map(h => ({
    ...h,
    miles_from_home: (home && home.lat && home.lng)
      ? Number(milesBetween(h.lat, h.lng, home.lat, home.lng).toFixed(2)) : null,
  }));

  res.json({
    consent_at: u.location_consent_at,
    last_ping: last,
    history: withDistance,
    ping_count: get('SELECT COUNT(*) c FROM location_pings WHERE user_id=?', req.params.id).c,
    home: home ? { address: home.address, city: home.city, state: home.state,
      geocoded: !!(home.lat && home.lng) } : null,
    miles_from_home: withDistance.length ? withDistance[0].miles_from_home : null,
  });
});

// ---------- pages ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'support.html')));
app.get('/delete-account', (req, res) => res.sendFile(path.join(__dirname, 'public', 'delete-account.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tenant.html')));

// Any unhandled route error comes back as JSON so the apps can surface a real message.
app.use((err, req, res, next) => {
  // An error with no message used to surface as a bare "Server error", which tells
  // nobody anything. Log the whole thing, and never return an empty message.
  console.error(`${req.method} ${req.path} —`, err && (err.stack || err.message || err));
  if (res.headersSent) return next(err);
  const msg = (err && err.message && String(err.message).trim())
    || (err && err.code ? `Something went wrong (${err.code})` : null)
    || 'Something went wrong and the app could not say what. The server log has the detail.';
  res.status(500).json({ error: msg });
});

app.listen(PORT, () => console.log(`PorchPay running on port ${PORT}`));
module.exports = app;
