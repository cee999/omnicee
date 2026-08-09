'use strict';

/**
 * Hurst Analysis Layer — separate from signal voting.
 * Classifies path-dependence regime per symbol/TF and recommends a
 * playbook (trend-follow / mean-revert / stand-aside). Does not fire
 * trades; analysis only. Signal agents remain independent.
 *
 * Confidence thresholds (R/S r² × 100 from fractal RSAnalysis):
 *   LOW    < 40  → always STAND_ASIDE (estimate too weak)
 *   MEDIUM 40–55 → provisional regime label only; no directional bias
 *   HIGH   ≥ 55  → full playbook + directional bias when |H − 0.5| is clear
 *
 * H bands (only applied when confidence allows):
 *   H ≥ 0.58 + HIGH conf → TREND_FOLLOW
 *   H ≤ 0.42 + HIGH conf → MEAN_REVERT
 *   else within dead-zone or weak conf → STAND_ASIDE
 */

const { RSAnalysis, DFAnalysis } = require('../agents/fractal-agent');

/** Explicit thresholds — tune via env without code edits */
const THRESHOLDS = {
  CONF_LOW: Number(process.env.HURST_CONF_LOW || 40),
  CONF_HIGH: Number(process.env.HURST_CONF_HIGH || 55),
  H_TREND: Number(process.env.HURST_H_TREND || 0.58),
  H_REVERT: Number(process.env.HURST_H_REVERT || 0.42),
  MIN_BARS: Number(process.env.HURST_MIN_BARS || 40),
  MIN_BARS_HIGH: Number(process.env.HURST_MIN_BARS_HIGH || 80),
};

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : null;
}

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

function confidenceTier(confidence, bars) {
  const conf = Number(confidence) || 0;
  if (bars < THRESHOLDS.MIN_BARS) return 'LOW';
  if (conf < THRESHOLDS.CONF_LOW) return 'LOW';
  if (conf < THRESHOLDS.CONF_HIGH || bars < THRESHOLDS.MIN_BARS_HIGH) return 'MEDIUM';
  return 'HIGH';
}

/**
 * Apply confidence gates before assigning playbook / bias.
 * @returns {{ playbook, bias, label, detail, confidenceTier, thresholds }}
 */
function playbookFromHurst(H, confidence, closes) {
  const bars = closes.length;
  const tier = confidenceTier(confidence, bars);
  const thresholds = { ...THRESHOLDS, appliedTier: tier };

  if (tier === 'LOW' || !Number.isFinite(H)) {
    return {
      playbook: 'STAND_ASIDE',
      bias: 'NONE',
      label: 'Low confidence',
      detail: `Confidence ${round(confidence, 1)}% < ${THRESHOLDS.CONF_LOW}% (or too few bars) — ignore Hurst until R/S stabilizes.`,
      confidenceTier: tier,
      thresholds,
    };
  }

  // MEDIUM: name the regime softly, but do not assign directional bias
  if (tier === 'MEDIUM') {
    if (H >= THRESHOLDS.H_TREND) {
      return {
        playbook: 'STAND_ASIDE',
        bias: 'NONE',
        label: 'Possible trend (provisional)',
        detail: `H=${round(H, 3)} looks persistent but confidence is only medium (${round(confidence, 1)}% / need ≥${THRESHOLDS.CONF_HIGH}% and ≥${THRESHOLDS.MIN_BARS_HIGH} bars). Watch structure; do not size on Hurst alone.`,
        confidenceTier: tier,
        thresholds,
      };
    }
    if (H <= THRESHOLDS.H_REVERT) {
      return {
        playbook: 'STAND_ASIDE',
        bias: 'NONE',
        label: 'Possible range (provisional)',
        detail: `H=${round(H, 3)} looks mean-reverting but confidence is medium (${round(confidence, 1)}%). Prefer range edges only with structure confirmation.`,
        confidenceTier: tier,
        thresholds,
      };
    }
    return {
      playbook: 'STAND_ASIDE',
      bias: 'NONE',
      label: 'Unclear / random',
      detail: `H=${round(H, 3)} near random walk with medium confidence — stand aside on Hurst.`,
      confidenceTier: tier,
      thresholds,
    };
  }

  // HIGH confidence — full playbooks
  if (H >= THRESHOLDS.H_TREND) {
    const up = closes[closes.length - 1] > closes[Math.max(0, closes.length - 20)];
    return {
      playbook: 'TREND_FOLLOW',
      bias: up ? 'LONG' : 'SHORT',
      label: 'Persistent / trending',
      detail: up
        ? `High-confidence trend regime (H=${round(H, 3)}, conf ${round(confidence, 1)}%). Favor continuation longs / pullback buys.`
        : `High-confidence trend regime (H=${round(H, 3)}, conf ${round(confidence, 1)}%). Favor continuation shorts / pullback sells.`,
      confidenceTier: tier,
      thresholds,
    };
  }

  if (H <= THRESHOLDS.H_REVERT) {
    const up5 = closes[closes.length - 1] > closes[Math.max(0, closes.length - 5)];
    return {
      playbook: 'MEAN_REVERT',
      bias: up5 ? 'SHORT' : 'LONG',
      label: 'Anti-persistent / ranging',
      detail: up5
        ? `High-confidence mean-revert (H=${round(H, 3)}, conf ${round(confidence, 1)}%). Fade strength toward mid/support — trade edges.`
        : `High-confidence mean-revert (H=${round(H, 3)}, conf ${round(confidence, 1)}%). Fade weakness toward mid/resistance — trade edges.`,
      confidenceTier: tier,
      thresholds,
    };
  }

  return {
    playbook: 'STAND_ASIDE',
    bias: 'NONE',
    label: 'Random walk',
    detail: `High confidence but H=${round(H, 3)} sits in the dead zone (${THRESHOLDS.H_REVERT}–${THRESHOLDS.H_TREND}) — no Hurst edge.`,
    confidenceTier: tier,
    thresholds,
  };
}

