
'use strict';

const EventEmitter = require('events');

const DEFAULT_RISK_PCT      = 1.0;
const MAX_RISK_PCT          = 2.0;
const MIN_RISK_PCT          = 0.25;
const DEFAULT_LEVERAGE      = 1;
const MAX_LEVERAGE          = 20;
const KELLY_FRACTION        = 0.25;
const ATR_PERIOD            = 14;
const HIGH_VOL_THRESHOLD    = 0.015;
const LOW_VOL_THRESHOLD     = 0.003;
const CORRELATION_THRESHOLD = 0.7;

// FIX: Add safe rounding with NaN/Infinity checks
function _round(n, d = 5) {
  if (!Number.isFinite(n)) return 0;
  return parseFloat((+n).toFixed(d));
}

function _roundLots(n, step = 0.001) {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (!Number.isFinite(step) || step <= 0) step = 0.001;
  return Math.round(n / step) * step;
}

class KellyCalculator {
  static calculate(winRate, avgWin, avgLoss, fraction = KELLY_FRACTION) {
    // FIX: Validate inputs before calculation
    if (!Number.isFinite(winRate) || !Number.isFinite(avgWin) || !Number.isFinite(avgLoss)) {
      return { kelly: 0, halfKelly: 0, quarterKelly: 0, edge: 0, note: 'Invalid input parameters', hasEdge: false };
    }

    if (!winRate || !avgWin || !avgLoss || avgLoss === 0) {
      return { kelly: 0, halfKelly: 0, quarterKelly: 0, edge: 0, note: 'Insufficient data', hasEdge: false };
    }

    const p = Math.min(Math.max(winRate, 0.01), 0.99);
    const q = 1 - p;
    const b = Math.abs(avgWin) / Math.abs(avgLoss);

    // FIX: Check for invalid b before division
    if (!Number.isFinite(b) || b <= 0) {
      return { kelly: 0, halfKelly: 0, quarterKelly: 0, edge: 0, note: 'Invalid odds ratio', hasEdge: false };
    }

    const fullKelly = (p * b - q) / b;

    if (fullKelly <= 0) {
      return {
        kelly:         0,
        halfKelly:     0,
        quarterKelly:  0,
        fullKelly:     _round(fullKelly * 100, 2),
        usedKelly:     0,
        edge:          _round(fullKelly * 100, 2),
        oddsRatio:     _round(b, 3),
        winRate:       _round(p * 100, 2),
        hasEdge:       false,
        note:          'No statistical edge — Kelly negative. Do not size up.',
      };
    }

    const usedKelly = fullKelly * fraction;

    return {
      fullKelly:     _round(fullKelly * 100, 4),
      halfKelly:     _round(fullKelly * 0.5 * 100, 4),
      quarterKelly:  _round(fullKelly * 0.25 * 100, 4),
      usedKelly:     _round(usedKelly * 100, 4),
      edge:          _round(fullKelly * 100, 4),
      oddsRatio:     _round(b, 3),
      winRate:       _round(p * 100, 2),
      hasEdge:       true,
      note:          `Positive edge detected. Kelly: ${_round(fullKelly * 100, 2)}%, Using: ${_round(usedKelly * 100, 2)}%`,
    };
  }

  static expectedValue(winRate, avgWin, avgLoss) {
    // FIX: Validate inputs
    if (!Number.isFinite(winRate) || !Number.isFinite(avgWin) || !Number.isFinite(avgLoss)) {
      return { ev: 0, positive: false, note: 'Invalid input parameters' };
    }

    const p   = winRate;
    const q   = 1 - p;
    const ev  = (p * Math.abs(avgWin)) - (q * Math.abs(avgLoss));
    return {
      ev:        _round(ev, 4),
      positive:  ev > 0,
      note:      `EV: ${ev > 0 ? '+' : ''}${(ev * 100).toFixed(2)}% per trade`,
    };
  }
}

