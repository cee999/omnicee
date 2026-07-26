/**
 * OMNICEE API client
 * ───────────────────
 * Thin wrapper around the real backend documented in api/server.js.
 * Auth: every request/socket connection carries the shared app token via
 * the `x-app-token` header (REST) or `auth.appToken` (socket.io) — the same
 * pattern telegramAuthMiddleware and the io.use() socket middleware both
 * check first, before falling back to Telegram initData. Set it via
 * VITE_APP_TOKEN in your .env (see .env.example).
 *
 * In dev, Vite's proxy (see vite.config.js) forwards /api and /socket.io to
 * the Node backend on localhost:3001, so relative paths work in both dev
 * and the production build served by api/server.js itself.
 */
import { io } from 'socket.io-client';

const APP_TOKEN = import.meta.env.VITE_APP_TOKEN || '';

function authHeaders() {
  return APP_TOKEN ? { 'x-app-token': APP_TOKEN } : {};
}

async function get(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  const url = qs.toString() ? `${path}?${qs}` : path;
  const res = await fetch(url, { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

export const OmniceeAPI = {
  health: () => get('/health'),
  signals: ({ symbol, limit = 50 } = {}) => get('/api/signals', { symbol, limit }),
  outlook: () => get('/api/outlook'),
  heatmap: ({ timeframe } = {}) => get('/api/heatmap', { timeframe }),
  auditTrail: ({ symbol, limit = 50 } = {}) => get('/api/audit-trail', { symbol, limit }),
  journal: (params = {}) => get('/api/journal', params),
  watchlist: ({ limit, timeframe } = {}) => get('/api/watchlist', { limit, timeframe }),
  learning: ({ limit } = {}) => get('/api/learning', { limit }),
  news: ({ symbol, category } = {}) => get('/api/news', { symbol, category }),
  stats: () => get('/api/stats'),
  recordOutcome: (signalId, outcome) => post('/api/outcomes', { signalId, outcome }),
};

/**
 * Opens the live socket and subscribes to the channels the backend actually
 * emits (see io.emit(channel, payload) in api/server.js): signal, market,
 * risk, stats, regime, telemetry, intel — plus the one-off `connected`
 * event and the `history`/`outcome_saved`/`outcome_error` replies to
 * `get_history` / `record_outcome`.
 *
 * `handlers` is a partial map of { channel: (payload) => void }; only the
 * channels you pass are subscribed.
 */
export function connectOmniceeSocket(handlers = {}) {
  const socket = io('/', {
    path: '/socket.io',
    auth: APP_TOKEN ? { appToken: APP_TOKEN } : {},
    transports: ['websocket', 'polling'],
  });

  const channels = ['connected', 'signal', 'market', 'risk', 'stats', 'regime', 'telemetry', 'intel', 'outcome_saved', 'outcome_error'];
  channels.forEach(ch => {
    if (handlers[ch]) socket.on(ch, handlers[ch]);
  });

  socket.getHistory = (payload) => socket.emit('get_history', payload);
  socket.recordOutcome = (payload) => socket.emit('record_outcome', payload);

  return socket;
}
