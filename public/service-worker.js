const CACHE_NAME = 'timer-sessoes-v108';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Apaga caches de versões antigas
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Destrava dispositivos presos em versões antigas: força reload das telas abertas.
    // (a primeira vez que esta versão ativar; depois o app já tem auto-reload próprio)
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      try { await client.navigate(client.url); } catch {}
    }
  })());
});

// Stale-while-revalidate: serve do cache na hora (rápido) e atualiza em background.
// A versão nova aparece na próxima abertura — sem espera de rede no carregamento.
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Fontes do Google (CSS + woff2): cache-first — o app abre com as fontes do tema mesmo
  // offline/rede ruim, e o CSS de fontes sai do caminho crítico do cold start.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const net = fetch(event.request).then((response) => {
          // respostas de fonte podem ser opacas (type 'opaque'); cacheamos mesmo assim
          if (response && (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  // Demais requisições cross-origin (Worker/Firebase): passa direto.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached || caches.match('./index.html'));
      // Cache primeiro (instantâneo); rede em background. Sem cache → espera a rede.
      return cached || fetchPromise;
    })
  );
});
