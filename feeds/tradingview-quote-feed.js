'use strict';

const EventEmitter = require('events');
const https = require('https');

/** Map Omnicee symbols → TradingView tickers (same as the chart widget). */
const TV_TICKERS = {
  XAUUSD: { market: 'forex', ticker: 'OANDA:XAUUSD' },
  EURUSD: { market: 'forex', ticker: 'OANDA:EURUSD' },
  GBPUSD: { market: 'forex', ticker: 'OANDA:GBPUSD' },
  USDJPY: { market: 'forex', ticker: 'OANDA:USDJPY' },
  USOIL: { market: 'cfd', ticker: 'TVC:USOIL' },
  UUP: { market: 'america', ticker: 'AMEX:UUP' },
  BTCUSDT: { market: 'crypto', ticker: 'BINANCE:BTCUSDT' },
  ETHUSDT: { market: 'crypto', ticker: 'BINANCE:ETHUSDT' },
};

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 OmniceeTVQuotes/1.0',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('tv scanner timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Polls TradingView's public scanner for bid/ask/last — same venue as the
 * embedded chart (OANDA / Binance / TVC). No API key.
 */
class TradingViewQuoteFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = (config.symbols || Object.keys(TV_TICKERS)).filter(s => TV_TICKERS[s]);
    this.intervalMs = Math.max(1500, Number(config.intervalMs) || 2500);
    this._timer = null;
    this._stopped = true;
    this._connected = false;
    this._reverse = {};
    for (const [omni, meta] of Object.entries(TV_TICKERS)) {
      this._reverse[meta.ticker] = omni;
    }
  }

  enabled() { return this.symbols.length > 0 && process.env.DISABLE_TRADINGVIEW !== '1'; }
  isConnected() { return this._connected === true; }

  start() {
    if (!this.enabled()) return;
    this._stopped = false;
    this._tick().catch(() => {});
    this._timer = setInterval(() => this._tick().catch(() => {}), this.intervalMs);
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._connected = false;
  }

  async _tick() {
    if (this._stopped) return;
    const byMarket = {};
    for (const sym of this.symbols) {
      const meta = TV_TICKERS[sym];
      if (!meta) continue;
      (byMarket[meta.market] || (byMarket[meta.market] = [])).push(meta.ticker);
    }
    let any = false;
    for (const [market, tickers] of Object.entries(byMarket)) {
      try {
        const { status, body } = await postJson(`https://scanner.tradingview.com/${market}/scan`, {
          symbols: { tickers, query: { types: [] } },
          columns: ['close', 'bid', 'ask', 'change', 'change_abs'],
        });
        if (status !== 200 || !Array.isArray(body?.data)) continue;
        for (const row of body.data) {
          const omni = this._reverse[row.s];
          if (!omni) continue;
          const d = row.d || [];
          const close = Number(d[0]);
          const bid = Number(d[1]);
          const ask = Number(d[2]);
          const change = Number(d[3]);
          const price = Number.isFinite(close) ? close
            : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN);
          if (!Number.isFinite(price)) continue;
          any = true;
          this.emit('price', {
            symbol: omni,
            price,
            bid: Number.isFinite(bid) ? bid : null,
            ask: Number.isFinite(ask) ? ask : null,
            change: Number.isFinite(change) ? change : null,
            source: 'tradingview',
            ticker: row.s,
          });
        }
      } catch (err) {
        this.emit('error', err);
      }
    }
    if (any && !this._connected) {
      this._connected = true;
      this.emit('connected');
    }
  }
}

module.exports = { TradingViewQuoteFeed, TV_TICKERS };
