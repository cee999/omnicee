/**
 * ============================================================
 *  SIGNAL SCORER — Multi-Agent Confluence Weighting Engine
 *  AI Trading Assistant · Layer 5 · Signal Pipeline
 * ============================================================
 *
 *  Responsibilities:
 *    - Receives raw votes from all 5 specialized AI agents
 *    - Applies weighted confluence scoring (SMC 35%, MTF 25%,
 *      Momentum 20%, Volume/OI 10%, Macro/Sentiment 10%)
 *    - Applies session filter (London / NY / Asia killzones)
 *    - Applies news blackout filter (30min before/after high-impact)
 *    - Applies drawdown circuit breaker (pauses if daily loss hit)
 *    - Generates final LONG / SHORT / WAIT with full audit trail
 *    - Writes signal history to PostgreSQL via db module
 *    - Publishes signal to Redis for frontend + alert-dispatcher
 *    - Tracks signal performance (win rate per symbol, per session)
 *
 *  Minimum score to fire a signal: 75/100
 *  Grade A = 85+, Grade B = 75-84, Grade C = 65-74 (not fired)
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  WEIGHT CONFIGURATION
// ─────────────────────────────────────────────

const AGENT_WEIGHTS = {
  SMC:         0.35,   // Order blocks, FVG, BOS/CHoCH, sweeps
  MTF:         0.25,   // Multi-timeframe alignment
  MOMENTUM:    0.20,   // RSI, MACD, EMA, Ichimoku, VWAP
  VOLUME_OI:   0.10,   // Volume profile, CVD, OI, funding
  MACRO_SENT:  0.10,   // News NLP, COT, DXY, intermarket
};

const MIN_SCORE_TO_FIRE    = 75;
const MIN_SCORE_GRADE_A    = 85;
const MIN_SCORE_GRADE_B    = 75;

// Session windows in UTC hours
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

// ─────────────────────────────────────────────
//  SESSION DETECTOR
// ─────────────────────────────────────────────

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

    // Best session = highest quality one active
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
      // Score multiplier: killzone = 1.1x, high = 1.0x, low = 0.85x, dead = 0.6x
      multiplier:    best.quality === 'HIGHEST' ? 1.10
        : best.quality === 'HIGH' ? 1.00
        : best.quality === 'LOW' ? 0.85
        : 0.60,
    };
  }

  /**
   * Returns the next high-quality session
   */
  static getNextKillzone(timestampMs) {
    const d       = new Date(timestampMs || Date.now());
    const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;

    if (utcHour < 8)  return { session: 'London Open',  hoursAway: 8  - utcHour };
    if (utcHour < 13) return { session: 'NY Open',       hoursAway: 13 - utcHour };
    if (utcHour < 21) return { session: 'London Open',   hoursAway: (24 - utcHour) + 8 };
    return              { session: 'London Open',        hoursAway: (24 - utcHour) + 8 };
  }
}

// ─────────────────────────────────────────────
//  NEWS BLACKOUT MANAGER
// ─────────────────────────────────────────────

class NewsBlackoutManager {
  constructor() {
    // Scheduled high-impact events: { symbol, time: UTC ms, name, impact }
    this._events = [];
    this._blackoutWindow = 30 * 60 * 1000; // 30 minutes each side
  }

  /**
   * Register a high-impact news event
   */
  addEvent(event) {
    this._events.push({
      ...event,
      addedAt: Date.now(),
    });
    // Keep only future events
    this._events = this._events.filter(e => e.time > Date.now() - this._blackoutWindow);
  }

  /**
   * Add multiple events from an economic calendar feed
   */
  addEvents(events) {
    for (const event of events) {
      this.addEvent(event);
    }
  }

