// Notifications: an in-app feed that drives badge counts, plus push so a buyer hears
// about it when the app is closed.
//
// Two transports, because there are two ways to have this app.
//
//   Web push, over VAPID, for a browser or a home-screen PWA — Android Chrome, desktop
//   Chrome and Edge, and iOS 16.4+ once added to the home screen. Safari in a plain tab
//   cannot receive it; that is Apple's restriction, not ours.
//
//   Native push, over Firebase, for the App Store and Play builds. A Capacitor app
//   cannot use web push at all — iOS reserves it for Safari's own home-screen apps and
//   Android's WebView does not expose the API — so the shells register a device token
//   and FCM delivers, reaching iOS through APNs so there is no Apple certificate to
//   keep renewing.
//
// A person may have both. A notification goes to everything they have registered.
//
// The in-app feed and the badge counts always work, so nothing depends on push being
// configured at all.

const webpush = require('web-push');
const crypto = require('crypto');
const { get, all, run } = require('./db');

// ---------- VAPID keys ----------
// Generated once and kept in settings so subscriptions survive restarts. Set
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the environment to pin them yourself.
function vapid() {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const rowPub = get("SELECT value FROM settings WHERE key='vapid_public'");
    const rowPriv = get("SELECT value FROM settings WHERE key='vapid_private'");
    if (rowPub && rowPriv) { pub = rowPub.value; priv = rowPriv.value; }
    else {
      const keys = webpush.generateVAPIDKeys();
      run("INSERT OR REPLACE INTO settings (key,value) VALUES ('vapid_public',?)", keys.publicKey);
      run("INSERT OR REPLACE INTO settings (key,value) VALUES ('vapid_private',?)", keys.privateKey);
      pub = keys.publicKey; priv = keys.privateKey;
      // These now live only on the data volume. If that volume is ever recreated, or
      // restored from a snapshot taken before this moment, a fresh pair is generated
      // and every subscription already out there silently stops delivering — no error,
      // just nothing arriving. Pinning them in the environment makes that impossible.
      console.log('Generated VAPID keys for push notifications.');
      console.log('  Pin these as VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY so existing');
      console.log('  subscriptions survive a volume restore:');
      console.log('  VAPID_PUBLIC_KEY=' + keys.publicKey);
    }
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@porchpay.app';
  webpush.setVapidDetails(subject, pub, priv);
  return { publicKey: pub };
}

// ---------- native push: Firebase Cloud Messaging ----------
// The store apps cannot receive web push, so they register an FCM token instead and
// notifications go out through Firebase. FCM delivers to Android directly and to iOS
// through APNs, so one sender covers both and there is no Apple certificate to renew.
//
// Credentials come from a Firebase service-account JSON, either as a file path or
// pasted whole into an environment variable — Railway has no filesystem to upload to,
// so the pasted form is the one that gets used in practice.
//
// Everything here is optional. With no credentials configured, native push is simply
// not attempted and web push carries on exactly as before.
let fcmCreds = null;
function firebaseCreds() {
  if (fcmCreds !== null) return fcmCreds;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
    || (process.env.FIREBASE_SERVICE_ACCOUNT_FILE
        && require('fs').readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8'));
  if (!raw) { fcmCreds = false; return false; }
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!j.client_email || !j.private_key || !j.project_id) throw new Error('missing fields');
    fcmCreds = j;
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT is set but could not be read:', e.message);
    fcmCreds = false;
  }
  return fcmCreds;
}
const nativePushEnabled = () => !!firebaseCreds();

