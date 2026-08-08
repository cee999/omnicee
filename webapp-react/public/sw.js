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
 *    - Navigation requests (index.html) are NETWORK-FIRST, not cache-first.
 *    - Hashed build assets (/assets/*-<hash>.js, *-<hash>.css — Vite
 *      content-hashes these, so a changed filename always means changed
 *      content) are cache-first: safe to cache forever, no staleness risk.
 *    - Everything else static (icons, manifest.json) is cache-first with
 *      a background revalidate.
 *
 *  FIX (installed-PWA-goes-blank-after-a-deploy bug): the previous version
 *  served index.html cache-first. Vite fingerprints every JS/CSS chunk
 *  with a content hash, and Render's build replaces dist/ wholesale on
 *  each deploy — old chunk files simply don't exist on the server anymore.
 *  So: user has the PWA installed → we ship a new build → their SW still
 *  serves the OLD cached index.html → that HTML references JS/CSS hashes
 *  from the OLD build → those 404 → blank screen. The only fix the user
 *  had was deleting and reinstalling the app. Network-first navigation
 *  means an online client always gets the index.html matching what's
 *  actually deployed, so this can't happen again; the cached copy is now
 *  purely an offline fallback. See main.jsx's registerServiceWorker() for
 *  the companion piece — it detects a waiting/updated worker and reloads
 *  once, so an already-open tab also self-updates without user action.
 *
 *  CACHE_VERSION is injected at build time from the Vite build hash
 *  (see index.html's inline bootstrap + vite-plugin that writes it — falls
 *  back to a date stamp if that's ever missing) so every deploy gets a
 *  distinct cache automatically; nobody has to remember to hand-bump a
 *  version string. The 'activate' handler purges every cache that isn't
 *  the current one.
 */

const CACHE_VERSION = 'omnicee-shell-__BUILD_ID__';
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

// Lets a client force an already-installed-but-waiting worker to activate
// immediately (main.jsx posts this after showing/auto-confirming an
// "update available" prompt) instead of waiting for all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
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

  // NETWORK-FIRST for navigations (index.html, and any client-side route
  // the browser resolves as a page load). This is the actual fix — see the
  // FIX comment above CACHE_VERSION. Cache is now only an offline fallback,
  // never the first thing an online client sees.
  const isNavigation = event.request.mode === 'navigate' || url.pathname === '/';
  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // CACHE-FIRST for Vite's content-hashed build output (/assets/*-<hash>.js
  // and .css). A given hash is immutable — its content can never change
  // without the filename also changing — so serving it straight from cache
  // with no network round-trip at all is both safe and correctly instant.
  const isHashedAsset = url.pathname.startsWith('/assets/');
  if (isHashedAsset) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else static (icons, manifest.json): cache-first with a
  // background revalidate, same as before — low-risk, rarely changes, and
  // no longer includes index.html now that navigations are handled above.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});


self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
