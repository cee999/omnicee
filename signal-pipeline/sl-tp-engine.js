/**
 * ============================================================
 *  SL/TP ENGINE — Structure-Based Stop Loss + ATR Trailing
 *  AI Trading Assistant · Layer 6 · Signal Pipeline
 * ============================================================
 *
 *  Responsibilities:
 *    - Structure-based SL placement (below OB low / above swing)
 *    - ATR-based SL as fallback + minimum buffer
 *    - Multi-target TP calculation (TP1 1.5R, TP2 3R, TP3 5R)
 *    - OTE / liquidity pool targeting (EQH/EQL)
 *    - Partial close management plan (50% at TP1, trail rest)
 *    - Trailing stop logic (ATR × multiplier, structure-based)
 *    - Breakeven trigger (move SL to entry after TP1)
 *    - R-multiple calculator
 *    - Position lifecycle tracker (entry → TP1 → trail → close)
 *
 *  Input:  signal from smc-agent + scorer + risk-engine position size
 *  Output: complete trade plan with all SL/TP levels + management rules
 *
 *  Usage:
 *    const { SLTPEngine } = require('./sl-tp-engine');
 *    const engine = new SLTPEngine();
 *    const plan = engine.calculate(signal, candles, positionSize);
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

// ATR period for volatility-based levels
const ATR_PERIOD = 14;

// Default RR targets
const RR_TP1 = 1.5;
const RR_TP2 = 3.0;
const RR_TP3 = 5.0;

// ATR multipliers
const ATR_SL_MULT     = 1.5;   // SL = entry ± ATR × 1.5
const ATR_TRAIL_MULT  = 2.0;   // Trailing stop = ATR × 2.0 behind price
const ATR_MIN_BUFFER  = 0.5;   // Min buffer from structure = ATR × 0.5

// Breakeven trigger: move SL to entry when this % in profit
const BE_TRIGGER_PCT = 0.5;   // 50% of way to TP1

// Partial close plan
const PARTIAL_CLOSE_PLAN = [
  { atTP: 1, closePct: 0.50, moveSLTo: 'BREAKEVEN', note: 'Close 50% at TP1, move SL to breakeven' },
  { atTP: 2, closePct: 0.30, moveSLTo: 'TP1',       note: 'Close 30% at TP2, trail stop to TP1'   },
  { atTP: 3, closePct: 0.20, moveSLTo: 'TRAIL',     note: 'Close 20% at TP3, let remaining trail'  },
];

// ─────────────────────────────────────────────
//  ATR CALCULATOR
// ─────────────────────────────────────────────

class ATRCalculator {
  /**
   * Calculates Average True Range over N periods.
   * True Range = max of:
   *   - current high - current low
   *   - |current high - previous close|
   *   - |current low  - previous close|
   *
   * @param {Array}  candles  - OHLCV array oldest-first
   * @param {number} period   - ATR period (default 14)
   * @returns {number} ATR value
   */
  static calculate(candles, period = ATR_PERIOD) {
    if (candles.length < period + 1) {
      // Fallback: simple high-low average
      const recent = candles.slice(-10);
      return recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length;
    }

    const trValues = [];

    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];

      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low  - prev.close)
      );
      trValues.push(tr);
    }

    // Wilder smoothed ATR
    const initial = trValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
    let atr = initial;

    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return atr;
  }

  /**
   * Returns ATR history (array of ATR values) for the last N candles.
   * Useful for dynamic trailing stop calculations.
   */
  static history(candles, period = ATR_PERIOD, lookback = 20) {
    const result = [];
    const start  = Math.max(period + 1, candles.length - lookback);

    for (let end = start; end <= candles.length; end++) {
      result.push(ATRCalculator.calculate(candles.slice(0, end), period));
    }

    return result;
  }
}

// ─────────────────────────────────────────────
//  STRUCTURE LEVEL FINDER
// ─────────────────────────────────────────────

class StructureLevelFinder {
  /**
   * Finds the most recent significant swing low (for long SL placement).
   * Significant = a swing low that was not immediately violated.
   *
   * @param {Array}  candles
   * @param {number} strength - pivot lookback (default 3)
   * @param {number} lookback - how many candles back to scan
   * @returns {number|null} structure low price
   */
  static findSwingLow(candles, strength = 3, lookback = 30) {
    const scan = candles.slice(-lookback);
    const lows = [];

    for (let i = strength; i < scan.length - strength; i++) {
      const window  = scan.slice(i - strength, i + strength + 1);
      const current = scan[i];
      if (window.every(c => c.low >= current.low)) {
        lows.push({ price: current.low, index: i, timestamp: current.timestamp });
      }
    }

    // Return the most recent swing low
    return lows.length > 0 ? lows[lows.length - 1].price : null;
  }

