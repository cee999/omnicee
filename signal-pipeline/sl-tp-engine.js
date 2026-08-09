
'use strict';

const EventEmitter = require('events');

const ATR_PERIOD = 14;

const RR_TP1 = 1.5;
const RR_TP2 = 3.0;
const RR_TP3 = 5.0;

const ATR_SL_MULT     = 1.5;
const ATR_TRAIL_MULT  = 2.0;
const ATR_MIN_BUFFER  = 0.5;

const BE_TRIGGER_PCT = 0.5;

const PARTIAL_CLOSE_PLAN = [
  { atTP: 1, closePct: 0.50, moveSLTo: 'BREAKEVEN', note: 'Close 50% at TP1, move SL to breakeven' },
  { atTP: 2, closePct: 0.30, moveSLTo: 'TP1',       note: 'Close 30% at TP2, trail stop to TP1'   },
  { atTP: 3, closePct: 0.20, moveSLTo: 'TRAIL',     note: 'Close 20% at TP3, let remaining trail'  },
];

class ATRCalculator {
  static calculate(candles, period = ATR_PERIOD) {
    if (candles.length < period + 1) {
      const recent = candles.slice(-10);
      if (recent.length === 0) return 0;
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

    const initial = trValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
    let atr = initial;

    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return atr;
  }

  static history(candles, period = ATR_PERIOD, lookback = 20) {
    const result = [];
    const start  = Math.max(period + 1, candles.length - lookback);

    for (let end = start; end <= candles.length; end++) {
      result.push(ATRCalculator.calculate(candles.slice(0, end), period));
    }

    return result;
  }
}

class StructureLevelFinder {
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

    return lows.length > 0 ? lows[lows.length - 1].price : null;
  }

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

