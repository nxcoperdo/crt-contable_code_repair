/* Service worker de CRT Contable.
   Cachea solo el "shell" (HTML/CSS/JS/iconos). NUNCA cachea /api/*:
   los datos financieros deben venir siempre frescos y no quedar
   accesibles sin sesión en un dispositivo compartido. */

const VERSION = 'crt-shell-v2';
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

  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  e.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});
