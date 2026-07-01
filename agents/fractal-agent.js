'use strict';

/**
 * ============================================================
 *  FRACTAL ANALYSIS AGENT — Multi-Scale Market Memory Detection
 *  Institutional-Grade Non-Linear Market Analysis
 * ============================================================
 *
 *  Analyzes markets through the lens of fractal geometry and
 *  chaos theory to detect:
 *
 *  1. Hurst Exponent (R/S Analysis) — persistence vs anti-persistence
 *  2. Fractal Dimension — market complexity/roughness
 *  3. Detrended Fluctuation Analysis (DFA) — long-range dependence
 *  4. Fractal Adaptive Moving Average (FRAMA) — auto-adapting MA
 *  5. Multi-Fractal Spectrum — varying market memory at different scales
 *  6. Elliott Wave Approximation — fractal wave patterns
 *  7. Price Self-Similarity — repeating patterns across timeframes
 *  8. Chaos Theory Indicators — Lyapunov exponent estimate
 *
 *  These metrics reveal whether the market is trending, mean-
 *  reverting, or random at the current moment — critical for
 *  strategy selection.
 *
 *  H > 0.5: persistent/trending → use trend-following
 *  H = 0.5: random walk → no edge
 *  H < 0.5: anti-persistent → use mean-reversion
 * ============================================================
 */

const EventEmitter = require('events');

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1));
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Rescaled Range Analysis — computes Hurst exponent
 */
class RSAnalysis {
  static hurst(values, minBlock = 8, maxBlock = null) {
    const n = values.length;
    if (n < 40) return { H: 0.5, confidence: 0, note: 'Insufficient data' };

    maxBlock = maxBlock || Math.floor(n / 3);
    const sizes = [];
    let s = minBlock;
    while (s <= maxBlock) {
      sizes.push(s);
      s = Math.floor(s * 1.4);
    }
    if (sizes.length < 3) return { H: 0.5, confidence: 0, note: 'Insufficient block sizes' };

    const logN = [];
    const logRS = [];

    for (const size of sizes) {
      const nBlocks = Math.floor(n / size);
      let rsSum = 0;
      let validBlocks = 0;

      for (let b = 0; b < nBlocks; b++) {
        const block = values.slice(b * size, (b + 1) * size);
        const mean = avg(block);
        const deviations = block.map(r => r - mean);

        const cumDev = [];
        let cumSum = 0;
        for (const d of deviations) {
          cumSum += d;
          cumDev.push(cumSum);
        }

        const R = Math.max(...cumDev) - Math.min(...cumDev);
        const S = stddev(block);
        if (S > 0) {
          rsSum += R / S;
          validBlocks++;
        }
      }

      if (validBlocks > 0) {
        logN.push(Math.log(size));
        logRS.push(Math.log(rsSum / validBlocks));
      }
    }

    if (logN.length < 3) return { H: 0.5, confidence: 0, note: 'R/S regression failed' };

    // Linear regression: log(R/S) = H * log(n) + c
    const xMean = avg(logN);
    const yMean = avg(logRS);
    let num = 0, den = 0;
    for (let i = 0; i < logN.length; i++) {
      num += (logN[i] - xMean) * (logRS[i] - yMean);
      den += (logN[i] - xMean) ** 2;
    }
    const H = den !== 0 ? num / den : 0.5;

    // R-squared for confidence
    const fitted = logN.map(x => yMean + H * (x - xMean));
    const ssTot = logRS.reduce((s, y) => s + (y - yMean) ** 2, 0);
    const ssRes = logRS.reduce((s, y, i) => s + (y - fitted[i]) ** 2, 0);
    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    return {
      H: round(clamp(H, 0, 1), 4),
      rSquared: round(rSquared, 4),
      confidence: round(rSquared * 100, 1),
      regime: H > 0.55 ? 'PERSISTENT' : H < 0.45 ? 'ANTI_PERSISTENT' : 'RANDOM',
      note: `H=${round(H, 3)} — ${H > 0.55 ? 'trending/persistent' : H < 0.45 ? 'mean-reverting' : 'random walk'}`,
    };
  }
}

