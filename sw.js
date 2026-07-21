const CACHE = 'vertux-workspace-v12';
const ASSETS = ['./', './index.html', './styles.css', './data.js', './auth.js', './app.js', './manifest.webmanifest', './icon.svg', './vendor/supabase.js', './vendor/xlsx.full.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // Network-first: свежая версия всегда побеждает, кэш — запасной для офлайна.
  if (u.origin === location.origin && e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(e.request))
    );
  }
});
