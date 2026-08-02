/**
 * ============================================================
 *  FREE RATE FEED — Near-live mid prices, no API key
 *  Polls every ~15–30s (configurable) so the ticker feels live.
 * ============================================================
 *
 *  Primary: Yahoo Finance chart meta (regularMarketPrice)
 *    - Forex: EURUSD=X, GBPUSD=X, …
 *    - Gold:  GC=F (COMEX) or XAUUSD=X
 *    - Crypto: BTC-USD, ETH-USD
 *
 *  Backup:  fawazahmed0 / open.er-api daily mid rates (FX only)
 *
 *  Emits 'price' events compatible with onLivePrice().
 *  Does NOT build OHLC candles — agents still need TwelveData /
 *  Binance / Bybit / MT5 for analysis. This feed keeps the
 *  dashboard ticker and /api/market alive between those sources.
 */

'use strict';

const https = require('https');
const EventEmitter = require('events');

const POLL_MS = Number(process.env.FREE_RATE_POLL_MS || 20 * 1000); // 20s default
const USER_AGENT = 'Mozilla/5.0 (compatible; OMNICEE/1.1; +https://github.com/cee999/omnicee)';

// OMNICEE symbol → Yahoo Finance symbol
const YAHOO_MAP = {
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  USDJPY: 'USDJPY=X',
  AUDUSD: 'AUDUSD=X',
  USDCAD: 'USDCAD=X',
  NZDUSD: 'NZDUSD=X',
  USDCHF: 'USDCHF=X',
  XAUUSD: 'GC=F',       // COMEX gold futures — most reliable free proxy
  XAGUSD: 'SI=F',
  BTCUSDT: 'BTC-USD',
  ETHUSDT: 'ETH-USD',
  BTCUSD:  'BTC-USD',
  ETHUSD:  'ETH-USD',
};

// Fallback daily FX map (usd-based rates from currency-api)
const FX_DAILY_MAP = {
  EURUSD: { quote: 'eur', invert: true },
  GBPUSD: { quote: 'gbp', invert: true },
  USDJPY: { quote: 'jpy', invert: false },
  AUDUSD: { quote: 'aud', invert: true },
  USDCAD: { quote: 'cad', invert: false },
  NZDUSD: { quote: 'nzd', invert: true },
  USDCHF: { quote: 'chf', invert: false },
  XAUUSD: { quote: 'xau', invert: true },
  XAGUSD: { quote: 'xag', invert: true },
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchYahooPrice(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`;
  const data = await httpGetJSON(url);
  const result = data?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`no meta for ${yahooSymbol}`);
  const price = Number(result.meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`bad price for ${yahooSymbol}`);
  return {
    price,
    timestamp: (result.meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000,
  };
}

class FreeRateFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = (config.symbols || Object.keys(YAHOO_MAP)).map(s => String(s).toUpperCase());
    this.pollMs = Math.max(10000, config.pollMs || POLL_MS); // floor 10s — be a good citizen
    this._timer = null;
    this._prices = new Map();
    this._running = false;
    this._stats = { polls: 0, updates: 0, errors: 0, yahooOk: 0, fallbackOk: 0 };
    this._inflight = false;
  }

  enabled() {
    return this.symbols.length > 0;
  }

  isConnected() {
    return this._running === true;
  }

  async connect() {
    return this.start();
  }

  async start() {
    if (this._running) return;
    this._running = true;
    console.log(`[FreeRateFeed] Near-live mode — ${this.symbols.join(', ')} every ${Math.round(this.pollMs / 1000)}s (Yahoo + daily fallback)`);
    await this._poll();
    this._timer = setInterval(() => {
      this._poll().catch(() => {});
    }, this.pollMs);
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

  getStats() {
    return { ...this._stats, prices: this._prices.size, pollMs: this.pollMs };
  }

  async _poll() {
    if (this._inflight || !this._running) return;
    this._inflight = true;
    this._stats.polls++;

    try {
      const tasks = this.symbols.map(async (symbol) => {
        const yahoo = YAHOO_MAP[symbol];
        if (!yahoo) return null;
        try {
          const { price, timestamp } = await fetchYahooPrice(yahoo);
          return { symbol, price, timestamp, source: 'yahoo' };
        } catch (err) {
          return { symbol, error: err.message };
        }
      });

      const results = await Promise.all(tasks);
      let anyYahoo = false;

      for (const r of results) {
        if (!r) continue;
        if (r.error) {
          this._stats.errors++;
          continue;
        }
        anyYahoo = true;
        this._stats.yahooOk++;
        this._emitPrice(r.symbol, r.price, r.source, r.timestamp);
      }

      if (!anyYahoo) {
        await this._fallbackDailyFx();
      } else {
        const missing = this.symbols.filter(s => !this._prices.has(s) && FX_DAILY_MAP[s]);
        if (missing.length) await this._fallbackDailyFx(missing);
      }
    } catch (err) {
      this._stats.errors++;
      console.warn(`[FreeRateFeed] poll error: ${err.message}`);
      this.emit('error', err);
    } finally {
      this._inflight = false;
    }
  }

  _emitPrice(symbol, price, source, timestamp = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    const prev = this._prices.get(symbol);
    this._prices.set(symbol, price);
    this._stats.updates++;
    const change = prev != null && prev > 0 ? ((price - prev) / prev) * 100 : null;
    this.emit('price', {
      symbol,
      price,
      change,
      source,
      timestamp,
    });
  }

  async _fallbackDailyFx(onlySymbols = null) {
    const targets = onlySymbols || this.symbols.filter(s => FX_DAILY_MAP[s]);
    if (!targets.length) return;

    let rates = null;
    try {
      const data = await httpGetJSON('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
      rates = data?.usd || null;
    } catch (_) {
      try {
        const data = await httpGetJSON('https://open.er-api.com/v6/latest/USD');
        if (data?.rates) {
          rates = {};
          for (const [k, v] of Object.entries(data.rates)) rates[k.toLowerCase()] = v;
        }
      } catch (e) {
        console.warn(`[FreeRateFeed] daily fallback failed: ${e.message}`);
        return;
      }
    }
    if (!rates) return;

    for (const symbol of targets) {
      const meta = FX_DAILY_MAP[symbol];
      if (!meta) continue;
      let rate = rates[meta.quote];
      if (rate == null || !Number.isFinite(Number(rate))) continue;
      rate = Number(rate);
      const price = meta.invert ? (1 / rate) : rate;
      if (!Number.isFinite(price) || price <= 0) continue;
      this._stats.fallbackOk++;
      this._emitPrice(symbol, price, 'free-rate-daily');
    }
  }
}

module.exports = { FreeRateFeed };
