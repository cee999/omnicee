'use strict';

/**
 * ============================================================
 *  REGIME ENGINE — Enhanced with HMM-Style Transition Model
 *  Institutional-Grade Market Regime Classification
 * ============================================================
 *
 *  Upgrades:
 *    - Hidden Markov Model-inspired regime transition tracking
 *    - Transition probability matrix (what regime comes next?)
 *    - Regime persistence scoring (how long will it last?)
 *    - Multi-scale regime detection (short + medium + long)
 *    - Regime change early warning system
 *    - Historical regime performance tracking
 * ============================================================
 */

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1));
}

/**
 * Tracks regime transitions and builds a transition probability matrix.
 */
class RegimeTransitionModel {
  constructor() {
    this._transitions = {}; // from -> { to -> count }
    this._durations = {};   // regime -> [duration1, duration2, ...]
    this._currentRegime = null;
    this._currentStart = null;
    this._totalTransitions = 0;
    // FIX: _stayCounts tracks how often a regime persists from one classify()
    // call to the next. _transitions only ever records a change AWAY from a
    // regime (record() only touches it when regime !== this._currentRegime),
    // so probs[regime] in transitionProbabilities() could never be populated —
    // persistenceProbability() was structurally guaranteed to always return
    // its 0.5 fallback, silently disabling the "low regime persistence"
    // tradeability penalty in classify(). Verified: rapid regime flapping that
    // should show near-zero persistence still returned exactly 0.5.
    this._stayCounts = {};
  }

  record(regime) {
    if (this._currentRegime && regime !== this._currentRegime) {
      // Transition occurred
      const from = this._currentRegime;
      if (!this._transitions[from]) this._transitions[from] = {};
      this._transitions[from][regime] = (this._transitions[from][regime] || 0) + 1;
      this._totalTransitions++;

      // Record duration
      if (this._currentStart) {
        const duration = Date.now() - this._currentStart;
        if (!this._durations[from]) this._durations[from] = [];
        this._durations[from].push(duration);
        if (this._durations[from].length > 100) {
          this._durations[from] = this._durations[from].slice(-100);
        }
      }
    } else if (this._currentRegime && regime === this._currentRegime) {
      this._stayCounts[regime] = (this._stayCounts[regime] || 0) + 1;
    }

    if (regime !== this._currentRegime) {
      this._currentRegime = regime;
      this._currentStart = Date.now();
    }
  }

  // Get transition probabilities from current regime
  transitionProbabilities(fromRegime) {
    const transitions = this._transitions[fromRegime];
    if (!transitions) return {};

    const total = Object.values(transitions).reduce((s, v) => s + v, 0);
    if (total === 0) return {};
    const probs = {};
    for (const [to, count] of Object.entries(transitions)) {
      probs[to] = round(count / total, 4);
    }
    return probs;
  }

  // Expected duration of current regime
  expectedDuration(regime) {
    const durations = this._durations[regime];
    if (!durations || durations.length < 3) return null;
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      mean: round(avg(durations) / (60 * 60 * 1000), 2),      // hours
      median: round(sorted[Math.floor(sorted.length / 2)] / (60 * 60 * 1000), 2),
      samples: durations.length,
    };
  }

  // How long has the current regime been active?
  currentDuration() {
    if (!this._currentStart) return 0;
    return Date.now() - this._currentStart;
  }

  // Persistence probability (how likely to stay in current regime next period)
  // FIX: was `transitionProbabilities(regime)[regime] || 0.5`, which could
  // never be anything but 0.5 (see constructor note). Now computed from
  // actual stay-vs-leave counts for this regime.
  persistenceProbability(regime) {
    const stays = this._stayCounts[regime] || 0;
    const transitionsAway = Object.values(this._transitions[regime] || {}).reduce((s, v) => s + v, 0);
    const total = stays + transitionsAway;
    return total > 0 ? round(stays / total, 4) : 0.5;
  }
}

class RegimeEngine {
  constructor(config = {}) {
    this.lookback = config.lookback || 120;
    this._transitionModel = new RegimeTransitionModel();
    this._regimeHistory = [];
    this._maxHistory = 200;
  }

