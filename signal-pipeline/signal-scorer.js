
'use strict';

const EventEmitter = require('events');

// FIX: PatternAgent (Wyckoff/harmonics/H&S/divergences, ~1,250 lines) was instantiated in index.js's agentPool but .analyze() was never called on it anywhere — its vote had zero influence on any...
const AGENT_WEIGHTS = {
  SMC:            0.20,
  MICROSTRUCTURE: 0.18,
  MTF:            0.15,
  VOLUME_OI:      0.12,
  FRACTAL:        0.10,
  MOMENTUM:       0.10,
  MACRO_SENT:     0.08,
  PATTERN:        0.07,
};

const MIN_SCORE_TO_FIRE    = 65;
const MIN_SCORE_GRADE_A    = 85;
const MIN_SCORE_GRADE_B    = 65;

const SESSIONS = {
  ASIA: {
    name:  'Asia',
    start: 0,
    end:   8,
    quality: 'LOW',
    note: 'Low volume — avoid unless strong setup',
  },
  LONDON: {
    name:  'London',
    start: 8,
    end:   16,
    quality: 'HIGH',
    note: 'Highest institutional activity',
  },
  LONDON_NY_OVERLAP: {
    name:  'London/NY Overlap',
    start: 13,
    end:   16,
    quality: 'HIGHEST',
    note: 'Maximum volume and volatility — best setups',
  },
  NEW_YORK: {
    name:  'New York',
    start: 13,
    end:   21,
    quality: 'HIGH',
    note: 'High volume — strong moves',
  },
  DEAD: {
    name:  'Dead Zone',
    start: 21,
    end:   24,
    quality: 'DEAD',
    note: 'Low volume — avoid trading',
  },
};

class SessionDetector {
  static getCurrent(timestampMs) {
    const d       = new Date(timestampMs || Date.now());
    const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;

    const active = [];

    if (utcHour >= 0    && utcHour < 8)  active.push(SESSIONS.ASIA);
    if (utcHour >= 8    && utcHour < 16) active.push(SESSIONS.LONDON);
    if (utcHour >= 13   && utcHour < 16) active.push(SESSIONS.LONDON_NY_OVERLAP);
    if (utcHour >= 13   && utcHour < 21) active.push(SESSIONS.NEW_YORK);
    if (utcHour >= 21)                   active.push(SESSIONS.DEAD);

    const qualityOrder = ['HIGHEST', 'HIGH', 'LOW', 'DEAD'];
    active.sort((a, b) =>
      qualityOrder.indexOf(a.quality) - qualityOrder.indexOf(b.quality)
    );

    const best = active[0] || SESSIONS.DEAD;

    return {
      active,
      best,
      utcHour:       parseFloat(utcHour.toFixed(2)),
      isKillzone:    best.quality === 'HIGHEST',
      isHighVolume:  best.quality === 'HIGH' || best.quality === 'HIGHEST',
      isDead:        best.quality === 'DEAD',
      multiplier:    best.quality === 'HIGHEST' ? 1.10
        : best.quality === 'HIGH' ? 1.00
        : best.quality === 'LOW' ? 0.85
        : 0.60,
    };
  }

  static getNextKillzone(timestampMs) {
    const d       = new Date(timestampMs || Date.now());
    const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;

    if (utcHour < 8)  return { session: 'London Open',  hoursAway: 8  - utcHour };
    if (utcHour < 13) return { session: 'NY Open',       hoursAway: 13 - utcHour };
    if (utcHour < 21) return { session: 'London Open',   hoursAway: (24 - utcHour) + 8 };
    return              { session: 'London Open',        hoursAway: (24 - utcHour) + 8 };
  }
}

class NewsBlackoutManager {
  constructor() {
    this._events = [];
    this._blackoutWindow = 30 * 60 * 1000;
  }

  addEvent(event) {
    this._events.push({
      ...event,
      addedAt: Date.now(),
    });
    this._events = this._events.filter(e => e.time > Date.now() - this._blackoutWindow);
  }

  addEvents(events) {
    for (const event of events) {
      this.addEvent(event);
    }
  }

