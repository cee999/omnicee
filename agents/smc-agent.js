
'use strict';

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

const MIN_CANDLES = 50;

function bodySize(c) {
  return Math.abs(c.close - c.open);
}

function wickRange(c) {
  return c.high - c.low;
}

function isBullish(c) {
  return c.close > c.open;
}

function isBearish(c) {
  return c.close < c.open;
}

function bodyRatio(c) {
  const range = wickRange(c);
  return range === 0 ? 0 : bodySize(c) / range;
}

function round(n, decimals = 5) {
  return parseFloat(n.toFixed(decimals));
}

function rangesOverlap(high1, low1, high2, low2) {
  return low1 <= high2 && high1 >= low2;
}

function swingHigh(candles) {
  return Math.max(...candles.map(c => c.high));
}

function swingLow(candles) {
  return Math.min(...candles.map(c => c.low));
}

class OrderBlockDetector {
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
        next1.close > c.high &&
        bodyRatio(next1) > 0.5;

      if (!displacement) continue;

      const hasFVG = next2 && next3
        ? next3.low > next1.high
        : false;

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

  static updateStates(obs, currentCandle) {
    const { high, low, close } = currentCandle;

    return obs.map(ob => {
      if (ob.state === ZONE_STATE.MITIGATED) return ob;

      const touched = rangesOverlap(high, low, ob.obHigh, ob.obLow);

      if (!touched) return ob;

      const mitigated = ob.type === 'BULLISH_OB'
        ? close < ob.obLow
        : close > ob.obHigh;

      return {
        ...ob,
        state: mitigated ? ZONE_STATE.MITIGATED : ZONE_STATE.TESTED,
      };
    });
  }

  static getValid(obs) {
    return obs.filter(ob => ob.state !== ZONE_STATE.MITIGATED);
  }
}

class FVGDetector {
  static detect(candles) {
    const fvgs = [];

    for (let i = 0; i < candles.length - 2; i++) {
      const c1 = candles[i];
      const c2 = candles[i + 1];
      const c3 = candles[i + 2];

      if (c3.low > c1.high) {
        const gapSize  = c3.low - c1.high;
        const gapMid   = c1.high + gapSize / 2;
        const ce       = gapMid;

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
          strength:  bodyRatio(c2) > 0.65 ? 'STRONG' : 'STANDARD',
        });
      }

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