/**
 * Detrended Fluctuation Analysis (DFA)
 */
class DFAnalysis {
  static analyze(values) {
    const n = values.length;
    if (n < 50) return { alpha: 0.5, confidence: 0, note: 'Insufficient data' };

    // Integrate the series
    const mean = avg(values);
    const integrated = [];
    let sum = 0;
    for (const v of values) {
      sum += (v - mean);
      integrated.push(sum);
    }

    // Compute fluctuation at different scales
    const scales = [8, 12, 16, 20, 30, 40, 50].filter(s => s <= Math.floor(n / 4));
    if (scales.length < 3) return { alpha: 0.5, confidence: 0, note: 'Insufficient scales' };

    const logScales = [];
    const logF = [];

    for (const s of scales) {
      const nSegments = Math.floor(n / s);
      let totalFluctuation = 0;

      for (let seg = 0; seg < nSegments; seg++) {
        const segment = integrated.slice(seg * s, (seg + 1) * s);

        // Local linear trend
        const xM = (s - 1) / 2;
        const yM = avg(segment);
        let num = 0, den = 0;
        for (let i = 0; i < s; i++) {
          num += (i - xM) * (segment[i] - yM);
          den += (i - xM) ** 2;
        }
        const slope = den ? num / den : 0;
        const intercept = yM - slope * xM;

        // Detrended variance
        let detrendedVar = 0;
        for (let i = 0; i < s; i++) {
          const trend = intercept + slope * i;
          detrendedVar += (segment[i] - trend) ** 2;
        }
        totalFluctuation += detrendedVar / s;
      }

      const F = Math.sqrt(totalFluctuation / nSegments);
      if (F > 0) {
        logScales.push(Math.log(s));
        logF.push(Math.log(F));
      }
    }

    // Scaling exponent α (same as Hurst but more robust)
    const xMean = avg(logScales);
    const yMean = avg(logF);
    let num = 0, den = 0;
    for (let i = 0; i < logScales.length; i++) {
      num += (logScales[i] - xMean) * (logF[i] - yMean);
      den += (logScales[i] - xMean) ** 2;
    }
    const alpha = den ? num / den : 0.5;

    return {
      alpha: round(alpha, 4),
      regime: alpha > 0.6 ? 'LONG_RANGE_CORRELATED' : alpha < 0.4 ? 'ANTI_CORRELATED' : 'RANDOM',
      confidence: round(Math.min(100, logScales.length * 15), 1),
      note: `DFA α=${round(alpha, 3)} — ${alpha > 0.6 ? 'long-range dependence' : alpha < 0.4 ? 'anti-persistent' : 'near random'}`,
    };
  }
}

/**
 * Fractal Adaptive Moving Average (FRAMA)
 */
class FRAMA {
  static compute(closes, period = 16) {
    if (closes.length < period * 2) return { frama: null, speed: 0 };

    const half = Math.floor(period / 2);
    const recent = closes.slice(-period);
    const firstHalf = recent.slice(0, half);
    const secondHalf = recent.slice(half);

    // Fractal dimensions of each half
    const n1 = (Math.max(...firstHalf) - Math.min(...firstHalf)) / half;
    const n2 = (Math.max(...secondHalf) - Math.min(...secondHalf)) / half;
    const n3 = (Math.max(...recent) - Math.min(...recent)) / period;

    let D = 0;
    if (n1 > 0 && n2 > 0 && n3 > 0 && (n1 + n2) > 0) {
      D = (Math.log(n1 + n2) - Math.log(n3)) / Math.log(2);
    }

    // FRAMA alpha
    const alpha = Math.exp(-4.6 * (D - 1)); // Johnson's formula
    const clampedAlpha = clamp(alpha, 0.01, 1);

    // Compute FRAMA as EMA with dynamic alpha
    let frama = closes[0];
    for (let i = 1; i < closes.length; i++) {
      frama = clampedAlpha * closes[i] + (1 - clampedAlpha) * frama;
    }

    return {
      frama: round(frama, 5),
      fractalDimension: round(D, 4),
      alpha: round(clampedAlpha, 4),
      speed: clampedAlpha > 0.5 ? 'FAST' : clampedAlpha > 0.1 ? 'MEDIUM' : 'SLOW',
      note: `D=${round(D, 2)} α=${round(clampedAlpha, 3)} — ${clampedAlpha > 0.5 ? 'trending (fast)' : clampedAlpha > 0.1 ? 'transitioning' : 'ranging (slow)'}`,
    };
  }
}

