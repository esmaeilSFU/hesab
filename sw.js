// Offline shell: the app's own files are cached; calls to Google are never intercepted.
const VERSION = 'hesab-v14';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'app.css',
  'app.js', 'engine.js', 'api.js', 'format.js', 'charts.js', 'icons.js', 'demo.js', 'data.js', 'install.js', 'google.js', 'track.js', 'qrcode.js', 'privacy.html',
  'icon.svg',
  'hesab-icon.svg',
  'favicon.svg',
  'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for our own files (so updates show up), cache as the fallback when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