  /**
   * Finds the most recent significant swing high (for short SL placement).
   */
  static findSwingHigh(candles, strength = 3, lookback = 30) {
    const scan  = candles.slice(-lookback);
    const highs = [];

    for (let i = strength; i < scan.length - strength; i++) {
      const window  = scan.slice(i - strength, i + strength + 1);
      const current = scan[i];
      if (window.every(c => c.high <= current.high)) {
        highs.push({ price: current.high, index: i, timestamp: current.timestamp });
      }
    }

    return highs.length > 0 ? highs[highs.length - 1].price : null;
  }

  /**
   * Find nearest liquidity pool above/below price.
   * These become TP magnets (price tends to gravitate to liquidity).
   *
   * @param {Array}  candles
   * @param {number} currentPrice
   * @param {string} direction - 'LONG' or 'SHORT'
   * @returns {{ pools: Array }}
   */
  static findLiquidityPools(candles, currentPrice, direction) {
    const scan   = candles.slice(-100);
    const pools  = [];

    // Equal highs / equal lows (within 0.05%)
    const tolerance = 0.0005;
    const isLong    = direction === 'LONG';

    const swingPoints = [];
    const strength = 3;

    for (let i = strength; i < scan.length - strength; i++) {
      const window = scan.slice(i - strength, i + strength + 1);
      const c      = scan[i];

      if (isLong) {
        // Look for equal highs ABOVE current price (buy-side liquidity)
        if (c.high > currentPrice && window.every(x => x.high <= c.high)) {
          swingPoints.push(c.high);
        }
      } else {
        // Look for equal lows BELOW current price (sell-side liquidity)
        if (c.low < currentPrice && window.every(x => x.low >= c.low)) {
          swingPoints.push(c.low);
        }
      }
    }

    // Sort and find clusters
    swingPoints.sort((a, b) => isLong ? a - b : b - a);

    let clustered = [];
    for (let i = 0; i < swingPoints.length; i++) {
      if (i === 0) {
        clustered.push([swingPoints[i]]);
        continue;
      }
      const last = clustered[clustered.length - 1];
      const avg  = last.reduce((s, v) => s + v, 0) / last.length;
      if (Math.abs(swingPoints[i] - avg) / avg <= tolerance * 3) {
        last.push(swingPoints[i]);
      } else {
        clustered.push([swingPoints[i]]);
      }
    }

    for (const cluster of clustered.slice(0, 5)) {
      const avg   = cluster.reduce((s, v) => s + v, 0) / cluster.length;
      const count = cluster.length;
      pools.push({
        price:    _round(avg),
        count,
        strength: count >= 3 ? 'STRONG' : count >= 2 ? 'MEDIUM' : 'WEAK',
        note:     `${count} touch${count > 1 ? 'es' : ''} — ${isLong ? 'buy-side' : 'sell-side'} liquidity`,
      });
    }

    return pools;
  }
}

// ─────────────────────────────────────────────
//  STOP LOSS CALCULATOR
// ─────────────────────────────────────────────

class StopLossCalculator {
  /**
   * Calculates structure-based stop loss with ATR buffer.
   *
   * Priority:
   *   1. Below OB low (if OB provided) — tightest, most precise
   *   2. Below swing low (last significant structure)
   *   3. ATR × 1.5 fallback
   *
   * @param {Object} params
   * @param {string} params.direction   - 'LONG' or 'SHORT'
   * @param {number} params.entryPrice
   * @param {number} params.atr
   * @param {Array}  params.candles
   * @param {Object} [params.orderBlock] - OB from SMC agent
   * @param {Object} [params.smcSignal]  - full signal from smc-agent
   * @returns {Object} stopLoss
   */
  static calculate({ direction, entryPrice, atr, candles, orderBlock, smcSignal }) {
    const isLong = direction === 'LONG';
    const buffer = atr * ATR_MIN_BUFFER; // minimum clearance beyond structure

    let slPrice   = null;
    let slMethod  = null;
    let slNote    = null;

    // ── Method 1: OB-based (most precise) ──
    if (orderBlock) {
      if (isLong) {
        slPrice  = _round(orderBlock.obLow - buffer);
        slMethod = 'STRUCTURE_OB';
        slNote   = `Below bullish OB low (${orderBlock.obLow}) − ATR buffer`;
      } else {
        slPrice  = _round(orderBlock.obHigh + buffer);
        slMethod = 'STRUCTURE_OB';
        slNote   = `Above bearish OB high (${orderBlock.obHigh}) + ATR buffer`;
      }
    }

    // ── Method 2: Swing structure ──
    if (!slPrice || Math.abs(slPrice - entryPrice) / entryPrice < 0.002) {
      const structureLevel = isLong
        ? StructureLevelFinder.findSwingLow(candles, 3, 30)
        : StructureLevelFinder.findSwingHigh(candles, 3, 30);

      if (structureLevel) {
        const candidate = isLong
          ? _round(structureLevel - buffer)
          : _round(structureLevel + buffer);

        // Only use if it gives meaningful distance from entry
        const dist = Math.abs(candidate - entryPrice) / entryPrice;
        if (dist >= 0.003) {
          slPrice  = candidate;
          slMethod = 'STRUCTURE_SWING';
          slNote   = `Beyond swing ${isLong ? 'low' : 'high'} (${structureLevel}) − ATR buffer`;
        }
      }
    }

    // ── Method 3: ATR fallback ──
    if (!slPrice) {
      slPrice  = isLong
        ? _round(entryPrice - atr * ATR_SL_MULT)
        : _round(entryPrice + atr * ATR_SL_MULT);
      slMethod = 'ATR';
      slNote   = `ATR × ${ATR_SL_MULT} (${_round(atr * ATR_SL_MULT)} points)`;
    }

    // ── Ensure SL is valid (not beyond entry) ──
    if (isLong  && slPrice >= entryPrice) slPrice = _round(entryPrice - atr * ATR_SL_MULT);
    if (!isLong && slPrice <= entryPrice) slPrice = _round(entryPrice + atr * ATR_SL_MULT);

    const riskPoints = Math.abs(entryPrice - slPrice);
    const riskPct    = _round((riskPoints / entryPrice) * 100, 4);

    return {
      price:      slPrice,
      method:     slMethod,
      note:       slNote,
      riskPoints: _round(riskPoints, 5),
      riskPct,
      atrUsed:    _round(atr, 5),
    };
  }

