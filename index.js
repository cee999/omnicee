'use strict';

/**
 * ============================================================
 *  OMNICEE — Entry Point
 *  Boots the entire system in the correct order and wires
 *  all modules together.
 *
 *  Boot sequence:
 *    1. Load .env config
 *    2. Create AlertDispatcher (Telegram)
 *    3. Create data feeds (BinanceFeed + TwelveData)
 *    4. Create all 5 agents per symbol
 *    5. Create ConflictResolver + SignalScorer
 *    6. Create RiskEngine (DrawdownGuard + PositionSizer + SessionFilter)
 *    7. Create TaskPlanner (orchestrates agents → scorer → dispatcher)
 *    8. Wire event listeners
 *    9. Connect feeds, init dispatcher, start planner
 * ============================================================
 */

// ── 0. Config ──────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const log = {
  debug: (...a) => LOG_LEVEL === 'debug' && console.log('[DEBUG]', ...a),
  info:  (...a) => ['debug','info'].includes(LOG_LEVEL) && console.log('[INFO] ', ...a),
  warn:  (...a) => console.warn('[WARN] ', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

// ── 1. Validate critical env vars ─────────────────────────────────────────

function requireEnv(name, fallback) {
  const val = process.env[name] || fallback;
  if (!val) {
    log.warn(`${name} not set in .env — some features will be disabled`);
  }
  return val;
}

const BOT_TOKEN       = requireEnv('TELEGRAM_BOT_TOKEN', '');
const CHAT_IDS        = (requireEnv('TELEGRAM_CHAT_IDS', '') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const SYMBOLS         = (requireEnv('SYMBOLS', 'BTCUSDT,XAUUSD,EURUSD') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TIMEFRAMES_STR  = (requireEnv('TIMEFRAMES', 'H1,H4') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const MIN_SCORE       = parseFloat(requireEnv('MIN_SIGNAL_SCORE', '75'));
const RISK_PCT        = parseFloat(requireEnv('RISK_PCT_PER_TRADE', '1.0'));
const MAX_DAILY_LOSS  = parseFloat(requireEnv('MAX_DAILY_LOSS_PCT', '3.0'));
const MAX_DRAWDOWN    = parseFloat(requireEnv('MAX_DRAWDOWN_PCT', '10.0'));
const ACCOUNT_BALANCE = parseFloat(requireEnv('ACCOUNT_BALANCE', '10000'));
const REQUIRE_KZ      = requireEnv('REQUIRE_KILLZONE', 'false') === 'true';
const TWELVE_KEY      = requireEnv('TWELVE_DATA_API_KEY', '');

// ── 2. Load modules ────────────────────────────────────────────────────────

const path = require('path');
const mongoStore = loadModule('./db', 'MongoStore') || {};

function loadModule(relPath, label) {
  try {
    return require(path.join(__dirname, relPath));
  } catch (err) {
    log.error(`Failed to load ${label}: ${err.message}`);
    return null;
  }
}

// ── WebSocket bus (optional — only if ws-server.js is running) ─────────────
let wsBus = null;
try {
  wsBus = require('./webapp/ws-server').bus;
  log.info('WebSocket bus connected — signals will stream to Mini App');
} catch (_) {
  log.info('WebSocket bus not available — start webapp/ws-server.js to enable Mini App streaming');
}

const { AlertDispatcher }    = loadModule('./signal-pipeline/alert-dispatcher',  'AlertDispatcher')    || {};
const { BinanceFeed }        = loadModule('./feeds/binance-ws',                  'BinanceFeed')        || {};
const { TwelveDataFeed }     = loadModule('./feeds/twelve-data',                 'TwelveDataFeed')     || {};
const { SMCAgent }           = loadModule('./agents/smc-agent',                  'SMCAgent')           || {};
const { MTFAgent }           = loadModule('./agents/mtf-agent',                  'MTFAgent')           || {};
const { MomentumAgent }      = loadModule('./agents/momentum-agent',             'MomentumAgent')      || {};
const { SentimentAgent }     = loadModule('./agents/sentiment-agent',            'SentimentAgent')     || {};
const { PatternAgent }       = loadModule('./agents/pattern-agent',              'PatternAgent')       || {};
const { VolumeOIAgent }      = loadModule('./agents/volume-oi-agent',            'VolumeOIAgent')      || {};
const { SignalScorer }       = loadModule('./signal-pipeline/signal-scorer',     'SignalScorer')       || {};
const { SLTPEngine }         = loadModule('./signal-pipeline/sl-tp-engine',      'SLTPEngine')        || {};
const { EntryOptimizer }     = loadModule('./signal-pipeline/entry-optimizer',   'EntryOptimizer')    || {};
const { RegimeEngine }       = loadModule('./signal-pipeline/regime-engine',     'RegimeEngine')      || {};
const { InstitutionalGates } = loadModule('./signal-pipeline/institutional-gates','InstitutionalGates') || {};
const { AdaptiveLearningEngine } = loadModule('./signal-pipeline/adaptive-learning-engine','AdaptiveLearningEngine') || {};
const { MonteCarloEngine }   = loadModule('./signal-pipeline/monte-carlo-engine', 'MonteCarloEngine')  || {};
const { BayesianEngine }     = loadModule('./signal-pipeline/bayesian-engine',    'BayesianEngine')    || {};
const { StatisticalValidator }= loadModule('./signal-pipeline/statistical-validator','StatisticalValidator') || {};
const { WalkForwardOptimizer }= loadModule('./signal-pipeline/walk-forward-optimizer','WalkForwardOptimizer') || {};
const { EnsembleEngine }     = loadModule('./signal-pipeline/ensemble-engine',    'EnsembleEngine')    || {};
const { MicrostructureAgent }= loadModule('./agents/microstructure-agent',        'MicrostructureAgent') || {};
const { FractalAgent }       = loadModule('./agents/fractal-agent',               'FractalAgent')      || {};
const { DrawdownGuard }      = loadModule('./risk-engine/drawdown-guard',        'DrawdownGuard')     || {};
const { RiskEngine }         = loadModule('./risk-engine/position-sizer',        'RiskEngine')        || {};
const { SessionFilter }      = loadModule('./risk-engine/session-filter',        'SessionFilter')     || {};
const { CorrelationFilter }  = loadModule('./risk-engine/correlation',           'CorrelationFilter') || {};
const { ConflictResolver: ConflictResolverClass } = loadModule('./orchestrator/conflict-resolver', 'ConflictResolver') || {};
const { MemoryManager }      = loadModule('./orchestrator/memory-manager',       'MemoryManager')     || {};
const { ExecutionManager }   = loadModule('./orchestrator/execution-algorithms',  'ExecutionManager')  || {};
const { SignalMonitor }      = loadModule('./signal-pipeline/signal-monitor',     'SignalMonitor')     || {};
const { InstitutionalRiskManager } = loadModule('./risk-engine/institutional-risk-manager', 'InstitutionalRiskManager') || {};
const { MyfxbookFeed }       = loadModule('./feeds/myfxbook-feed',               'MyfxbookFeed')      || {};
const { OpenInsiderFeed }    = loadModule('./feeds/openinsider-feed',            'OpenInsiderFeed')   || {};

// ConflictResolver is instantiated (not static) — create one singleton
const conflictResolver = ConflictResolverClass ? new ConflictResolverClass() : null;

// ── 3. System state ────────────────────────────────────────────────────────

/** Per-symbol candle stores — { symbol: { TF: candle[] } } */
const candleStores = {};

/** Per-symbol agent instances */
const agentPool = {};

/** Track last vote per symbol for signal assembly */
const lastVotes = {};

// In-flight analysis guard — prevents duplicate concurrent analyses per symbol+TF
const inFlight = new Set();

// ── 4. Initialise per-symbol agent pool ────────────────────────────────────

function initAgentsForSymbol(symbol) {
  agentPool[symbol] = {
    smc:            SMCAgent           ? new SMCAgent({ symbol, timeframe: 'H1', lookback: 30, pivotStrength: 3, minScore: 60 }) : null,
    mtf:            MTFAgent           ? new MTFAgent({ symbol, requireHTFAlign: true }) : null,
    momentum:       MomentumAgent      ? new MomentumAgent({ symbol, timeframe: 'H1' }) : null,
    sentiment:      SentimentAgent     ? new SentimentAgent({ symbol }) : null,
    pattern:        PatternAgent       ? new PatternAgent({ symbol }) : null,
    volumeOI:       VolumeOIAgent      ? new VolumeOIAgent({ symbol, timeframe: 'H1' }) : null,
    microstructure: MicrostructureAgent? new MicrostructureAgent({ symbol, timeframe: 'H1' }) : null,
    fractal:        FractalAgent       ? new FractalAgent({ symbol, timeframe: 'H1' }) : null,
  };

  candleStores[symbol] = {};
  lastVotes[symbol]    = {};

  for (const tf of TIMEFRAMES_STR) {
    candleStores[symbol][tf] = [];
  }

  log.info(`Agents initialised for ${symbol}`);
}

// ── 5. Signal pipeline ─────────────────────────────────────────────────────

/**
 * Runs the full signal pipeline for one symbol on one timeframe.
 * Called when a candle closes.
 */
async function runAnalysisCycle(symbol, timeframe) {
  const key = `${symbol}:${timeframe}`;
  if (inFlight.has(key)) {
    log.debug(`Analysis already in flight for ${key} — skipping`);
    return;
  }
  inFlight.add(key);

  try {
    const candles = candleStores[symbol]?.[timeframe];
    if (!candles || candles.length < 50) {
      log.debug(`${key}: not enough candles (${candles?.length || 0}/50) — waiting`);
      return;
    }

    const agents  = agentPool[symbol];
    if (!agents) return;

    log.info(`[Analysis] ${key} — ${candles.length} candles`);

    // ── Run agents in parallel (including new institutional agents) ──
    const [smcResult, mtfResult, momResult, volumeResult, microResult, fractalResult] = await Promise.all([
      agents.smc?.analyze(candles)
        .catch(e => { log.warn(`SMC error [${key}]: ${e.message}`); return null; }),

      agents.mtf?.analyze({ [timeframe]: candles, ...buildMTFData(symbol) })
        .catch(e => { log.warn(`MTF error [${key}]: ${e.message}`); return null; }),

      agents.momentum?.analyze(candles)
        .catch(e => { log.warn(`Momentum error [${key}]: ${e.message}`); return null; }),

      agents.volumeOI?.analyze(candles)
        .catch(e => { log.warn(`Volume/OI error [${key}]: ${e.message}`); return null; }),

      agents.microstructure?.analyze(candles)
        .catch(e => { log.warn(`Microstructure error [${key}]: ${e.message}`); return null; }),

      agents.fractal?.analyze(candles)
        .catch(e => { log.warn(`Fractal error [${key}]: ${e.message}`); return null; }),
    ]);

    // Sentiment/Pattern run less frequently (every 3rd cycle per symbol)
    const sentResult = agents.sentiment && Math.random() > 0.66
      ? await agents.sentiment.analyze(candles).catch(() => null)
      : lastVotes[symbol]?.macroSent || null;

    // Store votes for next cycle reuse
    if (smcResult)   lastVotes[symbol].smc       = smcResult;
    if (mtfResult)   lastVotes[symbol].mtf        = mtfResult;
    if (momResult)   lastVotes[symbol].momentum   = momResult;
    if (sentResult)  lastVotes[symbol].macroSent  = sentResult;
    if (volumeResult)  lastVotes[symbol].volumeOI       = volumeResult;
    if (microResult)   lastVotes[symbol].microstructure  = microResult;
    if (fractalResult) lastVotes[symbol].fractal         = fractalResult;

    // ── Check we have the three minimum votes ──
    const votes = lastVotes[symbol];
    if (!votes.smc || !votes.mtf || !votes.momentum) {
      log.debug(`${key}: incomplete votes — smc:${!!votes.smc} mtf:${!!votes.mtf} mom:${!!votes.momentum}`);
      return;
    }

    const agentVotes = {
      smc:            votes.smc,
      mtf:            votes.mtf,
      momentum:       votes.momentum,
      macroSent:      votes.macroSent || null,
      volumeOI:       votes.volumeOI || null,
      microstructure: votes.microstructure || null,
      fractal:        votes.fractal || null,
    };

    const regime = regimeEngine?.classify
      ? regimeEngine.classify(candles)
      : { regime: 'UNKNOWN', tradeability: 50, reasons: [] };

    if (wsBus) {
      wsBus.emit('regime_update', { symbol, timeframe, ...regime });
    }

    // ── Conflict resolution ──
    const currentPrice = candles[candles.length - 1].close;
    const conflictCtx  = { symbol, timeframe, currentPrice };

    let resolvedVotes = agentVotes;
    if (conflictResolver?.resolve) {
      const resolved = conflictResolver.resolve(agentVotes, conflictCtx);
      if (!resolved.resolved) {
        log.debug(`${key}: conflict resolver blocked — ${resolved.note}`);
        return;
      }
      resolvedVotes = resolved.votes;
    }

    // ── Score ──
    if (!scorer) { log.warn('SignalScorer not available'); return; }

    let signal = await scorer.score(resolvedVotes, {
      symbol,
      timeframe,
      currentPrice,
      timestamp: Date.now(),
    });

    if (!signal || signal.action === 'WAIT') {
      log.debug(`${key}: score=${signal?.score?.final || 0} — no signal`);
      return;
    }

    log.info(`[SIGNAL] ${signal.action} ${symbol} @ ${currentPrice} | Score: ${signal.score?.final} | Grade: ${signal.score?.grade}`);

    // ── Refine entry, build SL/TP, then gate the setup ──
    let fullSignal = { ...signal, regime };
    let entryOptimization = null;
    let tradePlan = null;
    let riskEvaluation = null;

    if (entryOptimizer && signal.action !== 'WAIT') {
      entryOptimization = entryOptimizer.optimize({ 
        smcAnalysis: smcResult?.analysis || lastVotes[symbol].smc?.analysis, 
        signal, 
        candles 
      });
      if (!entryOptimization?.rejected && entryOptimization?.entry) {
        const e = entryOptimization.entry;
        signal = {
          ...signal,
          entry: {
            zoneHigh: e.zoneHigh,
            zoneLow: e.zoneLow,
            midpoint: e.midPoint,
            type: e.type,
            note: e.note,
          },
          entryOptimization,
        };
      }
    }

    if (sltp && signal.action !== 'WAIT') {
      try {
        const sltpResult = sltp.calculate(signal, candles, {
          accountBalance: ACCOUNT_BALANCE,
          riskPct: RISK_PCT,
        });
        if (sltpResult?.error) {
          log.warn(`SL/TP rejected ${key}: ${sltpResult.error}`);
        } else {
          tradePlan = sltpResult.plan;
          riskEvaluation = riskEngine?.evaluate
            ? riskEngine.evaluate({
                ...signal,
                entry: { midPoint: tradePlan.entry.midPoint },
                stopLoss: tradePlan.stopLoss,
                atr: tradePlan.risk.atr,
              })
            : { approved: true, reason: 'RiskEngine unavailable' };
        }
      } catch (e) {
        log.warn(`SL/TP calculation error: ${e.message}`);
      }
    }

    const learning = adaptiveLearning?.evaluateSetup
      ? await adaptiveLearning.evaluateSetup({
          signal,
          tradePlan,
          entryOptimization,
          riskEvaluation,
          regime,
        }).catch(e => ({ action: 'ALLOW', penalty: 0, note: `Learning unavailable: ${e.message}` }))
      : { action: 'ALLOW', penalty: 0, note: 'Adaptive learning disabled' };

    if (learning?.penalty && signal.score?.final != null) {
      signal.score = {
        ...signal.score,
        preLearning: signal.score.final,
        final: Math.max(0, Math.round(signal.score.final - learning.penalty)),
        learningPenalty: learning.penalty,
      };
    }

    // ── Run institutional-grade validation engines in parallel ──
    const [mcResult, bayesianResult, statResult] = await Promise.all([
      monteCarlo?.simulate
        ? monteCarlo.simulate({ candles, signal, tradePlan, regime })
        : null,
      bayesianEng?.evaluate
        ? bayesianEng.evaluate({ signal, tradePlan, regime, entryOptimization, riskEvaluation, votes: resolvedVotes, session: signal.session })
        : null,
      statValidator?.validate
        ? statValidator.validate({ candles, signal, tradePlan, regime })
        : null,
    ]).catch(e => {
      log.warn(`Validation engine error: ${e.message}`);
      return [null, null, null];
    });

    // Walk-forward check (uses cached analysis, fast)
    const wfResult = walkForward?.analyze ? walkForward.analyze() : null;

    // Ensemble validation — combines all layers
    let ensembleResult = null;
    if (ensembleEng?.evaluate) {
      ensembleResult = ensembleEng.evaluate({
        monteCarlo:     mcResult,
        bayesian:       bayesianResult,
        statistical:    statResult,
        walkForward:    wfResult,
        learning,
        agentVotes:     resolvedVotes,
        regime,
        fractal:        votes.fractal || null,
        microstructure: votes.microstructure || null,
      }, signal);

      // Apply ensemble penalty to score
      if (ensembleResult?.totalPenalty && signal.score?.final != null) {
        signal.score = {
          ...signal.score,
          preEnsemble: signal.score.final,
          final: Math.max(0, Math.round(signal.score.final - ensembleResult.totalPenalty)),
          ensemblePenalty: ensembleResult.totalPenalty,
        };
      }

      log.info(`[ENSEMBLE] ${symbol} ${timeframe}: score=${ensembleResult.ensembleScore} approved=${ensembleResult.approved} layers=${ensembleResult.approvedLayers}/${ensembleResult.layerCount}`);
    }

    const gate = institutionalGates?.evaluate
      ? institutionalGates.evaluate({
          signal,
          tradePlan,
          entryOptimization,
          riskEvaluation,
          regime,
          votes: resolvedVotes,
          ensemble: ensembleResult,
          learning,
      })
      : { approved: true, status: 'APPROVED', failures: [], warnings: [], confidence: signal.score?.final || 0 };

    gate.learning = learning;
    if (learning?.action === 'BLOCK') {
      gate.approved = false;
      gate.status = 'REJECTED';
      gate.failures = [...(gate.failures || []), `Adaptive learning blocked repeat pattern: ${learning.note}`];
    } else if (learning?.action === 'WARN') {
      gate.status = gate.status === 'APPROVED' ? 'APPROVED_WITH_WARNINGS' : gate.status;
      gate.warnings = [...(gate.warnings || []), `Adaptive learning warning: ${learning.note}`];
    }

    if (!gate.approved) {
      log.warn(`[GATE BLOCK] ${symbol} ${timeframe}: ${gate.failures.join(' | ')}`);
      mongoStore.saveTelemetry?.({
        symbol,
        timeframe,
        type: 'gate_block',
        gate,
        regime,
        timestamp: Date.now(),
      }).catch(e => log.warn(`Mongo telemetry save error: ${e.message}`));
      if (wsBus) {
        wsBus.emit('telemetry_update', {
          symbol,
          timeframe,
          type: 'gate_block',
          gate,
          regime,
          timestamp: Date.now(),
        });
      }
      return;
    }

    fullSignal = {
      ...signal,
      tradePlan,
      riskEvaluation,
      entryOptimization,
      gate,
      regime,
      ensemble: ensembleResult,
      validation: {
        monteCarlo: mcResult ? {
          approved: mcResult.approved,
          winProbability: mcResult.winProbability,
          expectedR: mcResult.expectedR,
          simulations: mcResult.simulations,
        } : null,
        bayesian: bayesianResult ? {
          approved: bayesianResult.approved,
          posterior: bayesianResult.posterior,
        } : null,
        statistical: statResult ? {
          approved: statResult.approved,
          passed: statResult.passed,
          total: statResult.total,
        } : null,
        walkForward: wfResult ? {
          sufficient: wfResult.sufficient,
          wfe: wfResult.wfe,
          robust: wfResult.robust,
        } : null,
      },
    };

    if (tradePlan) {
      fullSignal.entry = {
        ...fullSignal.entry,
        midpoint: tradePlan.entry.midPoint,
        zoneHigh: tradePlan.entry.zoneHigh,
        zoneLow: tradePlan.entry.zoneLow,
      };
      fullSignal.stopLoss = tradePlan.stopLoss;
      fullSignal.targets = tradePlan.targets;
      fullSignal.management = {
        ...fullSignal.management,
        summary: tradePlan.management?.summary,
      };
    }

    // ── Store in memory ──
    if (memory?.saveSignal) {
      memory.saveSignal(fullSignal).catch(e => log.warn(`Memory save error: ${e.message}`));
    }
    if (mongoStore.saveSignal) {
      mongoStore.saveSignal(fullSignal).catch(e => log.warn(`Mongo signal save error: ${e.message}`));
    }

    // ── Dispatch to Telegram ──
    if (dispatcher?.sendSignal) {
      await dispatcher.sendSignal(fullSignal).catch(e => {
        log.error(`Dispatch error: ${e.message}`);
      });
    }

    // ── Emit to Mini App via WebSocket bus ──
    if (wsBus) {
      wsBus.emit('signal', fullSignal);
      // Also emit updated stats
      wsBus.emit('stats_update', {
        total:    Object.values(lastVotes).reduce((s, v) => s + (v._signalCount || 0), 0),
        gradeA:   fullSignal.score?.grade === 'A' ? 1 : 0,
      });
      if (drawdownGuard?.getStatus) {
        const status = drawdownGuard.getStatus();
        wsBus.emit('risk_update', {
          state: status.circuitBreaker?.state,
          dailyPnl: status.daily?.pnl,
          drawdown: status.drawdown?.current,
          consecLoss: status.consecLoss,
          maxDailyLoss: status.daily?.limit,
          maxDrawdown: status.drawdown?.limit,
          netSizingFactor: status.netSizingFactor,
        });
      }
      wsBus.emit('telemetry_update', {
        symbol,
        timeframe,
        type: 'signal_approved',
        gate,
        regime,
        risk: riskEvaluation,
        timestamp: Date.now(),
      });
    }

    // Update drawdown guard on signal fire
    if (drawdownGuard?.recordSignal) {
      drawdownGuard.recordSignal(fullSignal);
    }

  } catch (err) {
    log.error(`Analysis cycle error [${symbol}:${timeframe}]: ${err.message}`);
    if (LOG_LEVEL === 'debug') console.error(err.stack);
  } finally {
    inFlight.delete(key);
  }
}

/** Build multi-TF data object for MTFAgent from current candle stores */
function buildMTFData(symbol) {
  const store = candleStores[symbol] || {};
  const data  = {};
  for (const tf of TIMEFRAMES_STR) {
    if (store[tf] && store[tf].length > 0) data[tf] = store[tf];
  }
  return data;
}

// ── 6. Candle ingestion ────────────────────────────────────────────────────

const MAX_CANDLES_PER_TF = 500;

function onCandle({ symbol, timeframe, candle, isClosed }) {
  if (!SYMBOLS.includes(symbol)) return;
  if (!TIMEFRAMES_STR.includes(timeframe)) return;

  const store = candleStores[symbol];
  if (!store) return;

  if (!store[timeframe]) store[timeframe] = [];

  const arr = store[timeframe];

  // Update or push
  if (arr.length && arr[arr.length - 1].timestamp === candle.timestamp) {
    arr[arr.length - 1] = candle;  // update in-progress candle
  } else {
    arr.push(candle);
    if (arr.length > MAX_CANDLES_PER_TF) arr.shift();
  }

  // Only run analysis on closed candles to avoid noise
  if (isClosed) {
    // Stream latest price to Mini App
    if (wsBus && candle) {
      wsBus.emit('market_update', {
        symbol,
        price:  candle.close,
        change: candle.open ? ((candle.close - candle.open) / candle.open * 100) : 0,
        bias:   lastVotes[symbol]?.smc?.direction?.toLowerCase() || 'wait',
      });
    }
    setImmediate(() => runAnalysisCycle(symbol, timeframe));
  }
}

// ── 7. Instantiate singletons ──────────────────────────────────────────────

let dispatcher, scorer, sltp, entryOptimizer, regimeEngine, institutionalGates,
    adaptiveLearning, drawdownGuard, riskEngine, sessionFilter, correlationFilter, memory,
    monteCarlo, bayesianEng, statValidator, walkForward, ensembleEng,
    signalMonitor, institutionalRiskManager, executionManager, myfxbookFeed, openInsiderFeed;

function buildSingletons() {
  // AlertDispatcher
  if (AlertDispatcher && BOT_TOKEN) {
    dispatcher = new AlertDispatcher({ token: BOT_TOKEN, chatIds: CHAT_IDS, store: mongoStore });
    log.info(`AlertDispatcher created — ${CHAT_IDS.length} chat(s) + auto-subscribe enabled`);
  } else {
    log.warn('AlertDispatcher disabled — no BOT_TOKEN or module missing');
    dispatcher = null;
  }

  // DrawdownGuard
  if (DrawdownGuard) {
    drawdownGuard = new DrawdownGuard({
      maxDailyLossPct:  MAX_DAILY_LOSS,
      maxDrawdownPct:   MAX_DRAWDOWN,
      accountBalance:ACCOUNT_BALANCE,
    });
    drawdownGuard.on('circuit_open', (data) => {
      log.warn(`CIRCUIT BREAKER OPEN: ${data.reason}`);
      dispatcher?.sendMessage?.(`🛑 *CIRCUIT BREAKER OPEN*\n${data.reason}`)?.catch(() => {});
    });
    log.info('DrawdownGuard created');
  }

  // SignalScorer — pass circuit breaker state check
  if (SignalScorer) {
    scorer = new SignalScorer({
      minScore:      MIN_SCORE,
      sessionFilter: true,
      newsBlackout:  true,
      requireKillzone: REQUIRE_KZ,
      circuitBreaker: {
        maxDailyLoss:  MAX_DAILY_LOSS,
        maxDrawdown:   MAX_DRAWDOWN,
      },
    });

    scorer.on('signal', (sig) => {
      log.info(`[Scorer signal event] ${sig.action} ${sig.symbol} score=${sig.score?.final}`);
    });
    log.info('SignalScorer created');
  } else {
    log.error('SignalScorer module missing — signals cannot be scored');
  }

  // SL/TP Engine
  if (SLTPEngine) {
    sltp = new SLTPEngine();
    log.info('SLTPEngine created');
  }

  // EntryOptimizer
  if (EntryOptimizer) {
    entryOptimizer = new EntryOptimizer();
    log.info('EntryOptimizer created');
  }

  if (RegimeEngine) {
    regimeEngine = new RegimeEngine({ lookback: 120 });
    log.info('RegimeEngine created');
  }

  if (InstitutionalGates) {
    institutionalGates = new InstitutionalGates({
      minScore: MIN_SCORE,
      minRR: 1.5,
      maxRiskPct: Math.min(RISK_PCT, 2.0),
      minRegimeTradeability: 50,
    });
    log.info('InstitutionalGates created');
  }

  if (AdaptiveLearningEngine) {
    adaptiveLearning = new AdaptiveLearningEngine({ store: mongoStore });
    log.info('AdaptiveLearningEngine created (with RL + Mistake Blacklist)');
  }

  // Monte Carlo Simulation Engine
  if (MonteCarloEngine) {
    monteCarlo = new MonteCarloEngine({
      simulations: parseInt(process.env.MC_SIMULATIONS || '5000', 10),
      minWinProb: parseFloat(process.env.MC_MIN_WIN_PROB || '0.55'),
      minExpectedR: parseFloat(process.env.MC_MIN_EXPECTED_R || '0.3'),
    });
    log.info('MonteCarloEngine created (5000 sims × 3 methods = 15000 paths)');
  }

  // Bayesian Probability Engine
  if (BayesianEngine) {
    bayesianEng = new BayesianEngine({
      basePrior: parseFloat(process.env.BAYES_PRIOR || '0.50'),
      minPosterior: parseFloat(process.env.BAYES_MIN_POSTERIOR || '0.52'),
    });
    log.info('BayesianEngine created (LR + NaiveBayes + BetaBinomial)');
  }

  // Statistical Validator
  if (StatisticalValidator) {
    statValidator = new StatisticalValidator({
      minTestsPassed: parseInt(process.env.STAT_MIN_TESTS || '5', 10),
      significanceLevel: parseFloat(process.env.STAT_SIGNIFICANCE || '0.05'),
    });
    log.info('StatisticalValidator created (10 hypothesis tests)');
  }

  // Walk-Forward Optimizer
  if (WalkForwardOptimizer) {
    walkForward = new WalkForwardOptimizer({
      minSamples: parseInt(process.env.WF_MIN_SAMPLES || '20', 10),
      minWFE: parseFloat(process.env.WF_MIN_WFE || '0.35'),
    });
    log.info('WalkForwardOptimizer created');
  }

  // Ensemble Validation Engine
  if (EnsembleEngine) {
    ensembleEng = new EnsembleEngine({
      minConfidence: parseFloat(process.env.ENSEMBLE_MIN_CONFIDENCE || '60'),
    });
    log.info('EnsembleEngine created (9-layer consensus validation)');
  }

  // PositionSizer (exported as RiskEngine in position-sizer.js)
  if (RiskEngine) {
    riskEngine = new RiskEngine({
      accountBalance: ACCOUNT_BALANCE,
      riskPct:        RISK_PCT,
      sizingMethod:   'ATR',
    });
    log.info('RiskEngine (position sizer) created');
  }

  // SessionFilter
  if (SessionFilter) {
    sessionFilter = new SessionFilter();
    log.info('SessionFilter created');
  }

  // CorrelationFilter
  if (CorrelationFilter) {
    correlationFilter = new CorrelationFilter({ maxOpenPositions: 5 });
    log.info('CorrelationFilter created');
  }

  // MemoryManager (in-memory fallback is built into it)
  if (MemoryManager) {
    memory = new MemoryManager({
      redisUrl:    process.env.REDIS_URL    || null,
      databaseUrl: process.env.DATABASE_URL || null,
    });
    log.info('MemoryManager created (in-memory fallback active if no Redis/PG)');
  }

  // Signal Monitor - Real-time signal strength tracking
  if (SignalMonitor) {
    signalMonitor = new SignalMonitor({
      checkIntervalMs: 60000, // Check every minute
    });
    signalMonitor.on('signal_weakening', (data) => {
      log.warn(`[SignalMonitor] Signal weakening: ${data.signalId} - ${data.alert.message}`);
      dispatcher?.sendMessage?.(`⚠️ *Signal Weakening*\n${data.signalId}\n${data.alert.message}`)?.catch(() => {});
    });
    signalMonitor.on('reversal_risk', (data) => {
      log.warn(`[SignalMonitor] Reversal risk: ${data.signalId} - ${data.alert.message}`);
      dispatcher?.sendMessage?.(`🔄 *Reversal Risk*\n${data.signalId}\n${data.alert.message}`)?.catch(() => {});
    });
    signalMonitor.on('signal_failed', (data) => {
      log.warn(`[SignalMonitor] Signal failed: ${data.signalId} - ${data.alert.message}`);
      dispatcher?.sendMessage?.(`❌ *Signal Failed*\n${data.signalId}\n${data.alert.message}`)?.catch(() => {});
    });
    log.info('SignalMonitor created');
  }

  // Institutional Risk Manager - Jane Street/Wall Street grade risk management
  if (InstitutionalRiskManager) {
    institutionalRiskManager = new InstitutionalRiskManager({
      accountBalance: ACCOUNT_BALANCE,
      maxDailyLossPct: MAX_DAILY_LOSS,
      maxDrawdownPct: MAX_DRAWDOWN,
    });
    institutionalRiskManager.on('regime_change', (data) => {
      log.info(`[InstitutionalRisk] Regime change: ${data.regime} (risk multiplier: ${data.riskMultiplier})`);
    });
    log.info('InstitutionalRiskManager created (Kelly Criterion, Correlation Analysis, Tail Risk)');
  }

  // Execution Manager - TWAP/VWAP/POV execution algorithms
  if (ExecutionManager) {
    executionManager = new ExecutionManager();
    log.info('ExecutionManager created (TWAP, VWAP, POV algorithms)');
  }

  // Myfxbook Feed - Economic calendar and community sentiment
  if (MyfxbookFeed && process.env.MYFXBOOK_EMAIL && process.env.MYFXBOOK_PASSWORD) {
    myfxbookFeed = new MyfxbookFeed({
      email: process.env.MYFXBOOK_EMAIL,
      password: process.env.MYFXBOOK_PASSWORD,
      pollIntervalMs: 5 * 60000,
    });
    myfxbookFeed.on('economic_surprise', (data) => {
      log.info(`[Myfxbook] Economic surprise: ${data.event.name} - ${data.impact}`);
      dispatcher?.sendMessage?.(`📊 *Economic Surprise*\n${data.event.name}\nImpact: ${data.impact}\nCurrencies: ${data.affectedCurrencies.join(', ')}`)?.catch(() => {});
    });
    myfxbookFeed.on('extreme_retail_positioning', (data) => {
      log.warn(`[Myfxbook] Extreme retail positioning: ${data.symbol} - ${data.data.contrarianReason}`);
    });
    myfxbookFeed.on('upcoming_events', (data) => {
      log.info(`[Myfxbook] ${data.count} high-impact events upcoming`);
    });
    log.info('MyfxbookFeed created');
  } else {
    log.warn('MyfxbookFeed disabled - missing credentials or module');
  }

  // OpenInsider Feed - SEC Form 4 insider trading data
  if (OpenInsiderFeed) {
    openInsiderFeed = new OpenInsiderFeed({
      apiKey: process.env.PARSE_API_KEY || null,
      pollIntervalMs: 10 * 60000,
    });
    openInsiderFeed.on('cluster_buy', (data) => {
      log.info(`[OpenInsider] Cluster buy detected: ${data.ticker} - ${data.insiderCount} insiders`);
      dispatcher?.sendMessage?.(`💼 *Cluster Buy*\n${data.ticker}\n${data.insiderCount} insiders in ${data.windowDays} days\nConfidence: ${data.confidence}%`)?.catch(() => {});
    });
    openInsiderFeed.on('executive_activity', (data) => {
      log.info(`[OpenInsider] Executive activity: ${data.ticker} - ${data.signal}`);
    });
    log.info('OpenInsiderFeed created');
  }
}

// ── 8. Build feeds ─────────────────────────────────────────────────────────

function buildFeeds() {
  const feeds = [];

  // Separate crypto vs forex/commodity symbols
  const cryptoSymbols = SYMBOLS.filter(s => s.endsWith('USDT') || s.endsWith('USDC') || s.endsWith('BTC'));
  const fxSymbols     = SYMBOLS.filter(s => !cryptoSymbols.includes(s));

  // Binance feed for crypto
  if (BinanceFeed && cryptoSymbols.length) {
    const binanceFeed = new BinanceFeed({
      symbols:    cryptoSymbols,
      timeframes: TIMEFRAMES_STR,
    });
    binanceFeed.on('candle',        onCandle);
    binanceFeed.on('candle_update', onCandle);
    binanceFeed.on('error', (err) => log.error(`BinanceFeed error: ${err.message}`));
    binanceFeed.on('connected', () => log.info(`BinanceFeed connected for: ${cryptoSymbols.join(', ')}`));
    feeds.push({ name: 'BinanceFeed', instance: binanceFeed, symbols: cryptoSymbols });
    log.info(`BinanceFeed configured for: ${cryptoSymbols.join(', ')}`);
  }

  // TwelveData feed for forex/commodities
  if (TwelveDataFeed && fxSymbols.length && TWELVE_KEY) {
    const tdFeed = new TwelveDataFeed({
      apiKey:     TWELVE_KEY,
      symbols:    fxSymbols,
      timeframes: TIMEFRAMES_STR,
    });
    tdFeed.on('candle',        onCandle);
    tdFeed.on('candle_update', onCandle);
    tdFeed.on('error', (err) => log.error(`TwelveData error: ${err.message}`));
    tdFeed.on('connected', () => log.info(`TwelveDataFeed connected for: ${fxSymbols.join(', ')}`));
    feeds.push({ name: 'TwelveDataFeed', instance: tdFeed, symbols: fxSymbols });
    log.info(`TwelveDataFeed configured for: ${fxSymbols.join(', ')}`);
  } else if (fxSymbols.length && !TWELVE_KEY) {
    log.warn(`Forex symbols ${fxSymbols.join(',')} configured but TWELVE_DATA_API_KEY is missing`);
  }

  return feeds;
}

// ── 9. Graceful shutdown ───────────────────────────────────────────────────

function setupShutdown(feeds) {
  async function shutdown(signal) {
    log.info(`Received ${signal} — shutting down...`);

    for (const f of feeds) {
      try { await f.instance.disconnect?.(); } catch (_) {}
      log.info(`${f.name} disconnected`);
    }

    try { memory?.flush?.(); } catch (_) {}
    log.info('OMNICEE shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    if (LOG_LEVEL === 'debug') console.error(err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason}`);
  });
}

// ── 10. Main boot ──────────────────────────────────────────────────────────

async function main() {
  log.info('╔══════════════════════════════════════╗');
  log.info('║  OMNICEE  — Institutional Grade v2   ║');
  log.info('║  Monte Carlo · Bayesian · Ensemble   ║');
  log.info('╚══════════════════════════════════════╝');
  log.info(`Symbols:    ${SYMBOLS.join(', ')}`);
  log.info(`Timeframes: ${TIMEFRAMES_STR.join(', ')}`);
  log.info(`Min score:  ${MIN_SCORE} | Risk: ${RISK_PCT}% | Max DD: ${MAX_DRAWDOWN}%`);

  // a. Build all singletons (scorer, dispatcher, risk, memory)
  buildSingletons();

  // b. Init agents per symbol
  for (const sym of SYMBOLS) {
    initAgentsForSymbol(sym);
  }

  // c. Init Telegram bot
  if (dispatcher) {
    try {
      await dispatcher.init();
      log.info('Telegram bot initialised');
      await dispatcher.sendMessage?.('🚀 *OMNICEE Online*\nSystem initialized. Monitoring markets...');
      // Share dispatcher with API server for EA endpoints
      try { require('./api/realtime').setDispatcher(dispatcher); } catch (_) {}
    } catch (err) {
      log.error(`Telegram init failed: ${err.message}. Signals will still run — just no Telegram output.`);
    }
  }

  // d. Init memory
  if (memory?.init) {
    try { await memory.init(); } catch (e) { log.warn(`Memory init: ${e.message}`); }
  }

  // e. Build and connect feeds
  const feeds = buildFeeds();
  setupShutdown(feeds);

  let connected = 0;
  for (const f of feeds) {
    try {
      await f.instance.connect();
      log.info(`${f.name} connected`);
      connected++;
    } catch (err) {
      log.error(`${f.name} connection failed: ${err.message}`);
    }
  }

  // f. Connect external data feeds
  if (myfxbookFeed) {
    try {
      await myfxbookFeed.connect();
      log.info('MyfxbookFeed connected');
    } catch (err) {
      log.error(`MyfxbookFeed connection failed: ${err.message}`);
    }
  }

  if (openInsiderFeed) {
    try {
      await openInsiderFeed.connect();
      log.info('OpenInsiderFeed connected');
    } catch (err) {
      log.error(`OpenInsiderFeed connection failed: ${err.message}`);
    }
  }

  // g. Connect signal monitor
  if (signalMonitor) {
    try {
      await signalMonitor.connect();
      log.info('SignalMonitor connected');
    } catch (err) {
      log.error(`SignalMonitor connection failed: ${err.message}`);
    }
  }

  // h. Connect institutional risk manager
  if (institutionalRiskManager) {
    try {
      await institutionalRiskManager.connect();
      log.info('InstitutionalRiskManager connected');
    } catch (err) {
      log.error(`InstitutionalRiskManager connection failed: ${err.message}`);
    }
  }

  // i. Connect execution manager
  if (executionManager) {
    try {
      await executionManager.connect();
      log.info('ExecutionManager connected');
    } catch (err) {
      log.error(`ExecutionManager connection failed: ${err.message}`);
    }
  }

  if (connected === 0 && feeds.length > 0) {
    log.error('No feeds connected — check your API keys and network connection');
  }

  if (feeds.length === 0) {
    log.warn('No feeds configured. Add BINANCE_API_KEY and/or TWELVE_DATA_API_KEY to .env');
    log.info('Running in dry-run mode — use the test script to inject synthetic candles');
  }

  log.info('OMNICEE boot complete. Waiting for market data...');
  log.info('─────────────────────────────────────────────────');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[FATAL] Boot failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

// ── Exports for testing ────────────────────────────────────────────────────

module.exports = { main, onCandle, runAnalysisCycle, candleStores, agentPool, lastVotes };
