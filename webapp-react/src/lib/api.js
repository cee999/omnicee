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
  market: ({ symbols } = {}) => get('/api/market', { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols }),
  signals: ({ symbol, limit = 50 } = {}) => get('/api/signals', { symbol, limit }),
  candles: ({ symbol, timeframe = 'H1', limit = 300 } = {}) => get('/api/candles', { symbol, timeframe, limit }),
  outlook: () => get('/api/outlook'),
  heatmap: ({ timeframe } = {}) => get('/api/heatmap', { timeframe }),
  auditTrail: ({ symbol, limit = 50 } = {}) => get('/api/audit-trail', { symbol, limit }),
  journal: (params = {}) => get('/api/journal', params),
  watchlist: ({ limit, timeframe } = {}) => get('/api/watchlist', { limit, timeframe }),
  learning: ({ limit } = {}) => get('/api/learning', { limit }),
  news: ({ symbol, category } = {}) => get('/api/news', { symbol, category }),
  stats: () => get('/api/stats'),
  equityCurve: ({ limit } = {}) => get('/api/equity-curve', { limit }),
  recordOutcome: (signalId, outcome) => post('/api/outcomes', { signalId, outcome }),
};

export function connectOmniceeSocket(handlers = {}) {
  const socket = io('/', {
    path: '/socket.io',
    auth: { appToken: APP_TOKEN || undefined },
    transports: ['websocket', 'polling'],
  });

  const channels = [
    'connected', 'signal', 'notification', 'market', 'risk', 'stats', 'regime', 'telemetry',
    'intel', 'feed_health', 'balance', 'watchlist_update', 'abnormal_market',
    'liquidation_cascade', 'outcome_saved', 'outcome_error',
  ];
  channels.forEach(ch => {
    if (handlers[ch]) socket.on(ch, handlers[ch]);
  });

  socket.getHistory = (payload) => socket.emit('get_history', payload);
  socket.recordOutcome = (payload) => socket.emit('record_outcome', payload);

  return socket;
}
