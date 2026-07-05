/**
 * ============================================================
 *  DRAWDOWN GUARD — Elite Circuit Breaker + Equity Protection
 *  AI Trading Assistant · Layer 3 · Risk Engine
 * ============================================================
 *
 *  CIRCUIT BREAKER STATE MACHINE:
 *    CLOSED   → Normal trading, full position size
 *    WARNING  → Approaching limits, size reduced to 75%
 *    HALF     → 50% size — multiple losses or approaching daily limit
 *    OPEN     → Trading halted — limit hit
 *    COOLING  → Post-halt cooldown before recovery begins
 *    RECOVERY → Gradual size ramp back to 100% (4-step)
 *
 *  PROTECTION LAYERS:
 *    Layer 1  — Daily Loss Limit (default 3% of account)
 *    Layer 2  — Running Drawdown (peak-to-trough, default 10%)
 *    Layer 3  — Consecutive Loss Streak (default 4 in a row)
 *    Layer 4  — Win Rate Degradation (>25% drop from baseline)
 *    Layer 5  — Equity Curve Slope Filter (regression slope < 0)
 *    Layer 6  — Volatility Spike Guard (ATR spikes = reduce size)
 *    Layer 7  — Session-Based Loss Limits (per-session caps)
 *    Layer 8  — Weekly Loss Limit (default 7%)
 *    Layer 9  — Max Trades Per Day (prevent overtrading)
 *    Layer 10 — Profit Protection (lock in gains after good run)
 *
 *  EQUITY CURVE TRACKER:
 *    Linear regression slope on last N balance points
 *    Peak tracking, high watermark, variance, Sharpe ratio
 *    Max drawdown history, recovery factor, return statistics
 *
 *  WIN RATE MONITOR:
 *    Rolling window (20 trades), per-symbol, per-session, per-grade
 *    Degradation detection at 20/30/40% drops from baseline
 *    Automatic sizing reduction on degradation
 *
 *  RECOVERY MANAGER:
 *    4-step recovery: 25% → 50% → 75% → 100%
 *    2 consecutive wins per step to advance
 *    Any loss resets to step 1
 *    Deep drawdown starts at step 0
 *
 *  Events:
 *    circuit_open, circuit_warning, circuit_half, circuit_closed
 *    recovery_advance, recovery_complete, win_rate_alert
 *    equity_slope_alert, day_reset, high_watermark, profit_protection
 *    dd_update
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

const DEFAULT_MAX_DAILY_LOSS    = 3.0;
const DEFAULT_MAX_DRAWDOWN      = 10.0;
const DEFAULT_MAX_CONSEC_LOSS   = 4;
const DEFAULT_WIN_RATE_BASELINE = 0.55;
const DEFAULT_WIN_RATE_MIN_SAMPLE = 15;
const DEFAULT_WEEKLY_LOSS_LIMIT = 7.0;
const DEFAULT_MAX_TRADES_PER_DAY = 10;
const WARNING_DAILY_THRESHOLD   = 1.5;
const WARNING_DD_THRESHOLD      = 5.0;
const HALF_SIZE_CONSEC          = 2;
const RECOVERY_STEPS            = 4;
const RECOVERY_WINS_PER_STEP    = 2;
const EQUITY_SLOPE_LOOKBACK     = 20;
const EQUITY_SLOPE_THRESHOLD    = -0.001;
const VOLATILITY_SPIKE_MULT     = 2.5;
const SESSION_LOSS_LIMIT        = 2.0;

const CB_STATE = {
  CLOSED:   'CLOSED',
  WARNING:  'WARNING',
  HALF:     'HALF',
  OPEN:     'OPEN',
  COOLING:  'COOLING',
  RECOVERY: 'RECOVERY',
};

function _round(n, d = 4)  { return parseFloat((+n).toFixed(d)); }
function _avg(arr)          { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function _now()             { return Date.now(); }
function _utcDay() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function _utcWeek() {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 1));
  return mon.getTime();
}

// ─────────────────────────────────────────────
//  EQUITY CURVE TRACKER
// ─────────────────────────────────────────────

class EquityCurveTracker {
  constructor(maxPoints = 500) {
    this._points   = [];
    this._maxPoints = maxPoints;
    this._peak     = null;
    this._trough   = null;
    this._highWatermark = null;
  }

  record(balance, pnlPct, tradeId) {
    const point = { balance, pnlPct, timestamp: _now(), tradeId: tradeId || null, index: this._points.length };
    this._points.push(point);
    if (this._points.length > this._maxPoints) { this._points.shift(); this._points.forEach((p, i) => p.index = i); }

    if (this._peak === null || balance > this._peak)   this._peak = balance;
    if (this._trough === null || balance < this._trough) this._trough = balance;
    const isNewHigh = this._highWatermark === null || balance > this._highWatermark;
    if (isNewHigh) this._highWatermark = balance;
    return { isNewHigh, point };
  }

  slope(n = EQUITY_SLOPE_LOOKBACK) {
    const pts = this._points.slice(-n);
    if (pts.length < 4) return { slope: 0, r2: 0, trending: 'UNKNOWN', points: pts.length };
    const balances = pts.map(p => p.balance);
    const xMean    = (balances.length - 1) / 2;
    const yMean    = _avg(balances);
    let num = 0, den = 0;
    balances.forEach((y, x) => { num += (x - xMean) * (y - yMean); den += (x - xMean) ** 2; });
    const rawSlope  = (den !== 0 && !isNaN(den)) ? num / den : 0;
    const normSlope = (yMean !== 0 && !isNaN(yMean)) ? rawSlope / yMean : 0;
    const yhat      = balances.map((_, x) => rawSlope * x + (yMean - rawSlope * xMean));
    const ssTot     = balances.reduce((s, y) => s + (y - yMean) ** 2, 0);
    const ssRes     = balances.reduce((s, y, i) => s + (y - yhat[i]) ** 2, 0);
    const r2        = ssTot !== 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
    const trending  = normSlope > 0.002 ? 'UP' : normSlope < EQUITY_SLOPE_THRESHOLD ? 'DOWN' : 'FLAT';
    return { slope: _round(normSlope, 6), rawSlope: _round(rawSlope, 5), r2: _round(r2, 4), trending, points: pts.length };
  }

  drawdown(currentBalance) {
    if (!this._peak || currentBalance >= this._peak) return { pct: 0, absolute: 0, peak: this._peak || currentBalance, atPeak: true };
    const absolute = this._peak - currentBalance;
    const pct      = _round((absolute / this._peak) * 100, 4);
    return { pct, absolute: _round(absolute, 2), peak: _round(this._peak, 2), atPeak: false };
  }

  maxDrawdown() {
    if (this._points.length < 2) return { pct: 0, absolute: 0 };
    let peak = this._points[0].balance, maxDD = 0;
    for (const p of this._points) {
      if (p.balance > peak) peak = p.balance;
      const dd = (peak - p.balance) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    return { pct: _round(maxDD * 100, 4), absolute: _round(maxDD * peak, 2) };
  }

  sharpe(riskFreeRate = 0.02 / 252) {
    if (this._points.length < 10) return null;
    const returns = this._points.map(p => p.pnlPct / 100);
    const mean    = _avg(returns);
    const std     = Math.sqrt(_avg(returns.map(r => (r - mean) ** 2)));
    if (std === 0 || isNaN(std)) return null;
    return _round((mean - riskFreeRate) / std, 3);
  }

  recoveryFactor() {
    if (!this._points.length) return 0;
    const netGain = this._points[this._points.length - 1].balance - this._points[0].balance;
    const maxDD   = this.maxDrawdown();
    return maxDD.absolute === 0 ? Infinity : _round(netGain / maxDD.absolute, 3);
  }

  returnStats() {
    if (this._points.length < 5) return { mean: 0, std: 0, variance: 0 };
    const returns  = this._points.map(p => p.pnlPct);
    const mean     = _avg(returns);
    const variance = _avg(returns.map(r => (r - mean) ** 2));
    return { mean: _round(mean, 4), std: _round(Math.sqrt(variance), 4), variance: _round(variance, 4) };
  }

  currentStreak() {
    if (!this._points.length) return { type: 'NONE', count: 0 };
    const last = this._points[this._points.length - 1];
    const type = last.pnlPct >= 0 ? 'WIN' : 'LOSS';
    let count  = 0;
    for (let i = this._points.length - 1; i >= 0; i--) {
      const isWin = this._points[i].pnlPct >= 0;
      if ((type === 'WIN' && isWin) || (type === 'LOSS' && !isWin)) count++;
      else break;
    }
    return { type, count };
  }

  getLast(n = 20) { return this._points.slice(-n); }
  get length() { return this._points.length; }
  get peak()   { return this._peak; }
  get highWatermark() { return this._highWatermark; }
}

// ─────────────────────────────────────────────
//  WIN RATE MONITOR
// ─────────────────────────────────────────────

class WinRateMonitor {
  constructor(baseline = DEFAULT_WIN_RATE_BASELINE, window = 20) {
    this._baseline = baseline;
    this._window   = window;
    this._trades   = [];
    this._alerts   = [];
  }

  record(won, pnlR, meta = {}) {
    this._trades.push({
      won, pnlR: pnlR || 0,
      symbol:    meta.symbol  || 'UNKNOWN',
      session:   meta.session || 'UNKNOWN',
      grade:     meta.grade   || 'C',
      timestamp: _now(),
    });
  }

  rolling(n) {
    const size   = n || this._window;
    const trades = this._trades.slice(-size);
    if (!trades.length) return null;
    const wins   = trades.filter(t => t.won).length;
    const losses = trades.length - wins;
    const wr     = _round(wins / trades.length, 4);
    const avgWin  = _avg(trades.filter(t => t.won).map(t  => t.pnlR)) || 0;
    const avgLoss = Math.abs(_avg(trades.filter(t => !t.won).map(t => t.pnlR))) || 0;
    const pf      = (avgLoss > 0 && losses > 0) ? _round((avgWin * wins) / (avgLoss * losses), 3) : 0;
    return { winRate: wr, winRatePct: _round(wr * 100, 2), wins, losses, total: trades.length, avgWin: _round(avgWin, 4), avgLoss: _round(avgLoss, 4), profitFactor: pf };
  }

  degradation(threshold = 0.20) {
    const roll = this.rolling();
    if (!roll || roll.total < DEFAULT_WIN_RATE_MIN_SAMPLE) return { degraded: false, reason: `Insufficient sample (${roll?.total || 0})` };
    const drop  = (this._baseline - roll.winRate) / this._baseline;
    const level = drop >= 0.40 ? 'CRITICAL' : drop >= 0.30 ? 'SEVERE' : drop >= 0.20 ? 'MODERATE' : drop >= 0.10 ? 'MILD' : null;
    if (!level || drop < threshold) return { degraded: false, current: roll.winRatePct, baseline: _round(this._baseline * 100, 1) };
    const alert = {
      degraded: true, level, drop: _round(drop * 100, 1),
      current: roll.winRatePct, baseline: _round(this._baseline * 100, 1),
      sample: roll.total,
      reason: `Win rate ${roll.winRatePct}% — ${_round(drop*100,1)}% below baseline (${level})`,
      sizingFactor: level === 'CRITICAL' ? 0.25 : level === 'SEVERE' ? 0.50 : level === 'MODERATE' ? 0.70 : 0.85,
    };
    this._alerts.push({ ...alert, timestamp: _now() });
    return alert;
  }

  bySymbol() {
    const result = {};
    for (const t of this._trades) {
      if (!result[t.symbol]) result[t.symbol] = { wins: 0, total: 0, pnl: 0 };
      result[t.symbol].total++;
      result[t.symbol].pnl += t.pnlR;
      if (t.won) result[t.symbol].wins++;
    }
    for (const sym of Object.keys(result)) {
      const d = result[sym];
      d.winRate = _round(d.wins / d.total * 100, 2);
      d.avgPnl  = _round(d.pnl / d.total, 4);
    }
    return result;
  }

  bySession() {
    const result = {};
    for (const sess of ['LONDON', 'NEW_YORK', 'OVERLAP', 'ASIA', 'DEAD']) {
      const trades = this._trades.filter(t => t.session === sess);
      if (!trades.length) continue;
      const wins = trades.filter(t => t.won).length;
      result[sess] = {
        wins, losses: trades.length - wins, total: trades.length,
        winRate: _round(wins / trades.length * 100, 2),
        avgPnl:  _round(_avg(trades.map(t => t.pnlR)), 4),
        totalPnl: _round(trades.reduce((s, t) => s + t.pnlR, 0), 4),
      };
    }
    return result;
  }

  byGrade() {
    const result = {};
    for (const grade of ['A', 'B', 'C', 'D']) {
      const trades = this._trades.filter(t => t.grade === grade);
      if (!trades.length) continue;
      const wins = trades.filter(t => t.won).length;
      result[grade] = {
        wins, losses: trades.length - wins, total: trades.length,
        winRate: _round(wins / trades.length * 100, 2),
        avgPnl:  _round(_avg(trades.map(t => t.pnlR)), 4),
      };
    }
    return result;
  }

  getAlerts(n = 5) { return this._alerts.slice(-n); }
  get baseline()   { return this._baseline; }
  set baseline(v)  { this._baseline = v; }
  get totalTrades(){ return this._trades.length; }
}

// ─────────────────────────────────────────────
//  SESSION P&L TRACKER
// ─────────────────────────────────────────────

class SessionPnLTracker {
  constructor(limit = SESSION_LOSS_LIMIT) {
    this._limit = limit;
    this._sessions = {
      LONDON: this._new('LONDON'), NEW_YORK: this._new('NEW_YORK'),
      OVERLAP: this._new('OVERLAP'), ASIA: this._new('ASIA'), DEAD: this._new('DEAD'),
    };
    this._history = [];
  }

  _new(name) { return { name, pnl: 0, trades: 0, wins: 0, losses: 0, maxLoss: 0, limitHit: false }; }

  currentSession() {
    const h = new Date().getUTCHours();
    if (h >= 21) return 'DEAD';
    if (h < 8)   return 'ASIA';
    if (h < 13)  return 'LONDON';
    if (h < 16)  return 'OVERLAP';
    return 'NEW_YORK';
  }

  record(pnlPct, isWin, sessionOverride) {
    const session = sessionOverride || this.currentSession();
    const s       = this._sessions[session];
    if (!s) return;
    s.pnl += pnlPct; s.trades++;
    if (isWin) s.wins++; else s.losses++;
    if (pnlPct < s.maxLoss) s.maxLoss = pnlPct;
    if (s.pnl <= -this._limit && !s.limitHit) s.limitHit = true;
    return { session, limitHit: s.limitHit, sessionPnl: _round(s.pnl, 4) };
  }

  isSessionLimited() {
    const s = this._sessions[this.currentSession()];
    return s?.limitHit || false;
  }

  sessionSizingFactor() {
    const s = this._sessions[this.currentSession()];
    if (!s) return 1.0;
    if (s.limitHit)                       return 0;
    if (s.pnl <= -this._limit * 0.70)     return 0.5;
    if (s.pnl <= -this._limit * 0.50)     return 0.75;
    return 1.0;
  }

  worstSession() {
    let worst = null;
    for (const [name, s] of Object.entries(this._sessions)) {
      if (s.trades < 5) continue;
      const wr = s.wins / s.trades;
      if (!worst || wr < worst.wr) worst = { session: name, wr, ...s };
    }
    return worst;
  }

  bestSession() {
    let best = null;
    for (const [name, s] of Object.entries(this._sessions)) {
      if (s.trades < 5) continue;
      const wr = s.wins / s.trades;
      if (!best || wr > best.wr) best = { session: name, wr, ...s };
    }
    return best;
  }

  resetDaily() {
    this._history.push({ date: new Date().toUTCString(), sessions: JSON.parse(JSON.stringify(this._sessions)) });
    if (this._history.length > 30) this._history.shift();
    for (const key of Object.keys(this._sessions)) this._sessions[key] = this._new(key);
  }

  getAll() {
    const result = {};
    for (const [name, s] of Object.entries(this._sessions)) {
      result[name] = { ...s, winRate: s.trades > 0 ? _round(s.wins / s.trades * 100, 2) : null };
    }
    return result;
  }

  getHistory(n = 7) { return this._history.slice(-n); }
}

// ─────────────────────────────────────────────
//  RECOVERY MANAGER
// ─────────────────────────────────────────────

class RecoveryManager {
  constructor(steps = RECOVERY_STEPS, winsNeeded = RECOVERY_WINS_PER_STEP) {
    this._steps      = steps;
    this._winsNeeded = winsNeeded;
    this._step       = steps;
    this._inRecovery = false;
    this._consecWins = 0;
    this._history    = [];
    this._ddDepth    = 0;
  }

  startRecovery(ddDepth = 0) {
    this._inRecovery = true;
    this._ddDepth    = ddDepth;
    this._consecWins = 0;
    this._step       = ddDepth >= 8 ? 0 : 1;
    this._log('RECOVERY_STARTED', `DD ${ddDepth}%, step ${this._step}/${this._steps}`);
  }

  onWin() {
    if (!this._inRecovery) return;
    this._consecWins++;
    if (this._consecWins >= this._winsNeeded && this._step < this._steps) {
      this._step++; this._consecWins = 0;
      this._log('RECOVERY_ADVANCE', `Step ${this._step}/${this._steps} — ${this.factor()*100}% size`);
      if (this._step >= this._steps) { this._inRecovery = false; this._log('RECOVERY_COMPLETE', 'Full size'); return 'COMPLETE'; }
      return 'ADVANCE';
    }
    return 'WIN';
  }

  onLoss() {
    if (!this._inRecovery) return;
    const prev = this._step;
    this._step = 1; this._consecWins = 0;
    this._log('RECOVERY_RESET', `Reset from step ${prev} to 1`);
    return 'RESET';
  }

  factor() {
    if (!this._inRecovery) return 1.0;
    if (this._step === 0)  return 0;
    return _round(this._step / this._steps, 2);
  }

  get inRecovery() { return this._inRecovery; }
  get step()       { return this._step; }
  get totalSteps() { return this._steps; }

  status() {
    return {
      inRecovery: this._inRecovery,
      step:       this._step,
      totalSteps: this._steps,
      factor:     this.factor(),
      consecWins: this._consecWins,
      winsToAdvance: Math.max(0, this._winsNeeded - this._consecWins),
      label: this._inRecovery
        ? `Recovery ${this._step}/${this._steps} — ${this.factor()*100}% size (${Math.max(0,this._winsNeeded-this._consecWins)} wins to advance)`
        : 'Full size — not in recovery',
    };
  }

  _log(event, note) {
    this._history.push({ event, note, step: this._step, timestamp: _now() });
    if (this._history.length > 50) this._history.shift();
  }

  getHistory(n = 20) { return this._history.slice(-n); }
}

// ─────────────────────────────────────────────
//  PROFIT PROTECTION ENGINE
// ─────────────────────────────────────────────

class ProfitProtection {
  constructor(config = {}) {
    this._levels = config.levels || [
      { pct: 1.5, factor: 0.75, label: 'Profit mode: 75% size' },
      { pct: 2.5, factor: 0.50, label: 'Profit mode: 50% size' },
      { pct: 4.0, factor: 0.00, label: 'Profit target hit: stop trading today' },
    ];
    this._dailyPnl    = 0;
    this._activeLevel = null;
    this._triggered   = [];
  }

  update(dailyPnl) {
    this._dailyPnl = dailyPnl;
    let activeLevel = null;
    for (const level of this._levels) {
      if (dailyPnl >= level.pct) activeLevel = level;
    }
    if (activeLevel && (!this._activeLevel || activeLevel.pct > this._activeLevel.pct)) {
      const isNew = !this._activeLevel || activeLevel.pct !== this._activeLevel.pct;
      this._activeLevel = activeLevel;
      if (isNew) this._triggered.push({ ...activeLevel, dailyPnl, timestamp: _now() });
      return { triggered: true, isNew, level: activeLevel };
    }
    return { triggered: false, level: null };
  }

  factor()  { return this._activeLevel ? this._activeLevel.factor : 1.0; }
  reset()   { this._dailyPnl = 0; this._activeLevel = null; }

  status() {
    return {
      dailyPnl:    _round(this._dailyPnl, 4),
      activeLevel: this._activeLevel,
      factor:      this.factor(),
      triggered:   this._triggered.slice(-5),
    };
  }
}

// ─────────────────────────────────────────────
//  VOLATILITY GUARD
// ─────────────────────────────────────────────

class VolatilityGuard {
  constructor(baselineWindow = 50, spikeMult = VOLATILITY_SPIKE_MULT) {
    this._window      = baselineWindow;
    this._spikeMult   = spikeMult;
    this._atrHistory  = [];
    this._currentATR  = null;
  }

  update(atr, price) {
    if (!atr || !price) return { factor: 1.0, isSpike: false };
    const atrPct = atr / price;
    this._currentATR = atrPct;
    this._atrHistory.push(atrPct);
    if (this._atrHistory.length > this._window) this._atrHistory.shift();

    const avgATR = _avg(this._atrHistory);
    const ratio  = avgATR > 0 ? atrPct / avgATR : 1;
    let factor = 1.0, isSpike = false;

    if (ratio >= this._spikeMult * 1.5) { factor = 0.25; isSpike = true; }
    else if (ratio >= this._spikeMult)   { factor = 0.50; isSpike = true; }
    else if (ratio >= this._spikeMult * 0.75) { factor = 0.75; }

    return {
      factor, isSpike,
      atrPct:    _round(atrPct * 100, 4),
      avgAtrPct: _round(avgATR * 100, 4),
      ratio:     _round(ratio, 3),
      note: isSpike ? `ATR spike ${_round(ratio,1)}x normal — reducing to ${factor*100}%` : 'Normal volatility',
    };
  }

  isCalibrated() { return this._atrHistory.length >= 10; }
  currentRatio() {
    if (!this._currentATR || !this._atrHistory.length) return 1;
    const avg = _avg(this._atrHistory);
    return avg > 0 ? _round(this._currentATR / avg, 3) : 1;
  }
}

// ─────────────────────────────────────────────
//  TRADE LOG
// ─────────────────────────────────────────────

class TradeLog {
  constructor(maxEntries = 1000) { this._log = []; this._max = maxEntries; }

  add(entry) {
    this._log.push({ ...entry, loggedAt: _now() });
    if (this._log.length > this._max) this._log.shift();
  }

  getLast(n = 20) { return this._log.slice(-n).reverse(); }

  getToday() {
    const midnight = _utcDay();
    return this._log.filter(e => e.loggedAt >= midnight);
  }

  getThisWeek() {
    const weekStart = _utcWeek();
    return this._log.filter(e => e.loggedAt >= weekStart);
  }

  getDailyStats() {
    const today = this.getToday();
    const wins  = today.filter(t => t.pnlPct > 0).length;
    const pnl   = today.reduce((s, t) => s + (t.pnlPct || 0), 0);
    return { trades: today.length, wins, losses: today.length - wins, winRate: today.length > 0 ? _round(wins / today.length * 100, 2) : 0, totalPnl: _round(pnl, 4) };
  }

  getWeeklyStats() {
    const week = this.getThisWeek();
    const wins = week.filter(t => t.pnlPct > 0).length;
    const pnl  = week.reduce((s, t) => s + (t.pnlPct || 0), 0);
    return { trades: week.length, wins, losses: week.length - wins, winRate: week.length > 0 ? _round(wins / week.length * 100, 2) : 0, totalPnl: _round(pnl, 4) };
  }

  get size() { return this._log.length; }
}

// ─────────────────────────────────────────────
//  MAIN DRAWDOWN GUARD
// ─────────────────────────────────────────────

class DrawdownGuard extends EventEmitter {
  constructor(config = {}) {
    super();

    this._maxDailyLoss  = config.maxDailyLossPct       || DEFAULT_MAX_DAILY_LOSS;
    this._maxDrawdown   = config.maxDrawdownPct         || DEFAULT_MAX_DRAWDOWN;
    this._maxConsecLoss = config.maxConsecutiveLoss     || DEFAULT_MAX_CONSEC_LOSS;
    this._warnDaily     = config.warningDailyPct        || WARNING_DAILY_THRESHOLD;
    this._warnDD        = config.warningDrawdownPct     || WARNING_DD_THRESHOLD;
    this._weeklyLimit   = config.weeklyLossLimitPct     || DEFAULT_WEEKLY_LOSS_LIMIT;
    this._maxTradesDay  = config.maxTradesPerDay        || DEFAULT_MAX_TRADES_PER_DAY;
    this._useEqFilter   = config.equityCurveFilter      !== false;
    this._useVolGuard   = config.volatilityGuard        !== false;
    this._useProfitProt = config.profitProtection       !== false;

    this._equity     = new EquityCurveTracker();
    this._winRate    = new WinRateMonitor(config.baselineWinRate || DEFAULT_WIN_RATE_BASELINE);
    this._sessions   = new SessionPnLTracker(config.sessionLossLimitPct || SESSION_LOSS_LIMIT);
    this._recovery   = new RecoveryManager();
    this._volGuard   = new VolatilityGuard();
    this._profitProt = new ProfitProtection(config.profitLevels ? { levels: config.profitLevels } : {});
    this._tradeLog   = new TradeLog();

    this._cbState    = CB_STATE.CLOSED;
    this._cbReason   = null;
    this._cbOpenedAt = null;
    this._cbHistory  = [];

    this._dailyPnl    = 0;
    this._weeklyPnl   = 0;
    this._dailyTrades = 0;
    this._consecLoss  = 0;
    this._balance     = null;
    this._dayStart    = _utcDay();
    this._weekStart   = _utcWeek();
    this._paused      = false;
    this._pauseReason = null;
    this._eventLog    = [];

    this._scheduleMidnightReset();
    this._log('DrawdownGuard initialized', { maxDaily: this._maxDailyLoss, maxDD: this._maxDrawdown });
  }

  // ─── RECORD TRADE ───

  record({ pnlPct, balance, won, symbol, signalId, grade, pnlR, session }) {
    const today = _utcDay(); const week = _utcWeek();
    if (today > this._dayStart)  this._rollDay();
    if (week  > this._weekStart) this._rollWeek();

    if (balance != null) this._balance = balance;
    this._dailyPnl   += pnlPct;
    this._weeklyPnl  += pnlPct;
    this._dailyTrades++;
    this._consecLoss  = won ? 0 : this._consecLoss + 1;

    const eqResult = this._equity.record(balance || (this._balance || 10000), pnlPct, signalId);
    if (eqResult.isNewHigh) this.emit('high_watermark', { balance, timestamp: _now() });

    this._winRate.record(won, pnlR || 0, { symbol, session: session || this._sessions.currentSession(), grade });
    const sessResult = this._sessions.record(pnlPct, won, session);

    if (this._useProfitProt) {
      const pp = this._profitProt.update(this._dailyPnl);
      if (pp.triggered && pp.isNew) {
        this.emit('profit_protection', pp.level);
        this._logEvent('PROFIT_PROTECTION', pp.level?.label);
      }
    }

    if (this._recovery.inRecovery) {
      const rr = won ? this._recovery.onWin() : this._recovery.onLoss();
      if (rr === 'COMPLETE') { this.emit('recovery_complete', { balance, timestamp: _now() }); this._logEvent('RECOVERY_COMPLETE', 'Full size'); }
      else if (rr === 'ADVANCE') { this.emit('recovery_advance', this._recovery.status()); }
    }

    this._tradeLog.add({
      signalId, symbol, grade, session: sessResult?.session,
      pnlPct: _round(pnlPct, 4), pnlR, won,
      balance: balance ? _round(balance, 2) : null,
      dailyPnl: _round(this._dailyPnl, 4), weeklyPnl: _round(this._weeklyPnl, 4),
      drawdown: balance ? this._equity.drawdown(balance).pct : 0,
      consecLoss: this._consecLoss,
    });

    this._evaluateCB(balance);
    const status = this.getStatus();
    this.emit('dd_update', { ...status, tradeResult: { pnlPct, won, pnlR } });
    return status;
  }

  // ─── EVALUATE (before new trade) ───

  evaluate(opts = {}) {
    const warnings = [];

    if (this._cbState === CB_STATE.OPEN) {
      return { allowed: false, sizingFactor: 0, reason: `Circuit breaker OPEN: ${this._cbReason}`, state: this._cbState, warnings };
    }

    if (this._paused) {
      return { allowed: false, sizingFactor: 0, reason: `Manual pause: ${this._pauseReason || 'paused'}`, state: 'PAUSED', warnings };
    }

    if (this._sessions.isSessionLimited()) {
      return { allowed: false, sizingFactor: 0, reason: `Session loss limit hit (${this._sessions.currentSession()})`, state: CB_STATE.OPEN, warnings };
    }

    if (this._dailyTrades >= this._maxTradesDay) {
      return { allowed: false, sizingFactor: 0, reason: `Max trades/day reached (${this._dailyTrades}/${this._maxTradesDay})`, state: CB_STATE.OPEN, warnings };
    }

    if (this._useProfitProt && this._profitProt.factor() === 0) {
      return { allowed: false, sizingFactor: 0, reason: `Daily profit target hit (+${this._dailyPnl}%) — stop trading`, state: 'PROFIT_PROTECTED', warnings };
    }

    let sizingFactor = 1.0;

    sizingFactor = Math.min(sizingFactor, this._cbStateFactor());

    if (this._recovery.inRecovery) {
      sizingFactor = Math.min(sizingFactor, this._recovery.factor());
      warnings.push(this._recovery.status().label);
    }

    if (this._useProfitProt) {
      const ppf = this._profitProt.factor();
      if (ppf < 1) { sizingFactor = Math.min(sizingFactor, ppf); warnings.push(this._profitProt._activeLevel?.label); }
    }

    const sessFactor = this._sessions.sessionSizingFactor();
    if (sessFactor < 1) { sizingFactor = Math.min(sizingFactor, sessFactor); warnings.push(`${this._sessions.currentSession()} approaching session limit`); }

    const wrDeg = this._winRate.degradation(0.20);
    if (wrDeg.degraded) { sizingFactor = Math.min(sizingFactor, wrDeg.sizingFactor); warnings.push(wrDeg.reason); }

    if (this._useEqFilter && this._equity.length >= EQUITY_SLOPE_LOOKBACK) {
      const slope = this._equity.slope();
      if (slope.trending === 'DOWN' && slope.r2 >= 0.6) {
        sizingFactor = Math.min(sizingFactor, 0.5);
        warnings.push(`Equity curve trending DOWN (slope: ${slope.slope}, R²: ${slope.r2})`);
        this.emit('equity_slope_alert', slope);
      }
    }

    if (this._useVolGuard && opts.atr && opts.price) {
      const vol = this._volGuard.update(opts.atr, opts.price);
      if (vol.factor < 1) { sizingFactor = Math.min(sizingFactor, vol.factor); warnings.push(vol.note); }
    }

    if (this._dailyPnl < 0) {
      const remaining = this._maxDailyLoss + this._dailyPnl;
      if (remaining < 0.5) { sizingFactor = Math.min(sizingFactor, 0.25); warnings.push(`Daily PnL ${_round(this._dailyPnl,2)}% — only ${_round(remaining,2)}% cushion`); }
      else if (remaining < 1.0) { sizingFactor = Math.min(sizingFactor, 0.5); warnings.push(`Approaching daily limit: ${_round(this._dailyPnl,2)}%`); }
    }

    const finalFactor = _round(Math.max(0, sizingFactor), 2);
    return {
      allowed:      true,
      sizingFactor: finalFactor,
      reason:       finalFactor < 1 ? `Sizing ${(finalFactor*100).toFixed(0)}% — ${warnings[0] || 'risk mgmt'}` : 'Normal sizing',
      state:        this._cbState,
      warnings,
      dailyPnl:     _round(this._dailyPnl, 4),
      weeklyPnl:    _round(this._weeklyPnl, 4),
      consecLoss:   this._consecLoss,
      dailyTrades:  this._dailyTrades,
    };
  }

  // ─── CIRCUIT BREAKER ───

  _evaluateCB(balance) {
    const prevState = this._cbState;
    const dd        = balance ? this._equity.drawdown(balance) : { pct: 0 };

    if      (this._dailyPnl  <= -this._maxDailyLoss)  this._openCB(`Daily loss: ${_round(this._dailyPnl,2)}% (limit: ${this._maxDailyLoss}%)`);
    else if (dd.pct           >= this._maxDrawdown)    this._openCB(`Max drawdown: ${_round(dd.pct,2)}% (limit: ${this._maxDrawdown}%)`);
    else if (this._consecLoss >= this._maxConsecLoss)  this._openCB(`${this._consecLoss} consecutive losses (limit: ${this._maxConsecLoss})`);
    else if (this._weeklyPnl  <= -this._weeklyLimit)   this._openCB(`Weekly loss: ${_round(this._weeklyPnl,2)}% (limit: ${this._weeklyLimit}%)`);
    else if (this._dailyPnl <= -this._maxDailyLoss * 0.67 || dd.pct >= this._warnDD * 1.5 || this._consecLoss >= HALF_SIZE_CONSEC + 1) {
      if (this._cbState === CB_STATE.CLOSED || this._cbState === CB_STATE.WARNING) this._setCBState(CB_STATE.HALF, 'Approaching limits — half-size');
    } else if (this._dailyPnl <= -this._warnDaily || dd.pct >= this._warnDD || this._consecLoss >= HALF_SIZE_CONSEC) {
      if (this._cbState === CB_STATE.CLOSED) this._setCBState(CB_STATE.WARNING, this._buildWarnReason(dd));
    } else if (this._cbState === CB_STATE.WARNING && this._dailyPnl > -this._warnDaily * 0.5 && dd.pct < this._warnDD * 0.5 && this._consecLoss === 0) {
      this._setCBState(CB_STATE.CLOSED, 'Conditions normalized');
    }

    if (prevState !== this._cbState) {
      if (this._cbState === CB_STATE.OPEN) {
        this.emit('circuit_open', { reason: this._cbReason, dailyPnl: this._dailyPnl, drawdown: dd.pct });
        this._logEvent('CIRCUIT_OPEN', this._cbReason);
      } else if (this._cbState === CB_STATE.HALF) {
        this.emit('circuit_half', { reason: this._cbReason });
      } else if (this._cbState === CB_STATE.WARNING) {
        this.emit('circuit_warning', { reason: this._cbReason });
      } else if (this._cbState === CB_STATE.CLOSED) {
        this.emit('circuit_closed', { reason: 'Normalized' });
      }
    }

    return { state: this._cbState, changed: prevState !== this._cbState };
  }

  _openCB(reason) {
    if (this._cbState === CB_STATE.OPEN) return;
    this._setCBState(CB_STATE.OPEN, reason);
    this._cbOpenedAt = _now();
  }

  _setCBState(state, reason) {
    this._cbState = state; this._cbReason = reason;
    this._cbHistory.push({ state, reason, timestamp: _now() });
    if (this._cbHistory.length > 100) this._cbHistory.shift();
  }

  _cbStateFactor() {
    switch (this._cbState) {
      case CB_STATE.CLOSED:   return 1.00;
      case CB_STATE.WARNING:  return 0.75;
      case CB_STATE.HALF:     return 0.50;
      case CB_STATE.RECOVERY: return this._recovery.factor();
      case CB_STATE.OPEN:
      case CB_STATE.COOLING:  return 0.00;
      default:                return 1.00;
    }
  }

  _buildWarnReason(dd) {
    const parts = [];
    if (this._dailyPnl <= -this._warnDaily) parts.push(`Daily PnL: ${_round(this._dailyPnl,2)}%`);
    if (dd.pct >= this._warnDD)             parts.push(`Drawdown: ${_round(dd.pct,2)}%`);
    if (this._consecLoss >= 2)              parts.push(`${this._consecLoss} consec losses`);
    return `Warning: ${parts.join(' | ')}`;
  }

  // ─── PUBLIC CONTROLS ───

  manualReset(reason = 'Manual reset') {
    if (this._cbState !== CB_STATE.OPEN) {
      this._setCBState(CB_STATE.CLOSED, 'Cleared by user');
      this.emit('circuit_closed', { reason });
      return true;
    }
    const dd = this._balance ? this._equity.drawdown(this._balance) : { pct: 0 };
    this._setCBState(CB_STATE.RECOVERY, 'Recovery after reset');
    this._recovery.startRecovery(dd.pct);
    this._consecLoss = 0;
    this.emit('circuit_closed', { reason, recoveryStarted: true });
    this._logEvent('MANUAL_RESET', reason);
    return true;
  }

  pause(reason = 'Paused by user') {
    this._paused = true; this._pauseReason = reason;
    this.emit('circuit_open', { reason: `PAUSED: ${reason}` });
    this._logEvent('PAUSED', reason);
  }

  resume(reason = 'Resumed') {
    this._paused = false; this._pauseReason = null;
    this.emit('circuit_closed', { reason });
    this._logEvent('RESUMED', reason);
  }

  updateBalance(balance) {
    this._balance = balance;
    this._equity.record(balance, 0, 'BALANCE_UPDATE');
  }

  updateVolatility(atr, price) {
    return this._useVolGuard ? this._volGuard.update(atr, price) : null;
  }

  updateBaseline(winRate) { this._winRate.baseline = winRate; }

  // ─── DAY/WEEK ROLLOVER ───

  _rollDay() {
    this._logEvent('DAY_RESET', `PnL: ${_round(this._dailyPnl,2)}%, Trades: ${this._dailyTrades}`);
    this._dailyPnl = 0; this._dailyTrades = 0; this._dayStart = _utcDay();
    this._consecLoss = 0;
    this._sessions.resetDaily();
    this._profitProt.reset();
    if (this._cbState === CB_STATE.WARNING || this._cbState === CB_STATE.HALF) {
      this._setCBState(CB_STATE.CLOSED, 'New day reset');
    }
    this.emit('day_reset', { date: new Date().toUTCString() });
  }

  _rollWeek() {
    this._logEvent('WEEK_RESET', `Weekly PnL: ${_round(this._weeklyPnl,2)}%`);
    this._weeklyPnl = 0; this._weekStart = _utcWeek();
  }

  _scheduleMidnightReset() {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const timer = setTimeout(() => {
      this._rollDay();
      const interval = setInterval(() => this._rollDay(), 24*60*60*1000);
      interval.unref?.();
    }, midnight - now);
    timer.unref?.();
  }

  // ─── STATUS ───

  getStatus() {
    const dd         = this._balance ? this._equity.drawdown(this._balance) : { pct: 0, absolute: 0 };
    const slope      = this._equity.length >= 5 ? this._equity.slope() : null;
    const wrRolling  = this._winRate.rolling();
    const wrDeg      = this._winRate.degradation();
    const dailyStats = this._tradeLog.getDailyStats();
    const weekStats  = this._tradeLog.getWeeklyStats();

    return {
      circuitBreaker: {
        state: this._cbState, reason: this._cbReason,
        isOpen: this._cbState === CB_STATE.OPEN, isHalf: this._cbState === CB_STATE.HALF,
        isWarning: this._cbState === CB_STATE.WARNING, isPaused: this._paused,
        factor: this._cbStateFactor(), openedAt: this._cbOpenedAt,
        history: this._cbHistory.slice(-5),
      },
      daily: {
        pnl: _round(this._dailyPnl, 4), trades: this._dailyTrades,
        limit: this._maxDailyLoss, remaining: _round(this._maxDailyLoss + this._dailyPnl, 4),
        usedPct: _round(Math.abs(Math.min(this._dailyPnl, 0)) / this._maxDailyLoss * 100, 2),
        stats: dailyStats,
      },
      weekly: {
        pnl: _round(this._weeklyPnl, 4), limit: this._weeklyLimit,
        remaining: _round(this._weeklyLimit + this._weeklyPnl, 4), stats: weekStats,
      },
      drawdown: {
        current: _round(dd.pct, 4), absolute: dd.absolute, peak: dd.peak,
        max: this._equity.maxDrawdown(), limit: this._maxDrawdown,
      },
      consecLoss: this._consecLoss,
      currentStreak: this._equity.currentStreak(),
      winRate: {
        rolling: wrRolling, baseline: _round(this._winRate.baseline * 100, 1),
        degraded: wrDeg.degraded, degradation: wrDeg.degraded ? wrDeg : null,
        bySession: this._winRate.bySession(), bySymbol: this._winRate.bySymbol(),
        byGrade: this._winRate.byGrade(),
      },
      equityCurve: {
        slope: slope, highWatermark: this._equity.highWatermark,
        peak: this._equity.peak, sharpe: this._equity.sharpe(),
        recoveryFactor: this._equity.recoveryFactor(),
        returnStats: this._equity.returnStats(),
      },
      recovery: this._recovery.status(),
      sessions: this._sessions.getAll(),
      profitProtection: this._useProfitProt ? this._profitProt.status() : null,
      volatility: this._useVolGuard ? { ratio: this._volGuard.currentRatio(), calibrated: this._volGuard.isCalibrated() } : null,
      netSizingFactor: this.evaluate().sizingFactor,
      balance: this._balance ? _round(this._balance, 2) : null,
    };
  }

  getTradeLog(n = 20) { return this._tradeLog.getLast(n); }
  getCBHistory(n = 10) { return this._cbHistory.slice(-n); }

  isPaused() {
    return {
      paused: this._cbState === CB_STATE.OPEN || this._paused,
      reason: this._paused ? this._pauseReason : this._cbReason,
      state: this._paused ? 'PAUSED' : this._cbState,
    };
  }

  recordSignal(signal = {}) {
    this._dailyTrades++;
    this._logEvent('SIGNAL_RECORDED', `${signal.action || 'SIGNAL'} ${signal.symbol || 'UNKNOWN'} ${signal.score?.final || ''}`.trim());
    return this.getStatus();
  }

  getDailyReport() {
    return {
      date: new Date(_utcDay()).toUTCString(),
      dailyPnl: _round(this._dailyPnl, 4), trades: this._dailyTrades,
      sessions: this._sessions.getAll(), winRate: this._winRate.rolling(),
      streak: this._equity.currentStreak(),
      cbEvents: this._cbHistory.filter(e => e.timestamp >= _utcDay()),
    };
  }

  _logEvent(type, note) {
    const entry = { type, note, state: this._cbState, timestamp: _now() };
    this._eventLog.push(entry);
    if (this._eventLog.length > 200) this._eventLog.shift();
    console.log(`[DrawdownGuard] ${type}: ${note}`);
  }

  _log(msg, data) {
    data ? console.log(`[DrawdownGuard] ${msg}`, data) : console.log(`[DrawdownGuard] ${msg}`);
  }
}

module.exports = {
  DrawdownGuard, EquityCurveTracker, WinRateMonitor, SessionPnLTracker,
  RecoveryManager, ProfitProtection, VolatilityGuard, TradeLog,
  CB_STATE, DEFAULT_MAX_DAILY_LOSS, DEFAULT_MAX_DRAWDOWN,
  DEFAULT_MAX_CONSEC_LOSS, DEFAULT_WIN_RATE_BASELINE,
  RECOVERY_STEPS, SESSION_LOSS_LIMIT,
};
