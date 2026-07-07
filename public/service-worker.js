const CACHE_NAME = 'timer-sessoes-v122';
// Cache PERMANENTE pra CDNs imutáveis (fontes + Firebase SDK, URLs versionadas).
// Sobrevive a bumps de versão — sem ele, cada update jogava fora fontes+Firebase e a
// primeira abertura re-baixava tudo de 3 hostnames (minutos, com DNS de roteador ruim).
const CDN_CACHE = 'timer-sessoes-cdn-v1';
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
    // Resgata entradas de CDN dos caches de versões antigas (uma vez, na transição
    // pro modelo de cache permanente) antes de apagá-los.
    const keys = await caches.keys();
    const cdn = await caches.open(CDN_CACHE);
    for (const k of keys) {
      if (k === CACHE_NAME || k === CDN_CACHE) continue;
      try {
        const old = await caches.open(k);
        for (const req of await old.keys()) {
          if (!isCacheFirstCdn(new URL(req.url))) continue;
          if (await cdn.match(req)) continue;
          const res = await old.match(req);
          // opaque (status ilegível, pode ser lixo de proxy) não entra no cache permanente
          if (res && res.type !== 'opaque') await cdn.put(req, res);
        }
      } catch {}
    }
    // Poda o CDN_CACHE: versões do SDK que o index.html não usa mais (senão acumulam
    // ~200KB+ por upgrade do Firebase, pra sempre)
    try {
      for (const req of await cdn.keys()) {
        const p = new URL(req.url).pathname;
        if (p.startsWith('/firebasejs/') && !p.startsWith(FIREBASEJS_VER)) await cdn.delete(req);
      }
    } catch {}
    // Apaga caches de versões antigas (o CDN_CACHE fica — é permanente)
    await Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== CDN_CACHE).map((k) => caches.delete(k)));
    // claim() dispara controllerchange nas telas abertas → o app se recarrega sozinho
    // (reload único, guardado). O client.navigate() que morava aqui era uma SEGUNDA
    // navegação forçada disputando com esse reload — removido.
    await self.clients.claim();
  })());
});

// CDNs do caminho crítico do cold start (o portão de login espera fontes + Firebase):
// - IMUTÁVEIS (URLs versionadas: woff2 do fonts.gstatic.com, /firebasejs/<ver>/):
//   cache-first puro no CDN_CACHE — zero rede/DNS depois da primeira carga.
// - CSS do Google Fonts (fonts.googleapis.com/css2?...): URL NÃO versionada (o Google
//   reescreve o conteúdo) → stale-while-revalidate. Refetch sempre em modo CORS pra
//   resposta ter status legível — lixo "opaque" (ex.: portal cativo de Wi-Fi) NUNCA
//   entra no cache permanente.
const FIREBASEJS_VER = '/firebasejs/10.13.1/'; // manter igual ao index.html (poda no activate)
function isFontCss(url) { return url.hostname === 'fonts.googleapis.com'; }
function isImmutableCdn(url) {
  return url.hostname === 'fonts.gstatic.com'
    || (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));
}
function isCacheFirstCdn(url) { return isFontCss(url) || isImmutableCdn(url); }

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (isCacheFirstCdn(url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached && isImmutableCdn(url)) return cached; // imutável: nem tenta rede
        const net = fetch(event.request.url, { mode: 'cors' }).then((response) => {
          if (response && response.ok) { // opaque tem status 0 → nunca passa daqui
            const copy = response.clone();
            caches.open(CDN_CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        });
        if (cached) { net.catch(() => {}); return cached; } // CSS: serve cache, revalida atrás
        return net;
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
