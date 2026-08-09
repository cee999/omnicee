
'use strict';

const EventEmitter = require('events');

const EXECUTION_MODE = {
  MANUAL:    'MANUAL',
  SEMI_AUTO: 'SEMI_AUTO',
};

const POSITION_STATE = {
  PENDING:    'PENDING',
  WATCHING:   'WATCHING',
  ENTERED:    'ENTERED',
  TP1_HIT:    'TP1_HIT',
  TP2_HIT:    'TP2_HIT',
  TP3_HIT:    'TP3_HIT',
  SL_HIT:     'SL_HIT',
  BREAKEVEN:  'BREAKEVEN',
  MANUAL_CLOSE: 'MANUAL_CLOSE',
  EXPIRED:    'EXPIRED',
  SKIPPED:    'SKIPPED',
};

const SIGNAL_STATE = {
  ACTIVE:   'ACTIVE',
  TAKEN:    'TAKEN',
  SKIPPED:  'SKIPPED',
  EXPIRED:  'EXPIRED',
  WATCHING: 'WATCHING',
};

const TRAIL_ATR_MULT     = 2.0;
const MAX_SIGNAL_AGE_MS  = 4 * 60 * 60 * 1000;
const PRICE_CHECK_INTERVAL = 10 * 1000;
const MAX_OPEN_POSITIONS = 5;

function _round(n, d = 5)  { return parseFloat((+n).toFixed(d)); }
function _now()            { return Date.now(); }

// FIX: getStats() broke performance down by symbol/session/grade but never by what kind of setupfired — in a multi-agent system, "setup type" is naturally "which agent's read was the dominant driver of...
function _dominantSetup(signal) {
  const breakdown = signal?.agentBreakdown;
  if (!Array.isArray(breakdown) || !breakdown.length) return 'UNKNOWN';
  const confirming = breakdown.filter(b => b.status === 'CONFIRMS');
  const pool = confirming.length ? confirming : breakdown;
  const top = pool.reduce((best, b) =>
    (b.contribution || 0) > (best?.contribution || -Infinity) ? b : best, null);
  return top?.agent || top?.label || 'UNKNOWN';
}
function _uuid()           {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}
function _pct(a, b)        { return b !== 0 ? Math.abs(a - b) / b * 100 : 0; }

class Position {
  constructor(signal, entryData, mode) {
    this.id            = `POS-${_uuid()}`;
    this.signalId      = signal.id;
    this.symbol        = signal.symbol;
    this.timeframe     = signal.timeframe;
    this.direction     = signal.action;
    this.mode          = mode;
    this.grade         = signal.score?.grade;
    this.signalScore   = signal.score?.final;
    this.session       = signal.session?.current || signal.session;

    this.entryPrice    = entryData.entryPrice   || signal.entry?.midPoint   || signal.currentPrice;
    this.size          = entryData.size         || signal.positionSize      || 1;
    this.dollarRisk    = entryData.dollarRisk   || signal.risk?.dollarRisk  || null;
    this.riskPct       = entryData.riskPct      || signal.stopLoss?.riskPct || 1;

    this.initialSL     = signal.stopLoss?.price || entryData.sl;
    this.currentSL     = this.initialSL;
    this.tp1           = signal.targets?.tp1?.price || entryData.tp1;
    this.tp2           = signal.targets?.tp2?.price || entryData.tp2;
    this.tp3           = signal.targets?.tp3?.price || entryData.tp3;
    this.tp1RR         = signal.targets?.tp1?.rr || null;
    this.tp2RR         = signal.targets?.tp2?.rr || null;
    this.tp3RR         = signal.targets?.tp3?.rr || null;

    this.state         = POSITION_STATE.ENTERED;
    this.openedAt      = _now();
    this.closedAt      = null;

    this.sizeRemaining = 1.0;
    this.beSet         = false;
    this.tp1Closed     = false;
    this.tp2Closed     = false;
    this.manualSLMoves = 0;
    this.trailActive   = false;

    this.currentPrice  = this.entryPrice;
    this.unrealizedPnlR = 0;
    this.realizedPnlR  = 0;
    this.totalPnlR     = 0;
    this.mae           = 0;
    this.mfe           = 0;
    this.highestPrice  = this.entryPrice;
    this.lowestPrice   = this.entryPrice;

    this.log           = [{
      event: 'OPENED',
      price: this.entryPrice,
      note:  `Position opened at ${this.entryPrice}`,
      timestamp: _now(),
    }];

    this.exchangeOrderId  = entryData.orderId   || null;
    this.slOrderId        = entryData.slOrderId || null;
    this.partialCloses    = [];
  }

