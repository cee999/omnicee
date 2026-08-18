/**
 * Auto-update the installed PWA when a new deploy ships.
 * Guard against infinite reload loops (controllerchange + dual registration
 * was the root cause of "frontend just loading and never opens" after commits).
 */
const SW_RELOAD_KEY = 'omnicee_sw_reload_at';
const SW_RELOAD_COOLDOWN_MS = 45 * 1000;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  // SW disabled by default — stale workers caused infinite LOADING after deploys.
  // Re-enable only for PWA tests: localStorage.setItem('omnicee_enable_sw','1')
  try {
    if (localStorage.getItem('omnicee_enable_sw') !== '1') {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      }).catch(() => {});
      return;
    }
  } catch (_) {
    return;
  }
  if (window.__omniceeSwRegistered) return;
  window.__omniceeSwRegistered = true;

  const softReload = () => {
    try {
      const last = Number(sessionStorage.getItem(SW_RELOAD_KEY) || 0);
      if (Date.now() - last < SW_RELOAD_COOLDOWN_MS) return;
      sessionStorage.setItem(SW_RELOAD_KEY, String(Date.now()));
      window.location.reload();
    } catch (_) {
      try { window.location.reload(); } catch (__) {}
    }
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    softReload();
  });

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
      registration.update().catch(() => {});

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            installing.postMessage({ type: 'SKIP_WAITING' });
            activateWaiting(registration);
          }
        });
      });

      if (registration.waiting) activateWaiting(registration);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          registration.update().catch(() => {});
          if (registration.waiting) activateWaiting(registration);
        }
      });

      // Less aggressive than every 60s — reduces update thrash after deploy
      setInterval(() => {
        registration.update().catch(() => {});
        if (registration.waiting) activateWaiting(registration);
      }, 5 * 60 * 1000);
    })
    .catch(() => {});
}