  /**
   * Trailing stop: moves SL up/down as price advances.
   * Uses ATR × multiplier, recalculated each candle.
   *
   * @param {Object} params
   * @param {string} params.direction
   * @param {number} params.currentPrice
   * @param {number} params.currentSL  - existing SL price
   * @param {number} params.atr
   * @param {number} [params.mult]     - ATR multiplier (default 2.0)
   * @returns {{ newSL, moved, delta }}
   */
  static updateTrailing({ direction, currentPrice, currentSL, atr, mult = ATR_TRAIL_MULT }) {
    const isLong = direction === 'LONG';

    const trailLevel = isLong
      ? _round(currentPrice - atr * mult)
      : _round(currentPrice + atr * mult);

    // Only move in the direction of profit
    const shouldMove = isLong
      ? trailLevel > currentSL
      : trailLevel < currentSL;

    const newSL  = shouldMove ? trailLevel : currentSL;
    const delta  = _round(Math.abs(newSL - currentSL), 5);

    return {
      newSL,
      moved:  shouldMove,
      delta,
      method: 'ATR_TRAIL',
      note:   `Trail ${isLong ? 'above' : 'below'} ATR × ${mult}`,
    };
  }
}

// ─────────────────────────────────────────────
//  TAKE PROFIT CALCULATOR
// ─────────────────────────────────────────────

class TakeProfitCalculator {
  /**
   * Calculates TP levels using R-multiples + liquidity pool targeting.
   *
   * Logic:
   *   - TP1 = 1.5R (minimum viable target)
   *   - TP2 = 3.0R OR nearest strong liquidity pool
   *   - TP3 = 5.0R OR second liquidity pool
   *
   * @param {Object} params
   * @param {string} params.direction
   * @param {number} params.entryPrice
   * @param {number} params.slPrice
   * @param {Array}  params.candles
   * @param {Object} [params.smcAnalysis] - full smc-agent analysis
   * @returns {Object} targets
   */
  static calculate({ direction, entryPrice, slPrice, candles, smcAnalysis }) {
    const isLong    = direction === 'LONG';
    const riskPts   = Math.abs(entryPrice - slPrice);

    // R-based targets
    const r15  = isLong ? entryPrice + riskPts * RR_TP1 : entryPrice - riskPts * RR_TP1;
    const r30  = isLong ? entryPrice + riskPts * RR_TP2 : entryPrice - riskPts * RR_TP2;
    const r50  = isLong ? entryPrice + riskPts * RR_TP3 : entryPrice - riskPts * RR_TP3;

    // Liquidity pool targets (price magnets)
    const pools = StructureLevelFinder.findLiquidityPools(candles, entryPrice, direction);

    // Match liquidity pools to R-targets (use pool if within 20% of R-target)
    const tp1 = _resolveTarget(r15, pools, direction, 1.5, 'TP1: First take profit — close 50% here');
    const tp2 = _resolveTarget(r30, pools, direction, 3.0, 'TP2: Move SL to TP1, let rest run');
    const tp3 = _resolveTarget(r50, pools, direction, 5.0, 'TP3: Extended target — trailing stop only');

    // EQH / EQL from SMC analysis (highest probability targets)
    let smcTarget = null;
    if (smcAnalysis?.equalLevels) {
      const { eqh, eql } = smcAnalysis.equalLevels;
      const relevant      = isLong ? eqh : eql;
      const aboveBelow    = relevant.filter(l =>
        isLong ? l.price > entryPrice : l.price < entryPrice
      );
      if (aboveBelow.length > 0) {
        smcTarget = {
          price:  aboveBelow[0].price,
          note:   `${isLong ? 'EQH' : 'EQL'} liquidity target at ${aboveBelow[0].price}`,
          type:   isLong ? 'EQH_TARGET' : 'EQL_TARGET',
        };
      }
    }

    return {
      tp1: {
        price:    _round(tp1.price),
        rr:       _round(Math.abs(tp1.price - entryPrice) / riskPts, 2),
        method:   tp1.method,
        closePct: 50,
        action:   'CLOSE_50_PERCENT + MOVE_SL_TO_BREAKEVEN',
        note:     tp1.note,
      },
      tp2: {
        price:    _round(tp2.price),
        rr:       _round(Math.abs(tp2.price - entryPrice) / riskPts, 2),
        method:   tp2.method,
        closePct: 30,
        action:   'CLOSE_30_PERCENT + MOVE_SL_TO_TP1',
        note:     tp2.note,
      },
      tp3: {
        price:    _round(tp3.price),
        rr:       _round(Math.abs(tp3.price - entryPrice) / riskPts, 2),
        method:   tp3.method,
        closePct: 20,
        action:   'CLOSE_REMAINING + TRAIL',
        note:     tp3.note,
      },
      smcLiquidityTarget: smcTarget,
      liquidityPools: pools.slice(0, 3),
      riskPoints: _round(riskPts, 5),
    };
  }
}

