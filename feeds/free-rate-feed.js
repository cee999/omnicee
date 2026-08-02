/**
 * ============================================================
 *  FREE RATE FEED — No-API-key mid prices for major FX + gold
 *  Fallback / always-on source when TwelveData quota is exhausted
 *  or keys are missing. Uses public free endpoints.
 * ============================================================
 *
 *  Sources (tried in order):
 *    1. https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest
 *    2. open.er-api.com (backup)
 *
 *  Emits the same 'price' event shape as other feeds so it plugs
 *  straight into onLivePrice(). Not suitable for high-frequency
 *  candle construction (updates every few minutes), but keeps the
 *  dashboard ticker and /api/market alive with real mid rates.
 */

'use strict';

const https = require('https');
const EventEmitter = require('events');

const POLL_MS = Number(process.env.FREE_RATE_POLL_MS || 5 * 60 * 1000); // 5 min default
const USER_AGENT = 'OMNICEE/1.0 (free-rate-feed; +https://github.com/cee999/omnicee)';

// Canonical OMNICEE symbols → rate keys (USD base)
const SYMBOL_MAP = {
  EURUSD: { base: 'usd', quote: 'eur', invert: true },  // rate is EUR per USD → invert for EURUSD
  GBPUSD: { base: 'usd', quote: 'gbp', invert: true },
  USDJPY: { base: 'usd', quote: 'jpy', invert: false },
  AUDUSD: { base: 'usd', quote: 'aud', invert: true },
  USDCAD: { base: 'usd', quote: 'cad', invert: false },
  NZDUSD: { base: 'usd', quote: 'nzd', invert: true },
  USDCHF: { base: 'usd', quote: 'chf', invert: false },
  XAUUSD: { base: 'usd', quote: 'xau', invert: true },  // gold often as XAU per USD inverted
  XAGUSD: { base: 'usd', quote: 'xag', invert: true },
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 120)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${data.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

class FreeRateFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = (config.symbols || Object.keys(SYMBOL_MAP)).map(s => String(s).toUpperCase());
    this.pollMs = config.pollMs || POLL_MS;
    this._timer = null;
    this._prices = new Map();
    this._running = false;
    this._stats = { polls: 0, updates: 0, errors: 0 };
  }

  enabled() {
    return this.symbols.length > 0;
  }

  async connect() {
    return this.start();
  }

  async start() {
    if (this._running) return;
    this._running = true;
    console.log(`[FreeRateFeed] Starting — symbols: ${this.symbols.join(', ')}, interval ${Math.round(this.pollMs / 1000)}s`);
    await this._poll();
    this._timer = setInterval(() => this._poll().catch(() => {}), this.pollMs);
    this.emit('connected');
  }

  async stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async disconnect() {
    return this.stop();
  }

  getPrice(symbol) {
    return this._prices.get(String(symbol).toUpperCase()) ?? null;
  }

  getAllPrices() {
    return Object.fromEntries(this._prices);
  }

  async _poll() {
    this._stats.polls++;
    try {
      const rates = await this._fetchRates();
      if (!rates) return;

      for (const symbol of this.symbols) {
        const meta = SYMBOL_MAP[symbol];
        if (!meta) continue;

        let rate = rates[meta.quote];
        if (rate == null || !Number.isFinite(Number(rate))) continue;

        rate = Number(rate);
        // Most free APIs return "how many quote per 1 USD".
        // EURUSD = how many USD per 1 EUR → invert.
        const price = meta.invert ? (1 / rate) : rate;
        if (!Number.isFinite(price) || price <= 0) continue;

        const prev = this._prices.get(symbol);
        this._prices.set(symbol, price);
        this._stats.updates++;

        const change = prev != null && prev > 0 ? ((price - prev) / prev) * 100 : null;
        this.emit('price', {
          symbol,
          price,
          change,
          source: 'free-rate',
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this._stats.errors++;
      console.warn(`[FreeRateFeed] poll error: ${err.message}`);
      this.emit('error', err);
    }
  }

  async _fetchRates() {
    // Primary: fawazahmed0 currency-api (generous free CDN)
    try {
      const data = await httpGetJSON('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
      if (data && data.usd && typeof data.usd === 'object') {
        return data.usd;
      }
    } catch (e) {
      console.warn(`[FreeRateFeed] primary source failed: ${e.message}`);
    }

    // Backup: open.er-api.com
    try {
      const data = await httpGetJSON('https://open.er-api.com/v6/latest/USD');
      if (data && data.rates && typeof data.rates === 'object') {
        // Normalize keys to lowercase to match primary
        const lower = {};
        for (const [k, v] of Object.entries(data.rates)) {
          lower[k.toLowerCase()] = v;
        }
        return lower;
      }
    } catch (e) {
      console.warn(`[FreeRateFeed] backup source failed: ${e.message}`);
    }

    return null;
  }

  getStats() {
    return { ...this._stats, prices: this._prices.size };
  }
}

module.exports = { FreeRateFeed };