  isBlackedOut(symbol, timestampMs) {
    const now = timestampMs || Date.now();

    const affecting = this._events.filter(e => {
      const symbolMatch = !e.symbol ||
        e.symbol === symbol ||
        symbol.includes(e.currency || '');

      const inWindow = Math.abs(e.time - now) <= this._blackoutWindow;

      return symbolMatch && inWindow && e.impact === 'HIGH';
    });

    return {
      isBlackedOut: affecting.length > 0,
      events: affecting,
      note: affecting.length > 0
        ? `News blackout: ${affecting.map(e => e.name).join(', ')}`
        : null,
    };
  }

  clearExpired() {
    this._events = this._events.filter(e => e.time > Date.now() - this._blackoutWindow * 2);
  }
}

class DrawdownCircuitBreaker {
  constructor(config = {}) {
    this.maxDailyLossPct        = config.maxDailyLossPct        || 3;
    this.maxWeeklyLossPct       = config.maxWeeklyLossPct       || 7;
    this.maxConsecutiveLosses   = config.maxConsecutiveLosses   || 4;

    this._dailyPnl        = 0;
    this._weeklyPnl       = 0;
    this._consecutiveLoss = 0;
    this._isPaused        = false;
    this._pausedReason    = null;
    this._tradeLog        = [];
    this._dayStart        = this._getTodayUTC();
    this._weekStart       = this._getWeekStartUTC();
  }

  recordTrade(pnlPct) {
    const now = Date.now();

    this._tradeLog.push({ pnlPct, timestamp: now });

    if (this._getTodayUTC() > this._dayStart) {
      this._dailyPnl  = 0;
      this._dayStart  = this._getTodayUTC();
    }

    if (this._getWeekStartUTC() > this._weekStart) {
      this._weeklyPnl  = 0;
      this._weekStart  = this._getWeekStartUTC();
    }

    this._dailyPnl  += pnlPct;
    this._weeklyPnl += pnlPct;

    if (pnlPct < 0) {
      this._consecutiveLoss++;
    } else {
      this._consecutiveLoss = 0;
    }

    this._checkBreakers();
  }

  _checkBreakers() {
    if (this._dailyPnl <= -this.maxDailyLossPct) {
      this._isPaused    = true;
      this._pausedReason = `Daily loss limit hit: ${this._dailyPnl.toFixed(2)}% (max ${this.maxDailyLossPct}%)`;
    } else if (this._weeklyPnl <= -this.maxWeeklyLossPct) {
      this._isPaused    = true;
      this._pausedReason = `Weekly loss limit hit: ${this._weeklyPnl.toFixed(2)}% (max ${this.maxWeeklyLossPct}%)`;
    } else if (this._consecutiveLoss >= this.maxConsecutiveLosses) {
      this._isPaused    = true;
      this._pausedReason = `${this._consecutiveLoss} consecutive losses — taking a break`;
    } else {
      this._isPaused    = false;
      this._pausedReason = null;
    }
  }

  isPaused() {
    return { paused: this._isPaused, reason: this._pausedReason };
  }

  reset() {
    this._isPaused        = false;
    this._pausedReason    = null;
    this._consecutiveLoss = 0;
  }

  getStats() {
    return {
      dailyPnl:          parseFloat(this._dailyPnl.toFixed(4)),
      weeklyPnl:         parseFloat(this._weeklyPnl.toFixed(4)),
      consecutiveLosses: this._consecutiveLoss,
      isPaused:          this._isPaused,
      pausedReason:      this._pausedReason,
      maxDailyLoss:      this.maxDailyLossPct,
      maxWeeklyLoss:     this.maxWeeklyLossPct,
    };
  }

  _getTodayUTC() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  _getWeekStartUTC() {
    const d   = new Date();
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff);
  }
}

class SignalHistoryTracker {
  constructor() {
    this._signals = [];
    this._outcomes = [];
  }

