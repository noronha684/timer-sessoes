const CACHE_NAME = 'timer-sessoes-v40';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './firebase-config.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: tenta a versão nova da rede; usa cache só se estiver offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Só intervém em requisições do próprio app (mesma origem). API externa (Worker/Firebase) passa direto.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() =>
      // Offline → cai pro cache (ou index.html como fallback de navegação)
      caches.match(event.request).then((cached) => cached || caches.match('./index.html'))
    )
  );
});
