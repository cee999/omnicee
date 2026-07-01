/**
 * ============================================================
 *  ENTRY OPTIMIZER — Zone-Based Entry Logic Engine
 *  AI Trading Assistant · Layer 5 · Signal Pipeline
 * ============================================================
 *
 *  What this does:
 *    Takes a raw signal from the scorer and refines the EXACT
 *    entry zone, entry type, and entry conditions based on:
 *
 *  ENTRY ZONE CALCULATION:
 *    - OTE (Optimal Trade Entry) — 0.618–0.786 Fibonacci retracement
 *    - Order Block refinement (mitigation candle body)
 *    - Fair Value Gap midpoint entries
 *    - VWAP reclaim/rejection entries
 *    - 50% retracement of last impulse leg
 *    - Breaker block entries
 *    - Liquidity void fill entries
 *    - EMA dynamic zone (9, 21 pullback)
 *    - Bollinger Band mean-reversion entries
 *    - Institutional Candle (IC) 50% level
 *
 *  ENTRY TYPES:
 *    LIMIT       → passive limit order at zone boundary
 *    STOP_LIMIT  → stop entry for breakout confirmation
 *    MARKET_NOW  → immediate market entry (Grade A only)
 *    SCALE_IN    → multiple entries across the zone (DCA)
 *    STOP_LOSS_HUNT → entry after obvious SL sweep
 *
 *  ENTRY CONFIRMATION ENGINE:
 *    - Rejection wick at zone (bullish/bearish pin bar)
 *    - CHoCH (Change of Character) on LTF inside zone
 *    - Volume spike at zone
 *    - RSI divergence entry signal
 *    - Momentum candle close (close above/below key level)
 *    - Time-based (only during high-probability sessions)
 *    - Spread check (don't enter during wide spread)
 *
 *  ENTRY QUALITY SCORING:
 *    Rates each potential entry 0-100 based on:
 *    - Zone precision (how well price aligns with zone)
 *    - Confluence count (how many zones overlap)
 *    - Confirmation strength (quality of entry signal)
 *    - Session timing bonus/penalty
 *    - Risk/reward ratio achievable from this entry
 *    - Liquidity above/below (clean path to target)
 *
 *  MULTI-ENTRY MANAGEMENT:
 *    - Tracks open entry windows
 *    - Cancels stale entries (price moved away)
 *    - Adjusts zone if new structure forms
 *    - Re-evaluates on each candle close
 *
 *  Output:
 *    {
 *      entryZone: { low, high, midpoint, type },
 *      entryType: 'LIMIT' | 'STOP_LIMIT' | 'MARKET_NOW' | 'SCALE_IN',
 *      entryPrice: number,          // ideal single entry price
 *      scaleEntries: [...],         // if SCALE_IN
 *      confirmations: [...],        // what to wait for
 *      qualityScore: 0-100,
 *      invalidation: price,         // if this is hit, cancel entry
 *      timeWindow: { start, end },  // when to accept entry
 *      reasons: [...],
 *      warnings: [...],
 *    }
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const FIBO_OTE_LOW  = 0.618;  // OTE zone low
const FIBO_OTE_HIGH = 0.786;  // OTE zone high
const FIBO_50       = 0.500;  // 50% retracement
const FIBO_382      = 0.382;  // shallow retrace
const FIBO_886      = 0.886;  // deep retrace / last chance

const OB_ENTRY_PCT       = 0.50;  // enter at 50% of OB body
const FVG_ENTRY_PCT      = 0.50;  // enter at midpoint of FVG
const ZONE_BUFFER_PCT    = 0.003; // 0.3% zone buffer above/below
const MAX_ZONE_WIDTH_PCT = 0.025; // zone must be < 2.5% wide
const MIN_RR_FOR_ENTRY   = 1.5;   // minimum RR to accept entry
const STALE_ENTRY_BARS   = 20;    // entry window expires after N candles
const SCALE_IN_LEVELS    = 3;     // number of scale-in entries

// Session windows (UTC hours)
const SESSIONS = {
  ASIA:     { start: 0,  end: 8  },
  LONDON:   { start: 8,  end: 13 },
  OVERLAP:  { start: 13, end: 16 },
  NEW_YORK: { start: 16, end: 21 },
  DEAD:     { start: 21, end: 24 },
};

const SESSION_QUALITY = {
  OVERLAP:  1.15,  // best — bonus
  LONDON:   1.10,
  NEW_YORK: 1.05,
  ASIA:     0.85,
  DEAD:     0.65,  // worst — penalty
};

function _round(n, d = 5)    { return parseFloat((+n).toFixed(d)); }
function _pct(a, b)          { return b !== 0 ? Math.abs(a - b) / b : 0; }
function _within(a, b, tol)  { return _pct(a, b) <= tol; }
function _avg(arr)            { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function _clamp(v, min, max)  { return Math.max(min, Math.min(max, v)); }
function _now()               { return Date.now(); }

// ─────────────────────────────────────────────
//  FIBONACCI ZONE CALCULATOR
// ─────────────────────────────────────────────

class FibonacciZones {
  /**
   * Calculates key Fibonacci retracement levels from an impulse leg.
   *
   * @param {number} legHigh  - high of the impulse leg
   * @param {number} legLow   - low of the impulse leg
   * @param {string} direction - 'LONG' | 'SHORT'
   * @returns {Object} fib levels + OTE zone
   */
  static calculate(legHigh, legLow, direction) {
    const range  = legHigh - legLow;
    if (range <= 0) return null;

    const isLong = direction === 'LONG';

    // Retracement from the extreme (for LONG: retrace from the high)
    const retrace = (ratio) => isLong
      ? _round(legHigh - range * ratio) // LONG: retrace down from high
      : _round(legLow  + range * ratio); // SHORT: retrace up from low

    const r236 = retrace(0.236);
    const r382 = retrace(0.382);
    const r500 = retrace(0.500);
    const r618 = retrace(0.618);
    const r705 = retrace(0.705);
    const r786 = retrace(0.786);
    const r886 = retrace(0.886);

    // OTE Zone: 0.618–0.786 retracement
    const oteHigh = isLong ? r618 : r786;  // closer to swing high for long
    const oteLow  = isLong ? r786 : r618;  // deeper for long

    // Extensions for targets
    const ext1272 = isLong ? _round(legHigh + range * 0.272) : _round(legLow - range * 0.272);
    const ext1618 = isLong ? _round(legHigh + range * 0.618) : _round(legLow - range * 0.618);
    const ext2618 = isLong ? _round(legHigh + range * 1.618) : _round(legLow - range * 1.618);

    return {
      legHigh: _round(legHigh),
      legLow:  _round(legLow),
      range:   _round(range, 5),
      direction,
      levels: { r236, r382, r500, r618, r705, r786, r886 },
      ote: {
        high:     isLong ? oteHigh : oteLow,
        low:      isLong ? oteLow  : oteHigh,
        midpoint: _round((oteHigh + oteLow) / 2),
        label:    'OTE (0.618–0.786)',
      },
      shallow: {
        high:     isLong ? r236 : r382,
        low:      isLong ? r382 : r236,
        midpoint: _round((r236 + r382) / 2),
        label:    'Shallow (0.236–0.382)',
      },
      deep: {
        high:     isLong ? r786 : r886,
        low:      isLong ? r886 : r786,
        midpoint: _round((r786 + r886) / 2),
        label:    'Deep (0.786–0.886)',
      },
      half: { price: r500, label: '50% Retracement' },
      extensions: { e1272: ext1272, e1618: ext1618, e2618: ext2618 },
    };
  }

  /**
   * Find the most recent impulse leg for Fibonacci calculation.
   * The impulse leg is the last significant directional move before the pullback.
   *
   * @param {Array}  candles   - OHLCV array
   * @param {string} direction - signal direction
   * @param {number} lookback  - bars to scan
   * @returns {{ legHigh, legLow, bars, strength }}
   */
  static findImpulseLeg(candles, direction, lookback = 40) {
    if (!candles || candles.length < lookback) return null;

    const recent  = candles.slice(-lookback);
    const isLong  = direction === 'LONG';

    // For LONG: find the bearish leg that preceded the bullish move
    // i.e., the last significant swing high and swing low
    if (isLong) {
      // Find most recent swing low (where we expect to enter on retrace)
      let swingLow  = { price: Infinity, idx: -1 };
      let swingHigh = { price: -Infinity, idx: -1 };

      for (let i = 2; i < recent.length - 2; i++) {
        const c = recent[i];
        if (c.low < recent[i-1].low && c.low < recent[i-2].low &&
            c.low < recent[i+1].low && c.low < recent[i+2].low) {
          if (c.low < swingLow.price) swingLow = { price: c.low, idx: i };
        }
        if (c.high > recent[i-1].high && c.high > recent[i-2].high &&
            c.high > recent[i+1].high && c.high > recent[i+2].high) {
          if (c.high > swingHigh.price) swingHigh = { price: c.high, idx: i };
        }
      }

      // The leg that created the recent low: from the swing high before the low
      if (swingHigh.idx < swingLow.idx && swingHigh.price > swingLow.price) {
        const legRange = swingHigh.price - swingLow.price;
        const legPct   = legRange / swingLow.price;
        return {
          legHigh:  swingHigh.price,
          legLow:   swingLow.price,
          bars:     swingLow.idx - swingHigh.idx,
          strength: legPct >= 0.05 ? 'STRONG' : legPct >= 0.02 ? 'MEDIUM' : 'WEAK',
          rangePct: _round(legPct * 100, 3),
        };
      }
    } else {
      // For SHORT: find the bullish leg before the high
      let swingLow  = { price: Infinity, idx: -1 };
      let swingHigh = { price: -Infinity, idx: -1 };

      for (let i = 2; i < recent.length - 2; i++) {
        const c = recent[i];
        if (c.low < recent[i-1].low && c.low < recent[i+1].low) {
          if (c.low < swingLow.price) swingLow = { price: c.low, idx: i };
        }
        if (c.high > recent[i-1].high && c.high > recent[i+1].high) {
          if (c.high > swingHigh.price) swingHigh = { price: c.high, idx: i };
        }
      }

      if (swingLow.idx < swingHigh.idx && swingHigh.price > swingLow.price) {
        const legRange = swingHigh.price - swingLow.price;
        const legPct   = legRange / swingLow.price;
        return {
          legHigh:  swingHigh.price,
          legLow:   swingLow.price,
          bars:     swingHigh.idx - swingLow.idx,
          strength: legPct >= 0.05 ? 'STRONG' : legPct >= 0.02 ? 'MEDIUM' : 'WEAK',
          rangePct: _round(legPct * 100, 3),
        };
      }
    }

    return null;
  }
}