  static updateStates(fvgs, currentCandle) {
    const { high, low, close } = currentCandle;

    return fvgs.map(fvg => {
      if (fvg.state === ZONE_STATE.MITIGATED) return fvg;

      const touched = rangesOverlap(high, low, fvg.fvgHigh, fvg.fvgLow);
      if (!touched) return fvg;

      const mitigated = fvg.type === 'BULLISH_FVG'
        ? close < fvg.fvgLow
        : close > fvg.fvgHigh;

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

class MarketStructureDetector {
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

  static detectStructureBreaks(candles, swings) {
    const events  = [];
    const { highs, lows } = swings;

    if (highs.length < 2 || lows.length < 2) return events;

    let trend = STRUCTURE.NEUTRAL;

    const lastTwoHighs = highs.slice(-2);
    const lastTwoLows  = lows.slice(-2);

    if (lastTwoHighs[1].price > lastTwoHighs[0].price &&
        lastTwoLows[1].price  > lastTwoLows[0].price) {
      trend = STRUCTURE.BULLISH;
    } else if (lastTwoHighs[1].price < lastTwoHighs[0].price &&
               lastTwoLows[1].price  < lastTwoLows[0].price) {
      trend = STRUCTURE.BEARISH;
    }

    const recent = candles.slice(-30);

    for (let i = 1; i < recent.length; i++) {
      const c = recent[i];

      const prevHigh = highs.filter(h => h.index < candles.length - 30 + i).slice(-1)[0];
      const prevLow  = lows.filter(l => l.index  < candles.length - 30 + i).slice(-1)[0];

      if (!prevHigh || !prevLow) continue;

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

      if (c.close > prevHigh.price && trend === STRUCTURE.BEARISH) {
        events.push({
          type:      'CHoCH',
          direction: STRUCTURE.BULLISH,
          price:     round(prevHigh.price),
          timestamp: c.timestamp,
          candle:    i,
          note:      'Potential reversal to bullish',
        });
        trend = STRUCTURE.BULLISH;
      }

      if (c.close < prevLow.price && trend === STRUCTURE.BULLISH) {
        events.push({
          type:      'CHoCH',
          direction: STRUCTURE.BEARISH,
          price:     round(prevLow.price),
          timestamp: c.timestamp,
          candle:    i,
          note:      'Potential reversal to bearish',
        });
        trend = STRUCTURE.BEARISH;
      }
    }

    return { events, currentTrend: trend };
  }

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

class LiquidityDetector {
  static detectSweeps(candles, swings) {
    const sweeps = [];
    const { highs, lows } = swings;
    const recent = candles.slice(-20);

    for (let i = 1; i < recent.length; i++) {
      const c = recent[i];

      for (const sh of highs) {
        if (c.high > sh.price && c.close < sh.price) {
          sweeps.push({
            type:        'BSL_SWEEP',
            direction:   'BEARISH',
            sweptLevel:  round(sh.price),
            wickHigh:    round(c.high),
            close:       round(c.close),
            timestamp:   c.timestamp,
            note:        'Buy-side liquidity swept — look for shorts',
            reliability: wickRange(c) > bodySize(c) * 1.5 ? 'HIGH' : 'MEDIUM',
          });
        }
      }

      for (const sl of lows) {
        if (c.low < sl.price && c.close > sl.price) {
          sweeps.push({
            type:        'SSL_SWEEP',
            direction:   'BULLISH',
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

  static detectInducement(candles) {
    const inducements = [];

    for (let i = 2; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const c    = candles[i];
      const next = candles[i + 1];

      if (!next) continue;

      const bullIDM = c.low < prev.low &&
        c.close > prev.low &&
        isBullish(next) &&
        next.close > c.high;

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

class PremiumDiscountCalculator {
  static calculate(swingHigh, swingLow) {
    const range = swingHigh - swingLow;

    return {
      swingHigh:    round(swingHigh),
      swingLow:     round(swingLow),
      equilibrium:  round(swingLow + range * 0.5),

      premium: {
        top:    round(swingHigh),
        bottom: round(swingLow + range * 0.5),
        label:  'PREMIUM — short bias',
      },

      discount: {
        top:    round(swingLow + range * 0.5),
        bottom: round(swingLow),
        label:  'DISCOUNT — long bias',
      },

      ote: {
        fib62:  round(swingHigh - range * 0.62),
        fib705: round(swingHigh - range * 0.705),
        fib79:  round(swingHigh - range * 0.79),
        label:  'OTE — Optimal Trade Entry zone',
      },

      sibi: round(swingLow + range * 0.75),
      bisi: round(swingLow + range * 0.25),
    };
  }

  static pricePosition(currentPrice, swingHigh, swingLow) {
    const range    = swingHigh - swingLow;
    if (range <= 0) return { percentage: 50, zone: 'NEUTRAL', inOTE: false, inOTELong: false, inOTEShort: false };

    const position = (currentPrice - swingLow) / range;

    return {
      percentage: round(position * 100, 2),
      zone: position > 0.5 ? 'PREMIUM' : 'DISCOUNT',
      // FIX: inOTE only ever checked the 62-79% retracement-from-the-HIGH zone (position 0.21-0.38, i.e.
      inOTELong:  position >= 0.21 && position <= 0.38,
      inOTEShort: position >= 0.62 && position <= 0.79,
      inOTE: position >= 0.21 && position <= 0.38,
    };
  }
}

class WyckoffDetector {
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

    const isContracting = rangeSec < rangeFirst * 0.7;

    const lastCandle    = candles[candles.length - 1];
    const rangeStart    = Math.min(firstLowest, secLowest);
    const hasSpring     = secLowest < firstLowest &&
                          lastCandle.close > rangeStart;

    const rangeTop      = Math.max(firstHighest, secHighest);
    const hasUpthrust   = secHighest > firstHighest &&
                          lastCandle.close < rangeTop;

    let phase      = 'PHASE_B';
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

class SMCConfluenceScorer {
  static score(analysis, direction) {
    let score   = 0;
    const reasons = [];

    const isLong = direction === SIGNAL_TYPE.LONG;

    const relevantOBs = isLong
      ? analysis.orderBlocks.bullish.filter(ob => ob.state !== ZONE_STATE.MITIGATED)
      : analysis.orderBlocks.bearish.filter(ob => ob.state !== ZONE_STATE.MITIGATED);

    if (relevantOBs.length > 0) {
      const best = relevantOBs[0];
      score += best.strength === 'STRONG' ? 25 : 15;
      reasons.push(`${best.strength} ${best.type} present`);
    }

    const relevantFVGs = isLong
      ? analysis.fvgs.bullish.filter(f => f.state !== ZONE_STATE.MITIGATED)
      : analysis.fvgs.bearish.filter(f => f.state !== ZONE_STATE.MITIGATED);

    if (relevantFVGs.length > 0) {
      score += relevantFVGs[0].strength === 'STRONG' ? 20 : 12;
      // FIX: was hardcoded to always say "Bullish FVG ...
      reasons.push(isLong
        ? 'Bullish FVG imbalance gap below current price'
        : 'Bearish FVG imbalance gap above current price');
    }

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

    const pd = analysis.premiumDiscount;
    const pdMatches = isLong
      ? pd.currentPosition.zone === 'DISCOUNT'
      : pd.currentPosition.zone === 'PREMIUM';

    if (pdMatches) {
      score += 10;
      reasons.push(`Price in ${pd.currentPosition.zone} zone (${pd.currentPosition.percentage}%)`);
    }

    // ── OTE Zone (max 5 pts bonus) ── FIX: was `pd.currentPosition.inOTE` regardless of direction — see the detailed note in PremiumDiscountCalculator.pricePosition().
    if (isLong ? pd.currentPosition.inOTELong : pd.currentPosition.inOTEShort) {
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

class SMCAgent {
  constructor(config = {}) {
    this.symbol        = config.symbol        || 'UNKNOWN';
    this.timeframe     = config.timeframe     || 'H1';
    this.lookback      = config.lookback      || 30;
    this.pivotStrength = config.pivotStrength || 3;
    this.minScore      = config.minScore      || 70;

    this._bullishOBs   = [];
    this._bearishOBs   = [];
    this._bullishFVGs  = [];
    this._bearishFVGs  = [];
  }

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

    this._bullishOBs = OrderBlockDetector.detectBullish(previous, this.lookback);
    this._bearishOBs = OrderBlockDetector.detectBearish(previous, this.lookback);
    this._bullishOBs = OrderBlockDetector.updateStates(this._bullishOBs, current);
    this._bearishOBs = OrderBlockDetector.updateStates(this._bearishOBs, current);

    const allFVGs     = FVGDetector.detect(previous);
    this._bullishFVGs = FVGDetector.updateStates(
      allFVGs.filter(f => f.type === 'BULLISH_FVG'), current
    );
    this._bearishFVGs = FVGDetector.updateStates(
      allFVGs.filter(f => f.type === 'BEARISH_FVG'), current
    );
    const inverseFVGs = FVGDetector.detectInverse([...this._bullishFVGs, ...this._bearishFVGs]);

    const swings          = MarketStructureDetector.findSwings(candles, this.pivotStrength);
    const { events, currentTrend } = MarketStructureDetector.detectStructureBreaks(candles, swings);
    const equalLevels     = MarketStructureDetector.findEqualLevels(swings);

    const sweeps          = LiquidityDetector.detectSweeps(candles, swings);
    const inducements     = LiquidityDetector.detectInducement(candles);

    const sh              = swingHigh(candles.slice(-50));
    const sl              = swingLow(candles.slice(-50));
    const pdZones         = PremiumDiscountCalculator.calculate(sh, sl);
    const currentPosition = PremiumDiscountCalculator.pricePosition(current.close, sh, sl);

    const wyckoff = WyckoffDetector.analyze(candles);

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
        events:   events.slice(-10),
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

    let direction = SIGNAL_TYPE.WAIT;

    if (currentTrend === STRUCTURE.BULLISH) direction = SIGNAL_TYPE.LONG;
    if (currentTrend === STRUCTURE.BEARISH) direction = SIGNAL_TYPE.SHORT;

    const lastEvent = events.slice(-1)[0];
    if (lastEvent?.type === 'CHoCH') {
      direction = lastEvent.direction === STRUCTURE.BULLISH
        ? SIGNAL_TYPE.LONG
        : SIGNAL_TYPE.SHORT;
    }

    // Price must be in correct zone for direction
    if (direction === SIGNAL_TYPE.LONG  && currentPosition.zone === 'PREMIUM') direction = SIGNAL_TYPE.WAIT;
    if (direction === SIGNAL_TYPE.SHORT && currentPosition.zone === 'DISCOUNT') direction = SIGNAL_TYPE.WAIT;

    let confluenceResult = { score: 0, reasons: ['No directional bias'], grade: 'D' };

    if (direction !== SIGNAL_TYPE.WAIT) {
      confluenceResult = SMCConfluenceScorer.score(analysis, direction);
    }

    const signal = this._buildSignal(direction, confluenceResult, analysis, current);

    return { analysis, signal, confluenceResult };
  }

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

    const isLong    = direction === SIGNAL_TYPE.LONG;
    const bestOB    = isLong
      ? analysis.orderBlocks.bullish[0]
      : analysis.orderBlocks.bearish[0];
    const bestFVG   = isLong
      ? analysis.fvgs.bullish[0]
      : analysis.fvgs.bearish[0];

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

    const lastSwingHigh = analysis.structure.swings.highs.slice(-1)[0]?.price;
    const lastSwingLow  = analysis.structure.swings.lows.slice(-1)[0]?.price;

    const stopLoss = isLong
      ? round((bestOB?.obLow ?? lastSwingLow ?? currentCandle.low) * 0.9998)
      : round((bestOB?.obHigh ?? lastSwingHigh ?? currentCandle.high) * 1.0002);

    const tp1Distance = Math.abs(currentCandle.close - stopLoss);
    const takeProfit1 = isLong
      ? round(currentCandle.close + tp1Distance * 1.5)
      : round(currentCandle.close - tp1Distance * 1.5);

    const takeProfit2 = isLong
      ? round(currentCandle.close + tp1Distance * 3.0)
      : round(currentCandle.close - tp1Distance * 3.0);

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

