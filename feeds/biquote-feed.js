'use strict';

/**
 * BiQuote — free MT5-sourced live quotes (no API key).
 * https://biquote.io/docs/
 *
 * Rank below mt5_ea / tradingview / deriv — use when your terminal is offline.
 * Not your Exness book; third-party MT5 composite.
 *
 * Prefer batch GET /api/latest (not per-symbol polling).
 * Optional SignalR stream exists at /hubs/tick — REST is enough for Omnicee fallback.
 */

const https = require('https');
const EventEmitter = require('events');

const BASE = 'https://biquote.io';

/** Omnicee symbol → BiQuote symbol */
const TO_BIQUOTE = {
  EURUSD: 'EURUSD',
  GBPUSD: 'GBPUSD',
  USDJPY: 'USDJPY',
  XAUUSD: 'XAUUSD',
  BTCUSDT: 'BTCUSD',
  ETHUSDT: 'ETHUSD',
  USOIL: 'USOIL',
  // UUP not typically on BiQuote MT5 FX feed
};

/** BiQuote symbol → Omnicee symbol */
const FROM_BIQUOTE = Object.fromEntries(
  Object.entries(TO_BIQUOTE).map(([omni, bq]) => [bq, omni]),
);

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 15000,
      headers: { Accept: 'application/json', 'User-Agent': 'OmniceeBiQuote/1.0' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('biquote timeout'));
    });
  });
}

class BiQuoteFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    const wanted = Array.isArray(config.symbols) ? config.symbols : Object.keys(TO_BIQUOTE);
    this.symbols = wanted.filter((s) => TO_BIQUOTE[s]);
    this.pollMs = Math.max(5000, Number(config.pollMs || process.env.BIQUOTE_POLL_MS || 8000));
    this._timer = null;
    this._running = false;
    this._lastOk = 0;
  }

  enabled() {
    return process.env.DISABLE_BIQUOTE !== '1';
  }

  isConnected() {
    return this._running && (Date.now() - this._lastOk) < this.pollMs * 4;
  }

  start() {
    if (!this.enabled() || this._running || !this.symbols.length) return;
    this._running = true;
    this._poll().catch(() => {});
    this._timer = setInterval(() => this._poll().catch(() => {}), this.pollMs);
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async disconnect() { this.stop(); }
  async connect() { this.start(); }

  async _poll() {
    const bqSymbols = [...new Set(this.symbols.map((s) => TO_BIQUOTE[s]).filter(Boolean))];
    if (!bqSymbols.length) return;

    // Batch: ?symbols=A&symbols=B (repeat param — comma form not supported)
    const qs = bqSymbols.map((s) => `symbols=${encodeURIComponent(s)}`).join('&');
    const url = `${BASE}/api/latest?${qs}`;

    try {
      const { status, body } = await httpGetJSON(url);
      if (status === 429) {
        this.emit('error', new Error('biquote rate limited'));
        return;
      }
      if (status >= 400 || !body || typeof body !== 'object') {
        throw new Error(`biquote status=${status}`);
      }

      this._lastOk = Date.now();
      this.emit('connected');

      for (const [bqSym, tick] of Object.entries(body)) {
        if (!tick || typeof tick !== 'object') continue;
        const omni = FROM_BIQUOTE[bqSym] || FROM_BIQUOTE[tick.symbol] || null;
        if (!omni || !this.symbols.includes(omni)) continue;

        const bid = Number(tick.bid);
        const ask = Number(tick.ask);
        const mid = Number(tick.mid);
        const price = Number.isFinite(mid) && mid > 0
          ? mid
          : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : bid);
        if (!Number.isFinite(price) || price <= 0) continue;

        // Skip clearly dead quotes if API marks them
        if (tick.stale === true && Number(tick.quoteAgeSeconds) > 600) continue;

        const change = tick.dayDiffPercent != null ? Number(tick.dayDiffPercent) : null;

        this.emit('price', {
          symbol: omni,
          price,
          bid: Number.isFinite(bid) ? bid : null,
          ask: Number.isFinite(ask) ? ask : null,
          change: Number.isFinite(change) ? change : null,
          source: 'biquote',
          marketState: tick.marketState || null,
          timestamp: this._lastOk,
        });
      }
    } catch (e) {
      this.emit('error', e);
    }
  }
}

module.exports = { BiQuoteFeed, TO_BIQUOTE };
