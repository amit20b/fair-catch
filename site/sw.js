/* Fair Catch: opens straight from the device, then checks for a newer version in the background.
   Only this site's own files are kept. The admin page and anything from other sites (Sleeper, Yahoo, the account server) are never stored here. */
const CACHE = 'fc-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
const stamp = (r) => r && (r.headers.get('etag') || r.headers.get('last-modified') || '');
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/admin\.html$/.test(url.pathname) || url.pathname.endsWith('/sw.js')) return;
  const page = req.mode === 'navigate';
  const key = page ? url.origin + url.pathname : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key, { ignoreSearch: page });
    const fresh = fetch(req, page ? { cache: 'no-cache' } : {}).then(async (res) => {
      if (res && res.ok && res.type === 'basic') {
        await cache.put(key, res.clone());
        if (page && hit && stamp(hit) && stamp(res) !== stamp(hit)) {
          for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'fc-updated' });
        }
      }
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(fresh); return hit; }
    return (await fresh) || new Response('You are offline. Open Fair Catch again when you are back online.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  })());
});

// the app asks this when it comes back to the screen: compare the page with the stored one and say if it changed
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'fc-check') return;
  e.waitUntil((async () => {
    const key = new URL('./', self.registration.scope).href;
    const cache = await caches.open(CACHE), hit = await cache.match(key, { ignoreSearch: true });
    const res = await fetch(key, { cache: 'no-cache' }).catch(() => null);
    if (!res || !res.ok || res.type !== 'basic') return;
    await cache.put(key, res.clone());
    if (hit && stamp(hit) && stamp(res) !== stamp(hit)) for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'fc-updated' });
  })());
});

// phone alerts from the fair-catch-push server: show them, and open the right screen when tapped
self.addEventListener('push', (e) => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch (err) { m = { title: 'Fair Catch', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Fair Catch', { body: m.body || '', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: m.url || './' }, tag: m.tag || undefined }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './', go = (url.split('#')[1] || '');
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) { if (c.url.startsWith(self.registration.scope)) { await c.focus(); if (go) c.postMessage({ type: 'fc-open', go }); return; } }
    await self.clients.openWindow(url);
  })());
});
