/**
 * ============================================================
 *  CONFLICT RESOLVER — Agent Vote Arbitration Engine
 *  AI Trading Assistant · Layer 3 · Orchestrator Module
 *  File: orchestrator/conflict-resolver.js
 * ============================================================
 *
 *  Modules inside this file:
 *
 *  1. AgentReliabilityScorer
 *     - Tracks each agent's historical accuracy (did its direction
 *       match the eventual signal outcome?)
 *     - Computes a dynamic reliability multiplier per agent
 *     - Decays old performance data so the engine adapts to regime changes
 *
 *  2. ConflictHistoryTracker
 *     - Logs every SMC/MTF/Momentum/Volume/Macro conflict
 *     - Detects recurring conflict patterns (e.g. SMC vs Momentum
 *       conflicting repeatedly during ranging markets)
 *     - Flags "regime change" when conflict rate spikes
 *
 *  3. VotingStrategies
 *     - WEIGHTED_MAJORITY  — default, weight × score per agent
 *     - UNANIMOUS_FOR_A    — Grade A requires SMC+MTF+Momentum agreement
 *     - RELIABILITY_ADJUSTED — weights scaled by AgentReliabilityScorer
 *     - CONSERVATIVE       — any HIGH-severity conflict = WAIT
 *
 *  4. ConflictExplainer
 *     - Generates human-readable explanations of why a conflict
 *       occurred and what resolution was chosen
 *     - Used in alert-dispatcher.js "Details" button output
 *
 *  5. ConflictResolver (main class)
 *     - resolve(votes, context) → { resolved, direction, votes, conflicts, note }
 *     - Same external contract as before, now backed by the above
 *       modules for adaptive, explainable conflict resolution
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

// Must mirror signal-scorer.js AGENT_WEIGHTS
const AGENT_WEIGHTS = {
  SMC:        0.35,
  MTF:        0.25,
  MOMENTUM:   0.20,
  VOLUME_OI:  0.10,
  MACRO_SENT: 0.10,
};

const AGENT_KEYS = {
  smc:       'SMC',
  mtf:       'MTF',
  momentum:  'MOMENTUM',
  volumeOI:  'VOLUME_OI',
  macroSent: 'MACRO_SENT',
};

const SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH:     'HIGH',
  MEDIUM:   'MEDIUM',
  LOW:      'LOW',
};

const VOTING_STRATEGY = {
  WEIGHTED_MAJORITY:     'WEIGHTED_MAJORITY',
  UNANIMOUS_FOR_A:       'UNANIMOUS_FOR_A',
  RELIABILITY_ADJUSTED:  'RELIABILITY_ADJUSTED',
  CONSERVATIVE:          'CONSERVATIVE',
};

// Reliability decay — older outcomes matter less
const RELIABILITY_DECAY        = 0.97;  // multiply running score by this each new outcome
const RELIABILITY_WINDOW       = 100;   // max outcomes tracked per agent
const RELIABILITY_MIN_SAMPLES  = 10;    // min samples before adjusting weight
const RELIABILITY_MAX_ADJUST   = 0.30;  // max ±30% weight adjustment from reliability

// Conflict regime detection
const REGIME_CONFLICT_WINDOW   = 20;    // last N analysis cycles
const REGIME_CONFLICT_THRESHOLD = 0.40; // >40% conflict rate = regime change

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────

const r     = (n, d = 4) => parseFloat((n ?? 0).toFixed(d));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ─────────────────────────────────────────────
//  1. AGENT RELIABILITY SCORER
// ─────────────────────────────────────────────

class AgentReliabilityScorer {
  /**
   * Tracks whether each agent's predicted direction matched the
   * eventual trade outcome. Produces a reliability multiplier
   * (0.70 to 1.30) applied on top of the static AGENT_WEIGHTS.
   */
  constructor() {
    // agentKey → { correct: number, total: number, history: [{correct, ts}] }
    this._records = new Map();
    for (const key of Object.keys(AGENT_KEYS)) {
      this._records.set(key, { correct: 0, total: 0, history: [], runningScore: 0.5 });
    }
  }

  /**
   * Record whether an agent's direction matched the final trade outcome.
   *
   * @param {string} agentKey - 'smc' | 'mtf' | 'momentum' | 'volumeOI' | 'macroSent'
   * @param {string} agentDirection - 'LONG' | 'SHORT' | 'WAIT'
   * @param {string} tradeOutcome   - 'WIN' | 'LOSS' | 'BREAKEVEN'
   * @param {string} signalDirection - the final fired signal direction
   */
  recordOutcome(agentKey, agentDirection, tradeOutcome, signalDirection) {
    const rec = this._records.get(agentKey);
    if (!rec) return;

    // "Correct" = agent agreed with the direction that won (WIN) or
    // disagreed with the direction that lost (would have avoided LOSS)
    let correct;
    if (tradeOutcome === 'WIN') {
      correct = agentDirection === signalDirection;
    } else if (tradeOutcome === 'LOSS') {
      correct = agentDirection !== signalDirection; // agent that dissented was "right"
    } else {
      return; // breakeven — no signal
    }

    rec.total++;
    if (correct) rec.correct++;

    rec.history.push({ correct, timestamp: Date.now() });
    if (rec.history.length > RELIABILITY_WINDOW) rec.history.shift();

    // Exponentially weighted running score (recent outcomes matter more)
    rec.runningScore = rec.runningScore * RELIABILITY_DECAY + (correct ? 1 : 0) * (1 - RELIABILITY_DECAY);

    this._records.set(agentKey, rec);
  }

  /**
   * Returns a weight multiplier for an agent based on its reliability.
   * 1.0 = neutral (default). Range: 1 - RELIABILITY_MAX_ADJUST to 1 + RELIABILITY_MAX_ADJUST.
   */
  getMultiplier(agentKey) {
    const rec = this._records.get(agentKey);
    if (!rec || rec.total < RELIABILITY_MIN_SAMPLES) return 1.0;

    // runningScore is ~0.5 if random, >0.5 if reliable, <0.5 if unreliable
    const deviation = (rec.runningScore - 0.5) * 2; // -1 to +1
    const adjustment = deviation * RELIABILITY_MAX_ADJUST;

    return r(clamp(1.0 + adjustment, 1 - RELIABILITY_MAX_ADJUST, 1 + RELIABILITY_MAX_ADJUST), 3);
  }

  /**
   * Returns adjusted weights for all agents (static weight × reliability multiplier,
   * renormalized to sum to 1.0)
   */
  getAdjustedWeights() {
    const adjusted = {};
    let total = 0;

    for (const [agentKey, weightKey] of Object.entries(AGENT_KEYS)) {
      const base = AGENT_WEIGHTS[weightKey];
      const mult = this.getMultiplier(agentKey);
      adjusted[agentKey] = base * mult;
      total += adjusted[agentKey];
    }

    // Renormalize so weights still sum to 1.0
    for (const key of Object.keys(adjusted)) {
      adjusted[key] = r(adjusted[key] / total, 4);
    }

    return adjusted;
  }

  getStats() {
    const stats = {};
    for (const [agentKey, rec] of this._records) {
      stats[agentKey] = {
        total:        rec.total,
        correct:      rec.correct,
        accuracy:     rec.total > 0 ? r(rec.correct / rec.total * 100, 2) : null,
        runningScore: r(rec.runningScore, 4),
        multiplier:   this.getMultiplier(agentKey),
        sampleSize:   rec.total >= RELIABILITY_MIN_SAMPLES ? 'SUFFICIENT' : 'INSUFFICIENT',
      };
    }
    return stats;
  }

  exportState() {
    const out = {};
    for (const [key, rec] of this._records) out[key] = rec;
    return out;
  }

  importState(state) {
    if (!state) return;
    for (const [key, rec] of Object.entries(state)) {
      this._records.set(key, rec);
    }
  }
}

