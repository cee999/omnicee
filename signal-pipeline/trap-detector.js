/**
 * ============================================================
 *  TRAP DETECTOR — Bull Trap / Bear Trap Recognition Engine
 *  AI Trading Assistant · Layer 5 · Signal Pipeline
 * ============================================================
 *
 *  Detects breakout failures where price pierces a key level,
 *  triggers breakout entries / stop clusters on the wrong side,
 *  then reverses sharply — a classic institutional trap.
 *
 *  Two trap families:
 *    - BULL TRAP:  price breaks ABOVE resistance/high, fails to
 *                  hold, closes back below → longs get trapped
 *    - BEAR TRAP:  price breaks BELOW support/low, fails to
 *                  hold, closes back above → shorts get trapped
 *
 *  Detection is structure-aware: it re-uses swing highs/lows
 *  (or SMC liquidity levels if supplied) rather than arbitrary
 *  lookback highs, so it plugs directly into the existing
 *  SMC / liquidity-sweep vocabulary already used elsewhere in
 *  the pipeline.
 *
 *  Input:  candles (OHLCV), optional smcAnalysis (for known
 *          liquidity levels / equal highs-lows / order blocks)
 *  Output: { traps: [...], activeTrap, trapRisk }
 *
 *  Usage:
 *    const { TrapDetector } = require('./trap-detector');
 *    const detector = new TrapDetector();
 *    const result = detector.analyze({ candles, smcAnalysis });
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────

function round(n, d = 5) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const valid = arr.filter(Number.isFinite);
  return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : 0;
}

function bodySize(c) { return Math.abs(c.close - c.open); }
function range(c) { return c.high - c.low; }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }

/**
 * Finds simple fractal swing highs/lows over a lookback window.
 * A swing high at index i requires candles[i].high to be the max
 * within +/- `wing` candles (and similarly for swing low).
 */
