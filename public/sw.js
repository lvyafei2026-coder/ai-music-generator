// AI Music Generator — Service Worker
var CACHE_NAME = 'ai-music-v1';
var PRECACHE = [
  '/music/',
  '/music/index.html',
  '/music/css/style.css',
  '/music/js/i18n.js',
  '/music/js/home.js',
  '/music/locales/en.json',
  '/music/locales/zh.json',
  '/music/icon-192.png',
  '/music/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE).catch(function () {
        // 忽略单个文件失败
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // 只缓存自己的静态资源，跳过 API、音频、外部链接
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/api/') !== -1) return;
  if (url.pathname.indexOf('.mp3') !== -1) return;

  e.respondWith(
    caches.match(e.request).then(function (cached) {
      var network = fetch(e.request).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(e.request, clone);
          });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
