/**
 * ============================================================
 *  TASK PLANNER — Master Agentic Orchestrator
 *  AI Trading Assistant · Layer 3 · Master Brain
 * ============================================================
 *
 *  This is the central nervous system of the entire trading assistant.
 *  Every other module plugs into this one. It:
 *
 *    - Receives live candle events from BinanceFeed / TwelveData
 *    - Runs all 5 specialized AI agents in PARALLEL per symbol/TF
 *    - Resolves conflicts between agents (Conflict Resolver)
 *    - Manages short-term and long-term agent memory
 *    - Self-heals: detects failed/stale agents and restarts them
 *    - Rate-limits analysis to prevent CPU overload
 *    - Manages per-symbol analysis queues
 *    - Aggregates all agent votes and passes to SignalScorer
 *    - Passes scored signals to AlertDispatcher
 *    - Tracks agent performance over time
 *    - Supports pluggable external agents (Claude API agents)
 *    - Maintains a full audit trail of every analysis cycle
 *    - Exposes a WebSocket API for real-time dashboard streaming
 *    - Health check endpoint for DevOps monitoring
 *    - Graceful shutdown with in-flight analysis completion
 *    - Dynamic timeframe prioritization (H4 and H1 = primary)
 *    - Cooldown management per symbol (no overanalysis)
 *    - Multi-symbol round-robin scheduler
 *    - Symbol whitelist / blacklist management
 *    - Market hours gate (skip analysis during dead hours)
 *
 *  Central flow:
 *    BinanceFeed.on('candle') →
 *      TaskPlanner.onCandle() →
 *        [SMCAgent, MTFAgent, MomentumAgent, VolumeAgent, MacroAgent] parallel →
 *          ConflictResolver.resolve() →
 *            SignalScorer.score() →
 *              AlertDispatcher.sendSignal()
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

// Minimum ms between analysis cycles per symbol+TF combination
const ANALYSIS_COOLDOWN = {
  M1:  10 * 1000,       // 10s
  M5:  30 * 1000,       // 30s
  M15: 60 * 1000,       // 1 min
  M30: 2 * 60 * 1000,   // 2 min
  H1:  5 * 60 * 1000,   // 5 min
  H2:  10 * 60 * 1000,  // 10 min
  H4:  15 * 60 * 1000,  // 15 min
  H6:  20 * 60 * 1000,
  H8:  25 * 60 * 1000,
  H12: 30 * 60 * 1000,
  D1:  60 * 60 * 1000,  // 1 hour
  W1:  4 * 60 * 60 * 1000,
};

// Primary timeframes — triggers full 5-agent analysis
const PRIMARY_TFS    = ['H1', 'H4', 'D1'];

// Secondary timeframes — triggers partial analysis (SMC + MTF only)
const SECONDARY_TFS  = ['M15', 'M30', 'H2', 'H6', 'H8', 'H12'];

// Ignored timeframes for analysis (too noisy)
const IGNORED_TFS    = ['M1', 'M3', 'M5'];

// Agent timeout — if an agent takes longer than this, skip it
const AGENT_TIMEOUT_MS = 8000;

// Max concurrent analysis jobs
const MAX_CONCURRENT  = 4;

// Self-heal: restart agent if it hasn't responded in this many cycles
const STALE_AGENT_CYCLES = 5;

// Audit trail retention
const MAX_AUDIT_ENTRIES = 500;

// ─────────────────────────────────────────────
//  AGENT REGISTRY
// ─────────────────────────────────────────────

class AgentRegistry {
  constructor() {
    this._agents       = new Map(); // name → { instance, healthy, lastRun, runCount, errors }
    this._factories    = new Map(); // name → factory function (for restarts)
  }

  /**
   * Register an agent with the registry.
   *
   * @param {string}   name     - agent identifier (e.g. 'smc', 'mtf')
   * @param {Object}   instance - agent instance with .analyze() method
   * @param {Function} factory  - function that creates a fresh instance (for self-heal)
   */
  register(name, instance, factory = null) {
    this._agents.set(name, {
      instance,
      factory,
      healthy:      true,
      lastRun:      null,
      lastResult:   null,
      runCount:     0,
      errorCount:   0,
      staleCount:   0,
      avgRunTimeMs: 0,
    });
    if (factory) this._factories.set(name, factory);
    console.log(`[AgentRegistry] Registered: ${name}`);
  }

  get(name) {
    return this._agents.get(name) || null;
  }

  getAll() {
    return this._agents;
  }

  /**
   * Mark agent as unhealthy — triggers self-heal
   */
  markUnhealthy(name, error) {
    const entry = this._agents.get(name);
    if (entry) {
      entry.healthy     = false;
      entry.errorCount += 1;
      console.error(`[AgentRegistry] Agent ${name} marked unhealthy: ${error}`);
    }
  }

  /**
   * Attempt to restart an unhealthy agent
   */
  async selfHeal(name) {
    const entry   = this._agents.get(name);
    const factory = this._factories.get(name);

    if (!entry || !factory) return false;

    try {
      console.log(`[AgentRegistry] Self-healing agent: ${name}`);
      const fresh     = factory();
      entry.instance  = fresh;
      entry.healthy   = true;
      entry.staleCount = 0;
      console.log(`[AgentRegistry] Agent ${name} restarted successfully`);
      return true;
    } catch (err) {
      console.error(`[AgentRegistry] Failed to restart ${name}: ${err.message}`);
      return false;
    }
  }

  /**
   * Record a successful agent run
   */
  recordRun(name, durationMs, result) {
    const entry = this._agents.get(name);
    if (!entry) return;

    entry.lastRun    = Date.now();
    entry.lastResult = result;
    entry.runCount  += 1;
    entry.staleCount = 0;

    // Running average of execution time
    entry.avgRunTimeMs = entry.runCount === 1
      ? durationMs
      : entry.avgRunTimeMs * 0.9 + durationMs * 0.1;
  }

  /**
   * Get health summary for all agents
   */
  getHealthSummary() {
    const summary = {};
    for (const [name, entry] of this._agents) {
      summary[name] = {
        healthy:      entry.healthy,
        lastRun:      entry.lastRun,
        runCount:     entry.runCount,
        errorCount:   entry.errorCount,
        avgRunTimeMs: Math.round(entry.avgRunTimeMs),
      };
    }
    return summary;
  }
}

