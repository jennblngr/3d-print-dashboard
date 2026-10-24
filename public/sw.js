// Keeps the app shell available offline. API calls always go to the network.
const CACHE = 'shell-v11';
const SHELL = ['/', '/style.css', '/theme.js', '/app.js', '/select.js', '/i18n.js', '/tigertag.js', '/tigertag-db.js', '/fonts/geist-latin.woff2', '/fonts/geist-latin-ext.woff2', '/fonts/geist-mono-latin.woff2', '/fonts/geist-mono-latin-ext.woff2', '/icon-192.png', '/icons.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(url.pathname, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(url.pathname)) || (e.request.mode === 'navigate' && (await caches.match('/'))) || Response.error())
  );
});