  onPrice(price, atr) {
    if (this.state === POSITION_STATE.SL_HIT ||
        this.state === POSITION_STATE.TP3_HIT ||
        this.state === POSITION_STATE.MANUAL_CLOSE) return [];

    const actions  = [];
    const isLong   = this.direction === 'LONG';
    // FIX: was computed from this.currentSL, which moves to breakeven/TP1 as the trade progresses.
    const riskPts  = Math.abs(this.entryPrice - this.initialSL);

    this.currentPrice = price;

    if (isLong) {
      if (price > this.highestPrice) {
        this.highestPrice = price;
        this.mfe = _round((price - this.entryPrice) / (riskPts || 1), 3);
      }
      if (price < this.lowestPrice) {
        this.lowestPrice = price;
        this.mae = _round((this.entryPrice - price) / (riskPts || 1), 3);
      }
    } else {
      if (price < this.lowestPrice) {
        this.lowestPrice = price;
        this.mfe = _round((this.entryPrice - price) / (riskPts || 1), 3);
      }
      if (price > this.highestPrice) {
        this.highestPrice = price;
        this.mae = _round((price - this.entryPrice) / (riskPts || 1), 3);
      }
    }

    this.unrealizedPnlR = _round(
      isLong
        ? (price - this.entryPrice) / (riskPts || 1)
        : (this.entryPrice - price) / (riskPts || 1),
      3
    );
    this.totalPnlR = _round(this.realizedPnlR + this.unrealizedPnlR * this.sizeRemaining, 3);

    const slHit = isLong ? price <= this.currentSL : price >= this.currentSL;
    if (slHit) {
      const finalPnl = _round(
        isLong
          ? (this.currentSL - this.entryPrice) / (riskPts || 1)
          : (this.entryPrice - this.currentSL) / (riskPts || 1),
        3
      );
      this.state        = POSITION_STATE.SL_HIT;
      this.closedAt     = _now();
      this.totalPnlR    = _round(this.realizedPnlR + finalPnl * this.sizeRemaining, 3);
      this.sizeRemaining = 0;

      actions.push({
        type:       'SL_HIT',
        price:      this.currentSL,
        pnlR:       finalPnl,
        totalPnlR:  this.totalPnlR,
        wasBreakeven: this.beSet,
        note:       this.beSet
          ? `SL hit at breakeven (${this.currentSL}) — no loss`
          : `Stop loss hit at ${this.currentSL} — loss: ${finalPnl}R`,
      });
      this._log('SL_HIT', price, `SL hit at ${this.currentSL}`);
      return actions;
    }

    // ── TP3 Hit ── FIX: was `if (!this.tp2Closed && this.tp3)` — the outer guard required tp2Closed to be FALSE to even enter this block, but the inner condition immediately below required tp1Closed &&...
    if (this.tp2Closed && this.tp3) {
      const tp3Hit = isLong ? price >= this.tp3 : price <= this.tp3;
      if (tp3Hit && this.tp1Closed && this.tp2Closed) {
        this.state = POSITION_STATE.TP3_HIT;
        this.closedAt = _now();
        const finalPnl = _round(this.tp3RR || (Math.abs(this.tp3 - this.entryPrice) / (riskPts || 1)), 3);
        this.realizedPnlR += finalPnl * this.sizeRemaining;
        this.totalPnlR     = _round(this.realizedPnlR, 3);
        this.sizeRemaining = 0;
        actions.push({
          type: 'TP3_HIT', price: this.tp3, pnlR: finalPnl,
          totalPnlR: this.totalPnlR, note: `TP3 hit at ${this.tp3} — all targets reached`,
        });
        this._log('TP3_HIT', price, `TP3 hit at ${this.tp3}`);
        return actions;
      }
    }

    if (this.tp1Closed && !this.tp2Closed && this.tp2) {
      const tp2Hit = isLong ? price >= this.tp2 : price <= this.tp2;
      if (tp2Hit) {
        this.state    = POSITION_STATE.TP2_HIT;
        this.tp2Closed = true;
        const pnlR    = _round(this.tp2RR || (Math.abs(this.tp2 - this.entryPrice) / (riskPts || 1)), 3);
        const closePct = 0.30;
        this.realizedPnlR  += pnlR * closePct;
        this.sizeRemaining -= closePct;

        const newSL = isLong ? this.tp1 : this.tp1;
        const prevSL = this.currentSL;
        this.currentSL  = newSL;
        this.trailActive = true;

        actions.push({
          type:      'TP2_HIT',
          price:     this.tp2,
          pnlR,
          closePct:  30,
          newSL,
          prevSL,
          remaining: _round(this.sizeRemaining, 2),
          note:      `TP2 hit at ${this.tp2} (${pnlR}R) — closed 30%, SL moved to TP1 (${newSL})`,
        });
        this._log('TP2_HIT', price, `TP2 at ${this.tp2}, SL → ${newSL}`);
      }
    }

    if (!this.tp1Closed && this.tp1) {
      const tp1Hit = isLong ? price >= this.tp1 : price <= this.tp1;
      if (tp1Hit) {
        this.state    = POSITION_STATE.TP1_HIT;
        this.tp1Closed = true;
        const pnlR    = _round(this.tp1RR || (Math.abs(this.tp1 - this.entryPrice) / (riskPts || 1)), 3);
        const closePct = 0.50;
        this.realizedPnlR  += pnlR * closePct;
        this.sizeRemaining -= closePct;

        const bePrice   = this.entryPrice;
        this.currentSL  = bePrice;
        this.beSet      = true;

        actions.push({
          type:      'TP1_HIT',
          price:     this.tp1,
          pnlR,
          closePct:  50,
          newSL:     bePrice,
          remaining: _round(this.sizeRemaining, 2),
          note:      `TP1 hit at ${this.tp1} (${pnlR}R) — closed 50%, SL → breakeven (${bePrice})`,
        });
        this._log('TP1_HIT', price, `TP1 at ${this.tp1}, SL → BE (${bePrice})`);
      }
    }

    if (!this.beSet && !this.tp1Closed && riskPts > 0) {
      const toTP1 = Math.abs(this.tp1 - this.entryPrice);
      const moved = isLong ? price - this.entryPrice : this.entryPrice - price;
      const pctToTP1 = moved / toTP1;

      if (pctToTP1 >= 0.5) {
        const prevSL = this.currentSL;
        this.currentSL = this.entryPrice;
        this.beSet     = true;
        actions.push({
          type:   'BREAKEVEN_SET',
          newSL:  this.entryPrice,
          prevSL,
          note:   `Price ${_round(pctToTP1*100,0)}% toward TP1 — SL moved to breakeven (${this.entryPrice})`,
        });
        this._log('BE_SET', price, `SL moved to breakeven ${this.entryPrice}`);
      }
    }

    if (this.trailActive && atr && this.sizeRemaining > 0) {
      const trailLevel = isLong
        ? _round(price - atr * TRAIL_ATR_MULT)
        : _round(price + atr * TRAIL_ATR_MULT);

      const shouldMove = isLong
        ? trailLevel > this.currentSL
        : trailLevel < this.currentSL;

      if (shouldMove) {
        const prevSL   = this.currentSL;
        this.currentSL = trailLevel;
        actions.push({
          type:  'TRAIL_UPDATED',
          newSL: trailLevel,
          prevSL,
          delta: _round(Math.abs(trailLevel - prevSL), 5),
          note:  `Trail stop moved to ${trailLevel}`,
        });
      }
    }

    return actions;
  }

  moveSL(newSL, allowLoosen = false) {
    const isLong   = this.direction === 'LONG';
    const tighter  = isLong ? newSL > this.currentSL : newSL < this.currentSL;

    if (!tighter && !allowLoosen) {
      return { success: false, reason: 'SL can only be moved toward profit (tighter). Pass allowLoosen=true to override.' };
    }

    const prevSL   = this.currentSL;
    this.currentSL = _round(newSL);
    this.manualSLMoves++;
    this._log('SL_MOVED', this.currentPrice, `SL manually moved from ${prevSL} to ${newSL}`);

    return { success: true, prevSL, newSL: this.currentSL };
  }

  closeManual(price, pct = 1.0) {
    const isLong   = this.direction === 'LONG';
    const riskPts  = Math.abs(this.entryPrice - this.initialSL);
    const pnlPts   = isLong ? price - this.entryPrice : this.entryPrice - price;
    const pnlR     = _round(pnlPts / (riskPts || 1), 3);

    const closedPct = Math.min(pct, this.sizeRemaining);
    this.realizedPnlR  += pnlR * closedPct;
    this.sizeRemaining -= closedPct;

    this.partialCloses.push({
      price:    _round(price),
      pct:      closedPct,
      pnlR,
      timestamp: _now(),
    });

    if (this.sizeRemaining <= 0.001) {
      this.sizeRemaining = 0;
      this.state         = POSITION_STATE.MANUAL_CLOSE;
      this.closedAt      = _now();
      this.totalPnlR     = _round(this.realizedPnlR, 3);
    }

    this._log('MANUAL_CLOSE', price, `Manually closed ${(closedPct*100).toFixed(0)}% at ${price} (${pnlR}R)`);

    return {
      success:   true,
      closedPct,
      pnlR,
      totalPnlR: this.totalPnlR,
      remaining: this.sizeRemaining,
    };
  }