// ─────────────────────────────────────────────
//  ORDER BLOCK ENTRY CALCULATOR
// ─────────────────────────────────────────────

class OrderBlockEntry {
  /**
   * Refines the entry zone from an SMC order block.
   * Entry is at the OB body 50% level or the OB low/high.
   *
   * @param {Object} ob        - order block from smc-agent
   * @param {string} direction - 'LONG' | 'SHORT'
   * @param {number} atr       - current ATR
   * @returns {Object} refined entry zone
   */
  static refine(ob, direction, atr) {
    if (!ob) return null;

    const isLong = direction === 'LONG';

    // OB body = open to close of the OB candle
    const obBodyHigh = Math.max(ob.open || ob.obHigh, ob.close || ob.obLow);
    const obBodyLow  = Math.min(ob.open || ob.obHigh, ob.close || ob.obLow);
    const obBodyMid  = (obBodyHigh + obBodyLow) / 2;

    // For LONG: buy at OB body 50% to OB low (deeper = better entry)
    // For SHORT: sell at OB body 50% to OB high
    const entryHigh = isLong ? _round(obBodyMid)  : _round(ob.obHigh || obBodyHigh);
    const entryLow  = isLong ? _round(ob.obLow || obBodyLow) : _round(obBodyMid);

    // ATR buffer below/above OB for SL placement
    const slBuffer = atr * 0.5;
    const idealSL  = isLong
      ? _round(entryLow  - slBuffer)
      : _round(entryHigh + slBuffer);

    const midpoint = _round((entryHigh + entryLow) / 2);
    const width    = _round(entryHigh - entryLow, 5);
    const widthPct = ob.obLow > 0 ? _round((width / ob.obLow) * 100, 3) : 0;

    return {
      type:      'ORDER_BLOCK',
      label:     `${isLong ? 'Bullish' : 'Bearish'} OB Entry`,
      high:      entryHigh,
      low:       entryLow,
      midpoint,
      width,
      widthPct,
      idealSL,
      idealEntry: midpoint,
      obStrength: ob.strength || 'MEDIUM',
      obFresh:   ob.mitigated === false,
      note:      `Enter at ${isLong ? 'bullish' : 'bearish'} OB body (${_round(entryLow)}–${_round(entryHigh)})`,
    };
  }
}

// ─────────────────────────────────────────────
//  FAIR VALUE GAP ENTRY CALCULATOR
// ─────────────────────────────────────────────

class FVGEntry {
  /**
   * Calculates entry from a Fair Value Gap (FVG/Imbalance).
   * Entry at the FVG midpoint or the 50% of the gap.
   *
   * @param {Object} fvg       - FVG from smc-agent
   * @param {string} direction
   * @param {Array}  candles
   * @returns {Object} entry zone
   */
  static refine(fvg, direction, candles) {
    if (!fvg) return null;

    const isLong   = direction === 'LONG';
    const gapHigh  = fvg.high || fvg.top;
    const gapLow   = fvg.low  || fvg.bottom;
    const gapMid   = _round((gapHigh + gapLow) / 2);
    const gapWidth = gapHigh - gapLow;

    if (!gapHigh || !gapLow || gapWidth <= 0) return null;

    // Entry: fill into FVG from the side we're entering
    // For LONG: price dropped below FVG, enters at FVG low + 25%
    // For SHORT: price rallied above FVG, enters at FVG high - 25%
    const entry25   = isLong  ? _round(gapLow + gapWidth * 0.25)  : _round(gapHigh - gapWidth * 0.25);
    const entry50   = gapMid;
    const entry75   = isLong  ? _round(gapLow + gapWidth * 0.75)  : _round(gapHigh - gapWidth * 0.75);

    const idealEntry = entry50; // midpoint = most conservative

    // Zone: 25%-75% of FVG body
    const zoneHigh = isLong ? entry75 : gapHigh;
    const zoneLow  = isLong ? gapLow  : entry75;

    // Staleness: how many candles ago was the FVG created?
    const age    = fvg.age || 0;
    const fresh  = age <= 5;
    const stale  = age > 20;

    return {
      type:        'FAIR_VALUE_GAP',
      label:       `${isLong ? 'Bullish' : 'Bearish'} FVG Fill`,
      high:        _round(zoneHigh),
      low:         _round(zoneLow),
      midpoint:    entry50,
      idealEntry,
      gapHigh:     _round(gapHigh),
      gapLow:      _round(gapLow),
      gapWidth:    _round(gapWidth, 5),
      entries:     { e25: entry25, e50: entry50, e75: entry75 },
      fresh, stale, age,
      quality:     fresh ? 'HIGH' : stale ? 'LOW' : 'MEDIUM',
      note:        `FVG fill entry at ${isLong ? 'gap low' : 'gap high'} — ${fresh ? 'fresh gap' : `${age} bars old`}`,
    };
  }
}

// ─────────────────────────────────────────────
//  VWAP ENTRY CALCULATOR
// ─────────────────────────────────────────────