// ─────────────────────────────────────────────
//  BREAKEVEN MANAGER
// ─────────────────────────────────────────────

class BreakevenManager {
  /**
   * Determines if SL should be moved to breakeven.
   * Triggers when price has moved BE_TRIGGER_PCT toward TP1.
   *
   * @param {Object} params
   * @param {string} params.direction
   * @param {number} params.currentPrice
   * @param {number} params.entryPrice
   * @param {number} params.tp1Price
   * @param {number} params.currentSL
   * @param {boolean} params.beAlreadyMoved
   * @returns {{ shouldMove, newSL, reason }}
   */
  static check({ direction, currentPrice, entryPrice, tp1Price, currentSL, beAlreadyMoved }) {
    if (beAlreadyMoved) {
      return { shouldMove: false, newSL: currentSL, reason: 'BE already set' };
    }

    const isLong       = direction === 'LONG';
    const totalDist    = Math.abs(tp1Price - entryPrice);
    const priceMoved   = isLong
      ? currentPrice - entryPrice
      : entryPrice - currentPrice;

    const pctToTP1     = priceMoved / totalDist;

    if (pctToTP1 >= BE_TRIGGER_PCT) {
      const bePrice  = _round(entryPrice);
      const alreadyBE = isLong ? currentSL >= bePrice : currentSL <= bePrice;

      return {
        shouldMove: !alreadyBE,
        newSL:      bePrice,
        pctToTP1:   _round(pctToTP1 * 100, 1),
        reason:     `Price ${(pctToTP1 * 100).toFixed(0)}% toward TP1 — move SL to breakeven`,
      };
    }

    return {
      shouldMove: false,
      newSL:      currentSL,
      pctToTP1:   _round(pctToTP1 * 100, 1),
      reason:     `${((1 - pctToTP1) * 100).toFixed(0)}% more needed to trigger BE`,
    };
  }
}

// ─────────────────────────────────────────────
//  POSITION LIFECYCLE TRACKER
// ─────────────────────────────────────────────

class PositionLifecycle {
  /**
   * Tracks the state of an open trade through its lifecycle.
   * States: PENDING → ENTERED → TP1_HIT → TP2_HIT → TP3_HIT/CLOSED
   *
   * @param {Object} plan - full trade plan from SLTPEngine
   */
  constructor(plan) {
    this.plan       = plan;
    this.state      = 'PENDING';
    this.currentSL  = plan.stopLoss.price;
    this.entryPrice = null;
    this.openTime   = null;
    this.tp1Hit     = false;
    this.tp2Hit     = false;
    this.beSet      = false;
    this.sizeRemaining = 1.0; // as fraction of original size (1.0 = 100%)
    this.log        = [];
    this.pnlR       = 0;
  }

