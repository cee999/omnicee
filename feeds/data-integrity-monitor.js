'use strict';

const TF_MS = {
  M1: 60000, M5: 300000, M15: 900000, M30: 1800000,
  H1: 3600000, H2: 7200000, H4: 14400000, H6: 21600000,
  H8: 28800000, H12: 43200000, D1: 86400000, W1: 604800000,
};

class DataIntegrityMonitor {
  constructor({ staleFactor = 3 } = {}) {
    this.staleFactor = staleFactor;
    this._feeds = new Map();
  }

  registerFeed(name, instance, symbols = []) {
    this._feeds.set(name, { instance, symbols });
  }

  check(candleStores = {}) {
    const now = Date.now();

    // FIX: instance.isConnected() returning `null` (no such method — true for REST/poll feeds like Finnhub/AlphaVantage/FMP/CFTC-COT/Myfxbook/ OpenInsider, none of which implement it) was being treated...
    const feeds = [...this._feeds.entries()].map(([name, { instance, symbols }]) => {
      let connected = null;
      try {
        connected = typeof instance.isConnected === 'function' ? instance.isConnected() : null;
      } catch (_) { connected = null; }
      const status = connected === false ? 'disconnected' : 'connected';
      return { name, connected, status, symbols };
    });

    const staleSeries = [];
    for (const symbol of Object.keys(candleStores)) {
      for (const tf of Object.keys(candleStores[symbol] || {})) {
        const candles = candleStores[symbol][tf];
        const last = candles && candles.length ? candles[candles.length - 1] : null;
        const intervalMs = TF_MS[tf] || null;
        if (!last || !intervalMs) continue;

        const ts = last.timestamp || last.time || null;
        if (!ts) continue;
        const ageMs = now - ts;
        const threshold = intervalMs * this.staleFactor;
        if (ageMs > threshold) {
          staleSeries.push({ symbol, timeframe: tf, ageMs, thresholdMs: threshold });
        }
      }
    }

    const disconnectedFeeds = feeds.filter(f => f.status === 'disconnected');
    const ok = disconnectedFeeds.length === 0 && staleSeries.length === 0;

    return {
      ok,
      feeds,
      staleSeries,
      summary: {
        feedsTotal: feeds.length,
        feedsDisconnected: disconnectedFeeds.length,
        staleSeriesCount: staleSeries.length,
        checkedAt: now,
      },
    };
  }
}

module.exports = { DataIntegrityMonitor, TF_MS };