// ─────────────────────────────────────────────
//  2. CONFLICT HISTORY TRACKER
// ─────────────────────────────────────────────

class ConflictHistoryTracker {
  /**
   * Logs every conflict detected during analysis cycles and
   * identifies recurring patterns / regime changes.
   */
  constructor() {
    this._log = []; // { timestamp, symbol, timeframe, conflicts: [...], resolution }
  }

  record(entry) {
    this._log.push({ ...entry, timestamp: Date.now() });
    if (this._log.length > 500) this._log.shift();
  }

  /**
   * Conflict rate over the last N cycles for a symbol (or global if no symbol given)
   */
  getConflictRate(symbol = null, window = REGIME_CONFLICT_WINDOW) {
    const filtered = symbol
      ? this._log.filter(e => e.symbol === symbol)
      : this._log;

    const recent = filtered.slice(-window);
    if (recent.length === 0) return { rate: 0, sample: 0 };

    const conflictCount = recent.filter(e => e.conflicts?.length > 0).length;
    return {
      rate:   r(conflictCount / recent.length, 3),
      sample: recent.length,
      isRegimeChange: (conflictCount / recent.length) >= REGIME_CONFLICT_THRESHOLD,
    };
  }

  /**
   * Find the most common conflict type for a symbol
   */
  getMostCommonConflictType(symbol = null, window = REGIME_CONFLICT_WINDOW) {
    const filtered = symbol
      ? this._log.filter(e => e.symbol === symbol)
      : this._log;

    const recent = filtered.slice(-window);
    const typeCounts = {};

    for (const entry of recent) {
      for (const c of entry.conflicts || []) {
        typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
      }
    }

    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    return sorted[0] ? { type: sorted[0][0], count: sorted[0][1] } : null;
  }

