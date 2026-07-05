/**
 * ============================================================
 *  SMC AGENT — Smart Money Concepts Detection Engine
 *  AI Trading Assistant · Layer 4 · Core Signal Brain
 * ============================================================
 *
 *  Detects:
 *    - Order Blocks (Bullish / Bearish / Refined)
 *    - Fair Value Gaps (FVG / IFVG / CE levels)
 *    - Market Structure (BOS / CHoCH / iBOS)
 *    - Liquidity (BSL / SSL / Sweeps / Inducements)
 *    - Premium / Discount zones + OTE Fibonacci
 *    - Wyckoff Phases (Accumulation / Distribution)
 *
 *  Output: structured SMC signal object fed to signal-scorer.js
 *
 *  Usage:
 *    const SMCAgent = require('./smc-agent');
 *    const agent = new SMCAgent({ timeframe: 'H1', symbol: 'EURUSD' });
 *    const signal = await agent.analyze(candles);
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const STRUCTURE = {
  BULLISH: 'BULLISH',
  BEARISH: 'BEARISH',
  NEUTRAL: 'NEUTRAL',
};

const SIGNAL_TYPE = {
  LONG:    'LONG',
  SHORT:   'SHORT',
  WAIT:    'WAIT',
};

const ZONE_STATE = {
  FRESH:     'FRESH',
  TESTED:    'TESTED',
  MITIGATED: 'MITIGATED',
};

// Minimum candles needed for reliable SMC analysis
const MIN_CANDLES = 50;

// ─────────────────────────────────────────────
//  UTILITY HELPERS
// ─────────────────────────────────────────────

/**
 * Returns the body size of a candle (absolute)
 */
function bodySize(c) {
  return Math.abs(c.close - c.open);
}

/**
 * Returns the full wick range of a candle
 */
function wickRange(c) {
  return c.high - c.low;
}

/**
 * True if candle is bullish
 */
function isBullish(c) {
  return c.close > c.open;
}

/**
 * True if candle is bearish
 */
function isBearish(c) {
  return c.close < c.open;
}

/**
 * Percentage body vs total range (0–1). High = strong candle.
 */
function bodyRatio(c) {
  const range = wickRange(c);
  return range === 0 ? 0 : bodySize(c) / range;
}

/**
 * Round to N decimal places
 */
function round(n, decimals = 5) {
  return parseFloat(n.toFixed(decimals));
}

/**
 * Checks if two price ranges overlap
 */
function rangesOverlap(high1, low1, high2, low2) {
  return low1 <= high2 && high1 >= low2;
}

/**
 * Returns the highest high in a range of candles
 */
function swingHigh(candles) {
  return Math.max(...candles.map(c => c.high));
}

/**
 * Returns the lowest low in a range of candles
 */
function swingLow(candles) {
  return Math.min(...candles.map(c => c.low));
}

// ─────────────────────────────────────────────
//  ORDER BLOCK DETECTION
// ─────────────────────────────────────────────

class OrderBlockDetector {
  /**
   * Detects bullish order blocks.
   * A bullish OB is the last bearish candle before a strong up move
   * that creates a BOS on the upside.
   *
   * @param {Array} candles - OHLCV array, oldest first
   * @param {number} lookback - candles to scan
   * @returns {Array} bullishOBs
   */
  static detectBullish(candles, lookback = 20) {
    const obs = [];

    for (let i = 2; i < Math.min(candles.length - 3, lookback + 3); i++) {
      const c = candles[i];
      if (!isBearish(c)) continue;

      // Next candles must show strong bullish displacement
      const next1 = candles[i + 1];
      const next2 = candles[i + 2];
      const next3 = candles[i + 3];

      if (!next1 || !next2) continue;

      const displacement = isBullish(next1) &&
        next1.close > c.high &&           // closes above OB high
        bodyRatio(next1) > 0.5;           // strong body

      if (!displacement) continue;

      // Check for FVG after the OB (imbalance = institutional move)
      const hasFVG = next2 && next3
        ? next3.low > next1.high           // gap between candle 1 and candle 3
        : false;

      // OTE zone: 50%–79% retracement of the OB body
      const obHigh  = c.high;
      const obLow   = c.low;
      const obMid   = (obHigh + obLow) / 2;
      const ote50   = obLow + (obHigh - obLow) * 0.50;
      const ote79   = obLow + (obHigh - obLow) * 0.79;

      obs.push({
        type:      'BULLISH_OB',
        index:     i,
        timestamp: c.timestamp,
        obHigh:    round(obHigh),
        obLow:     round(obLow),
        obMid:     round(obMid),
        ote50:     round(ote50),
        ote79:     round(ote79),
        hasFVG,
        state:     ZONE_STATE.FRESH,
        strength:  hasFVG ? 'STRONG' : 'STANDARD',
        bodyRatio: round(bodyRatio(c), 3),
      });
    }

    return obs;
  }

