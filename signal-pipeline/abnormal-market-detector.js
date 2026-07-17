'use strict';

/**
 * AbnormalMarketDetector
 * -----------------------
 * Doc item #53: "Flags unusual volatility or market behavior." Distinct from
 * DataIntegrityMonitor (which asks "is data still arriving?") — this asks
 * "is the data that IS arriving trustworthy enough to trade on?" A feed can
 * be perfectly "connected" while printing a flash-crash wick from a fat-
 * fingered order, a stale/frozen last-price repeated as new candles, or an
 * exchange glitch — none of which trip a connection-level check.
 *
 * Stateless per call (takes the candle window it needs each time), no new
 * data source required — reads the same OHLCV candles already in
 * candleStores.
 */
class AbnormalMarketDetector {
  constructor({
    lookback = 30,
    gapAtrMult = 3,        // open vs prior close gap, in multiples of ATR
    rangeAtrMult = 5,      // current candle range, in multiples of ATR
    wickBodyRatioMin = 4,  // wick length vs body length, for spike-and-revert
    frozenTickThreshold = 5, // consecutive identical closes = frozen feed
  } = {}) {
    this.lookback = lookback;
    this.gapAtrMult = gapAtrMult;
    this.rangeAtrMult = rangeAtrMult;
    this.wickBodyRatioMin = wickBodyRatioMin;
    this.frozenTickThreshold = frozenTickThreshold;
  }

  _atr(candles) {
    if (!candles || candles.length < 2) return null;
    let sum = 0, count = 0;
    for (let i = 1; i < candles.length; i++) {
      const cur = candles[i], prev = candles[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      sum += tr; count++;
    }
    return count > 0 ? sum / count : null;
  }

  /**
   * @param {Array} candles - full series for this symbol/timeframe, most recent last
   * @returns {{ abnormal: boolean, severity: 'none'|'elevated'|'severe', reasons: string[] }}
   */
  analyze({ candles, symbol = null } = {}) {
    const reasons = [];
    if (!candles || candles.length < this.lookback + 2) {
      return { abnormal: false, severity: 'none', reasons: [], symbol };
    }

    const window = candles.slice(-(this.lookback + 1));
    const history = window.slice(0, -1); // everything but the current candle
    const current = window[window.length - 1];
    const prior = window[window.length - 2];

    const atr = this._atr(history);

    // 1. Price gap: current open vs prior close
    if (atr && atr > 0 && prior) {
      const gap = Math.abs(current.open - prior.close);
      if (gap > atr * this.gapAtrMult) {
        reasons.push(`price gap ${gap.toFixed(5)} (${(gap / atr).toFixed(1)}x ATR) between candles`);
      }
    }

    // 2. Volatility spike: current candle's range vs typical range
    if (atr && atr > 0) {
      const range = current.high - current.low;
      if (range > atr * this.rangeAtrMult) {
        reasons.push(`candle range ${range.toFixed(5)} is ${(range / atr).toFixed(1)}x average — possible flash spike/crash`);
      }
    }

    // 3. Wick anomaly: huge wick relative to body (spike-and-revert within one candle)
    const body = Math.abs(current.close - current.open);
    const upperWick = current.high - Math.max(current.open, current.close);
    const lowerWick = Math.min(current.open, current.close) - current.low;
    const maxWick = Math.max(upperWick, lowerWick);
    if (body > 0 && maxWick / body > this.wickBodyRatioMin && atr && maxWick > atr * 0.5) {
      reasons.push(`wick-to-body ratio ${(maxWick / body).toFixed(1)}:1 — spike likely reverted within the candle`);
    }

    // 4. Frozen/duplicate-tick feed: last N candles all closing at the exact
    // same price (a "connected" feed that's silently stopped actually moving).
    const recentCloses = window.slice(-this.frozenTickThreshold).map(c => c.close);
    if (recentCloses.length === this.frozenTickThreshold && new Set(recentCloses).size === 1) {
      reasons.push(`last ${this.frozenTickThreshold} candles closed at an identical price — feed may be frozen`);
    }

    // 5. Liquidity vacuum: enormous range on near-zero volume (thin/gapped book)
    if (atr && atr > 0 && current.volume != null) {
      const avgVol = history.reduce((s, c) => s + (c.volume || 0), 0) / (history.length || 1);
      const range = current.high - current.low;
      if (avgVol > 0 && current.volume < avgVol * 0.15 && range > atr * 2) {
        reasons.push(`large range (${(range / atr).toFixed(1)}x ATR) on volume ${(current.volume / avgVol * 100).toFixed(0)}% of average — thin liquidity`);
      }
    }

    let severity = 'none';
    if (reasons.length === 1) severity = 'elevated';
    if (reasons.length >= 2) severity = 'severe';

    return { abnormal: reasons.length > 0, severity, reasons, symbol };
  }
}

module.exports = { AbnormalMarketDetector };
