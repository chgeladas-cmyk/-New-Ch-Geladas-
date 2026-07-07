// FIX [ALTO]: Service Worker restaurado com cache offline.
// Estava desativado ("temporariamente para testes") — PWA sem cache = quebrado offline.

const CACHE_NAME = 'ch-geladas-v26';

const ASSETS_STATIC = [
  './',
  './index.html',
  './vendas.html',
  './estoque.html',
  './financeiro.html',
  './aprovacao.html',
  './auditoria.html',
  './fiado.html',
  './saidas.html',
  './ponto.html',
  './comanda.html',
  './delivery.html',
  './cambio.html',
  './cardapio.html',
  './avulsa.html',
  './bi-dashboard.html',
  './monitor.html',
  './core.js',
  './services/permissoesService.js',
  './services/syncService.js',
  './services/auditService.js',
  './services/syncMonitor.js',
  './services/backupService.js',
  './services/userService.js',
  './services/estoqueService.js',
  './services/financeiroService.js',
  './services/vendasService.js',
  './services/aprovacaoService.js',
  './services/firebaseService.js',
  './services/biService.js',
  './services/saasService.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Install: pré-cacheia assets estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_STATIC.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(e => console.warn('[SW] Cache install parcial:', e))
  );
});

// Activate: limpa caches antigos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: Cache-first para assets locais, Network-first para Firebase/CDN
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase, Telegram, APIs externas → sempre network
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('api.telegram.org') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    event.request.method !== 'GET'
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Assets locais → Cache-first com fallback network
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return res;
        });
      })
      .catch(() => caches.match('./index.html')) // fallback offline
  );
});
