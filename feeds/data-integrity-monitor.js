'use strict';

/**
 * DataIntegrityMonitor
 * ---------------------
 * Doc item #54: "Checks data quality and pauses analysis if feeds become
 * unreliable." Before this, a WebSocket feed that silently stopped pushing
 * candles (dropped connection that doesn't fire an 'error' event, exchange
 * outage, etc.) produced no error, no crash, no log line — the pipeline just
 * kept scoring against stale, non-moving candles as if nothing were wrong.
 * That's the textbook definition of a silent failure.
 *
 * This module has no external dependencies — it just reads timestamps you
 * already have (candleStores, feed instances) and reports on their health.
 */

const TF_MS = {
  M1: 60000, M5: 300000, M15: 900000, M30: 1800000,
  H1: 3600000, H2: 7200000, H4: 14400000, H6: 21600000,
  H8: 28800000, H12: 43200000, D1: 86400000, W1: 604800000,
};

class DataIntegrityMonitor {
  constructor({ staleFactor = 3 } = {}) {
    // A symbol/timeframe is "stale" if its last candle is older than
    // staleFactor × the timeframe's own interval (e.g. an H1 feed with no
    // update in 3+ hours is stale; an M1 feed gets 3 minutes).
    this.staleFactor = staleFactor;
    this._feeds = new Map(); // name -> { instance, symbols }
  }

  registerFeed(name, instance, symbols = []) {
    this._feeds.set(name, { instance, symbols });
  }

  /**
   * @param {Object} candleStores - candleStores[symbol][timeframe] = candle[]
   * @returns {{ ok: boolean, feeds: Array, staleSeries: Array, summary: Object }}
   */
  check(candleStores = {}) {
    const now = Date.now();

    // 1. Feed connection status
    // FIX: instance.isConnected() returning `null` (no such method — true for
    // REST/poll feeds like Finnhub/AlphaVantage/FMP/CFTC-COT/Myfxbook/
    // OpenInsider, none of which implement it) was being treated identically
    // to `false` (a WS feed that positively reports itself disconnected) by
    // every caller. That's the difference between "we don't track this" and
    // "this is actually broken" — conflating them meant those 6 feeds always
    // rendered as red/down in the Monitor tab no matter their real state,
    // and inflated `feedsDisconnected`/`ok` as if they'd failed.
    const feeds = [...this._feeds.entries()].map(([name, { instance, symbols }]) => {
      let connected = null;
      try {
        connected = typeof instance.isConnected === 'function' ? instance.isConnected() : null;
      } catch (_) { connected = null; }
      const status = connected === false ? 'disconnected' : 'connected'; // null/true = running (REST feeds have no isConnected)
      return { name, connected, status, symbols };
    });

    // 2. Per symbol/timeframe staleness against the candles actually flowing
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
