'use strict';

/**
 * Free Yahoo Finance quotes for symbols BiQuote/Deriv miss (UUP, oil).
 * No API key. Rank below BiQuote/MT5 — fills empty desk cells only.
 */

const https = require('https');
const EventEmitter = require('events');

/** Omnicee → Yahoo chart symbol */
const YAHOO_MAP = {
  UUP: 'UUP',
  USOIL: 'CL=F',
  XAUUSD: 'GC=F',
  BTCUSDT: 'BTC-USD',
  ETHUSDT: 'ETH-USD',
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  USDJPY: 'USDJPY=X',
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OmniceeYahoo/1.0)',
        Accept: 'application/json',
      },
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
      reject(new Error('yahoo timeout'));
    });
  });
}

class YahooQuoteFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    const wanted = Array.isArray(config.symbols) ? config.symbols : Object.keys(YAHOO_MAP);
    this.symbols = wanted.filter((s) => YAHOO_MAP[s]);
    this.pollMs = Math.max(10000, Number(config.pollMs || process.env.YAHOO_QUOTE_POLL_MS || 20000));
    this._timer = null;
    this._running = false;
    this._lastOk = 0;
  }

  enabled() {
    return process.env.DISABLE_YAHOO_QUOTES !== '1';
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

  async _pollOne(omni) {
    const ySym = YAHOO_MAP[omni];
    if (!ySym) return null;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1m&range=1d`;
    const { status, body } = await httpGetJSON(url);
    if (status >= 400) return null;
    const meta = body?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = Number(meta.regularMarketPrice ?? meta.previousClose);
    if (!Number.isFinite(price) || price <= 0) return null;
    const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
    const change = Number.isFinite(prev) && prev > 0
      ? ((price - prev) / prev) * 100
      : null;
    return {
      symbol: omni,
      price,
      bid: price,
      ask: price,
      change: Number.isFinite(change) ? change : null,
      source: 'yahoo',
      timestamp: Date.now(),
    };
  }

  async _poll() {
    try {
      let any = false;
      for (const sym of this.symbols) {
        try {
          const tick = await this._pollOne(sym);
          if (!tick) continue;
          any = true;
          this.emit('price', tick);
        } catch (_) { /* per-symbol soft fail */ }
      }
      if (any) {
        this._lastOk = Date.now();
        this.emit('connected');
      }
    } catch (e) {
      this.emit('error', e);
    }
  }
}

module.exports = { YahooQuoteFeed, YAHOO_MAP };
