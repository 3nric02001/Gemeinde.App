/**
 * Service Worker der Gemeinde.App: hält die App-Oberfläche offline bereit.
 * Beim Bauen ersetzt vite.config.ts VERSION und PRECACHE (Dateien des Builds).
 * Die API (/api/...) geht immer an den Server; offline gespeicherte Titel liegen
 * verschlüsselt in IndexedDB und werden in der App entschlüsselt, nicht hier.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `gemeinde-shell-${VERSION}`;
/** Nicht zwingend nötig; fehlt eine davon, soll die Installation trotzdem klappen. */
const OPTIONAL = ['/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      await Promise.all(OPTIONAL.map((url) => cache.add(url).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('gemeinde-shell-') && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;

  // Seiten: immer frisch vom Server, ohne Netz die gespeicherte App (sie hat nur eine Seite).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('/', { cacheName: CACHE })) ?? Response.error()),
    );
    return;
  }

  // Dateien des Builds tragen einen Hash im Namen: aus dem Cache. Das Manifest (Gemeindename) frisch, sonst Cache.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (url.pathname === '/manifest.webmanifest') {
        try {
          const response = await fetch(request);
          if (response.ok) await cache.put(request, response.clone());
          return response;
        } catch {
          return (await cache.match(request)) ?? Response.error();
        }
      }
      return (await cache.match(request)) ?? fetch(request);
    })(),
  );
});