  classify(candles = []) {
    if (!Array.isArray(candles) || candles.length < 40) {
      return {
        regime: 'UNKNOWN',
        trend: 'UNKNOWN',
        volatility: 'UNKNOWN',
        tradeability: 45,
        confidence: 30,
        reasons: ['Insufficient candles for regime model'],
      };
    }

    const sample = candles.slice(-this.lookback);
    const closes = sample.map(c => Number(c.close));
    const highs = sample.map(c => Number(c.high));
    const lows = sample.map(c => Number(c.low));
    const volumes = sample.map(c => Number(c.volume || 0));
    const current = closes[closes.length - 1];

    const ema21 = this._ema(closes, 21);
    const ema55 = this._ema(closes, 55);
    const atr = this._atr(sample, 14);
    const atrPct = current ? atr / current : 0;
    const recentAtr = sample.slice(-20).map((_, i, arr) => this._trueRange(arr, i)).filter(Boolean);
    const atrExpansion = avg(recentAtr.slice(-5)) / (avg(recentAtr.slice(0, 10)) || atr || 1);
    const rangeHigh = Math.max(...highs.slice(-40));
    const rangeLow = Math.min(...lows.slice(-40));
    const rangePct = current ? (rangeHigh - rangeLow) / current : 0;
    const directionalEfficiency = this._directionalEfficiency(closes.slice(-30));
    const volumeNow = avg(volumes.slice(-5));
    const volumeBase = avg(volumes.slice(-40, -5));
    const liquidity = volumeBase ? volumeNow / volumeBase : 1;

    const trendBias = ema21 > ema55 && current > ema21 ? 'BULL_TREND'
      : ema21 < ema55 && current < ema21 ? 'BEAR_TREND'
      : 'BALANCED';
    const volatility = atrPct > 0.025 || atrExpansion > 1.6 ? 'EXPANSION'
      : atrPct < 0.004 && atrExpansion < 0.85 ? 'COMPRESSION'
      : 'NORMAL';
    const structure = directionalEfficiency > 0.55 ? 'DIRECTIONAL'
      : rangePct < atrPct * 9 ? 'RANGE'
      : 'CHOP';

    let tradeability = 55;
    const reasons = [];

    if (trendBias !== 'BALANCED' && structure === 'DIRECTIONAL') {
      tradeability += 20;
      reasons.push(`${trendBias} with efficient directional movement`);
    }
    if (volatility === 'NORMAL') {
      tradeability += 10;
      reasons.push('Volatility is normal enough for planned stops');
    } else if (volatility === 'EXPANSION') {
      tradeability -= 12;
      reasons.push('Volatility expansion requires reduced size and wider patience');
    } else {
      tradeability -= 6;
      reasons.push('Volatility compression can create false breaks');
    }
    if (liquidity >= 0.85) {
      tradeability += 7;
      reasons.push('Recent liquidity is healthy versus baseline');
    } else {
      tradeability -= 10;
      reasons.push('Recent liquidity is thin versus baseline');
    }
    if (structure === 'CHOP') {
      tradeability -= 18;
      reasons.push('Choppy structure reduces signal reliability');
    }

    const regime = trendBias !== 'BALANCED' && structure === 'DIRECTIONAL'
      ? trendBias
      : `${structure}_${volatility}`;

    // Update transition model
    this._transitionModel.record(regime);
    this._regimeHistory.push({ regime, timestamp: Date.now() });
    if (this._regimeHistory.length > this._maxHistory) {
      this._regimeHistory = this._regimeHistory.slice(-this._maxHistory);
    }

    // Multi-scale regime analysis
    const shortTermRegime = this._multiScaleRegime(closes.slice(-15), sample.slice(-15));
    const mediumTermRegime = this._multiScaleRegime(closes.slice(-50), sample.slice(-50));

    // Regime change early warning
    const earlyWarning = this._regimeChangeWarning(closes, regime);

    // Transition data
    const transitionProbs = this._transitionModel.transitionProbabilities(regime);
    const persistence = this._transitionModel.persistenceProbability(regime);
    const expectedDuration = this._transitionModel.expectedDuration(regime);
    const currentDurationMs = this._transitionModel.currentDuration();

    // Adjust tradeability based on regime instability
    if (earlyWarning.warning) {
      tradeability -= 8;
      reasons.push(`Regime change warning: ${earlyWarning.note}`);
    }
    if (persistence < 0.3 && this._transitionModel._totalTransitions > 5) {
      tradeability -= 5;
      reasons.push(`Low regime persistence (${round(persistence * 100, 1)}%) — frequent transitions`);
    }

    return {
      regime,
      trend: trendBias,
      structure,
      volatility,
      tradeability: round(clamp(tradeability, 0, 100), 2),
      confidence: round(clamp(45 + directionalEfficiency * 45 + Math.min(liquidity, 1.5) * 8, 0, 100), 2),
      metrics: {
        ema21: round(ema21, 5),
        ema55: round(ema55, 5),
        atr: round(atr, 5),
        atrPct: round(atrPct * 100, 4),
        atrExpansion: round(atrExpansion, 3),
        rangePct: round(rangePct * 100, 4),
        directionalEfficiency: round(directionalEfficiency, 3),
        liquidityRatio: round(liquidity, 3),
      },
      // New HMM-style fields
      transition: {
        probabilities: transitionProbs,
        persistence: round(persistence, 4),
        currentDurationHours: round(currentDurationMs / (60 * 60 * 1000), 2),
        expectedDuration,
      },
      multiScale: {
        short: shortTermRegime,
        medium: mediumTermRegime,
        aligned: shortTermRegime === mediumTermRegime && mediumTermRegime === regime,
      },
      earlyWarning,
      reasons,
    };
  }

