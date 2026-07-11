'use strict';
/**
 * backtest/engine.js
 *
 * Replays historical candles through the REAL production decision pipeline
 * — the same agent classes, the same SignalScorer, the same RiskEngine,
 * DrawdownGuard, InstitutionalGates, EnsembleEngine, and PositionLifecycle
 * that index.js runs live — just driven by a chronological history loop
 * instead of live WebSocket ticks.
 *
 * This deliberately does NOT modify or import index.js itself (the live
 * trading entry point). It mirrors index.js's runAnalysisCycle() sequence
 * exactly, construction-for-construction, so backtest results reflect the
 * actual shipped decision logic rather than a re-implementation of it.
 * If you change the live pipeline's decision sequence in index.js, mirror
 * the change here too — see the "MIRRORS index.js" comments below.
 */

const SMCAgent = require('../agents/smc-agent').SMCAgent;
const MTFAgent = require('../agents/mtf-agent').MTFAgent;
const MomentumAgent = require('../agents/momentum-agent').MomentumAgent;
const VolumeOIAgent = require('../agents/volume-oi-agent').VolumeOIAgent;
const MicrostructureAgent = require('../agents/microstructure-agent').MicrostructureAgent;
const FractalAgent = require('../agents/fractal-agent').FractalAgent;

const { ConflictResolver } = require('../orchestrator/conflict-resolver');
const { SignalScorer } = require('../signal-pipeline/signal-scorer');
const { SLTPEngine, PositionLifecycle } = require('../signal-pipeline/sl-tp-engine');
const { EntryOptimizer } = require('../signal-pipeline/entry-optimizer');
const { RegimeEngine } = require('../signal-pipeline/regime-engine');
const { InstitutionalGates } = require('../signal-pipeline/institutional-gates');
const { MonteCarloEngine } = require('../signal-pipeline/monte-carlo-engine');
const { BayesianEngine } = require('../signal-pipeline/bayesian-engine');
const { StatisticalValidator } = require('../signal-pipeline/statistical-validator');
const { EnsembleEngine } = require('../signal-pipeline/ensemble-engine');
const { RiskEngine } = require('../risk-engine/position-sizer');
const { DrawdownGuard } = require('../risk-engine/drawdown-guard');
const { CorrelationFilter } = require('../risk-engine/correlation');
const { SessionFilter } = require('../risk-engine/session-filter');

const MIN_LOOKBACK = 50;          // MIRRORS index.js: candles.length < 50 guard
const MAX_PENDING_CANDLES = 40;   // backtest-only safeguard: expire a signal
                                   // that never got filled after this many bars,
                                   // so stale PENDING positions don't pile up
                                   // forever (no equivalent exists live because
                                   // live never "runs out" of future candles).

