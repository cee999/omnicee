'use strict';

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

  rank(candleStores, symbols, timeframe) {
    const rows = [];
    for (const symbol of symbols) {
      const candles = candleStores?.[symbol]?.[timeframe];
      const changePct = this._pctChange(candles);
      const atrPct = this._avgTrueRangePct(candles);
      if (changePct === null) continue;

      const volAdjScore = atrPct && atrPct > 0.01
        ? changePct / atrPct
        : changePct;

      rows.push({ symbol, changePct, atrPct, volAdjScore });
    }

    rows.sort((a, b) => b.volAdjScore - a.volAdjScore);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

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
