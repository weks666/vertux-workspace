const CACHE = 'vertux-workspace-v18';
const ASSETS = ['./', './index.html', './styles.css', './data.js', './auth.js', './app.js', './manifest.webmanifest', './nexus-product.json', './icon.svg', './vendor/supabase.js', './vendor/xlsx.full.min.js'];
const SHELL_URLS = new Set(ASSETS.map(asset => new URL(asset, self.registration.scope).href));

function cacheable(response) {
  const policy = String(response.headers.get('Cache-Control') || '').toLowerCase();
  return response.ok && response.type === 'basic' && !policy.includes('no-store');
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(cache => Promise.all(ASSETS.map(async asset => {
    const response = await fetch(asset, { cache: 'reload' });
    if (!cacheable(response)) throw new Error('Workspace shell asset is not cacheable: ' + asset);
    await cache.put(asset, response);
  }))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !SHELL_URLS.has(u.href)) return;
  e.respondWith(fetch(e.request).then(response => {
    if (cacheable(response)) {
      const copy = response.clone();
      e.waitUntil(caches.open(CACHE).then(cache => cache.put(e.request, copy)));
    }
    return response;
  }).catch(() => caches.match(e.request)));
});