class BacktestEngine {
  /**
   * @param {Object} cfg
   * @param {string[]} cfg.symbols
   * @param {string} cfg.timeframe - primary MT-style timeframe to trade (e.g. 'H1')
   * @param {string[]} [cfg.htfTimeframes] - extra timeframes to also feed the
   *   MTF agent for HTF alignment context, if you have that data loaded too
   * @param {number} [cfg.accountBalance=10000]
   * @param {number} [cfg.riskPct=1.0]
   * @param {number} [cfg.maxDailyLossPct=3.0]
   * @param {number} [cfg.maxDrawdownPct=10.0]
   * @param {number} [cfg.minScore=75]
   */
  constructor(cfg) {
    this.symbols = cfg.symbols;
    this.timeframe = cfg.timeframe;
    this.htfTimeframes = cfg.htfTimeframes || [];
    this.accountBalance = cfg.accountBalance ?? 10000;
    this.riskPct = cfg.riskPct ?? 1.0;
    this.minScore = cfg.minScore ?? 75;

    // ── Build the exact same singleton pipeline as index.js's buildSingletons() ──
    this.drawdownGuard = new DrawdownGuard({
      maxDailyLossPct: cfg.maxDailyLossPct ?? 3.0,
      maxDrawdownPct: cfg.maxDrawdownPct ?? 10.0,
      accountBalance: this.accountBalance,
    });
    this.scorer = new SignalScorer({
      minScore: this.minScore,
      sessionFilter: true,
      newsBlackout: true,
      requireKillzone: false,
      circuitBreaker: { maxDailyLoss: cfg.maxDailyLossPct ?? 3.0, maxDrawdown: cfg.maxDrawdownPct ?? 10.0 },
    });
    this.sltp = new SLTPEngine();
    this.entryOptimizer = new EntryOptimizer();
    this.regimeEngine = new RegimeEngine({ lookback: 120 });
    this.institutionalGates = new InstitutionalGates({
      minScore: this.minScore, minRR: 1.5, maxRiskPct: Math.min(this.riskPct, 2.0), minRegimeTradeability: 50,
    });
    this.monteCarlo = new MonteCarloEngine({ simulations: cfg.mcSimulations ?? 2000, minWinProb: 0.55, minExpectedR: 0.3 });
    this.bayesianEng = new BayesianEngine({ basePrior: 0.50, minPosterior: 0.52 });
    this.statValidator = new StatisticalValidator({ minTestsPassed: 5, significanceLevel: 0.05 });
    this.ensembleEng = new EnsembleEngine({ minConfidence: 60 });
    this.riskEngine = new RiskEngine({
      accountBalance: this.accountBalance, riskPct: this.riskPct, sizingMethod: 'ATR', drawdownGuard: this.drawdownGuard,
    });
    this.sessionFilter = new SessionFilter();
    this.correlationFilter = new CorrelationFilter({ maxOpenPositions: 5 });
    this.conflictResolver = new ConflictResolver();

    // Per-symbol agent pool — MIRRORS index.js's agentPool[symbol] construction.
    this.agentPool = {};
    for (const symbol of this.symbols) {
      this.agentPool[symbol] = {
        smc: new SMCAgent({ symbol, timeframe: this.timeframe, lookback: 30, pivotStrength: 3, minScore: 60 }),
        mtf: new MTFAgent({ symbol, requireHTFAlign: true }),
        momentum: new MomentumAgent({ symbol, timeframe: this.timeframe }),
        volumeOI: new VolumeOIAgent({ symbol, timeframe: this.timeframe }),
        microstructure: new MicrostructureAgent({ symbol, timeframe: this.timeframe }),
        fractal: new FractalAgent({ symbol, timeframe: this.timeframe }),
      };
    }

    this.candleStores = {};   // symbol -> timeframe -> candle[]
    this.htfStores = {};      // symbol -> timeframe -> candle[] (for MTF context)
    this.openPositions = {};  // symbol -> { position: PositionLifecycle, signal, pendingBars, openedAt }
    this.closedTrades = [];
    this.equityCurve = [];    // [{ timestamp, balance }]
    this.rejections = { gate: 0, correlation: 0, session: 0, drawdown: 0, entryFailed: 0, noSignal: 0 };
    this.balance = this.accountBalance;
  }

