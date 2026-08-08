/**
 * DERIV FEED — Live ticks + OHLC history (no MT5, free)
 * Primary free live source when Exness EA is offline.
 */
'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

const DERIV_MAP = {
  EURUSD: 'frxEURUSD',
  GBPUSD: 'frxGBPUSD',
  USDJPY: 'frxUSDJPY',
  AUDUSD: 'frxAUDUSD',
  USDCAD: 'frxUSDCAD',
  NZDUSD: 'frxNZDUSD',
  USDCHF: 'frxUSDCHF',
  XAUUSD: 'frxXAUUSD',
  XAGUSD: 'frxXAGUSD',
  BTCUSDT: 'cryBTCUSD',
  ETHUSDT: 'cryETHUSD',
  USOIL: 'frxWTIOil',
};

// Chart / analysis timeframes we seed from Deriv candles
const CANDLE_REQS = [
  { timeframe: 'M5', granularity: 300, count: 300 },
  { timeframe: 'M15', granularity: 900, count: 300 },
  { timeframe: 'H1', granularity: 3600, count: 300 },
  { timeframe: 'H4', granularity: 14400, count: 200 },
  { timeframe: 'D1', granularity: 86400, count: 200 },
];

const DEFAULT_APP_ID = process.env.DERIV_APP_ID || '1089';
const WS_URL = (appId) => `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
const PING_MS = 30000;
const RECONNECT_MS = 5000;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

class DerivFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = (config.symbols || Object.keys(DERIV_MAP)).filter(s => DERIV_MAP[s]);
    this.appId = String(config.appId || DEFAULT_APP_ID);
    this._ws = null;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._historyTimer = null;
    this._stopped = false;
    this._connected = false;
    this._lastQuote = new Map();
    this._pendingHistory = []; // queue of history requests
    this._historyBusy = false;
  }

  enabled() { return this.symbols.length > 0; }
  isConnected() { return this._connected === true; }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._clearTimers();
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }
    this._connected = false;
  }

  _clearTimers() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._historyTimer) clearInterval(this._historyTimer);
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._historyTimer = null;
  }

  _connect() {
    if (this._stopped) return;
    this._clearTimers();
    let ws;
    try {
      ws = new WebSocket(WS_URL(this.appId));
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      this._connected = true;
      this.emit('connected');
      this._subscribeTicks();
      this._queueAllHistory();
      this._pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ ping: 1 })); } catch (_) {}
        }
      }, PING_MS);
      this._historyTimer = setInterval(() => this._queueAllHistory(), HISTORY_REFRESH_MS);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { return; }
      this._handleMessage(msg);
    });

    ws.on('close', () => {
      this._connected = false;
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    ws.on('error', (err) => this.emit('error', err));
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, RECONNECT_MS);
  }

  _send(obj) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try { this._ws.send(JSON.stringify(obj)); } catch (err) { this.emit('error', err); }
  }

  _subscribeTicks() {
    for (const omni of this.symbols) {
      const deriv = DERIV_MAP[omni];
      if (!deriv) continue;
      this._send({ ticks: deriv, subscribe: 1 });
    }
  }

  _queueAllHistory() {
    for (const omni of this.symbols) {
      const deriv = DERIV_MAP[omni];
      if (!deriv) continue;
      for (const spec of CANDLE_REQS) {
        this._pendingHistory.push({ omni, deriv, ...spec });
      }
    }
    this._drainHistory();
  }

  _drainHistory() {
    if (this._historyBusy || !this._pendingHistory.length) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._historyBusy = true;
    const job = this._pendingHistory.shift();
    this._send({
      ticks_history: job.deriv,
      adjust_start_time: 1,
      count: job.count,
      end: 'latest',
      granularity: job.granularity,
      style: 'candles',
      req_id: 900000 + (job.granularity % 10000),
      passthrough: { omni: job.omni, timeframe: job.timeframe },
    });
    // Allow next request after short delay (handled when response arrives or timeout)
    setTimeout(() => {
      this._historyBusy = false;
      this._drainHistory();
    }, 400);
  }

  _handleMessage(msg) {
    if (msg.msg_type === 'tick' && msg.tick) {
      const t = msg.tick;
      const omni = this._omniFromDeriv(t.symbol);
      if (!omni) return;
      const quote = Number(t.quote ?? t.bid ?? t.ask);
      if (!Number.isFinite(quote)) return;
      const bid = Number.isFinite(Number(t.bid)) ? Number(t.bid) : null;
      const ask = Number.isFinite(Number(t.ask)) ? Number(t.ask) : null;
      const prev = this._lastQuote.get(omni);
      let change = null;
      if (prev != null && prev > 0) change = ((quote - prev) / prev) * 100;
      this._lastQuote.set(omni, quote);
      this.emit('price', {
        symbol: omni,
        price: quote,
        bid,
        ask,
        change,
        source: 'deriv',
        epoch: t.epoch ? t.epoch * 1000 : Date.now(),
      });
      return;
    }

    if (msg.msg_type === 'candles' && Array.isArray(msg.candles)) {
      const omni = msg.passthrough?.omni || this._omniFromDeriv(msg.echo_req?.ticks_history);
      const timeframe = msg.passthrough?.timeframe || 'H1';
      if (!omni) return;
      const candles = msg.candles.map(c => ({
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: 0,
        timestamp: (Number(c.epoch) || 0) * 1000,
        isClosed: true,
        source: 'deriv',
      })).filter(c => [c.open, c.high, c.low, c.close, c.timestamp].every(Number.isFinite) && c.timestamp > 0);
      if (candles.length) {
        this.emit('candles', { symbol: omni, timeframe, candles });
      }
      return;
    }

    if (msg.error) {
      this.emit('error', new Error(msg.error.message || JSON.stringify(msg.error)));
    }
  }

  _omniFromDeriv(derivSym) {
    if (!derivSym) return null;
    for (const [omni, d] of Object.entries(DERIV_MAP)) {
      if (d === derivSym) return omni;
    }
    return null;
  }
}

module.exports = { DerivFeed, DERIV_MAP };
