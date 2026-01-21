// Inter Club Sulmona PWA - Service Worker
// Scopo: cache SOLO degli asset statici dell'app.
// IMPORTANTISSIMO: NON cachiamo mai le Netlify Functions (/.netlify/functions/*),
// perché devono essere SEMPRE fresche per quiz/eventi/bacheca/punti in tempo reale.

const CACHE = 'ics-pwa-v7'; // bump per forzare aggiornamento SW
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './_redirects',
  './data.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))));
      await self.clients.claim();
    })()
  );
});

// Helper: risposta JSON d'errore per quando non c'è internet (per le API)
function offlineJson(status = 503, message = 'Offline') {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) API (Netlify Functions): SEMPRE rete, mai cache.
  if (url.pathname.startsWith('/.netlify/functions/')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => offlineJson(503, 'Connessione assente'))
    );
    return;
  }

  // 2) Navigazioni: ritorna sempre index.html (app shell) ma con aggiornamento rete.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 3) Asset statici: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      });
    })
  );
});