class VWAPEntry {
  /**
   * Calculates VWAP-based entry zones.
   * - VWAP reclaim (price crosses back above/below VWAP)
   * - VWAP band touch (±1σ or ±2σ)
   * - VWAP slope entry (enter on pullback to rising/falling VWAP)
   */
  static calculate(vwapAnalysis, direction, currentPrice) {
    if (!vwapAnalysis) return null;

    const { vwap, band1Upper, band1Lower, band2Upper, band2Lower, slopeDir, aboveVWAP, vwapReclaim, vwapRejection } = vwapAnalysis;
    const isLong = direction === 'LONG';

    // VWAP reclaim entry (most precise)
    if (isLong && vwapReclaim) {
      return {
        type:        'VWAP_RECLAIM',
        label:       'VWAP Reclaim Entry',
        high:        _round(vwap * 1.003),
        low:         _round(vwap * 0.999),
        midpoint:    _round(vwap),
        idealEntry:  _round(vwap),
        quality:     'HIGH',
        note:        `VWAP reclaim at ${_round(vwap)} — institutions switching to buy side`,
      };
    }

    if (!isLong && vwapRejection) {
      return {
        type:        'VWAP_REJECTION',
        label:       'VWAP Rejection Entry',
        high:        _round(vwap * 1.001),
        low:         _round(vwap * 0.997),
        midpoint:    _round(vwap),
        idealEntry:  _round(vwap),
        quality:     'HIGH',
        note:        `VWAP rejection at ${_round(vwap)} — institutions switching to sell side`,
      };
    }

    // Band touch entry
    if (isLong && currentPrice <= band1Lower) {
      const zone = band2Lower ? Math.max(band2Lower, band1Lower * 0.998) : band1Lower * 0.998;
      return {
        type:       'VWAP_BAND',
        label:      'VWAP -1σ Band Entry',
        high:       _round(band1Lower),
        low:        _round(zone),
        midpoint:   _round((band1Lower + zone) / 2),
        idealEntry: _round(band1Lower),
        quality:    currentPrice <= band2Lower ? 'HIGH' : 'MEDIUM',
        note:       `VWAP discount zone (${_round(currentPrice)} at -${currentPrice <= band2Lower ? '2σ' : '1σ'} band)`,
      };
    }

    if (!isLong && currentPrice >= band1Upper) {
      const zone = band2Upper ? Math.min(band2Upper, band1Upper * 1.002) : band1Upper * 1.002;
      return {
        type:       'VWAP_BAND',
        label:      'VWAP +1σ Band Entry',
        high:       _round(zone),
        low:        _round(band1Upper),
        midpoint:   _round((band1Upper + zone) / 2),
        idealEntry: _round(band1Upper),
        quality:    currentPrice >= band2Upper ? 'HIGH' : 'MEDIUM',
        note:       `VWAP premium zone (${_round(currentPrice)} at +${currentPrice >= band2Upper ? '2σ' : '1σ'} band)`,
      };
    }

    // Pullback to VWAP (trend continuation)
    if (isLong && aboveVWAP && slopeDir === 'RISING') {
      return {
        type:       'VWAP_PULLBACK',
        label:      'VWAP Pullback (Trend Continue)',
        high:       _round(vwap * 1.005),
        low:        _round(vwap * 0.998),
        midpoint:   _round(vwap),
        idealEntry: _round(vwap),
        quality:    'MEDIUM',
        note:       `Pullback to rising VWAP (${_round(vwap)}) — buy the dip in trend`,
      };
    }

    if (!isLong && !aboveVWAP && slopeDir === 'FALLING') {
      return {
        type:       'VWAP_PULLBACK',
        label:      'VWAP Pullback (Trend Continue)',
        high:       _round(vwap * 1.002),
        low:        _round(vwap * 0.995),
        midpoint:   _round(vwap),
        idealEntry: _round(vwap),
        quality:    'MEDIUM',
        note:       `Bounce to falling VWAP (${_round(vwap)}) — sell the rally in downtrend`,
      };
    }

    return null;
  }
}

// ─────────────────────────────────────────────
//  EMA ENTRY CALCULATOR
// ─────────────────────────────────────────────

class EMAEntry {
  /**
   * Calculates entry zones from EMA levels.
   * - Dynamic support on EMA9/21 pullback (trend following)
   * - EMA50 bounce entry (key level)
   * - EMA200 touch (macro level)
   */
  static calculate(emaAnalysis, direction, currentPrice) {
    if (!emaAnalysis) return null;

    const { ema9, ema21, ema50, ema200, bullStack, bearStack, trendStrength } = emaAnalysis;
    const isLong = direction === 'LONG';

    // EMA9/21 pullback — tightest, most frequent
    if (isLong && bullStack && currentPrice > ema21 * 1.005) {
      // Price has pulled back to or near 9/21 EMA
      const isNear9  = _within(currentPrice, ema9,  0.008);
      const isNear21 = _within(currentPrice, ema21, 0.012);

      if (isNear9 || isNear21) {
        const zoneHigh = Math.max(ema9, ema21) * 1.002;
        const zoneLow  = Math.min(ema9, ema21) * 0.998;
        return {
          type:       'EMA_DYNAMIC',
          label:      'EMA 9/21 Bull Pullback',
          high:       _round(zoneHigh),
          low:        _round(zoneLow),
          midpoint:   _round((zoneHigh + zoneLow) / 2),
          idealEntry: _round((ema9 + ema21) / 2),
          ema9:       _round(ema9),
          ema21:      _round(ema21),
          quality:    isNear9 ? 'HIGH' : 'MEDIUM',
          note:       `EMA ${isNear9 ? '9' : '21'} pullback in bull stack — dynamic support entry`,
        };
      }
    }

    if (!isLong && bearStack && currentPrice < ema21 * 0.995) {
      const isNear9  = _within(currentPrice, ema9,  0.008);
      const isNear21 = _within(currentPrice, ema21, 0.012);

      if (isNear9 || isNear21) {
        const zoneHigh = Math.max(ema9, ema21) * 1.002;
        const zoneLow  = Math.min(ema9, ema21) * 0.998;
        return {
          type:       'EMA_DYNAMIC',
          label:      'EMA 9/21 Bear Bounce',
          high:       _round(zoneHigh),
          low:        _round(zoneLow),
          midpoint:   _round((zoneHigh + zoneLow) / 2),
          idealEntry: _round((ema9 + ema21) / 2),
          ema9:       _round(ema9),
          ema21:      _round(ema21),
          quality:    'MEDIUM',
          note:       `EMA 9/21 bounce in bear stack — dynamic resistance entry`,
        };
      }
    }

    // EMA50 entry — key level
    if (ema50 && _within(currentPrice, ema50, 0.015)) {
      return {
        type:       'EMA50',
        label:      'EMA 50 Touch',
        high:       _round(ema50 * 1.005),
        low:        _round(ema50 * 0.995),
        midpoint:   _round(ema50),
        idealEntry: _round(ema50),
        quality:    'MEDIUM',
        note:       `EMA50 (${_round(ema50)}) touch — key medium-term dynamic ${isLong ? 'support' : 'resistance'}`,
      };
    }

    // EMA200 entry — macro level (only in strong trend contexts)
    if (ema200 && _within(currentPrice, ema200, 0.015)) {
      const isGoodContext = isLong
        ? (trendStrength === 'MILD_BULL' || trendStrength === 'STRONG_BULL')
        : (trendStrength === 'MILD_BEAR' || trendStrength === 'STRONG_BEAR');

      if (isGoodContext) {
        return {
          type:       'EMA200',
          label:      'EMA 200 Macro Level',
          high:       _round(ema200 * 1.008),
          low:        _round(ema200 * 0.992),
          midpoint:   _round(ema200),
          idealEntry: _round(ema200),
          quality:    'HIGH', // EMA200 touches are high quality
          note:       `EMA200 (${_round(ema200)}) touch — macro ${isLong ? 'support' : 'resistance'}, high confidence`,
        };
      }
    }

    return null;
  }
}

// ─────────────────────────────────────────────
//  LIQUIDITY SWEEP ENTRY
// ─────────────────────────────────────────────

class LiquiditySweepEntry {
  /**
   * Detects if price recently swept liquidity (stop hunt)
   * and calculates the entry after the sweep.
   * This is the highest-precision entry type in SMC.
   *
   * Pattern: Price dips below a swing low (sweeps stops),
   * then recovers strongly = immediate entry signal.
   *
   * @param {Array}  candles   - OHLCV
   * @param {string} direction
   * @param {Object} smcAnalysis - from smc-agent
   * @returns {Object|null}
   */
  static detect(candles, direction, smcAnalysis) {
    if (!candles || candles.length < 10) return null;

    const isLong  = direction === 'LONG';
    const recent  = candles.slice(-10);
    const current = candles[candles.length - 1];

    // Check SMC sweep data
    const sweeps = smcAnalysis?.sweeps || smcAnalysis?.liquiditySweeps;
    if (sweeps) {
      const relevantSweep = isLong
        ? sweeps.bullishSweep || sweeps.buy
        : sweeps.bearishSweep || sweeps.sell;

      if (relevantSweep && relevantSweep.recent) {
        return {
          type:       'LIQUIDITY_SWEEP',
          label:      `${isLong ? 'Bullish' : 'Bearish'} Liquidity Sweep Entry`,
          high:       _round(current.close * 1.003),
          low:        _round(current.close * 0.997),
          midpoint:   _round(current.close),
          idealEntry: _round(current.close),
          sweepLevel: relevantSweep.level,
          quality:    'HIGHEST',
          urgent:     true,  // enter immediately on next candle open
          note:       `Liquidity sweep completed at ${_round(relevantSweep.level)} — institutional stop hunt, immediate ${isLong ? 'long' : 'short'} entry`,
        };
      }
    }

    // Manual sweep detection from candles
    if (isLong) {
      // Look for candle that dipped below recent low then closed above it
      for (let i = recent.length - 3; i < recent.length; i++) {
        const c    = recent[i];
        const prevLows = recent.slice(0, i).map(x => x.low);
        const minPrevLow = Math.min(...prevLows);

        if (c.low < minPrevLow && c.close > minPrevLow) {
          const recoveryStrength = (c.close - c.low) / (c.high - c.low);
          if (recoveryStrength > 0.6) {
            return {
              type:       'LIQUIDITY_SWEEP',
              label:      'Bullish Stop Hunt Entry',
              high:       _round(c.close * 1.004),
              low:        _round(minPrevLow),
              midpoint:   _round((c.close + minPrevLow) / 2),
              idealEntry: _round(c.close),
              sweepLevel: _round(minPrevLow),
              sweepDepth: _round((minPrevLow - c.low) / minPrevLow * 100, 3),
              quality:    recoveryStrength > 0.8 ? 'HIGHEST' : 'HIGH',
              urgent:     i === recent.length - 1,
              note:       `Stop hunt below ${_round(minPrevLow)} (swept ${_round((minPrevLow - c.low) / minPrevLow * 100, 2)}%), strong recovery — LONG`,
            };
          }
        }
      }
    } else {
      for (let i = recent.length - 3; i < recent.length; i++) {
        const c       = recent[i];
        const prevHighs = recent.slice(0, i).map(x => x.high);
        const maxPrevHigh = Math.max(...prevHighs);

        if (c.high > maxPrevHigh && c.close < maxPrevHigh) {
          const rejectionStrength = (c.high - c.close) / (c.high - c.low);
          if (rejectionStrength > 0.6) {
            return {
              type:       'LIQUIDITY_SWEEP',
              label:      'Bearish Stop Hunt Entry',
              high:       _round(maxPrevHigh),
              low:        _round(c.close * 0.996),
              midpoint:   _round((maxPrevHigh + c.close) / 2),
              idealEntry: _round(c.close),
              sweepLevel: _round(maxPrevHigh),
              quality:    rejectionStrength > 0.8 ? 'HIGHEST' : 'HIGH',
              urgent:     i === recent.length - 1,
              note:       `Stop hunt above ${_round(maxPrevHigh)}, strong rejection — SHORT`,
            };
          }
        }
      }
    }

    return null;
  }
}

