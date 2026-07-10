const CACHE_NAME = 'geo-api-v3';
const STATIC_ASSETS = [
  '/',
  '/assets/css/global.css',
  '/assets/css/tokens.css',
  '/assets/js/copy-code.js',
  '/assets/js/checkbox.js',
  '/assets/js/accordion.js',
  '/assets/js/mermaid-init.js',
  '/assets/img/logo.svg',
  '/assets/img/icon-192.png',
  '/manifest.json',
];

// Install: pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy
self.addEventListener('fetch', event => {
  const { request } = event;

  // Never cache non-GET requests (Cache.put only supports GET)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== location.origin) return;

  const isHTML = request.headers.get('accept')?.includes('text/html');
  const isAsset = /\.(css|js|png|svg|ico|woff2?)$/.test(url.pathname);

  if (isHTML) {
    // Network-first for HTML pages
    event.respondWith(
      fetch(request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request))
    );
  } else if (isAsset) {
    // Stale-while-revalidate for static assets
    event.respondWith(
      caches.match(request).then(cached => {
        const network = fetch(request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});

