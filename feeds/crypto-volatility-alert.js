/**
 * Volatility alerts — short-window % moves for crypto (BTC/ETH) and gold (XAUUSD).
 * Emits 'alert' events; index.js relays to wsBus + optional Telegram.
 */
'use strict';

const EventEmitter = require('events');

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XAUUSD'];

/** Crypto: larger swings. Gold: tighter % moves still matter. */
const WINDOWS_BY_ASSET = {
  crypto: [
    { id: '1m', ms: 60 * 1000, pct: 1.0 },
    { id: '5m', ms: 5 * 60 * 1000, pct: 2.0 },
    { id: '15m', ms: 15 * 60 * 1000, pct: 3.5 },
  ],
  gold: [
    { id: '1m', ms: 60 * 1000, pct: 0.25 },
    { id: '5m', ms: 5 * 60 * 1000, pct: 0.45 },
    { id: '15m', ms: 15 * 60 * 1000, pct: 0.8 },
  ],
};

function assetClass(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s === 'XAUUSD' || s === 'GOLD' || s === 'XAU') return 'gold';
  if (/USDT$|USDC$/.test(s) || s.includes('BTC') || s.includes('ETH')) return 'crypto';
  return null;
}

class CryptoVolatilityAlert extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = new Set(config.symbols || DEFAULT_SYMBOLS);
    this.windowsByAsset = config.windowsByAsset || WINDOWS_BY_ASSET;
    this.cooldownMs = Number(
      config.cooldownMs
      || process.env.VOL_ALERT_COOLDOWN_MS
      || process.env.CRYPTO_ALERT_COOLDOWN_MS
      || 5 * 60 * 1000
    );
    this._ticks = new Map();
    this._lastAlert = new Map();
    this.maxTicks = 500;
  }

  enabled() { return this.symbols.size > 0; }
  isConnected() { return true; }

  /** True if this symbol is watched (crypto or gold). */
  isCrypto(symbol) {
    return this.watches(symbol);
  }

  watches(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (this.symbols.has(s) || this.symbols.has(symbol)) return true;
    if (s === 'XAUUSD' || s === 'GOLD') return true;
    if (/USDT$|USDC$/.test(s)) return true;
    return false;
  }

  onPrice(symbol, price, ts = Date.now()) {
    if (!this.watches(symbol) || !Number.isFinite(price) || price <= 0) return null;

    const cls = assetClass(symbol);
    if (!cls) return null;
    const windows = this.windowsByAsset[cls] || WINDOWS_BY_ASSET.crypto;

    if (!this._ticks.has(symbol)) this._ticks.set(symbol, []);
    const arr = this._ticks.get(symbol);
    arr.push({ t: ts, price });
    if (arr.length > this.maxTicks) arr.splice(0, arr.length - this.maxTicks);

    const maxMs = Math.max(...windows.map(w => w.ms));
    const cutoff = ts - maxMs * 1.2;
    while (arr.length && arr[0].t < cutoff) arr.shift();

    let fired = null;
    for (const w of windows) {
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
      const kind = cls === 'gold' ? 'gold_volatility' : 'crypto_volatility';
      fired = {
        type: kind,
        assetClass: cls,
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
    }
    return fired;
  }

  _priceAtOrBefore(arr, targetT) {
    let best = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].t <= targetT) best = arr[i].price;
      else break;
    }
    if (best == null && arr.length) {
      if (arr[0].t <= targetT + 15000) best = arr[0].price;
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

module.exports = {
  CryptoVolatilityAlert,
  VolatilityAlert: CryptoVolatilityAlert,
  DEFAULT_SYMBOLS,
  WINDOWS_BY_ASSET,
  assetClass,
};