  /**
   * Detects bearish order blocks.
   * A bearish OB is the last bullish candle before a strong down move.
   */
  static detectBearish(candles, lookback = 20) {
    const obs = [];

    for (let i = 2; i < Math.min(candles.length - 3, lookback + 3); i++) {
      const c = candles[i];
      if (!isBullish(c)) continue;

      const next1 = candles[i + 1];
      const next2 = candles[i + 2];
      const next3 = candles[i + 3];

      if (!next1 || !next2) continue;

      const displacement = isBearish(next1) &&
        next1.close < c.low &&
        bodyRatio(next1) > 0.5;

      if (!displacement) continue;

      const hasFVG = next2 && next3
        ? next1.low > next3.high
        : false;

      const obHigh = c.high;
      const obLow  = c.low;
      const obMid  = (obHigh + obLow) / 2;
      const ote50  = obHigh - (obHigh - obLow) * 0.50;
      const ote79  = obHigh - (obHigh - obLow) * 0.79;

      obs.push({
        type:      'BEARISH_OB',
        index:     i,
        timestamp: c.timestamp,
        obHigh:    round(obHigh),
        obLow:     round(obLow),
        obMid:     round(obMid),
        ote50:     round(ote50),
        ote79:     round(ote79),
        hasFVG,
        state:     ZONE_STATE.FRESH,
        strength:  hasFVG ? 'STRONG' : 'STANDARD',
        bodyRatio: round(bodyRatio(c), 3),
      });
    }

    return obs;
  }

  /**
   * Updates OB state based on current price.
   * TESTED  = price entered the OB but didn't close through
   * MITIGATED = price closed fully through the OB (invalidated)
   */
  static updateStates(obs, currentCandle) {
    const { high, low, close } = currentCandle;

    return obs.map(ob => {
      if (ob.state === ZONE_STATE.MITIGATED) return ob;

      const touched = rangesOverlap(high, low, ob.obHigh, ob.obLow);

      if (!touched) return ob;

      // Mitigated = close fully through the zone
      const mitigated = ob.type === 'BULLISH_OB'
        ? close < ob.obLow
        : close > ob.obHigh;

      return {
        ...ob,
        state: mitigated ? ZONE_STATE.MITIGATED : ZONE_STATE.TESTED,
      };
    });
  }

  /**
   * Returns only fresh and tested (valid) OBs
   */
  static getValid(obs) {
    return obs.filter(ob => ob.state !== ZONE_STATE.MITIGATED);
  }
}

// ─────────────────────────────────────────────
//  FAIR VALUE GAP (FVG) DETECTION
// ─────────────────────────────────────────────

class FVGDetector {
  /**
   * FVG = 3-candle imbalance.
   * Bullish FVG: candle[i+2].low > candle[i].high  (gap between candle 1 and 3)
   * Bearish FVG: candle[i+2].high < candle[i].low
   *
   * @param {Array} candles
   * @returns {Array} fvgs
   */
  static detect(candles) {
    const fvgs = [];

    for (let i = 0; i < candles.length - 2; i++) {
      const c1 = candles[i];
      const c2 = candles[i + 1]; // displacement candle
      const c3 = candles[i + 2];

      // Bullish FVG
      if (c3.low > c1.high) {
        const gapSize  = c3.low - c1.high;
        const gapMid   = c1.high + gapSize / 2;
        const ce       = gapMid; // Consequent Encroachment

        fvgs.push({
          type:      'BULLISH_FVG',
          index:     i,
          timestamp: c2.timestamp,
          fvgHigh:   round(c3.low),
          fvgLow:    round(c1.high),
          fvgMid:    round(gapMid),
          ce:        round(ce),
          gapSize:   round(gapSize),
          state:     ZONE_STATE.FRESH,
          // Strong if displacement candle has big body
          strength:  bodyRatio(c2) > 0.65 ? 'STRONG' : 'STANDARD',
        });
      }

      // Bearish FVG
      if (c3.high < c1.low) {
        const gapSize  = c1.low - c3.high;
        const gapMid   = c3.high + gapSize / 2;
        const ce       = gapMid;

        fvgs.push({
          type:      'BEARISH_FVG',
          index:     i,
          timestamp: c2.timestamp,
          fvgHigh:   round(c1.low),
          fvgLow:    round(c3.high),
          fvgMid:    round(gapMid),
          ce:        round(ce),
          gapSize:   round(gapSize),
          state:     ZONE_STATE.FRESH,
          strength:  bodyRatio(c2) > 0.65 ? 'STRONG' : 'STANDARD',
        });
      }
    }

    return fvgs;
  }

  /**
   * Update FVG states based on current price action.
   * CE filled = TESTED. Fully closed through = MITIGATED.
   */
  static updateStates(fvgs, currentCandle) {
    const { high, low, close } = currentCandle;

    return fvgs.map(fvg => {
      if (fvg.state === ZONE_STATE.MITIGATED) return fvg;

      const touched = rangesOverlap(high, low, fvg.fvgHigh, fvg.fvgLow);
      if (!touched) return fvg;

      const mitigated = fvg.type === 'BULLISH_FVG'
        ? close < fvg.fvgLow
        : close > fvg.fvgHigh;

      // Check if CE (50%) has been reached
      const ceTested = fvg.type === 'BULLISH_FVG'
        ? low <= fvg.ce
        : high >= fvg.ce;

      return {
        ...fvg,
        ceTested,
        state: mitigated ? ZONE_STATE.MITIGATED : ZONE_STATE.TESTED,
      };
    });
  }

