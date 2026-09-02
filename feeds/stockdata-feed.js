'use strict';

/**
 * StockData.org (https://www.stockdata.org) — optional price fallback.
 *
 * Reality of their free/standard API (verified against live token):
 *  - GET /v1/data/quote  → US-listed equities/ETFs only (IEX). Works for UUP, AAPL, etc.
 *  - GET /v1/data/eod    → end-of-day history for stocks AND forex/crypto (not live ticks)
 *
 * So this feed is intentionally ranked BELOW mt5_ea and deriv. It fills gaps when
 * broker/Deriv are offline, and keeps DXY proxy (UUP) alive from a second source.
 * It is NOT a substitute for true live FX/crypto ticks.
 */

const https = require('https');
const EventEmitter = require('events');

const BASE = 'https://api.stockdata.org/v1';

/** Map OMNICEE symbol → StockData quote symbol (US listing only). */
const QUOTE_MAP = {
  UUP: 'UUP',
  // USO is the oil ETF proxy if USOIL has no direct IEX quote
  USOIL: 'USO',
};

/** Map OMNICEE symbol → StockData EOD symbol (forex/crypto daily). */
const EOD_MAP = {
  EURUSD: 'EURUSD',
  GBPUSD: 'GBPUSD',
  USDJPY: 'USDJPY',
  XAUUSD: 'XAUUSD',
  BTCUSDT: 'BTC-USD',
  ETHUSDT: 'ETH-USD',
  BTCUSD: 'BTC-USD',
  ETHUSD: 'ETH-USD',
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) {
          return reject(new Error(`StockData rate/plan limit HTTP ${res.statusCode}`));
        }
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`StockData HTTP ${res.statusCode}: ${data.slice(0, 160)}`));
        }
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (e) {
          reject(new Error(`StockData JSON parse failed: ${data.slice(0, 160)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('StockData request timeout'));
    });
  });
}

class StockDataFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiToken = config.apiToken || process.env.STOCKDATA_API_TOKEN || process.env.STOCKDATA_API_KEY || '';
    this.symbols = Array.isArray(config.symbols) ? config.symbols : [];
    // Free tiers are tight — default 3 minutes between full cycles
    this.pollMs = Number(config.pollMs || process.env.STOCKDATA_POLL_MS || 3 * 60 * 1000);
    this._timer = null;
    this._running = false;
    this._lastOk = 0;
    this._quotaUntil = 0;
    this._quoteMap = { ...QUOTE_MAP, ...(config.quoteMap || {}) };
    this._eodMap = { ...EOD_MAP, ...(config.eodMap || {}) };
  }

  enabled() {
    return Boolean(this.apiToken);
  }

  isConnected() {
    return this.enabled() && this._running && (Date.now() - this._lastOk < this.pollMs * 3);
  }

  start() {
    if (!this.enabled() || this._running) return;
    this._running = true;
    this._poll().catch(() => {});
    this._timer = setInterval(() => {
      this._poll().catch(() => {});
    }, this.pollMs);
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async disconnect() {
    this.stop();
  }

  async connect() {
    this.start();
  }

  async _poll() {
    if (!this.enabled()) return;
    if (Date.now() < this._quotaUntil) return;

    const omniSymbols = this.symbols.length
      ? this.symbols
      : Object.keys({ ...this._quoteMap, ...this._eodMap });

    // 1) Live-ish US quotes (one symbol per request — free plan rejects multi-symbol batches)
    for (const omni of omniSymbols) {
      const qSym = this._quoteMap[omni];
      if (!qSym) continue;
      try {
        const url = `${BASE}/data/quote?symbols=${encodeURIComponent(qSym)}&api_token=${encodeURIComponent(this.apiToken)}`;
        const body = await httpGetJSON(url);
        if (Array.isArray(body?.warnings) && body.warnings.length) {
          this.emit('warn', body.warnings.join('; '));
        }
        const row = Array.isArray(body?.data) ? body.data[0] : null;
        const price = Number(row?.price);
        if (Number.isFinite(price) && price > 0) {
          const prev = Number(row.previous_close_price);
          const change = Number.isFinite(prev) && prev > 0
            ? ((price - prev) / prev) * 100
            : (Number.isFinite(Number(row.day_change)) ? Number(row.day_change) : null);
          this._lastOk = Date.now();
          this.emit('price', {
            symbol: omni,
            price,
            bid: null,
            ask: null,
            change,
            source: 'stockdata',
            mode: 'quote',
            ticker: row.ticker || qSym,
            dayHigh: Number(row.day_high) || null,
            dayLow: Number(row.day_low) || null,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        this._handleErr(err);
        break;
      }
      // gentle spacing so free tier does not 403 mid-cycle
      await new Promise((r) => setTimeout(r, 400));
    }

    // 2) EOD fallback for FX/crypto (latest close only — not a live tick)
    for (const omni of omniSymbols) {
      if (this._quoteMap[omni]) continue; // already tried quote path
      const eodSym = this._eodMap[omni];
      if (!eodSym) continue;
      try {
        const url = `${BASE}/data/eod?symbols=${encodeURIComponent(eodSym)}&api_token=${encodeURIComponent(this.apiToken)}`;
        const body = await httpGetJSON(url);
        const rows = Array.isArray(body?.data) ? body.data : [];
        const row = rows[0];
        const price = Number(row?.close);
        if (Number.isFinite(price) && price > 0) {
          const prevClose = rows[1] ? Number(rows[1].close) : null;
          const change = Number.isFinite(prevClose) && prevClose > 0
            ? ((price - prevClose) / prevClose) * 100
            : null;
          this._lastOk = Date.now();
          this.emit('price', {
            symbol: omni,
            price,
            bid: null,
            ask: null,
            change,
            source: 'stockdata',
            mode: 'eod',
            ticker: eodSym,
            dayHigh: Number(row.high) || null,
            dayLow: Number(row.low) || null,
            asOf: row.date || null,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        this._handleErr(err);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  _handleErr(err) {
    const msg = err?.message || String(err);
    if (/rate\/plan limit|HTTP 403|HTTP 429/i.test(msg)) {
      // back off 15 minutes on plan/rate walls
      this._quotaUntil = Date.now() + 15 * 60 * 1000;
      this.emit('error', new Error(`${msg} — backing off 15m`));
    } else {
      this.emit('error', err instanceof Error ? err : new Error(msg));
    }
  }
}

module.exports = { StockDataFeed, QUOTE_MAP, EOD_MAP };