  record(signal) {
    this._signals.push({
      ...signal,
      id: `SIG_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      firedAt: Date.now(),
      outcome: null,
    });
    return this._signals[this._signals.length - 1].id;
  }

  closeSignal(id, outcome) {
    const sig = this._signals.find(s => s.id === id);
    if (sig) {
      sig.outcome  = outcome;
      sig.closedAt = Date.now();
      sig.pnlPct   = outcome.pnlPct;
      this._outcomes.push(outcome);
    }
  }

  getStats() {
    const closed  = this._signals.filter(s => s.outcome !== null);
    const wins    = closed.filter(s => s.outcome?.result === 'WIN');
    const losses  = closed.filter(s => s.outcome?.result === 'LOSS');
    const be      = closed.filter(s => s.outcome?.result === 'BREAKEVEN');

    const winRate = closed.length > 0
      ? parseFloat(((wins.length / closed.length) * 100).toFixed(2))
      : 0;

    const avgWin  = wins.length > 0
      ? wins.reduce((s, t) => s + (parseFloat(t.pnlPct) || 0), 0) / wins.length
      : 0;

    const avgLoss = losses.length > 0
      ? losses.reduce((s, t) => s + (parseFloat(t.pnlPct) || 0), 0) / losses.length
      : 0;

    const profitFactor = (avgLoss !== 0 && !isNaN(avgLoss))
      ? parseFloat(Math.abs(avgWin / avgLoss).toFixed(2))
      : (avgWin > 0 ? 999 : 0);

    const bySymbol = {};
    for (const sig of closed) {
      if (!bySymbol[sig.symbol]) bySymbol[sig.symbol] = { wins: 0, losses: 0, total: 0 };
      bySymbol[sig.symbol].total++;
      if (sig.outcome?.result === 'WIN') bySymbol[sig.symbol].wins++;
      if (sig.outcome?.result === 'LOSS') bySymbol[sig.symbol].losses++;
    }
    for (const sym of Object.keys(bySymbol)) {
      bySymbol[sym].winRate = parseFloat(
        ((bySymbol[sym].wins / bySymbol[sym].total) * 100).toFixed(2)
      );
    }

    return {
      total:        this._signals.length,
      closed:       closed.length,
      pending:      this._signals.length - closed.length,
      wins:         wins.length,
      losses:       losses.length,
      breakevens:   be.length,
      winRate,
      avgWinPct:    parseFloat(avgWin.toFixed(4)),
      avgLossPct:   parseFloat(avgLoss.toFixed(4)),
      profitFactor,
      bySymbol,
    };
  }

  getRecent(n = 10) {
    return this._signals.slice(-n).reverse();
  }
}

class SignalScorer extends EventEmitter {
  constructor(config = {}) {
    super();

    this.minScore         = config.minScore        || MIN_SCORE_TO_FIRE;
    this.sessionFilter    = config.sessionFilter   !== false;
    this.newsBlackout     = config.newsBlackout    !== false;
    this.requireKillzone  = config.requireKillzone || false;
    this.redis            = config.redis           || null;

    this.circuitBreaker   = new DrawdownCircuitBreaker(config.circuitBreaker || {});
    this.newsManager      = new NewsBlackoutManager();
    this.history          = new SignalHistoryTracker();

    this._processingCount = 0;
    this._lastSignalTime  = new Map();
    this._minSignalGapMs  = 5 * 60 * 1000;
  }

  async score(agentVotes, context) {
    this._processingCount++;

    const {
      symbol,
      timeframe,
      currentPrice,
      timestamp = Date.now(),
    } = context;

    const validation = this._validateVotes(agentVotes);
    if (!validation.valid) {
      return this._buildWaitSignal(symbol, timeframe, currentPrice, validation.reason, 0);
    }

    const cb = this.circuitBreaker.isPaused();
    if (cb.paused) {
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Circuit breaker active: ${cb.reason}`, 0);
    }

    if (this.newsBlackout) {
      const blackout = this.newsManager.isBlackedOut(symbol, timestamp);
      if (blackout.isBlackedOut) {
        return this._buildWaitSignal(symbol, timeframe, currentPrice,
          blackout.note, 0);
      }
    }

    const session = SessionDetector.getCurrent(timestamp);
    if (this.sessionFilter && session.isDead) {
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Dead zone (${session.best.name}) — no trades`, 0);
    }
    if (this.requireKillzone && !session.isKillzone) {
      const next = SessionDetector.getNextKillzone(timestamp);
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Waiting for killzone. Next: ${next.session} in ${next.hoursAway.toFixed(1)}h`, 0);
    }

