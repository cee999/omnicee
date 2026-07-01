/**
 * ============================================================
 *  POSITION SIZER — Kelly Criterion + ATR-Based Sizing
 *  AI Trading Assistant · Layer 3 · Risk Engine
 * ============================================================
 *
 *  Sizing methods:
 *    - Fixed fractional (% of account)
 *    - ATR-based (normalize risk across volatility regimes)
 *    - Kelly Criterion (full + half-Kelly)
 *    - Volatility-adjusted (reduce size in high-vol environments)
 *    - Correlation-adjusted (reduce if correlated position open)
 *
 *  Risk controls:
 *    - Max risk per trade (default 1%)
 *    - Max position size (absolute cap)
 *    - Max leverage cap
 *    - Margin check (ensure sufficient balance)
 *    - Correlation filter (no double exposure)
 *    - Session volatility scaling
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const DEFAULT_RISK_PCT      = 1.0;    // 1% per trade
const MAX_RISK_PCT          = 2.0;    // hard cap
const MIN_RISK_PCT          = 0.25;   // floor
const DEFAULT_LEVERAGE      = 1;
const MAX_LEVERAGE          = 20;
const KELLY_FRACTION        = 0.25;   // quarter-Kelly for safety
const ATR_PERIOD            = 14;
const HIGH_VOL_THRESHOLD    = 0.015;  // 1.5% ATR/price = reduce size
const LOW_VOL_THRESHOLD     = 0.003;  // 0.3% ATR/price = normal size
const CORRELATION_THRESHOLD = 0.7;    // 70%+ correlation = reduce

function _round(n, d = 5) { return parseFloat((+n).toFixed(d)); }
function _roundLots(n, step = 0.001) {
  return Math.floor(n / step) * step;
}

// ─────────────────────────────────────────────
//  KELLY CALCULATOR
// ─────────────────────────────────────────────

class KellyCalculator {
  /**
   * Full Kelly formula: f* = (p * b - q) / b
   * where:
   *   p = win rate (0-1)
   *   q = 1 - p (loss rate)
   *   b = avg win / avg loss (profit factor)
   *
   * Returns the optimal fraction of capital to risk.
   * We use quarter-Kelly for safety.
   *
   * @param {number} winRate   - historical win rate (0-1)
   * @param {number} avgWin    - average winning trade return (as %)
   * @param {number} avgLoss   - average losing trade return (as %, positive)
   * @param {number} fraction  - Kelly fraction multiplier (default 0.25)
   * @returns {Object} kellyResult
   */
  static calculate(winRate, avgWin, avgLoss, fraction = KELLY_FRACTION) {
    if (!winRate || !avgWin || !avgLoss || avgLoss === 0) {
      return { kelly: 0, halfKelly: 0, quarterKelly: 0, edge: 0, note: 'Insufficient data' };
    }

    const p = Math.min(Math.max(winRate, 0.01), 0.99);
    const q = 1 - p;
    const b = Math.abs(avgWin) / Math.abs(avgLoss); // odds ratio

    const fullKelly = (p * b - q) / b;

    // Negative Kelly = no edge → don't trade
    if (fullKelly <= 0) {
      return {
        kelly:         0,
        halfKelly:     0,
        quarterKelly:  0,
        fullKelly:     _round(fullKelly * 100, 2),
        edge:          _round(fullKelly * 100, 2),
        note:          'No statistical edge — Kelly negative. Do not size up.',
        hasEdge:       false,
      };
    }

    const usedKelly = fullKelly * fraction;

    return {
      fullKelly:     _round(fullKelly * 100, 4),   // as %
      halfKelly:     _round(fullKelly * 0.5 * 100, 4),
      quarterKelly:  _round(fullKelly * 0.25 * 100, 4),
      usedKelly:     _round(usedKelly * 100, 4),   // what we actually use
      edge:          _round(fullKelly * 100, 4),
      oddsRatio:     _round(b, 3),
      winRate:       _round(p * 100, 2),
      hasEdge:       true,
      note:          `Full Kelly: ${_round(fullKelly * 100, 2)}% — using ${fraction * 100}% Kelly for safety`,
    };
  }

  /**
   * Expected Value of a trade.
   * EV = (winRate × avgWin) − (lossRate × avgLoss)
   * Positive EV = good trade, negative = avoid
   */
  static expectedValue(winRate, avgWin, avgLoss) {
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

// ─────────────────────────────────────────────
//  ATR SIZER
// ─────────────────────────────────────────────

class ATRSizer {
  /**
   * ATR-based position sizing.
   * Risk = account × riskPct
   * SL distance = ATR × multiplier
   * Size = Risk / (ATR × multiplier × price)
   *
   * This normalizes position size across different volatility regimes:
   * - High vol = smaller size
   * - Low vol = larger size (but capped)
   *
   * @param {Object} params
   * @param {number} params.accountBalance
   * @param {number} params.riskPct         - % of account to risk
   * @param {number} params.atr             - current ATR
   * @param {number} params.entryPrice
   * @param {number} params.slPrice
   * @param {string} [params.symbol]        - for lot step lookup
   * @param {number} [params.leverage]      - leverage (default 1)
   * @returns {Object} sizing result
   */
  static calculate({ accountBalance, riskPct, atr, entryPrice, slPrice, symbol, leverage = 1 }) {
    const riskAmount    = accountBalance * (riskPct / 100);
    const slDistance    = Math.abs(entryPrice - slPrice);
    const atrPct        = atr / entryPrice;

    if (slDistance === 0) {
      return { error: 'SL distance is 0 — cannot size', units: 0 };
    }

    // Base units: risk ÷ SL distance
    let units = riskAmount / slDistance;

    // Apply leverage
    units = units * leverage;

    // Volatility scaling
    const volScaling = ATRSizer._volatilityScale(atrPct);
    units = units * volScaling.factor;

    // Lot step normalization (BTC = 0.001, ETH = 0.01, etc.)
    const lotStep = ATRSizer._getLotStep(symbol || '');
    const lots    = _roundLots(units, lotStep);

    // Dollar values
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
    if (atrPct > HIGH_VOL_THRESHOLD) {
      const excess  = atrPct / HIGH_VOL_THRESHOLD;
      const factor  = Math.max(0.3, 1 / excess); // reduce to 30-70% in high vol
      return { factor: _round(factor, 3), label: 'HIGH_VOL_REDUCED', atrPct: _round(atrPct * 100, 3) };
    }
    if (atrPct < LOW_VOL_THRESHOLD) {
      return { factor: 1.0, label: 'LOW_VOL_NORMAL', atrPct: _round(atrPct * 100, 3) };
    }
    return { factor: 1.0, label: 'NORMAL', atrPct: _round(atrPct * 100, 3) };
  }

  static _getLotStep(symbol) {
    const s = symbol.toUpperCase();
    if (s.includes('BTC'))      return 0.001;
    if (s.includes('ETH'))      return 0.01;
    if (s.includes('SOL'))      return 0.1;
    if (s.includes('XAU'))      return 0.01;  // Gold
    if (s.includes('EUR') || s.includes('GBP')) return 0.01; // Forex
    return 1; // default
  }
}

// ─────────────────────────────────────────────
//  CORRELATION FILTER
// ─────────────────────────────────────────────

class CorrelationFilter {
  /**
   * Simple correlation filter.
   * Prevents double-exposure to correlated assets.
   *
   * e.g. BTC long + ETH long = correlated → reduce ETH size
   *
   * @param {Array}  openPositions - array of { symbol, direction, size }
   * @param {string} newSymbol
   * @param {string} newDirection
   * @returns {{ approved, reductionFactor, reason }}
   */
  static check(openPositions, newSymbol, newDirection) {
    if (!openPositions || openPositions.length === 0) {
      return { approved: true, reductionFactor: 1.0, reason: 'No open positions' };
    }

    const correlatedGroups = [
      ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],  // Crypto majors
      ['EURUSD', 'GBPUSD', 'AUDUSD'],                  // Risk-on FX
      ['USDJPY', 'USDCHF'],                             // Risk-off FX
      ['XAUUSD', 'XAGUSD'],                             // Precious metals
    ];

    const newGroup = correlatedGroups.find(g => g.includes(newSymbol));
    if (!newGroup) return { approved: true, reductionFactor: 1.0, reason: 'No known correlations' };

    const conflicting = openPositions.filter(pos =>
      newGroup.includes(pos.symbol) &&
      pos.symbol !== newSymbol &&
      pos.direction === newDirection
    );

    if (conflicting.length === 0) {
      return { approved: true, reductionFactor: 1.0, reason: 'No correlated positions in same direction' };
    }

    // Reduce size for each correlated position
    const factor = Math.max(0.25, 1 - conflicting.length * 0.25);

    return {
      approved:       true,
      reductionFactor: _round(factor, 2),
      reason:         `${conflicting.length} correlated position(s) open: ${conflicting.map(p => p.symbol).join(', ')} — size reduced to ${(factor * 100).toFixed(0)}%`,
      correlated:     conflicting,
    };
  }
}

