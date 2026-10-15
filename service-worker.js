/* ================================================================
   GROENKLIMAAT — SOLAR CALCULATOR
   Service Worker v1.0.8
   Doel:
     - offline caching van de volledige app
     - network-first voor HTML (updates direct zichtbaar)
     - cache-first voor assets (snel + offline)
     - nooit cachen: externe CDN's en API-routes
   ================================================================ */
'use strict';

const CACHE_VERSION = 'v1.0.8';
const CACHE_NAME = 'groenklimaat-solar-' + CACHE_VERSION;

/* Bestanden die bij installatie in de cache gaan */
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './manifest.json',
  './solar-config.json',
  './icon.svg',
  './icon_512x512_192x192.png',
  './icon_512x512_512x512.png'
];

/* Paden die NOOIT gecached mogen worden (dynamisch, API's) */
const NEVER_CACHE = [
  '/api/proxy',
  '/api/config',
  '/api/test',
  '/api/health'
];

/* Externe hosts — altijd via netwerk (CDN's) */
const EXTERNAL_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

/* ================================================================
   1. INSTALL — precache alle statische assets
   ================================================================ */
self.addEventListener('install', (event) => {
  console.log('[SW] Installeren…', CACHE_VERSION);

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Precache vullen:', PRECACHE_ASSETS.length, 'bestanden');
        return Promise.all(
          PRECACHE_ASSETS.map((url) =>
            cache.add(url).catch((err) =>
              console.warn('[SW] Kon niet precachen:', url, err)
            )
          )
        );
      })
      .then(() => self.skipWaiting())
      .catch((err) => console.error('[SW] Precache mislukt:', err))
  );
});

/* ================================================================
   2. ACTIVATE — oude caches opruimen
   ================================================================ */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activeren…');

  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log('[SW] Oude cache verwijderen:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ================================================================
   3. FETCH — routering van verzoeken
   ================================================================ */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 3a. Alleen GET-verzoeken cachen
  if (request.method !== 'GET') return;

  // 3b. API-routes nooit cachen
  if (NEVER_CACHE.some((path) => url.pathname.startsWith(path))) return;

  // 3c. Externe CDN's nooit cachen
  if (EXTERNAL_HOSTS.some((host) => url.hostname === host)) return;

  // 3d. Andere origine → niet cachen
  if (url.origin !== self.location.origin) return;

  // 3e. HTML-navigatie → network-first
  const isHtml =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');

  if (isHtml) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 3f. Config JSON → network-first
  if (url.pathname.endsWith('solar-config.json') ||
      url.pathname.endsWith('manifest.json')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 3g. Alle andere assets → cache-first
  event.respondWith(cacheFirst(request));
});

/* ================================================================
   4. STRATEGIE: Network-first
   ================================================================ */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;

    // Navigatie-fallback
    if (request.mode === 'navigate') {
      const fallback =
        (await cache.match('./index.html')) ||
        (await cache.match('./'));
      if (fallback) return fallback;
    }

    return new Response('Offline — niet in cache', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/* ================================================================
   5. STRATEGIE: Cache-first
   ================================================================ */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch (err) {
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Offline — niet in cache', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/* ================================================================
   6. MESSAGE — communicatie met de pagina
   ================================================================ */
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => {
          if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({ ok: true, cleared: true });
          }
        })
    );
    return;
  }

  if (data.type === 'GET_VERSION') {
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({
        ok: true,
        version: CACHE_VERSION,
        cacheName: CACHE_NAME
      });
    }
  }
});

/* ================================================================
   7. PUSH — optionele notificaties
   ================================================================ */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = { title: 'GroenKlimaat', body: '' };
  try {
    payload = Object.assign(payload, event.data.json());
  } catch {
    payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icon_512x512_192x192.png',
      badge: './icon_512x512_192x192.png',
      vibrate: [100, 50, 100]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