  /**
   * Get recent conflict log entries
   */
  getRecent(symbol = null, n = 10) {
    const filtered = symbol
      ? this._log.filter(e => e.symbol === symbol)
      : this._log;
    return filtered.slice(-n).reverse();
  }

  /**
   * Full regime analysis across all tracked symbols
   */
  getRegimeAnalysis() {
    const symbols = [...new Set(this._log.map(e => e.symbol))];
    const result = {};

    for (const symbol of symbols) {
      const rate = this.getConflictRate(symbol);
      const commonType = this.getMostCommonConflictType(symbol);

      result[symbol] = {
        ...rate,
        mostCommonConflict: commonType,
        note: rate.isRegimeChange
          ? `${symbol}: ${(rate.rate * 100).toFixed(0)}% conflict rate — possible regime change` +
            (commonType ? ` (mostly ${commonType.type})` : '')
          : `${symbol}: normal conflict rate (${(rate.rate * 100).toFixed(0)}%)`,
      };
    }

    return result;
  }
}

// ─────────────────────────────────────────────
//  3. VOTING STRATEGIES
// ─────────────────────────────────────────────

class VotingStrategies {
  /**
   * WEIGHTED_MAJORITY — default strategy.
   * Sum of (weight × 1) per direction, highest wins if margin sufficient.
   */
  static weightedMajority(votes, weights) {
    const tally = { LONG: 0, SHORT: 0, WAIT: 0 };
    const breakdown = [];

    for (const [agentKey, weight] of Object.entries(weights)) {
      const vote = votes[agentKey];
      const dir  = vote?.direction?.toUpperCase() || 'WAIT';
      tally[dir] = (tally[dir] || 0) + weight;
      breakdown.push({ agent: agentKey, direction: dir, weight, score: vote?.score ?? 0 });
    }

    const maxVote = Math.max(tally.LONG, tally.SHORT, tally.WAIT);
    const winner  = Object.keys(tally).find(k => tally[k] === maxVote);
    const runnerUp = winner === 'LONG' ? tally.SHORT : winner === 'SHORT' ? tally.LONG : Math.max(tally.LONG, tally.SHORT);
    const margin   = maxVote - runnerUp;

    return {
      strategy:  VOTING_STRATEGY.WEIGHTED_MAJORITY,
      direction: margin >= 0.15 ? winner : 'WAIT',
      tally,
      margin: r(margin, 3),
      breakdown,
    };
  }

