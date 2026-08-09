const NOTIFICATION_PREF = 'omnicee_notifications_enabled';

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

export function notificationsEnabled() {
  try { return localStorage.getItem(NOTIFICATION_PREF) !== '0'; } catch (_) { return true; }
}

export async function enableNotifications() {
  if (!notificationsSupported()) return { ok: false, reason: 'Notifications are not supported by this browser' };
  const permission = await Notification.requestPermission();
  const ok = permission === 'granted';
  try { localStorage.setItem(NOTIFICATION_PREF, ok ? '1' : '0'); } catch (_) {}
  return { ok, permission };
}

export async function showWebNotification(notification) {
  if (!notificationsSupported() || !notificationsEnabled()) return false;
  if (Notification.permission !== 'granted') return false;

  const title = notification?.type === 'signal'
    ? `${notification.signal?.action || 'SIGNAL'} ${notification.signal?.symbol || ''}`.trim()
    : (notification?.title || 'OMNICEE Alert');
  const body = notification?.type === 'signal'
    ? `Score ${notification.signal?.score?.final ?? notification.signal?.score ?? '—'} • ${notification.signal?.timeframe || ''}`.trim()
    : String(notification?.message || '');

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, {
      body: body.slice(0, 240),
      tag: `omnicee-${notification?.id || Date.now()}`,
      renotify: true,
      data: { url: '/', signalId: notification?.signal?.id || null },
      requireInteraction: notification?.priority === 'high',
    });
    return true;
  } catch (_) {
    try {
      new Notification(title, { body: body.slice(0, 240), tag: `omnicee-${notification?.id || Date.now()}` });
      return true;
    } catch (_) { return false; }
  }
}

export function attachWebNotificationSocket(socket) {
  if (!socket) return () => {};
  const handler = (notification) => { showWebNotification(notification); };
  socket.on('notification', handler);
  return () => socket.off('notification', handler);
}