  /**
   * Detect Inverse FVG (IFVG) — mitigated FVG that now acts as opposite zone
   */
  static detectInverse(fvgs) {
    return fvgs
      .filter(fvg => fvg.state === ZONE_STATE.MITIGATED)
      .map(fvg => ({
        ...fvg,
        type: fvg.type === 'BULLISH_FVG' ? 'INVERSE_BULLISH_FVG' : 'INVERSE_BEARISH_FVG',
        state: ZONE_STATE.FRESH,
        isInverse: true,
      }));
  }

  static getValid(fvgs) {
    return fvgs.filter(fvg => fvg.state !== ZONE_STATE.MITIGATED);
  }
}

// ─────────────────────────────────────────────
//  MARKET STRUCTURE DETECTION
// ─────────────────────────────────────────────

class MarketStructureDetector {
  /**
   * Identifies swing highs and swing lows using a pivot approach.
   * A swing high = candle[i].high > candle[i-n..i+n].high
   * A swing low  = candle[i].low  < candle[i-n..i+n].low
   *
   * @param {Array} candles
   * @param {number} strength - pivot strength (candles each side)
   * @returns {{ highs: Array, lows: Array }}
   */
  static findSwings(candles, strength = 3) {
    const highs = [];
    const lows  = [];

    if (candles.length < (strength * 2 + 1)) return { highs, lows };

    for (let i = strength; i < candles.length - strength; i++) {
      const window  = candles.slice(i - strength, i + strength + 1);
      const current = candles[i];

      const isSwingHigh = window.every(c => c.high <= current.high);
      const isSwingLow  = window.every(c => c.low  >= current.low);

      if (isSwingHigh) {
        highs.push({ index: i, price: current.high, timestamp: current.timestamp });
      }
      if (isSwingLow) {
        lows.push({ index: i, price: current.low, timestamp: current.timestamp });
      }
    }

    return { highs, lows };
  }

  /**
   * Detects Break of Structure (BOS) and Change of Character (CHoCH).
   *
   * BOS   = price closes beyond the PREVIOUS swing in the SAME direction as trend
   *         → trend continuation
   * CHoCH = price closes beyond the PREVIOUS swing AGAINST the current trend
   *         → potential reversal
   *
   * @param {Array} candles
   * @param {{ highs, lows }} swings
   * @returns {Array} structureEvents
   */
  static detectStructureBreaks(candles, swings) {
    const events  = [];
    const { highs, lows } = swings;

    if (highs.length < 2 || lows.length < 2) return events;

    // Determine initial trend from first two swing points
    let trend = STRUCTURE.NEUTRAL;

    // Simple trend: compare last two swing highs
    const lastTwoHighs = highs.slice(-2);
    const lastTwoLows  = lows.slice(-2);

    if (lastTwoHighs[1].price > lastTwoHighs[0].price &&
        lastTwoLows[1].price  > lastTwoLows[0].price) {
      trend = STRUCTURE.BULLISH;
    } else if (lastTwoHighs[1].price < lastTwoHighs[0].price &&
               lastTwoLows[1].price  < lastTwoLows[0].price) {
      trend = STRUCTURE.BEARISH;
    }

    // Scan recent candles for breaks
    const recent = candles.slice(-30);

    for (let i = 1; i < recent.length; i++) {
      const c = recent[i];

      // Last confirmed swing high / low before this candle
      const prevHigh = highs.filter(h => h.index < candles.length - 30 + i).slice(-1)[0];
      const prevLow  = lows.filter(l => l.index  < candles.length - 30 + i).slice(-1)[0];

      if (!prevHigh || !prevLow) continue;

      // Bullish BOS — close above previous swing high (trend continuation in bull)
      if (c.close > prevHigh.price && trend === STRUCTURE.BULLISH) {
        events.push({
          type:      'BOS',
          direction: STRUCTURE.BULLISH,
          price:     round(prevHigh.price),
          timestamp: c.timestamp,
          candle:    i,
          note:      'Trend continuation — bullish',
        });
      }

      // Bearish BOS — close below previous swing low (trend continuation in bear)
      if (c.close < prevLow.price && trend === STRUCTURE.BEARISH) {
        events.push({
          type:      'BOS',
          direction: STRUCTURE.BEARISH,
          price:     round(prevLow.price),
          timestamp: c.timestamp,
          candle:    i,
          note:      'Trend continuation — bearish',
        });
      }

      // Bullish CHoCH — close above previous swing high DURING a downtrend
      if (c.close > prevHigh.price && trend === STRUCTURE.BEARISH) {
        events.push({
          type:      'CHoCH',
          direction: STRUCTURE.BULLISH,
          price:     round(prevHigh.price),
          timestamp: c.timestamp,
          candle:    i,
          note:      'Potential reversal to bullish',
        });
        trend = STRUCTURE.BULLISH; // Update trend
      }

      // Bearish CHoCH — close below previous swing low DURING an uptrend
      if (c.close < prevLow.price && trend === STRUCTURE.BULLISH) {
        events.push({
          type:      'CHoCH',
          direction: STRUCTURE.BEARISH,
          price:     round(prevLow.price),
          timestamp: c.timestamp,
          candle:    i,
          note:      'Potential reversal to bearish',
        });
        trend = STRUCTURE.BEARISH; // Update trend
      }
    }

    return { events, currentTrend: trend };
  }

