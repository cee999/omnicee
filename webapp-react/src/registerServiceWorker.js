/**
 * Auto-update the installed PWA when a new deploy ships.
 * - Poll for new sw.js
 * - skipWaiting + clients.claim on the new worker
 * - Reload all open tabs once (no reinstall required)
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  let reloaded = false;
  const softReload = () => {
    if (reloaded) return;
    reloaded = true;
    try {
      window.location.reload();
    } catch (_) {}
  };

  // New SW took control → load the new JS/CSS shell
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    softReload();
  });

  // SW can also ask the page to reload after activate
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event?.data?.type === 'SW_UPDATED' || event?.data === 'SW_UPDATED') {
      softReload();
    }
  });

  const activateWaiting = (registration) => {
    const waiting = registration.waiting;
    if (!waiting) return;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    waiting.postMessage('SKIP_WAITING');
  };

  navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      // Immediately check for a newer worker
      registration.update().catch(() => {});

      // When a new worker installs, activate it right away
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') {
            // With an existing controller → update; first install has no controller
            if (navigator.serviceWorker.controller) {
              installing.postMessage({ type: 'SKIP_WAITING' });
              installing.postMessage('SKIP_WAITING');
              activateWaiting(registration);
            }
          }
        });
      });

      if (registration.waiting) activateWaiting(registration);

      // Check again when the tab becomes visible (user returns to the app)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          registration.update().catch(() => {});
          if (registration.waiting) activateWaiting(registration);
        }
      });

      // Periodic check while the app stays open (deploy mid-session)
      setInterval(() => {
        registration.update().catch(() => {});
        if (registration.waiting) activateWaiting(registration);
      }, 60 * 1000);
    })
    .catch(() => {});
}
