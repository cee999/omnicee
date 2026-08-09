
'use strict';

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

class TrapDetector {
  constructor(config = {}) {
    this.swingWing = config.swingWing || 4;
    this.confirmWindow = config.confirmWindow || 3;
    this.minRejectionWickRatio = config.minRejectionWickRatio || 0.55;
    this.minPenetrationATR = config.minPenetrationATR ?? 0.3;
    this.maxLevelsPerSide = config.maxLevelsPerSide || 6;
    this.levelMergeATR = config.levelMergeATR ?? 0.4;
    this.maxHistory = config.maxHistory || 50;
    this._history = [];
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

  _refineLevels(rawLevels, atr) {
    const kept = [];
    for (let i = rawLevels.length - 1; i >= 0 && kept.length < this.maxLevelsPerSide; i--) {
      const price = rawLevels[i];
      const tooClose = kept.some(k => Math.abs(k - price) <= this.levelMergeATR * (atr || 0.0001));
      if (!tooClose) kept.push(price);
    }
    return kept;
  }

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

  analyze({ candles, smcAnalysis } = {}) {
    if (!Array.isArray(candles) || candles.length < this.swingWing * 2 + 10) {
      return { traps: [], activeTrap: null, trapRisk: 0, reason: 'insufficient_candles' };
    }

    const atr = this._atr(candles) || avg(candles.slice(-20).map(range)) || 0.0001;
    const levels = this._keyLevels(candles, smcAnalysis, atr);
    const traps = [];

    // must NOT also reserve confirmWindow candles of room, or a trap that just confirmed on the latest bar would never be scanned (that was the bug: a trap completing on/near the most recent candle — the...
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

    const deduped = Object.values(
      traps.reduce((acc, t) => {
        const key = `${t.type}_${t.breakIndex}_${round(t.level, 3)}`;
        if (!acc[key] || acc[key].strength < t.strength) acc[key] = t;
        return acc;
      }, {})
    ).sort((a, b) => a.breakIndex - b.breakIndex);

    this._history.push(...deduped);
    if (this._history.length > this.maxHistory) {
      this._history.splice(0, this._history.length - this.maxHistory);
    }

    const recentIndex = candles.length - 1;
    const activeTrap = deduped.find(t =>
      t.confirmedIndex !== null && t.confirmedIndex >= recentIndex - this.confirmWindow
    ) || null;

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
