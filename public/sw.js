/* Service worker de CRT Contable.
   Cachea solo el "shell" (HTML/CSS/JS/iconos). NUNCA cachea /api/*:
   los datos financieros deben venir siempre frescos y no quedar
   accesibles sin sesión en un dispositivo compartido.

   El shell va con stale-while-revalidate: responde al instante desde la
   caché y, en paralelo, se trae la versión nueva para la próxima vez. Antes
   era cache-first puro, así que un despliegue sin cambiar VERSION dejaba a
   la app instalada con el app.js viejo para siempre. */

const VERSION = 'crt-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/tema.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Permite forzar limpieza total (p.ej. al cerrar sesión).
self.addEventListener('message', (e) => {
  if (e.data === 'limpiar-cache') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fuentes u otros orígenes: comportamiento por defecto
  if (url.pathname.startsWith('/api/')) return;     // API: siempre a la red, sin caché

  // El HTML siempre se pide a la red primero: así un despliegue nuevo entra
  // de una, y la caché queda solo como red de seguridad si no hay señal.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copia = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copia));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const enCache = await cache.match(request);
      const enRed = fetch(request)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);

      if (enCache) {
        e.waitUntil(enRed); // se actualiza por detrás para la próxima carga
        return enCache;
      }
      return (await enRed) || fetch(request);
    })
  );
});