  isClosed() {
    return [
      POSITION_STATE.SL_HIT, POSITION_STATE.TP3_HIT,
      POSITION_STATE.MANUAL_CLOSE, POSITION_STATE.EXPIRED,
    ].includes(this.state);
  }

  holdingTimeMs() {
    const end = this.closedAt || _now();
    return end - this.openedAt;
  }

  holdingTimeStr() {
    const ms    = this.holdingTimeMs();
    const hours = Math.floor(ms / 3600000);
    const mins  = Math.floor((ms % 3600000) / 60000);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  }

  summary() {
    const isLong  = this.direction === 'LONG';
    const riskPts = Math.abs(this.entryPrice - this.initialSL);

    return {
      id:           this.id,
      signalId:     this.signalId,
      symbol:       this.symbol,
      direction:    this.direction,
      grade:        this.grade,
      state:        this.state,
      mode:         this.mode,

      entry:        _round(this.entryPrice),
      currentPrice: _round(this.currentPrice),
      currentSL:    _round(this.currentSL),
      initialSL:    _round(this.initialSL),
      tp1:          this.tp1 ? _round(this.tp1) : null,
      tp2:          this.tp2 ? _round(this.tp2) : null,
      tp3:          this.tp3 ? _round(this.tp3) : null,

      size:          this.size,
      sizeRemaining: _round(this.sizeRemaining, 3),
      dollarRisk:    this.dollarRisk,

      unrealizedPnlR: this.unrealizedPnlR,
      realizedPnlR:   _round(this.realizedPnlR, 3),
      totalPnlR:      this.totalPnlR,
      mfe:            this.mfe,
      mae:            this.mae,

      beSet:          this.beSet,
      tp1Closed:      this.tp1Closed,
      tp2Closed:      this.tp2Closed,
      trailActive:    this.trailActive,

      holdingTime:   this.holdingTimeStr(),
      openedAt:      new Date(this.openedAt).toISOString(),
      closedAt:      this.closedAt ? new Date(this.closedAt).toISOString() : null,

      partialCloses:  this.partialCloses,
      log:           this.log.slice(-5),
    };
  }

  _log(event, price, note) {
    this.log.push({ event, price, note, state: this.state, timestamp: _now() });
    if (this.log.length > 50) this.log.shift();
  }
}

class SignalJournal {
  constructor() {
    this._signals  = [];
    this._outcomes = [];
  }

  logSignal(signal, dispatchResult) {
    const entry = {
      id:          signal.id,
      symbol:      signal.symbol,
      timeframe:   signal.timeframe,
      direction:   signal.action,
      score:       signal.score?.final,
      grade:       signal.score?.grade,
      session:     signal.session?.current || signal.session,
      entryZone:   signal.entry,
      slPrice:     signal.stopLoss?.price,
      slRiskPct:   signal.stopLoss?.riskPct,
      tp1:         signal.targets?.tp1?.price,
      tp2:         signal.targets?.tp2?.price,
      tp3:         signal.targets?.tp3?.price,
      tp1RR:       signal.targets?.tp1?.rr,
      htfBias:     signal.htfBias?.direction,
      setupType:   _dominantSetup(signal),
      agentScores: {
        smc:      signal.agentVotes?.smc?.score,
        mtf:      signal.agentVotes?.mtf?.score,
        momentum: signal.agentVotes?.momentum?.score,
      },
      state:       SIGNAL_STATE.ACTIVE,
      dispatchedAt: _now(),
      outcome:     null,
    };
    this._signals.push(entry);
    return entry;
  }

  updateSignalState(signalId, state, data = {}) {
    const entry = this._signals.find(s => s.id === signalId);
    if (entry) {
      entry.state     = state;
      entry.updatedAt = _now();
      Object.assign(entry, data);
    }
  }

  recordOutcome(positionId, signalId, outcome) {
    const signal = this._signals.find(s => s.id === signalId);

    const record = {
      positionId,
      signalId,
      symbol:       signal?.symbol,
      direction:    signal?.direction,
      grade:        signal?.grade,
      setupType:    signal?.setupType || 'UNKNOWN',
      session:      signal?.session,
      entryPrice:   outcome.entryPrice,
      exitPrice:    outcome.exitPrice,
      pnlR:         outcome.pnlR,
      pnlPct:       outcome.pnlPct,
      won:          outcome.pnlR > 0,
      holdingTimeMs: outcome.holdingTimeMs,
      state:        outcome.state,
      tpHit:        outcome.tpHit || 0,
      beHit:        outcome.beSet,
      mfe:          outcome.mfe,
      mae:          outcome.mae,
      closedAt:     _now(),
    };

    this._outcomes.push(record);
    if (signal) { signal.state = SIGNAL_STATE.TAKEN; signal.outcome = record; }

    return record;
  }