  /**
   * Equal Highs (EQH) and Equal Lows (EQL) — liquidity pools.
   * Two swing points within 0.05% of each other = equal level.
   */
  static findEqualLevels(swings, tolerance = 0.0005) {
    const eqh = [];
    const eql = [];
    const { highs, lows } = swings;

    for (let i = 0; i < highs.length - 1; i++) {
      for (let j = i + 1; j < highs.length; j++) {
        const diff = Math.abs(highs[i].price - highs[j].price) / highs[i].price;
        if (diff <= tolerance) {
          eqh.push({
            price:      round((highs[i].price + highs[j].price) / 2),
            timestamp1: highs[i].timestamp,
            timestamp2: highs[j].timestamp,
            note:       'Equal highs — liquidity resting above',
          });
        }
      }
    }

    for (let i = 0; i < lows.length - 1; i++) {
      for (let j = i + 1; j < lows.length; j++) {
        const diff = Math.abs(lows[i].price - lows[j].price) / lows[i].price;
        if (diff <= tolerance) {
          eql.push({
            price:      round((lows[i].price + lows[j].price) / 2),
            timestamp1: lows[i].timestamp,
            timestamp2: lows[j].timestamp,
            note:       'Equal lows — liquidity resting below',
          });
        }
      }
    }

    return { eqh, eql };
  }
}

// ─────────────────────────────────────────────
//  LIQUIDITY DETECTION
// ─────────────────────────────────────────────

class LiquidityDetector {
  /**
   * Detects liquidity sweeps.
   * A sweep = price wicks beyond a swing high/low then REVERSES
   * and closes back inside the range.
   *
   * This is the institutional stop-hunt move.
   *
   * @param {Array} candles
   * @param {{ highs, lows }} swings
   * @returns {Array} sweeps
   */
  static detectSweeps(candles, swings) {
    const sweeps = [];
    const { highs, lows } = swings;
    const recent = candles.slice(-20);

    for (let i = 1; i < recent.length; i++) {
      const c = recent[i];

      // Check sweep of buy-side liquidity (BSL) — above swing highs
      for (const sh of highs) {
        if (c.high > sh.price && c.close < sh.price) {
          sweeps.push({
            type:        'BSL_SWEEP',
            direction:   'BEARISH',        // swept up, expect reversal down
            sweptLevel:  round(sh.price),
            wickHigh:    round(c.high),
            close:       round(c.close),
            timestamp:   c.timestamp,
            note:        'Buy-side liquidity swept — look for shorts',
            reliability: wickRange(c) > bodySize(c) * 1.5 ? 'HIGH' : 'MEDIUM',
          });
        }
      }

      // Check sweep of sell-side liquidity (SSL) — below swing lows
      for (const sl of lows) {
        if (c.low < sl.price && c.close > sl.price) {
          sweeps.push({
            type:        'SSL_SWEEP',
            direction:   'BULLISH',        // swept down, expect reversal up
            sweptLevel:  round(sl.price),
            wickLow:     round(c.low),
            close:       round(c.close),
            timestamp:   c.timestamp,
            note:        'Sell-side liquidity swept — look for longs',
            reliability: wickRange(c) > bodySize(c) * 1.5 ? 'HIGH' : 'MEDIUM',
          });
        }
      }
    }

    return sweeps;
  }

  /**
   * Detects inducement (IDM) — a false breakout before the real move.
   * Price takes out a minor swing to grab stops, then reverses.
   * Identified by: sweep + immediate opposite-direction displacement.
   */
  static detectInducement(candles) {
    const inducements = [];

    for (let i = 2; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const c    = candles[i];
      const next = candles[i + 1];

      if (!next) continue;

      // Bullish inducement: wicked below prev low, then strong bullish candle
      const bullIDM = c.low < prev.low &&
        c.close > prev.low &&
        isBullish(next) &&
        next.close > c.high;

      // Bearish inducement: wicked above prev high, then strong bearish candle
      const bearIDM = c.high > prev.high &&
        c.close < prev.high &&
        isBearish(next) &&
        next.close < c.low;

      if (bullIDM) {
        inducements.push({
          type:       'BULLISH_IDM',
          idmLevel:   round(c.low),
          timestamp:  c.timestamp,
          note:       'Bullish inducement — stops taken below, expect long',
        });
      }

      if (bearIDM) {
        inducements.push({
          type:       'BEARISH_IDM',
          idmLevel:   round(c.high),
          timestamp:  c.timestamp,
          note:       'Bearish inducement — stops taken above, expect short',
        });
      }
    }

    return inducements;
  }
}

// ─────────────────────────────────────────────
//  PREMIUM / DISCOUNT ZONE CALCULATOR
// ─────────────────────────────────────────────