  static findLiquidityPools(candles, currentPrice, direction) {
    const scan   = candles.slice(-100);
    const pools  = [];

    const tolerance = 0.0005;
    const isLong    = direction === 'LONG';

    const swingPoints = [];
    const strength = 3;

    for (let i = strength; i < scan.length - strength; i++) {
      const window = scan.slice(i - strength, i + strength + 1);
      const c      = scan[i];

      if (isLong) {
        if (c.high > currentPrice && window.every(x => x.high <= c.high)) {
          swingPoints.push(c.high);
        }
      } else {
        if (c.low < currentPrice && window.every(x => x.low >= c.low)) {
          swingPoints.push(c.low);
        }
      }
    }

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

class StopLossCalculator {
  static calculate({ direction, entryPrice, atr, candles, orderBlock, smcSignal }) {
    const isLong = direction === 'LONG';
    const buffer = atr * ATR_MIN_BUFFER;

    let slPrice   = null;
    let slMethod  = null;
    let slNote    = null;

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

    if (!slPrice || Math.abs(slPrice - entryPrice) / entryPrice < 0.002) {
      const structureLevel = isLong
        ? StructureLevelFinder.findSwingLow(candles, 3, 30)
        : StructureLevelFinder.findSwingHigh(candles, 3, 30);

      if (structureLevel) {
        const candidate = isLong
          ? _round(structureLevel - buffer)
          : _round(structureLevel + buffer);

        const dist = Math.abs(candidate - entryPrice) / entryPrice;
        if (dist >= 0.003) {
          slPrice  = candidate;
          slMethod = 'STRUCTURE_SWING';
          slNote   = `Beyond swing ${isLong ? 'low' : 'high'} (${structureLevel}) − ATR buffer`;
        }
      }
    }

    if (!slPrice) {
      slPrice  = isLong
        ? _round(entryPrice - atr * ATR_SL_MULT)
        : _round(entryPrice + atr * ATR_SL_MULT);
      slMethod = 'ATR';
      slNote   = `ATR × ${ATR_SL_MULT} (${_round(atr * ATR_SL_MULT)} points)`;
    }

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

  static updateTrailing({ direction, currentPrice, currentSL, atr, mult = ATR_TRAIL_MULT }) {
    const isLong = direction === 'LONG';

    const trailLevel = isLong
      ? _round(currentPrice - atr * mult)
      : _round(currentPrice + atr * mult);

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

class TakeProfitCalculator {
  static calculate({ direction, entryPrice, slPrice, candles, smcAnalysis }) {
    const isLong    = direction === 'LONG';
    const riskPts   = Math.abs(entryPrice - slPrice);

    const r15  = isLong ? entryPrice + riskPts * RR_TP1 : entryPrice - riskPts * RR_TP1;
    const r30  = isLong ? entryPrice + riskPts * RR_TP2 : entryPrice - riskPts * RR_TP2;
    const r50  = isLong ? entryPrice + riskPts * RR_TP3 : entryPrice - riskPts * RR_TP3;

    const pools = StructureLevelFinder.findLiquidityPools(candles, entryPrice, direction);

    const tp1 = _resolveTarget(r15, pools, direction, 1.5, 'TP1: First take profit — close 50% here');
    const tp2 = _resolveTarget(r30, pools, direction, 3.0, 'TP2: Move SL to TP1, let rest run');
    const tp3 = _resolveTarget(r50, pools, direction, 5.0, 'TP3: Extended target — trailing stop only');

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

class BreakevenManager {
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

class PositionLifecycle {
  constructor(plan) {
    this.plan       = plan;
    this.state      = 'PENDING';
    this.currentSL  = plan.stopLoss.price;
    this.entryPrice = null;
    this.openTime   = null;
    this.tp1Hit     = false;
    this.tp2Hit     = false;
    this.beSet      = false;
    this.sizeRemaining = 1.0;
    this.log        = [];
    this.pnlR       = 0;
    // FIX: riskPts used to be recomputed from entryPrice vs currentSL on every update() call.
    this.initialRiskPts = null;
  }

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
        this.initialRiskPts = Math.abs(this.entryPrice - this.currentSL);
        actions.push({ type: 'ENTER', price: currentPrice, note: 'Price entered trade zone' });
        this._log('ENTERED', currentPrice);
      }
      return actions;
    }

    if (this.state === 'CLOSED') return actions;

    const riskPts = this.initialRiskPts || Math.abs(this.entryPrice - this.currentSL);

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

    if (!this.tp1Hit) {
      const tp1Hit = isLong
        ? currentPrice >= this.plan.targets.tp1.price
        : currentPrice <= this.plan.targets.tp1.price;

      if (tp1Hit) {
        this.tp1Hit = true;
        this.state  = 'TP1_HIT';
        this.sizeRemaining -= 0.50;

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

class SLTPEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.atrPeriod    = config.atrPeriod    || ATR_PERIOD;
    this.atrSLMult    = config.atrSLMult    || ATR_SL_MULT;
    this.atrTrailMult = config.atrTrailMult || ATR_TRAIL_MULT;
    this.minRR        = config.minRR        || 1.5;
    this.useStructure = config.useStructure !== false;

    this._positions   = new Map();
  }

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

    const atr       = ATRCalculator.calculate(candles, this.atrPeriod);
    const atrPct    = _round((atr / candles[candles.length - 1].close) * 100, 4);
    const atrHistory = ATRCalculator.history(candles, this.atrPeriod, 20);
    const atrTrend  = this._classifyATRTrend(atrHistory);

    const entryZoneHigh = signal.entry?.zoneHigh || candles[candles.length - 1].close;
    const entryZoneLow  = signal.entry?.zoneLow  || candles[candles.length - 1].close;
    const entryPrice    = isLong
      ? _round((entryZoneHigh + entryZoneLow) / 2)
      : _round((entryZoneHigh + entryZoneLow) / 2);

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

    if (signal.stopLoss?.price) {
      const smcSLDist  = Math.abs(signal.stopLoss.price - entryPrice);
      const calcSLDist = Math.abs(stopLoss.price - entryPrice);

      if (smcSLDist < calcSLDist && smcSLDist >= atr * 0.5) {
        stopLoss.price   = signal.stopLoss.price;
        stopLoss.method  = 'SMC_PROVIDED';
        stopLoss.note    = signal.stopLoss.note || 'Structure-based from SMC agent';
      }
    }

    const targets = TakeProfitCalculator.calculate({
      direction,
      entryPrice,
      slPrice:     stopLoss.price,
      candles,
      smcAnalysis: signal.analysis || signal.agentVotes?.smc?.analysis,
    });

    const actualRR = targets.tp1.rr;
    if (actualRR < this.minRR) {
      return {
        error:  `Insufficient RR: ${actualRR} < minimum ${this.minRR}`,
        plan:   null,
        targets,
        stopLoss,
      };
    }

    const management = this._buildManagementRules(direction, entryPrice, stopLoss.price, targets, atr);

    const dollarRisk = accountBalance && riskPct
      ? _round(accountBalance * (riskPct / 100), 2)
      : null;

    const plan = {
      signalId:   signal.id || signal.signalId || `SL_${Date.now()}`,
      symbol:     signal.symbol,
      timeframe:  signal.timeframe,
      direction,
      generatedAt: new Date().toISOString(),

      entry: {
        zoneHigh:   _round(entryZoneHigh),
        zoneLow:    _round(entryZoneLow),
        midPoint:   entryPrice,
        type:       signal.entry?.type || 'ZONE',
        note:       signal.entry?.note || 'Wait for price to enter zone before entering',
      },

      stopLoss: {
        price:      stopLoss.price,
        method:     stopLoss.method,
        riskPoints: stopLoss.riskPoints,
        riskPct:    stopLoss.riskPct,
        atrUsed:    stopLoss.atrUsed,
        note:       stopLoss.note,
      },

      targets,

      management,

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

  openPosition(signalId, plan) {
    const lifecycle = new PositionLifecycle(plan);
    this._positions.set(signalId, lifecycle);
    return lifecycle;
  }

  updatePositions(currentPrice, atr) {
    const results = new Map();

    for (const [id, lifecycle] of this._positions) {
      const actions = lifecycle.update(currentPrice, atr);
      if (actions.length > 0) {
        results.set(id, actions);
        this.emit('position_actions', { signalId: id, actions, status: lifecycle.getStatus() });
      }

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

  _buildManagementRules(direction, entryPrice, slPrice, targets, atr) {
    const isLong = direction === 'LONG';
    const r      = Math.abs(entryPrice - slPrice);

    return {
      entry: [
        `Set LIMIT order at entry zone (${isLong ? targets.tp1.price > entryPrice ? 'zone high' : 'zone low' : 'zone'}), do NOT market chase`,
        `Invalidate setup if price closes ${isLong ? 'below' : 'above'} the zone before filling`,
      ],

      afterEntry: [
        `Initial SL: ${slPrice} — ${isLong ? 'below' : 'above'} structure`,
        `Do NOT move SL further against the trade`,
        `Set TP1 limit at ${targets.tp1.price} immediately after entry`,
      ],

      afterTP1: [
        `Close 50% of position at TP1 (${targets.tp1.price})`,
        `Move SL to breakeven (${entryPrice}) immediately`,
        `Set TP2 limit at ${targets.tp2.price}`,
        `This trade is now risk-free on remaining size`,
      ],

      afterTP2: [
        `Close 30% more at TP2 (${targets.tp2.price})`,
        `Move SL to TP1 price (${targets.tp1.price}) to lock in profits`,
        `Let remaining 20% trail with ATR × ${ATR_TRAIL_MULT}`,
        `Set TP3 target at ${targets.tp3.price}`,
      ],

      invalidation: [
        `Signal INVALID if price closes ${isLong ? 'below' : 'above'} ${slPrice}`,
        `Re-evaluate if new CHoCH forms against direction`,
        `Exit immediately if HTF bias flips against trade`,
      ],

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
    if (change > 0.15) return 'EXPANDING';
    if (change < -0.15) return 'CONTRACTING';
    return 'STABLE';
  }
}

function _round(n, decimals = 5) {
  return parseFloat(n.toFixed(decimals));
}

function _resolveTarget(rTarget, pools, direction, rrLabel, defaultNote) {
  const isLong = direction === 'LONG';

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

// note}`); // → pass to alert-dispatcher.js or execution engine } });