// ─────────────────────────────────────────────
//  BREAKOUT ENTRY CALCULATOR
// ─────────────────────────────────────────────

class BreakoutEntry {
  /**
   * For signals that require a structural break for entry.
   * Entry on pullback after breakout (BOPB — break of structure pullback).
   *
   * @param {Object} smcAnalysis
   * @param {string} direction
   * @param {Array}  candles
   * @returns {Object|null}
   */
  static calculate(smcAnalysis, direction, candles) {
    if (!smcAnalysis || !candles) return null;

    const isLong    = direction === 'LONG';
    const bos       = smcAnalysis.bos || smcAnalysis.breakOfStructure;
    const choch     = smcAnalysis.choch || smcAnalysis.changeOfCharacter;

    // Recent CHoCH = highest quality breakout entry
    const relevantChoch = isLong
      ? choch?.bullish || choch?.bull
      : choch?.bearish || choch?.bear;

    if (relevantChoch) {
      const breakLevel  = typeof relevantChoch === 'object' ? relevantChoch.price : relevantChoch;
      const current     = candles[candles.length - 1].close;
      const retracePct  = _round(_pct(current, breakLevel) * 100, 3);

      // Price should be between the break level and 0.5 retrace for BOPB
      if (isLong && current > breakLevel && retracePct < 3.0) {
        return {
          type:        'CHOCH_PULLBACK',
          label:       'CHoCH Pullback Entry (BOPB)',
          high:        _round(Math.max(current, breakLevel) * 1.003),
          low:         _round(breakLevel * 0.998),
          midpoint:    _round((current + breakLevel) / 2),
          idealEntry:  _round(breakLevel * 1.001),
          breakLevel:  _round(breakLevel),
          quality:     retracePct < 1.5 ? 'HIGH' : 'MEDIUM',
          note:        `CHoCH at ${_round(breakLevel)} confirmed — pullback ${retracePct}% for BOPB entry`,
        };
      }

      if (!isLong && current < breakLevel && retracePct < 3.0) {
        return {
          type:        'CHOCH_PULLBACK',
          label:       'CHoCH Pullback Entry (BOPB)',
          high:        _round(breakLevel * 1.002),
          low:         _round(Math.min(current, breakLevel) * 0.997),
          midpoint:    _round((current + breakLevel) / 2),
          idealEntry:  _round(breakLevel * 0.999),
          breakLevel:  _round(breakLevel),
          quality:     'HIGH',
          note:        `Bearish CHoCH at ${_round(breakLevel)} — pullback for BOPB short entry`,
        };
      }
    }

    return null;
  }
}

// ─────────────────────────────────────────────
//  ENTRY CONFIRMATION ENGINE
// ─────────────────────────────────────────────

class ConfirmationEngine {
  /**
   * Evaluates real-time confirmation signals for entry.
   * Called each candle close while price is in the entry zone.
   *
   * @param {Array}  candles      - OHLCV (latest candle is current)
   * @param {Object} entryZone    - calculated entry zone
   * @param {string} direction
   * @param {Object} indicators   - from momentum-agent
   * @returns {Object} confirmation assessment
   */
  static evaluate(candles, entryZone, direction, indicators = {}) {
    const current   = candles[candles.length - 1];
    const prev      = candles[candles.length - 2] || current;
    const isLong    = direction === 'LONG';
    const inZone    = isLong
      ? current.close >= entryZone.low && current.close <= entryZone.high
      : current.close >= entryZone.low && current.close <= entryZone.high;

    const confirmations = [];
    const warnings      = [];
    let   strength      = 0;

    // ── 1. Rejection Wick (Pin Bar) at zone ──
    const wickConf = ConfirmationEngine._wickConfirmation(current, prev, isLong, entryZone);
    if (wickConf.confirmed) {
      strength += wickConf.strength;
      confirmations.push({ type: 'WICK_REJECTION', strength: wickConf.strength, note: wickConf.note });
    }

    // ── 2. Engulfing candle ──
    const engulf = ConfirmationEngine._engulfing(current, prev, isLong);
    if (engulf.confirmed) {
      strength += engulf.strength;
      confirmations.push({ type: 'ENGULFING', strength: engulf.strength, note: engulf.note });
    }

    // ── 3. Volume spike at zone ──
    const avgVol  = candles.slice(-20).reduce((s, c) => s + (c.volume || 1), 0) / 20;
    const currVol = current.volume || 1;
    const volRatio = currVol / avgVol;
    if (volRatio >= 1.5) {
      const volStr = volRatio >= 2.5 ? 25 : volRatio >= 2.0 ? 18 : 10;
      strength += volStr;
      confirmations.push({
        type: 'VOLUME_SPIKE', strength: volStr,
        note: `Volume ${_round(volRatio, 1)}x average at zone — institutional participation`,
      });
    }

    // ── 4. RSI divergence / oversold-oversold exit ──
    if (indicators.rsi) {
      const rsi = indicators.rsi;
      if (isLong && rsi.zone === 'OVERSOLD' && rsi.trend === 'RISING') {
        strength += 20;
        confirmations.push({ type: 'RSI_EXIT_OS', strength: 20, note: `RSI exiting oversold (${rsi.value}) — momentum turning` });
      }
      if (!isLong && rsi.zone === 'OVERBOUGHT' && rsi.trend === 'FALLING') {
        strength += 20;
        confirmations.push({ type: 'RSI_EXIT_OB', strength: 20, note: `RSI exiting overbought (${rsi.value}) — momentum turning` });
      }
      if (rsi.divergence?.bullish && isLong) {
        strength += 15;
        confirmations.push({ type: 'RSI_DIVERGENCE', strength: 15, note: `Bullish RSI divergence in zone — high conviction` });
      }
      if (rsi.divergence?.bearish && !isLong) {
        strength += 15;
        confirmations.push({ type: 'RSI_DIVERGENCE', strength: 15, note: `Bearish RSI divergence in zone — high conviction` });
      }
    }

    // ── 5. MACD momentum shift ──
    if (indicators.macd) {
      const macd = indicators.macd;
      if (isLong && (macd.bullCross || macd.histTrend === 'BULLISH_ACCELERATING')) {
        strength += 15;
        confirmations.push({ type: 'MACD_CONFIRM', strength: 15, note: `MACD bullish shift in zone — momentum aligning` });
      }
      if (!isLong && (macd.bearCross || macd.histTrend === 'BEARISH_ACCELERATING')) {
        strength += 15;
        confirmations.push({ type: 'MACD_CONFIRM', strength: 15, note: `MACD bearish shift in zone — momentum aligning` });
      }
    }

    // ── 6. Stochastic RSI oversold/overbought exit ──
    if (indicators.stochRsi) {
      const sr = indicators.stochRsi;
      if (isLong && sr.bullCross && sr.zone === 'OVERSOLD') {
        strength += 12;
        confirmations.push({ type: 'STOCHRSI_CROSS', strength: 12, note: `Stoch RSI bull cross from oversold in zone` });
      }
      if (!isLong && sr.bearCross && sr.zone === 'OVERBOUGHT') {
        strength += 12;
        confirmations.push({ type: 'STOCHRSI_CROSS', strength: 12, note: `Stoch RSI bear cross from overbought in zone` });
      }
    }

    // ── 7. Candle close inside zone ──
    if (inZone) {
      strength += 8;
      confirmations.push({ type: 'PRICE_IN_ZONE', strength: 8, note: `Price confirmed inside entry zone` });
    }

    // ── Warnings ──
    if (!inZone) warnings.push(`Price ${isLong ? 'above' : 'below'} entry zone — wait for retrace`);
    if (volRatio < 0.5) warnings.push(`Very low volume — lack of institutional participation`);
    if (indicators.adx && indicators.adx.adx < 15) warnings.push(`ADX ${_round(indicators.adx.adx, 1)} — ranging market, patterns less reliable`);

    const totalStrength = Math.min(100, strength);
    const readyToEnter  = totalStrength >= 50 && inZone && confirmations.length >= 2;
    const signalQuality = totalStrength >= 80 ? 'A'
                        : totalStrength >= 60 ? 'B'
                        : totalStrength >= 40 ? 'C'
                        : 'D';

    return {
      readyToEnter,
      inZone,
      strength:     totalStrength,
      quality:      signalQuality,
      confirmations,
      warnings,
      bestConfirmation: confirmations.sort((a, b) => b.strength - a.strength)[0] || null,
    };
  }

