'use strict';

/**
 * Standalone Advanced Analysis layer.
 * Completely independent of signal scoring, HurstAnalysisEngine instance,
 * and agent votes. Computes path-dependence metrics on demand from candles:
 *   - R/S Hurst exponent
 *   - Hardened DFA (α, R²)
 *   - FRAMA fractal dimension / adaptive speed
 *   - Lyapunov estimate (chaos indicator)
 *
 * Does not fire trades or mutate risk. Safe to call from /api/analysis only.
 */

const { RSAnalysis, DFAnalysis } = require('../agents/fractal-agent');

// FRAMA + Lyapunov live in fractal-agent but are not exported — reimplement
// thin local helpers so this module stays self-contained (no engine wiring).

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : null;
}

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

function framaMetrics(closes, period = 16) {
  if (!closes || closes.length < period * 2) {
    return { frama: null, fractalDimension: null, alpha: null, speed: null, note: 'Need more bars for FRAMA' };
  }
  const half = Math.floor(period / 2);
  const recent = closes.slice(-period);
  const firstHalf = recent.slice(0, half);
  const secondHalf = recent.slice(half);
  const n1 = (Math.max(...firstHalf) - Math.min(...firstHalf)) / half;
  const n2 = (Math.max(...secondHalf) - Math.min(...secondHalf)) / half;
  const n3 = (Math.max(...recent) - Math.min(...recent)) / period;
  let D = 1;
  if (n1 > 0 && n2 > 0 && n3 > 0 && (n1 + n2) > 0) {
    D = (Math.log(n1 + n2) - Math.log(n3)) / Math.log(2);
  }
  const alpha = clamp(Math.exp(-4.6 * (D - 1)), 0.01, 1);
  let frama = closes[0];
  for (let i = 1; i < closes.length; i++) {
    frama = alpha * closes[i] + (1 - alpha) * frama;
  }
  return {
    frama: round(frama, 5),
    fractalDimension: round(D, 4),
    alpha: round(alpha, 4),
    speed: alpha > 0.5 ? 'FAST' : alpha > 0.1 ? 'MEDIUM' : 'SLOW',
    note: `D=${round(D, 2)} α=${round(alpha, 3)} — ${alpha > 0.5 ? 'trending (fast)' : alpha > 0.1 ? 'transitioning' : 'ranging (slow)'}`,
  };
}

function lyapunovEstimate(values, embeddingDim = 3, delay = 1) {
  const n = values.length;
  if (n < 60) return { exponent: 0, chaotic: false, note: 'Insufficient data for Lyapunov' };
  const vectors = [];
  for (let i = 0; i < n - (embeddingDim - 1) * delay; i++) {
    const vec = [];
    for (let d = 0; d < embeddingDim; d++) vec.push(values[i + d * delay]);
    vectors.push(vec);
  }
  if (vectors.length < 30) return { exponent: 0, chaotic: false, note: 'Insufficient vectors' };

  // Rough Rosenstein-style: average log divergence of nearest neighbors over short steps
  const maxSteps = 8;
  const divergences = new Array(maxSteps).fill(0);
  const counts = new Array(maxSteps).fill(0);
  const sample = Math.min(vectors.length - maxSteps - 1, 80);
  const step = Math.max(1, Math.floor((vectors.length - maxSteps) / sample));

  for (let i = 0; i < vectors.length - maxSteps; i += step) {
    let bestDist = Infinity;
    let bestJ = -1;
    for (let j = 0; j < vectors.length - maxSteps; j++) {
      if (Math.abs(i - j) < embeddingDim) continue;
      let dist = 0;
      for (let k = 0; k < embeddingDim; k++) dist += (vectors[i][k] - vectors[j][k]) ** 2;
      dist = Math.sqrt(dist);
      if (dist > 1e-12 && dist < bestDist) {
        bestDist = dist;
        bestJ = j;
      }
    }
    if (bestJ < 0 || bestDist <= 0) continue;
    for (let s = 0; s < maxSteps; s++) {
      let d = 0;
      for (let k = 0; k < embeddingDim; k++) {
        d += (vectors[i + s][k] - vectors[bestJ + s][k]) ** 2;
      }
      d = Math.sqrt(d);
      if (d > 1e-12) {
        divergences[s] += Math.log(d / bestDist);
        counts[s]++;
      }
    }
  }

  const xs = [];
  const ys = [];
  for (let s = 1; s < maxSteps; s++) {
    if (counts[s] > 5) {
      xs.push(s);
      ys.push(divergences[s] / counts[s]);
    }
  }
  if (xs.length < 3) return { exponent: 0, chaotic: false, note: 'Lyapunov fit failed' };
  const xM = avg(xs), yM = avg(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xM) * (ys[i] - yM);
    den += (xs[i] - xM) ** 2;
  }
  const exponent = den ? num / den : 0;
  return {
    exponent: round(exponent, 5),
    chaotic: exponent > 0.01,
    note: exponent > 0.01
      ? `λ≈${round(exponent, 4)} — sensitive / chaotic regime`
      : `λ≈${round(exponent, 4)} — stable / non-chaotic`,
  };
}

