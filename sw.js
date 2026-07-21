/* Service Worker：缓存应用外壳，保证飞行模式下应用本身可以打开 */
const CACHE = 'kline-offline-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './chart.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  // API 请求不走缓存（行情数据由 IndexedDB 负责离线）
  if (url.origin !== self.location.origin) return;

  // 应用文件：缓存优先，后台刷新
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