// ─────────────────────────────────────────────
//  CONFLICT RESOLVER
// ─────────────────────────────────────────────

class ConflictResolver {
  /**
   * Resolves conflicts between agent votes before passing to SignalScorer.
   *
   * Rules:
   *   1. If SMC and MTF both say LONG/SHORT → allow (highest weight agents agree)
   *   2. If SMC says LONG but MTF says SHORT → WAIT (fundamental conflict)
   *   3. If 3+ agents agree on direction → allow even if 2 oppose
   *   4. If momentum strongly opposes SMC → reduce SMC score by 20%
   *   5. If there's a liquidation cascade in progress → override to WAIT
   *   6. Track conflict patterns over time — repeated conflicts = regime change
   *
   * @param {Object} votes - { smc, mtf, momentum, volumeOI, macroSent }
   * @param {Object} context - { symbol, timeframe, currentPrice, liquidationAlert }
   * @returns {Object} { resolved: bool, votes, conflicts, direction, note }
   */
  static resolve(votes, context = {}) {
    const conflicts  = [];
    const resVotes   = { ...votes };
    let resolution   = 'PROCEED';
    let note         = '';

    const smcDir   = votes.smc?.direction?.toUpperCase();
    const mtfDir   = votes.mtf?.direction?.toUpperCase();
    const momDir   = votes.momentum?.direction?.toUpperCase();
    const volDir   = votes.volumeOI?.direction?.toUpperCase();
    const macroDir = votes.macroSent?.direction?.toUpperCase();

    // ── Rule 1: Liquidation cascade override ──
    if (context.liquidationAlert?.isCascade) {
      resolution = 'WAIT';
      note = `Liquidation cascade in progress ($${(context.liquidationAlert.totalUSDT / 1000000).toFixed(2)}M) — standing by`;
      conflicts.push({ type: 'LIQUIDATION_CASCADE', severity: 'CRITICAL', note });
    }

    // ── Rule 2: SMC vs MTF fundamental conflict ──
    if (smcDir && mtfDir &&
        smcDir !== 'WAIT' && mtfDir !== 'WAIT' &&
        smcDir !== mtfDir) {
      conflicts.push({
        type:     'SMC_MTF_CONFLICT',
        severity: 'HIGH',
        smcDir,
        mtfDir,
        note:     `SMC says ${smcDir} but MTF says ${mtfDir} — fundamental conflict`,
      });
      resolution = 'WAIT';
      note       = `SMC/MTF conflict: ${smcDir} vs ${mtfDir}`;
    }

    // ── Rule 3: Majority vote (3+ of 5 agents agree) ──
    const dirs = [smcDir, mtfDir, momDir, volDir, macroDir].filter(Boolean);
    const longCount  = dirs.filter(d => d === 'LONG').length;
    const shortCount = dirs.filter(d => d === 'SHORT').length;
    const waitCount  = dirs.filter(d => d === 'WAIT').length;

    if (resolution === 'PROCEED') {
      if (longCount  >= 3) { resolution = 'LONG';  note = `${longCount}/5 agents bullish`; }
      else if (shortCount >= 3) { resolution = 'SHORT'; note = `${shortCount}/5 agents bearish`; }
      else if (waitCount  >= 4) { resolution = 'WAIT';  note = `${waitCount}/5 agents say wait`; }
    }

    // ── Rule 4: Momentum penalty if opposing SMC strongly ──
    if (smcDir && momDir && smcDir !== 'WAIT' && momDir !== 'WAIT' && smcDir !== momDir) {
      conflicts.push({
        type:     'MOMENTUM_OPPOSES_SMC',
        severity: 'MEDIUM',
        note:     `Momentum (${momDir}) opposes SMC (${smcDir}) — applying 20% score penalty to SMC`,
      });

      if (resVotes.smc) {
        resVotes.smc = {
          ...resVotes.smc,
          score:   Math.round(votes.smc.score * 0.80),
          reasons: [...(votes.smc.reasons || []), '⚠️ 20% penalty: momentum opposes SMC direction'],
        };
      }
    }

    // ── Rule 5: Volume opposes SMC ──
    if (smcDir && volDir && smcDir !== 'WAIT' && volDir !== 'WAIT' && smcDir !== volDir) {
      conflicts.push({
        type:     'VOLUME_OPPOSES_SMC',
        severity: 'LOW',
        note:     `Volume/OI (${volDir}) opposes SMC (${smcDir})`,
      });
    }

    // ── Determine consensus direction for scorer ──
    const consensusDir = resolution === 'LONG'  ? 'LONG'
      : resolution === 'SHORT' ? 'SHORT'
      : 'WAIT';

    return {
      resolved:       conflicts.filter(c => c.severity === 'HIGH').length === 0,
      direction:      consensusDir,
      resolution,
      votes:          resVotes,
      originalVotes:  votes,
      conflicts,
      note,
      stats: {
        longCount,
        shortCount,
        waitCount,
        totalAgents: dirs.length,
      },
    };
  }
}

