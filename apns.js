// Apple push, sent straight to Apple.
//
// The iOS shells register through @capacitor/push-notifications, which hands back a raw
// APNs device token — 64 hex characters. Firebase cannot deliver to that: it needs an FCM
// token, which only exists when the Firebase iOS SDK is compiled into the app, and it is
// not. Every send to an iPhone came back "The registration token is not a valid FCM
// registration token", the failures piled up until the token was deleted, and from then
// on every notification short-circuited on "no devices". Texts arrived, nobody's phone
// made a sound.
//
// Talking to Apple directly needs no app rebuild: the token the app already sends is
// exactly what Apple wants. Android tokens are real FCM tokens and keep going to Firebase.
//
// Railway variables:
//   APNS_KEY_P8   the .p8 auth key from Apple, BEGIN/END lines included (literal \n is fine)
//   APNS_KEY_ID   the 10 character Key ID shown next to that key
//   APNS_TEAM_ID  the 10 character Team ID (58M49NYZQY for RenewEQ, LLC)
//   APNS_ENV      optional: 'production' or 'sandbox'. Unset tries production, then
//                 sandbox when Apple says the token belongs to the other one.

const http2 = require('http2');
const crypto = require('crypto');

const HOST_PROD = 'https://api.push.apple.com';
const HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

// Which app a token belongs to decides the topic Apple checks it against.
const BUNDLES = { admin: 'com.porchpay.admin', buyer: 'com.porchpay.app' };

function rawKey() {
  const k = process.env.APNS_KEY_P8 || '';
  return k.includes('\\n') ? k.replace(/\\n/g, '\n') : k;
}
const apnsConfigured = () => !!(rawKey() && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID);
const isApnsToken = (t) => /^[0-9a-f]{64}$/i.test(String(t || ''));

// Apple throttles provider token generation, so one is reused for 45 minutes of its hour.
let tok = null, tokAt = 0;
function providerToken() {
  if (tok && Date.now() - tokAt < 45 * 60 * 1000) return tok;
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  // ES256 in a JWT is the raw r||s signature, not the DER that Node produces by default.
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claim}`),
    { key: rawKey(), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  tok = `${header}.${claim}.${sig}`;
  tokAt = Date.now();
  return tok;
}

function postToApple(host, token, topic, body) {
  return new Promise((resolve) => {
    let client;
    try { client = http2.connect(host); } catch (e) { return resolve({ ok: false, error: e.message }); }
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { client.close(); } catch {} resolve(r); };
    client.on('error', (e) => done({ ok: false, error: e.message }));
    const payload = Buffer.from(JSON.stringify(body));
    const req = client.request({
      ':method': 'POST', ':path': '/3/device/' + token,
      authorization: 'bearer ' + providerToken(),
      'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      'content-type': 'application/json', 'content-length': payload.length,
    });
    let status = 0, data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { data += c; });
    req.on('error', (e) => done({ ok: false, error: e.message }));
    req.on('end', () => {
      if (status === 200) return done({ ok: true });
      let reason = '';
      try { reason = JSON.parse(data).reason || ''; } catch { reason = data.slice(0, 120); }
      done({ ok: false, status, reason, error: `APNs ${status} ${reason}`.trim() });
    });
    req.setTimeout(10000, () => done({ ok: false, error: 'timed out talking to Apple' }));
    req.end(payload);
  });
}

// Same outcomes as the Firebase sender: 'sent', 'gone' for a token that will never work
// again, or a thrown error for anything worth retrying.
async function sendApns(row, { title, body, url, badge, kind }) {
  const topic = BUNDLES[row.app] || BUNDLES.buyer;
  const msg = {
    aps: {
      alert: { title, body: body || '' },
      badge: badge || 0,
      sound: 'default',
      'thread-id': kind || 'general',
    },
    url: url || '/', kind: kind || 'general',
  };
  const pinned = process.env.APNS_ENV;
  const first = pinned === 'sandbox' ? HOST_SANDBOX : HOST_PROD;
  let r = await postToApple(first, row.token, topic, msg);
  // A build signed for the other environment reads as BadDeviceToken. Try the other
  // host once rather than delete a token that is fine.
  if (!r.ok && !pinned && r.reason === 'BadDeviceToken') {
    r = await postToApple(first === HOST_PROD ? HOST_SANDBOX : HOST_PROD, row.token, topic, msg);
  }
  if (r.ok) return 'sent';
  if (['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(r.reason)) return 'gone';
  throw new Error(r.error);
}

module.exports = { apnsConfigured, isApnsToken, sendApns };