  /**
   * Update the lifecycle with current price action.
   * Returns actions to execute.
   *
   * @param {number} currentPrice
   * @param {number} atr - current ATR
   * @returns {Array} actions
   */
  update(currentPrice, atr) {
    const actions  = [];
    const isLong   = this.plan.direction === 'LONG';

    if (this.state === 'PENDING') {
      const inZone = isLong
        ? currentPrice <= this.plan.entry.zoneHigh && currentPrice >= this.plan.entry.zoneLow
        : currentPrice >= this.plan.entry.zoneLow  && currentPrice <= this.plan.entry.zoneHigh;

      if (inZone) {
        this.state      = 'ENTERED';
        this.entryPrice = currentPrice;
        this.openTime   = Date.now();
        actions.push({ type: 'ENTER', price: currentPrice, note: 'Price entered trade zone' });
        this._log('ENTERED', currentPrice);
      }
      return actions;
    }

    if (this.state === 'CLOSED') return actions;

    const riskPts = Math.abs(this.entryPrice - this.currentSL);

    // ── SL Hit ──
    const slHit = isLong ? currentPrice <= this.currentSL : currentPrice >= this.currentSL;
    if (slHit) {
      this.pnlR  = _round(isLong
        ? (this.currentSL - this.entryPrice) / riskPts
        : (this.entryPrice - this.currentSL) / riskPts, 2);
      this.state = 'CLOSED';
      actions.push({
        type: 'STOP_HIT',
        price: this.currentSL,
        pnlR: this.pnlR,
        note: `SL hit at ${this.currentSL} — ${this.pnlR}R`,
      });
      this._log('SL_HIT', currentPrice);
      return actions;
    }

    // ── TP1 Hit ──
    if (!this.tp1Hit) {
      const tp1Hit = isLong
        ? currentPrice >= this.plan.targets.tp1.price
        : currentPrice <= this.plan.targets.tp1.price;

      if (tp1Hit) {
        this.tp1Hit = true;
        this.state  = 'TP1_HIT';
        this.sizeRemaining -= 0.50;

        // Move SL to breakeven
        this.currentSL = this.entryPrice;
        this.beSet = true;

        actions.push({
          type:      'TP1_HIT',
          price:     this.plan.targets.tp1.price,
          closePct:  50,
          newSL:     this.entryPrice,
          remaining: this.sizeRemaining,
          note:      'TP1 hit — close 50%, SL → breakeven',
        });
        this._log('TP1_HIT', currentPrice);
      }
    }

    // ── TP2 Hit ──
    if (this.tp1Hit && !this.tp2Hit) {
      const tp2Hit = isLong
        ? currentPrice >= this.plan.targets.tp2.price
        : currentPrice <= this.plan.targets.tp2.price;

      if (tp2Hit) {
        this.tp2Hit = true;
        this.state  = 'TP2_HIT';
        this.sizeRemaining -= 0.30;
        this.currentSL = this.plan.targets.tp1.price;

        actions.push({
          type:      'TP2_HIT',
          price:     this.plan.targets.tp2.price,
          closePct:  30,
          newSL:     this.plan.targets.tp1.price,
          remaining: this.sizeRemaining,
          note:      'TP2 hit — close 30%, SL → TP1 price',
        });
        this._log('TP2_HIT', currentPrice);
      }
    }

    // ── TP3 Hit ──
    if (this.tp2Hit) {
      const tp3Hit = isLong
        ? currentPrice >= this.plan.targets.tp3.price
        : currentPrice <= this.plan.targets.tp3.price;

      if (tp3Hit) {
        this.sizeRemaining = 0;
        this.state = 'CLOSED';
        actions.push({
          type:     'TP3_HIT',
          price:    this.plan.targets.tp3.price,
          closePct: 20,
          note:     'TP3 hit — close remaining position',
        });
        this._log('TP3_HIT', currentPrice);
        return actions;
      }

      // Trail the remaining position
      if (atr) {
        const trail = StopLossCalculator.updateTrailing({
          direction:    this.plan.direction,
          currentPrice,
          currentSL:    this.currentSL,
          atr,
        });

        if (trail.moved) {
          this.currentSL = trail.newSL;
          actions.push({
            type:   'TRAIL_UPDATED',
            newSL:  trail.newSL,
            delta:  trail.delta,
            note:   `Trailing stop moved to ${trail.newSL}`,
          });
        }
      }
    }

    // ── Breakeven check (before TP1 if not yet set) ──
    if (!this.beSet && this.tp1Hit === false) {
      const be = BreakevenManager.check({
        direction:     this.plan.direction,
        currentPrice,
        entryPrice:    this.entryPrice,
        tp1Price:      this.plan.targets.tp1.price,
        currentSL:     this.currentSL,
        beAlreadyMoved: this.beSet,
      });

      if (be.shouldMove) {
        this.currentSL = be.newSL;
        this.beSet = true;
        actions.push({
          type:  'BREAKEVEN_SET',
          newSL: be.newSL,
          note:  be.reason,
        });
      }
    }

    // Update PnL in R
    this.pnlR = _round(isLong
      ? (currentPrice - this.entryPrice) / riskPts
      : (this.entryPrice - currentPrice) / riskPts, 2);

    return actions;
  }

