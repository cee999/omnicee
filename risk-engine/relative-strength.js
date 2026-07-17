'use strict';

/**
 * RelativeStrengthEngine
 * -----------------------
 * Ranks assets by comparative performance over a lookback window — doc item
 * #23. Reads directly from the candle stores the feeds are already
 * populating (candleStores[symbol][timeframe]), so no new data source is
 * required.
 *
 * Percent change is normalized against each symbol's own recent volatility
 * (ATR-ish: average true range as % of price) so a 2% move in a low-vol
 * forex pair and a 2% move in a high-vol crypto pair aren't compared
 * apples-to-oranges — the raw % change alone would always rank crypto first.
 */
class RelativeStrengthEngine {
  constructor({ lookback = 20 } = {}) {
    this.lookback = lookback;
  }

  _pctChange(candles) {
    if (!candles || candles.length < this.lookback + 1) return null;
    const slice = candles.slice(-(this.lookback + 1));
    const start = slice[0].close;
    const end = slice[slice.length - 1].close;
    if (!start) return null;
    return ((end - start) / start) * 100;
  }

  _avgTrueRangePct(candles) {
    if (!candles || candles.length < this.lookback + 1) return null;
    const slice = candles.slice(-this.lookback);
    let sum = 0;
    let count = 0;
    for (let i = 1; i < slice.length; i++) {
      const cur = slice[i];
      const prev = slice[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      if (cur.close > 0) {
        sum += (tr / cur.close) * 100;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  }

  /**
   * @param {Object} candleStores - candleStores[symbol][timeframe] = candle[]
   * @param {string[]} symbols
   * @param {string} timeframe
   * @returns {Array<{symbol, changePct, volAdjScore, rank}>} sorted strongest-first
   */
  rank(candleStores, symbols, timeframe) {
    const rows = [];
    for (const symbol of symbols) {
      const candles = candleStores?.[symbol]?.[timeframe];
      const changePct = this._pctChange(candles);
      const atrPct = this._avgTrueRangePct(candles);
      if (changePct === null) continue;

      // Volatility-adjusted score: move size relative to typical noise for
      // that symbol. Guards against div-by-zero with a small floor.
      const volAdjScore = atrPct && atrPct > 0.01
        ? changePct / atrPct
        : changePct;

      rows.push({ symbol, changePct, atrPct, volAdjScore });
    }

    rows.sort((a, b) => b.volAdjScore - a.volAdjScore);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  /** Convenience: strongest N and weakest N in one call. */
  leadersAndLaggards(candleStores, symbols, timeframe, n = 3) {
    const ranked = this.rank(candleStores, symbols, timeframe);
    return {
      leaders: ranked.slice(0, n),
      laggards: ranked.slice(-n).reverse(),
      all: ranked,
    };
  }
}

module.exports = { RelativeStrengthEngine };
