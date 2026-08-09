
'use strict';

function round(n, d = 3) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

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
  EXPANSION: 0.93,
  COMPRESSION: 0.95,
};

class StrategySelector {
  constructor(config = {}) {
    this.minRegimeSamples = config.minRegimeSamples ?? 15;
    this.maxHistoricalAdjust = config.maxHistoricalAdjust ?? 0.12;
  }

  // must expose getStats() returning { regimeWinRates: { [regime]: { wins, total } } } or similar; missing/absent is handled gracefully. @returns {Object}
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

    if (regime.trend === 'BULL_TREND' && signalAction === 'SHORT') {
      multiplier *= 0.9;
    } else if (regime.trend === 'BEAR_TREND' && signalAction === 'LONG') {
      multiplier *= 0.9;
    } else if (regime.trend !== 'BALANCED' &&
               ((regime.trend === 'BULL_TREND' && signalAction === 'LONG') ||
                (regime.trend === 'BEAR_TREND' && signalAction === 'SHORT'))) {
      multiplier *= 1.05;
    }

    if (Number.isFinite(regime.tradeability)) {
      multiplier *= 0.85 + (regime.tradeability / 100) * 0.3;
    }

    let minScoreFloor = null;
    if (regime.structure === 'CHOP') minScoreFloor = 82;
    else if (regime.volatility === 'EXPANSION') minScoreFloor = 80;
    else if (regime.structure === 'RANGE') minScoreFloor = 78;

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
      } catch (_) { }
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