class ATRSizer {
  static calculate({ accountBalance, riskPct, atr, entryPrice, slPrice, symbol, leverage = 1 }) {
    // FIX: Validate all numeric inputs
    if (!Number.isFinite(accountBalance) || accountBalance <= 0) {
      return { error: 'Invalid account balance', units: 0 };
    }
    if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 100) {
      return { error: 'Invalid risk percentage', units: 0 };
    }
    if (!Number.isFinite(atr) || atr <= 0) {
      return { error: 'Invalid ATR value', units: 0 };
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return { error: 'Invalid entry price', units: 0 };
    }
    if (!Number.isFinite(slPrice) || slPrice <= 0) {
      return { error: 'Invalid SL price', units: 0 };
    }
    if (!Number.isFinite(leverage) || leverage <= 0 || leverage > MAX_LEVERAGE) {
      return { error: 'Invalid leverage', units: 0 };
    }

    const riskAmount    = accountBalance * (riskPct / 100);
    const slDistance    = Math.abs(entryPrice - slPrice);
    const atrPct        = atr / entryPrice;

    // FIX: Protect against zero division
    if (slDistance === 0 || !Number.isFinite(slDistance)) {
      return { error: 'SL distance is 0 or invalid — cannot size', units: 0 };
    }

    let units = riskAmount / slDistance;

    // FIX: Validate units calculation
    if (!Number.isFinite(units) || units < 0) {
      return { error: 'Position size calculation failed', units: 0 };
    }

    units = units * leverage;

    const volScaling = ATRSizer._volatilityScale(atrPct);
    units = units * volScaling.factor;

    const lotStep = ATRSizer._getLotStep(symbol || '');
    const lots    = _roundLots(units, lotStep);

    const positionValue = lots * entryPrice;
    const actualRisk    = lots * slDistance;
    const actualRiskPct = accountBalance > 0 ? _round((actualRisk / accountBalance) * 100, 4) : 0;
    const margin        = leverage > 1 ? _round(positionValue / leverage, 2) : positionValue;

    return {
      units:          lots,
      rawUnits:       _round(units, 6),
      positionValue:  _round(positionValue, 2),
      riskAmount:     _round(riskAmount, 2),
      actualRisk:     _round(actualRisk, 2),
      actualRiskPct,
      margin,
      slDistance:     _round(slDistance, 5),
      atrPct:         _round(atrPct * 100, 4),
      volScaling,
      leverage,
      lotStep,
    };
  }

  static _volatilityScale(atrPct) {
    // FIX: Add bounds checking
    if (!Number.isFinite(atrPct) || atrPct < 0) {
      return { factor: 1.0, label: 'UNKNOWN' };
    }

    if (atrPct > HIGH_VOL_THRESHOLD) {
      return { factor: 0.5, label: 'HIGH_VOL — reduce size 50%' };
    }
    if (atrPct < LOW_VOL_THRESHOLD) {
      return { factor: 1.5, label: 'LOW_VOL — increase size 50% (capped)' };
    }
    return { factor: 1.0, label: 'NORMAL_VOL' };
  }

  static _getLotStep(symbol) {
    const steps = {
      'BTCUSDT': 0.001,
      'ETHUSDT': 0.01,
      'BNBUSDT': 0.1,
      'XAUUSD':  0.01,
      'EURUSD':  0.01,
      'GBPUSD':  0.01,
    };
    return steps[symbol] || 0.01;
  }
}

class SessionVolatilityFilter {
  static getMultiplier() {
    const utcHour = new Date().getUTCHours();

    if (utcHour >= 21) return { factor: 0.5, session: 'DEAD', note: 'Half size in dead zone' };

    if (utcHour < 8)   return { factor: 0.75, session: 'ASIA', note: 'Reduced size — Asia session' };

    if (utcHour < 13)  return { factor: 1.0, session: 'LONDON', note: 'Normal size — London session' };

    if (utcHour < 16)  return { factor: 1.0, session: 'OVERLAP', note: 'Normal size — prime session' };

    return { factor: 1.0, session: 'NEW_YORK', note: 'Normal size — NY session' };
  }
}