  /**
   * UNANIMOUS_FOR_A — Grade A signals require SMC + MTF + Momentum
   * to ALL agree on direction. Otherwise falls back to weighted majority
   * but caps the result at Grade B.
   */
  static unanimousForA(votes, weights) {
    const core = ['smc', 'mtf', 'momentum'];
    const coreDirections = core.map(k => votes[k]?.direction?.toUpperCase() || 'WAIT');
    const allAgree = coreDirections.every(d => d === coreDirections[0]) && coreDirections[0] !== 'WAIT';

    const base = this.weightedMajority(votes, weights);

    return {
      ...base,
      strategy: VOTING_STRATEGY.UNANIMOUS_FOR_A,
      gradeCapApplied: !allAgree,
      gradeCap: allAgree ? null : 'B',
      coreAgreement: allAgree,
      note: allAgree
        ? 'SMC + MTF + Momentum unanimous — Grade A eligible'
        : 'Core agents not unanimous — capped at Grade B',
    };
  }

  /**
   * RELIABILITY_ADJUSTED — uses AgentReliabilityScorer-adjusted weights
   * instead of static AGENT_WEIGHTS.
   */
  static reliabilityAdjusted(votes, reliabilityScorer) {
    const adjustedWeights = reliabilityScorer.getAdjustedWeights();
    const base = this.weightedMajority(votes, adjustedWeights);

    return {
      ...base,
      strategy: VOTING_STRATEGY.RELIABILITY_ADJUSTED,
      adjustedWeights,
      reliabilityStats: reliabilityScorer.getStats(),
    };
  }

  /**
   * CONSERVATIVE — any HIGH or CRITICAL severity conflict = WAIT,
   * regardless of weighted majority outcome.
   */
  static conservative(votes, weights, conflicts) {
    const base = this.weightedMajority(votes, weights);
    const blocking = conflicts.filter(c => c.severity === SEVERITY.HIGH || c.severity === SEVERITY.CRITICAL);

    if (blocking.length > 0) {
      return {
        ...base,
        strategy:  VOTING_STRATEGY.CONSERVATIVE,
        direction: 'WAIT',
        overridden: true,
        overrideReason: blocking.map(c => c.note).join('; '),
      };
    }

    return { ...base, strategy: VOTING_STRATEGY.CONSERVATIVE, overridden: false };
  }
}

// ─────────────────────────────────────────────
//  4. CONFLICT EXPLAINER
// ─────────────────────────────────────────────

class ConflictExplainer {
  /**
   * Generates a human-readable explanation of a resolution decision.
   * Used in Telegram "Details" button and web dashboard.
   */
  static explain(resolution) {
    const lines = [];

    lines.push(`Resolution: ${resolution.resolution}`);
    lines.push(`Strategy used: ${resolution.votingResult?.strategy ?? 'WEIGHTED_MAJORITY'}`);

    if (resolution.votingResult?.tally) {
      const t = resolution.votingResult.tally;
      lines.push(`Vote tally — LONG: ${r(t.LONG,3)}, SHORT: ${r(t.SHORT,3)}, WAIT: ${r(t.WAIT,3)}`);
    }

    if (resolution.conflicts.length === 0) {
      lines.push('No conflicts detected — all agents in reasonable agreement.');
    } else {
      lines.push(`${resolution.conflicts.length} conflict(s) detected:`);
      for (const c of resolution.conflicts) {
        lines.push(`  [${c.severity}] ${c.type}: ${c.note}`);
      }
    }

    if (resolution.votingResult?.gradeCapApplied) {
      lines.push(`Note: ${resolution.votingResult.note}`);
    }

    if (resolution.votingResult?.overridden) {
      lines.push(`Override: ${resolution.votingResult.overrideReason}`);
    }

    if (resolution.regimeWarning) {
      lines.push(`⚠️ Regime warning: ${resolution.regimeWarning.note}`);
    }

    return lines.join('\n');
  }