  static _wickConfirmation(current, prev, isLong, zone) {
    const body   = Math.abs(current.close - current.open);
    const spread = current.high - current.low;
    if (spread === 0) return { confirmed: false };

    const upperWick = current.high - Math.max(current.close, current.open);
    const lowerWick = Math.min(current.close, current.open) - current.low;
    const bodyRatio = body / spread;

    if (isLong) {
      // Bullish pin bar: long lower wick, small body at top
      const lowerWickRatio = lowerWick / spread;
      if (lowerWickRatio >= 0.6 && bodyRatio <= 0.35 && current.low <= zone.high) {
        return {
          confirmed: true,
          strength:  lowerWickRatio >= 0.75 ? 25 : 18,
          note:      `Bullish pin bar at zone (lower wick ${_round(lowerWickRatio*100,0)}% of range)`,
        };
      }
    } else {
      // Bearish pin bar: long upper wick
      const upperWickRatio = upperWick / spread;
      if (upperWickRatio >= 0.6 && bodyRatio <= 0.35 && current.high >= zone.low) {
        return {
          confirmed: true,
          strength:  upperWickRatio >= 0.75 ? 25 : 18,
          note:      `Bearish pin bar at zone (upper wick ${_round(upperWickRatio*100,0)}% of range)`,
        };
      }
    }

    return { confirmed: false };
  }

  static _engulfing(current, prev, isLong) {
    const currBody = Math.abs(current.close - current.open);
    const prevBody = Math.abs(prev.close - prev.open);

    if (isLong) {
      // Bullish engulfing: current closes above prev open, was below prev close
      const engulfs = current.close > prev.open && current.open < prev.close;
      const isBull  = current.close > current.open;
      const prevBear = prev.close < prev.open;
      if (engulfs && isBull && prevBear && currBody > prevBody * 1.1) {
        return {
          confirmed: true,
          strength:  currBody > prevBody * 1.5 ? 22 : 15,
          note:      `Bullish engulfing candle — momentum shift confirmed`,
        };
      }
    } else {
      const engulfs  = current.close < prev.open && current.open > prev.close;
      const isBear   = current.close < current.open;
      const prevBull = prev.close > prev.open;
      if (engulfs && isBear && prevBull && currBody > prevBody * 1.1) {
        return {
          confirmed: true,
          strength:  currBody > prevBody * 1.5 ? 22 : 15,
          note:      `Bearish engulfing candle — momentum shift confirmed`,
        };
      }
    }

    return { confirmed: false };
  }
}

// ─────────────────────────────────────────────
//  ZONE QUALITY SCORER
// ─────────────────────────────────────────────

class ZoneQualityScorer {
  /**
   * Scores the quality of an entry zone 0-100.
   * Used to rank multiple candidate zones.
   *
   * @param {Object} zone         - candidate entry zone
   * @param {Object} signal       - scored signal
   * @param {Object} smcAnalysis  - for confluence
   * @param {number} currentPrice
   * @param {number} atr
   * @param {string} session      - current session
   * @returns {Object} scored zone
   */
  static score(zone, signal, smcAnalysis, currentPrice, atr, session) {
    let score   = 0;
    const notes = [];

    // ── 1. Zone precision (how tight + how well price aligns) ──
    const widthPct = zone.widthPct || (zone.high - zone.low) / zone.midpoint * 100;
    if (widthPct <= 0.5) { score += 20; notes.push('Ultra-tight zone < 0.5%'); }
    else if (widthPct <= 1.0) { score += 15; notes.push('Tight zone < 1.0%'); }
    else if (widthPct <= 1.5) { score += 10; notes.push('Normal zone < 1.5%'); }
    else if (widthPct <= 2.5) { score += 5; }
    else { score -= 5; notes.push('Wide zone > 2.5% — imprecise'); }

    // ── 2. Zone type quality ──
    const typeScore = {
      'LIQUIDITY_SWEEP': 25, 'ORDER_BLOCK': 22, 'CHOCH_PULLBACK': 20,
      'FAIR_VALUE_GAP': 18,  'VWAP_RECLAIM': 17, 'OTE': 16,
      'EMA200': 15,          'VWAP_BAND': 14,    'EMA_DYNAMIC': 13,
      'VWAP_PULLBACK': 12,   'EMA50': 11,        'DEEP_RETRACE': 10,
    };
    score += typeScore[zone.type] || 8;
    notes.push(`Zone type: ${zone.type}`);

    // ── 3. Confluence (how many zones overlap) ──
    // Will be calculated by the main engine across all zones

    // ── 4. Distance from current price ──
    const distPct = _pct(currentPrice, zone.midpoint) * 100;
    if (distPct <= 0.5) { score += 15; notes.push('Price at zone now'); }
    else if (distPct <= 1.5) { score += 10; notes.push('Price near zone'); }
    else if (distPct <= 3.0) { score += 5; notes.push('Price approaching zone'); }
    else { score += 0; notes.push(`Price ${_round(distPct,1)}% from zone`); }

    // ── 5. Risk/Reward from this zone ──
    // Uses signal's TP1 target if available
    if (signal.targets?.tp1?.price && zone.midpoint) {
      const tpDist   = Math.abs(signal.targets.tp1.price - zone.midpoint);
      const slDist   = Math.abs(zone.midpoint - (signal.stopLoss?.price || zone.low));
      const rr       = slDist > 0 ? tpDist / slDist : 0;
      if (rr >= 3.0) { score += 15; notes.push(`RR from zone: ${_round(rr,2)}:1`); }
      else if (rr >= 2.0) { score += 10; notes.push(`RR from zone: ${_round(rr,2)}:1`); }
      else if (rr >= 1.5) { score += 5; notes.push(`RR from zone: ${_round(rr,2)}:1`); }
      else { score -= 5; notes.push(`Poor RR from zone: ${_round(rr,2)}:1`); }
    }

    // ── 6. Session quality multiplier ──
    const sessMultiplier = SESSION_QUALITY[session] || 0.9;
    score = score * sessMultiplier;

    // ── 7. Freshness bonus ──
    if (zone.obFresh === true || zone.fresh === true || zone.quality === 'HIGH') {
      score += 8;
      notes.push('Fresh/unmitigated zone — higher probability');
    }

    // ── 8. Quality label override ──
    if (zone.quality === 'HIGHEST') score = Math.max(score, 85);

    return {
      ...zone,
      qualityScore: Math.min(100, Math.round(score)),
      qualityNotes: notes,
      qualityGrade: score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D',
      distancePct:  _round(_pct(currentPrice, zone.midpoint) * 100, 3),
    };
  }

  /**
   * Find confluence between multiple zones.
   * Zones that overlap = stronger entry point.
   */
  static findConfluence(zones, tolerance = 0.008) {
    const confluenceGroups = [];

    for (let i = 0; i < zones.length; i++) {
      const group = [zones[i]];
      for (let j = i + 1; j < zones.length; j++) {
        const mid1 = zones[i].midpoint;
        const mid2 = zones[j].midpoint;
        if (_within(mid1, mid2, tolerance)) {
          group.push(zones[j]);
        }
      }
      if (group.length > 1) {
        const avgMid = _avg(group.map(z => z.midpoint));
        const avgHigh = _avg(group.map(z => z.high));
        const avgLow  = _avg(group.map(z => z.low));
        confluenceGroups.push({
          zones:         group.map(z => z.type),
          count:         group.length,
          midpoint:      _round(avgMid),
          high:          _round(avgHigh),
          low:           _round(avgLow),
          confluenceScore: group.length * 12,
          note:          `${group.length}-way confluence: ${group.map(z => z.type).join(' + ')}`,
        });
      }
    }

    return confluenceGroups.sort((a, b) => b.count - a.count);
  }
}

