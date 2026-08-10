// Text messaging via Twilio. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM_NUMBER to send automatically. Without them the app still creates the
// invitation and hands the admin a ready-to-send message they can paste into their
// own phone — nothing blocks on Twilio being configured.
//
// The outbound number is send-only. Buyers who reply get one automatic answer pointing
// them back into the app, and every message carries a STOP line because US carriers
// require an opt-out on automated business texting.

const smsEnabled = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);

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

async function sendSms(to, body) {
  const number = normalizePhone(to);
  if (!number) throw new Error('That phone number does not look valid');
  if (!smsEnabled()) throw new Error('Texting is not configured — set the Twilio variables to send automatically');
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const params = new URLSearchParams({ To: number, From: process.env.TWILIO_FROM_NUMBER, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `Twilio error ${res.status}`);
  return json;
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

module.exports = { smsEnabled, sendSms, normalizePhone, inviteMessage, autoReplyTwiml };