  /**
   * Short one-line summary (for compact UI)
   */
  static shortExplain(resolution) {
    if (resolution.conflicts.length === 0) {
      return `${resolution.direction} — agents aligned`;
    }
    const top = resolution.conflicts[0];
    return `${resolution.direction} — ${resolution.conflicts.length} conflict(s), top: ${top.type}`;
  }
}

// ─────────────────────────────────────────────
//  5. MAIN CONFLICT RESOLVER CLASS
// ─────────────────────────────────────────────

class ConflictResolver {
  /**
   * @param {Object} config
   * @param {string} config.strategy - VOTING_STRATEGY value (default WEIGHTED_MAJORITY)
   * @param {boolean} config.useReliabilityWeights - apply AgentReliabilityScorer (default true)
   * @param {boolean} config.conservativeOverride - apply CONSERVATIVE override on top (default true)
   */
  constructor(config = {}) {
    this.strategy             = config.strategy ?? VOTING_STRATEGY.WEIGHTED_MAJORITY;
    this.useReliabilityWeights = config.useReliabilityWeights !== false;
    this.conservativeOverride  = config.conservativeOverride  !== false;

    this.reliabilityScorer = new AgentReliabilityScorer();
    this.historyTracker    = new ConflictHistoryTracker();
  }

  /**
   * Main resolution function — same external contract as the original
   * bundled version in task-planner.js, now with adaptive weighting,
   * history tracking, and explainability.
   *
   * @param {Object} votes - { smc, mtf, momentum, volumeOI, macroSent }
   * @param {Object} context - { symbol, timeframe, currentPrice, liquidationAlert }
   * @returns {Object} { resolved, direction, votes, conflicts, note, votingResult, explanation }
   */
  resolve(votes, context = {}) {
    const { symbol, timeframe } = context;
    const conflicts = [];
    const resVotes  = { ...votes };

    const smcDir   = votes.smc?.direction?.toUpperCase();
    const mtfDir   = votes.mtf?.direction?.toUpperCase();
    const momDir   = votes.momentum?.direction?.toUpperCase();
    const volDir   = votes.volumeOI?.direction?.toUpperCase();
    const macroDir = votes.macroSent?.direction?.toUpperCase();

    // ── Rule: Liquidation cascade override ──
    if (context.liquidationAlert?.isCascade) {
      conflicts.push({
        type:     'LIQUIDATION_CASCADE',
        severity: SEVERITY.CRITICAL,
        note:     `Liquidation cascade in progress ($${(context.liquidationAlert.totalUSDT / 1e6).toFixed(2)}M)`,
      });
    }

    // ── Rule: SMC vs MTF fundamental conflict ──
    if (smcDir && mtfDir && smcDir !== 'WAIT' && mtfDir !== 'WAIT' && smcDir !== mtfDir) {
      conflicts.push({
        type:     'SMC_MTF_CONFLICT',
        severity: SEVERITY.HIGH,
        smcDir, mtfDir,
        note:     `SMC says ${smcDir} but MTF says ${mtfDir} — fundamental structure/trend conflict`,
      });
    }

    // ── Rule: Momentum opposes SMC ──
    if (smcDir && momDir && smcDir !== 'WAIT' && momDir !== 'WAIT' && smcDir !== momDir) {
      conflicts.push({
        type:     'MOMENTUM_OPPOSES_SMC',
        severity: SEVERITY.MEDIUM,
        note:     `Momentum (${momDir}) opposes SMC (${smcDir}) — 20% score penalty applied to SMC`,
      });

      if (resVotes.smc) {
        resVotes.smc = {
          ...resVotes.smc,
          score:   Math.round(votes.smc.score * 0.80),
          reasons: [...(votes.smc.reasons || []), '⚠️ 20% penalty: momentum opposes SMC direction'],
        };
      }
    }

    // ── Rule: Volume opposes SMC ──
    if (smcDir && volDir && smcDir !== 'WAIT' && volDir !== 'WAIT' && smcDir !== volDir) {
      conflicts.push({
        type:     'VOLUME_OPPOSES_SMC',
        severity: SEVERITY.LOW,
        note:     `Volume/OI (${volDir}) opposes SMC (${smcDir})`,
      });
    }

    // ── Rule: Macro/Sentiment opposes everything ──
    const technicalConsensus = [smcDir, mtfDir, momDir].filter(d => d && d !== 'WAIT');
    if (macroDir && macroDir !== 'WAIT' && technicalConsensus.length >= 2) {
      const allTechAgree = technicalConsensus.every(d => d === technicalConsensus[0]);
      if (allTechAgree && macroDir !== technicalConsensus[0]) {
        conflicts.push({
          type:     'MACRO_OPPOSES_TECHNICALS',
          severity: SEVERITY.MEDIUM,
          note:     `Macro/Sentiment (${macroDir}) opposes technical consensus (${technicalConsensus[0]}) — fundamental headwind`,
        });
      }
    }

    // ── Voting ──
    const weights = this.useReliabilityWeights
      ? this.reliabilityScorer.getAdjustedWeights()
      : Object.fromEntries(Object.entries(AGENT_KEYS).map(([k, v]) => [k, AGENT_WEIGHTS[v]]));

    let votingResult;
    switch (this.strategy) {
      case VOTING_STRATEGY.UNANIMOUS_FOR_A:
        votingResult = VotingStrategies.unanimousForA(resVotes, weights);
        break;
      case VOTING_STRATEGY.RELIABILITY_ADJUSTED:
        votingResult = VotingStrategies.reliabilityAdjusted(resVotes, this.reliabilityScorer);
        break;
      case VOTING_STRATEGY.CONSERVATIVE:
        votingResult = VotingStrategies.conservative(resVotes, weights, conflicts);
        break;
      default:
        votingResult = VotingStrategies.weightedMajority(resVotes, weights);
    }

    // SMC/MTF HIGH conflict always forces WAIT regardless of strategy
    const hasHighConflict = conflicts.some(c => c.severity === SEVERITY.HIGH || c.severity === SEVERITY.CRITICAL);
    let direction = hasHighConflict ? 'WAIT' : votingResult.direction;

    // Apply conservative override on top of any strategy if enabled
    if (this.conservativeOverride && !hasHighConflict) {
      const consResult = VotingStrategies.conservative(resVotes, weights, conflicts);
      if (consResult.overridden) {
        direction = 'WAIT';
        votingResult.overridden = true;
        votingResult.overrideReason = consResult.overrideReason;
      }
    }

    // ── Regime check ──
    const conflictRate = this.historyTracker.getConflictRate(symbol);
    const regimeWarning = conflictRate.isRegimeChange
      ? {
          rate: conflictRate.rate,
          note: `${symbol}: ${(conflictRate.rate * 100).toFixed(0)}% conflict rate over last ${conflictRate.sample} cycles — market regime may be changing`,
        }
      : null;

    const resolution = {
      resolved:   conflicts.filter(c => c.severity === SEVERITY.HIGH || c.severity === SEVERITY.CRITICAL).length === 0,
      direction,
      resolution: direction,
      votes:      resVotes,
      originalVotes: votes,
      conflicts,
      votingResult,
      regimeWarning,
      note: hasHighConflict
        ? conflicts.find(c => c.severity === SEVERITY.HIGH || c.severity === SEVERITY.CRITICAL)?.note
        : votingResult.note ?? `${direction} via ${votingResult.strategy}`,
      stats: {
        longCount:  [smcDir, mtfDir, momDir, volDir, macroDir].filter(d => d === 'LONG').length,
        shortCount: [smcDir, mtfDir, momDir, volDir, macroDir].filter(d => d === 'SHORT').length,
        waitCount:  [smcDir, mtfDir, momDir, volDir, macroDir].filter(d => d === 'WAIT').length,
        totalAgents: [smcDir, mtfDir, momDir, volDir, macroDir].filter(Boolean).length,
      },
    };

    resolution.explanation = ConflictExplainer.explain(resolution);
    resolution.shortExplanation = ConflictExplainer.shortExplain(resolution);

    // Log for history/regime tracking
    this.historyTracker.record({ symbol, timeframe, conflicts, resolution: direction });

    return resolution;
  }