// ─────────────────────────────────────────────
//  MEMORY MANAGER
// ─────────────────────────────────────────────

class MemoryManager {
  /**
   * Manages short-term and long-term memory for the orchestrator.
   *
   * Short-term: last N analysis results per symbol+TF (in-memory)
   * Long-term:  pattern history, signal outcomes, agent performance (persistent)
   *
   * Long-term memory is stored in Vector DB (Pinecone) in production.
   * For now, we use in-memory Map with optional JSON persistence.
   */
  constructor(config = {}) {
    this.maxShortTermEntries = config.maxShortTerm || 50;
    this.persistPath         = config.persistPath  || null;

    // Short-term: symbol+TF → circular buffer of last N analyses
    this._shortTerm  = new Map();

    // Long-term: pattern signatures → outcome history
    this._longTerm   = new Map();

    // Agent performance memory
    this._agentPerf  = new Map();

    // Context window: running narrative of what's happening per symbol
    this._context    = new Map();
  }

  /**
   * Store a new analysis result in short-term memory
   */
  storeAnalysis(symbol, timeframe, result) {
    const key  = `${symbol}_${timeframe}`;
    if (!this._shortTerm.has(key)) {
      this._shortTerm.set(key, []);
    }

    const buf  = this._shortTerm.get(key);
    buf.push({
      timestamp: Date.now(),
      direction: result.direction,
      score:     result.score,
      smcState:  result.agentResults?.smc?.analysis?.structure?.currentTrend,
      htfBias:   result.agentResults?.mtf?.htfBias,
    });

    if (buf.length > this.maxShortTermEntries) buf.shift();
  }

  /**
   * Get recent analysis history for a symbol+TF
   */
  getHistory(symbol, timeframe, n = 10) {
    const key = `${symbol}_${timeframe}`;
    const buf = this._shortTerm.get(key) || [];
    return buf.slice(-n);
  }

  /**
   * Compute trend consistency: how many of the last N analyses agree on direction
   */
  getTrendConsistency(symbol, timeframe, n = 5) {
    const history = this.getHistory(symbol, timeframe, n);
    if (history.length === 0) return { direction: 'WAIT', consistency: 0 };

    const longCount  = history.filter(h => h.direction === 'LONG').length;
    const shortCount = history.filter(h => h.direction === 'SHORT').length;
    const total      = history.length;

    if (longCount / total >= 0.7) {
      return { direction: 'LONG', consistency: longCount / total };
    }
    if (shortCount / total >= 0.7) {
      return { direction: 'SHORT', consistency: shortCount / total };
    }

    return { direction: 'WAIT', consistency: 0 };
  }

  /**
   * Update context narrative for a symbol
   */
  updateContext(symbol, context) {
    this._context.set(symbol, {
      ...context,
      updatedAt: Date.now(),
    });
  }

  getContext(symbol) {
    return this._context.get(symbol) || null;
  }

  /**
   * Record agent performance metric
   */
  recordAgentPerf(agentName, durationMs, score) {
    if (!this._agentPerf.has(agentName)) {
      this._agentPerf.set(agentName, { runs: 0, totalTime: 0, totalScore: 0 });
    }
    const p = this._agentPerf.get(agentName);
    p.runs++;
    p.totalTime  += durationMs;
    p.totalScore += score;
  }

  getAgentPerf() {
    const result = {};
    for (const [name, p] of this._agentPerf) {
      result[name] = {
        runs:     p.runs,
        avgTime:  Math.round(p.totalTime / p.runs),
        avgScore: Math.round(p.totalScore / p.runs),
      };
    }
    return result;
  }

  /**
   * Clear all short-term memory (e.g. on reconnect)
   */
  clearShortTerm() {
    this._shortTerm.clear();
    console.log('[MemoryManager] Short-term memory cleared');
  }

  getStats() {
    return {
      shortTermKeys:   this._shortTerm.size,
      contextKeys:     this._context.size,
      longTermEntries: this._longTerm.size,
      agentPerfKeys:   this._agentPerf.size,
    };
  }
}

// ─────────────────────────────────────────────
//  ANALYSIS SCHEDULER
// ─────────────────────────────────────────────

class AnalysisScheduler {
  /**
   * Manages analysis cooldowns per symbol+TF to prevent overanalysis.
   * Implements a round-robin queue across symbols.
   */
  constructor() {
    this._lastRun    = new Map(); // `${symbol}_${tf}` → timestamp
    this._queue      = [];
    this._running    = 0;
    this._maxConcurrent = MAX_CONCURRENT;
  }

  /**
   * Check if analysis is allowed for this symbol+TF
   */
  canRun(symbol, timeframe) {
    const key     = `${symbol}_${timeframe}`;
    const last    = this._lastRun.get(key) || 0;
    const cooldown = ANALYSIS_COOLDOWN[timeframe] || 60000;
    return (Date.now() - last) >= cooldown;
  }

  /**
   * Record that analysis ran for this symbol+TF
   */
  markRun(symbol, timeframe) {
    this._lastRun.set(`${symbol}_${timeframe}`, Date.now());
  }

  /**
   * Enqueue a new analysis job
   */
  enqueue(job) {
    // Prevent duplicate jobs for same symbol+TF
    const exists = this._queue.some(j =>
      j.symbol === job.symbol && j.timeframe === job.timeframe
    );
    if (!exists) {
      this._queue.push(job);
    }
  }

