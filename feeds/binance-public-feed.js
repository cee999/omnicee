'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

/** Free public Binance trade stream — no API key. Crypto only. */
const BINANCE_MAP = {
  BTCUSDT: 'btcusdt',
  ETHUSDT: 'ethusdt',
};

class BinancePublicFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = (config.symbols || Object.keys(BINANCE_MAP)).filter(s => BINANCE_MAP[s]);
    this._ws = null;
    this._stopped = false;
    this._connected = false;
    this._reconnectTimer = null;
    this._reverse = {};
    for (const [omni, b] of Object.entries(BINANCE_MAP)) this._reverse[b] = omni;
  }

  enabled() { return this.symbols.length > 0; }
  isConnected() { return this._connected === true; }

  async connect() {
    this.start();
    return this;
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }
    this._connected = false;
  }

  _connect() {
    if (this._stopped || !this.symbols.length) return;
    const streams = this.symbols.map(s => `${BINANCE_MAP[s]}@trade`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 15000 });
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      this._connected = true;
      this.emit('connected', { url: 'binance-public' });
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { return; }
      const d = msg.data || msg;
      if (!d || d.e !== 'trade') return;
      const stream = String(msg.stream || '').split('@')[0];
      const omni = this._reverse[stream] || this._reverse[String(d.s || '').toLowerCase()];
      if (!omni) return;
      const price = Number(d.p);
      if (!Number.isFinite(price)) return;
      this.emit('price', {
        symbol: omni,
        price,
        bid: price,
        ask: price,
        timestamp: d.T || Date.now(),
        source: 'binance',
      });
    });

    ws.on('close', () => {
      this._connected = false;
      this.emit('disconnected');
      if (!this._stopped) this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connect(), 3000);
  }
}

module.exports = { BinancePublicFeed, BINANCE_MAP };
