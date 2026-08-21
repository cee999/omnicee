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
  // USOIL / UUP not on Deriv public tick API
};

const CANDLE_REQS = [
  { timeframe: 'M5', granularity: 300, count: 300 },
  { timeframe: 'M15', granularity: 900, count: 350 },
  { timeframe: 'H1', granularity: 3600, count: 400 },
  { timeframe: 'H4', granularity: 14400, count: 250 },
  { timeframe: 'D1', granularity: 86400, count: 250 },
];

const URLS = [
  (id) => `wss://ws.derivws.com/websockets/v3?app_id=${id}`,
  (id) => `wss://ws.binaryws.com/websockets/v3?app_id=${id}`,
];

class DerivFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = (config.symbols || Object.keys(DERIV_MAP)).filter(s => DERIV_MAP[s]);
    this.appId = String(config.appId || process.env.DERIV_APP_ID || '1089');
    this._ws = null;
    this._urlIndex = 0;
    this._stopped = false;
    this._connected = false;
    this._lastQuote = new Map();
    this._lastTickAt = 0;
    this._pendingHistory = [];
    this._pendingHistorySet = new Set();
    this._invalidSymbols = new Set();
    this._historyBusy = false;
    this._pingTimer = null;
    this._watchTimer = null;
    this._reconnectTimer = null;
    this._historyTimer = null;
  }

  enabled() { return this.symbols.length > 0; }
  isConnected() { return this._connected === true; }

  /** Alias so index.js main() `await feed.connect()` works (same as start). */
  async connect() {
    if (this._connected && this._ws?.readyState === WebSocket.OPEN) {
      return this;
    }
    this.start();
    return this;
  }

  start() {
    if (this._connected && this._ws?.readyState === WebSocket.OPEN && !this._stopped) {
      return;
    }
    this._stopped = false;
    this._connect();
    this._watchTimer = setInterval(() => {
      if (this._stopped) return;
      if (!this._connected) return;
      if (this._lastTickAt && Date.now() - this._lastTickAt > 25000) {
        this.emit('error', new Error('no ticks for 25s — reconnecting'));
        this._forceReconnect();
      }
    }, 10000);
  }

  stop() {
    this._stopped = true;
    this._teardown();
  }

  _teardown() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._watchTimer) clearInterval(this._watchTimer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._historyTimer) clearInterval(this._historyTimer);
    this._pingTimer = this._watchTimer = this._reconnectTimer = this._historyTimer = null;
    if (this._ws) {
      try { this._ws.removeAllListeners(); this._ws.close(); } catch (_) {}
      this._ws = null;
    }
    this._connected = false;
  }

  _forceReconnect() {
    if (this._stopped) return;
    try { if (this._ws) this._ws.close(); } catch (_) {}
    this._connected = false;
    this._urlIndex = (this._urlIndex + 1) % URLS.length;
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, 2000);
  }

  _historyJobKey(job) {
    return `${job.deriv}:${job.timeframe}`;
  }

  _queueHistoryJob(job) {
    const key = this._historyJobKey(job);
    if (this._invalidSymbols.has(job.deriv) || this._pendingHistorySet.has(key)) return;
    this._pendingHistorySet.add(key);
    this._pendingHistory.push(job);
  }

  _removePendingHistoryForDeriv(deriv) {
    this._pendingHistory = this._pendingHistory.filter((job) => {
      const keep = job.deriv !== deriv;
      if (!keep) this._pendingHistorySet.delete(this._historyJobKey(job));
      return keep;
    });
  }

  _connect() {
    if (this._stopped) return;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._historyTimer) clearInterval(this._historyTimer);

    const url = URLS[this._urlIndex](this.appId);
    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 15000 });
    } catch (err) {
      this.emit('error', err);
      this._forceReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      this._connected = true;
      this.emit('connected', { url, appId: this.appId });
      this._subscribeTicks();
      setTimeout(() => {
        if (this._stopped || !this._connected) return;
        this._queueAllHistory();
        this._historyTimer = setInterval(() => this._queueAllHistory(), 5 * 60 * 1000);
      }, 2000);
      this._pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ ping: 1 })); } catch (_) {}
        }
      }, 20000);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { return; }
      this._handle(msg);
    });

    ws.on('close', () => {
      this._connected = false;
      this.emit('disconnected');
      if (!this._stopped) this._forceReconnect();
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _send(obj) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false;
    try {
      this._ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  _subscribeTicks() {
    for (const omni of this.symbols) {
      const d = DERIV_MAP[omni];
      if (!d || this._invalidSymbols.has(d)) continue;
      this._send({ ticks: d, subscribe: 1 });
    }
  }

  _queueAllHistory() {
    for (const omni of this.symbols) {
      const d = DERIV_MAP[omni];
      if (!d || this._invalidSymbols.has(d)) continue;
      for (const spec of CANDLE_REQS) {
        this._queueHistoryJob({ omni, deriv: d, ...spec });
      }
    }
    this._drainHistory();
  }

  _drainHistory() {
    if (this._historyBusy || !this._pendingHistory.length) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._historyBusy = true;
    let job = this._pendingHistory.shift();
    while (job && this._invalidSymbols.has(job.deriv)) {
      this._pendingHistorySet.delete(this._historyJobKey(job));
      job = this._pendingHistory.shift();
    }
    if (!job) {
      this._historyBusy = false;
      return;
    }
    this._pendingHistorySet.delete(this._historyJobKey(job));
    this._send({
      ticks_history: job.deriv,
      adjust_start_time: 1,
      count: job.count,
      end: 'latest',
      granularity: job.granularity,
      style: 'candles',
      passthrough: { omni: job.omni, timeframe: job.timeframe },
    });
    setTimeout(() => {
      this._historyBusy = false;
      this._drainHistory();
    }, 500);
  }

  _handle(msg) {
    if (msg.error) {
      const errMsg = msg.error.message || JSON.stringify(msg.error);
      const invalidSymbol = msg.echo_req?.ticks || msg.echo_req?.ticks_history;
      if (msg.error.code === 'InvalidSymbol' && invalidSymbol) {
        this._invalidSymbols.add(invalidSymbol);
        this._removePendingHistoryForDeriv(invalidSymbol);
      }
      this.emit('error', new Error(errMsg));
      return;
    }

    if (msg.msg_type === 'tick' && msg.tick) {
      const t = msg.tick;
      const omni = this._omniFromDeriv(t.symbol);
      if (!omni) return;
      const quote = Number(t.quote ?? t.bid ?? t.ask);
      if (!Number.isFinite(quote)) return;
      this._lastTickAt = Date.now();
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
      })).filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.timestamp > 1e11);
      if (candles.length) this.emit('candles', { symbol: omni, timeframe, candles });
    }
  }

  _omniFromDeriv(sym) {
    if (!sym) return null;
    for (const [omni, d] of Object.entries(DERIV_MAP)) {
      if (d === sym) return omni;
    }
    return null;
  }
}

module.exports = { DerivFeed, DERIV_MAP };