  /**
   * Feed back trade outcomes to update agent reliability scores.
   * Call this from signal-scorer.js / risk-engine.js when a trade closes.
   *
   * @param {Object} agentDirections - { smc: 'LONG', mtf: 'LONG', ... } at time of signal
   * @param {string} tradeOutcome    - 'WIN' | 'LOSS' | 'BREAKEVEN'
   * @param {string} signalDirection - the direction that was actually traded
   */
  recordTradeOutcome(agentDirections, tradeOutcome, signalDirection) {
    for (const [agentKey, direction] of Object.entries(agentDirections)) {
      this.reliabilityScorer.recordOutcome(agentKey, direction, tradeOutcome, signalDirection);
    }
  }

  /**
   * Full dashboard — reliability scores + conflict regime analysis
   */
  getStats() {
    return {
      strategy:           this.strategy,
      reliability:        this.reliabilityScorer.getStats(),
      adjustedWeights:    this.reliabilityScorer.getAdjustedWeights(),
      regimeAnalysis:     this.historyTracker.getRegimeAnalysis(),
      recentConflicts:    this.historyTracker.getRecent(null, 10),
    };
  }

  getSymbolConflicts(symbol, n = 10) {
    return this.historyTracker.getRecent(symbol, n);
  }

  exportState() {
    return { reliability: this.reliabilityScorer.exportState() };
  }