  getStats(filter = {}) {
    let outcomes = [...this._outcomes];

    if (filter.symbol)    outcomes = outcomes.filter(o => o.symbol    === filter.symbol);
    if (filter.direction) outcomes = outcomes.filter(o => o.direction === filter.direction);
    if (filter.grade)     outcomes = outcomes.filter(o => o.grade     === filter.grade);
    if (filter.session)   outcomes = outcomes.filter(o => o.session   === filter.session);
    if (filter.setup)     outcomes = outcomes.filter(o => o.setupType === filter.setup);
    if (filter.since)     outcomes = outcomes.filter(o => o.closedAt  >= filter.since);

    const total   = outcomes.length;
    if (!total) return { total: 0, message: 'No completed trades yet' };

    const wins    = outcomes.filter(o => o.won).length;
    const losses  = total - wins;
    const winRate = _round(wins / total * 100, 2);

    const allPnl     = outcomes.map(o => o.pnlR || 0);
    const winPnl     = outcomes.filter(o => o.won).map(o => o.pnlR || 0);
    const lossPnl    = outcomes.filter(o => !o.won).map(o => Math.abs(o.pnlR || 0));
    const totalPnlR  = _round(allPnl.reduce((s, v) => s + v, 0), 3);
    const avgWin     = winPnl.length  ? _round(winPnl.reduce((s, v) => s + v, 0) / winPnl.length, 3) : 0;
    const avgLoss    = lossPnl.length ? _round(lossPnl.reduce((s, v) => s + v, 0) / lossPnl.length, 3) : 0;
    const pf         = avgLoss > 0 && losses > 0
      ? _round((avgWin * wins) / (avgLoss * losses), 3)
      : wins > 0 ? 999 : 0;

    const expectancy = _round((winRate / 100 * avgWin) - ((1 - winRate / 100) * avgLoss), 4);

    const byGrade = {};
    for (const grade of ['A', 'B', 'C', 'D']) {
      const g = outcomes.filter(o => o.grade === grade);
      if (!g.length) continue;
      const gw = g.filter(o => o.won).length;
      byGrade[grade] = {
        total: g.length, wins: gw,
        winRate: _round(gw / g.length * 100, 2),
        avgPnl:  _round(g.reduce((s, o) => s + (o.pnlR || 0), 0) / g.length, 3),
      };
    }

    const bySymbol = {};
    const symbols  = [...new Set(outcomes.map(o => o.symbol))];
    for (const sym of symbols) {
      const s  = outcomes.filter(o => o.symbol === sym);
      const sw = s.filter(o => o.won).length;
      bySymbol[sym] = {
        total: s.length, wins: sw, losses: s.length - sw,
        winRate: _round(sw / s.length * 100, 2),
        totalPnl: _round(s.reduce((s, o) => s + (o.pnlR || 0), 0), 3),
      };
    }

    const bySession = {};
    for (const sess of ['LONDON', 'NEW_YORK', 'OVERLAP', 'ASIA', 'DEAD']) {
      const s  = outcomes.filter(o => o.session === sess);
      if (!s.length) continue;
      const sw = s.filter(o => o.won).length;
      bySession[sess] = {
        total: s.length, wins: sw,
        winRate: _round(sw / s.length * 100, 2),
        avgPnl:  _round(s.reduce((a, o) => a + (o.pnlR || 0), 0) / s.length, 3),
      };
    }

    const bySetup = {};
    const setupTypes = [...new Set(outcomes.map(o => o.setupType || 'UNKNOWN'))];
    for (const setup of setupTypes) {
      const s  = outcomes.filter(o => (o.setupType || 'UNKNOWN') === setup);
      const sw = s.filter(o => o.won).length;
      bySetup[setup] = {
        total: s.length, wins: sw, losses: s.length - sw,
        winRate: _round(sw / s.length * 100, 2),
        totalPnl: _round(s.reduce((a, o) => a + (o.pnlR || 0), 0), 3),
        avgPnl:  _round(s.reduce((a, o) => a + (o.pnlR || 0), 0) / s.length, 3),
      };
    }

    let maxConsecW = 0, maxConsecL = 0, curW = 0, curL = 0;
    for (const o of outcomes) {
      if (o.won) { curW++; curL = 0; maxConsecW = Math.max(maxConsecW, curW); }
      else       { curL++; curW = 0; maxConsecL = Math.max(maxConsecL, curL); }
    }

    const dispatched = this._signals.length;
    const taken      = this._signals.filter(s => s.state === SIGNAL_STATE.TAKEN).length;
    const skipped    = this._signals.filter(s => s.state === SIGNAL_STATE.SKIPPED).length;
    const takeRate   = dispatched > 0 ? _round(taken / dispatched * 100, 2) : 0;

    return {
      total, wins, losses, winRate,
      totalPnlR, avgWin, avgLoss,
      profitFactor:   pf,
      expectancy,
      maxConsecWins:  maxConsecW,
      maxConsecLoss:  maxConsecL,
      byGrade, bySymbol, bySession, bySetup,
      signalStats: { dispatched, taken, skipped, takeRate },
      period: filter.since ? `Since ${new Date(filter.since).toUTCString()}` : 'All time',
    };
  }

  export(format = 'json') {
    if (format === 'json') {
      return JSON.stringify({ signals: this._signals, outcomes: this._outcomes }, null, 2);
    }
    if (format === 'csv') {
      const headers = ['signalId','symbol','direction','grade','entryPrice','exitPrice','pnlR','pnlPct','won','session','holdingTimeMs','state','closedAt'];
      const rows    = this._outcomes.map(o => headers.map(h => JSON.stringify(o[h] ?? '')).join(','));
      return [headers.join(','), ...rows].join('\n');
    }
    return this._outcomes;
  }

  getSignals(n = 20)   { return this._signals.slice(-n).reverse(); }
  getOutcomes(n = 20)  { return this._outcomes.slice(-n).reverse(); }
  get totalSignals()   { return this._signals.length; }
  get totalOutcomes()  { return this._outcomes.length; }
}

class RiskEnforcer {
  constructor(config = {}) {
    this._maxOpenPositions = config.maxOpenPositions || MAX_OPEN_POSITIONS;
    this._maxRiskPct       = config.maxRiskPct       || 2.0;
    this._maxCorrelated    = config.maxCorrelated    || 2;
    this._requireSession   = config.requireSession   !== false;

    this._CORRELATED_GROUPS = [
      ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT'],
      ['EURUSD',  'GBPUSD',  'AUDUSD',  'NZDUSD'],
      ['USDJPY',  'USDCHF',  'USDCAD'],
      ['XAUUSD',  'XAGUSD'],
    ];
  }

  validate(signal, entryData, openPositions, drawdownGuard) {
    const warnings = [];
    const blockers = [];

    if (drawdownGuard) {
      const ddEval = drawdownGuard.evaluate();
      if (!ddEval.allowed) {
        blockers.push(`Circuit breaker: ${ddEval.reason}`);
      } else if (ddEval.sizingFactor < 1) {
        warnings.push(`Risk sizing reduced to ${(ddEval.sizingFactor * 100).toFixed(0)}%: ${ddEval.reason}`);
      }
      for (const w of ddEval.warnings) warnings.push(w);
    }

    const openCount = openPositions.filter(p => !p.isClosed()).length;
    if (openCount >= this._maxOpenPositions) {
      blockers.push(`Max open positions reached (${openCount}/${this._maxOpenPositions})`);
    }

    const riskPct = entryData.riskPct || signal.stopLoss?.riskPct || 0;
    if (riskPct > this._maxRiskPct) {
      blockers.push(`Risk ${_round(riskPct, 2)}% exceeds maximum ${this._maxRiskPct}% per trade`);
    } else if (riskPct > this._maxRiskPct * 0.8) {
      warnings.push(`Risk ${_round(riskPct, 2)}% approaching maximum ${this._maxRiskPct}%`);
    }

    const activeSymbols = openPositions.filter(p => !p.isClosed()).map(p => ({ symbol: p.symbol, direction: p.direction }));
    const corrGroup = this._CORRELATED_GROUPS.find(g => g.includes(signal.symbol));
    if (corrGroup) {
      const correlated = activeSymbols.filter(a => corrGroup.includes(a.symbol) && a.symbol !== signal.symbol && a.direction === signal.action);
      if (correlated.length >= this._maxCorrelated) {
        blockers.push(`Correlation limit: ${correlated.length} correlated ${signal.action} positions already open (${correlated.map(c => c.symbol).join(', ')})`);
      } else if (correlated.length > 0) {
        warnings.push(`${correlated.length} correlated ${signal.action} position(s) open — consider reducing size`);
      }
    }

    const sameSymbol = activeSymbols.filter(a => a.symbol === signal.symbol);
    if (sameSymbol.length > 0) {
      warnings.push(`Already have ${sameSymbol.length} open position(s) on ${signal.symbol}`);
    }

    if (this._requireSession) {
      const h = new Date().getUTCHours();
      if (h >= 21) {
        if (signal.score?.grade !== 'A') {
          warnings.push(`Dead zone session — only Grade A signals recommended`);
        }
      } else if (h < 8) {
        warnings.push(`Asia session — lower liquidity, wider spreads possible`);
      }
    }

    // Signal grade warning ──
    if (signal.score?.grade === 'C' || signal.score?.grade === 'D') {
      warnings.push(`Low grade signal (${signal.score?.grade}) — higher risk setup`);
    }

    const slDist = Math.abs((entryData.entryPrice || signal.currentPrice) - signal.stopLoss?.price);
    const tp1Dist = Math.abs(signal.targets?.tp1?.price - (entryData.entryPrice || signal.currentPrice));
    if (slDist > 0 && tp1Dist > 0) {
      const rr = _round(tp1Dist / slDist, 2);
      if (rr < 1.5) {
        warnings.push(`Low RR on TP1: ${rr}:1 — consider skipping or adjusting entry`);
      }
    }

    const approved = blockers.length === 0;

    return {
      approved,
      blockers,
      warnings,
      openPositions: openCount,
      note: approved
        ? warnings.length > 0 ? `Approved with ${warnings.length} warning(s)` : 'All checks passed'
        : `Blocked: ${blockers.join('; ')}`,
    };
  }
}