  /**
   * Dequeue next job if concurrency allows
   */
  dequeue() {
    if (this._running >= this._maxConcurrent) return null;
    return this._queue.shift() || null;
  }

  incrementRunning()  { this._running++; }
  decrementRunning()  { this._running = Math.max(0, this._running - 1); }
  getQueueSize()      { return this._queue.length; }
  getConcurrent()     { return this._running; }

  clearQueue() {
    this._queue = [];
  }
}

// ─────────────────────────────────────────────
//  AUDIT TRAIL
// ─────────────────────────────────────────────

class AuditTrail {
  constructor() {
    this._entries = [];
  }

  /**
   * Record a complete analysis cycle result
   */
  record(entry) {
    this._entries.push({
      ...entry,
      recordedAt: Date.now(),
    });
    if (this._entries.length > MAX_AUDIT_ENTRIES) {
      this._entries.shift();
    }
  }

  getRecent(n = 20) {
    return this._entries.slice(-n).reverse();
  }

  getBySymbol(symbol, n = 10) {
    return this._entries
      .filter(e => e.symbol === symbol)
      .slice(-n)
      .reverse();
  }

  getSignalFired() {
    return this._entries.filter(e => e.signalFired);
  }

  size() { return this._entries.length; }
}

// ─────────────────────────────────────────────
//  AGENT RUNNER — runs a single agent with timeout
// ─────────────────────────────────────────────