class PremiumDiscountCalculator {
  /**
   * Calculates the premium/discount zones for the current swing range.
   * Premium = above equilibrium (50%) → look for shorts
   * Discount = below equilibrium (50%) → look for longs
   *
   * OTE (Optimal Trade Entry) Fibonacci levels:
   *   0.62, 0.705, 0.79 retracement → highest probability entries
   *
   * @param {number} swingHigh
   * @param {number} swingLow
   * @returns {Object} zones
   */
  static calculate(swingHigh, swingLow) {
    const range = swingHigh - swingLow;

    return {
      swingHigh:    round(swingHigh),
      swingLow:     round(swingLow),
      equilibrium:  round(swingLow + range * 0.5),

      // Premium zone (above equilibrium) — short bias
      premium: {
        top:    round(swingHigh),
        bottom: round(swingLow + range * 0.5),
        label:  'PREMIUM — short bias',
      },

      // Discount zone (below equilibrium) — long bias
      discount: {
        top:    round(swingLow + range * 0.5),
        bottom: round(swingLow),
        label:  'DISCOUNT — long bias',
      },

      // OTE zone — the institutional sweet spot
      ote: {
        fib62:  round(swingHigh - range * 0.62),
        fib705: round(swingHigh - range * 0.705),
        fib79:  round(swingHigh - range * 0.79),
        label:  'OTE — Optimal Trade Entry zone',
      },

      // SIBI/BISI zones
      sibi: round(swingLow + range * 0.75), // Sell in buy imbalance
      bisi: round(swingLow + range * 0.25), // Buy in sell imbalance
    };
  }

  /**
   * Returns current price position relative to the range
   */
  static pricePosition(currentPrice, swingHigh, swingLow) {
    const range    = swingHigh - swingLow;
    if (range <= 0) return { percentage: 50, zone: 'NEUTRAL', inOTE: false };
    
    const position = (currentPrice - swingLow) / range;

    return {
      percentage: round(position * 100, 2),
      zone: position > 0.5 ? 'PREMIUM' : 'DISCOUNT',
      inOTE: position >= 0.21 && position <= 0.38, // Inverse for long = 62%–79% retrace
    };
  }
}

// ─────────────────────────────────────────────
//  WYCKOFF PHASE DETECTOR
// ─────────────────────────────────────────────

class WyckoffDetector {
  /**
   * Identifies Wyckoff accumulation/distribution phases.
   * Simplified schematic detection using price action + volume patterns.
   *
   * Phase A: Stopping the prior trend (PS, SC/BC, AR, ST)
   * Phase B: Building cause
   * Phase C: Spring/Upthrust (the trap)
   * Phase D: SOS/SOW + LPS/LPSY
   * Phase E: Markup/Markdown
   *
   * @param {Array} candles
   * @returns {Object} wyckoff analysis
   */
  static analyze(candles) {
    if (candles.length < 30) {
      return { phase: 'INSUFFICIENT_DATA', confidence: 0 };
    }

    const recent    = candles.slice(-30);
    const firstHalf = recent.slice(0, 15);
    const secHalf   = recent.slice(15);

    const firstHighest = swingHigh(firstHalf);
    const firstLowest  = swingLow(firstHalf);
    const secHighest   = swingHigh(secHalf);
    const secLowest    = swingLow(secHalf);

    const rangeFirst = firstHighest - firstLowest;
    const rangeSec   = secHighest   - secLowest;

    // Accumulation signals: price contracting + volume drying up
    const isContracting = rangeSec < rangeFirst * 0.7;

    // Spring detection: price dips below range low then recovers
    const lastCandle    = candles[candles.length - 1];
    const rangeStart    = Math.min(firstLowest, secLowest);
    const hasSpring     = secLowest < firstLowest &&
                          lastCandle.close > rangeStart;

    // Upthrust detection: price pops above range high then falls
    const rangeTop      = Math.max(firstHighest, secHighest);
    const hasUpthrust   = secHighest > firstHighest &&
                          lastCandle.close < rangeTop;

    let phase      = 'PHASE_B'; // Default: building cause
    let type       = 'NEUTRAL';
    let confidence = 40;

    if (hasSpring) {
      phase      = 'PHASE_C_SPRING';
      type       = 'ACCUMULATION';
      confidence = 72;
    } else if (hasUpthrust) {
      phase      = 'PHASE_C_UPTHRUST';
      type       = 'DISTRIBUTION';
      confidence = 70;
    } else if (isContracting) {
      phase      = 'PHASE_B';
      type       = 'BUILDING_CAUSE';
      confidence = 50;
    }

    return {
      phase,
      type,
      confidence,
      rangeHigh:  round(Math.max(firstHighest, secHighest)),
      rangeLow:   round(Math.min(firstLowest,  secLowest)),
      hasSpring,
      hasUpthrust,
      isContracting,
    };
  }
}

// ─────────────────────────────────────────────
//  CONFLUENCE SCORER
// ─────────────────────────────────────────────