  importState(state) {
    if (state?.reliability) this.reliabilityScorer.importState(state.reliability);
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  ConflictResolver,
  AgentReliabilityScorer,
  ConflictHistoryTracker,
  VotingStrategies,
  ConflictExplainer,
  AGENT_WEIGHTS,
  AGENT_KEYS,
  SEVERITY,
  VOTING_STRATEGY,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { ConflictResolver, VOTING_STRATEGY } = require('./orchestrator/conflict-resolver');
 *
 *  const resolver = new ConflictResolver({
 *    strategy:              VOTING_STRATEGY.WEIGHTED_MAJORITY,
 *    useReliabilityWeights: true,
 *    conservativeOverride:  true,
 *  });
 *
 *  // In task-planner.js analysis cycle:
 *  const resolution = resolver.resolve({
 *    smc:       smcAgent.getLastVote(),
 *    mtf:       mtfAgent.getLastVote(),
 *    momentum:  momentumAgent.getLastVote(),
 *    volumeOI:  volumeAgent.getLastVote(),
 *    macroSent: macroAgent.getLastVote(),
 *  }, {
 *    symbol: 'XAUUSD',
 *    timeframe: 'H1',
 *    currentPrice: 2345.50,
 *    liquidationAlert: feed._liquidationState,
 *  });
 *
 *  console.log(resolution.direction);       // 'LONG' | 'SHORT' | 'WAIT'
 *  console.log(resolution.explanation);     // multi-line human-readable explanation
 *  console.log(resolution.shortExplanation); // one-liner for compact UI
 *
 *  // When a trade closes — feed back for reliability scoring
 *  resolver.recordTradeOutcome(
 *    { smc: 'LONG', mtf: 'LONG', momentum: 'LONG', volumeOI: 'WAIT', macroSent: 'SHORT' },
 *    'WIN',
 *    'LONG'
 *  );
 *
 *  // Dashboard
 *  console.log(resolver.getStats());
 *  // → reliability per agent, adjusted weights, regime warnings per symbol
 * ─────────────────────────────────────────────
 */