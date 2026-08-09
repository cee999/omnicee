'use strict';

/**
 * Hurst Analysis Layer — separate from signal voting.
 * Classifies path-dependence regime per symbol/TF and recommends a
 * playbook (trend-follow / mean-revert / stand-aside). Does not fire
 * trades; analysis only. Signal agents remain independent.
 */

const { RSAnalysis, DFAnalysis } = require('../agents/fractal-agent');

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

function playbookFromHurst(H, confidence, closes) {
  if (!(confidence > 35) || !Number.isFinite(H)) {
    return {
      playbook: 'STAND_ASIDE',
      bias: 'NONE',
      label: 'Low confidence',
      detail: 'Not enough structure in R/S estimate — do not lean on Hurst alone.',
    };
  }
  if (H > 0.55) {
    const up = closes[closes.length - 1] > closes[Math.max(0, closes.length - 20)];
    return {
      playbook: 'TREND_FOLLOW',
      bias: up ? 'LONG' : 'SHORT',
      label: 'Persistent / trending',
      detail: up
        ? 'Favor continuation longs / pullback buys in trend direction.'
        : 'Favor continuation shorts / pullback sells in trend direction.',
    };
  }
  if (H < 0.45) {
    const up5 = closes[closes.length - 1] > closes[Math.max(0, closes.length - 5)];
    return {
      playbook: 'MEAN_REVERT',
      bias: up5 ? 'SHORT' : 'LONG',
      label: 'Anti-persistent / ranging',
      detail: up5
        ? 'Recent push up — fade toward range mid / support. Trade edges, not mids.'
        : 'Recent push down — fade toward range mid / resistance. Trade edges, not mids.',
    };
  }
  return {
    playbook: 'STAND_ASIDE',
    bias: 'NONE',
    label: 'Random walk',
    detail: 'Path dependence is weak — reduce size or wait for clearer regime.',
  };
}

/**
 * @param {Array<{close:number}>} candles
 * @param {{ symbol?: string, timeframe?: string }} meta
 */
function analyzeHurst(candles, meta = {}) {
  const symbol = meta.symbol || 'UNKNOWN';
  const timeframe = meta.timeframe || 'H1';
  if (!Array.isArray(candles) || candles.length < 40) {
    return {
      symbol,
      timeframe,
      ok: false,
      reason: 'Need ≥40 candles for Hurst R/S',
      H: null,
      confidence: 0,
      regime: 'UNKNOWN',
      playbook: 'STAND_ASIDE',
      bias: 'NONE',
      layer: 'hurst_analysis',
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
    layer: 'hurst_analysis', // explicit: not a signal vote
    H: hurst.H,
    confidence: hurst.confidence,
    rSquared: hurst.rSquared,
    regime: hurst.regime,
    note: hurst.note,
    dfa: dfa && dfa.confidence > 0 ? { alpha: dfa.alpha, regime: dfa.regime, confidence: dfa.confidence } : null,
    playbook: pb.playbook,
    bias: pb.bias,
    label: pb.label,
    detail: pb.detail,
    bars: closes.length,
    ts: Date.now(),
  };
}

/**
 * Build a multi-symbol Hurst board from candleStores.
 * candleStores[symbol][tf] = candle[]
 */
function buildHurstBoard(candleStores, symbols, timeframes = ['H1', 'H4']) {
  const board = [];
  for (const symbol of symbols || []) {
    const byTf = candleStores?.[symbol] || {};
    const tfs = {};
    for (const tf of timeframes) {
      const candles = byTf[tf];
      if (candles?.length) tfs[tf] = analyzeHurst(candles, { symbol, timeframe: tf });
    }
    // Prefer H1 for primary row, else first available
    const primary = tfs.H1 || tfs.H4 || Object.values(tfs)[0] || null;
    if (primary) {
      board.push({
        ...primary,
        multi: tfs,
      });
    }
  }
  // Sort: MEAN_REVERT and TREND_FOLLOW before STAND_ASIDE, then by |H-0.5|
  board.sort((a, b) => {
    const rank = (p) => (p === 'MEAN_REVERT' || p === 'TREND_FOLLOW' ? 0 : 1);
    const dr = rank(a.playbook) - rank(b.playbook);
    if (dr !== 0) return dr;
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
    return { board: this._lastBoard, ts: this._lastTs };
  }
}

module.exports = {
  analyzeHurst,
  buildHurstBoard,
  HurstAnalysisEngine,
};
