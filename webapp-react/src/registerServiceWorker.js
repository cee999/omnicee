/**
 * registerServiceWorker.js
 * ────────────────────────
 * Registers public/sw.js and — this is the part that was missing before —
 * actually watches for updates and reloads once a new version has taken
 * over, instead of leaving an already-open tab running old JS until the
 * user manually refreshes.
 *
 * Sequence on a fresh deploy, for someone who already has the PWA open:
 *   1. Browser re-fetches sw.js on this navigation (it always does, on
 *      every page load, regardless of any of our caching), byte-compares
 *      it to the currently-installed one. Different bytes → new worker
 *      starts installing in the background (registration.installing).
 *   2. We listen for that via 'updatefound', then watch the new worker's
 *      .state. When it reaches 'installed' *and* navigator.serviceWorker.
 *      controller already exists (i.e. this is an update, not the very
 *      first install on a brand-new device), we know a new version is
 *      ready and waiting.
 *   3. We post it SKIP_WAITING so it activates immediately instead of
 *      waiting for every other open tab to close first.
 *   4. 'controllerchange' fires once it takes over → reload this tab once
 *      (guarded so a second event can't loop us). This is the step that
 *      makes the fix from sw.js's network-first navigation change land in
 *      an already-open tab too, not just on the next cold launch.
 *
 * Combined with sw.js now fetching index.html network-first, this closes
 * both halves of the "have to delete and redownload the app" bug: new
 * installs/relaunches always get current HTML, and already-running tabs
 * self-update within moments of a deploy finishing instead of needing a
 * manual refresh.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  navigator.serviceWorker.register('/sw.js').then((registration) => {
    // Covers the case where a new version finished installing while this
    // tab was in the background (e.g. phone locked overnight) — check the
    // instant we're back, rather than waiting for the next full navigation.
    if (document.visibilityState === 'visible') registration.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          // A previous controller already existed → this is an update, not
          // the first-ever install. Activate it now rather than waiting for
          // every tab to close.
          installing.postMessage('SKIP_WAITING');
        }
      });
    });

    // Covers the case where a worker was already waiting from before this
    // tab even loaded (e.g. it updated in another tab moments earlier).
    if (registration.waiting && navigator.serviceWorker.controller) {
      registration.waiting.postMessage('SKIP_WAITING');
    }
  }).catch(() => { /* PWA install/update just isn't available this session — app still works */ });
}