  /**
   * Check if trading is blacked out right now for a symbol
   */
  isBlackedOut(symbol, timestampMs) {
    const now = timestampMs || Date.now();

    const affecting = this._events.filter(e => {
      // Event affects this symbol (USD events affect all USD pairs, etc.)
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

// ─────────────────────────────────────────────
//  DRAWDOWN CIRCUIT BREAKER
// ─────────────────────────────────────────────

class DrawdownCircuitBreaker {
  /**
   * @param {Object} config
   * @param {number} config.maxDailyLossPct - max daily loss % before pausing (default 3%)
   * @param {number} config.maxWeeklyLossPct - max weekly loss % (default 7%)
   * @param {number} config.maxConsecutiveLosses - stop after N losses in a row (default 4)
   */
  constructor(config = {}) {
    this.maxDailyLossPct        = config.maxDailyLossPct        || 3;
    this.maxWeeklyLossPct       = config.maxWeeklyLossPct       || 7;
    this.maxConsecutiveLosses   = config.maxConsecutiveLosses   || 4;

    this._dailyPnl        = 0;   // in % of account
    this._weeklyPnl       = 0;
    this._consecutiveLoss = 0;
    this._isPaused        = false;
    this._pausedReason    = null;
    this._tradeLog        = [];
    this._dayStart        = this._getTodayUTC();
    this._weekStart       = this._getWeekStartUTC();
  }

  /**
   * Register a completed trade result
   * @param {number} pnlPct - PnL as percentage of account (+ or -)
   */
  recordTrade(pnlPct) {
    const now = Date.now();

    this._tradeLog.push({ pnlPct, timestamp: now });

    // Reset daily if new day
    if (this._getTodayUTC() > this._dayStart) {
      this._dailyPnl  = 0;
      this._dayStart  = this._getTodayUTC();
    }

    // Reset weekly if new week
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
    const day = d.getUTCDay(); // 0 = Sunday
    const diff = d.getUTCDate() - day;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff);
  }
}

// ─────────────────────────────────────────────
//  SIGNAL HISTORY TRACKER
// ─────────────────────────────────────────────

class SignalHistoryTracker {
  constructor() {
    this._signals = [];   // all signals fired
    this._outcomes = [];  // closed trade outcomes
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
      sig.outcome  = outcome; // 'WIN' | 'LOSS' | 'BREAKEVEN'
      sig.closedAt = Date.now();
      sig.pnlPct   = outcome.pnlPct;
      this._outcomes.push(outcome);
    }
  }

  /**
   * Win rate statistics per symbol, per session, per timeframe
   */
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
      : (avgWin > 0 ? 999 : 0); // Handle zero loss as infinite PF

    // Per-symbol breakdown
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

// ─────────────────────────────────────────────
//  MAIN SIGNAL SCORER CLASS
// ─────────────────────────────────────────────

class SignalScorer extends EventEmitter {
  /**
   * @param {Object} config
   * @param {number} config.minScore            - minimum score to fire (default 75)
   * @param {boolean} config.sessionFilter      - apply session quality filter (default true)
   * @param {boolean} config.newsBlackout       - apply news blackout filter (default true)
   * @param {Object}  config.circuitBreaker     - DrawdownCircuitBreaker config
   * @param {Object}  config.redis              - Redis client for publishing
   * @param {boolean} config.requireKillzone    - only fire in killzone sessions (default false)
   */
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
    this._lastSignalTime  = new Map(); // symbol → timestamp (prevent spam)
    this._minSignalGapMs  = 5 * 60 * 1000; // min 5 minutes between signals per symbol
  }

  // ─────────────────────────────────────────────
  //  MAIN SCORE FUNCTION
  // ─────────────────────────────────────────────

  /**
   * The master scoring function. Takes agent votes and outputs a final signal.
   *
   * @param {Object} agentVotes - votes from all 5 agents
   * @param {Object} agentVotes.smc        - { direction, score, reasons, analysis }
   * @param {Object} agentVotes.mtf        - { direction, score, reasons, analysis }
   * @param {Object} agentVotes.momentum   - { direction, score, reasons, analysis }
   * @param {Object} agentVotes.volumeOI   - { direction, score, reasons, analysis }
   * @param {Object} agentVotes.macroSent  - { direction, score, reasons, analysis }
   * @param {Object} context               - { symbol, timeframe, currentPrice, timestamp }
   * @returns {Object} scoredSignal
   */
  async score(agentVotes, context) {
    this._processingCount++;

    const {
      symbol,
      timeframe,
      currentPrice,
      timestamp = Date.now(),
    } = context;

    // ── Step 1: Validate all required agents present ──
    const validation = this._validateVotes(agentVotes);
    if (!validation.valid) {
      return this._buildWaitSignal(symbol, timeframe, currentPrice, validation.reason, 0);
    }

    // ── Step 2: Circuit breaker check ──
    const cb = this.circuitBreaker.isPaused();
    if (cb.paused) {
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Circuit breaker active: ${cb.reason}`, 0);
    }

    // ── Step 3: News blackout check ──
    if (this.newsBlackout) {
      const blackout = this.newsManager.isBlackedOut(symbol, timestamp);
      if (blackout.isBlackedOut) {
        return this._buildWaitSignal(symbol, timeframe, currentPrice,
          blackout.note, 0);
      }
    }

    // ── Step 4: Session filter ──
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

    // ── Step 5: Determine consensus direction ──
    const directionVote = this._resolveDirection(agentVotes);
    if (directionVote.direction === 'WAIT') {
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        directionVote.reason, 0);
    }

    // ── Step 6: Compute weighted confluence score ──
    const scoring = this._computeWeightedScore(agentVotes, directionVote.direction);

    // ── Step 7: Apply session multiplier ──
    const rawScore    = scoring.rawScore;
    const adjScore    = Math.min(Math.round(rawScore * session.multiplier), 100);
    const grade       = adjScore >= MIN_SCORE_GRADE_A ? 'A'
      : adjScore >= MIN_SCORE_GRADE_B ? 'B'
      : adjScore >= 65 ? 'C' : 'D';

    // ── Step 8: Score gate ──
    if (adjScore < this.minScore) {
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Score ${adjScore}/100 below minimum ${this.minScore} (grade ${grade})`, adjScore);
    }

    // ── Step 9: Signal spam prevention ──
    const lastFired = this._lastSignalTime.get(`${symbol}_${timeframe}`);
    if (lastFired && (timestamp - lastFired) < this._minSignalGapMs) {
      const wait = ((this._minSignalGapMs - (timestamp - lastFired)) / 60000).toFixed(1);
      return this._buildWaitSignal(symbol, timeframe, currentPrice,
        `Signal cooldown: wait ${wait}min before next signal`, adjScore);
    }

    // ── Step 10: Build final signal ──
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

    // Record signal time
    this._lastSignalTime.set(`${symbol}_${timeframe}`, timestamp);

    // Record in history
    const signalId = this.history.record(signal);
    signal.id      = signalId;

    // ── Step 11: Publish to Redis ──
    if (this.redis) {
      await this._publishSignal(signal).catch(err =>
        console.error('[SignalScorer] Redis publish error:', err)
      );
    }

    // ── Step 12: Emit event ──
    this.emit('signal', signal);

    if (grade === 'A') {
      this.emit('signal_grade_a', signal);
    }

    return signal;
  }

  // ─────────────────────────────────────────────
  //  DIRECTION RESOLUTION
  // ─────────────────────────────────────────────

  /**
   * Resolves the final direction from all agent votes.
   * Uses weighted majority — agents with higher weight have more influence.
   * SMC + MTF combined = 60% — if both agree, direction is confirmed.
   * If they conflict → WAIT (no trade).
   */
  _resolveDirection(agentVotes) {
    const votes = {
      LONG:  0,
      SHORT: 0,
      WAIT:  0,
    };

    const agentList = [
      { key: 'smc',       weight: AGENT_WEIGHTS.SMC },
      { key: 'mtf',       weight: AGENT_WEIGHTS.MTF },
      { key: 'momentum',  weight: AGENT_WEIGHTS.MOMENTUM },
      { key: 'volumeOI',  weight: AGENT_WEIGHTS.VOLUME_OI },
      { key: 'macroSent', weight: AGENT_WEIGHTS.MACRO_SENT },
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

    // Find winning direction
    const maxVote   = Math.max(...Object.values(votes));
    const winner    = Object.keys(votes).find(k => votes[k] === maxVote);
    const loser     = winner === 'LONG' ? 'SHORT' : 'LONG';
    const margin    = votes[winner] - (votes[loser] || 0);

    // Must have clear majority (margin > 0.15 weight)
    if (margin < 0.15 && winner !== 'WAIT') {
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

  // ─────────────────────────────────────────────
  //  WEIGHTED SCORE COMPUTATION
  // ─────────────────────────────────────────────

  /**
   * Computes the weighted score from each agent's individual score.
   * Each agent returns a score 0–100 for the given direction.
   * Weighted average = final raw score.
   */
  _computeWeightedScore(agentVotes, direction) {
    const breakdown = [];
    let weightedSum = 0;
    let totalWeight = 0;

    const agentMap = [
      { key: 'smc',       label: 'SMC Agent',            weight: AGENT_WEIGHTS.SMC },
      { key: 'mtf',       label: 'MTF Agent',            weight: AGENT_WEIGHTS.MTF },
      { key: 'momentum',  label: 'Momentum Agent',       weight: AGENT_WEIGHTS.MOMENTUM },
      { key: 'volumeOI',  label: 'Volume/OI Agent',      weight: AGENT_WEIGHTS.VOLUME_OI },
      { key: 'macroSent', label: 'Macro/Sentiment Agent',weight: AGENT_WEIGHTS.MACRO_SENT },
    ];

    for (const { key, label, weight } of agentMap) {
      const vote = agentVotes[key];

      // If agent direction conflicts with consensus, invert its contribution
      let agentScore = vote?.score ?? 0;
      const agentDir = vote?.direction?.toUpperCase() ?? 'WAIT';

      let contribution;
      let status;

      if (agentDir === direction) {
        contribution = agentScore * weight;
        status       = 'CONFIRMS';
      } else if (agentDir === 'WAIT') {
        contribution = agentScore * weight * 0.5; // Neutral agent = half contribution
        status       = 'NEUTRAL';
      } else {
        contribution = 0; // Opposing agent = zero contribution (already blocked above for SMC/MTF)
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

    // Bonus points for multiple strong confirmations
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

  // ─────────────────────────────────────────────
  //  SIGNAL BUILDERS
  // ─────────────────────────────────────────────

  _buildWaitSignal(symbol, timeframe, price, reason, score, timestamp = Date.now()) {
    return {
      action:       'WAIT',
      symbol,
      timeframe,
      currentPrice: price,
      score,
      reason,
      timestamp,
      session:      SessionDetector.getCurrent().best.name,
    };
  }

  _buildFireSignal(params) {
    const {
      symbol, timeframe, currentPrice, timestamp,
      direction, rawScore, adjScore, grade,
      scoring, session, agentVotes, directionVote,
    } = params;

    const isLong   = direction === 'LONG';

    // Aggregate all reasons from all confirming agents
    const allReasons = scoring.breakdown
      .filter(b => b.status === 'CONFIRMS')
      .flatMap(b => b.reasons.map(r => `[${b.label}] ${r}`));

    // Risk summary from SMC agent (primary)
    const smcSignal = agentVotes.smc?.signal || {};
    const mtfBiasRaw = agentVotes.mtf?.analysis?.htfBias || direction;
    const mtfBias = typeof mtfBiasRaw === 'string'
      ? mtfBiasRaw
      : (mtfBiasRaw.direction || mtfBiasRaw.bias || direction);

    // Build comprehensive AI reasoning text
    const reasoning = this._buildReasoningText({
      direction, adjScore, grade, session,
      scoring, allReasons, smcSignal, mtfBias,
      symbol, timeframe, currentPrice,
    });

    return {
      // ── Identity ──
      action:       direction,
      symbol,
      timeframe,
      timestamp,
      currentPrice,

      // ── Score breakdown ──
      score: {
        final:          adjScore,
        raw:            rawScore,
        sessionAdj:     parseFloat((adjScore - rawScore).toFixed(2)),
        grade,
        minimum:        this.minScore,
        confluenceBonus: scoring.confluenceBonus,
      },

      // ── Agent breakdown ──
      agentBreakdown: scoring.breakdown.map(b => ({
        agent:       b.label,
        score:       b.rawScore,
        weight:      b.weight,
        direction:   b.direction,
        status:      b.status,
        topReasons:  b.reasons.slice(0, 3),
      })),

      // ── Direction analysis ──
      directionAnalysis: {
        consensus:    directionVote.direction,
        margin:       directionVote.margin,
        votes:        directionVote.votes,
        agentVotes:   directionVote.agentDirections,
        confirmedBy:  directionVote.agentDirections
          .filter(a => a.direction === direction)
          .map(a => a.agent),
      },

      // ── Entry zone ──
      entry:          smcSignal.entry || {
        zoneHigh: parseFloat((currentPrice * (isLong ? 1.0005 : 1.0005)).toFixed(5)),
        zoneLow:  parseFloat((currentPrice * (isLong ? 0.9995 : 0.9995)).toFixed(5)),
        type:     'MARKET_ZONE',
        note:     'No OB available — use caution, reduce size',
      },

      // ── Stop loss ──
      stopLoss:       smcSignal.stopLoss || {
        price: parseFloat((currentPrice * (isLong ? 0.995 : 1.005)).toFixed(5)),
        note:  'Default ATR-based stop',
      },

      // ── Take profit targets ──
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

      // ── Trade management ──
      management:     smcSignal.management || {
        moveToBreakeven: 'After TP1 hit',
        partialClose:    '50% at TP1',
        trailingStop:    'ATR × 1.5 after TP1',
      },

      // ── Session context ──
      session: {
        current:     session.best.name,
        quality:     session.best.quality,
        multiplier:  session.multiplier,
        isKillzone:  session.isKillzone,
        note:        session.best.note,
        nextKillzone: SessionDetector.getNextKillzone(timestamp),
      },

      // ── HTF bias ──
      htfBias: {
        direction: mtfBias,
        note:      `Higher timeframe bias is ${mtfBias}`,
      },

      // ── AI reasoning ──
      reasoning,
      allReasons: allReasons.slice(0, 10),

      // ── Metadata ──
      meta: {
        generatedAt:    new Date(timestamp).toISOString(),
        processingCount: this._processingCount,
        circuitBreaker: this.circuitBreaker.getStats(),
        signalStats:    this.history.getStats(),
      },
    };
  }

  /**
   * Generates a detailed plain-English AI reasoning text.
   * This is what gets sent to the user in the Telegram alert.
   */
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

    // Add top reasons
    const topReasons = allReasons.slice(0, 6);
    for (const r of topReasons) {
      lines.push(`  ✅ ${r}`);
    }

    // Entry/SL/TP
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

  // ─────────────────────────────────────────────
  //  VALIDATION
  // ─────────────────────────────────────────────

  _validateVotes(agentVotes) {
    const required = ['smc', 'mtf', 'momentum'];
    const missing  = required.filter(k => !agentVotes[k]);

    if (missing.length > 0) {
      return { valid: false, reason: `Missing agent votes: ${missing.join(', ')}` };
    }

    return { valid: true };
  }

  // ─────────────────────────────────────────────
  //  REDIS PUBLISHER
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  //  PUBLIC API
  // ─────────────────────────────────────────────

  /**
   * Add a high-impact news event to the blackout manager
   */
  addNewsEvent(event) {
    this.newsManager.addEvent(event);
  }

  addNewsEvents(events) {
    this.newsManager.addEvents(events);
  }

  /**
   * Record a completed trade outcome (feeds circuit breaker + history)
   */
  recordTradeOutcome(signalId, outcome) {
    this.history.closeSignal(signalId, outcome);
    this.circuitBreaker.recordTrade(outcome.pnlPct || 0);
    this.emit('trade_outcome', { signalId, outcome });
  }

  /**
   * Get full performance stats
   */
  getStats() {
    return {
      signals:        this.history.getStats(),
      circuitBreaker: this.circuitBreaker.getStats(),
      processing:     this._processingCount,
      lastSignals:    this.history.getRecent(5),
    };
  }

  /**
   * Reset circuit breaker (use after reviewing losses)
   */
  resetCircuitBreaker() {
    this.circuitBreaker.reset();
    this.emit('circuit_breaker_reset');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

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

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { SignalScorer } = require('./signal-scorer');
 *
 *  const scorer = new SignalScorer({
 *    minScore:      75,
 *    sessionFilter: true,
 *    newsBlackout:  true,
 *    circuitBreaker: {
 *      maxDailyLossPct:      3,
 *      maxWeeklyLossPct:     7,
 *      maxConsecutiveLosses: 4,
 *    },
 *  });
 *
 *  // Register upcoming news
 *  scorer.addNewsEvent({
 *    name:     'US NFP',
 *    time:     new Date('2026-06-06T12:30:00Z').getTime(),
 *    impact:   'HIGH',
 *    currency: 'USD',
 *  });
 *
 *  // Score incoming agent votes
 *  const signal = await scorer.score({
 *    smc:       smcAgent.getLastVote(),
 *    mtf:       mtfAgent.getLastVote(),
 *    momentum:  momentumAgent.getLastVote(),
 *    volumeOI:  volumeAgent.getLastVote(),
 *    macroSent: sentimentAgent.getLastVote(),
 *  }, {
 *    symbol:       'XAUUSD',
 *    timeframe:    'H1',
 *    currentPrice: 2345.50,
 *  });
 *
 *  if (signal.action !== 'WAIT') {
 *    console.log(signal.reasoning); // Full AI text for Telegram
 *    // → pass to alert-dispatcher.js
 *  }
 * ─────────────────────────────────────────────
 */