/**
 * @param {Array<{close:number}>} candles
 * @param {{ symbol?: string, timeframe?: string }} meta
 */
function analyzeHurst(candles, meta = {}) {
  const symbol = meta.symbol || 'UNKNOWN';
  const timeframe = meta.timeframe || 'H1';
  if (!Array.isArray(candles) || candles.length < THRESHOLDS.MIN_BARS) {
    return {
      symbol,
      timeframe,
      ok: false,
      reason: `Need ≥${THRESHOLDS.MIN_BARS} candles for Hurst R/S`,
      H: null,
      confidence: 0,
      confidenceTier: 'LOW',
      regime: 'UNKNOWN',
      playbook: 'STAND_ASIDE',
      bias: 'NONE',
      layer: 'hurst_analysis',
      thresholds: { ...THRESHOLDS },
    };
  }

  const closes = candles.map(c => Number(c.close)).filter(Number.isFinite);
  const returns = logReturns(closes);
  const hurst = RSAnalysis.hurst(returns);
  const dfa = returns.length >= 50 ? DFAnalysis.analyze(returns) : null;
  const pb = playbookFromHurst(hurst.H, hurst.confidence, closes);

  return {
    symbol,
    timeframe,
    ok: true,
    layer: 'hurst_analysis',
    H: hurst.H,
    confidence: hurst.confidence,
    confidenceTier: pb.confidenceTier,
    rSquared: hurst.rSquared,
    regime: hurst.regime,
    note: hurst.note,
    dfa: dfa && dfa.confidence > 0
      ? {
          alpha: dfa.alpha,
          rSquared: dfa.rSquared,
          regime: dfa.regime,
          confidence: dfa.confidence,
          scalesUsed: dfa.scalesUsed,
          order: dfa.order,
          note: dfa.note,
        }
      : null,
    playbook: pb.playbook,
    bias: pb.bias,
    label: pb.label,
    detail: pb.detail,
    thresholds: pb.thresholds,
    bars: closes.length,
    ts: Date.now(),
  };
}

function buildHurstBoard(candleStores, symbols, timeframes = ['H1', 'H4']) {
  const board = [];
  for (const symbol of symbols || []) {
    const byTf = candleStores?.[symbol] || {};
    const tfs = {};
    for (const tf of timeframes) {
      const candles = byTf[tf];
      if (candles?.length) tfs[tf] = analyzeHurst(candles, { symbol, timeframe: tf });
    }
    const primary = tfs.H1 || tfs.H4 || Object.values(tfs)[0] || null;
    if (primary) {
      board.push({
        ...primary,
        multi: tfs,
      });
    }
  }
  // HIGH-confidence actionable playbooks first, then by |H-0.5|
  board.sort((a, b) => {
    const tierRank = (t) => (t === 'HIGH' ? 0 : t === 'MEDIUM' ? 1 : 2);
    const playRank = (p) => (p === 'MEAN_REVERT' || p === 'TREND_FOLLOW' ? 0 : 1);
    const dt = tierRank(a.confidenceTier) - tierRank(b.confidenceTier);
    if (dt !== 0) return dt;
    const dp = playRank(a.playbook) - playRank(b.playbook);
    if (dp !== 0) return dp;
    return Math.abs((b.H ?? 0.5) - 0.5) - Math.abs((a.H ?? 0.5) - 0.5);
  });
  return board;
}

class HurstAnalysisEngine {
  constructor(config = {}) {
    this.timeframes = config.timeframes || ['H1', 'H4'];
    this._lastBoard = [];
    this._lastTs = 0;
  }

  analyzeSymbol(candles, symbol, timeframe) {
    return analyzeHurst(candles, { symbol, timeframe });
  }

  buildBoard(candleStores, symbols) {
    this._lastBoard = buildHurstBoard(candleStores, symbols, this.timeframes);
    this._lastTs = Date.now();
    return this._lastBoard;
  }

  getLastBoard() {
    return { board: this._lastBoard, ts: this._lastTs, thresholds: { ...THRESHOLDS } };
  }
}

module.exports = {
  analyzeHurst,
  buildHurstBoard,
  HurstAnalysisEngine,
  THRESHOLDS,
};