// ─────────────────────────────────────────────
//  DRAWDOWN GUARD
// ─────────────────────────────────────────────

class DrawdownGuard {
  /**
   * @param {Object} config
   * @param {number} config.maxDailyLossPct    - default 3%
   * @param {number} config.maxDrawdownPct     - running drawdown limit (default 10%)
   * @param {number} config.maxConsecutiveLoss - default 4
   * @param {number} config.scalingThreshold   - start reducing at this drawdown (default 5%)
   */
  constructor(config = {}) {
    this.maxDailyLoss     = config.maxDailyLossPct    || 3;
    this.maxDrawdown      = config.maxDrawdownPct      || 10;
    this.maxConsecLoss    = config.maxConsecutiveLoss  || 4;
    this.scalingThreshold = config.scalingThreshold   || 5;

    this._dailyPnl    = 0;
    this._peakBalance = null;
    this._currentDD   = 0;
    this._consecLoss  = 0;
    this._trades      = [];
    this._dayStart    = this._today();
    this._paused      = false;
  }

  /**
   * Record a completed trade.
   * @param {number} pnlPct  - trade PnL as % of account (negative = loss)
   * @param {number} balance - current account balance
   */
  record(pnlPct, balance) {
    const now = Date.now();

    // Reset daily if new day
    if (this._today() > this._dayStart) {
      this._dailyPnl = 0;
      this._dayStart = this._today();
    }

