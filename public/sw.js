/* Open Room ETHZ service worker: caches the static app shell ONLY.
 * - Reservation data (/api/) is never cached here and is never served from this cache: availability must come from the network
 *   (or from the app's own age-tracked cache), otherwise old data could look current.
 * - Only successful (2xx) same-origin GET responses for known shell files are stored; errors and redirects never are.
 * - Bump CACHE whenever a shell file changes in a way that must reach installed apps (old caches are deleted on activate). */
const CACHE = 'openroom-shell-v4';
const ASSETS = [
  '/', '/index.html', '/styles.css', '/app.js', '/schedule.mjs', '/recommend.mjs', '/timeline.mjs', '/detail-view.mjs',
  '/rooms.json', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png', '/icons/favicon-32.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // data is never handled here
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic' && ASSETS.includes(url.pathname)) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
      }
      return response;
    } catch {
      // offline: the cached shell, and for page navigations the cached start page
      const cached = await caches.match(request, {ignoreSearch: true});
      if (cached) return cached;
      if (request.mode === 'navigate') return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error();
      return Response.error();
    }
  })());
});