class PriceMonitor {
  constructor() {
    this._prices    = new Map();
    this._listeners = new Map();
  }

  update(symbol, price) {
    this._prices.set(symbol, { price: _round(price), timestamp: _now() });
    const listeners = this._listeners.get(symbol);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(price, symbol); } catch { }
      }
    }
  }

  subscribe(symbol, callback) {
    if (!this._listeners.has(symbol)) this._listeners.set(symbol, new Set());
    this._listeners.get(symbol).add(callback);
    return () => this._listeners.get(symbol)?.delete(callback);
  }

  getPrice(symbol) {
    return this._prices.get(symbol)?.price || null;
  }

  getAllPrices() {
    const result = {};
    for (const [sym, data] of this._prices) result[sym] = data;
    return result;
  }
}

class SemiAutoExecutor {
  // Never auto-closes — always requires user confirmation for each action.
  constructor(config = {}) {
    this._client   = config.exchangeClient || null;
    this._exchange = config.exchange       || 'BINANCE';
    this._testnet  = config.testnet        || false;
    this._leverage = config.leverage       || 1;
    this._enabled  = !!this._client;
    this._orders   = new Map();
  }

  async placeEntry(signal, params) {
    if (!this._enabled) {
      return { success: false, reason: 'No exchange client configured — manual mode only', simulated: true, orderId: `SIM-${_uuid()}` };
    }

    const { entryPrice, size, sl, tp1 } = params;
    const isLong = signal.action === 'LONG';

    try {
      const orderParams = {
        symbol:      signal.symbol,
        side:        isLong ? 'BUY' : 'SELL',
        type:        'LIMIT',
        price:       String(entryPrice),
        quantity:    String(size),
        timeInForce: 'GTC',
      };

      const result = await this._client.newOrder(orderParams);
      const orderId = result.orderId || result.order_id || `ORDER-${_uuid()}`;

      this._orders.set(String(orderId), {
        orderId, signal, params, status: 'OPEN', placedAt: _now(),
      });

      // Place SL order (stop-loss) FIX: this result was previously discarded entirely (fire-and-forget, .catch() only) — meaning the SL order's exchange-assigned ID was never captured anywhere.
      let slOrderId = null;
      if (sl) {
        const slResult = await this._client.newOrder({
          symbol:      signal.symbol,
          side:        isLong ? 'SELL' : 'BUY',
          type:        'STOP_MARKET',
          stopPrice:   String(sl),
          quantity:    String(size),
          timeInForce: 'GTC',
          reduceOnly:  true,
        }).catch(e => { console.warn(`[SemiAuto] SL order failed: ${e.message}`); return null; });
        slOrderId = slResult?.orderId || slResult?.order_id || null;
      }

      if (tp1) {
        await this._client.newOrder({
          symbol:      signal.symbol,
          side:        isLong ? 'SELL' : 'BUY',
          type:        'TAKE_PROFIT_MARKET',
          stopPrice:   String(tp1),
          quantity:    String(size * 0.5),
          timeInForce: 'GTC',
          reduceOnly:  true,
        }).catch(e => console.warn(`[SemiAuto] TP1 order failed: ${e.message}`));
      }

      return { success: true, orderId, slOrderId, result };

    } catch (err) {
      return { success: false, reason: err.message, error: err };
    }
  }

