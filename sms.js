// Text messaging via Twilio. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM_NUMBER to send automatically. Without them the app still creates the
// invitation and hands the admin a ready-to-send message they can paste into their
// own phone — nothing blocks on Twilio being configured.
//
// The outbound number is send-only. Buyers who reply get one automatic answer pointing
// them back into the app, and every message carries a STOP line because US carriers
// require an opt-out on automated business texting.

// A company's own Twilio details win; the environment is the fallback. This means a
// servicer can connect texting from inside the app without touching the host.
function creds(company) {
  if (company && company.twilio_sid && company.twilio_token && company.twilio_from) {
    return { sid: company.twilio_sid, token: company.twilio_token, from: company.twilio_from,
             source: 'company' };
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
    return { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN,
             from: process.env.TWILIO_FROM_NUMBER, source: 'env' };
  }
  return null;
}

const smsEnabled = (company) => !!creds(company);

// Normalize to E.164 for US numbers; pass through anything already prefixed.
function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^\d+]/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return d ? '+' + d : null;
}

async function sendSms(to, body, company) {
  const number = normalizePhone(to);
  if (!number) throw new Error('That phone number does not look valid');
  const c = creds(company);
  if (!c) throw new Error('Texting is not connected yet — add your Twilio details under Settings → Texting');
  const params = new URLSearchParams({ To: number, From: c.from, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(twilioError(json, res.status));
  return json;
}

// The in-app dialer, done as a call bridge: Twilio rings the admin's own phone first,
// and when they answer it dials the other party and joins the legs. No app picker, no
// browser microphone, no SDK — and the person called sees the business number, never
// the admin's cell. The phone in your hand is just the handset; the program placed
// the call.
async function placeCall(to, adminPhone, company, { announce } = {}) {
  const number = normalizePhone(to);
  const mine = normalizePhone(adminPhone);
  if (!number) throw new Error('That phone number does not look valid');
  if (!mine) throw new Error('Your own phone number does not look valid');
  const c = creds(company);
  if (!c) throw new Error('Calling is not connected yet — add your Twilio details under Settings → Texting');
  const who = String(announce || 'your contact').replace(/[<>&"]/g, ' ').slice(0, 60);
  const twiml = `<Response><Say voice="alice">Connecting you to ${who}. One moment.</Say>` +
    `<Dial callerId="${c.from}" timeout="25">${number}</Dial></Response>`;
  const params = new URLSearchParams({ To: mine, From: c.from, Twiml: twiml });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(twilioError(json, res.status));
  return { sid: json.sid, my_phone: mine, to: number };
}

// The softphone's access token: a JWT with a voice grant, signed with the API key
// secret. Three base64url parts and an HMAC — Twilio's SDK on the other end does the
// same arithmetic, so no library is needed on this end.
const crypto = require('node:crypto');
const b64url = (input) => Buffer.from(input).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function voiceToken({ accountSid, keySid, keySecret, appSid, identity }) {
  if (!accountSid || !keySid || !keySecret || !appSid) throw new Error('Softphone is not fully configured');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' }));
  const payload = b64url(JSON.stringify({
    jti: `${keySid}-${now}`, iss: keySid, sub: accountSid, iat: now, exp: now + 3600,
    grants: { identity, voice: { outgoing: { application_sid: appSid } } },
  }));
  const sig = b64url(crypto.createHmac('sha256', keySecret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

// Twilio's error codes are famously opaque. Translate the ones that actually happen.
function twilioError(json, status) {
  const code = json && json.code;
  const map = {
    20003: 'Twilio rejected the credentials. Check the Account SID and Auth Token.',
    21211: 'That mobile number is not valid.',
    21606: 'That "from" number cannot send texts. Use a Twilio number you own with SMS enabled.',
    21608: 'Your Twilio trial can only text verified numbers. Upgrade the account or verify this number in Twilio first.',
    21610: 'That person replied STOP, so they are unsubscribed. They have to text START to receive messages again.',
    21614: 'That number cannot receive texts — it looks like a landline.',
    30007: 'The carrier filtered the message. This usually means A2P 10DLC registration is incomplete.',
  };
  return map[code] || (json && json.message) || `Twilio error ${status}`;
}

// A quick credential check that does not send anything.
async function verifyCreds({ sid, token, from }) {
  if (!sid || !token || !from) throw new Error('All three Twilio values are needed');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(twilioError(json, res.status));
  return { account: json.friendly_name || sid, status: json.status };
}

// The invitation a tenant buyer receives the day their home is sold to them.
function inviteMessage({ buyerName, companyName, address, url, email, tempPassword }) {
  const first = (buyerName || '').trim().split(/\s+/)[0] || 'there';
  return `Hi ${first} — congratulations on ${address}!

${companyName} uses Porch Pay to handle your payments and paperwork.

Open this on your phone:
${url}

Sign in with:
Email: ${email}
Temporary password: ${tempPassword}

You'll pick your own password on first sign-in. iPhone: tap Share then "Add to Home Screen". Android: tap the menu then "Install app".

In the app you can see your balance and payment schedule, pay by card, bank, Cash App or cash at a store, and message us any time.

This is an automated message from an unmonitored number — please don't reply here. Message us in the app instead. Reply STOP to opt out of texts.`;
}

// What anyone who texts the number back receives. Sent once per conversation by Twilio's
// webhook, so a buyer who replies is not left thinking nobody heard them.
const AUTO_REPLY = `This number doesn't receive messages. To reach ${'{company}'}, open the Porch Pay app and use Messages — we answer there. Reply STOP to opt out.`;

function autoReplyTwiml(companyName) {
  const body = AUTO_REPLY.replace('{company}', companyName || 'your servicer');
  const esc = (t) => String(t).replace(/[<>&'"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc(body)}</Message></Response>`;
}

module.exports = { smsEnabled, sendSms, placeCall, voiceToken, normalizePhone, inviteMessage, autoReplyTwiml, creds, verifyCreds };