// A Google OAuth token, signed with the service account key. Cached until shortly
// before it expires — minting one per notification would be a round trip nobody needs.
let fcmToken = null, fcmTokenExpires = 0;
async function fcmAccessToken() {
  const creds = firebaseCreds();
  if (!creds) return null;
  if (fcmToken && Date.now() < fcmTokenExpires - 60000) return fcmToken;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${signer.sign(creds.private_key, 'base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`Firebase auth failed: ${j.error_description || j.error || r.status}`);
  fcmToken = j.access_token;
  fcmTokenExpires = Date.now() + (j.expires_in || 3600) * 1000;
  return fcmToken;
}

// One notification to one device. Returns 'gone' when Firebase says the token is dead,
// so the caller can drop it rather than keep trying forever.
async function sendToDevice(row, { title, body, url, badge, kind }) {
  const creds = firebaseCreds();
  if (!creds) return 'skipped';
  const token = await fcmAccessToken();
  const message = {
    message: {
      token: row.token,
      notification: { title, body: body || '' },
      // The tap target and the badge count travel as data so the app can route to the
      // right screen instead of just opening at the top.
      data: { url: url || '/', kind: kind || 'general', badge: String(badge || 0) },
      apns: {
        payload: { aps: { badge: badge || 0, sound: 'default', 'content-available': 1 } },
      },
      android: { notification: { sound: 'default' }, priority: 'high' },
    },
  };
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (r.ok) return 'sent';
  const err = await r.json().catch(() => ({}));
  const status = (err.error && err.error.status) || '';
  // The app was uninstalled, or the token was reissued.
  if (r.status === 404 || status === 'NOT_FOUND' || status === 'UNREGISTERED') return 'gone';
  throw new Error(`FCM ${r.status}: ${(err.error && err.error.message) || 'unknown'}`);
}

const KINDS = {
  message: { icon: '💬', tab: 'msgs' },
  document: { icon: '📁', tab: 'docs' },
  payment_due: { icon: '💵', tab: 'pay' },
  payment_late: { icon: '⏰', tab: 'pay' },
  payment_received: { icon: '✅', tab: 'home' },
  notice: { icon: '📄', tab: 'home' },
  general: { icon: '🔔', tab: 'home' },
};

// Buyers can turn any category off. Defaults to everything on.
function prefsFor(userId) {
  const u = get('SELECT notify_prefs FROM users WHERE id=?', userId);
  let p = {};
  try { p = u && u.notify_prefs ? JSON.parse(u.notify_prefs) : {}; } catch {}
  return {
    message: p.message !== false,
    document: p.document !== false,
    payment_due: p.payment_due !== false,
    payment_late: p.payment_late !== false,
    payment_received: p.payment_received !== false,
    notice: p.notice !== false,
    general: true,
  };
}

// Records the notification, then tries to push it. The record is what the badge
// counts read, so a failed push never loses the notification.
async function notify(userId, { kind, title, body, url, dedupeKey }) {
  if (!userId) return null;
  if (dedupeKey && get('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=?', userId, dedupeKey)) {
    return null;
  }
  const k = KINDS[kind] ? kind : 'general';
  const r = run(`INSERT INTO notifications (user_id, kind, title, body, url, dedupe_key)
    VALUES (?,?,?,?,?,?)`, userId, k, title, body || null, url || null, dedupeKey || null);

  if (!prefsFor(userId)[k]) return r.lastInsertRowid;   // recorded, but stays quiet

  // Two transports, one notification. A person may have the web app on a laptop and a
  // store app on their phone, and both should light up. Either list being empty is
  // ordinary, not an error — the notification is already recorded either way, which is
  // what the badge counts and the in-app feed read.
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id=?', userId);
  const devices = all('SELECT * FROM device_tokens WHERE user_id=?', userId);
  if (!subs.length && !devices.length) return r.lastInsertRowid;

  const unread = unreadCount(userId).total;

  // ---- web push: browsers and installed PWAs ----
  if (subs.length) {
    vapid();
    const payload = JSON.stringify({
      title, body: body || '', url: url || '/', kind: k, badge: unread,
      tag: k + '-' + (dedupeKey || r.lastInsertRowid),
    });
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      } catch (e) {
        // 404/410 mean the browser dropped the subscription — clean it up.
        if (e.statusCode === 404 || e.statusCode === 410) {
          run('DELETE FROM push_subscriptions WHERE id=?', s.id);
        } else {
          console.error('Push failed for user', userId, e.statusCode || e.message);
        }
      }
    }
  }

  // ---- native push: the App Store and Play builds ----
  if (devices.length && nativePushEnabled()) {
    for (const d of devices) {
      try {
        const outcome = await sendToDevice(d, { title, body, url, badge: unread, kind: k });
        if (outcome === 'gone') {
          // The app was uninstalled or the token was reissued. Nothing to keep.
          run('DELETE FROM device_tokens WHERE id=?', d.id);
        } else if (outcome === 'sent') {
          run("UPDATE device_tokens SET last_seen_at=datetime('now'), failures=0 WHERE id=?", d.id);
        }
      } catch (e) {
        // A transient failure should not cost somebody their notifications, but a token
        // that keeps failing is dead weight on every send from here on.
        const fails = (d.failures || 0) + 1;
        if (fails >= 10) run('DELETE FROM device_tokens WHERE id=?', d.id);
        else run('UPDATE device_tokens SET failures=? WHERE id=?', fails, d.id);
        console.error('Native push failed for user', userId, e.message);
      }
    }
  }
  return r.lastInsertRowid;
}

function unreadCount(userId) {
  const rows = all(`SELECT kind, COUNT(*) c FROM notifications
    WHERE user_id=? AND read_at IS NULL GROUP BY kind`, userId);
  const by = {};
  let total = 0;
  for (const r of rows) { by[r.kind] = r.c; total += r.c; }
  return {
    total,
    by_kind: by,
    // What the buyer app puts on each tab.
    tabs: {
      msgs: by.message || 0,
      docs: by.document || 0,
      pay: (by.payment_due || 0) + (by.payment_late || 0),
      home: (by.notice || 0) + (by.payment_received || 0) + (by.general || 0),
    },
  };
}

function markRead(userId, { id, kind }) {
  if (id) run("UPDATE notifications SET read_at=datetime('now') WHERE id=? AND user_id=?", id, userId);
  else if (kind) run("UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND kind=? AND read_at IS NULL", userId, kind);
  else run("UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL", userId);
}

function list(userId, limit = 40) {
  return all(`SELECT id, kind, title, body, url, read_at, created_at
    FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ?`, userId, limit);
}

function subscribe(userId, sub) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error('Invalid subscription');
  run(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES (?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,
         p256dh=excluded.p256dh, auth=excluded.auth`,
    userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

function unsubscribe(endpoint) {
  run('DELETE FROM push_subscriptions WHERE endpoint=?', endpoint);
}

function setPrefs(userId, prefs) {
  run('UPDATE users SET notify_prefs=? WHERE id=?', JSON.stringify(prefs || {}), userId);
}

module.exports = { vapid, notify, nativePushEnabled, unreadCount, markRead, list, subscribe, unsubscribe, setPrefs, prefsFor, KINDS };
