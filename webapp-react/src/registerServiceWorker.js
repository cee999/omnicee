// This is the step that makes the fix from sw.js's network-first navigation change land in an already-open tab too, not just on the next cold launch.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  navigator.serviceWorker.register('/sw.js').then((registration) => {
    if (document.visibilityState === 'visible') registration.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          installing.postMessage('SKIP_WAITING');
        }
      });
    });

    if (registration.waiting && navigator.serviceWorker.controller) {
      registration.waiting.postMessage('SKIP_WAITING');
    }
  }).catch(() => { });
}