    this._dailyPnl += pnlPct;
    this._trades.push({ pnlPct, balance, timestamp: now });

    // Track peak for drawdown calculation
    if (balance > (this._peakBalance || balance)) {
      this._peakBalance = balance;
    }
    if (this._peakBalance && balance < this._peakBalance) {
      this._currentDD = _round(((this._peakBalance - balance) / this._peakBalance) * 100, 4);
    }

    // Consecutive loss counter
    if (pnlPct < 0) {
      this._consecLoss++;
    } else {
      this._consecLoss = 0;
    }

    this._checkBreakers();
    return this.getStatus();
  }

  /**
   * Check if a new trade is allowed.
   * Returns { allowed, sizingFactor, reason }
   */
  evaluate(balance) {
    if (this._paused) {
      return { allowed: false, sizingFactor: 0, reason: `Trading paused: ${this._pausedReason}` };
    }

    // Size scaling based on drawdown
    let sizingFactor = 1.0;
    if (this._currentDD > this.scalingThreshold) {
      // Linear reduction: 5% DD = 100%, 10% DD = 50%
      const excess = this._currentDD - this.scalingThreshold;
      const range  = this.maxDrawdown - this.scalingThreshold;
      sizingFactor = Math.max(0.25, 1 - (excess / range) * 0.75);
    }

    if (this._consecLoss >= 3) {
      sizingFactor = Math.min(sizingFactor, 0.5); // half-size after 3 losses in a row
    }

    return {
      allowed:      true,
      sizingFactor: _round(sizingFactor, 2),
      dailyPnl:     _round(this._dailyPnl, 4),
      drawdown:     _round(this._currentDD, 4),
      consecLoss:   this._consecLoss,
      reason:       sizingFactor < 1 ? `Scaling to ${(sizingFactor * 100).toFixed(0)}% due to drawdown` : 'Normal sizing',
    };
  }

