const CACHE_NAME = 'tra-search-cache-v1';
const urlsToCache = [
    './index.html',
    './manifest.json',
    // 雖然外部資源一般不快取，但為了功能運行，我們快取主要的 CSS 和 JS
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&display=swap',
    // 請記得把你的圖示檔案路徑也加進來，例如：
    './icon-192x192.png',
    './icon-512x512.png'
];

// 安裝 Service Worker 並快取資源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// 攔截網路請求，優先從快取中回應
self.addEventListener('fetch', event => {
  // 忽略跨域的 API 請求，我們只快取靜態資源
  if (event.request.url.startsWith('https://tdx.transportdata.tw')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 快取中有資源則直接回傳
        if (response) {
          return response;
        }
        // 快取中沒有則嘗試發出網路請求
        return fetch(event.request);
      })
  );
});

// 清理舊的快取
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});