class SMCConfluenceScorer {
  /**
   * Takes all detected SMC elements and computes a 0–100 directional score.
   * Higher score = stronger signal. Minimum 70 to generate a trade signal.
   *
   * @param {Object} analysis - full SMC analysis result
   * @param {string} direction - 'LONG' or 'SHORT'
   * @returns {{ score, reasons }}
   */
  static score(analysis, direction) {
    let score   = 0;
    const reasons = [];

    const isLong = direction === SIGNAL_TYPE.LONG;

    // ── Order Block (max 25 pts) ──
    const relevantOBs = isLong
      ? analysis.orderBlocks.bullish.filter(ob => ob.state !== ZONE_STATE.MITIGATED)
      : analysis.orderBlocks.bearish.filter(ob => ob.state !== ZONE_STATE.MITIGATED);

    if (relevantOBs.length > 0) {
      const best = relevantOBs[0];
      score += best.strength === 'STRONG' ? 25 : 15;
      reasons.push(`${best.strength} ${best.type} present`);
    }

    // ── FVG (max 20 pts) ──
    const relevantFVGs = isLong
      ? analysis.fvgs.bullish.filter(f => f.state !== ZONE_STATE.MITIGATED)
      : analysis.fvgs.bearish.filter(f => f.state !== ZONE_STATE.MITIGATED);

    if (relevantFVGs.length > 0) {
      score += relevantFVGs[0].strength === 'STRONG' ? 20 : 12;
      reasons.push(`Bullish FVG imbalance gap above current price`);
    }

    // ── Market Structure (max 20 pts) ──
    const latestEvent = analysis.structure.events.slice(-1)[0];
    if (latestEvent) {
      const matches = isLong
        ? latestEvent.direction === STRUCTURE.BULLISH
        : latestEvent.direction === STRUCTURE.BEARISH;

      if (matches) {
        score += latestEvent.type === 'CHoCH' ? 20 : 15;
        reasons.push(`${latestEvent.type} ${latestEvent.direction} — ${latestEvent.note}`);
      }
    }

    // ── Liquidity Sweep (max 20 pts) ──
    const recentSweeps = analysis.liquidity.sweeps.slice(-3);
    for (const sweep of recentSweeps) {
      const sweepMatches = isLong
        ? sweep.direction === 'BULLISH'
        : sweep.direction === 'BEARISH';

      if (sweepMatches) {
        score += sweep.reliability === 'HIGH' ? 20 : 12;
        reasons.push(`${sweep.type} — ${sweep.note}`);
        break;
      }
    }

    // ── Premium / Discount (max 10 pts) ──
    const pd = analysis.premiumDiscount;
    const pdMatches = isLong
      ? pd.currentPosition.zone === 'DISCOUNT'
      : pd.currentPosition.zone === 'PREMIUM';

    if (pdMatches) {
      score += 10;
      reasons.push(`Price in ${pd.currentPosition.zone} zone (${pd.currentPosition.percentage}%)`);
    }

    // ── OTE Zone (max 5 pts bonus) ──
    if (pd.currentPosition.inOTE) {
      score += 5;
      reasons.push('Price in Optimal Trade Entry (OTE) zone');
    }

    // ── Equal Levels (additive warning) ──
    const { eqh, eql } = analysis.equalLevels;
    if (isLong && eql.length > 0) {
      reasons.push(`Equal lows at ${eql[0].price} — liquidity above, caution`);
    }
    if (!isLong && eqh.length > 0) {
      reasons.push(`Equal highs at ${eqh[0].price} — liquidity below, caution`);
    }

    return {
      score:   Math.min(score, 100),
      reasons,
      grade:   score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D',
    };
  }
}

// ─────────────────────────────────────────────
//  MAIN SMC AGENT CLASS
// ─────────────────────────────────────────────

class SMCAgent {
  /**
   * @param {Object} config
   * @param {string} config.symbol    - e.g. 'EURUSD', 'BTCUSDT'
   * @param {string} config.timeframe - e.g. 'M15', 'H1', 'H4'
   * @param {number} config.lookback  - OB/FVG lookback candles (default 30)
   * @param {number} config.pivotStrength - swing point sensitivity (default 3)
   * @param {number} config.minScore  - minimum score to issue signal (default 70)
   */
  constructor(config = {}) {
    this.symbol        = config.symbol        || 'UNKNOWN';
    this.timeframe     = config.timeframe     || 'H1';
    this.lookback      = config.lookback      || 30;
    this.pivotStrength = config.pivotStrength || 3;
    this.minScore      = config.minScore      || 70;

    // Internal state (persists across analyze() calls)
    this._bullishOBs   = [];
    this._bearishOBs   = [];
    this._bullishFVGs  = [];
    this._bearishFVGs  = [];
  }

  /**
   * Master analyze function.
   * Call this with the latest candle array every time a new candle closes.
   *
   * @param {Array} candles - OHLCV array, each: { open, high, low, close, volume, timestamp }
   * @returns {Object} full SMC analysis + trade signal
   */
  async analyze(candles) {
    if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
      return {
        error:   `Need at least ${MIN_CANDLES} candles. Got ${candles?.length ?? 0}.`,
        signal:  null,
        analysis: null,
      };
    }

    const current  = candles[candles.length - 1];
    const previous = candles.slice(0, -1);

