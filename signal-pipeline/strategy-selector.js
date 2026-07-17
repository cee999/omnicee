/**
 * ============================================================
 *  AI STRATEGY SELECTOR
 *  AI Trading Assistant · Layer 5 · Signal Pipeline
 * ============================================================
 *
 *  Doc item #5: "Chooses the most appropriate strategy for current
 *  market conditions."
 *
 *  This is deliberately NOT a black box. It's a transparent, rule-based
 *  mapping from RegimeEngine's output (trend / structure / volatility /
 *  tradeability) to:
 *
 *    - a named strategy profile ("what kind of setup should even be
 *      considered right now")
 *    - a confidence multiplier applied to the already-scored signal
 *      (rewards signals that fit the current regime, penalizes ones
 *      that fight it — e.g. a breakout call inside a CHOP regime)
 *    - a regime-appropriate minimum-score bar (choppy/uncertain
 *      regimes should require more agreement before firing, not less)
 *    - which of the 6 voting agents the current regime historically
 *      rewards weighting more heavily — informational context for
 *      review, not a live re-weighting of the scorer itself (that
 *      would need per-symbol scorer state and isn't worth the added
 *      concurrency risk for a shared, multi-symbol scorer instance)
 *
 *  If an `adaptiveLearningEngine` is supplied and has recorded enough
 *  outcomes for this exact regime, its actual historical win rate for
 *  that regime nudges the confidence multiplier further — real
 *  evidence, not another static rule. Below the sample-size floor it's
 *  ignored rather than trusted.
 *
 *  This does NOT and cannot guarantee accuracy — no regime classifier
 *  can see a black-swan move coming, and a "DIRECTIONAL" read can flip
 *  mid-bar. Treat the multiplier as a lean, not a certainty.
 *
 *  Usage:
 *    const { StrategySelector } = require('./strategy-selector');
 *    const selector = new StrategySelector();
 *    const rec = selector.select({ regime, signalAction: signal.action, adaptiveLearningEngine });
 * ============================================================
 */

'use strict';

function round(n, d = 3) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// Static regime -> profile map. Keys match RegimeEngine's `structure` +
// `volatility` fields (regime.trend is folded in separately below).
const PROFILE_MAP = {
  DIRECTIONAL: {
    profile: 'TREND_CONTINUATION',
    baseMultiplier: 1.08,
    emphasize: ['mtf', 'momentum'],
    note: 'Efficient directional movement — trend-following and MTF-alignment setups get the benefit of the doubt.',
  },
  RANGE: {
    profile: 'MEAN_REVERSION',
    baseMultiplier: 0.97,
    emphasize: ['smc', 'volumeOI'],
    note: 'Range-bound structure — liquidity-sweep and mean-reversion setups fit better than fresh breakouts.',
  },
  CHOP: {
    profile: 'DEFENSIVE_SELECTIVE',
    baseMultiplier: 0.8,
    emphasize: [],
    note: 'Choppy structure — no strategy is statistically favored here; conviction should be discounted across the board.',
  },
};

const VOLATILITY_ADJUST = {
  NORMAL: 1.0,
  EXPANSION: 0.93, // wider, less reliable stops
  COMPRESSION: 0.95, // pre-breakout, direction not yet resolved
};

class StrategySelector {
  constructor(config = {}) {
    // Minimum recorded outcomes in a regime bucket before its historical
    // win rate is allowed to influence the multiplier.
    this.minRegimeSamples = config.minRegimeSamples ?? 15;
    this.maxHistoricalAdjust = config.maxHistoricalAdjust ?? 0.12; // +/- cap
  }

  /**
   * @param {Object} params
   * @param {Object} params.regime           - output of RegimeEngine.classify()
   * @param {string} [params.signalAction]   - 'LONG' | 'SHORT' (for trend-alignment check)
   * @param {Object} [params.adaptiveLearningEngine] - optional, must expose
   *                  getStats() returning { regimeWinRates: { [regime]: { wins, total } } }
   *                  or similar; missing/absent is handled gracefully.
   * @returns {Object}
   */
  select({ regime, signalAction, adaptiveLearningEngine } = {}) {
    if (!regime || regime.regime === 'UNKNOWN') {
      return {
        profile: 'INSUFFICIENT_DATA',
        confidenceMultiplier: 1,
        minScoreFloor: null,
        emphasize: [],
        note: 'Regime not yet classifiable — no strategy preference applied.',
      };
    }

    const structureProfile = PROFILE_MAP[regime.structure] || PROFILE_MAP.CHOP;
    const volAdjust = VOLATILITY_ADJUST[regime.volatility] ?? 1.0;

    let multiplier = structureProfile.baseMultiplier * volAdjust;

    // Trend-alignment bonus/penalty: does the signal's direction match
    // the regime's trend bias, when the regime actually has one?
    if (regime.trend === 'BULL_TREND' && signalAction === 'SHORT') {
      multiplier *= 0.9;
    } else if (regime.trend === 'BEAR_TREND' && signalAction === 'LONG') {
      multiplier *= 0.9;
    } else if (regime.trend !== 'BALANCED' &&
               ((regime.trend === 'BULL_TREND' && signalAction === 'LONG') ||
                (regime.trend === 'BEAR_TREND' && signalAction === 'SHORT'))) {
      multiplier *= 1.05;
    }

    // Tradeability score from RegimeEngine folds in persistence/regime-change
    // warnings already — use it as one more soft tilt rather than duplicating
    // that logic here.
    if (Number.isFinite(regime.tradeability)) {
      multiplier *= 0.85 + (regime.tradeability / 100) * 0.3; // maps 0-100 -> ~0.85-1.15
    }

    // Regime-appropriate min-score floor: choppier/less tradeable regimes
    // should require a higher bar to fire, not the same bar as a clean trend.
    let minScoreFloor = null;
    if (regime.structure === 'CHOP') minScoreFloor = 82;
    else if (regime.volatility === 'EXPANSION') minScoreFloor = 80;
    else if (regime.structure === 'RANGE') minScoreFloor = 78;

    // Historical evidence nudge (optional, outcome-driven, not unsupervised —
    // this only fires off real recorded win/loss data for this regime).
    let historicalNote = null;
    if (adaptiveLearningEngine && typeof adaptiveLearningEngine.getStats === 'function') {
      try {
        const stats = adaptiveLearningEngine.getStats();
        const regimeStats = stats?.regimeWinRates?.[regime.regime];
        if (regimeStats && regimeStats.total >= this.minRegimeSamples) {
          const winRate = regimeStats.wins / regimeStats.total;
          const edge = clamp((winRate - 0.5) * 2, -1, 1) * this.maxHistoricalAdjust;
          multiplier *= (1 + edge);
          historicalNote = `Historical win rate in this regime: ${round(winRate * 100, 1)}% over ${regimeStats.total} trades — applied ${edge >= 0 ? '+' : ''}${round(edge * 100, 1)}% adjustment.`;
        }
      } catch (_) { /* adaptive learning engine shape mismatch — ignore, stay rule-based */ }
    }

    return {
      profile: structureProfile.profile,
      confidenceMultiplier: round(clamp(multiplier, 0.5, 1.3), 3),
      minScoreFloor,
      emphasize: structureProfile.emphasize,
      note: historicalNote || structureProfile.note,
      regimeSnapshot: { regime: regime.regime, trend: regime.trend, structure: regime.structure, volatility: regime.volatility, tradeability: regime.tradeability },
    };
  }
}

module.exports = { StrategySelector };
