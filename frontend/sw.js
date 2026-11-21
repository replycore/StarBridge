// Console service worker: deliberately conservative. It only caches
// the static brand assets and keeps a copy of the app shell so the
// console still opens offline; page data always comes from the
// network, and /config.json is never cached.
var CACHE = 'gw-console-v1';
var STATIC = ['/favicon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/maskable-512.png', '/manifest.webmanifest'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(STATIC); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/config.json' || url.pathname === '/sw.js') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('/', copy); });
      }
      return res;
    }).catch(function () { return caches.match('/'); }));
    return;
  }
  if (STATIC.indexOf(url.pathname) !== -1) {
    e.respondWith(caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request);
    }));
  }
});