  _log(event, price) {
    this.log.push({ event, price, timestamp: Date.now(), state: this.state });
  }

  getStatus() {
    return {
      state:         this.state,
      currentSL:     this.currentSL,
      entryPrice:    this.entryPrice,
      sizeRemaining: this.sizeRemaining,
      beSet:         this.beSet,
      tp1Hit:        this.tp1Hit,
      tp2Hit:        this.tp2Hit,
      pnlR:          this.pnlR,
      log:           this.log,
    };
  }
}

// ─────────────────────────────────────────────
//  MAIN SL/TP ENGINE
// ─────────────────────────────────────────────

class SLTPEngine extends EventEmitter {
  /**
   * @param {Object} config
   * @param {number} config.atrPeriod      - ATR period (default 14)
   * @param {number} config.atrSLMult      - ATR multiplier for SL (default 1.5)
   * @param {number} config.atrTrailMult   - ATR multiplier for trail (default 2.0)
   * @param {number} config.minRR          - minimum RR to accept trade (default 1.5)
   * @param {boolean} config.useStructure  - use structure-based SL (default true)
   */
  constructor(config = {}) {
    super();
    this.atrPeriod    = config.atrPeriod    || ATR_PERIOD;
    this.atrSLMult    = config.atrSLMult    || ATR_SL_MULT;
    this.atrTrailMult = config.atrTrailMult || ATR_TRAIL_MULT;
    this.minRR        = config.minRR        || 1.5;
    this.useStructure = config.useStructure !== false;

    // Active position trackers: signalId → PositionLifecycle
    this._positions   = new Map();
  }

  // ─────────────────────────────────────────────
  //  MAIN CALCULATE FUNCTION
  // ─────────────────────────────────────────────

  /**
   * Takes a raw signal and candle data and returns a complete trade plan.
   * This is the primary function called after signal-scorer fires a signal.
   *
   * @param {Object} signal   - from signal-scorer or smc-agent
   * @param {Array}  candles  - OHLCV history
   * @param {Object} [options]
   * @param {number} [options.positionSize]   - units/contracts
   * @param {number} [options.accountBalance] - for $ risk display
   * @param {number} [options.riskPct]        - risk per trade %
   * @returns {Object} completeTradePlan
   */
  calculate(signal, candles, options = {}) {
    if (!signal || !candles || candles.length < 20) {
      return { error: 'Invalid input — need signal + candles', plan: null };
    }

    const { positionSize, accountBalance, riskPct } = options;
    const direction  = signal.action || signal.direction;
    const isLong     = direction === 'LONG';

    if (direction === 'WAIT') {
      return { error: 'Signal is WAIT — no trade plan needed', plan: null };
    }

    // ── Calculate ATR ──
    const atr       = ATRCalculator.calculate(candles, this.atrPeriod);
    const atrPct    = _round((atr / candles[candles.length - 1].close) * 100, 4);
    const atrHistory = ATRCalculator.history(candles, this.atrPeriod, 20);
    const atrTrend  = this._classifyATRTrend(atrHistory);

    // ── Determine Entry Price ──
    const entryZoneHigh = signal.entry?.zoneHigh || candles[candles.length - 1].close;
    const entryZoneLow  = signal.entry?.zoneLow  || candles[candles.length - 1].close;
    const entryPrice    = isLong
      ? _round((entryZoneHigh + entryZoneLow) / 2) // mid of zone
      : _round((entryZoneHigh + entryZoneLow) / 2);

    // ── Calculate Stop Loss ──
    const orderBlock = isLong
      ? signal.analysis?.orderBlocks?.bullish?.[0] || signal.agentVotes?.smc?.analysis?.orderBlocks?.bullish?.[0]
      : signal.analysis?.orderBlocks?.bearish?.[0] || signal.agentVotes?.smc?.analysis?.orderBlocks?.bearish?.[0];

    const stopLoss = StopLossCalculator.calculate({
      direction,
      entryPrice,
      atr,
      candles,
      orderBlock: this.useStructure ? orderBlock : null,
      smcSignal:  signal,
    });

    // ── Override with SMC-provided SL if better ──
    if (signal.stopLoss?.price) {
      const smcSLDist  = Math.abs(signal.stopLoss.price - entryPrice);
      const calcSLDist = Math.abs(stopLoss.price - entryPrice);

      // Use SMC SL if it's tighter and still valid
      if (smcSLDist < calcSLDist && smcSLDist >= atr * 0.5) {
        stopLoss.price   = signal.stopLoss.price;
        stopLoss.method  = 'SMC_PROVIDED';
        stopLoss.note    = signal.stopLoss.note || 'Structure-based from SMC agent';
      }
    }

    // ── Calculate Take Profits ──
    const targets = TakeProfitCalculator.calculate({
      direction,
      entryPrice,
      slPrice:     stopLoss.price,
      candles,
      smcAnalysis: signal.analysis || signal.agentVotes?.smc?.analysis,
    });

    // ── Validate Minimum RR ──
    const actualRR = targets.tp1.rr;
    if (actualRR < this.minRR) {
      return {
        error:  `Insufficient RR: ${actualRR} < minimum ${this.minRR}`,
        plan:   null,
        targets,
        stopLoss,
      };
    }

    // ── Build Management Rules ──
    const management = this._buildManagementRules(direction, entryPrice, stopLoss.price, targets, atr);

    // ── Dollar Risk Calculation ──
    const dollarRisk = accountBalance && riskPct
      ? _round(accountBalance * (riskPct / 100), 2)
      : null;

    // ── Assemble Complete Trade Plan ──
    const plan = {
      // Identity
      signalId:   signal.id || signal.signalId || `SL_${Date.now()}`,
      symbol:     signal.symbol,
      timeframe:  signal.timeframe,
      direction,
      generatedAt: new Date().toISOString(),

      // Entry
      entry: {
        zoneHigh:   _round(entryZoneHigh),
        zoneLow:    _round(entryZoneLow),
        midPoint:   entryPrice,
        type:       signal.entry?.type || 'ZONE',
        note:       signal.entry?.note || 'Wait for price to enter zone before entering',
      },

      // Stop Loss
      stopLoss: {
        price:      stopLoss.price,
        method:     stopLoss.method,
        riskPoints: stopLoss.riskPoints,
        riskPct:    stopLoss.riskPct,
        atrUsed:    stopLoss.atrUsed,
        note:       stopLoss.note,
      },

      // Take Profit Targets
      targets,

      // Trade Management
      management,

      // Risk Parameters
      risk: {
        atr:          _round(atr, 5),
        atrPct,
        atrTrend,
        riskPoints:   stopLoss.riskPoints,
        riskPct:      stopLoss.riskPct,
        dollarRisk,
        positionSize: positionSize || null,
        partialClose: PARTIAL_CLOSE_PLAN,
      },

      // Market Context
      marketContext: {
        currentPrice:  candles[candles.length - 1].close,
        atr,
        atrPct,
        volatilityLabel: atrPct < 0.3 ? 'LOW' : atrPct < 0.8 ? 'MEDIUM' : 'HIGH',
        liquidityPools:  targets.liquidityPools,
        smcLiquidityTarget: targets.smcLiquidityTarget,
      },
    };

    this.emit('plan_generated', plan);
    return { plan, error: null };
  }

