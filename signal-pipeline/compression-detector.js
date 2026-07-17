/**
 * ============================================================
 *  COMPRESSION DETECTOR — Volatility Squeeze / Expansion Engine
 *  AI Trading Assistant · Layer 5 · Signal Pipeline
 * ============================================================
 *
 *  Identifies periods where price range and volatility have
 *  tightened well below their recent norm — conditions that
 *  historically precede an expansion move. Combines:
 *
 *    - Bollinger Band Width percentile (BBW squeeze)
 *    - ATR contraction vs its own moving average
 *    - Range compression (Donchian channel narrowing)
 *    - Consecutive small-range candle count
 *
 *  into a single 0-100 "compression score" plus a directional
 *  bias hint (which side the eventual expansion is more likely
 *  to break toward), based on where price sits inside the
 *  compression range and recent higher-timeframe drift.
 *
 *  Input:  candles (OHLCV), optional higherTFCandles for bias
 *  Output: { compressionScore, isCompressed, biasHint, detail }
 *
 *  Usage:
 *    const { CompressionDetector } = require('./compression-detector');
 *    const detector = new CompressionDetector();
 *    const result = detector.analyze({ candles });
 * ============================================================
 */

'use strict';

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const v = arr.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

function stddev(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(avg(arr.map(x => (x - m) ** 2)));
}

function percentileRank(value, arr) {
  if (!arr.length) return 50;
  const below = arr.filter(v => v <= value).length;
  return round((below / arr.length) * 100, 1);
}

function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    out.push(avg(values.slice(i - period + 1, i + 1)));
  }
  return out;
}

class CompressionDetector {
  constructor(config = {}) {
    this.bbPeriod = config.bbPeriod || 20;
    this.bbStdDev = config.bbStdDev || 2;
    this.atrPeriod = config.atrPeriod || 14;
    this.donchianPeriod = config.donchianPeriod || 20;
    this.lookback = config.lookback || 100; // history window for percentile ranking
    this.squeezePercentile = config.squeezePercentile ?? 20; // below this = squeeze
    this.smallRangeThreshold = config.smallRangeThreshold ?? 0.6; // vs avg range
  }

  _bollingerWidth(closes) {
    const widths = [];
    for (let i = this.bbPeriod - 1; i < closes.length; i++) {
      const window = closes.slice(i - this.bbPeriod + 1, i + 1);
      const mean = avg(window);
      const sd = stddev(window);
      const upper = mean + this.bbStdDev * sd;
      const lower = mean - this.bbStdDev * sd;
      widths.push(mean !== 0 ? (upper - lower) / mean : 0);
    }
    return widths;
  }

  _trueRanges(candles) {
    const trs = [0];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close),
      ));
    }
    return trs;
  }

  analyze({ candles, higherTFCandles } = {}) {
    const minNeeded = Math.max(this.bbPeriod, this.atrPeriod, this.donchianPeriod) + this.lookback;
    if (!Array.isArray(candles) || candles.length < Math.min(minNeeded, this.bbPeriod + 30)) {
      return { compressionScore: 0, isCompressed: false, biasHint: 'NEUTRAL', reason: 'insufficient_candles' };
    }

    const closes = candles.map(c => c.close);
    const trs = this._trueRanges(candles);
    const atrSeries = sma(trs, this.atrPeriod).filter(Number.isFinite);
    const bbwSeries = this._bollingerWidth(closes);

    const histBBW = bbwSeries.slice(-this.lookback, -1);
    const currentBBW = bbwSeries[bbwSeries.length - 1];
    const bbwPercentile = percentileRank(currentBBW, histBBW.length ? histBBW : bbwSeries);

    const histATR = atrSeries.slice(-this.lookback, -1);
    const currentATR = atrSeries[atrSeries.length - 1];
    const atrPercentile = percentileRank(currentATR, histATR.length ? histATR : atrSeries);

    // Donchian channel narrowing: compare current N-period high-low range
    // to the average of the prior several N-period ranges.
    const donchianWindow = candles.slice(-this.donchianPeriod);
    const currentDonchianRange = Math.max(...donchianWindow.map(c => c.high)) - Math.min(...donchianWindow.map(c => c.low));
    const priorRanges = [];
    for (let i = 1; i <= 5; i++) {
      const seg = candles.slice(-this.donchianPeriod * (i + 1), -this.donchianPeriod * i);
      if (seg.length < this.donchianPeriod * 0.6) continue;
      priorRanges.push(Math.max(...seg.map(c => c.high)) - Math.min(...seg.map(c => c.low)));
    }
    const avgPriorRange = avg(priorRanges) || currentDonchianRange;
    const donchianRatio = avgPriorRange > 0 ? currentDonchianRange / avgPriorRange : 1;

    // Consecutive small-range candles (relative to recent average range)
    const recentRanges = candles.slice(-20).map(c => c.high - c.low);
    const avgRecentRange = avg(recentRanges) || 0.0001;
    let consecutiveSmall = 0;
    for (let i = candles.length - 1; i >= Math.max(0, candles.length - 15); i--) {
      const r = candles[i].high - candles[i].low;
      if (r <= avgRecentRange * this.smallRangeThreshold) consecutiveSmall++;
      else break;
    }

    // Composite compression score (0-100, higher = tighter/more compressed)
    const bbwScore = round(100 - bbwPercentile, 1);       // low BBW percentile => high score
    const atrScore = round(100 - atrPercentile, 1);
    const donchianScore = round(Math.max(0, Math.min(100, (1 - donchianRatio) * 150)), 1);
    const streakScore = round(Math.min(100, consecutiveSmall * 12), 1);

    const compressionScore = round(
      bbwScore * 0.35 + atrScore * 0.30 + donchianScore * 0.20 + streakScore * 0.15, 1
    );

    const isCompressed = compressionScore >= (100 - this.squeezePercentile);

    // Directional bias hint: where does price sit within the compression
    // range, and (if provided) what's the higher-timeframe drift?
    const rangeHigh = Math.max(...donchianWindow.map(c => c.high));
    const rangeLow = Math.min(...donchianWindow.map(c => c.low));
    const posInRange = rangeHigh !== rangeLow ? (closes[closes.length - 1] - rangeLow) / (rangeHigh - rangeLow) : 0.5;

    let htfDrift = 0;
    if (Array.isArray(higherTFCandles) && higherTFCandles.length >= 10) {
      const htfCloses = higherTFCandles.map(c => c.close);
      htfDrift = (htfCloses[htfCloses.length - 1] - htfCloses[htfCloses.length - 10]) / htfCloses[htfCloses.length - 10];
    }

    let biasHint = 'NEUTRAL';
    const leanScore = (posInRange - 0.5) * 2 + htfDrift * 10; // combine positional + drift lean
    if (leanScore > 0.15) biasHint = 'UPSIDE_LEAN';
    else if (leanScore < -0.15) biasHint = 'DOWNSIDE_LEAN';

    return {
      compressionScore,
      isCompressed,
      biasHint,
      detail: {
        bbwPercentile,
        atrPercentile,
        donchianRatio: round(donchianRatio, 3),
        consecutiveSmallRangeCandles: consecutiveSmall,
        positionInRange: round(posInRange, 2),
        higherTFDrift: round(htfDrift, 4),
        rangeHigh: round(rangeHigh),
        rangeLow: round(rangeLow),
      },
      note: isCompressed
        ? 'Volatility and range are historically tight — expansion risk is elevated; avoid fading range extremes and prepare for a breakout in either direction.'
        : 'No significant compression detected at this timeframe.',
    };
  }
}

module.exports = { CompressionDetector };