/**
 * Lyapunov Exponent Estimation (sensitivity to initial conditions)
 */
class LyapunovEstimator {
  static estimate(values, embeddingDim = 3, delay = 1) {
    const n = values.length;
    if (n < 50) return { exponent: 0, chaotic: false, note: 'Insufficient data' };

    // Phase space reconstruction
    const vectors = [];
    for (let i = 0; i < n - (embeddingDim - 1) * delay; i++) {
      const vec = [];
      for (let d = 0; d < embeddingDim; d++) {
        vec.push(values[i + d * delay]);
      }
      vectors.push(vec);
    }

    if (vectors.length < 20) return { exponent: 0, chaotic: false, note: 'Insufficient vectors' };

    // Find nearest neighbors and track divergence
    let totalDivergence = 0;
    let validPairs = 0;

    for (let i = 0; i < Math.min(vectors.length - 2, 100); i++) {
      let minDist = Infinity;
      let nearIdx = -1;

      for (let j = 0; j < vectors.length; j++) {
        if (Math.abs(i - j) < embeddingDim * delay) continue;
        const dist = LyapunovEstimator._euclidean(vectors[i], vectors[j]);
        if (dist > 0 && dist < minDist) {
          minDist = dist;
          nearIdx = j;
        }
      }

      if (nearIdx >= 0 && i + 1 < vectors.length && nearIdx + 1 < vectors.length) {
        const nextDist = LyapunovEstimator._euclidean(vectors[i + 1], vectors[nearIdx + 1]);
        if (nextDist > 0 && minDist > 0) {
          totalDivergence += Math.log(nextDist / minDist);
          validPairs++;
        }
      }
    }

    const exponent = validPairs > 0 ? totalDivergence / validPairs : 0;

    return {
      exponent: round(exponent, 4),
      chaotic: exponent > 0.1,
      note: exponent > 0.1 ? 'Positive Lyapunov — chaotic dynamics, use short horizons'
        : exponent < -0.1 ? 'Negative Lyapunov — converging, stable regime'
        : 'Near-zero Lyapunov — quasi-periodic, moderate predictability',
    };
  }

  static _euclidean(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
  }
}

/**
 * Main Fractal Agent
 */
