/**
 * ============================================================
 *  SERVICE WORKER — OMNICEE PWA
 * ============================================================
 *
 *  Caching strategy is deliberately conservative because this is a live
 *  trading tool, not a content site: showing a cached (stale) signal,
 *  price, or risk state as if it were current would be actively
 *  misleading, not just an inconvenience. So:
 *
 *    - NEVER cache anything under /api/, /socket.io/, or /health. Every
 *      data request always goes to the network, full stop. If the
 *      network is unavailable, the request fails visibly (the app's own
 *      existing error handling shows disconnected/stale-data states) —
 *      it never silently falls back to a cached response that could look
 *      current.
 *    - Cache-first ONLY for the static app shell: index.html, the icon
 *      set, and manifest.json. These make the PWA installable and let it
 *      at least render its shell offline, with the app's own UI then
 *      showing a disconnected state (it already has connect/disconnect
 *      Socket.IO handling) rather than the browser's blank error page.
 *
 *  Bump CACHE_VERSION on any static-asset change that needs old caches
 *  invalidated — the 'activate' handler purges anything not matching.
 */

const CACHE_VERSION = 'omnicee-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept anything data-related — always hit the network live.
  // This is the load-bearing safety property of this whole file.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname === '/health'
  ) {
    return; // let the browser handle it normally, no caching involved
  }

  // Only handle same-origin GET requests for the shell/static assets below;
  // everything else (including cross-origin CDN scripts) passes through
  // untouched rather than risking a stale cached script.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          // Keep the shell cache fresh in the background on every successful
          // load, so the next offline launch reflects the last-seen version.
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached → this rejects, handled below

      // Cache-first for instant shell load; network still runs in the
      // background above to keep the cache current for next time.
      return cached || networkFetch;
    })
  );
});