  _checkBreakers() {
    if (this._dailyPnl <= -this.maxDailyLoss) {
      this._paused = true;
      this._pausedReason = `Daily loss limit: ${_round(this._dailyPnl, 2)}% (max ${this.maxDailyLoss}%)`;
    } else if (this._currentDD >= this.maxDrawdown) {
      this._paused = true;
      this._pausedReason = `Max drawdown hit: ${_round(this._currentDD, 2)}% (max ${this.maxDrawdown}%)`;
    } else if (this._consecLoss >= this.maxConsecLoss) {
      this._paused = true;
      this._pausedReason = `${this._consecLoss} consecutive losses — circuit breaker`;
    } else {
      this._paused = false;
      this._pausedReason = null;
    }
  }

  getStatus() {
    return {
      paused:         this._paused,
      pausedReason:   this._pausedReason || null,
      dailyPnl:       _round(this._dailyPnl, 4),
      currentDD:      _round(this._currentDD, 4),
      peakBalance:    this._peakBalance,
      consecLoss:     this._consecLoss,
      tradesCount:    this._trades.length,
    };
  }

  reset() {
    this._paused = false;
    this._pausedReason = null;
    this._consecLoss = 0;
  }

  _today() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
}

// ─────────────────────────────────────────────
//  SESSION VOLATILITY FILTER
// ─────────────────────────────────────────────

class SessionVolatilityFilter {
  /**
   * Adjusts position size based on trading session.
   * Asia session = reduce size (lower liquidity)
   * London/NY = normal or slight increase
   */
  static getMultiplier() {
    const utcHour = new Date().getUTCHours();

    // Dead zone: 21:00-00:00 UTC
    if (utcHour >= 21) return { factor: 0.5, session: 'DEAD', note: 'Half size in dead zone' };

    // Asia: 00:00-08:00 UTC
    if (utcHour < 8)   return { factor: 0.75, session: 'ASIA', note: 'Reduced size — Asia session' };

    // London: 08:00-13:00 UTC
    if (utcHour < 13)  return { factor: 1.0, session: 'LONDON', note: 'Normal size — London session' };

    // London/NY overlap: 13:00-16:00 UTC (best session)
    if (utcHour < 16)  return { factor: 1.0, session: 'OVERLAP', note: 'Normal size — prime session' };

    // NY: 16:00-21:00 UTC
    return { factor: 1.0, session: 'NEW_YORK', note: 'Normal size — NY session' };
  }
}

// ─────────────────────────────────────────────
//  MAIN RISK ENGINE / POSITION SIZER
// ─────────────────────────────────────────────

class RiskEngine extends EventEmitter {
  /**
   * @param {Object} config
   * @param {number}  config.accountBalance       - account size in USD
   * @param {number}  config.riskPct              - base risk per trade % (default 1)
   * @param {number}  config.maxRiskPct           - hard cap (default 2)
   * @param {number}  config.defaultLeverage      - default leverage (default 1)
   * @param {number}  config.maxLeverage          - max allowed leverage (default 20)
   * @param {string}  config.sizingMethod         - 'FIXED' | 'ATR' | 'KELLY' (default 'ATR')
   * @param {boolean} config.useKelly             - blend Kelly into sizing (default false)
   * @param {boolean} config.correlationFilter    - check correlations (default true)
   * @param {boolean} config.sessionScaling       - scale by session (default true)
   * @param {Object}  config.drawdown             - DrawdownGuard config
   */
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

    this._drawdown      = new DrawdownGuard(config.drawdown || {});

    // Open positions registry: signalId → { symbol, direction, size }
    this._openPositions = new Map();