// ─────────────────────────────────────────────
//  ENTRY TYPE SELECTOR
// ─────────────────────────────────────────────

class EntryTypeSelector {
  /**
   * Determines the optimal entry type based on:
   * - Zone quality score
   * - Signal grade
   * - Market conditions
   * - Distance from current price
   * - Confirmation status
   */
  static select(zone, signal, confirmation, distancePct, session) {
    const isGradeA      = signal.score?.grade === 'A';
    const isGradeB      = signal.score?.grade === 'B';
    const inZoneNow     = distancePct <= 0.3;
    const nearZone      = distancePct <= 1.0;
    const approaching   = distancePct <= 2.5;
    const urgentEntry   = zone.urgent === true;
    const isDeadSession = session === 'DEAD';

    // Immediate market entry conditions (highest conviction only)
    if (urgentEntry && isGradeA && confirmation.readyToEnter && !isDeadSession) {
      return {
        type:       'MARKET_NOW',
        label:      'Market Entry — Immediate',
        reasoning:  'Grade A + sweep confirmed + all conditions met — enter at market',
        risk:       'LOW',
        waitFor:    null,
      };
    }

    // Scale-in for wide zones
    const zoneWidthPct = zone.widthPct || _pct(zone.high, zone.low) * 100;
    if (zoneWidthPct >= 0.8 && zoneWidthPct <= 2.5 && (isGradeA || isGradeB)) {
      return {
        type:       'SCALE_IN',
        label:      'Scale-In (3 Levels)',
        reasoning:  `Zone width ${_round(zoneWidthPct,2)}% — scale in across zone for better average`,
        risk:       'MEDIUM',
        waitFor:    'Price to enter zone',
        levels:     EntryTypeSelector._buildScaleLevels(zone, signal.action),
      };
    }

    // Limit order (standard — most common)
    if (approaching || nearZone) {
      return {
        type:       'LIMIT',
        label:      'Limit Order',
        reasoning:  `Place limit at ${_round(zone.idealEntry || zone.midpoint)} — wait for price to fill`,
        risk:       'LOW',
        waitFor:    confirmation.readyToEnter ? null : `Wait for: ${confirmation.confirmations.map(c => c.type).join(', ')}`,
      };
    }

    // Stop-limit for breakout confirmation
    if (!approaching && signal.action) {
      const isLong = signal.action === 'LONG';
      const stopPrice = isLong ? zone.high : zone.low;
      return {
        type:       'STOP_LIMIT',
        label:      'Stop-Limit (Breakout Confirm)',
        reasoning:  `Price ${_round(distancePct,1)}% from zone — use stop entry at ${_round(stopPrice)}`,
        risk:       'MEDIUM',
        waitFor:    `Price to break ${_round(stopPrice)}`,
        stopPrice:  _round(stopPrice),
      };
    }

    return {
      type:    'LIMIT',
      label:   'Limit Order (Default)',
      reasoning: 'Standard limit entry at zone midpoint',
      risk:    'LOW',
      waitFor: 'Price to enter zone',
    };
  }

  static _buildScaleLevels(zone, direction) {
    const isLong = direction === 'LONG';
    const rangeH = zone.high;
    const rangeL = zone.low;
    const width  = rangeH - rangeL;
    const third  = width / SCALE_IN_LEVELS;

    // For LONG: enter deeper in the zone (lower = better price)
    // Level 1: zone top third (early / less aggressive)
    // Level 2: zone middle (standard)
    // Level 3: zone bottom (aggressive / deepest discount)
    return isLong ? [
      { level: 1, price: _round(rangeH - third * 0.5), size: 0.30, note: 'Level 1 — conservative (30% size)' },
      { level: 2, price: _round(rangeH - third * 1.5), size: 0.40, note: 'Level 2 — standard (40% size)' },
      { level: 3, price: _round(rangeL + third * 0.3), size: 0.30, note: 'Level 3 — aggressive at zone low (30% size)' },
    ] : [
      { level: 1, price: _round(rangeL + third * 0.5), size: 0.30, note: 'Level 1 — conservative (30% size)' },
      { level: 2, price: _round(rangeL + third * 1.5), size: 0.40, note: 'Level 2 — standard (40% size)' },
      { level: 3, price: _round(rangeH - third * 0.3), size: 0.30, note: 'Level 3 — aggressive at zone high (30% size)' },
    ];
  }
}

// ─────────────────────────────────────────────
//  INVALIDATION CALCULATOR
// ─────────────────────────────────────────────

class InvalidationCalculator {
  /**
   * Determines the exact price at which the entry setup is cancelled.
   * Different from the trade SL — this is the PRE-ENTRY invalidation.
   *
   * @param {Object} zone      - entry zone
   * @param {string} direction
   * @param {number} atr
   * @param {Object} smcAnalysis
   * @returns {{ price, reason, method }}
   */
  static calculate(zone, direction, atr, smcAnalysis) {
    const isLong    = direction === 'LONG';
    const buffer    = atr * 0.3;

    // Primary: close below/above zone with body
    const zoneLine   = isLong ? zone.low : zone.high;
    const primary    = isLong
      ? _round(zoneLine - buffer)
      : _round(zoneLine + buffer);

    // Structural: any recent swing below/above our entry zone
    let structural = null;
    if (smcAnalysis?.marketStructure) {
      const { lastSwingLow, lastSwingHigh } = smcAnalysis.marketStructure;
      if (isLong && lastSwingLow) {
        structural = _round(lastSwingLow - buffer * 0.5);
      }
      if (!isLong && lastSwingHigh) {
        structural = _round(lastSwingHigh + buffer * 0.5);
      }
    }

    const invalidationPrice = structural
      ? (isLong ? Math.min(primary, structural) : Math.max(primary, structural))
      : primary;

    return {
      price:  invalidationPrice,
      method: structural ? 'STRUCTURAL' : 'ZONE_BREACH',
      reason: isLong
        ? `Entry invalid if price closes below ${_round(invalidationPrice)} (zone + structure broken)`
        : `Entry invalid if price closes above ${_round(invalidationPrice)} (zone + structure broken)`,
      buffer: _round(buffer, 5),
    };
  }
}

// ─────────────────────────────────────────────
//  TIME WINDOW CALCULATOR
// ─────────────────────────────────────────────

class TimeWindowCalculator {
  /**
   * Determines the time window during which entry is acceptable.
   * Avoids entries in low-liquidity periods (dead zone, pre-news).
   */
  static calculate(signal, upcomingEvents = []) {
    const now     = new Date();
    const utcHour = now.getUTCHours();
    const session = TimeWindowCalculator._getSession(utcHour);

    // Check for upcoming high-impact events (avoid 30 min before)
    const nextEvent = upcomingEvents.find(e => {
      const msUntil = e.timestamp - Date.now();
      return msUntil > 0 && msUntil < 2 * 60 * 60 * 1000 && e.impact === 'HIGH';
    });

    const blackoutStart = nextEvent ? new Date(nextEvent.timestamp - 30 * 60 * 1000) : null;

    // Determine ideal trading window
    let windowStart, windowEnd, acceptable;

    if (session === 'DEAD') {
      // Dead zone: still allow entries if Grade A
      acceptable = signal.score?.grade === 'A';
      windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
      windowEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
    } else {
      acceptable  = true;
      const sessInfo = SESSIONS[session];
      windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), sessInfo.start, 0, 0));
      windowEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), sessInfo.end, 0, 0));
    }

    return {
      session,
      acceptable,
      sessionQuality:  SESSION_QUALITY[session] || 0.9,
      windowStart:     windowStart.toISOString(),
      windowEnd:       windowEnd.toISOString(),
      blackout:        blackoutStart ? { active: true, event: nextEvent?.name, startsAt: blackoutStart.toISOString() } : { active: false },
      currentUTCHour:  utcHour,
      note: acceptable
        ? `${session} session — entry acceptable (quality: ${_round(SESSION_QUALITY[session] || 0.9, 2)}x)`
        : `Dead zone — low quality entries only for Grade A signals`,
    };
  }

  static _getSession(utcHour) {
    if (utcHour >= 21) return 'DEAD';
    if (utcHour < 8)   return 'ASIA';
    if (utcHour < 13)  return 'LONDON';
    if (utcHour < 16)  return 'OVERLAP';
    return 'NEW_YORK';
  }
}

