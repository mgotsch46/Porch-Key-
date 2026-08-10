// Service worker: receives push while the app is closed, keeps the home-screen icon
// badge in step, and opens the right tab when a notification is tapped.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Porch Pay' }; }

  const title = d.title || 'Porch Pay';
  const options = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || d.kind || 'porchpay',
    renotify: true,
    data: { url: d.url || '/' },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Number on the home-screen icon.
    if (self.navigator && 'setAppBadge' in self.navigator) {
      const n = Number(d.badge || 0);
      try { n > 0 ? await self.navigator.setAppBadge(n) : await self.navigator.clearAppBadge(); } catch {}
    }
    // Nudge any open window so its tab badges refresh immediately.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'refresh-badges' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.postMessage({ type: 'open-url', url }); return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
