/**
 * Crypto volatility alerts — short-window % moves on BTC/ETH (Deriv/MT5 ticks).
 * Emits 'alert' events; index.js relays to wsBus + optional Telegram.
 */
'use strict';

const EventEmitter = require('events');

const DEFAULT_CRYPTO = ['BTCUSDT', 'ETHUSDT'];

/** Windows in ms → threshold percent move to alert */
const DEFAULT_WINDOWS = [
  { id: '1m', ms: 60 * 1000, pct: 1.0 },
  { id: '5m', ms: 5 * 60 * 1000, pct: 2.0 },
  { id: '15m', ms: 15 * 60 * 1000, pct: 3.5 },
];

class CryptoVolatilityAlert extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = new Set(config.symbols || DEFAULT_CRYPTO);
    this.windows = config.windows || DEFAULT_WINDOWS;
    this.cooldownMs = Number(config.cooldownMs || process.env.CRYPTO_ALERT_COOLDOWN_MS || 5 * 60 * 1000);
    this._ticks = new Map(); // symbol -> [{ t, price }]
    this._lastAlert = new Map(); // symbol:windowId -> ts
    this.maxTicks = 500;
  }

  enabled() { return this.symbols.size > 0; }
  isConnected() { return true; }

  isCrypto(symbol) {
    return this.symbols.has(symbol) || /USDT$|USDC$/.test(symbol);
  }

  /**
   * Call on every live crypto tick.
   * @returns {object|null} alert payload if fired
   */
  onPrice(symbol, price, ts = Date.now()) {
    if (!this.isCrypto(symbol) || !Number.isFinite(price) || price <= 0) return null;

    if (!this._ticks.has(symbol)) this._ticks.set(symbol, []);
    const arr = this._ticks.get(symbol);
    arr.push({ t: ts, price });
    if (arr.length > this.maxTicks) arr.splice(0, arr.length - this.maxTicks);

    // Drop older than longest window
    const maxMs = Math.max(...this.windows.map(w => w.ms));
    const cutoff = ts - maxMs * 1.2;
    while (arr.length && arr[0].t < cutoff) arr.shift();

    let fired = null;
    for (const w of this.windows) {
      const ref = this._priceAtOrBefore(arr, ts - w.ms);
      if (ref == null || ref <= 0) continue;
      const pct = ((price - ref) / ref) * 100;
      const abs = Math.abs(pct);
      if (abs < w.pct) continue;

      const key = `${symbol}:${w.id}`;
      const last = this._lastAlert.get(key) || 0;
      if (ts - last < this.cooldownMs) continue;

      this._lastAlert.set(key, ts);
      const direction = pct > 0 ? 'UP' : 'DOWN';
      const severity = abs >= w.pct * 1.75 ? 'severe' : abs >= w.pct * 1.25 ? 'high' : 'elevated';
      fired = {
        type: 'crypto_volatility',
        symbol,
        direction,
        severity,
        pct: Math.round(pct * 100) / 100,
        absPct: Math.round(abs * 100) / 100,
        window: w.id,
        thresholdPct: w.pct,
        price,
        refPrice: ref,
        message: `${symbol} ${direction} ${abs.toFixed(2)}% in ${w.id} (threshold ${w.pct}%)`,
        timestamp: ts,
      };
      this.emit('alert', fired);
      // one alert per tick max (most severe window already sorted? emit all windows with cooldown)
    }
    return fired;
  }

  _priceAtOrBefore(arr, targetT) {
    // arr sorted by time ascending
    let best = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].t <= targetT) best = arr[i].price;
      else break;
    }
    // if no tick old enough, use oldest
    if (best == null && arr.length) {
      if (arr[0].t <= targetT + 15000) best = arr[0].price; // allow slight skew
    }
    return best;
  }

  getStatus() {
    const out = {};
    for (const [sym, arr] of this._ticks) {
      out[sym] = { ticks: arr.length, last: arr[arr.length - 1] || null };
    }
    return out;
  }
}

module.exports = { CryptoVolatilityAlert, DEFAULT_WINDOWS, DEFAULT_CRYPTO };
