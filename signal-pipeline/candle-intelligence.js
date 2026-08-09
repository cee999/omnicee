// note } Usage: const { CandleIntelligence } = require('./candle-intelligence'); const ci = new CandleIntelligence(); const result = ci.analyze({ candles });

'use strict';

function round(n, d = 3) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function range(c) { return c.high - c.low; }
function body(c) { return Math.abs(c.close - c.open); }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }
function isBull(c) { return c.close >= c.open; }

class CandleIntelligence {
  constructor(config = {}) {
    this.atrPeriod = config.atrPeriod || 14;
    this.trendLookback = config.trendLookback || 10;
  }

  _atr(candles) {
    if (candles.length < this.atrPeriod + 1) return avg(candles.slice(-10).map(range)) || 0.0001;
    const trs = [];
    for (let i = candles.length - this.atrPeriod; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return avg(trs) || 0.0001;
  }

  _classifyShape(c, r, b) {
    const bodyRatio = r > 0 ? b / r : 0;
    const upperRatio = r > 0 ? upperWick(c) / r : 0;
    const lowerRatio = r > 0 ? lowerWick(c) / r : 0;

    if (bodyRatio < 0.08) return 'DOJI';
    if (bodyRatio > 0.85) return isBull(c) ? 'BULL_MARUBOZU' : 'BEAR_MARUBOZU';
    if (lowerRatio > 0.55 && bodyRatio < 0.35) return 'HAMMER_REJECTION';
    if (upperRatio > 0.55 && bodyRatio < 0.35) return 'SHOOTING_STAR_REJECTION';
    if (bodyRatio >= 0.5) return isBull(c) ? 'BULLISH_BODY' : 'BEARISH_BODY';
    return 'INDECISION';
  }

  analyze({ candles } = {}) {
    if (!Array.isArray(candles) || candles.length < Math.max(this.atrPeriod, this.trendLookback) + 2) {
      return { type: 'UNKNOWN', qualityScore: 0, reason: 'insufficient_candles' };
    }

    const c = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const atr = this._atr(candles);
    const r = range(c) || 0.0001;
    const b = body(c);

    const bodyDominance = round(clamp(b / r, 0, 1), 3);
    const upperRatio = round(clamp(upperWick(c) / r, 0, 1), 3);
    const lowerRatio = round(clamp(lowerWick(c) / r, 0, 1), 3);
    const relativeSize = round(r / atr, 3);

    const shape = this._classifyShape(c, r, b);

    let engulfing = null;
    if (isBull(c) && !isBull(prev) && c.close > prev.open && c.open < prev.close) engulfing = 'BULLISH_ENGULFING';
    else if (!isBull(c) && isBull(prev) && c.close < prev.open && c.open > prev.close) engulfing = 'BEARISH_ENGULFING';

    const priorCloses = candles.slice(-this.trendLookback - 1, -1).map(x => x.close);
    const trendSlope = priorCloses.length > 1 ? (priorCloses[priorCloses.length - 1] - priorCloses[0]) / priorCloses[0] : 0;
    const priorTrend = trendSlope > 0.002 ? 'UP' : trendSlope < -0.002 ? 'DOWN' : 'FLAT';

    const candleDirection = isBull(c) ? 'UP' : 'DOWN';
    let contextAlignment;
    if (priorTrend === 'FLAT') contextAlignment = 'NEUTRAL';
    else if (candleDirection === priorTrend) contextAlignment = 'CONTINUATION';
    else contextAlignment = 'COUNTER_TREND';

    const isRejectionShape = shape === 'HAMMER_REJECTION' || shape === 'SHOOTING_STAR_REJECTION';
    const rejectionDirection = shape === 'HAMMER_REJECTION' ? 'BULLISH' : shape === 'SHOOTING_STAR_REJECTION' ? 'BEARISH' : null;
    const isExhaustionCandidate = isRejectionShape &&
      ((rejectionDirection === 'BULLISH' && priorTrend === 'DOWN') ||
       (rejectionDirection === 'BEARISH' && priorTrend === 'UP'));

    let volumeConfirmation = null;
    if (Number.isFinite(c.volume)) {
      const avgVolume = avg(candles.slice(-this.trendLookback - 1, -1).map(x => x.volume)) || 0.0001;
      const volRatio = c.volume / avgVolume;
      volumeConfirmation = round(volRatio, 2);
    }

    let score = 0;
    score += bodyDominance >= 0.5 ? bodyDominance * 35 : Math.max(upperRatio, lowerRatio) * 35;
    score += clamp(relativeSize, 0, 2) * 20;
    if (contextAlignment === 'CONTINUATION') score += 15;
    if (isExhaustionCandidate) score += 20;
    if (engulfing) score += 10;
    if (volumeConfirmation != null) {
      if (volumeConfirmation >= 1.3) score += 8;
      else if (volumeConfirmation < 0.6) score -= 8;
    }
    if (shape === 'DOJI' || shape === 'INDECISION') score -= 15;

    const qualityScore = round(clamp(score, 0, 100), 1);

    return {
      type: engulfing || shape,
      qualityScore,
      rejection: {
        isRejectionShape,
        direction: rejectionDirection,
        upperWickRatio: upperRatio,
        lowerWickRatio: lowerRatio,
        isExhaustionCandidate,
      },
      momentum: {
        bodyDominance,
        relativeSizeVsATR: relativeSize,
        volumeConfirmation,
      },
      context: {
        priorTrend,
        candleDirection,
        alignment: contextAlignment,
      },
      note: isExhaustionCandidate
        ? `${rejectionDirection === 'BULLISH' ? 'Bullish' : 'Bearish'} rejection after an extended ${priorTrend === 'DOWN' ? 'down' : 'up'}move — reads as a potential exhaustion/reversal candle, not just noise.`
        : contextAlignment === 'CONTINUATION'
          ? `${candleDirection === 'UP' ? 'Bullish' : 'Bearish'} candle in line with the prevailing short-term trend — supports continuation.`
          : 'No strong contextual read — treat mainly on its own quality score.',
    };
  }
}

module.exports = { CandleIntelligence };
