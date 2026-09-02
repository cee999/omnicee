'use strict';

/**
 * Continuous free FX rates (no API key) via open.er-api.com.
 * Used only as a fallback under MT5 / Deriv / TradingView / Finnhub.
 * Quotes are USD-base → inverted for XXXUSD pairs.
 */

const https = require('https');
const EventEmitter = require('events');

const ENDPOINT = 'https://open.er-api.com/v6/latest/USD';

/** OMNICEE symbol → how to derive price from USD rates map */
const PAIR_FROM_USD = {
  EURUSD: (rates) => (rates.EUR > 0 ? 1 / rates.EUR : null), // EUR per USD → USD per EUR
  GBPUSD: (rates) => (rates.GBP > 0 ? 1 / rates.GBP : null),
  USDJPY: (rates) => (rates.JPY > 0 ? rates.JPY : null),
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
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
      reject(new Error('exchangerate timeout'));
    });
  });
}

class ExchangeRateFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = Array.isArray(config.symbols) ? config.symbols : Object.keys(PAIR_FROM_USD);
    this.pollMs = Math.max(15000, Number(config.pollMs || process.env.EXCHANGERATE_POLL_MS || 30000));
    this._timer = null;
    this._running = false;
    this._lastOk = 0;
  }

  enabled() {
    return process.env.DISABLE_EXCHANGERATE !== '1';
  }

  isConnected() {
    return this._running && (Date.now() - this._lastOk) < this.pollMs * 3;
  }

  start() {
    if (!this.enabled() || this._running) return;
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
    try {
      const { status, body } = await httpGetJSON(ENDPOINT);
      if (status >= 400 || body?.result !== 'success') {
        throw new Error(`exchangerate status=${status} result=${body?.result}`);
      }
      const rates = body.rates || {};
      this._lastOk = Date.now();
      this.emit('connected');
      for (const sym of this.symbols) {
        const derive = PAIR_FROM_USD[sym];
        if (!derive) continue;
        const price = Number(derive(rates));
        if (!Number.isFinite(price) || price <= 0) continue;
        this.emit('price', {
          symbol: sym,
          price,
          source: 'exchangerate',
          change: null,
          bid: null,
          ask: null,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

module.exports = { ExchangeRateFeed, PAIR_FROM_USD };