  // ─────────────────────────────────────────────
  //  POSITION LIFECYCLE
  // ─────────────────────────────────────────────

  /**
   * Register a new open position for lifecycle tracking.
   *
   * @param {string} signalId
   * @param {Object} plan  - from calculate()
   * @returns {PositionLifecycle}
   */
  openPosition(signalId, plan) {
    const lifecycle = new PositionLifecycle(plan);
    this._positions.set(signalId, lifecycle);
    return lifecycle;
  }

  /**
   * Update all open positions with current price.
   * Emits actions (TP_HIT, TRAIL_UPDATED, etc.) for executor.
   *
   * @param {number} currentPrice
   * @param {number} atr
   * @returns {Map} signalId → actions
   */
  updatePositions(currentPrice, atr) {
    const results = new Map();

    for (const [id, lifecycle] of this._positions) {
      const actions = lifecycle.update(currentPrice, atr);
      if (actions.length > 0) {
        results.set(id, actions);
        this.emit('position_actions', { signalId: id, actions, status: lifecycle.getStatus() });
      }

      // Clean up closed positions
      if (lifecycle.state === 'CLOSED') {
        this.emit('position_closed', { signalId: id, status: lifecycle.getStatus() });
        this._positions.delete(id);
      }
    }

    return results;
  }

  getPosition(signalId) {
    return this._positions.get(signalId) || null;
  }

  // ─────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────

  _buildManagementRules(direction, entryPrice, slPrice, targets, atr) {
    const isLong = direction === 'LONG';
    const r      = Math.abs(entryPrice - slPrice);

    return {
      // Entry rules
      entry: [
        `Set LIMIT order at entry zone (${isLong ? targets.tp1.price > entryPrice ? 'zone high' : 'zone low' : 'zone'}), do NOT market chase`,
        `Invalidate setup if price closes ${isLong ? 'below' : 'above'} the zone before filling`,
      ],

      // After entry
      afterEntry: [
        `Initial SL: ${slPrice} — ${isLong ? 'below' : 'above'} structure`,
        `Do NOT move SL further against the trade`,
        `Set TP1 limit at ${targets.tp1.price} immediately after entry`,
      ],

      // After TP1
      afterTP1: [
        `Close 50% of position at TP1 (${targets.tp1.price})`,
        `Move SL to breakeven (${entryPrice}) immediately`,
        `Set TP2 limit at ${targets.tp2.price}`,
        `This trade is now risk-free on remaining size`,
      ],

      // After TP2
      afterTP2: [
        `Close 30% more at TP2 (${targets.tp2.price})`,
        `Move SL to TP1 price (${targets.tp1.price}) to lock in profits`,
        `Let remaining 20% trail with ATR × ${ATR_TRAIL_MULT}`,
        `Set TP3 target at ${targets.tp3.price}`,
      ],

      // Invalidation
      invalidation: [
        `Signal INVALID if price closes ${isLong ? 'below' : 'above'} ${slPrice}`,
        `Re-evaluate if new CHoCH forms against direction`,
        `Exit immediately if HTF bias flips against trade`,
      ],

      // Quick summary
      summary: `Enter at zone → SL at ${slPrice} → Close 50% at ${targets.tp1.price} (${targets.tp1.rr}R) → trail rest`,
    };
  }

