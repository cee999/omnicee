'use strict';

/**
 * Frankfurter — free ECB FX rates (no API key).
 * ApiVault catalog candidate; fills EURUSD/GBPUSD/USDJPY when MT5/Deriv quiet.
 * https://www.frankfurter.app/docs
 */

const https = require('https');
const EventEmitter = require('events');

const ENDPOINT = 'https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY';

const PAIR_FROM_USD = {
  EURUSD: (rates) => (rates.EUR > 0 ? 1 / rates.EUR : null),
  GBPUSD: (rates) => (rates.GBP > 0 ? 1 / rates.GBP : null),
  USDJPY: (rates) => (rates.JPY > 0 ? rates.JPY : null),
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, headers: { Accept: 'application/json' } }, (res) => {
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
      reject(new Error('frankfurter timeout'));
    });
  });
}

class FrankfurterFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = Array.isArray(config.symbols)
      ? config.symbols.filter((s) => PAIR_FROM_USD[s])
      : Object.keys(PAIR_FROM_USD);
    this.pollMs = Math.max(30000, Number(config.pollMs || process.env.FRANKFURTER_POLL_MS || 60000));
    this._timer = null;
    this._running = false;
    this._lastOk = 0;
  }

  enabled() {
    return process.env.DISABLE_FRANKFURTER !== '1';
  }

  isConnected() {
    return this._running && (Date.now() - this._lastOk) < this.pollMs * 3;
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
    try {
      const { status, body } = await httpGetJSON(ENDPOINT);
      if (status >= 400 || !body?.rates) {
        throw new Error(`frankfurter status=${status}`);
      }
      const rates = body.rates;
      this._lastOk = Date.now();
      for (const symbol of this.symbols) {
        const fn = PAIR_FROM_USD[symbol];
        if (!fn) continue;
        const price = fn(rates);
        if (!Number.isFinite(price) || price <= 0) continue;
        this.emit('price', {
          symbol,
          price,
          bid: price,
          ask: price,
          source: 'frankfurter',
          timestamp: this._lastOk,
        });
      }
      this.emit('tick', { source: 'frankfurter', at: this._lastOk });
    } catch (e) {
      this.emit('error', e);
    }
  }
}

module.exports = { FrankfurterFeed };