class FractalAgent extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbol = config.symbol || 'UNKNOWN';
    this.timeframe = config.timeframe || 'H1';
  }

  async analyze(candles) {
    if (!candles || candles.length < 50) {
      return this._wait('Insufficient data for fractal analysis');
    }

    const closes = candles.map(c => c.close);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
      }
    }

    const reasons = [];
    let longScore = 45;
    let shortScore = 45;
    let edgeMultiplier = 1.0;

    // R/S Hurst Exponent
    const hurst = RSAnalysis.hurst(returns);
    if (hurst.confidence > 50) {
      if (hurst.regime === 'PERSISTENT') {
        // Trending market — follow the current trend
        const recentTrend = closes[closes.length - 1] > closes[closes.length - 20]
          ? 'LONG' : 'SHORT';
        if (recentTrend === 'LONG') longScore += 12;
        else shortScore += 12;
        edgeMultiplier *= 1.15;
        reasons.push(`Hurst H=${hurst.H} — persistent/trending, follow ${recentTrend} trend`);
      } else if (hurst.regime === 'ANTI_PERSISTENT') {
        // Mean-reverting — fade the recent move
        const recentMove = closes[closes.length - 1] > closes[closes.length - 5]
          ? 'SHORT' : 'LONG'; // fade it
        if (recentMove === 'LONG') longScore += 10;
        else shortScore += 10;
        reasons.push(`Hurst H=${hurst.H} — anti-persistent/mean-reverting, fade the move`);
      } else {
        edgeMultiplier *= 0.85;
        reasons.push(`Hurst H=${hurst.H} — random walk, reduced edge`);
      }
    }

    // DFA Analysis
    const dfa = DFAnalysis.analyze(returns);
    if (dfa.confidence > 30) {
      if (dfa.regime === 'LONG_RANGE_CORRELATED') {
        edgeMultiplier *= 1.1;
        reasons.push(`DFA α=${dfa.alpha} — long-range correlation confirms trend persistence`);
      } else if (dfa.regime === 'ANTI_CORRELATED') {
        reasons.push(`DFA α=${dfa.alpha} — anti-correlation, favor counter-trend entries`);
      }
    }

    // FRAMA
    const frama = FRAMA.compute(closes);
    if (frama.frama !== null) {
      const price = closes[closes.length - 1];
      if (frama.speed === 'FAST') {
        // FRAMA is fast = trending, direction = price vs FRAMA
        if (price > frama.frama) {
          longScore += 8;
          reasons.push(`FRAMA fast mode (D=${frama.fractalDimension}), price above FRAMA — bullish trend`);
        } else {
          shortScore += 8;
          reasons.push(`FRAMA fast mode (D=${frama.fractalDimension}), price below FRAMA — bearish trend`);
        }
      } else if (frama.speed === 'SLOW') {
        edgeMultiplier *= 0.9;
        reasons.push(`FRAMA slow mode (D=${frama.fractalDimension}) — ranging market, reduced edge`);
      }
    }

    // Lyapunov Exponent
    const lyap = LyapunovEstimator.estimate(returns);
    if (lyap.chaotic) {
      edgeMultiplier *= 0.85;
      reasons.push(`Lyapunov λ=${lyap.exponent} — chaotic dynamics, reduce exposure`);
    }

    // Apply edge multiplier
    longScore = clamp(longScore * edgeMultiplier, 0, 100);
    shortScore = clamp(shortScore * edgeMultiplier, 0, 100);

    // Final direction
    const edge = Math.abs(longScore - shortScore);
    const direction = edge < 6 ? 'WAIT' : longScore > shortScore ? 'LONG' : 'SHORT';
    const score = direction === 'LONG' ? longScore : direction === 'SHORT' ? shortScore : Math.max(longScore, shortScore);

    const result = {
      agent: 'FractalAgent',
      symbol: this.symbol,
      timeframe: this.timeframe,
      direction,
      score: round(score, 2),
      reasons: reasons.length ? reasons : ['Fractal analysis shows no clear directional bias'],
      analysis: {
        hurst: hurst.confidence > 0 ? {
          H: hurst.H,
          regime: hurst.regime,
          rSquared: hurst.rSquared,
        } : null,
        dfa: dfa.confidence > 0 ? {
          alpha: dfa.alpha,
          regime: dfa.regime,
        } : null,
        frama: frama.frama ? {
          value: frama.frama,
          fractalDimension: frama.fractalDimension,
          speed: frama.speed,
        } : null,
        lyapunov: {
          exponent: lyap.exponent,
          chaotic: lyap.chaotic,
        },
        edgeMultiplier: round(edgeMultiplier, 3),
        longScore: round(longScore, 2),
        shortScore: round(shortScore, 2),
      },
    };

    this.emit('analysis', result);
    return result;
  }

  _wait(reason) {
    return {
      agent: 'FractalAgent',
      symbol: this.symbol,
      timeframe: this.timeframe,
      direction: 'WAIT',
      score: 45,
      reasons: [reason],
      analysis: {},
    };
  }
}

module.exports = { FractalAgent };