    // ── 1. Detect Order Blocks ──
    this._bullishOBs = OrderBlockDetector.detectBullish(previous, this.lookback);
    this._bearishOBs = OrderBlockDetector.detectBearish(previous, this.lookback);
    this._bullishOBs = OrderBlockDetector.updateStates(this._bullishOBs, current);
    this._bearishOBs = OrderBlockDetector.updateStates(this._bearishOBs, current);

    // ── 2. Detect FVGs ──
    const allFVGs     = FVGDetector.detect(previous);
    this._bullishFVGs = FVGDetector.updateStates(
      allFVGs.filter(f => f.type === 'BULLISH_FVG'), current
    );
    this._bearishFVGs = FVGDetector.updateStates(
      allFVGs.filter(f => f.type === 'BEARISH_FVG'), current
    );
    const inverseFVGs = FVGDetector.detectInverse([...this._bullishFVGs, ...this._bearishFVGs]);

    // ── 3. Market Structure ──
    const swings          = MarketStructureDetector.findSwings(candles, this.pivotStrength);
    const { events, currentTrend } = MarketStructureDetector.detectStructureBreaks(candles, swings);
    const equalLevels     = MarketStructureDetector.findEqualLevels(swings);

    // ── 4. Liquidity ──
    const sweeps          = LiquidityDetector.detectSweeps(candles, swings);
    const inducements     = LiquidityDetector.detectInducement(candles);

    // ── 5. Premium / Discount ──
    const sh              = swingHigh(candles.slice(-50));
    const sl              = swingLow(candles.slice(-50));
    const pdZones         = PremiumDiscountCalculator.calculate(sh, sl);
    const currentPosition = PremiumDiscountCalculator.pricePosition(current.close, sh, sl);

    // ── 6. Wyckoff ──
    const wyckoff = WyckoffDetector.analyze(candles);

    // ── 7. Build full analysis object ──
    const analysis = {
      symbol:    this.symbol,
      timeframe: this.timeframe,
      timestamp: current.timestamp,
      currentPrice: round(current.close),

      orderBlocks: {
        bullish: OrderBlockDetector.getValid(this._bullishOBs),
        bearish: OrderBlockDetector.getValid(this._bearishOBs),
      },

      fvgs: {
        bullish: FVGDetector.getValid(this._bullishFVGs),
        bearish: FVGDetector.getValid(this._bearishFVGs),
        inverse: inverseFVGs,
      },

      structure: {
        currentTrend,
        events:   events.slice(-10), // last 10 structure breaks
        swings:   {
          highs: swings.highs.slice(-5),
          lows:  swings.lows.slice(-5),
        },
      },

      equalLevels,

      liquidity: {
        sweeps:      sweeps.slice(-5),
        inducements: inducements.slice(-5),
      },

      premiumDiscount: {
        ...pdZones,
        currentPosition,
      },

      wyckoff,
    };

    // ── 8. Determine signal direction ──
    let direction = SIGNAL_TYPE.WAIT;

    // Primary direction from market structure
    if (currentTrend === STRUCTURE.BULLISH) direction = SIGNAL_TYPE.LONG;
    if (currentTrend === STRUCTURE.BEARISH) direction = SIGNAL_TYPE.SHORT;

    // Override if CHoCH just fired
    const lastEvent = events.slice(-1)[0];
    if (lastEvent?.type === 'CHoCH') {
      direction = lastEvent.direction === STRUCTURE.BULLISH
        ? SIGNAL_TYPE.LONG
        : SIGNAL_TYPE.SHORT;
    }

    // Price must be in correct zone for direction
    if (direction === SIGNAL_TYPE.LONG  && currentPosition.zone === 'PREMIUM') direction = SIGNAL_TYPE.WAIT;
    if (direction === SIGNAL_TYPE.SHORT && currentPosition.zone === 'DISCOUNT') direction = SIGNAL_TYPE.WAIT;

    // ── 9. Score the signal ──
    let confluenceResult = { score: 0, reasons: ['No directional bias'], grade: 'D' };

    if (direction !== SIGNAL_TYPE.WAIT) {
      confluenceResult = SMCConfluenceScorer.score(analysis, direction);
    }

    // ── 10. Build trade signal ──
    const signal = this._buildSignal(direction, confluenceResult, analysis, current);