function findSwings(candles, wing = 3) {
  const highs = [];
  const lows = [];
  for (let i = wing; i < candles.length - wing; i++) {
    const windowSlice = candles.slice(i - wing, i + wing + 1);
    const hi = Math.max(...windowSlice.map(c => c.high));
    const lo = Math.min(...windowSlice.map(c => c.low));
    if (candles[i].high === hi) highs.push({ index: i, price: candles[i].high });
    if (candles[i].low === lo) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

// ─────────────────────────────────────────────
//  TRAP DETECTOR
// ─────────────────────────────────────────────

class TrapDetector {
  constructor(config = {}) {
    this.swingWing = config.swingWing || 4;
    // How many candles after the break we allow for the reversal
    // to confirm before we stop calling it a trap.
    this.confirmWindow = config.confirmWindow || 3;
    // Minimum wick-to-body ratio on the breakout candle that hints
    // at rejection rather than a clean impulsive break.
    this.minRejectionWickRatio = config.minRejectionWickRatio || 0.55;
    // Minimum ATR-relative penetration required to count as a
    // genuine "break" (filters out noise around the level).
    this.minPenetrationATR = config.minPenetrationATR ?? 0.3;
    // How many of the most recent swing levels per side to test against —
    // keeps the scan focused on levels a trader would actually be watching,
    // rather than every minor swing in the lookback.
    this.maxLevelsPerSide = config.maxLevelsPerSide || 6;
    // Levels closer together than this (in ATR) are treated as one level
    // (keep the more recent one) — avoids double-counting the same trap
    // against near-duplicate swing points.
    this.levelMergeATR = config.levelMergeATR ?? 0.4;
    this.maxHistory = config.maxHistory || 50;
    this._history = []; // rolling record of past detected traps for stats
  }

  _atr(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    const trs = [];
    for (let i = candles.length - period; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close),
      ));
    }
    return avg(trs);
  }

  /** Merge/prune a raw level list down to the most relevant recent levels. */
  _refineLevels(rawLevels, atr) {
    // Sort by recency (later entries = more recent swings), then merge
    // anything within levelMergeATR of an already-kept level.
    const kept = [];
    for (let i = rawLevels.length - 1; i >= 0 && kept.length < this.maxLevelsPerSide; i--) {
      const price = rawLevels[i];
      const tooClose = kept.some(k => Math.abs(k - price) <= this.levelMergeATR * (atr || 0.0001));
      if (!tooClose) kept.push(price);
    }
    return kept;
  }

  /**
   * Pull candidate key levels: swing points plus, if supplied,
   * SMC liquidity levels (equal highs/lows, order block edges).
   */
  _keyLevels(candles, smcAnalysis, atr) {
    const { highs, lows } = findSwings(candles, this.swingWing);
    let resistances = highs.map(h => h.price);
    let supports = lows.map(l => l.price);

    if (smcAnalysis) {
      const eqh = smcAnalysis.liquidity?.equalHighs || smcAnalysis.equalHighs || [];
      const eql = smcAnalysis.liquidity?.equalLows || smcAnalysis.equalLows || [];
      resistances.push(...eqh.map(l => l.price ?? l));
      supports.push(...eql.map(l => l.price ?? l));
    }

    return {
      resistances: this._refineLevels(resistances, atr),
      supports: this._refineLevels(supports, atr),
    };
  }

  /**
   * Core analysis entry point.
   * @param {Object} params
   * @param {Array}  params.candles      OHLCV array, most recent last
   * @param {Object} [params.smcAnalysis] optional SMC agent output
   * @returns {Object}
   */
  analyze({ candles, smcAnalysis } = {}) {
    if (!Array.isArray(candles) || candles.length < this.swingWing * 2 + 10) {
      return { traps: [], activeTrap: null, trapRisk: 0, reason: 'insufficient_candles' };
    }

    const atr = this._atr(candles) || avg(candles.slice(-20).map(range)) || 0.0001;
    const levels = this._keyLevels(candles, smcAnalysis, atr);
    const traps = [];

    // Scan every break candle up through the second-to-last candle (the
    // last candle always needs at least itself available to check for a
    // same-bar or next-bar reversion). Confirmation itself is bounded by
    // candles.length inside the inner loop, so this only needs to ensure
    // there's a break candle at all — it must NOT also reserve confirmWindow
    // candles of room, or a trap that just confirmed on the latest bar would
    // never be scanned (that was the bug: a trap completing on/near the most
    // recent candle — the only one that matters for a live "activeTrap" —
    // was silently excluded from the scan range).
    const lastCheckable = candles.length - 2;

    for (const level of levels.resistances) {
      for (let i = 5; i <= lastCheckable; i++) {
        const c = candles[i];
        const priorCloses = candles.slice(Math.max(0, i - 5), i).map(x => x.close);
        const wasBelow = avg(priorCloses) < level;
        const penetrated = c.high > level && (c.high - level) >= this.minPenetrationATR * atr;
        if (!wasBelow || !penetrated) continue;

        const rejectionWick = upperWick(c) / (range(c) || atr);
        const closedBack = c.close < level;

        // Require a decisive close back below the level, AND at least some
        // rejection wick evidence on the way — a bare "closed back below"
        // with no wick at all is just as consistent with an orderly pullback
        // as with a genuine trap, so we don't fire on that alone.
        let confirmedIndex = null;
        for (let j = i; j <= i + this.confirmWindow && j < candles.length; j++) {
          if (candles[j].close < level - 0.15 * atr) { confirmedIndex = j; break; }
        }
        const qualifies = confirmedIndex !== null &&
          (rejectionWick >= this.minRejectionWickRatio || (closedBack && rejectionWick >= 0.3));
        if (!qualifies) continue;

        const trapStrength = round(Math.min(1, (
          0.4 * Math.min(1, rejectionWick) +
          0.3 * Math.min(1, (c.high - candles[confirmedIndex].close) / (atr * 2)) +
          0.3 * (closedBack ? 1 : 0.5)
        )), 2);

        traps.push({
          type: 'BULL_TRAP',
          level: round(level),
          breakIndex: i,
          breakTime: c.time || c.timestamp || null,
          confirmedIndex,
          rejectionWickRatio: round(rejectionWick, 2),
          strength: trapStrength,
          note: 'Price broke above resistance/liquidity, failed to hold, and closed back below — longs triggered on the break are trapped.',
        });
      }
    }

    for (const level of levels.supports) {
      for (let i = 5; i <= lastCheckable; i++) {
        const c = candles[i];
        const priorCloses = candles.slice(Math.max(0, i - 5), i).map(x => x.close);
        const wasAbove = avg(priorCloses) > level;
        const penetrated = c.low < level && (level - c.low) >= this.minPenetrationATR * atr;
        if (!wasAbove || !penetrated) continue;

        const rejectionWick = lowerWick(c) / (range(c) || atr);
        const closedBack = c.close > level;

        let confirmedIndex = null;
        for (let j = i; j <= i + this.confirmWindow && j < candles.length; j++) {
          if (candles[j].close > level + 0.15 * atr) { confirmedIndex = j; break; }
        }
        const qualifies = confirmedIndex !== null &&
          (rejectionWick >= this.minRejectionWickRatio || (closedBack && rejectionWick >= 0.3));
        if (!qualifies) continue;

        const trapStrength = round(Math.min(1, (
          0.4 * Math.min(1, rejectionWick) +
          0.3 * Math.min(1, (candles[confirmedIndex].close - c.low) / (atr * 2)) +
          0.3 * (closedBack ? 1 : 0.5)
        )), 2);

        traps.push({
          type: 'BEAR_TRAP',
          level: round(level),
          breakIndex: i,
          breakTime: c.time || c.timestamp || null,
          confirmedIndex,
          rejectionWickRatio: round(rejectionWick, 2),
          strength: trapStrength,
          note: 'Price broke below support/liquidity, failed to hold, and closed back above — shorts triggered on the break are trapped.',
        });
      }
    }

    // De-dupe overlapping detections on the same level/break index, keep strongest
    const deduped = Object.values(
      traps.reduce((acc, t) => {
        const key = `${t.type}_${t.breakIndex}_${round(t.level, 3)}`;
        if (!acc[key] || acc[key].strength < t.strength) acc[key] = t;
        return acc;
      }, {})
    ).sort((a, b) => a.breakIndex - b.breakIndex);

    // Track history for stats (bounded)
    this._history.push(...deduped);
    if (this._history.length > this.maxHistory) {
      this._history.splice(0, this._history.length - this.maxHistory);
    }

    // Is there a trap active right at (or one candle after) the most
    // recent bar? This is the actionable, "trade the trap reversal now" case.
    const recentIndex = candles.length - 1;
    const activeTrap = deduped.find(t =>
      t.confirmedIndex !== null && t.confirmedIndex >= recentIndex - this.confirmWindow
    ) || null;

    // Overall "trap risk" gauge: how trap-prone recent price action has
    // been. Useful as a dampener on breakout-style signals from other
    // agents (e.g., pattern-agent / momentum-agent breakout calls).
    const recentTraps = deduped.filter(t => t.breakIndex >= candles.length - 20);
    const trapRisk = round(Math.min(1, recentTraps.reduce((s, t) => s + t.strength, 0) / 2), 2);

    return {
      traps: deduped,
      activeTrap,
      trapRisk,
      atr: round(atr),
      levelsScanned: { resistances: levels.resistances.length, supports: levels.supports.length },
    };
  }

  /**
   * Convenience: should a pending breakout signal from another agent
   * be down-weighted because trap risk is elevated at this level?
   */
  shouldDampenBreakout({ candles, smcAnalysis, direction, threshold = 0.5 }) {
    const { trapRisk, activeTrap } = this.analyze({ candles, smcAnalysis });
    if (activeTrap) {
      const opposesLong = direction === 'LONG' && activeTrap.type === 'BULL_TRAP';
      const opposesShort = direction === 'SHORT' && activeTrap.type === 'BEAR_TRAP';
      if (opposesLong || opposesShort) return { dampen: true, factor: 1 - activeTrap.strength, reason: activeTrap.note };
    }
    if (trapRisk >= threshold) {
      return { dampen: true, factor: 1 - trapRisk, reason: 'Elevated recent trap frequency at this level cluster.' };
    }
    return { dampen: false, factor: 1, reason: null };
  }

  stats() {
    const bull = this._history.filter(t => t.type === 'BULL_TRAP').length;
    const bear = this._history.filter(t => t.type === 'BEAR_TRAP').length;
    return {
      totalDetected: this._history.length,
      bullTraps: bull,
      bearTraps: bear,
      avgStrength: round(avg(this._history.map(t => t.strength)), 2),
    };
  }
}

module.exports = { TrapDetector };
