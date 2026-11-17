/* Static shell only. NEVER cache /api/ allocations as offline availability. */
const CACHE='openroom-static-v2';
const ASSETS=['/','/index.html','/styles.css','/app.js','/schedule.mjs','/recommend.mjs','/rooms.json','/manifest.webmanifest','/icons/icon-192.png'];
self.addEventListener('install', event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  event.respondWith(fetch(request).then(response=>{if(response.ok && ASSETS.includes(url.pathname)){const clone=response.clone();void caches.open(CACHE).then(c=>c.put(request,clone));}return response;}).catch(()=>caches.match(request)));
});