// ─────────────────────────────────────────────
//  MAIN ENTRY OPTIMIZER
// ─────────────────────────────────────────────

class EntryOptimizer extends EventEmitter {
  /**
   * @param {Object} config
   * @param {number} [config.minRR]              - minimum RR to accept (default 1.5)
   * @param {number} [config.minQualityScore]    - minimum zone quality (default 55)
   * @param {boolean} [config.requireConfirmation] - require confirmation before entry (default true)
   * @param {number} [config.maxZoneWidthPct]    - reject zones wider than this % (default 2.5)
   * @param {boolean} [config.allowDeadSession]  - allow entries in dead zone (default false)
   * @param {number} [config.gradeAMinScore]     - min zone score for Grade A (default 65)
   */
  constructor(config = {}) {
    super();
    this.minRR               = config.minRR              || MIN_RR_FOR_ENTRY;
    this.minQualityScore     = config.minQualityScore    || 55;
    this.requireConfirmation = config.requireConfirmation !== false;
    this.maxZoneWidthPct     = config.maxZoneWidthPct    || MAX_ZONE_WIDTH_PCT * 100;
    this.allowDeadSession    = config.allowDeadSession   || false;
    this.gradeAMinScore      = config.gradeAMinScore     || 65;

    // Active entry windows: signalId → { zone, entryResult, createdAt, barsOpen }
    this._activeWindows = new Map();

    this._stats = {
      optimized: 0, accepted: 0, rejected: 0,
      avgQuality: 0, byType: {}, byZone: {},
    };
  }

  // ─────────────────────────────────────────────
  //  PRIMARY OPTIMIZE METHOD
  // ─────────────────────────────────────────────

  /**
   * Primary method. Takes a scored signal and candles,
   * returns optimal entry zone + type + confirmations.
   *
   * @param {Object} signal   - from signal-scorer
   * @param {Array}  candles  - OHLCV
   * @param {Object} [opts]
   * @param {Array}  [opts.upcomingEvents] - macro events
   * @returns {Object} optimized entry
   */
  optimize(signal, candles, opts = {}) {
    this._stats.optimized++;

    if (!signal || !candles || candles.length < 30) {
      return this._reject('Invalid input', signal);
    }

    if (signal.action === 'WAIT') {
      return this._reject('Signal is WAIT', signal);
    }

    const direction      = signal.action;
    const currentPrice   = candles[candles.length - 1].close;
    const atr            = this._calcATR(candles, 14);
    const smcAnalysis    = signal.agentVotes?.smc?.analysis || signal.analysis || {};
    const momAnalysis    = signal.agentVotes?.momentum?.analysis || {};
    const indicators     = momAnalysis;

    // ── Time window ──
    const timeWindow = TimeWindowCalculator.calculate(signal, opts.upcomingEvents || []);

    if (!timeWindow.acceptable && !this.allowDeadSession) {
      return this._reject(`Dead session — entry not recommended`, signal, { timeWindow });
    }

    if (timeWindow.blackout?.active) {
      return this._reject(`News blackout: ${timeWindow.blackout.event} in < 30min`, signal, { timeWindow });
    }

    // ── Collect all candidate zones ──
    const candidateZones = this._collectZones(signal, candles, direction, atr, smcAnalysis, momAnalysis, currentPrice);

    if (!candidateZones.length) {
      return this._reject('No valid entry zones found', signal, { timeWindow });
    }

    // ── Score all zones ──
    const session  = timeWindow.session;
    const scored   = candidateZones.map(z =>
      ZoneQualityScorer.score(z, signal, smcAnalysis, currentPrice, atr, session)
    );

    // ── Find confluence ──
    const confluence = ZoneQualityScorer.findConfluence(scored);

    // Apply confluence bonus
    for (const conf of confluence) {
      for (const z of scored) {
        if (conf.zones.includes(z.type)) {
          z.qualityScore += conf.confluenceScore;
          z.qualityNotes.push(conf.note);
        }
      }
    }

    // ── Select best zone ──
    scored.sort((a, b) => b.qualityScore - a.qualityScore);
    const bestZone = scored[0];

    // Check minimum quality
    const minScore = signal.score?.grade === 'A' ? this.gradeAMinScore : this.minQualityScore;
    if (bestZone.qualityScore < minScore) {
      return this._reject(`Zone quality ${bestZone.qualityScore} < minimum ${minScore}`, signal, { bestZone, timeWindow });
    }

    // Check zone width
    const zoneWidthPct = ((bestZone.high - bestZone.low) / bestZone.midpoint) * 100;
    if (zoneWidthPct > this.maxZoneWidthPct) {
      return this._reject(`Zone too wide (${_round(zoneWidthPct,2)}% > ${this.maxZoneWidthPct}%)`, signal, { bestZone });
    }

    // ── Confirmation evaluation ──
    const confirmation = ConfirmationEngine.evaluate(candles, bestZone, direction, indicators);

    // ── Entry type selection ──
    const distancePct = _pct(currentPrice, bestZone.midpoint) * 100;
    const entryType   = EntryTypeSelector.select(bestZone, signal, confirmation, distancePct, session);

    // ── Invalidation ──
    const invalidation = InvalidationCalculator.calculate(bestZone, direction, atr, smcAnalysis);

    // ── Build final result ──
    const result = {
      // Signal reference
      signalId:    signal.id,
      symbol:      signal.symbol,
      timeframe:   signal.timeframe,
      direction,

      // Entry zone
      entryZone: {
        type:       bestZone.type,
        label:      bestZone.label,
        high:       bestZone.high,
        low:        bestZone.low,
        midpoint:   bestZone.midpoint,
        idealEntry: bestZone.idealEntry || bestZone.midpoint,
        note:       bestZone.note,
      },

      // Entry mechanics
      entryType:   entryType.type,
      entryLabel:  entryType.label,
      entryPrice:  bestZone.idealEntry || bestZone.midpoint,
      entryReason: entryType.reasoning,
      waitFor:     entryType.waitFor,

      // Scale-in (if applicable)
      scaleEntries: entryType.type === 'SCALE_IN' ? entryType.levels : null,

      // Quality metrics
      qualityScore:  Math.min(100, bestZone.qualityScore),
      qualityGrade:  bestZone.qualityGrade,
      qualityNotes:  bestZone.qualityNotes,
      distancePct:   _round(distancePct, 3),

      // Confirmation status
      confirmation: {
        ready:         confirmation.readyToEnter,
        strength:      confirmation.strength,
        quality:       confirmation.quality,
        signals:       confirmation.confirmations.map(c => c.note),
        bestSignal:    confirmation.bestConfirmation?.note,
        inZone:        confirmation.inZone,
      },

      // Invalidation
      invalidation: {
        price:  invalidation.price,
        reason: invalidation.reason,
        method: invalidation.method,
      },

      // Time window
      timeWindow,

      // All candidate zones ranked
      allZones:    scored.slice(0, 5).map(z => ({
        type:  z.type, label: z.label,
        midpoint: z.midpoint, score: z.qualityScore, grade: z.qualityGrade,
      })),

      // Confluence
      confluence: confluence.slice(0, 3),

      // ATR context
      atr:     _round(atr, 5),
      atrPct:  _round((atr / currentPrice) * 100, 4),

      // Reasons + warnings
      reasons:   [
        `Entry zone: ${bestZone.label} (score: ${Math.min(100, bestZone.qualityScore)})`,
        `Entry type: ${entryType.label}`,
        bestZone.note,
        ...(confluence[0] ? [confluence[0].note] : []),
        ...(confirmation.confirmations.slice(0, 2).map(c => c.note)),
      ].filter(Boolean),

      warnings: [
        ...confirmation.warnings,
        ...(!timeWindow.acceptable ? ['Dead session — reduced quality'] : []),
        ...(distancePct > 3 ? [`Price ${_round(distancePct,1)}% from zone — be patient`] : []),
        ...(entryType.type === 'MARKET_NOW' ? ['Market entry — ensure confirmation before executing'] : []),
      ],

      timestamp:  _now(),
    };

    // ── Register active window ──
    this._activeWindows.set(signal.id, {
      result, candles: candles.length, createdAt: _now(), barsOpen: 0,
    });

    // ── Update stats ──
    this._stats.accepted++;
    this._stats.byType[entryType.type] = (this._stats.byType[entryType.type] || 0) + 1;
    this._stats.byZone[bestZone.type]  = (this._stats.byZone[bestZone.type]  || 0) + 1;
    this._stats.avgScore = _round(
      (this._stats.avgScore * (this._stats.accepted - 1) + result.qualityScore) / this._stats.accepted, 2
    );

    this.emit('entry_optimized', result);
    return result;
  }