  _classifyATRTrend(atrHistory) {
    if (atrHistory.length < 5) return 'UNKNOWN';
    const recent  = atrHistory.slice(-5);
    const older   = atrHistory.slice(-10, -5);
    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const olderAvg  = older.length > 0
      ? older.reduce((s, v) => s + v, 0) / older.length
      : recentAvg;

    const change = (recentAvg - olderAvg) / olderAvg;
    if (change > 0.15) return 'EXPANDING'; // volatility increasing
    if (change < -0.15) return 'CONTRACTING'; // volatility decreasing
    return 'STABLE';
  }
}

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────

function _round(n, decimals = 5) {
  return parseFloat(n.toFixed(decimals));
}

function _resolveTarget(rTarget, pools, direction, rrLabel, defaultNote) {
  const isLong = direction === 'LONG';

  // Find a liquidity pool within 20% of the R-target
  const nearby = pools.filter(p => {
    const dist = Math.abs(p.price - rTarget) / rTarget;
    return dist <= 0.20 && (isLong ? p.price > rTarget * 0.9 : p.price < rTarget * 1.1);
  });

  if (nearby.length > 0) {
    const best = nearby.reduce((a, b) => b.count > a.count ? b : a);
    return {
      price:  best.price,
      method: 'LIQUIDITY_POOL',
      note:   `${rrLabel}R — ${best.note}`,
    };
  }

  return {
    price:  rTarget,
    method: 'R_MULTIPLE',
    note:   defaultNote,
  };
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  SLTPEngine,
  ATRCalculator,
  StopLossCalculator,
  TakeProfitCalculator,
  BreakevenManager,
  PositionLifecycle,
  StructureLevelFinder,
  ATR_PERIOD,
  ATR_SL_MULT,
  ATR_TRAIL_MULT,
  PARTIAL_CLOSE_PLAN,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { SLTPEngine }  = require('./sl-tp-engine');
 *  const { SignalScorer } = require('./signal-scorer');
 *  const { BinanceFeed }  = require('../feeds/binance-ws');
 *
 *  const engine = new SLTPEngine({ minRR: 1.5, useStructure: true });
 *
 *  // After scorer fires a signal:
 *  scorer.on('signal', async (signal) => {
 *    const candles = feed.getCandles(signal.symbol, signal.timeframe);
 *    const { plan, error } = engine.calculate(signal, candles, {
 *      accountBalance: 10000,
 *      riskPct: 1.0,
 *    });
 *
 *    if (error) return console.warn('SL/TP rejected:', error);
 *
 *    console.log('Trade Plan:');
 *    console.log(`  Entry Zone: ${plan.entry.zoneLow} – ${plan.entry.zoneHigh}`);
 *    console.log(`  Stop Loss:  ${plan.stopLoss.price} (${plan.stopLoss.riskPct}%)`);
 *    console.log(`  TP1:        ${plan.targets.tp1.price} (${plan.targets.tp1.rr}R)`);
 *    console.log(`  TP2:        ${plan.targets.tp2.price} (${plan.targets.tp2.rr}R)`);
 *    console.log(`  TP3:        ${plan.targets.tp3.price} (${plan.targets.tp3.rr}R)`);
 *    console.log(plan.management.summary);
 *
 *    // Track the open position
 *    const position = engine.openPosition(signal.id, plan);
 *
 *    // On each new price update:
 *    feed.on('price', ({ symbol, price }) => {
 *      if (symbol !== signal.symbol) return;
 *      const atr = ATRCalculator.calculate(feed.getCandles(symbol, signal.timeframe));
 *      engine.updatePositions(price, atr);
 *    });
 *  });
 *
 *  engine.on('position_actions', ({ signalId, actions }) => {
 *    for (const action of actions) {
 *      console.log(`[${signalId}] ${action.type}: ${action.note}`);
 *      // → pass to alert-dispatcher.js or execution engine
 *    }
 *  });
 * ─────────────────────────────────────────────
 */