    const directionVote = this._resolveDirection(agentVotes);
    if (directionVote.direction === 'WAIT') {
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        directionVote.reason, 0);
    }

    const micro = agentVotes.microstructure;
    if (micro?.direction && micro.direction !== 'WAIT') {
      const microDir = String(micro.direction).toUpperCase();
      const microScore = Number(micro.score) || 0;
      if (microDir !== directionVote.direction && microScore >= 70) {
        return this._buildWaitSignal(symbol, timeframe, currentPrice,
          `Adverse selection: microstructure ${microDir} (${microScore}) opposes ${directionVote.direction} consensus`, 0);
      }
    }

    const fractal = agentVotes.fractal;
    if (fractal?.analysis?.lyapunov?.chaotic === true && (fractal.score || 0) >= 60) {
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Fractal chaos regime (Lyapunov) — edge unstable, no trade`, 0);
    }

    const scoring = this._computeWeightedScore(agentVotes, directionVote.direction);

    const rawScore    = scoring.rawScore;
    const adjScore    = Math.min(Math.round(rawScore * session.multiplier), 100);
    const grade       = adjScore >= MIN_SCORE_GRADE_A ? 'A'
      : adjScore >= MIN_SCORE_GRADE_B ? 'B'
      : adjScore >= 65 ? 'C' : 'D';

    if (adjScore < this.minScore) {
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Score ${adjScore}/100 below minimum ${this.minScore} (grade ${grade})`, adjScore);
    }

    const lastFired = this._lastSignalTime.get(`${symbol}_${timeframe}`);
    if (lastFired && (timestamp - lastFired) < this._minSignalGapMs) {
      const wait = ((this._minSignalGapMs - (timestamp - lastFired)) / 60000).toFixed(1);
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Signal cooldown: wait ${wait}min before next signal`, adjScore);
    }

    const signal = this._buildFireSignal({
      symbol,
      timeframe,
      currentPrice,
      timestamp,
      direction:      directionVote.direction,
      rawScore,
      adjScore,
      grade,
      scoring,
      session,
      agentVotes,
      directionVote,
    });

    this._lastSignalTime.set(`${symbol}_${timeframe}`, timestamp);

    const signalId = this.history.record(signal);
    signal.id      = signalId;

    if (this.redis) {
      await this._publishSignal(signal).catch(err =>
        console.error('[SignalScorer] Redis publish error:', err)
      );
    }

    this.emit('signal', signal);

    if (grade === 'A') {
      this.emit('signal_grade_a', signal);
    }

    return signal;
  }

  _resolveDirection(agentVotes) {
    const votes = {
      LONG:  0,
      SHORT: 0,
      WAIT:  0,
    };

    const agentList = [
      { key: 'smc',            weight: AGENT_WEIGHTS.SMC },
      { key: 'microstructure', weight: AGENT_WEIGHTS.MICROSTRUCTURE },
      { key: 'mtf',            weight: AGENT_WEIGHTS.MTF },
      { key: 'volumeOI',       weight: AGENT_WEIGHTS.VOLUME_OI },
      { key: 'fractal',        weight: AGENT_WEIGHTS.FRACTAL },
      { key: 'momentum',       weight: AGENT_WEIGHTS.MOMENTUM },
      { key: 'macroSent',      weight: AGENT_WEIGHTS.MACRO_SENT },
      { key: 'pattern',        weight: AGENT_WEIGHTS.PATTERN },
    ];

    const agentDirections = [];

    for (const { key, weight } of agentList) {
      const vote = agentVotes[key];
      if (!vote || !vote.direction) {
        votes['WAIT'] += weight;
        agentDirections.push({ agent: key, direction: 'WAIT', weight, score: 0 });
        continue;
      }

      const dir = vote.direction.toUpperCase();
      votes[dir] = (votes[dir] || 0) + weight;
      agentDirections.push({ agent: key, direction: dir, weight, score: vote.score || 0 });
    }

    // SMC and MTF must agree — they are the foundation
    const smcDir = agentVotes.smc?.direction?.toUpperCase();
    const mtfDir = agentVotes.mtf?.direction?.toUpperCase();

    if (smcDir && mtfDir && smcDir !== 'WAIT' && mtfDir !== 'WAIT' && smcDir !== mtfDir) {
      return {
        direction: 'WAIT',
        reason:    `SMC (${smcDir}) conflicts with MTF (${mtfDir}) — no trade`,
        agentDirections,
        votes,
      };
    }

    const maxVote   = Math.max(...Object.values(votes));
    const winner    = Object.keys(votes).find(k => votes[k] === maxVote);
    const loser     = winner === 'LONG' ? 'SHORT' : 'LONG';
    const margin    = votes[winner] - (votes[loser] || 0);

    if (margin < 0.18 && winner !== 'WAIT') {
      return {
        direction: 'WAIT',
        reason:    `Direction unclear — LONG ${(votes.LONG || 0).toFixed(2)} vs SHORT ${(votes.SHORT || 0).toFixed(2)}`,
        agentDirections,
        votes,
      };
    }

    return {
      direction:  winner,
      margin:     parseFloat(margin.toFixed(3)),
      agentDirections,
      votes,
      reason:     `${winner} consensus — ${(maxVote * 100).toFixed(0)}% weighted agreement`,
    };
  }

  _computeWeightedScore(agentVotes, direction) {
    const breakdown = [];
    let weightedSum = 0;
    let totalWeight = 0;

    const agentMap = [
      { key: 'smc',            label: 'SMC Agent',              weight: AGENT_WEIGHTS.SMC },
      { key: 'microstructure', label: 'Microstructure Agent',   weight: AGENT_WEIGHTS.MICROSTRUCTURE },
      { key: 'mtf',            label: 'MTF Agent',              weight: AGENT_WEIGHTS.MTF },
      { key: 'volumeOI',       label: 'Volume/OI Agent',        weight: AGENT_WEIGHTS.VOLUME_OI },
      { key: 'fractal',        label: 'Fractal Agent',          weight: AGENT_WEIGHTS.FRACTAL },
      { key: 'momentum',       label: 'Momentum Agent',         weight: AGENT_WEIGHTS.MOMENTUM },
      { key: 'macroSent',      label: 'Macro/Sentiment Agent',  weight: AGENT_WEIGHTS.MACRO_SENT },
      { key: 'pattern',        label: 'Pattern Agent',          weight: AGENT_WEIGHTS.PATTERN },
    ];

    for (const { key, label, weight } of agentMap) {
      const vote = agentVotes[key];

      let agentScore = vote?.score ?? 0;
      const agentDir = vote?.direction?.toUpperCase() ?? 'WAIT';

      let contribution;
      let status;

      const conf = Math.max(agentScore, 0) / 100;
      const confBoost = 0.92 + 0.08 * conf;

      if (agentDir === direction) {
        contribution = agentScore * weight * confBoost;
        status       = 'CONFIRMS';
      } else if (agentDir === 'WAIT') {
        contribution = agentScore * weight * 0.40;
        status       = 'NEUTRAL';
      } else {
        contribution = 0;
        status       = 'OPPOSES';
        agentScore   = 0;
      }

      weightedSum += contribution;
      totalWeight += weight;

      breakdown.push({
        agent:        key,
        label,
        weight:       parseFloat((weight * 100).toFixed(0)) + '%',
        rawScore:     agentScore,
        contribution: parseFloat(contribution.toFixed(2)),
        direction:    agentDir,
        status,
        reasons:      vote?.reasons || [],
      });
    }

    const rawScore = totalWeight > 0
      ? parseFloat((weightedSum / totalWeight).toFixed(2))
      : 0;

    const confirmCount = breakdown.filter(b => b.status === 'CONFIRMS' && b.rawScore >= 70).length;
    const confluenceBonus = confirmCount >= 4 ? 5 : confirmCount >= 3 ? 3 : 0;

    return {
      rawScore:        Math.min(rawScore + confluenceBonus, 100),
      baseScore:       rawScore,
      confluenceBonus,
      breakdown,
      confirmCount,
    };
  }

  _buildWaitSignal(symbol, timeframe, price, reason, score, timestamp = Date.now()) {
    const numericScore = typeof score === 'number' ? score : 0;
    return {
      action:       'WAIT',
      symbol,
      timeframe,
      currentPrice: price,
      // FIX: was a bare number here while _buildFireSignal returns score as
      // an object ({final, raw, grade, ...}). Every downstream consumer
      // (opportunityRanker, auditTrail near-miss calc, memory-manager,
      // alert-dispatcher, the dashboard's Gate-checks panel) reads
      // signal.score?.final / .grade uniformly, so a WAIT signal's real
      // score was silently read as undefined -> coerced to 0 everywhere.
      // In practice this zeroed near-miss detection almost entirely, since
      // the vast majority of analysis cycles end in WAIT. Shape now matches
      // _buildFireSignal so no call site needs to special-case WAIT vs FIRE.
      score: {
        final:           numericScore,
        raw:             numericScore,
        grade:           null,
        minimum:         this.minScore,
        confluenceBonus: 0,
      },
      reason,
      waitReason:   reason,
      timestamp,
      session:      SessionDetector.getCurrent().best.name,
      gatesFailed:  reason ? [String(reason).slice(0, 120)] : [],
      gatesPassed:  [],
    };
  }

  _buildFireSignal(params) {
    const {
      symbol, timeframe, currentPrice, timestamp,
      direction, rawScore, adjScore, grade,
      scoring, session, agentVotes, directionVote,
    } = params;

    const isLong   = direction === 'LONG';

    const allReasons = scoring.breakdown
      .filter(b => b.status === 'CONFIRMS')
      .flatMap(b => b.reasons.map(r => `[${b.label}] ${r}`));

    const smcSignal = agentVotes.smc?.signal || {};
    const mtfBiasRaw = agentVotes.mtf?.analysis?.htfBias || direction;
    const mtfBias = typeof mtfBiasRaw === 'string'
      ? mtfBiasRaw
      : (mtfBiasRaw.direction || mtfBiasRaw.bias || direction);

    const reasoning = this._buildReasoningText({
      direction, adjScore, grade, session,
      scoring, allReasons, smcSignal, mtfBias,
      symbol, timeframe, currentPrice,
    });

    return {
      action:       direction,
      symbol,
      timeframe,
      timestamp,
      currentPrice,

      score: {
        final:          adjScore,
        raw:            rawScore,
        sessionAdj:     parseFloat((adjScore - rawScore).toFixed(2)),
        grade,
        minimum:        this.minScore,
        confluenceBonus: scoring.confluenceBonus,
      },

      agentBreakdown: scoring.breakdown.map(b => ({
        agent:       b.label,
        score:       b.rawScore,
        weight:      b.weight,
        direction:   b.direction,
        status:      b.status,
        topReasons:  b.reasons.slice(0, 3),
      })),

      directionAnalysis: {
        consensus:    directionVote.direction,
        margin:       directionVote.margin,
        votes:        directionVote.votes,
        agentVotes:   directionVote.agentDirections,
        confirmedBy:  directionVote.agentDirections
          .filter(a => a.direction === direction)
          .map(a => a.agent),
      },

      entry:          smcSignal.entry || {
        zoneHigh: parseFloat((currentPrice * (isLong ? 1.0005 : 1.0005)).toFixed(5)),
        zoneLow:  parseFloat((currentPrice * (isLong ? 0.9995 : 0.9995)).toFixed(5)),
        type:     'MARKET_ZONE',
        note:     'No OB available — use caution, reduce size',
      },

      stopLoss:       smcSignal.stopLoss || {
        price: parseFloat((currentPrice * (isLong ? 0.995 : 1.005)).toFixed(5)),
        note:  'Default ATR-based stop',
      },

      targets:        smcSignal.targets || {
        tp1: {
          price: parseFloat((currentPrice * (isLong ? 1.0075 : 0.9925)).toFixed(5)),
          rr:    1.5,
          note:  'Close 50% here',
        },
        tp2: {
          price: parseFloat((currentPrice * (isLong ? 1.015 : 0.985)).toFixed(5)),
          rr:    3.0,
          note:  'Trail stop to BE after TP1',
        },
      },

      management:     smcSignal.management || {
        moveToBreakeven: 'After TP1 hit',
        partialClose:    '50% at TP1',
        trailingStop:    'ATR × 1.5 after TP1',
      },

      session: {
        current:     session.best.name,
        quality:     session.best.quality,
        multiplier:  session.multiplier,
        isKillzone:  session.isKillzone,
        note:        session.best.note,
        nextKillzone: SessionDetector.getNextKillzone(timestamp),
      },

      htfBias: {
        direction: mtfBias,
        note:      `Higher timeframe bias is ${mtfBias}`,
      },

      reasoning,
      allReasons: allReasons.slice(0, 10),

      meta: {
        generatedAt:    new Date(timestamp).toISOString(),
        processingCount: this._processingCount,
        circuitBreaker: this.circuitBreaker.getStats(),
        signalStats:    this.history.getStats(),
      },
    };
  }

  _buildReasoningText(params) {
    const {
      direction, adjScore, grade, session,
      scoring, allReasons, smcSignal, mtfBias,
      symbol, timeframe, currentPrice,
    } = params;

    const isLong = direction === 'LONG';
    const emoji  = isLong ? '🟢' : '🔴';
    const action = isLong ? 'BUY' : 'SELL';

    const lines = [
      `${emoji} ${action} SIGNAL — ${symbol} ${timeframe}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📊 Score: ${adjScore}/100 (Grade ${grade}) | Session: ${session.best.name}`,
      `💰 Current Price: ${currentPrice}`,
      ``,
      `🧠 WHY THIS TRADE:`,
    ];

    const topReasons = allReasons.slice(0, 6);
    for (const r of topReasons) {
      lines.push(`  ✅ ${r}`);
    }

    if (smcSignal.entry) {
      lines.push('');
      lines.push(`📍 ENTRY ZONE: ${smcSignal.entry.zoneLow} – ${smcSignal.entry.zoneHigh}`);
      lines.push(`🛑 STOP LOSS: ${smcSignal.stopLoss?.price || 'See chart'}`);
      lines.push(`🎯 TP1: ${smcSignal.targets?.tp1?.price || 'N/A'} (${smcSignal.targets?.tp1?.rr || '?'}:1 RR)`);
      lines.push(`🎯 TP2: ${smcSignal.targets?.tp2?.price || 'N/A'} (${smcSignal.targets?.tp2?.rr || '?'}:1 RR)`);
    }

    lines.push('');
    lines.push(`📐 HTF Bias: ${mtfBias}`);
    lines.push(`⏰ Session Quality: ${session.best.quality}`);

    if (grade === 'A') {
      lines.push('');
      lines.push('⭐ GRADE A SIGNAL — Highest confluence detected');
    }

    lines.push('');
    lines.push(`📋 Agent votes: ${scoring.breakdown.map(b => `${b.label.split(' ')[0]}: ${b.rawScore}`).join(' | ')}`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`⚠️ Always confirm on your chart. Risk max 1-2% of account.`);

    return lines.join('\n');
  }

  _validateVotes(agentVotes) {
    const required = ['smc', 'mtf', 'momentum'];
    const missing  = required.filter(k => !agentVotes[k]);

    if (missing.length > 0) {
      return { valid: false, reason: `Missing agent votes: ${missing.join(', ')}` };
    }

    return { valid: true };
  }

  async _publishSignal(signal) {
    if (!this.redis) return;

    const channels = [
      `signals:all`,
      `signals:${signal.symbol}`,
      `signals:${signal.symbol}:${signal.timeframe}`,
      signal.action === 'LONG'  ? `signals:long`  : null,
      signal.action === 'SHORT' ? `signals:short` : null,
      signal.score?.grade === 'A' ? `signals:grade_a` : null,
    ].filter(Boolean);

    const payload = JSON.stringify(signal);

    await Promise.all(channels.map(ch => this.redis.publish(ch, payload)));
  }

  addNewsEvent(event) {
    this.newsManager.addEvent(event);
  }

  addNewsEvents(events) {
    this.newsManager.addEvents(events);
  }

  recordTradeOutcome(signalId, outcome) {
    this.history.closeSignal(signalId, outcome);
    this.circuitBreaker.recordTrade(outcome.pnlPct || 0);
    this.emit('trade_outcome', { signalId, outcome });
  }

  getStats() {
    return {
      signals:        this.history.getStats(),
      circuitBreaker: this.circuitBreaker.getStats(),
      processing:     this._processingCount,
      lastSignals:    this.history.getRecent(5),
    };
  }

  resetCircuitBreaker() {
    this.circuitBreaker.reset();
    this.emit('circuit_breaker_reset');
  }
}

module.exports = {
  SignalScorer,
  SessionDetector,
  NewsBlackoutManager,
  DrawdownCircuitBreaker,
  SignalHistoryTracker,
  AGENT_WEIGHTS,
  SESSIONS,
  MIN_SCORE_TO_FIRE,
};

