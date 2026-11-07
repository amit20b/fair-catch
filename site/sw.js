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