function playbookFromMetrics(H, dfaAlpha, confH, confDfa) {
  const conf = Math.max(Number(confH) || 0, Number(confDfa) || 0);
  if (conf < 40 || !Number.isFinite(H)) {
    return {
      playbook: 'STAND_ASIDE',
      bias: 'NONE',
      label: 'Low confidence',
      detail: 'Estimates too weak — wait for more data / higher R².',
    };
  }
  const alpha = Number.isFinite(dfaAlpha) ? dfaAlpha : H;
  const persistent = (H >= 0.58 && alpha >= 0.55) || (H >= 0.62);
  const antipersistent = (H <= 0.42 && alpha <= 0.45) || (H <= 0.38);
  if (conf >= 55 && persistent) {
    return {
      playbook: 'TREND_FOLLOW',
      bias: 'DIRECTIONAL',
      label: 'Persistent path',
      detail: `H=${round(H, 3)} α=${round(alpha, 3)} — long-range dependence favors trend continuation.`,
    };
  }
  if (conf >= 55 && antipersistent) {
    return {
      playbook: 'MEAN_REVERT',
      bias: 'REVERSION',
      label: 'Anti-persistent',
      detail: `H=${round(H, 3)} α=${round(alpha, 3)} — mean-reversion / fade extremes.`,
    };
  }
  return {
    playbook: 'STAND_ASIDE',
    bias: 'NONE',
    label: 'Near random / mixed',
    detail: `H=${round(H, 3)} α=${round(alpha, 3)} — no clear path-dependence edge.`,
  };
}

/**
 * Full advanced analysis for one candle series.
 * @param {Array<{close:number}>} candles
 * @param {{ symbol?: string, timeframe?: string }} meta
 */
function analyzeSeries(candles, meta = {}) {
  const symbol = meta.symbol || 'UNKNOWN';
  const timeframe = meta.timeframe || 'H1';
  const minBars = 40;

  if (!Array.isArray(candles) || candles.length < minBars) {
    return {
      ok: false,
      symbol,
      timeframe,
      reason: `Need ≥${minBars} candles`,
      layer: 'advanced_analysis',
    };
  }

  const closes = candles.map(c => Number(c.close ?? c.c)).filter(Number.isFinite);
  if (closes.length < minBars) {
    return {
      ok: false,
      symbol,
      timeframe,
      reason: 'Insufficient finite closes',
      layer: 'advanced_analysis',
    };
  }

  const returns = logReturns(closes);
  const hurst = RSAnalysis.hurst(returns);
  const dfa = returns.length >= 50 ? DFAnalysis.analyze(returns) : null;
  const frama = framaMetrics(closes);
  const lyap = lyapunovEstimate(returns);
  const pb = playbookFromMetrics(
    hurst.H,
    dfa?.alpha,
    hurst.confidence,
    dfa?.confidence
  );

  return {
    ok: true,
    layer: 'advanced_analysis',
    symbol,
    timeframe,
    bars: closes.length,
    hurst: {
      H: hurst.H,
      confidence: hurst.confidence,
      rSquared: hurst.rSquared ?? null,
      regime: hurst.regime,
      note: hurst.note,
    },
    dfa: dfa && dfa.confidence > 0
      ? {
          alpha: dfa.alpha,
          rSquared: dfa.rSquared,
          confidence: dfa.confidence,
          regime: dfa.regime,
          scalesUsed: dfa.scalesUsed,
          note: dfa.note,
        }
      : null,
    frama: frama.frama != null ? frama : null,
    lyapunov: lyap,
    playbook: pb.playbook,
    bias: pb.bias,
    label: pb.label,
    detail: pb.detail,
    ts: Date.now(),
  };
}

/**
 * Build a multi-symbol / multi-TF board from candleStores.
 * Pure function — no shared engine state.
 */
function buildAdvancedBoard(candleStores, symbols, timeframes = ['H1', 'H4']) {
  const board = [];
  const syms = symbols?.length ? symbols : Object.keys(candleStores || {});
  for (const symbol of syms) {
    const byTf = candleStores?.[symbol] || {};
    const tfs = {};
    for (const tf of timeframes) {
      const candles = byTf[tf];
      if (candles?.length) tfs[tf] = analyzeSeries(candles, { symbol, timeframe: tf });
    }
    const primary = tfs.H1 || tfs.H4 || Object.values(tfs)[0] || null;
    if (primary && primary.ok) {
      board.push({ ...primary, multi: tfs });
    }
  }
  board.sort((a, b) => {
    const rank = (p) => (p === 'TREND_FOLLOW' || p === 'MEAN_REVERT' ? 0 : 1);
    const dr = rank(a.playbook) - rank(b.playbook);
    if (dr !== 0) return dr;
    const ha = Math.abs((a.hurst?.H ?? 0.5) - 0.5);
    const hb = Math.abs((b.hurst?.H ?? 0.5) - 0.5);
    return hb - ha;
  });
  return board;
}

module.exports = {
  analyzeSeries,
  buildAdvancedBoard,
  framaMetrics,
  lyapunovEstimate,
};
