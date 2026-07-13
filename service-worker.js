// Service Worker — Gestor de Tareas
// Sube este número de versión cada vez que cambies el HTML/CSS/JS
// para forzar a los dispositivos a bajar la versión nueva.
const CACHE_VERSION = 'v4';
const CACHE_NAME = 'productividad-cache-' + CACHE_VERSION;

// Archivos propios de la app: se guardan en caché apenas se instala
// el service worker, así la app abre instantáneamente y funciona offline.
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './index.js',
  './manifest.json',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
];

// No cachear nunca las llamadas a Supabase (datos y autenticación):
// siempre tienen que ir a la red para que la sincronización sea real.
function isBackendRequest(url) {
  return url.hostname.endsWith('.supabase.co');
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith('productividad-cache-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo manejamos GET; todo lo demás (POST a Sheets, etc.) pasa directo.
  if (req.method !== 'GET') return;

  // La sincronización con Supabase siempre va directo a la red,
  // nunca se sirve ni se guarda en caché.
  if (isBackendRequest(url)) {
    event.respondWith(fetch(req));
    return;
  }

  // Estrategia "stale-while-revalidate": responde rápido con lo que
  // haya en caché (o de la red si no hay nada todavía) y en paralelo
  // actualiza la caché para la próxima vez.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