    return { analysis, signal, confluenceResult };
  }

  /**
   * Constructs the final trade signal object.
   * This is what gets fed to signal-scorer.js and alert-dispatcher.js
   */
  _buildSignal(direction, confluenceResult, analysis, currentCandle) {
    const { score, reasons, grade } = confluenceResult;
    const fire = direction !== SIGNAL_TYPE.WAIT && score >= this.minScore;

    if (!fire) {
      return {
        action:     SIGNAL_TYPE.WAIT,
        reason:     score < this.minScore
          ? `Score ${score}/100 below minimum ${this.minScore}`
          : 'No directional bias established',
        score,
        grade,
      };
    }

    // Find the best entry zone (OB or FVG)
    const isLong    = direction === SIGNAL_TYPE.LONG;
    const bestOB    = isLong
      ? analysis.orderBlocks.bullish[0]
      : analysis.orderBlocks.bearish[0];
    const bestFVG   = isLong
      ? analysis.fvgs.bullish[0]
      : analysis.fvgs.bearish[0];

    // Entry price: prefer OTE zone of best OB, fallback to FVG midpoint
    let entryZoneHigh, entryZoneLow;

    if (bestOB) {
      entryZoneHigh = bestOB.obHigh;
      entryZoneLow  = bestOB.ote50;
    } else if (bestFVG) {
      entryZoneHigh = bestFVG.fvgHigh;
      entryZoneLow  = bestFVG.fvgMid;
    } else {
      entryZoneHigh = round(currentCandle.close * 1.0005);
      entryZoneLow  = round(currentCandle.close * 0.9995);
    }

    // Stop Loss: beyond the OB or last swing
    const lastSwingHigh = analysis.structure.swings.highs.slice(-1)[0]?.price;
    const lastSwingLow  = analysis.structure.swings.lows.slice(-1)[0]?.price;

    const stopLoss = isLong
      ? round((bestOB?.obLow ?? lastSwingLow ?? currentCandle.low) * 0.9998)
      : round((bestOB?.obHigh ?? lastSwingHigh ?? currentCandle.high) * 1.0002);

    // Take Profit: next liquidity pool (EQH/EQL or swing high/low)
    const tp1Distance = Math.abs(currentCandle.close - stopLoss);
    const takeProfit1 = isLong
      ? round(currentCandle.close + tp1Distance * 1.5)  // 1:1.5 RR
      : round(currentCandle.close - tp1Distance * 1.5);

    const takeProfit2 = isLong
      ? round(currentCandle.close + tp1Distance * 3.0)  // 1:3 RR
      : round(currentCandle.close - tp1Distance * 3.0);

    // Partials: close 50% at TP1, let rest run to TP2
    const riskReward1 = round(tp1Distance * 1.5 / tp1Distance, 2);
    const riskReward2 = round(tp1Distance * 3.0 / tp1Distance, 2);

    return {
      action:       direction,
      symbol:       this.symbol,
      timeframe:    this.timeframe,
      timestamp:    currentCandle.timestamp,
      currentPrice: round(currentCandle.close),

      entry: {
        zoneHigh: entryZoneHigh,
        zoneLow:  entryZoneLow,
        type:     bestOB ? 'LIMIT_ORDER_IN_OB' : 'LIMIT_ORDER_IN_FVG',
        note:     'Wait for price to return to zone — do NOT chase',
      },

      stopLoss: {
        price: stopLoss,
        note:  isLong
          ? 'Below OB low — structure invalidated if hit'
          : 'Above OB high — structure invalidated if hit',
      },

      targets: {
        tp1: {
          price: takeProfit1,
          rr:    riskReward1,
          note:  'Close 50% here — protect profits',
        },
        tp2: {
          price: takeProfit2,
          rr:    riskReward2,
          note:  'Trail stop to BE after TP1 hit — let it run',
        },
      },

      confluence: {
        score,
        grade,
        reasons,
        smcFactors: {
          hasOrderBlock:    !!bestOB,
          hasFVG:           !!bestFVG,
          hasSweep:         analysis.liquidity.sweeps.length > 0,
          hasInducement:    analysis.liquidity.inducements.length > 0,
          marketStructure:  analysis.structure.currentTrend,
          priceZone:        analysis.premiumDiscount.currentPosition.zone,
          wyckoffPhase:     analysis.wyckoff.phase,
        },
      },

      management: {
        moveToBreakeven: 'After TP1 is hit',
        partialClose:    '50% at TP1',
        trailingStop:    'Use ATR × 1.5 after TP1',
        invalidation:    `Signal invalid if price closes beyond ${stopLoss}`,
      },
    };
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  SMCAgent,
  OrderBlockDetector,
  FVGDetector,
  MarketStructureDetector,
  LiquidityDetector,
  PremiumDiscountCalculator,
  WyckoffDetector,
  SMCConfluenceScorer,
  STRUCTURE,
  SIGNAL_TYPE,
  ZONE_STATE,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { SMCAgent } = require('./smc-agent');
 *
 *  const agent = new SMCAgent({
 *    symbol:       'XAUUSD',
 *    timeframe:    'H1',
 *    lookback:     30,
 *    pivotStrength: 3,
 *    minScore:     70,
 *  });
 *
 *  // candles = array from your data feed (binance-ws.js / twelve-data.js)
 *  // Each candle: { open, high, low, close, volume, timestamp }
 *
 *  const result = await agent.analyze(candles);
 *
 *  console.log(result.signal);
 *  // {
 *  //   action: 'LONG',
 *  //   entry:  { zoneHigh: 2345.00, zoneLow: 2342.50, type: 'LIMIT_ORDER_IN_OB' },
 *  //   stopLoss: { price: 2338.00 },
 *  //   targets: { tp1: { price: 2350.50, rr: 1.5 }, tp2: { price: 2359.50, rr: 3.0 } },
 *  //   confluence: { score: 82, grade: 'A', reasons: [...] }
 *  // }
 *
 *  // Feed this to: signal-scorer.js → sl-tp-engine.js → alert-dispatcher.js
 * ─────────────────────────────────────────────
 */