  async cancelOrder(symbol, orderId) {
    if (!this._enabled) return { success: true, simulated: true };
    try {
      await this._client.cancelOrder({ symbol, orderId });
      this._orders.delete(String(orderId));
      return { success: true };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  async setBreakeven(symbol, direction, size, entryPrice, currentSLOrderId) {
    if (!this._enabled) return { success: true, simulated: true, newSL: entryPrice };
    try {
      // Cancel existing SL FIX: this previously swallowed any cancel failure with .catch(() => {}) and proceeded to place a NEW breakeven SL order regardless.
      if (currentSLOrderId) {
        await this._client.cancelOrder({ symbol, orderId: currentSLOrderId })
          .catch(e => console.warn(`[ExecutionEngine] setBreakeven: failed to cancel old SL ${currentSLOrderId} for ${symbol} — a duplicate stop order may now be live: ${e.message}`));
      }

      const newSLResult = await this._client.newOrder({
        symbol,
        side:       direction === 'LONG' ? 'SELL' : 'BUY',
        type:       'STOP_MARKET',
        stopPrice:  String(entryPrice),
        quantity:   String(size),
        reduceOnly: true,
      });

      return { success: true, newSL: entryPrice, newSLOrderId: newSLResult?.orderId || newSLResult?.order_id || null };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  isEnabled() { return this._enabled; }
  getOrders() { return Object.fromEntries(this._orders); }
}

class ExecutionEngine extends EventEmitter {
  constructor(config = {}) {
    super();

    this.mode        = config.mode || EXECUTION_MODE.MANUAL;
    this._dispatcher = config.dispatcher;
    this._dd         = config.drawdownGuard;
    this._prices     = config.priceMonitor || new PriceMonitor();

    this._journal    = new SignalJournal();
    this._enforcer   = new RiskEnforcer({
      maxOpenPositions: config.maxOpenPositions || MAX_OPEN_POSITIONS,
      maxRiskPct:       config.maxRiskPct       || 2.0,
    });
    this._executor   = new SemiAutoExecutor({
      exchangeClient: config.exchangeClient || null,
      exchange:       config.exchange       || 'BINANCE',
      testnet:        config.testnet        || false,
      leverage:       config.leverage       || 1,
    });

    this._positions       = new Map();
    this._pendingSignals  = new Map();
    this._skippedSignals  = new Set();
    this._autoBreakeven   = config.autoBreakeven !== false;
    this._running         = false;
    this._paused          = false;

    this._stats = {
      signalsReceived: 0, signalsDispatched: 0,
      tradesTaken: 0, tradesSkipped: 0,
      positionsOpened: 0, positionsClosed: 0,
      totalPnlR: 0, errors: 0,
    };

    this._wirePriceMonitor();

    if (config.sendJournalDaily !== false) {
      this._scheduleDailySummary();
    }

    console.log(`[ExecutionEngine] Initialized in ${this.mode} mode`);
  }

  async onSignal(signal) {
    this._stats.signalsReceived++;

    if (!signal || signal.action === 'WAIT') return { dispatched: false, reason: 'WAIT signal' };
    if (this._paused) return { dispatched: false, reason: 'Engine paused' };

    this._expirePendingSignals();

    const journalEntry = this._journal.logSignal(signal, {});

    let dispatchResult = null;
    try {
      dispatchResult = await this._dispatcher?.sendSignal(signal);
      this._stats.signalsDispatched++;
    } catch (err) {
      this._stats.errors++;
      console.error(`[ExecutionEngine] Dispatch error: ${err.message}`);
    }

    this._pendingSignals.set(signal.id, {
      signal,
      journalEntry,
      dispatchedAt: _now(),
      state:        SIGNAL_STATE.ACTIVE,
    });

    this.emit('signal_dispatched', { signal, dispatchResult });

    return { dispatched: true, signalId: signal.id, dispatchResult };
  }

  async onTrade(signalId, userParams = {}) {
    const pending = this._pendingSignals.get(signalId);
    if (!pending) {
      return { success: false, reason: `Signal ${signalId} not found or expired` };
    }

    const { signal } = pending;
    const isLong     = signal.action === 'LONG';

    const entryData = {
      entryPrice: userParams.entryPrice || signal.entry?.midPoint || signal.currentPrice,
      size:       userParams.size       || signal.positionSize    || 1,
      sl:         userParams.sl         || signal.stopLoss?.price,
      tp1:        userParams.tp1        || signal.targets?.tp1?.price,
      tp2:        userParams.tp2        || signal.targets?.tp2?.price,
      tp3:        userParams.tp3        || signal.targets?.tp3?.price,
      riskPct:    userParams.riskPct    || signal.stopLoss?.riskPct,
      dollarRisk: userParams.dollarRisk || signal.risk?.dollarRisk,
    };

    const openPositions = [...this._positions.values()];
    const validation    = this._enforcer.validate(signal, entryData, openPositions, this._dd);

    if (!validation.approved) {
      // Send warning to Telegram
      await this._dispatcher?.sendCustom(
        `🚫 <b>Entry Blocked</b>\n\n${validation.blockers.map(b => `• ${b}`).join('\n')}\n\n<i>Fix issues before entering.</i>`
      );
      return { success: false, validation };
    }

    if (validation.warnings.length > 0) {
      await this._dispatcher?.sendCustom(
        `⚠️ <b>Entry Warnings for ${signal.symbol}</b>\n\n${validation.warnings.map(w => `• ${w}`).join('\n')}\n\n<i>Proceeding with trade.</i>`,
        { silent: true }
      );
    }

    let orderResult = null;
    if (this.mode === EXECUTION_MODE.SEMI_AUTO && this._executor.isEnabled()) {
      orderResult = await this._executor.placeEntry(signal, entryData);
      if (!orderResult.success) {
        await this._dispatcher?.sendCustom(
          `❌ <b>Order Failed</b>\n${signal.symbol} ${signal.action}\n\n<code>${orderResult.reason}</code>\n\n<i>Enter manually on exchange.</i>`
        );
        return { success: false, reason: `Order failed: ${orderResult.reason}`, orderResult };
      }
    }

    const position = new Position(signal, { ...entryData, orderId: orderResult?.orderId, slOrderId: orderResult?.slOrderId }, this.mode);
    this._positions.set(position.id, position);
    this._stats.tradesTaken++;
    this._stats.positionsOpened++;

    this._journal.updateSignalState(signalId, SIGNAL_STATE.TAKEN, { positionId: position.id, entryPrice: entryData.entryPrice });
    this._pendingSignals.delete(signalId);

    this._subscribeToPosition(position);

    this._dd?.openPosition?.(position.id, signal.symbol, signal.action, entryData.size);

    await this._sendEntryConfirmation(signal, position, orderResult, validation);

    this.emit('position_opened', { position: position.summary(), signal });
    this._stats.tradesTaken++;

    return { success: true, positionId: position.id, position: position.summary(), validation, orderResult };
  }

  async onSkip(signalId, reason = 'User skipped') {
    const pending = this._pendingSignals.get(signalId);
    if (!pending) return { success: false };

    this._pendingSignals.delete(signalId);
    this._skippedSignals.add(signalId);
    this._journal.updateSignalState(signalId, SIGNAL_STATE.SKIPPED, { skipReason: reason });
    this._stats.tradesSkipped++;

    this.emit('trade_skipped', { signalId, reason });
    return { success: true };
  }

  async onWatch(signalId) {
    const pending = this._pendingSignals.get(signalId);
    if (!pending) return { success: false };

    pending.state = SIGNAL_STATE.WATCHING;
    this._journal.updateSignalState(signalId, SIGNAL_STATE.WATCHING);
    this.emit('signal_watching', { signalId });
    return { success: true };
  }

  async onClose(positionId, params = {}) {
    const position = this._positions.get(positionId);
    if (!position || position.isClosed()) {
      return { success: false, reason: 'Position not found or already closed' };
    }

    const closePrice = params.price || this._prices.getPrice(position.symbol) || position.currentPrice;
    const closePct   = params.pct   || 1.0;

    // FIX: previously silent — if this cancel fails, the code below still marks the position closed internally while the exchange-side order may still be live, meaning the account can carry exposure the...
    if (this.mode === EXECUTION_MODE.SEMI_AUTO && position.exchangeOrderId) {
      await this._executor.cancelOrder(position.symbol, position.exchangeOrderId)
        .catch(e => console.warn(`[ExecutionEngine] onClose: failed to cancel exchange order ${position.exchangeOrderId} for ${position.symbol} — it may still be live: ${e.message}`));
    }

    const closeResult = position.closeManual(closePrice, closePct);

    if (position.isClosed()) {
      await this._handlePositionClosed(position, 'MANUAL_CLOSE');
    } else {
      await this._dispatcher?.sendCustom(
        `✂️ <b>Partial Close</b> — ${position.symbol}\nClosed ${(closePct*100).toFixed(0)}% at <code>${_round(closePrice)}</code>\nPnL on this slice: <b>${closeResult.pnlR}R</b>\nRemaining: <b>${(closeResult.remaining*100).toFixed(0)}%</b>`
      );
    }

    return { success: true, closeResult, position: position.summary() };
  }

  async onMoveSL(positionId, newSL) {
    const position = this._positions.get(positionId);
    if (!position || position.isClosed()) return { success: false };

    const result = position.moveSL(newSL);
    if (result.success) {
      await this._dispatcher?.sendCustom(
        `🔧 <b>SL Updated</b> — ${position.symbol}\nOld SL: <code>${_round(result.prevSL)}</code>\nNew SL: <code>${_round(result.newSL)}</code>`
      );
    }
    return result;
  }

  async onSetBreakeven(positionId) {
    const position = this._positions.get(positionId);
    if (!position || position.isClosed() || position.beSet) {
      return { success: false, reason: position?.beSet ? 'Breakeven already set' : 'Position not found' };
    }

    const prevSL = position.currentSL;

    // FIX: this previously flipped position.beSet=true and moved position.currentSL to entryPrice BEFORE calling the exchange, and never checked whether the exchange call actually succeeded.
    if (this.mode === EXECUTION_MODE.SEMI_AUTO) {
      const result = await this._executor.setBreakeven(
        position.symbol, position.direction,
        position.size * position.sizeRemaining,
        position.entryPrice, position.slOrderId
      ).catch(e => ({ success: false, reason: e.message }));

      if (!result.success) {
        console.warn(`[ExecutionEngine] onSetBreakeven: exchange update failed for ${position.symbol} — internal state left unchanged, no confirmation sent: ${result.reason}`);
        await this._dispatcher?.sendCustom(
          `❌ <b>Breakeven Failed</b> — ${position.symbol}\n<code>${result.reason || 'unknown error'}</code>\n\n<i>SL was NOT moved. Check the exchange manually or retry.</i>`
        ).catch(() => {});
        return { success: false, reason: `Exchange update failed: ${result.reason}` };
      }
      // trailing stop) — previously never refreshed after a breakeven move, so it would go stale after this point.
      if (result.newSLOrderId) position.slOrderId = result.newSLOrderId;
    }

    position.currentSL = position.entryPrice;
    position.beSet     = true;

    await this._dispatcher?.sendBreakeven(position.id, position.symbol, position.entryPrice, position.direction);
    this.emit('breakeven_set', { positionId, symbol: position.symbol, newSL: position.entryPrice });

    return { success: true, prevSL, newSL: position.entryPrice };
  }

  _wirePriceMonitor() {
  }

  _subscribeToPosition(position) {
    const unsub = this._prices.subscribe(position.symbol, async (price) => {
      if (position.isClosed()) { unsub(); return; }

      const atr     = null;
      const actions = position.onPrice(price, atr);

      for (const action of actions) {
        await this._handlePositionAction(position, action);
      }
    });
  }

  async _handlePositionAction(position, action) {
    switch (action.type) {
      case 'TP1_HIT':
        this._stats.totalPnlR += action.pnlR * 0.5;
        await this._dispatcher?.sendTPHit(
          position.signalId, 1, action.price, action.pnlR,
          action.remaining * 100, position.symbol
        );
        this.emit('tp_alert', { positionId: position.id, tp: 1, ...action });
        break;

      case 'TP2_HIT':
        this._stats.totalPnlR += action.pnlR * 0.3;
        await this._dispatcher?.sendTPHit(
          position.signalId, 2, action.price, action.pnlR,
          action.remaining * 100, position.symbol
        );
        this.emit('tp_alert', { positionId: position.id, tp: 2, ...action });
        break;

      case 'TP3_HIT':
        await this._dispatcher?.sendTPHit(
          position.signalId, 3, action.price, action.pnlR,
          0, position.symbol
        );
        await this._handlePositionClosed(position, 'TP3_HIT');
        this.emit('tp_alert', { positionId: position.id, tp: 3, ...action });
        break;

      case 'SL_HIT':
        await this._dispatcher?.sendSLHit(
          position.signalId, action.price, action.pnlR,
          position.symbol, action.wasBreakeven
        );
        await this._handlePositionClosed(position, 'SL_HIT');
        this.emit('sl_alert', { positionId: position.id, ...action });
        break;

      case 'BREAKEVEN_SET':
        if (this._autoBreakeven) {
          // FIX: this case previously only sent a Telegram notification and emitted an event — it NEVER called the exchange at all.
          let exchangeOk = true;
          let exchangeReason = null;
          if (this.mode === EXECUTION_MODE.SEMI_AUTO) {
            const result = await this._executor.setBreakeven(
              position.symbol, position.direction,
              position.size * position.sizeRemaining,
              position.entryPrice, position.slOrderId
            ).catch(e => ({ success: false, reason: e.message }));
            exchangeOk = !!result.success;
            exchangeReason = result.reason;
            if (exchangeOk && result.newSLOrderId) position.slOrderId = result.newSLOrderId;
          }

          if (exchangeOk) {
            await this._dispatcher?.sendBreakeven(
              position.id, position.symbol, action.newSL, position.direction
            );
            this.emit('breakeven_set', { positionId: position.id, ...action });
          } else {
            console.warn(`[ExecutionEngine] Auto-breakeven exchange update failed for ${position.symbol} — internal tracking shows breakeven set but the real stop was NOT moved: ${exchangeReason}`);
            await this._dispatcher?.sendCustom(
              `⚠️ <b>Auto-Breakeven Failed</b> — ${position.symbol}\n<code>${exchangeReason || 'unknown error'}</code>\n\n<i>Price crossed the trigger but the exchange stop was NOT moved. Check the exchange manually.</i>`
            ).catch(() => {});
          }
        }
        break;

      case 'TRAIL_UPDATED':
        await this._dispatcher?.sendTrailUpdate(
          position.id, position.symbol, position.direction,
          action.newSL, action.delta, position.unrealizedPnlR
        );
        this.emit('trail_updated', { positionId: position.id, ...action });
        break;
    }
  }

  async _handlePositionClosed(position, reason) {
    this._stats.positionsClosed++;
    this._stats.totalPnlR = _round(this._stats.totalPnlR + position.totalPnlR, 3);

    const outcome = {
      entryPrice:    position.entryPrice,
      exitPrice:     position.currentPrice,
      pnlR:          position.totalPnlR,
      pnlPct:        _round(position.totalPnlR * position.riskPct, 4),
      won:           position.totalPnlR > 0,
      state:         position.state,
      tpHit:         position.tp2Closed ? 2 : position.tp1Closed ? 1 : 0,
      beSet:         position.beSet,
      mfe:           position.mfe,
      mae:           position.mae,
      holdingTimeMs: position.holdingTimeMs(),
    };

    const journalRecord = this._journal.recordOutcome(position.id, position.signalId, outcome);

    if (this._dd) {
      this._dd.record({
        pnlPct:   outcome.pnlPct,
        balance:  null,
        won:      outcome.won,
        symbol:   position.symbol,
        signalId: position.signalId,
        grade:    position.grade,
        pnlR:     position.totalPnlR,
      });
    }

    this.emit('position_closed', { position: position.summary(), outcome, journalRecord });

    this._positions.delete(position.id);
  }

  async _sendEntryConfirmation(signal, position, orderResult, validation) {
    const isLong  = signal.action === 'LONG';
    const modeTag = this.mode === EXECUTION_MODE.SEMI_AUTO && orderResult?.orderId
      ? `🤖 <b>Semi-Auto:</b> Order placed (ID: <code>${orderResult.orderId}</code>)`
      : `📝 <b>Manual:</b> Execute on your exchange now`;

    const text = [
      `✅ <b>TRADE ENTERED</b> — ${signal.symbol} ${signal.action}`,
      ``,
      modeTag,
      ``,
      `<b>Entry:</b>     <code>${_round(position.entryPrice)}</code>`,
      `<b>Stop Loss:</b> <code>${_round(position.currentSL)}</code>`,
      `<b>TP1:</b>       <code>${_round(position.tp1)}</code> (${position.tp1RR || '?'}:1 RR)`,
      `<b>TP2:</b>       <code>${_round(position.tp2)}</code>`,
      `<b>TP3:</b>       <code>${_round(position.tp3)}</code>`,
      ``,
      `<b>Size:</b>      ${position.size} units`,
      position.dollarRisk ? `<b>$ Risk:</b>    $${position.dollarRisk}` : null,
      ``,
      `<b>Plan:</b>`,
      `  1. SL auto-moves to BE when 50% toward TP1`,
      `  2. Close 50% at TP1, trail rest`,
      `  3. Close 30% at TP2, trail final 20%`,
      ``,
      `<code>Position ID: ${position.id}</code>`,
      `<i>${validation.warnings.length > 0 ? `⚠️ ${validation.warnings[0]}` : 'All risk checks passed.'}</i>`,
    ].filter(l => l !== null).join('\n');

    await this._dispatcher?.sendCustom(text);
  }

  async sendDailySummary() {
    const midnight  = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const stats     = this._journal.getStats({ since: midnight.getTime() });
    const ddStatus  = this._dd?.getDailyReport?.() || {};

    await this._dispatcher?.sendDailySummary({
      signals: {
        total:       stats.total,
        wins:        stats.wins,
        losses:      stats.losses,
        winRate:     stats.winRate,
        profitFactor: stats.profitFactor,
        avgWin:      stats.avgWin,
        avgLoss:     stats.avgLoss,
        fired:       stats.signalStats?.dispatched,
        bySymbol:    stats.bySymbol,
        byGrade:     stats.byGrade,
      },
      risk: {
        dailyPnl:   ddStatus.dailyPnl,
        drawdown:   ddStatus.drawdown?.current,
        trades:     ddStatus.trades,
        winRate:    ddStatus.winRate?.rolling?.winRatePct,
      },
      sessions:    stats.bySession,
      topSetup:    this._getBestSetup(stats),
    });
  }

  _getBestSetup(stats) {
    if (!stats.byGrade?.A || stats.byGrade.A.total === 0) return null;
    const a = stats.byGrade.A;
    return `Grade A: ${a.wins}W/${a.losses}L (${a.winRate}% WR, avg ${a.avgPnl}R)`;
  }

  _scheduleDailySummary() {
    const now      = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    setTimeout(async () => {
      await this.sendDailySummary();
      setInterval(() => this.sendDailySummary(), 24 * 60 * 60 * 1000);
    }, midnight - now);
  }

  _expirePendingSignals() {
    const now = _now();
    for (const [id, pending] of this._pendingSignals) {
      if (now - pending.dispatchedAt > MAX_SIGNAL_AGE_MS) {
        this._pendingSignals.delete(id);
        this._journal.updateSignalState(id, SIGNAL_STATE.EXPIRED);
        this.emit('signal_expired', { signalId: id });
      }
    }
  }

  onPrice(symbol, price, atr) {
    this._prices.update(symbol, price);

    for (const position of this._positions.values()) {
      if (position.symbol === symbol && !position.isClosed() && atr) {
        const actions = position.onPrice(price, atr);
        // FIX: fire-and-forget is intentional here (onPrice() is called synchronously from the price-tick handler and can't itself be async without restructuring every caller), but the failure was previously...
        for (const action of actions) {
          this._handlePositionAction(position, action)
            .catch(e => console.warn(`[ExecutionEngine] onPrice: failed to handle ${action.type} for ${position.symbol} — this trade event may not have been recorded or alerted: ${e.message}`));
        }
      }
    }
  }

  pause()  { this._paused = true;  this.emit('paused');  }
  resume() { this._paused = false; this.emit('resumed'); }

  setMode(mode) {
    if (!Object.values(EXECUTION_MODE).includes(mode)) throw new Error(`Invalid mode: ${mode}`);
    this.mode = mode;
    this.emit('mode_changed', { mode });
    console.log(`[ExecutionEngine] Mode changed to ${mode}`);
  }

  getStatus() {
    const openPositions = [...this._positions.values()].filter(p => !p.isClosed());
    return {
      mode:            this.mode,
      running:         !this._paused,
      stats:           this._stats,
      openPositions:   openPositions.length,
      openPositionList: openPositions.map(p => p.summary()),
      pendingSignals:  this._pendingSignals.size,
      journal: {
        totalSignals:  this._journal.totalSignals,
        totalOutcomes: this._journal.totalOutcomes,
        allTimeStats:  this._journal.getStats(),
        todayStats:    this._journal.getStats({ since: new Date().setUTCHours(0, 0, 0, 0) }),
      },
      drawdown:        this._dd?.getStatus?.() || null,
      semiAutoEnabled: this._executor.isEnabled(),
    };
  }

  getPosition(positionId) {
    return this._positions.get(positionId)?.summary() || null;
  }

  getAllPositions(includeClosed = false) {
    return [...this._positions.values()]
      .filter(p => includeClosed || !p.isClosed())
      .map(p => p.summary());
  }

  exportJournal(format = 'json') {
    return this._journal.export(format);
  }

  getJournalStats(filter = {}) {
    return this._journal.getStats(filter);
  }

  getPriceMonitor() { return this._prices; }
}

module.exports = {
  ExecutionEngine,
  Position,
  SignalJournal,
  RiskEnforcer,
  PriceMonitor,
  SemiAutoExecutor,
  EXECUTION_MODE,
  POSITION_STATE,
  SIGNAL_STATE,
  MAX_OPEN_POSITIONS,
  TRAIL_ATR_MULT,
};