    // Performance stats for Kelly
    this._performanceStats = {
      winRate:  0.55,
      avgWin:   1.5,
      avgLoss:  1.0,
    };
  }

  // ─────────────────────────────────────────────
  //  MAIN EVALUATE FUNCTION
  // ─────────────────────────────────────────────

  /**
   * Full evaluation of a signal — returns sizing + approval.
   * Called by task-planner after scoring.
   *
   * @param {Object} signal - scored signal from signal-scorer
   * @returns {Object} evaluation result
   */
  evaluate(signal) {
    const { symbol, action: direction, currentPrice, stopLoss, risk } = signal;
    const slPrice    = stopLoss?.price;
    const atr        = risk?.atr || (currentPrice * 0.01);

    if (!slPrice || !currentPrice) {
      return { approved: false, reason: 'Missing price or SL data', positionSize: 0 };
    }

    // ── Drawdown check ──
    const ddCheck = this._drawdown.evaluate(this._balance);
    if (!ddCheck.allowed) {
      this.emit('blocked', { reason: ddCheck.reason, signal });
      return { approved: false, reason: ddCheck.reason, positionSize: 0, drawdown: ddCheck };
    }

    // ── Correlation filter ──
    let corrReduction = 1.0;
    if (this._corrFilter) {
      const openArr  = [...this._openPositions.values()];
      const corrCheck = CorrelationFilter.check(openArr, symbol, direction);
      corrReduction  = corrCheck.reductionFactor;
      if (corrReduction < 1) {
        signal._corrNote = corrCheck.reason;
      }
    }

    // ── Session scaling ──
    const sessionMult = this._sessScaling
      ? SessionVolatilityFilter.getMultiplier().factor
      : 1.0;

    // ── Effective risk % ──
    const baseRisk     = this._riskPct;
    const ddFactor     = ddCheck.sizingFactor;
    const effectiveRisk = Math.min(
      baseRisk * ddFactor * corrReduction * sessionMult,
      this._maxRiskPct
    );

    const clampedRisk  = Math.max(effectiveRisk, MIN_RISK_PCT);

    // ── Compute size ──
    let sizing;

    if (this._method === 'ATR' || !slPrice) {
      sizing = ATRSizer.calculate({
        accountBalance: this._balance,
        riskPct:        clampedRisk,
        atr,
        entryPrice:     currentPrice,
        slPrice,
        symbol,
        leverage:       this._leverage,
      });
    } else {
      // Fixed fractional fallback
      const riskAmount = this._balance * (clampedRisk / 100);
      const slDist     = Math.abs(currentPrice - slPrice);
      const units      = slDist > 0 ? _roundLots(riskAmount / slDist) : 0;
      sizing = { units, positionValue: units * currentPrice, actualRiskPct: clampedRisk };
    }

    if (sizing.error) {
      return { approved: false, reason: sizing.error, positionSize: 0 };
    }

    // ── Kelly overlay ──
    let kellyResult = null;
    if (this._useKelly) {
      kellyResult = KellyCalculator.calculate(
        this._performanceStats.winRate,
        this._performanceStats.avgWin,
        this._performanceStats.avgLoss
      );

      if (kellyResult.hasEdge) {
        const kellySize = (this._balance * kellyResult.usedKelly / 100) / Math.abs(currentPrice - slPrice);
        // Use the smaller of ATR size or Kelly size
        sizing.units = _roundLots(Math.min(sizing.units, kellySize));
        sizing.kellyAdjusted = true;
      }
    }

    // ── Margin check ──
    const margin         = sizing.margin || sizing.positionValue;
    const marginOk       = margin <= this._balance * 0.9; // never use >90% margin

    if (!marginOk) {
      return {
        approved:     false,
        reason:       `Insufficient margin: need ${_round(margin, 2)}, have ${this._balance}`,
        positionSize: 0,
        sizing,
      };
    }

    // ── Final result ──
    const result = {
      approved:       true,
      positionSize:   sizing.units,
      sizing,
      effectiveRisk:  _round(clampedRisk, 4),
      factors: {
        base:         baseRisk,
        ddFactor,
        corrReduction,
        sessionMult,
        effective:    _round(clampedRisk, 4),
      },
      kelly:          kellyResult,
      drawdown:       ddCheck,
      maxLoss:        _round(sizing.actualRisk || (sizing.units * Math.abs(currentPrice - slPrice)), 2),
      note: [
        ddFactor < 1 ? `DD scaling: ×${ddFactor}` : null,
        corrReduction < 1 ? `Corr reduction: ×${corrReduction}` : null,
        sessionMult < 1 ? `Session scaling: ×${sessionMult}` : null,
      ].filter(Boolean).join(' | ') || 'Full size — no reductions',
    };

    this.emit('evaluated', { signal, result });
    return result;
  }

  /**
   * Backward-compatible sizing helper used by older orchestration code.
   * Returns a compact shape while still routing through the full evaluator.
   */
  size({ candles = [], signal = {}, symbol } = {}) {
    const last = candles[candles.length - 1] || {};
    const entry = signal.entry || {};
    const currentPrice = entry.midpoint || entry.midPoint || entry.zoneHigh || signal.currentPrice || last.close;
    const atr = signal.risk?.atr || this._calcATR(candles) || (currentPrice ? currentPrice * 0.01 : 0);
    const enriched = {
      ...signal,
      symbol: symbol || signal.symbol,
      currentPrice,
      stopLoss: signal.stopLoss || {
        price: signal.action === 'SHORT' ? currentPrice + atr * 1.5 : currentPrice - atr * 1.5,
      },
      risk: { ...(signal.risk || {}), atr },
    };
    const result = this.evaluate(enriched);
    return {
      approved: result.approved,
      lots: result.positionSize || 0,
      units: result.positionSize || 0,
      riskUSD: result.sizing?.actualRisk || result.maxLoss || 0,
      effectiveRisk: result.effectiveRisk || 0,
      reason: result.reason || result.note,
      evaluation: result,
    };
  }

  // ─────────────────────────────────────────────
  //  POSITION TRACKING
  // ─────────────────────────────────────────────

  openPosition(signalId, symbol, direction, size) {
    this._openPositions.set(signalId, { symbol, direction, size, openedAt: Date.now() });
    this.emit('position_opened', { signalId, symbol, direction, size });
  }

  closePosition(signalId, pnlPct) {
    const pos = this._openPositions.get(signalId);
    if (!pos) return;

    this._openPositions.delete(signalId);
    this._drawdown.record(pnlPct, this._balance * (1 + pnlPct / 100));
    this.emit('position_closed', { signalId, pnlPct, drawdown: this._drawdown.getStatus() });
  }

  // ─────────────────────────────────────────────
  //  ACCOUNT MANAGEMENT
  // ─────────────────────────────────────────────

  updateBalance(newBalance) {
    this._balance = newBalance;
    this.emit('balance_updated', { balance: newBalance });
  }

  updatePerformance(stats) {
    // Called with stats from signal-scorer to keep Kelly calibrated
    if (stats.winRate)  this._performanceStats.winRate = stats.winRate / 100;
    if (stats.avgWinPct) this._performanceStats.avgWin = Math.abs(stats.avgWinPct);
    if (stats.avgLossPct) this._performanceStats.avgLoss = Math.abs(stats.avgLossPct);
  }

  getBalance()    { return this._balance; }
  getRiskPct()    { return this._riskPct; }
  setRiskPct(pct) { this._riskPct = Math.min(Math.max(pct, MIN_RISK_PCT), MAX_RISK_PCT); }
  setLeverage(l)  { this._leverage = Math.min(Math.max(l, 1), this._maxLeverage); }

  resetCircuitBreaker() {
    this._drawdown.reset();
    this.emit('circuit_breaker_reset');
  }

  getStatus() {
    return {
      balance:        this._balance,
      riskPct:        this._riskPct,
      leverage:       this._leverage,
      method:         this._method,
      openPositions:  this._openPositions.size,
      drawdown:       this._drawdown.getStatus(),
      performance:    this._performanceStats,
      kelly:          KellyCalculator.calculate(
        this._performanceStats.winRate,
        this._performanceStats.avgWin,
        this._performanceStats.avgLoss,
      ),
    };
  }

  _calcATR(candles, period = ATR_PERIOD) {
    if (!Array.isArray(candles) || candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const p = candles[i - 1];
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  RiskEngine,
  KellyCalculator,
  ATRSizer,
  CorrelationFilter,
  DrawdownGuard,
  SessionVolatilityFilter,
  DEFAULT_RISK_PCT,
  MAX_RISK_PCT,
  KELLY_FRACTION,
};
