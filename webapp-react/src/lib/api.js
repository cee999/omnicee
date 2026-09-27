"""Enhanced API client with diagnostics endpoints."""

const API_BASE = import.meta.env.VITE_API_BASE || window.location.origin;
const SOCKET_URL = `${API_BASE.replace(/^http/, 'ws')}`;

const get = async (path, params) => {
  const q = new URLSearchParams(params).toString();
  const url = q ? `${path}?${q}` : path;
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

const post = async (path, body) => {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

export const api = {
  // Health & Diagnostics (NEW)
  health: () => get('/health'),
  healthDetailed: () => get('/health/detailed'),
  diagnostics: () => get('/api/diagnostics'),
  systemStatus: () => get('/api/system-status'),

  // Core Data
  market: ({ symbols } = {}) => get('/api/market', { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols }),
  signals: ({ symbol, limit = 50 } = {}) => get('/api/signals', { symbol, limit }),
  stats: () => get('/api/stats'),
  candles: ({ symbol, timeframe = 'H1', limit = 300 } = {}) => get('/api/candles', { symbol, timeframe, limit }),
  outlook: () => get('/api/outlook'),
  heatmap: ({ timeframe } = {}) => get('/api/heatmap', { timeframe }),
  auditTrail: ({ symbol, limit = 50 } = {}) => get('/api/audit-trail', { symbol, limit }),
  journal: (params = {}) => get('/api/journal', params),
  watchlist: ({ limit, timeframe } = {}) => get('/api/watchlist', { limit, timeframe }),
  learning: ({ limit } = {}) => get('/api/learning', { limit }),
  news: ({ symbol, category } = {}) => get('/api/news', { symbol, category }),
  equityCurve: ({ limit } = {}) => get('/api/equity-curve', { limit }),
  recordOutcome: (signalId, outcome) => post('/api/outcomes', { signalId, outcome }),
};

// WebSocket Singleton
let socket = null;

export const initSocket = (token) => {
  if (socket) return socket;
  socket = new WebSocket(`${SOCKET_URL}/ws?token=${token}`);
  socket.handlers = {};
  socket.on = (event, handler) => { socket.handlers[event] = handler; };
  socket.emit = (event, payload) => { socket.send(JSON.stringify({ event, payload })); };
  socket.onmessage = (msg) => {
    const { event, payload } = JSON.parse(msg.data);
    const handler = socket.handlers[event];
    if (handler) handler(payload);
  };
  socket.onerror = () => { socket = null; };
  socket.onclose = () => { socket = null; };
  return socket;
};

export const getSocket = () => socket;

export const closeSocket = () => {
  if (socket) {
    socket.close();
    socket = null;
  }
};

if (socket && socket.handlers) {
  socket.getAccountState = (payload) => socket.emit('get_account_state', payload);
  socket.analyzeSymbol = (payload) => socket.emit('analyze_symbol', payload);
  socket.getHistory = (payload) => socket.emit('get_history', payload);
  socket.recordOutcome = (payload) => socket.emit('record_outcome', payload);
}

export default api;