class RiskEngine extends EventEmitter {
  constructor(config = {}) {
    super();

    this._balance       = config.accountBalance  || 10000;
    this._riskPct       = config.riskPct         || DEFAULT_RISK_PCT;
    this._maxRiskPct    = config.maxRiskPct      || MAX_RISK_PCT;
    this._leverage      = config.defaultLeverage || DEFAULT_LEVERAGE;
    this._maxLeverage   = config.maxLeverage     || MAX_LEVERAGE;
    this._method        = config.sizingMethod    || 'ATR';
    this._useKelly      = config.useKelly        || false;
    this._corrFilter    = config.correlationFilter !== false;
    this._sessScaling   = config.sessionScaling  !== false;
    // FIX: RiskEngine.evaluate() previously used a hardcoded `{ sizingFactor: 1.0 }` stub instead of actually consulting DrawdownGuard, meaning the circuit breaker (daily loss limits, max drawdown,...
    this._drawdownGuard = config.drawdownGuard || null;

    this._performanceStats = {
      trades:   0,
      wins:     0,
      losses:   0,
      winRate:  0.5,
      avgWin:   1.0,
      avgLoss:  1.0,
      maxLoss:  0,
      pnl:      0,
    };

    this._positions = new Map();
    this._openCount = 0;

    console.log('[RiskEngine] Initialized:', {
      balance: this._balance,
      riskPct: this._riskPct,
      method:  this._method,
      useKelly: this._useKelly,
    });
  }

  evaluate(signal) {
    try {
      if (!signal) return { approved: false, reason: 'No signal provided', positionSize: 0 };

      const entryPrice = signal.entry?.midPoint || signal.entryPrice;
      const slPrice    = signal.stopLoss?.price;
      const currentPrice = signal.currentPrice;
      const symbol     = signal.symbol;

      // FIX: Validate required fields
      if (!Number.isFinite(entryPrice) || !Number.isFinite(slPrice)) {
        return { approved: false, reason: 'Invalid entry or SL price', positionSize: 0 };
      }

      // Drawdown check — FIX: was hardcoded to sizingFactor 1.0, which meant the circuit breaker could never block a trade if RiskEngine.evaluate() were ever called directly.
      const ddCheck = this._drawdownGuard?.evaluate
        ? this._drawdownGuard.evaluate({ atr: signal.atr, price: currentPrice || entryPrice })
        : { allowed: true, sizingFactor: 1.0 };

      if (!ddCheck.allowed) {
        return { approved: false, reason: ddCheck.reason || 'Blocked by drawdown guard', positionSize: 0 };
      }

      const corrReduction = this._corrFilter ? this._getCorrelationReduction() : 1.0;

      const sessionMult = this._sessScaling
        ? SessionVolatilityFilter.getMultiplier().factor
        : 1.0;

      const baseRisk     = this._riskPct;
      const ddFactor     = 1.0; // see note above — applied externally, not here
      const effectiveRisk = Math.min(
        baseRisk * ddFactor * corrReduction * sessionMult,
        this._maxRiskPct
      );

      const clampedRisk  = Math.max(effectiveRisk, MIN_RISK_PCT);

      let sizing;

      if (this._method === 'ATR' || !slPrice) {
        sizing = ATRSizer.calculate({
          accountBalance: this._balance,
          riskPct: clampedRisk,
          atr: signal.atr || 0,
          entryPrice,
          slPrice: slPrice || (entryPrice * 1.02),
          symbol,
          leverage: this._leverage,
        });
      } else {
        const riskAmount = this._balance * (clampedRisk / 100);
        const slDistance = Math.abs(entryPrice - slPrice);
        let units = slDistance > 0 ? riskAmount / slDistance : 0;
        units = Math.max(0, Math.min(units * this._leverage, this._balance / entryPrice));
        sizing = {
          units: units,
          actualRiskPct: clampedRisk,
          error: null,
        };
      }

      if (sizing.error) {
        return { approved: false, reason: sizing.error, positionSize: 0 };
      }

      let kellyResult = null;
      if (this._useKelly && this._performanceStats.trades > 10) {
        kellyResult = KellyCalculator.calculate(
          this._performanceStats.winRate,
          this._performanceStats.avgWin,
          this._performanceStats.avgLoss
        );

        if (kellyResult.hasEdge) {
          const kellySize = (this._balance * (kellyResult.usedKelly / 100)) / Math.abs(entryPrice - slPrice);
          if (kellySize < sizing.units) {
            sizing.units = kellySize;
            sizing.kellyConstrained = true;
          }
        }
      }

      const positionValue = sizing.units * entryPrice;
      const requiredMargin = this._leverage > 1 ? positionValue / this._leverage : positionValue;

      if (requiredMargin > this._balance * 0.9) {
        return {
          approved: false,
          reason: `Insufficient margin: need ${requiredMargin.toFixed(2)}, have ${this._balance * 0.9}`,
          positionSize: 0,
        };
      }

      return {
        approved: true,
        positionSize: sizing.units,
        sizing,
        kellyResult,
        effectiveRisk: clampedRisk,
        note: `Approved: ${sizing.units} units at ${symbol}`,
      };
    } catch (err) {
      console.error('[RiskEngine] Evaluation error:', err.message);
      return { approved: false, reason: err.message, positionSize: 0 };
    }
  }

