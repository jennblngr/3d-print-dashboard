// Keeps the app shell available offline, and shows the owner's notifications. API calls always
// go to the network.
// The server fills in the files of the built app and their version (see SHELL in server.js):
// a new version of the app replaces the cache of the previous one.
const CACHE = 'shell-__VERSION__';
const SHELL = __SHELL__;

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

// A notification sent by the server (see notifyOwner in server.js). Tapping it opens the app on
// the page it names, in the window already open if there is one.
self.addEventListener('push', e => {
  let message = {};
  try {
    message = e.data.json();
  } catch {}
  e.waitUntil(self.registration.showNotification(message.title || '3D Print Dashboard', {
    body: message.body || '',
    icon: '/icon-192.png',
    tag: message.tag,
    data: { url: typeof message.url === 'string' && message.url.startsWith('/') ? message.url : '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const open = (await clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .find(c => new URL(c.url).origin === self.location.origin && !new URL(c.url).pathname.startsWith('/g/'));
    if (!open) return clients.openWindow(url);
    await open.focus();
    return open.navigate(url).catch(() => open.postMessage({ url }));
  })());
});
