/**
 * ============================================================
 *  DERIV FEED — Live ticks via public WebSocket (no MT5, free)
 * ============================================================
 *
 *  Docs: https://developers.deriv.com/docs/data/ticks/
 *  Socket: wss://ws.derivws.com/websockets/v3?app_id=APP_ID
 *
 *  Market data ticks do NOT require a paid plan or deposit.
 *  App ID: free from api.deriv.com (or use DERIV_APP_ID env).
 *  Default app_id 1089 is Deriv's public demo/sample ID.
 *
 *  Emits:
 *    'price'  { symbol, price, bid, ask, change, source: 'deriv' }
 *    'connected' / 'disconnected' / 'error'
 *
 *  Ranking: below MT5/Exness (source rank lower); above Yahoo when live.
 */

'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

// OMNICEE symbol → Deriv short symbol
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
  // Crypto on Deriv (if available in region)
  BTCUSDT: 'cryBTCUSD',
  ETHUSDT: 'cryETHUSD',
  // Oil / indices — best-effort
  USOIL: 'frxWTIOil',
  UUP: null, // no direct map — skip
};

const DEFAULT_APP_ID = process.env.DERIV_APP_ID || '1089';
const WS_URL = (appId) => `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
const PING_MS = 30000;
const RECONNECT_MS = 5000;

class DerivFeed extends EventEmitter {
  /**
   * @param {{ symbols?: string[], appId?: string }} config
   */
  constructor(config = {}) {
    super();
    this.symbols = (config.symbols || Object.keys(DERIV_MAP)).filter(s => DERIV_MAP[s]);
    this.appId = String(config.appId || DEFAULT_APP_ID);
    this._ws = null;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._stopped = false;
    this._connected = false;
    this._lastQuote = new Map(); // symbol → price
    this._subIds = new Map();    // derivSymbol → subscription id
  }

  enabled() {
    return this.symbols.length > 0;
  }

  isConnected() {
    return this._connected === true;
  }

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
    this._pingTimer = null;
    this._reconnectTimer = null;
  }

  _connect() {
    if (this._stopped) return;
    this._clearTimers();

    const url = WS_URL(this.appId);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      this._connected = true;
      this.emit('connected');
      this._subscribeAll();
      this._pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ ping: 1 })); } catch (_) {}
        }
      }, PING_MS);
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

    ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, RECONNECT_MS);
  }

  _subscribeAll() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    for (const omni of this.symbols) {
      const deriv = DERIV_MAP[omni];
      if (!deriv) continue;
      try {
        this._ws.send(JSON.stringify({
          ticks: deriv,
          subscribe: 1,
        }));
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  _handleMessage(msg) {
    if (msg.msg_type === 'tick' && msg.tick) {
      const t = msg.tick;
      const derivSym = t.symbol;
      const omni = this._omniFromDeriv(derivSym);
      if (!omni) return;

      const quote = Number(t.quote ?? t.bid ?? t.ask);
      if (!Number.isFinite(quote)) return;

      const bid = Number.isFinite(Number(t.bid)) ? Number(t.bid) : null;
      const ask = Number.isFinite(Number(t.ask)) ? Number(t.ask) : null;

      const prev = this._lastQuote.get(omni);
      let change = null;
      if (prev != null && prev > 0) {
        change = ((quote - prev) / prev) * 100;
      }
      this._lastQuote.set(omni, quote);

      if (msg.subscription && msg.subscription.id) {
        this._subIds.set(derivSym, msg.subscription.id);
      }

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

    if (msg.error) {
      this.emit('error', new Error(msg.error.message || JSON.stringify(msg.error)));
    }
  }

  _omniFromDeriv(derivSym) {
    for (const [omni, d] of Object.entries(DERIV_MAP)) {
      if (d === derivSym) return omni;
    }
    return null;
  }
}

module.exports = { DerivFeed, DERIV_MAP };