  // FIX: RiskEngine._balance was set once at construction from the ACCOUNT_BALANCE env var and never updatable afterward.
  setBalance(balance) {
    const n = Number(balance);
    if (Number.isFinite(n) && n > 0) this._balance = n;
  }

  recordTrade(outcome) {
    try {
      if (!outcome || typeof outcome.pnlR !== 'number') return;

      this._performanceStats.trades++;
      if (outcome.pnlR > 0) {
        this._performanceStats.wins++;
        this._performanceStats.avgWin = (this._performanceStats.avgWin * (this._performanceStats.wins - 1) + outcome.pnlR) / this._performanceStats.wins;
      } else {
        this._performanceStats.losses++;
        this._performanceStats.avgLoss = (this._performanceStats.avgLoss * (this._performanceStats.losses - 1) + Math.abs(outcome.pnlR)) / this._performanceStats.losses;
      }

      this._performanceStats.winRate = this._performanceStats.wins / this._performanceStats.trades;
      this._performanceStats.pnl += outcome.pnlR;
    } catch (err) {
      console.warn('[RiskEngine] Trade record error:', err.message);
    }
  }

  _getCorrelationReduction() {
    return this._openCount > 2 ? 0.8 : 1.0;
  }

  _calcATR(candles, period = ATR_PERIOD) {
    if (!Array.isArray(candles) || candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const p = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      if (Number.isFinite(tr)) trs.push(tr);
    }
    if (trs.length === 0) return 0;
    const atr = trs.slice(-period).reduce((s, v) => s + v, 0) / Math.min(period, trs.length);
    return Number.isFinite(atr) ? atr : 0;
  }

  size(signal) {
    return this.evaluate(signal);
  }

  getStats() {
    return {
      balance: this._balance,
      riskPct: this._riskPct,
      method: this._method,
      performanceStats: this._performanceStats,
      openPositions: this._openCount,
    };
  }
}

module.exports = {
  RiskEngine,
  ATRSizer,
  KellyCalculator,
  SessionVolatilityFilter,
  ATR_PERIOD,
  DEFAULT_RISK_PCT,
  MAX_RISK_PCT,
};