  _multiScaleRegime(closes, candles) {
    if (closes.length < 10) return 'UNKNOWN';
    const de = this._directionalEfficiency(closes);
    const vol = stddev(closes.map((c, i) => i > 0 ? Math.log(c / closes[i - 1]) : 0).slice(1));
    if (de > 0.55) return 'DIRECTIONAL';
    if (vol > 0.02) return 'VOLATILE';
    if (vol < 0.003) return 'COMPRESSED';
    return 'RANGE';
  }

  _regimeChangeWarning(closes, currentRegime) {
    if (closes.length < 30) return { warning: false, note: 'Insufficient data' };

    // Check if directional efficiency is rapidly changing
    const deRecent = this._directionalEfficiency(closes.slice(-10));
    const dePrev = this._directionalEfficiency(closes.slice(-25, -10));
    const deChange = Math.abs(deRecent - dePrev);

    // Check for volatility shift
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
      }
    }
    const volRecent = stddev(returns.slice(-10));
    const volPrev = stddev(returns.slice(-30, -10));
    const volRatio = volPrev > 0 ? volRecent / volPrev : 1;

    const warning = deChange > 0.25 || volRatio > 2.0 || volRatio < 0.4;

    return {
      warning,
      deChange: round(deChange, 3),
      volRatio: round(volRatio, 3),
      note: warning
        ? `Structure shift (DE Δ=${round(deChange, 2)}, vol ratio=${round(volRatio, 2)}) — regime may be changing`
        : 'Regime stable',
    };
  }

  _ema(values, period) {
    if (!values.length) return 0;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).length === period ? avg(values.slice(0, period)) : values[0];
    for (const v of values.slice(period)) ema = v * k + ema * (1 - k);
    return ema;
  }

  _atr(candles, period) {
    const trs = [];
    for (let i = 1; i < candles.length; i++) trs.push(this._trueRange(candles, i));
    const recent = trs.slice(-period);
    return avg(recent);
  }

  _trueRange(candles, i) {
    if (i <= 0 || !candles[i] || !candles[i - 1]) return 0;
    const c = candles[i];
    const p = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }

  _directionalEfficiency(closes) {
    if (closes.length < 3) return 0;
    const net = Math.abs(closes[closes.length - 1] - closes[0]);
    let path = 0;
    for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
    return path ? clamp(net / path, 0, 1) : 0;
  }

  getTransitionModel() {
    return this._transitionModel;
  }
}

module.exports = { RegimeEngine };