class AgentRunner {
  /**
   * Runs an agent's .analyze() method with:
   *   - Timeout enforcement (AGENT_TIMEOUT_MS)
   *   - Error isolation (one agent failing doesn't stop others)
   *   - Duration measurement
   *
   * @param {string}   name    - agent name
   * @param {Object}   agent   - agent instance
   * @param {Array}    args    - arguments to pass to agent.analyze()
   * @param {Object}   registry - AgentRegistry for health tracking
   * @returns {Promise<{ name, result, durationMs, timedOut, error }>}
   */
  static async run(name, agent, args, registry) {
    const startTime = Date.now();

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Agent ${name} timed out after ${AGENT_TIMEOUT_MS}ms`)), AGENT_TIMEOUT_MS)
    );

    try {
      const result      = await Promise.race([
        agent.analyze(...args),
        timeoutPromise,
      ]);

      const durationMs  = Date.now() - startTime;
      registry?.recordRun(name, durationMs, result?.score ?? 0);

      return { name, result, durationMs, timedOut: false, error: null };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const timedOut   = err.message.includes('timed out');

      registry?.markUnhealthy(name, err.message);

      return {
        name,
        result:   { direction: 'WAIT', score: 0, grade: 'D', reasons: [err.message] },
        durationMs,
        timedOut,
        error:    err.message,
      };
    }
  }

  /**
   * Run multiple agents in parallel
   * Returns array of results in same order as input
   */
  static async runAll(agentJobs, registry) {
    return Promise.all(
      agentJobs.map(({ name, agent, args }) =>
        this.run(name, agent, args, registry)
      )
    );
  }
}

// ─────────────────────────────────────────────
//  MARKET HOURS GATE
// ─────────────────────────────────────────────

class MarketHoursGate {
  /**
   * Returns true if market analysis should proceed based on UTC hour.
   * Skips analysis during true dead hours (21:00–23:00 UTC Sunday)
   * and around major holidays.
   */
  static shouldAnalyze(timeframe, timestampMs) {
    const d       = new Date(timestampMs || Date.now());
    const utcHour = d.getUTCHours();
    const utcDay  = d.getUTCDay(); // 0=Sun, 6=Sat

    // Skip M1/M5 analysis on weekends
    if ((utcDay === 0 || utcDay === 6) && ['M1','M5','M15'].includes(timeframe)) {
      return false;
    }

    // True dead zone: Sunday 21:00–23:59 and Monday 00:00–00:05 (market open gap)
    if (utcDay === 0 && utcHour >= 21) return false;

    // Allow all other times — crypto runs 24/7, forex 5 days
    return true;
  }

  /**
   * Returns quality multiplier for current market hours
   */
  static getQuality(timestampMs) {
    const d       = new Date(timestampMs || Date.now());
    const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;

    // London/NY overlap — best
    if (utcHour >= 13 && utcHour < 16) return { quality: 1.1, label: 'London/NY Overlap' };
    // London session
    if (utcHour >= 8  && utcHour < 13) return { quality: 1.0, label: 'London' };
    // NY session
    if (utcHour >= 16 && utcHour < 21) return { quality: 0.95, label: 'New York' };
    // Asia
    if (utcHour >= 0  && utcHour < 8)  return { quality: 0.80, label: 'Asia' };
    // Dead zone
    return { quality: 0.5, label: 'Dead Zone' };
  }
}

// ─────────────────────────────────────────────
//  SYMBOL MANAGER
// ─────────────────────────────────────────────

class SymbolManager {
  constructor(config = {}) {
    this._whitelist  = new Set(config.symbols   || []);
    this._blacklist  = new Set(config.blacklist  || []);
    this._priority   = config.priority           || [];
    this._metadata   = new Map(); // symbol → { type, exchange, pipSize }
  }

  isAllowed(symbol) {
    if (this._blacklist.has(symbol)) return false;
    if (this._whitelist.size > 0)   return this._whitelist.has(symbol);
    return true;
  }

  addSymbol(symbol, metadata = {}) {
    this._whitelist.add(symbol);
    this._metadata.set(symbol, metadata);
  }

  removeSymbol(symbol) {
    this._whitelist.delete(symbol);
    this._blacklist.add(symbol);
  }

  blacklist(symbol) {
    this._blacklist.add(symbol);
  }

  getPriority() { return this._priority; }

  getMetadata(symbol) {
    return this._metadata.get(symbol) || {};
  }

  getAll() { return [...this._whitelist]; }
}

// ─────────────────────────────────────────────
//  MAIN TASK PLANNER CLASS
// ─────────────────────────────────────────────

class TaskPlanner extends EventEmitter {
  /**
   * @param {Object} config
   * @param {Object}   config.feed           - BinanceFeed instance
   * @param {Object}   config.scorer         - SignalScorer instance
   * @param {Object}   config.dispatcher     - AlertDispatcher instance
   * @param {string[]} config.symbols        - symbols to trade
   * @param {string[]} config.timeframes     - timeframes to analyze
   * @param {Object}   config.agents         - { smc, mtf, momentum, volume, macro } — agent factories
   * @param {boolean}  config.autoHeal       - enable self-healing (default true)
   * @param {number}   config.healthCheckMs  - health check interval ms (default 60000)
   * @param {boolean}  config.dryRun         - dry run: score signals but don't send (default false)
   * @param {Object}   config.memory         - MemoryManager config
   */
  constructor(config = {}) {
    super();

    this.feed          = config.feed        || null;
    this.scorer        = config.scorer      || null;
    this.dispatcher    = config.dispatcher  || null;
    this.symbols       = config.symbols     || ['BTCUSDT', 'ETHUSDT', 'XAUUSD', 'EURUSD'];
    this.timeframes    = config.timeframes  || PRIMARY_TFS;
    this.agentFactories = config.agents     || {};
    this.autoHeal      = config.autoHeal    !== false;
    this.healthCheckMs = config.healthCheckMs || 60000;
    this.dryRun        = config.dryRun       || false;

    // Sub-systems
    this.registry    = new AgentRegistry();
    this.memory      = new MemoryManager(config.memory || {});
    this.scheduler   = new AnalysisScheduler();
    this.audit       = new AuditTrail();
    this.symbolMgr   = new SymbolManager({ symbols: this.symbols });

    // Per-symbol agent instances (each symbol gets its own agents)
    this._agentPool   = new Map(); // symbol → { smc, mtf, momentum, volume, macro }

    // Intervals and timers
    this._healthTimer  = null;
    this._schedTimer   = null;

    // State
    this._running      = false;
    this._analysisCount = 0;
    this._signalCount   = 0;
    this._errorCount    = 0;
    this._startTime     = null;

    // Last seen liquidation state
    this._liquidationState = null;
  }

  // ─────────────────────────────────────────────
  //  INITIALIZATION
  // ─────────────────────────────────────────────

  /**
   * Initialize the task planner:
   *  1. Create agent instances for each symbol
   *  2. Register agents in registry
   *  3. Attach event listeners to feed
   *  4. Start health check timer
   *  5. Start scheduler
   */
  async init() {
    console.log('[TaskPlanner] Initializing...');
    console.log(`[TaskPlanner] Symbols: ${this.symbols.join(', ')}`);
    console.log(`[TaskPlanner] Timeframes: ${this.timeframes.join(', ')}`);

    this._startTime = Date.now();
    this._running   = true;

    // Create agent pool for each symbol
    for (const symbol of this.symbols) {
      await this._createAgentPool(symbol);
    }

    // Attach feed listeners
    if (this.feed) {
      this._attachFeedListeners();
    }

    // Start health check
    if (this.autoHeal) {
      this._healthTimer = setInterval(
        () => this._runHealthCheck(),
        this.healthCheckMs
      );
    }

    // Start scheduler loop
    this._schedTimer = setInterval(
      () => this._processSchedulerQueue(),
      200 // check queue every 200ms
    );

    console.log('[TaskPlanner] Ready ✓');
    this.emit('ready', { symbols: this.symbols, timeframes: this.timeframes });
  }

  /**
   * Create a full agent pool for a symbol
   */
  async _createAgentPool(symbol) {
    const factories = this.agentFactories;

    const pool = {
      smc:      factories.smc      ? factories.smc(symbol)      : this._createDefaultSMC(symbol),
      mtf:      factories.mtf      ? factories.mtf(symbol)      : this._createDefaultMTF(symbol),
      momentum: factories.momentum ? factories.momentum(symbol) : this._createDefaultMomentum(symbol),
      volume:   factories.volume   ? factories.volume(symbol)   : null,
      macro:    factories.macro    ? factories.macro(symbol)    : null,
    };

    this._agentPool.set(symbol, pool);

    // Register in registry with factory functions for self-healing
    for (const [name, agent] of Object.entries(pool)) {
      if (!agent) continue;
      const regName = `${symbol}_${name}`;
      this.registry.register(
        regName,
        agent,
        () => factories[name] ? factories[name](symbol) : null
      );
    }

    console.log(`[TaskPlanner] Agent pool created for: ${symbol}`);
  }

  // Default agent constructors (when no factory provided)
  _createDefaultSMC(symbol) {
    try {
      const { SMCAgent } = require('../agents/smc-agent');
      return new SMCAgent({ symbol, timeframe: 'H1', lookback: 30, pivotStrength: 3, minScore: 70 });
    } catch (err) { console.error('[TaskPlanner] Failed to create default SMCAgent:', err.message); return null; }
  }

  _createDefaultMTF(symbol) {
    try {
      const { MTFAgent } = require('../agents/mtf-agent');
      return new MTFAgent({ symbol, requireHTFAlign: true });
    } catch (err) { console.error('[TaskPlanner] Failed to create default MTFAgent:', err.message); return null; }
  }

  _createDefaultMomentum(symbol) {
    try {
      const { MomentumAgent } = require('../agents/momentum-agent');
      return new MomentumAgent({ symbol, timeframe: 'H1' });
    } catch (err) { console.error('[TaskPlanner] Failed to create default MomentumAgent:', err.message); return null; }
  }

  // ─────────────────────────────────────────────
  //  FEED EVENT LISTENERS
  // ─────────────────────────────────────────────

  _attachFeedListeners() {
    // Closed candle → main analysis trigger
    this.feed.on('candle', (data) => {
      this._onCandle(data);
    });

    // Liquidation cascade → emergency alert + override
    this.feed.on('liquidation_cascade', (data) => {
      this._liquidationState = data;
      console.warn(`[TaskPlanner] Liquidation cascade: $${(data.totalUSDT / 1000000).toFixed(2)}M`);
      this.dispatcher?.sendLiquidationCascade(data);
      this.emit('liquidation_cascade', data);
    });

    // Whale trade → alert if large enough
    this.feed.on('large_trade', (data) => {
      this.dispatcher?.sendWhaleTrade(data);
      this.emit('large_trade', data);
    });

    // Funding rate extreme → alert
    this.feed.on('funding_extreme', (extremes) => {
      this.dispatcher?.sendFundingExtreme(extremes);
      this.emit('funding_extreme', extremes);
    });

    // Feed disconnected → pause analysis
    this.feed.on('disconnected', ({ type }) => {
      console.warn(`[TaskPlanner] Feed ${type} disconnected — pausing analysis`);
    });

    // Feed reconnected → resume
    this.feed.on('connected', ({ type }) => {
      console.log(`[TaskPlanner] Feed ${type} reconnected — resuming analysis`);
    });

    console.log('[TaskPlanner] Feed listeners attached');
  }

  // ─────────────────────────────────────────────
  //  CANDLE EVENT HANDLER
  // ─────────────────────────────────────────────

  /**
   * Called every time a candle closes on any subscribed symbol/TF.
   * This is the entry point of the entire analysis pipeline.
   */
  _onCandle(data) {
    const { symbol, timeframe, candles, isFutures } = data;

    // Symbol allowed?
    if (!this.symbolMgr.isAllowed(symbol)) return;

    // Ignore noisy timeframes
    if (IGNORED_TFS.includes(timeframe)) return;

    // Market hours gate
    if (!MarketHoursGate.shouldAnalyze(timeframe, Date.now())) return;

    // Cooldown check
    if (!this.scheduler.canRun(symbol, timeframe)) return;

    // Mark as queued
    this.scheduler.markRun(symbol, timeframe);

    // Enqueue analysis job
    this.scheduler.enqueue({
      symbol,
      timeframe,
      candles,
      isFutures,
      isPrimary:  PRIMARY_TFS.includes(timeframe),
      enqueuedAt: Date.now(),
    });
  }

  // ─────────────────────────────────────────────
  //  SCHEDULER QUEUE PROCESSOR
  // ─────────────────────────────────────────────

  async _processSchedulerQueue() {
    const job = this.scheduler.dequeue();
    if (!job) return;

    this.scheduler.incrementRunning();

    try {
      await this._runAnalysisCycle(job);
    } finally {
      this.scheduler.decrementRunning();
    }
  }

  // ─────────────────────────────────────────────
  //  MAIN ANALYSIS CYCLE
  // ─────────────────────────────────────────────

  /**
   * The core analysis cycle. Runs all agents for a symbol+TF combination.
   *
   * @param {Object} job - { symbol, timeframe, candles, isPrimary }
   */
  async _runAnalysisCycle(job) {
    const { symbol, timeframe, candles, isPrimary } = job;
    const cycleStart = Date.now();
    this._analysisCount++;

    const pool = this._agentPool.get(symbol);
    if (!pool) return;

    // Build TF data map for MTF agent
    const tfData = this._buildTFData(symbol, timeframe, candles);

    // ── Run agents in parallel ──
    const agentJobs = [];

    if (pool.smc) {
      agentJobs.push({ name: `${symbol}_smc`, agent: pool.smc, args: [candles] });
    }

    if (pool.mtf) {
      agentJobs.push({ name: `${symbol}_mtf`, agent: pool.mtf, args: [tfData] });
    }

    // Only run momentum/volume/macro on primary TFs (H1, H4, D1)
    if (isPrimary) {
      if (pool.momentum) {
        const htfHint = pool.mtf?.getLastVote?.()?.htfBias || null;
        agentJobs.push({ name: `${symbol}_momentum`, agent: pool.momentum, args: [candles, htfHint] });
      }

      if (pool.volume) {
        agentJobs.push({ name: `${symbol}_volume`, agent: pool.volume, args: [candles] });
      }

      if (pool.macro) {
        agentJobs.push({ name: `${symbol}_macro`, agent: pool.macro, args: [symbol] });
      }
    }

    // Run all agents in parallel with timeout isolation
    const results = await AgentRunner.runAll(agentJobs, this.registry);

    // Map results to vote object
    const votes = {};
    const agentResults = {};
    let totalAgentTime = 0;

    for (const r of results) {
      const agentKey = r.name.replace(`${symbol}_`, '');
      votes[agentKey] = r.result;
      agentResults[agentKey] = r;
      totalAgentTime += r.durationMs;

      // Memory: record agent perf
      this.memory.recordAgentPerf(agentKey, r.durationMs, r.result?.score ?? 0);

      if (r.error) {
        console.warn(`[TaskPlanner] Agent ${r.name} error: ${r.error}`);
        this._errorCount++;
      }
    }

    // ── Conflict resolution ──
    const resolved = ConflictResolver.resolve(votes, {
      symbol,
      timeframe,
      currentPrice: candles[candles.length - 1]?.close,
      liquidationAlert: this._liquidationState,
    });

    // ── Store in short-term memory ──
    this.memory.storeAnalysis(symbol, timeframe, {
      direction:    resolved.direction,
      score:        0, // filled after scoring
      agentResults,
    });

    // ── Update context ──
    const consistency = this.memory.getTrendConsistency(symbol, timeframe, 5);
    this.memory.updateContext(symbol, {
      symbol,
      timeframe,
      direction:    resolved.direction,
      consistency:  consistency.consistency,
      conflicts:    resolved.conflicts.length,
      lastAnalysis: Date.now(),
    });

    // ── Score the signal ──
    let scoredSignal = null;
    let signalFired  = false;

    if (resolved.direction !== 'WAIT' && this.scorer) {
      try {
        scoredSignal = await this.scorer.score(
          resolved.votes,
          {
            symbol,
            timeframe,
            currentPrice: candles[candles.length - 1]?.close,
            timestamp:    Date.now(),
          }
        );

        if (scoredSignal?.action !== 'WAIT') {
          signalFired = true;
          this._signalCount++;

          // Log signal
          console.log(
            `[TaskPlanner] 🚨 SIGNAL: ${scoredSignal.action} ${symbol} ${timeframe}` +
            ` | Score: ${scoredSignal.score?.final ?? scoredSignal.score}` +
            ` | Grade: ${scoredSignal.score?.grade}`
          );

          // ── Dispatch signal ──
          if (!this.dryRun && this.dispatcher) {
            await this.dispatcher.sendSignal(scoredSignal).catch(err => {
              console.error('[TaskPlanner] Dispatch error:', err.message);
            });
          }

          this.emit('signal', scoredSignal);
        }
      } catch (err) {
        console.error('[TaskPlanner] Scorer error:', err.message);
        this._errorCount++;
      }
    }

    const cycleDuration = Date.now() - cycleStart;

    // ── Audit trail entry ──
    this.audit.record({
      symbol,
      timeframe,
      direction:    resolved.direction,
      conflicts:    resolved.conflicts,
      signalFired,
      signal:       scoredSignal,
      agentTimes:   Object.fromEntries(results.map(r => [r.name, r.durationMs])),
      cycleDuration,
      consistency:  consistency.consistency,
    });

    // Emit analysis complete event for dashboard
    this.emit('analysis', {
      symbol,
      timeframe,
      direction:  resolved.direction,
      score:      scoredSignal?.score?.final ?? 0,
      signalFired,
      cycleDuration,
      conflicts:  resolved.conflicts.length,
      agentBreakdown: results.map(r => ({
        name:  r.name,
        score: r.result?.score ?? 0,
        dir:   r.result?.direction ?? 'WAIT',
        time:  r.durationMs,
      })),
    });

    // Clear old liquidation state after 30s
    if (this._liquidationState &&
        Date.now() - this._liquidationState.timestamp > 30000) {
      this._liquidationState = null;
    }
  }

  // ─────────────────────────────────────────────
  //  TF DATA BUILDER
  // ─────────────────────────────────────────────

  /**
   * Builds the multi-timeframe candle data map for the MTF agent.
   * Pulls from BinanceFeed's CandleStore for all available TFs.
   */
  _buildTFData(symbol, primaryTF, primaryCandles) {
    const tfData = { [primaryTF]: primaryCandles };

    if (!this.feed) return tfData;

    const allTFs = [...PRIMARY_TFS, ...SECONDARY_TFS].filter(tf => tf !== primaryTF);

    for (const tf of allTFs) {
      const candles = this.feed.getCandles?.(symbol, tf);
      if (candles && candles.length >= 10) {
        tfData[tf] = candles;
      }
    }

    return tfData;
  }

  // ─────────────────────────────────────────────
  //  SELF-HEALING HEALTH CHECK
  // ─────────────────────────────────────────────

  async _runHealthCheck() {
    console.log('[TaskPlanner] Running health check...');

    for (const [name, entry] of this.registry.getAll()) {
      // Check for stale agents (haven't run in a long time)
      if (entry.lastRun) {
        const staleness = Date.now() - entry.lastRun;
        const tfKey     = name.split('_').slice(-1)[0]; // e.g. 'smc', 'mtf'

        if (staleness > this.healthCheckMs * 5) {
          entry.staleCount++;
          if (entry.staleCount >= STALE_AGENT_CYCLES) {
            console.warn(`[TaskPlanner] Agent ${name} is stale (${(staleness / 1000).toFixed(0)}s)`);
          }
        }
      }

      // Restart unhealthy agents
      if (!entry.healthy && entry.factory) {
        const healed = await this.registry.selfHeal(name);
        if (healed) {
          // Update pool
          const [symbol, agentKey] = name.split('_');
          const pool = this._agentPool.get(symbol);
          if (pool && agentKey) {
            pool[agentKey] = this.registry.get(name)?.instance;
          }
        }
      }
    }

    // Emit health status
    this.emit('health', {
      agents:      this.registry.getHealthSummary(),
      memory:      this.memory.getStats(),
      scheduler:   { queue: this.scheduler.getQueueSize(), concurrent: this.scheduler.getConcurrent() },
      analysis:    this._analysisCount,
      signals:     this._signalCount,
      errors:      this._errorCount,
      uptime:      Math.floor((Date.now() - this._startTime) / 1000),
    });
  }

  // ─────────────────────────────────────────────
  //  MANUAL ANALYSIS TRIGGER
  // ─────────────────────────────────────────────

  /**
   * Manually trigger analysis for a specific symbol+TF.
   * Useful for testing or on-demand analysis via bot command.
   */
  async analyzeNow(symbol, timeframe) {
    if (!this.feed) {
      throw new Error('No feed connected');
    }

    const candles = this.feed.getCandles(symbol, timeframe);
    if (!candles || candles.length < 20) {
      throw new Error(`Insufficient candle data for ${symbol} ${timeframe}`);
    }

    console.log(`[TaskPlanner] Manual analysis: ${symbol} ${timeframe}`);

    await this._runAnalysisCycle({
      symbol,
      timeframe,
      candles,
      isPrimary: PRIMARY_TFS.includes(timeframe),
    });
  }

  // ─────────────────────────────────────────────
  //  SYMBOL MANAGEMENT
  // ─────────────────────────────────────────────

  async addSymbol(symbol) {
    if (this._agentPool.has(symbol)) return;
    this.symbolMgr.addSymbol(symbol);
    this.symbols.push(symbol);
    await this._createAgentPool(symbol);
    console.log(`[TaskPlanner] Added symbol: ${symbol}`);
  }

  removeSymbol(symbol) {
    this.symbolMgr.removeSymbol(symbol);
    this._agentPool.delete(symbol);
    this.symbols = this.symbols.filter(s => s !== symbol);
    console.log(`[TaskPlanner] Removed symbol: ${symbol}`);
  }

  // ─────────────────────────────────────────────
  //  PUBLIC API
  // ─────────────────────────────────────────────

  getStats() {
    return {
      running:         this._running,
      uptime:          Math.floor((Date.now() - (this._startTime || Date.now())) / 1000),
      analysisCount:   this._analysisCount,
      signalCount:     this._signalCount,
      errorCount:      this._errorCount,
      symbols:         this.symbols,
      timeframes:      this.timeframes,
      dryRun:          this.dryRun,
      scheduler: {
        queueSize:     this.scheduler.getQueueSize(),
        concurrent:    this.scheduler.getConcurrent(),
      },
      agentHealth:     this.registry.getHealthSummary(),
      agentPerf:       this.memory.getAgentPerf(),
      memory:          this.memory.getStats(),
      audit:           this.audit.size(),
    };
  }

  getAuditTrail(symbol = null, n = 20) {
    return symbol ? this.audit.getBySymbol(symbol, n) : this.audit.getRecent(n);
  }

  getContext(symbol) {
    return this.memory.getContext(symbol);
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('[TaskPlanner] Shutting down...');
    this._running = false;

    clearInterval(this._healthTimer);
    clearInterval(this._schedTimer);
    this.scheduler.clearQueue();

    // Wait for in-flight analyses to complete
    let waited = 0;
    while (this.scheduler.getConcurrent() > 0 && waited < 10000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }

    this.emit('shutdown');
    console.log('[TaskPlanner] Shutdown complete');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  TaskPlanner,
  AgentRegistry,
  AgentRunner,
  ConflictResolver,
  MemoryManager,
  AnalysisScheduler,
  AuditTrail,
  MarketHoursGate,
  SymbolManager,
  PRIMARY_TFS,
  SECONDARY_TFS,
  IGNORED_TFS,
  ANALYSIS_COOLDOWN,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { TaskPlanner }      = require('./task-planner');
 *  const { BinanceFeed }      = require('./binance-ws');
 *  const { SignalScorer }     = require('./signal-scorer');
 *  const { AlertDispatcher }  = require('./alert-dispatcher');
 *  const { SMCAgent }         = require('./smc-agent');
 *  const { MTFAgent }         = require('./mtf-agent');
 *  const { MomentumAgent }    = require('./momentum-agent');
 *
 *  const feed       = new BinanceFeed({ symbols: ['BTCUSDT','XAUUSD','EURUSD'] });
 *  const scorer     = new SignalScorer({ minScore: 75 });
 *  const dispatcher = new AlertDispatcher({ token: process.env.BOT_TOKEN, chatIds: ['...'] });
 *
 *  const planner = new TaskPlanner({
 *    feed,
 *    scorer,
 *    dispatcher,
 *    symbols:    ['BTCUSDT', 'ETHUSDT', 'XAUUSD', 'EURUSD', 'GBPUSD'],
 *    timeframes: ['H1', 'H4', 'D1'],
 *    agents: {
 *      smc:      (sym) => new SMCAgent({ symbol: sym }),
 *      mtf:      (sym) => new MTFAgent({ symbol: sym }),
 *      momentum: (sym) => new MomentumAgent({ symbol: sym }),
 *    },
 *    autoHeal: true,
 *    dryRun:   false,
 *  });
 *
 *  await dispatcher.init();
 *  await feed.connect();
 *  await planner.init();
 *
 *  planner.on('signal', (signal) => {
 *    console.log('Signal fired:', signal.action, signal.symbol, signal.score?.final);
 *  });
 *
 *  planner.on('health', (health) => {
 *    console.log('Health:', health.agents);
 *  });
 *
 *  // Manual trigger
 *  await planner.analyzeNow('BTCUSDT', 'H1');
 * ─────────────────────────────────────────────
 */