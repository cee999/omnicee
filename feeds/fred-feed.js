'use strict';

/**
 * FRED (Federal Reserve Bank of St. Louis) daily FX series.
 * Requires FRED_API_KEY — free at https://fred.stlouisfed.org/docs/api/api_key.html
 *
 * Daily observations — not intraday ticks. Ranked under live feeds.
 */

const https = require('https');
const EventEmitter = require('events');

const SERIES = {
  // FRED: foreign currency per USD or USD per foreign — see invert
  EURUSD: { id: 'DEXUSEU', invert: false }, // USD per EUR → EURUSD
  GBPUSD: { id: 'DEXUSUK', invert: false }, // USD per GBP
  USDJPY: { id: 'DEXJPUS', invert: false }, // JPY per USD
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
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
      reject(new Error('fred timeout'));
    });
  });
}

class FredFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.FRED_API_KEY || '';
    this.symbols = Array.isArray(config.symbols)
      ? config.symbols.filter((s) => SERIES[s])
      : Object.keys(SERIES);
    this.pollMs = Math.max(10 * 60 * 1000, Number(config.pollMs || process.env.FRED_POLL_MS || 30 * 60 * 1000));
    this._timer = null;
    this._running = false;
    this._lastOk = 0;
  }

  enabled() {
    return Boolean(this.apiKey) && this.symbols.length > 0;
  }

  isConnected() {
    return this.enabled() && this._running && (Date.now() - this._lastOk) < this.pollMs * 2;
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

  async _pollOne(sym) {
    const meta = SERIES[sym];
    if (!meta) return;
    const url =
      `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=${encodeURIComponent(meta.id)}` +
      `&api_key=${encodeURIComponent(this.apiKey)}` +
      `&file_type=json&sort_order=desc&limit=5`;
    const { status, body } = await httpGetJSON(url);
    if (status >= 400) throw new Error(`FRED HTTP ${status} ${sym}`);
    const obs = Array.isArray(body?.observations) ? body.observations : [];
    for (const row of obs) {
      const v = Number(row.value);
      if (!Number.isFinite(v) || v <= 0) continue;
      const price = meta.invert ? 1 / v : v;
      this.emit('price', {
        symbol: sym,
        price,
        source: 'fred',
        asOf: row.date,
        mode: 'daily',
        timestamp: Date.now(),
      });
      return;
    }
  }

  async _poll() {
    try {
      for (const sym of this.symbols) {
        await this._pollOne(sym);
        await new Promise((r) => setTimeout(r, 300));
      }
      this._lastOk = Date.now();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

module.exports = { FredFeed, SERIES };
