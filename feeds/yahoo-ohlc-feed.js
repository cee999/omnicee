/**
 * Yahoo Finance OHLC candles — free, no API key.
 * Fills candle history so the signal pipeline can run without Twelve Data / MT5.
 */
'use strict';

const https = require('https');
const { EventEmitter } = require('events');

const UA = 'Mozilla/5.0 (compatible; OMNICEE/1.0)';

/** Map internal symbol → Yahoo chart symbol */
const YAHOO_SYMBOL = {
  BTCUSDT: 'BTC-USD',
  ETHUSDT: 'ETH-USD',
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  USDJPY: 'USDJPY=X',
  XAUUSD: 'GC=F', // COMEX gold futures proxy
  AUDUSD: 'AUDUSD=X',
  USDCAD: 'USDCAD=X',
  NZDUSD: 'NZDUSD=X',
  USDCHF: 'USDCHF=X',
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON: ${data.slice(0, 60)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function toCandles(chartResult) {
  const r = chartResult?.chart?.result?.[0];
  if (!r?.timestamp?.length) return [];
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every(Number.isFinite)) continue;
    out.push({
      open: o, high: h, low: l, close: c,
      volume: Number(q.volume?.[i]) || 0,
      timestamp: r.timestamp[i] * 1000,
      isClosed: true,
    });
  }
  return out;
}

class YahooOhlcFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = config.symbols || Object.keys(YAHOO_SYMBOL);
    this.interval = config.interval || '1h';
    this.range = config.range || '10d';
    this.pollMs = Number(config.pollMs || process.env.YAHOO_OHLC_POLL_MS || 5 * 60 * 1000);
    this._timer = null;
    this._running = false;
  }

  enabled() { return this.symbols.length > 0; }
  isConnected() { return this._running; }

  yahooTicker(symbol) {
    return YAHOO_SYMBOL[symbol] || (symbol.includes('USDT') ? symbol.replace('USDT', '-USD') : `${symbol}=X`);
  }

  async fetchSymbol(symbol) {
    const y = this.yahooTicker(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=${this.interval}&range=${this.range}`;
    const data = await httpGetJSON(url);
    if (data?.chart?.error) throw new Error(data.chart.error.description || 'yahoo chart error');
    return toCandles(data);
  }

  async pollOnce() {
    for (const symbol of this.symbols) {
      try {
        const candles = await this.fetchSymbol(symbol);
        if (candles.length) {
          this.emit('candles', { symbol, timeframe: 'H1', candles });
          const last = candles[candles.length - 1];
          this.emit('candle', { symbol, timeframe: 'H1', candle: last, isClosed: true });
        }
      } catch (err) {
        this.emit('error', { symbol, error: err.message });
      }
      // gentle pacing
      await new Promise(r => setTimeout(r, 400));
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.emit('connected');
    const loop = async () => {
      if (!this._running) return;
      try { await this.pollOnce(); } catch (e) { this.emit('error', { error: e.message }); }
      if (this._running) this._timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  disconnect() { this.stop(); }
}

module.exports = { YahooOhlcFeed, YAHOO_SYMBOL };