  /** Load full historical candle history for a symbol/timeframe before running. */
  loadCandles(symbol, timeframe, candles) {
    if (timeframe === this.timeframe) {
      this.candleStores[symbol] = this.candleStores[symbol] || {};
      this.candleStores[symbol][timeframe] = candles.slice().sort((a, b) => a.timestamp - b.timestamp);
    } else {
      this.htfStores[symbol] = this.htfStores[symbol] || {};
      this.htfStores[symbol][timeframe] = candles.slice().sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  _buildMTFData(symbol, idx) {
    const data = {};
    const main = this.candleStores[symbol]?.[this.timeframe];
    if (main) data[this.timeframe] = main.slice(0, idx + 1);
    const htf = this.htfStores[symbol];
    if (htf) {
      for (const tf of Object.keys(htf)) {
        // Only include HTF candles that closed at or before this point in
        // time — using future HTF candles here would be look-ahead bias.
        const cutoffTs = main[idx].timestamp;
        data[tf] = htf[tf].filter(c => c.timestamp <= cutoffTs);
      }
    }
    return data;
  }

  /** Run the full backtest across all loaded symbols. Chronologically merges
   *  each symbol's candle stream so multi-symbol correlation/session/
   *  drawdown state evolves in true time order across symbols. */
  async run() {
    const steps = [];
    for (const symbol of this.symbols) {
      const candles = this.candleStores[symbol]?.[this.timeframe];
      if (!candles || candles.length < MIN_LOOKBACK) continue;
      for (let i = 0; i < candles.length; i++) steps.push({ symbol, i, ts: candles[i].timestamp });
    }
    steps.sort((a, b) => a.ts - b.ts);

    for (const step of steps) {
      await this._processStep(step.symbol, step.i);
    }

    for (const symbol of Object.keys(this.openPositions)) {
      const candles = this.candleStores[symbol][this.timeframe];
      this._forceClose(symbol, candles[candles.length - 1]);
    }

    return {
      trades: this.closedTrades,
      equityCurve: this.equityCurve,
      finalBalance: this.balance,
      rejections: this.rejections,
    };
  }

  async _processStep(symbol, idx) {
    const candles = this.candleStores[symbol][this.timeframe];
    const candle = candles[idx];
    const historySoFar = candles.slice(0, idx + 1);

    this._updateOpenPosition(symbol, candle);

    if (historySoFar.length < MIN_LOOKBACK) return;
    if (this.openPositions[symbol]) return;

    const agents = this.agentPool[symbol];
    let smcResult, mtfResult, momResult, volumeResult, microResult, fractalResult;
    try {
      [smcResult, mtfResult, momResult, volumeResult, microResult, fractalResult] = await Promise.all([
        agents.smc?.analyze(historySoFar).catch(() => null),
        agents.mtf?.analyze(this._buildMTFData(symbol, idx)).catch(() => null),
        agents.momentum?.analyze(historySoFar).catch(() => null),
        agents.volumeOI?.analyze(historySoFar).catch(() => null),
        agents.microstructure?.analyze(historySoFar).catch(() => null),
        agents.fractal?.analyze(historySoFar).catch(() => null),
      ]);
    } catch (_) { return; }

    if (!smcResult || !mtfResult || !momResult) { this.rejections.noSignal++; return; }

    const agentVotes = {
      smc: smcResult, mtf: mtfResult, momentum: momResult,
      macroSent: null, volumeOI: volumeResult || null,
      microstructure: microResult || null, fractal: fractalResult || null,
    };

    const regime = this.regimeEngine?.classify ? this.regimeEngine.classify(historySoFar) : { regime: 'UNKNOWN', tradeability: 50, reasons: [] };
    const currentPrice = candle.close;
    let resolvedVotes = agentVotes;
    if (this.conflictResolver?.resolve) {
      const resolved = this.conflictResolver.resolve(agentVotes, { symbol, timeframe: this.timeframe, currentPrice });
      if (!resolved.resolved) { this.rejections.noSignal++; return; }
      resolvedVotes = resolved.votes;
    }

    let sessionQuality = null;
    if (this.sessionFilter?.check) {
      sessionQuality = this.sessionFilter.check(symbol, candle.timestamp);
      if (!sessionQuality.allowed) { this.rejections.session++; return; }
    }

    let drawdownEval = null;
    if (this.drawdownGuard?.evaluate) {
      drawdownEval = this.drawdownGuard.evaluate({ price: currentPrice });
      if (!drawdownEval.allowed) { this.rejections.drawdown++; return; }
    }

    if (!this.scorer) return;
    let signal = await this.scorer.score(resolvedVotes, { symbol, timeframe: this.timeframe, currentPrice, timestamp: candle.timestamp });
    if (!signal || signal.action === 'WAIT') { this.rejections.noSignal++; return; }

    if (this.correlationFilter?.check) {
      const corrCheck = this.correlationFilter.check(symbol, signal.action, this.riskPct);
      if (!corrCheck.allowed) { this.rejections.correlation++; return; }
    }

    let entryOptimization = null, tradePlan = null, riskEvaluation = null;
    if (this.entryOptimizer) {
      entryOptimization = this.entryOptimizer.optimize({ smcAnalysis: smcResult?.analysis, signal, candles: historySoFar });
      if (!entryOptimization?.rejected && entryOptimization?.entry) {
        const e = entryOptimization.entry;
        signal = { ...signal, entry: { zoneHigh: e.zoneHigh, zoneLow: e.zoneLow, midpoint: e.midPoint, type: e.type, note: e.note }, entryOptimization };
      }
    }

    if (this.sltp) {
      const sltpResult = this.sltp.calculate(signal, historySoFar, { accountBalance: this.balance, riskPct: this.riskPct });
      if (sltpResult?.error) { this.rejections.entryFailed++; return; }
      tradePlan = sltpResult.plan;
      riskEvaluation = this.riskEngine?.evaluate
        ? this.riskEngine.evaluate({ ...signal, entry: { midPoint: tradePlan.entry.midPoint }, stopLoss: tradePlan.stopLoss, atr: tradePlan.risk.atr, currentPrice })
        : { approved: true };

      if (riskEvaluation?.approved && riskEvaluation.positionSize > 0) {
        const combinedFactor = (sessionQuality?.multiplier ?? 1) * (drawdownEval?.sizingFactor ?? 1);
        if (combinedFactor < 1) riskEvaluation.positionSize *= combinedFactor;
      }
    }
    if (!riskEvaluation?.approved) { this.rejections.entryFailed++; return; }

    const [mcResult, bayesianResult, statResult] = await Promise.all([
      this.monteCarlo?.simulate ? this.monteCarlo.simulate({ candles: historySoFar, signal, tradePlan, regime }) : null,
      this.bayesianEng?.evaluate ? this.bayesianEng.evaluate({ signal, tradePlan, regime, entryOptimization, riskEvaluation, votes: resolvedVotes, session: signal.session }) : null,
      this.statValidator?.validate ? this.statValidator.validate({ candles: historySoFar, signal, tradePlan, regime }) : null,
    ]).catch(() => [null, null, null]);

    let ensembleResult = null;
    if (this.ensembleEng?.evaluate) {
      ensembleResult = this.ensembleEng.evaluate({
        monteCarlo: mcResult, bayesian: bayesianResult, statistical: statResult, walkForward: null,
        learning: { action: 'ALLOW', penalty: 0 }, agentVotes: resolvedVotes, regime,
        fractal: fractalResult || null, microstructure: microResult || null,
      }, signal);
      if (ensembleResult?.totalPenalty && signal.score?.final != null) {
        signal.score = { ...signal.score, final: Math.max(0, Math.round(signal.score.final - ensembleResult.totalPenalty)) };
      }
    }

    const gate = this.institutionalGates?.evaluate
      ? this.institutionalGates.evaluate({ signal, tradePlan, entryOptimization, riskEvaluation, regime, votes: resolvedVotes, ensemble: ensembleResult, learning: { action: 'ALLOW' } })
      : { approved: true };
    if (!gate.approved) { this.rejections.gate++; return; }

    if (tradePlan) {
      const position = new PositionLifecycle(tradePlan);
      this.openPositions[symbol] = { position, signal, openedAt: candle.timestamp, pendingBars: 0, riskPct: riskEvaluation.finalRiskPct ?? this.riskPct };
    }
  }

  _updateOpenPosition(symbol, candle) {
    const open = this.openPositions[symbol];
    if (!open) return;
    const { position } = open;
    const isLong = position.plan.direction === 'LONG';
    const atr = position.plan.risk?.atr || (candle.high - candle.low);

    if (position.state === 'PENDING') {
      open.pendingBars++;
      const touchedZone = isLong
        ? candle.low <= position.plan.entry.zoneHigh && candle.high >= position.plan.entry.zoneLow
        : candle.high >= position.plan.entry.zoneLow && candle.low <= position.plan.entry.zoneHigh;
      const fillPrice = touchedZone ? candle.open : candle.close;
      position.update(fillPrice, atr);
      if (position.state === 'PENDING' && open.pendingBars >= MAX_PENDING_CANDLES) {
        delete this.openPositions[symbol];
      }
      return;
    }

    const worstFirst = isLong ? candle.low : candle.high;
    const bestSecond = isLong ? candle.high : candle.low;
    position.update(worstFirst, atr);
    if (position.state !== 'CLOSED') position.update(bestSecond, atr);
    if (position.state !== 'CLOSED') position.update(candle.close, atr);

    if (position.state === 'CLOSED') {
      this._recordTrade(symbol, open, candle.timestamp);
    }
  }

  _forceClose(symbol, lastCandle) {
    const open = this.openPositions[symbol];
    if (!open) return;
    if (open.position.state === 'PENDING') { delete this.openPositions[symbol]; return; }
    const riskPts = open.position.initialRiskPts || 1;
    const isLong = open.position.plan.direction === 'LONG';
    const pnlR = isLong
      ? (lastCandle.close - open.position.entryPrice) / riskPts
      : (open.position.entryPrice - lastCandle.close) / riskPts;
    open.position.pnlR = pnlR;
    open.position.state = 'CLOSED';
    this._recordTrade(symbol, open, lastCandle.timestamp, true);
  }

  _recordTrade(symbol, open, closeTimestamp, forced = false) {
    const { position, signal, openedAt, riskPct } = open;
    const pnlR = position.pnlR || 0;
    const pnlPct = pnlR * riskPct;
    this.balance = this.balance * (1 + pnlPct / 100);

    const trade = {
      symbol, direction: position.plan.direction, grade: signal.score?.grade,
      score: signal.score?.final, openedAt, closedAt: closeTimestamp,
      entryPrice: position.entryPrice, pnlR, pnlPct, riskPct, forced,
      balanceAfter: Math.round(this.balance * 100) / 100,
    };
    this.closedTrades.push(trade);
    this.equityCurve.push({ timestamp: closeTimestamp, balance: this.balance });

    if (this.drawdownGuard?.record) {
      this.drawdownGuard.record({ pnlPct, won: pnlR > 0, symbol, signalId: signal.id || `${symbol}-${openedAt}`, grade: signal.score?.grade, pnlR });
    }
    delete this.openPositions[symbol];
  }
}

module.exports = { BacktestEngine };