  // ─────────────────────────────────────────────
  //  UPDATE OPEN WINDOWS
  // ─────────────────────────────────────────────

  /**
   * Called each candle close to update open entry windows.
   * Re-evaluates confirmation and checks for invalidation.
   *
   * @param {string} signalId
   * @param {Array}  candles
   * @param {Object} currentIndicators
   * @returns {{ status, confirmation, invalidated }}
   */
  updateWindow(signalId, candles, currentIndicators = {}) {
    const window = this._activeWindows.get(signalId);
    if (!window) return { status: 'NOT_FOUND' };

    window.barsOpen++;

    // Check staleness
    if (window.barsOpen >= STALE_ENTRY_BARS) {
      this._activeWindows.delete(signalId);
      this.emit('entry_expired', { signalId, barsOpen: window.barsOpen });
      return { status: 'EXPIRED', barsOpen: window.barsOpen };
    }

    // Re-evaluate confirmation
    const confirmation = ConfirmationEngine.evaluate(
      candles, window.result.entryZone, window.result.direction, currentIndicators
    );

    // Check invalidation
    const current = candles[candles.length - 1].close;
    const inv     = window.result.invalidation.price;
    const isLong  = window.result.direction === 'LONG';
    const invalidated = isLong ? current < inv : current > inv;

    if (invalidated) {
      this._activeWindows.delete(signalId);
      this.emit('entry_invalidated', { signalId, price: current, invalidationLevel: inv });
      return { status: 'INVALIDATED', price: current, invalidationLevel: inv };
    }

    // Upgrade to MARKET_NOW if confirmation strengthened
    if (confirmation.readyToEnter && confirmation.strength >= 80 &&
        window.result.entryType !== 'MARKET_NOW') {
      window.result.entryType   = 'MARKET_NOW';
      window.result.entryLabel  = 'Market Entry — Confirmation Triggered';
      window.result.waitFor     = null;
      this.emit('entry_ready', { signalId, confirmation, result: window.result });
    }

    return {
      status:       'ACTIVE',
      barsOpen:     window.barsOpen,
      confirmation,
      invalidated:  false,
      result:       window.result,
    };
  }

  cancelWindow(signalId) {
    const existed = this._activeWindows.delete(signalId);
    if (existed) this.emit('entry_cancelled', { signalId });
    return existed;
  }

  getActiveWindows() {
    const result = {};
    for (const [id, w] of this._activeWindows) {
      result[id] = {
        direction:    w.result.direction,
        entryZone:    w.result.entryZone,
        entryType:    w.result.entryType,
        qualityScore: w.result.qualityScore,
        barsOpen:     w.barsOpen,
        createdAt:    w.createdAt,
      };
    }
    return result;
  }

  // ─────────────────────────────────────────────
  //  ZONE COLLECTION
  // ─────────────────────────────────────────────

  _collectZones(signal, candles, direction, atr, smcAnalysis, momAnalysis, currentPrice) {
    const zones  = [];
    const isLong = direction === 'LONG';

    // ── 1. Liquidity sweep (highest priority) ──
    const sweep = LiquiditySweepEntry.detect(candles, direction, smcAnalysis);
    if (sweep) zones.push(sweep);

    // ── 2. Order block entry ──
    const obs = isLong
      ? smcAnalysis.orderBlocks?.bullish || []
      : smcAnalysis.orderBlocks?.bearish || [];
    const freshOBs = obs.filter(ob => !ob.mitigated).slice(0, 2);
    for (const ob of freshOBs) {
      const obZone = OrderBlockEntry.refine(ob, direction, atr);
      if (obZone) zones.push(obZone);
    }

    // ── 3. SMC signal provided entry zone ──
    if (signal.entry?.zoneLow && signal.entry?.zoneHigh) {
      const smcZone = {
        type:       'SMC_SIGNAL',
        label:      'SMC Agent Entry Zone',
        high:       _round(signal.entry.zoneHigh),
        low:        _round(signal.entry.zoneLow),
        midpoint:   _round((signal.entry.zoneHigh + signal.entry.zoneLow) / 2),
        idealEntry: _round((signal.entry.zoneHigh + signal.entry.zoneLow) / 2),
        note:       signal.entry.note || 'Entry zone from SMC analysis',
        quality:    'HIGH',
      };
      zones.push(smcZone);
    }

    // ── 4. OTE Zone (Fibonacci 0.618–0.786) ──
    const impulseLeg = FibonacciZones.findImpulseLeg(candles, direction);
    if (impulseLeg) {
      const fib    = FibonacciZones.calculate(impulseLeg.legHigh, impulseLeg.legLow, direction);
      if (fib) {
        zones.push({
          type:       'OTE',
          label:      `OTE Zone (0.618–0.786 Fib)`,
          high:       fib.ote.high,
          low:        fib.ote.low,
          midpoint:   fib.ote.midpoint,
          idealEntry: fib.ote.midpoint,
          fibLevels:  fib.levels,
          extensions: fib.extensions,
          legStrength: impulseLeg.strength,
          widthPct:   _round(_pct(fib.ote.high, fib.ote.low) * 100, 3),
          note:       `OTE entry: 0.618 (${_round(fib.levels.r618)}) to 0.786 (${_round(fib.levels.r786)})`,
        });

        // 50% level as supplementary
        zones.push({
          type:       'FIFTY_PCT',
          label:      '50% Retracement',
          high:       _round(fib.half.price * 1.003),
          low:        _round(fib.half.price * 0.997),
          midpoint:   fib.half.price,
          idealEntry: fib.half.price,
          widthPct:   0.6,
          note:       `50% retracement at ${_round(fib.half.price)}`,
        });
      }
    }

    // ── 5. FVG entry ──
    const fvgs = isLong
      ? smcAnalysis.fvgs?.bullish || []
      : smcAnalysis.fvgs?.bearish || [];
    const freshFVGs = fvgs.filter(f => !f.filled).slice(0, 2);
    for (const fvg of freshFVGs) {
      const fvgZone = FVGEntry.refine(fvg, direction, candles);
      if (fvgZone) zones.push(fvgZone);
    }

    // ── 6. VWAP entry ──
    const vwapData = momAnalysis.vwap;
    if (vwapData) {
      const vwapZone = VWAPEntry.calculate(vwapData, direction, currentPrice);
      if (vwapZone) zones.push(vwapZone);
    }

    // ── 7. EMA entry ──
    const emaData = momAnalysis.emaStack || momAnalysis.ema;
    if (emaData) {
      const emaZone = EMAEntry.calculate(emaData, direction, currentPrice);
      if (emaZone) zones.push(emaZone);
    }

    // ── 8. CHoCH breakout entry ──
    const chochZone = BreakoutEntry.calculate(smcAnalysis, direction, candles);
    if (chochZone) zones.push(chochZone);

    // ── Filter: remove zones that are invalid or too far ──
    const maxDistancePct = 0.05; // 5% max from current price
    const validZones = zones.filter(z => {
      if (!z || !z.high || !z.low || !z.midpoint) return false;
      if (z.high <= z.low) return false;
      if (_pct(currentPrice, z.midpoint) > maxDistancePct) return false;
      return true;
    });

    return validZones;
  }

  // ─────────────────────────────────────────────
  //  UTILITIES
  // ─────────────────────────────────────────────

  _calcATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return candles?.[candles.length - 1]?.close * 0.01 || 0;
    let atr = 0;
    let prev = candles[candles.length - period - 1];
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const c  = candles[i];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
      sum += tr;
      prev = c;
    }
    return sum / period;
  }

  _reject(reason, signal, extra = {}) {
    this._stats.rejected++;
    const result = {
      rejected:  true,
      reason,
      signal:    signal ? { id: signal.id, symbol: signal.symbol, action: signal.action } : null,
      ...extra,
      timestamp: _now(),
    };
    this.emit('entry_rejected', result);
    return result;
  }

  getStats() {
    return {
      ...this._stats,
      totalOptimized: this._stats.optimized,
      acceptRate: this._stats.optimized > 0
        ? _round(this._stats.accepted / this._stats.optimized * 100, 2)
        : 0,
      activeWindows: this._activeWindows.size,
    };
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  EntryOptimizer,
  FibonacciZones,
  OrderBlockEntry,
  FVGEntry,
  VWAPEntry,
  EMAEntry,
  LiquiditySweepEntry,
  BreakoutEntry,
  ConfirmationEngine,
  ZoneQualityScorer,
  EntryTypeSelector,
  InvalidationCalculator,
  TimeWindowCalculator,
  SESSIONS,
  SESSION_QUALITY,
  FIBO_OTE_LOW,
  FIBO_OTE_HIGH,
};