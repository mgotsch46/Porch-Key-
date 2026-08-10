// Notifications: an in-app feed that drives badge counts, plus web push so a buyer
// hears about it when the app is closed.
//
// Push works in installed web apps — Android Chrome, desktop Chrome/Edge, and iOS 16.4+
// once the app is added to the home screen. Safari in a browser tab cannot receive push;
// that is an Apple restriction, not something the app controls. The in-app feed and badge
// counts always work, so nothing depends on push being available.

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
      console.log('Generated VAPID keys for push notifications');
    }
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@porchpay.app';
  webpush.setVapidDetails(subject, pub, priv);
  return { publicKey: pub };
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

  const subs = all('SELECT * FROM push_subscriptions WHERE user_id=?', userId);
  if (!subs.length) return r.lastInsertRowid;
  vapid();
  const unread = unreadCount(userId).total;
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

module.exports = { vapid, notify, unreadCount, markRead, list, subscribe, unsubscribe, setPrefs, prefsFor, KINDS };
