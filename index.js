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
// FIX: intermarket analysis (DXY/equity cross-confirmation) — the last item
// on the original audit's "does not exist" list. Configurable since not
// FIX: was 'DXY' / 'SPX500', with a comment claiming "every TwelveData
// plan/region resolves 'DXY' the same way" — confirmed against TwelveData's
// own indices page (twelvedata.com/indices), which states indices data is
// "coming soon" and isn't a live product yet. Any literal index symbol
// fails with "symbol or figi parameter is missing or invalid" regardless of
// plan/region — this isn't a formatting or tier issue, the feature doesn't
// exist there yet. UUP (Invesco DB US Dollar Index Bullish Fund) and SPY
// (SPDR S&P 500 ETF Trust) are the standard, widely-used ETF proxies for
// the Dollar Index and S&P 500 respectively — fully supported as ordinary
// ETF data, and track their underlying index closely enough for
// intermarket-analysis purposes.
const DXY_SYMBOL          = process.env.DXY_SYMBOL          || 'UUP';
const EQUITY_INDEX_SYMBOL = process.env.EQUITY_INDEX_SYMBOL || 'SPY';

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
const { recordOutcomeEverywhere } = loadModule('./signal-pipeline/outcome-recorder', 'OutcomeRecorder') || {};
const { ExecutionEngine }    = loadModule('./signal-pipeline/manual-mode',       'ExecutionEngine')    || {};
const { BinanceFeed }        = loadModule('./feeds/binance-ws',                  'BinanceFeed')        || {};
const { BybitFeed }           = loadModule('./feeds/bybit-ws',                    'BybitFeed')          || {};
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
const { AlphaVantageFeed }   = loadModule('./feeds/alpha-vantage-feed',          'AlphaVantageFeed')  || {};
const { FinnhubFeed }        = loadModule('./feeds/finnhub-feed',                'FinnhubFeed')       || {};
const { FMPFeed }            = loadModule('./feeds/fmp-feed',                    'FMPFeed')           || {};
const { CFTCCotFeed }        = loadModule('./feeds/cftc-cot-feed',               'CFTCCotFeed')       || {};
const { COTReportParser }    = loadModule('./feeds/cot-report-parser',           'COTReportParser')   || {};
const { OpportunityRanker }  = loadModule('./signal-pipeline/opportunity-ranker', 'OpportunityRanker') || {};
const { RelativeStrengthEngine } = loadModule('./risk-engine/relative-strength', 'RelativeStrengthEngine') || {};
const { DataIntegrityMonitor } = loadModule('./feeds/data-integrity-monitor', 'DataIntegrityMonitor') || {};
const { IntermarketAnalyzer } = loadModule('./risk-engine/intermarket-analyzer', 'IntermarketAnalyzer') || {};
const { TrapDetector }       = loadModule('./signal-pipeline/trap-detector',      'TrapDetector')      || {};
const { CompressionDetector }= loadModule('./signal-pipeline/compression-detector','CompressionDetector') || {};
const { AbnormalMarketDetector } = loadModule('./signal-pipeline/abnormal-market-detector', 'AbnormalMarketDetector') || {};
const { TimeCycleEngine }    = loadModule('./signal-pipeline/time-cycle-engine',   'TimeCycleEngine')   || {};
const { StrategySelector }   = loadModule('./signal-pipeline/strategy-selector',    'StrategySelector')  || {};
const { CandleIntelligence } = loadModule('./signal-pipeline/candle-intelligence',  'CandleIntelligence') || {};
const { AIAdvisor }          = loadModule('./signal-pipeline/ai-advisor',           'AIAdvisor')          || {};
const { MarketHoursGate, SymbolManager } = loadModule('./orchestrator/scheduling-gate', 'MarketHoursGate') || {};
const { AuditTrail }          = loadModule('./orchestrator/audit-trail',             'AuditTrail')         || {};
const { SignalExplainer }    = loadModule('./signal-pipeline/signal-explainer',     'SignalExplainer')    || {};

// ConflictResolver is instantiated (not static) — create one singleton
const conflictResolver = ConflictResolverClass ? new ConflictResolverClass() : null;

// TrapDetector keeps its own rolling per-call history but is stateless enough
// to share across symbols; CompressionDetector, TimeCycleEngine,
// AbnormalMarketDetector, StrategySelector, and CandleIntelligence are all
// fully stateless per call — safe to share across symbols too.
const trapDetector        = TrapDetector        ? new TrapDetector()        : null;
const compressionDetector = CompressionDetector ? new CompressionDetector() : null;
const abnormalMarketDetector = AbnormalMarketDetector ? new AbnormalMarketDetector() : null;
const timeCycleEngine     = TimeCycleEngine     ? new TimeCycleEngine()     : null;
const strategySelector    = StrategySelector    ? new StrategySelector()    : null;
const candleIntelligence  = CandleIntelligence  ? new CandleIntelligence()  : null;
// AIAdvisor no-ops safely (fails open) if ANTHROPIC_API_KEY isn't set — see
// signal-pipeline/ai-advisor.js. Logged once at startup below so it's obvious
// from the boot log whether the agentic layer is actually active.
const aiAdvisor = AIAdvisor ? new AIAdvisor({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
if (aiAdvisor) {
  log.info(aiAdvisor.enabled
    ? `AI Advisor active (model=${aiAdvisor.model}) — advisory-only, fails open on any error`
    : 'AI Advisor loaded but disabled — ANTHROPIC_API_KEY not set in .env');
}
// SignalExplainer is the free counterpart to AIAdvisor — pure template-driven
// natural-language breakdown of the pipeline's own already-computed context,
// no API key, no network call, no cost, never fails. Always on.
const signalExplainer = SignalExplainer ? new SignalExplainer() : null;

// SymbolManager (extracted from orphaned task-planner.js) — seeded with the
// exact SYMBOLS list already configured via .env, so nothing changes by
// default; it exists so a symbol can be blacklisted at runtime (e.g. via a
// future admin action) without touching the SYMBOLS env var or restarting.
const symbolManager = SymbolManager ? new SymbolManager({ symbols: SYMBOLS }) : null;

// AuditTrail (extracted from orphaned task-planner.js) — records every
// analysis cycle result, fired or not, so "what did the pipeline decide
// about X in the last hour" doesn't require grepping logs.
const auditTrail = AuditTrail ? new AuditTrail() : null;

// ── 3. System state ────────────────────────────────────────────────────────

/** Per-symbol candle stores — { symbol: { TF: candle[] } } */
const candleStores = {};
// FIX: VolumeOIAgent.analyze() already reads last.fundingRate / last.openInterest
// directly off candle objects — that plumbing was built correctly, but nothing
// ever attached real values to candles, so those reads always fell back to 0.
// BybitFeed (which has a fully-built funding/OI engine) was never even
// instantiated anywhere. Populated by bootBybitFeed() below.
const bybitFundingOI = {}; // symbol -> { fundingRate, openInterest }
const lastMarketEmit = {}; // symbol -> timestamp of last market_update emit (throttle, see onCandle)

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

  // Symbol/hours gates run before anything else — no point running the full
  // agent pipeline on a blacklisted symbol or during a confirmed dead zone.
  if (symbolManager && !symbolManager.isAllowed(symbol)) {
    log.debug(`${key}: symbol blacklisted/not whitelisted — skipping`);
    return;
  }
  if (MarketHoursGate && !MarketHoursGate.shouldAnalyze(timeframe)) {
    log.debug(`${key}: market-hours gate — skipping (dead zone / weekend M1-M15)`);
    return;
  }

  inFlight.add(key);

  try {
    const candles = candleStores[symbol]?.[timeframe];
    if (!candles || candles.length < 50) {
      log.debug(`${key}: not enough candles (${candles?.length || 0}/50) — waiting`);
      return;
    }

    // FIX: nothing in this pipeline ever asked "is the data I'm about to
    // trade on actually trustworthy?" — a flash-crash wick, a frozen/stale
    // feed repeating the same price, or a huge range on almost no volume
    // would flow straight into all six agents and the scorer exactly like
    // clean data. Gate severe cases before spending any compute on them (and
    // before they pollute lastVotes[symbol] for reuse next cycle); elevated
    // cases are logged and annotated but allowed through, same "dampen not
    // block" philosophy as TrapDetector below.
    let abnormalMarket = null;
    if (abnormalMarketDetector) {
      abnormalMarket = abnormalMarketDetector.analyze({ candles, symbol });
      if (abnormalMarket.abnormal) {
        log.warn(`${key}: abnormal market (${abnormalMarket.severity}) — ${abnormalMarket.reasons.join('; ')}`);
        if (wsBus) wsBus.emit('abnormal_market', { symbol, timeframe, ...abnormalMarket });
        if (abnormalMarket.severity === 'severe') {
          log.warn(`${key}: severe — skipping this cycle entirely`);
          return;
        }
      }
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
    // FIX: this comment already documented the intent to run BOTH sentiment
    // and pattern on a reduced cadence, but the code only ever called
    // agents.sentiment — agents.pattern.analyze() was never called anywhere,
    // meaning PatternAgent's vote (Wyckoff/harmonics/H&S/divergences) had
    // zero influence on any signal ever, despite being instantiated and
    // fully implemented. Both now share the same cadence draw.
    const runReducedCadenceAgents = Math.random() > 0.66;

    const sentResult = agents.sentiment && runReducedCadenceAgents
      ? await buildSentimentExternalData(symbol)
          .then(extData => agents.sentiment.analyze(extData))
          .catch(() => null)
      : lastVotes[symbol]?.macroSent || null;

    const patternResult = agents.pattern && runReducedCadenceAgents
      ? await agents.pattern.analyze(candles).catch(e => { log.warn(`Pattern error [${key}]: ${e.message}`); return null; })
      : lastVotes[symbol]?.pattern || null;

    // Store votes for next cycle reuse
    if (smcResult)   lastVotes[symbol].smc       = smcResult;
    if (mtfResult)   lastVotes[symbol].mtf        = mtfResult;
    if (momResult)   lastVotes[symbol].momentum   = momResult;
    if (sentResult)  lastVotes[symbol].macroSent  = sentResult;
    if (patternResult) lastVotes[symbol].pattern       = patternResult;
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
      pattern:        votes.pattern || null,
    };

    const regime = regimeEngine?.classify
      ? regimeEngine.classify(candles)
      : { regime: 'UNKNOWN', tradeability: 50, reasons: [] };

    if (wsBus) {
      wsBus.emit('regime_update', { symbol, timeframe, ...regime });
    }

    // FIX: institutionalRiskManager was instantiated + connected but never fed
    // live data — setRegime()/updateLiquidity() had zero call sites, so its
    // regime-aware Kelly multiplier and liquidity check were permanently blind.
    // Spread has no real feed anywhere in this codebase (grepped — confirmed),
    // so we use candle range/close as a documented proxy, not a real quote spread.
    if (institutionalRiskManager) {
      if (regime?.regime && institutionalRiskManager.setRegime) {
        institutionalRiskManager.setRegime(regime.regime);
      }
      if (institutionalRiskManager.updateLiquidity) {
        const lastCandle = candles[candles.length - 1];
        const spreadProxy = lastCandle.close > 0
          ? (lastCandle.high - lastCandle.low) / lastCandle.close
          : 0;
        institutionalRiskManager.updateLiquidity(symbol, lastCandle.volume || 1, spreadProxy);
      }
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

    // FIX: sessionFilter (holiday/weekend/liquidity/killzone/rollover/news-blackout
    // gate) was instantiated in buildSingletons() but its .check() method was never
    // called anywhere in the pipeline — it was silently doing nothing. Wired in here.
    let sessionQuality = null;
    if (sessionFilter?.check) {
      sessionQuality = sessionFilter.check(symbol, Date.now());
      if (!sessionQuality.allowed) {
        log.debug(`${key}: session filter blocked — ${sessionQuality.reason}`);
        return;
      }
    }

    // FIX: drawdownGuard.evaluate() — the actual pre-trade circuit-breaker /
    // daily-loss / recovery-mode gate — was never called. Only getStatus()
    // (read-only) and recordSignal() (post-hoc logging) were used, so the
    // circuit breaker never actually stopped a new trade from firing.
    let drawdownEval = null;
    if (drawdownGuard?.evaluate) {
      drawdownEval = drawdownGuard.evaluate({ price: currentPrice });
      if (!drawdownEval.allowed) {
        log.warn(`${key}: drawdown guard blocked — ${drawdownEval.reason}`);
        return;
      }
    }

    // ── Score ──
    if (!scorer) { log.warn('SignalScorer not available'); return; }

    let signal = await scorer.score(resolvedVotes, {
      symbol,
      timeframe,
      currentPrice,
      timestamp: Date.now(),
    });

    // Record this cycle's evaluation on the watchlist scoreboard regardless
    // of whether it fires — this is what lets /api/watchlist answer "what's
    // close to setting up?" instead of only ever showing signals that
    // already cleared every gate.
    if (opportunityRanker) {
      opportunityRanker.update(symbol, {
        action:       signal?.action || 'WAIT',
        score:        signal?.score?.final || 0,
        grade:        signal?.score?.grade || null,
        regime:       regime?.regime || null,
        tradeability: regime?.tradeability ?? null,
        session:      sessionQuality?.session || null,
        fired:        !!(signal && signal.action !== 'WAIT'),
        price:        currentPrice,
        timestamp:    Date.now(),
      });
      if (wsBus) {
        wsBus.emit('watchlist_update', opportunityRanker.getRanked({ limit: 20 }));
      }
    }

    if (!signal || signal.action === 'WAIT') {
      log.debug(`${key}: score=${signal?.score?.final || 0} — no signal`);
      if (auditTrail) {
        auditTrail.record({ symbol, timeframe, signalFired: false, blockedReason: 'no_signal_or_wait', score: signal?.score?.final ?? 0 });
      }
      return;
    }

    // ── Trap + compression context ──
    // Trap detector: is this signal firing right at a level that just
    // produced a bull/bear trap (failed breakout + reversal)? If so, dampen
    // conviction rather than blocking outright — the reversal itself may
    // still be tradeable in the opposite direction next cycle.
    let trapContext = null;
    if (trapDetector) {
      trapContext = trapDetector.shouldDampenBreakout({
        candles,
        smcAnalysis: smcResult?.analysis || lastVotes[symbol].smc?.analysis,
        direction: signal.action,
      });
      if (trapContext.dampen && signal.score?.final != null) {
        const dampened = parseFloat((signal.score.final * trapContext.factor).toFixed(2));
        log.debug(`${key}: trap risk dampening score ${signal.score.final} -> ${dampened} (${trapContext.reason})`);
        signal = { ...signal, score: { ...signal.score, final: dampened, trapDampened: true } };
      }
    }

    // Compression detector: purely informational context attached to the
    // signal (and fed to the scanner below) — a squeeze doesn't block a
    // signal, but it flags elevated expansion/whipsaw risk around it.
    let compressionContext = null;
    if (compressionDetector) {
      compressionContext = compressionDetector.analyze({ candles });
    }

    // Abnormal market detector: severe cases were already gated out entirely
    // near the top of this cycle (before agents even ran). 'elevated' cases
    // were allowed through but should still flag the signal for the risk
    // engine to consider sizing down, same "dampen not block" pattern as
    // trap/compression above.
    if (abnormalMarket?.abnormal && abnormalMarket.severity === 'elevated') {
      signal = { ...signal, riskFlags: { ...(signal.riskFlags || {}), abnormalMarket: true, abnormalReasons: abnormalMarket.reasons } };
    }

    // Time cycle engine: informational only — historical hour-of-day /
    // day-of-week edge (or lack of one) for this symbol, attached to the
    // signal for display/journaling. Never blocks or resizes on its own;
    // sample sizes from a single symbol's own history aren't strong enough
    // evidence for that, but they're useful context on the signal card.
    let timeCycleContext = null;
    if (timeCycleEngine) {
      timeCycleContext = timeCycleEngine.currentWindowBias({ candles });
    }

    // AI Strategy Selector: does THIS signal's direction/setup fit the
    // regime that's actually in play right now? Trend-following calls get
    // a lean in DIRECTIONAL regimes, breakout-style calls get discounted
    // in CHOP. This tilts the already-scored confidence and can raise
    // (never lower) the minimum-score bar for choppier/less tradeable
    // regimes — it does not mutate the shared scorer instance, so there's
    // no cross-symbol race condition from concurrent regimes.
    let strategyContext = null;
    if (strategySelector) {
      strategyContext = strategySelector.select({ regime, signalAction: signal.action, adaptiveLearningEngine: adaptiveLearning });
      if (strategyContext.confidenceMultiplier !== 1 && signal.score?.final != null) {
        const tilted = parseFloat((signal.score.final * strategyContext.confidenceMultiplier).toFixed(2));
        log.debug(`${key}: strategy-fit (${strategyContext.profile}) tilting score ${signal.score.final} -> ${tilted}`);
        signal = { ...signal, score: { ...signal.score, final: tilted, strategyTilted: true } };
      }
      const effectiveFloor = Math.max(scorer.minScore ?? 0, strategyContext.minScoreFloor || 0);
      if ((signal.score?.final ?? 0) < effectiveFloor) {
        log.debug(`${key}: below regime-adjusted floor (${effectiveFloor}) for ${strategyContext.profile} — filtered`);
        if (auditTrail) {
          auditTrail.record({ symbol, timeframe, signalFired: false, blockedReason: `below_regime_floor_${strategyContext.profile}`, score: signal.score?.final ?? 0 });
        }
        return;
      }
    }

    // Candle Intelligence: does the most recent candle itself look like a
    // decisive, well-formed bar, or a low-conviction non-event? Attached as
    // context rather than a hard filter — a low candle-quality score on an
    // otherwise well-confirmed multi-agent signal is a caution flag, not
    // an automatic reject.
    let candleContext = null;
    if (candleIntelligence) {
      candleContext = candleIntelligence.analyze({ candles });
    }

    if (!signal || signal.action === 'WAIT' || (signal.score?.final ?? 0) < (scorer.minScore ?? 0)) {
      log.debug(`${key}: filtered post trap/compression check — score=${signal?.score?.final}`);
      if (auditTrail) {
        auditTrail.record({ symbol, timeframe, signalFired: false, blockedReason: 'filtered_post_trap_compression', score: signal?.score?.final ?? 0 });
      }
      return;
    }

    log.info(`[SIGNAL] ${signal.action} ${symbol} @ ${currentPrice} | Score: ${signal.score?.final} | Grade: ${signal.score?.grade}`);

    // FIX: correlationFilter was instantiated but its .check() method was
    // never called — nothing prevented stacking correlated/duplicate/
    // over-limit positions before a signal fired. Wired in here.
    if (correlationFilter?.check) {
      const corrCheck = correlationFilter.check(symbol, signal.action, RISK_PCT);
      if (!corrCheck.allowed) {
        log.debug(`${key}: correlation filter blocked — ${corrCheck.reason}`);
        return;
      }
    }

    // ── Refine entry, build SL/TP, then gate the setup ──
    let fullSignal = {
      ...signal,
      regime,
      compressionContext: compressionContext ? {
        isCompressed: compressionContext.isCompressed,
        compressionScore: compressionContext.compressionScore,
        biasHint: compressionContext.biasHint,
      } : null,
      abnormalMarket: abnormalMarket?.abnormal ? {
        severity: abnormalMarket.severity,
        reasons: abnormalMarket.reasons,
      } : null,
      timeCycle: timeCycleContext,
      strategy: strategyContext ? {
        profile: strategyContext.profile,
        confidenceMultiplier: strategyContext.confidenceMultiplier,
        note: strategyContext.note,
      } : null,
      candleIntelligence: candleContext ? {
        type: candleContext.type,
        qualityScore: candleContext.qualityScore,
        note: candleContext.note,
      } : null,
    };
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

          // FIX: institutionalRiskManager.validateAndSizePosition() was never
          // called anywhere (only .connect() was) — its Kelly/regime/liquidity/
          // portfolio-cap sizing had zero influence on any real trade. It
          // returns its OWN absolute position size in different units than
          // RiskEngine's (accountBalance/currentPrice-based Kelly units vs
          // SL-distance-based risk units), so we don't substitute one for the
          // other — instead we take the *ratio* of its post-checks size to its
          // own pre-checks size (unit-independent, 0..1) and fold that in the
          // same way sessionQuality/drawdownEval already scale down below.
          let institutionalRisk = null;
          let institutionalFactor = 1;
          if (institutionalRiskManager?.validateAndSizePosition) {
            try {
              institutionalRisk = institutionalRiskManager.validateAndSizePosition(signal, currentPrice);
              if (institutionalRisk?.positionSize > 0) {
                const rawRatio = institutionalRisk.adjustedSize / institutionalRisk.positionSize;
                institutionalFactor = Math.max(0, Math.min(1, rawRatio));
              }
            } catch (e) {
              log.warn(`InstitutionalRiskManager sizing error: ${e.message}`);
            }
          }

          // FIX: sessionQuality.multiplier and drawdownEval.sizingFactor were
          // computed above but nothing ever applied them to the actual
          // position size — they were pure dead weight. Fold them in now.
          if (riskEvaluation?.approved && riskEvaluation.positionSize > 0) {
            const combinedFactor =
              (sessionQuality?.multiplier ?? 1) * (drawdownEval?.sizingFactor ?? 1) * institutionalFactor;
            riskEvaluation.institutionalRisk = institutionalRisk ? {
              kellyPercent: institutionalRisk.kellyPercent,
              regimeMultiplier: institutionalRisk.regimeMultiplier,
              liquidityCheck: institutionalRisk.liquidityCheck,
              correlationPenalty: institutionalRisk.correlationPenalty,
              portfolioRiskCapped: institutionalRisk.portfolioRiskCapped || false,
              correlationExposureCapped: institutionalRisk.correlationExposureCapped || false,
              warning: institutionalRisk.warning || null,
              factorApplied: Math.round(institutionalFactor * 100) / 100,
            } : null;
            if (combinedFactor < 1) {
              riskEvaluation.positionSize = riskEvaluation.positionSize * combinedFactor;
              riskEvaluation.sessionMultiplier = sessionQuality?.multiplier ?? 1;
              riskEvaluation.drawdownSizingFactor = drawdownEval?.sizingFactor ?? 1;
              riskEvaluation.note = `${riskEvaluation.note || ''} | Size scaled ${(combinedFactor * 100).toFixed(0)}% (session/drawdown)`;
            }
            // FIX: /api/ea/signals (the MT5 EA polling endpoint) was sending a
            // completely static riskPct straight from an env var — ignoring
            // effectiveRisk (RiskEngine's own correlation/session adjustment)
            // AND the session/drawdown combinedFactor above entirely. That
            // meant every risk-reduction safeguard computed server-side (this
            // session's session-quality gate, drawdown circuit breaker, and
            // the pre-existing correlation reduction) had zero effect on the
            // size of any trade actually placed by the automated MT5 bridge —
            // it only ever affected the position-size TEXT shown to a human
            // via Telegram. finalRiskPct now carries the real, fully-adjusted
            // risk percentage through to that endpoint.
            riskEvaluation.finalRiskPct = Math.round(
              (riskEvaluation.effectiveRisk ?? RISK_PCT) * combinedFactor * 100
            ) / 100;
          }
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

    // Safety net: if the combined session/drawdown/institutional-risk
    // scaling above collapsed positionSize to (near) zero, don't dispatch a
    // signal that risks nothing — institutionalGates has no positionSize
    // check of its own, so without this a 0-size signal could otherwise
    // still reach Telegram/the Mini App/the MT5 EA.
    if (riskEvaluation?.positionSize != null && riskEvaluation.positionSize <= 0) {
      log.warn(`[RISK BLOCK] ${symbol} ${timeframe}: position size scaled to zero (session/drawdown/institutional risk combined)`);
      return;
    }

    // FIX: ExecutionManager (TWAP/VWAP/POV, ~830 lines) was instantiated but
    // getOptimalExecution() had zero call sites — its recommendation never
    // reached a signal or the humans/EA acting on it. This is advisory only:
    // this system dispatches signals (Telegram + MT5 EA polling), it doesn't
    // place orders itself, so there is no live order to "execute" here — we
    // attach the recommended algorithm/slicing so a human or the EA can use
    // it. Only meaningful for symbols with real order-book data (crypto via
    // Bybit); absent for forex symbols, so we don't fabricate a recommendation.
    let executionPlan = null;
    const em = getExecutionManager(symbol);
    if (em && riskEvaluation?.positionSize > 0) {
      try {
        executionPlan = em.getOptimalExecution(symbol, riskEvaluation.positionSize, signal.action);
      } catch (e) {
        log.warn(`ExecutionManager advisory error (${symbol}): ${e.message}`);
      }
    }

    // FIX: intermarket analysis (DXY/equity-index cross-confirmation) — the
    // last item from the original audit's "does not exist" list. Advisory
    // only, matching the pattern above: this is a well-known FX heuristic,
    // not a physical law (see risk-engine/intermarket-analyzer.js), so it
    // informs rather than gates. Logged as a warning on genuine divergence
    // so it's visible without silently blocking a signal that passed every
    // deterministic filter already.
    let intermarketCheck = null;
    if (intermarketAnalyzer) {
      try {
        intermarketCheck = intermarketAnalyzer.checkConfirmation(symbol, signal.action, {
          dxySymbol: DXY_SYMBOL, equitySymbol: EQUITY_INDEX_SYMBOL,
        });
        if (intermarketCheck.available && intermarketCheck.confirmed === false) {
          log.warn(`[INTERMARKET DIVERGENCE] ${symbol} ${signal.action}: ${intermarketCheck.reasons.join('; ')}`);
        }
      } catch (e) {
        log.warn(`IntermarketAnalyzer error (${symbol}): ${e.message}`);
      }
    }

    fullSignal = {
      ...signal,
      tradePlan,
      riskEvaluation,
      entryOptimization,
      gate,
      regime,
      ensemble: ensembleResult,
      executionPlan,
      intermarketCheck,
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

    // ── AI Advisor (agentic layer) ──
    // The one LLM-based check in the pipeline, deliberately placed last —
    // it only ever runs on a signal that has already cleared every
    // deterministic gate (scoring, trap/compression/abnormal-market,
    // regime-fit floor) and has its full entry/SL/TP plan built, so it's
    // reviewing a complete, real setup rather than a partial one. Advisory
    // only: it can say SKIP or REDUCE_SIZE, but it never adjusts risk
    // parameters or touches execution directly, and any error/timeout/
    // missing-key fails OPEN (proceeds as TAKE) rather than blocking a
    // trade on an LLM outage.
    let aiAdvisorVerdict = null;
    if (aiAdvisor) {
      aiAdvisorVerdict = await aiAdvisor.evaluate({
        signal: fullSignal,
        regime,
        strategyContext,
        candleContext,
        compressionContext,
        abnormalMarket,
        timeCycleContext,
        trapContext,
      });
      fullSignal.aiAdvisor = {
        recommendation: aiAdvisorVerdict.recommendation,
        confidence: aiAdvisorVerdict.confidence,
        reasoning: aiAdvisorVerdict.reasoning,
        source: aiAdvisorVerdict.source,
      };
      if (aiAdvisorVerdict.recommendation === 'REDUCE_SIZE') {
        fullSignal.riskFlags = { ...(fullSignal.riskFlags || {}), aiAdvisorReduceSize: true };
        log.info(`${key}: AI Advisor recommends REDUCE_SIZE — ${aiAdvisorVerdict.reasoning}`);
      }
    }

    // ── Signal Explainer (free, no LLM) ──
    // Runs unconditionally — no key, no network, no cost. This is what
    // populates the "why did I get this signal" breakdown in the Mini App
    // and Telegram message even when the paid AI Advisor above is disabled
    // (which it is by default).
    if (signalExplainer) {
      const explanation = signalExplainer.explain({
        signal: fullSignal,
        regime,
        strategyContext,
        candleContext,
        compressionContext,
        abnormalMarket,
        trapContext,
        timeCycleContext,
      });
      fullSignal.explanation = explanation;
    }

    // ── Store in memory ──
    if (memory?.saveSignal) {
      memory.saveSignal(fullSignal).catch(e => log.warn(`Memory save error: ${e.message}`));
    }
    if (mongoStore.saveSignal) {
      mongoStore.saveSignal(fullSignal).catch(e => log.warn(`Mongo signal save error: ${e.message}`));
    }

    // AI Advisor SKIP is checked here — after journaling (so vetoed setups
    // are still visible for review, e.g. "was the advisor right to skip
    // this one?"), but before this signal consumes any risk-model budget
    // or reaches dispatch/execution.
    if (aiAdvisorVerdict?.recommendation === 'SKIP') {
      log.info(`${key}: AI Advisor recommends SKIP — ${aiAdvisorVerdict.reasoning}`);
      if (auditTrail) {
        auditTrail.record({ symbol, timeframe, signalFired: false, blockedReason: 'ai_advisor_skip', score: fullSignal.score?.final ?? 0 });
      }
      return;
    }
    if (auditTrail) {
      auditTrail.record({ symbol, timeframe, signalFired: true, action: fullSignal.action, score: fullSignal.score?.final ?? 0, grade: fullSignal.score?.grade });
    }

    // Track this position in the portfolio-risk model so future correlation
    // and exposure checks (see validateAndSizePosition above) account for it.
    if (institutionalRiskManager?.executePosition) {
      try {
        institutionalRiskManager.executePosition(symbol, riskEvaluation.positionSize, currentPrice, signal.action);
      } catch (e) { log.warn(`InstitutionalRiskManager executePosition error: ${e.message}`); }
    }

    // ── Dispatch to Telegram ──
    // FIX: when ExecutionEngine is active, route through it instead of
    // calling dispatcher.sendSignal() directly — onSignal() calls
    // dispatcher.sendSignal() internally (so the Telegram message is
    // unchanged) but ALSO journals the signal and registers it in
    // ExecutionEngine's own pending-signals map, which is required for the
    // TAKE/WATCH buttons to find it by signalId later. Without this, those
    // buttons would always fail with "signal not found or expired".
    if (executionEngine?.onSignal) {
      await executionEngine.onSignal(fullSignal).catch(e => {
        log.error(`ExecutionEngine dispatch error: ${e.message}`);
      });
    } else if (dispatcher?.sendSignal) {
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

    // FIX: SignalMonitor was instantiated and connected but createSignal() was
    // never called anywhere, so its weakening/reversal-risk tracking never
    // actually monitored any live signal. Register the fired signal here.
    if (signalMonitor?.createSignal && fullSignal.id) {
      signalMonitor.createSignal(fullSignal.id, {
        score: fullSignal.score?.final,
        direction: fullSignal.action || fullSignal.direction,
        symbol: fullSignal.symbol,
        entryPrice: fullSignal.entry?.midpoint,
        stopLoss: fullSignal.stopLoss?.price,
        takeProfit: fullSignal.targets?.tp1?.price,
      }, { timeframe: fullSignal.timeframe });
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

// FIX: agents.sentiment.analyze() was being called with a raw candles ARRAY
// (agents.sentiment.analyze(candles)) where it expects a structured
// { cot, fearGreed, lsRatio, upcomingEvents, social, articles } object.
// Since candles.cot / candles.fearGreed / etc. are all undefined on an
// array, EVERY sub-analyzer inside SentimentAgent (COT, Fear&Greed,
// Long/Short Ratio, Social) was silently disabled — only the NLP news arm
// could ever fire, and only if a working news fetcher was configured. This
// builds the real object instead, including real CFTC COT data.
const _cotCache = {}; // symbol -> { analysis, ts } — CFTC updates weekly, no need to re-fetch every cycle
const _newsCache = {}; // category -> { articles, ts } — Finnhub free tier is rate-limited, cache by asset-class category

async function buildSentimentExternalData(symbol) {
  const data = {};

  if (cftcCotFeed && cotParser) {
    try {
      const cached = _cotCache[symbol];
      const stale = !cached || (Date.now() - cached.ts) > 12 * 3600000;
      let analysis = cached?.analysis;
      if (stale) {
        const rows = await cftcCotFeed.fetchForSymbol(symbol);
        if (rows && rows.length) {
          for (const row of rows) analysis = cotParser.ingest(symbol, row);
          _cotCache[symbol] = { analysis, ts: Date.now() };
        }
      }
      // FIX: COTAnalyzer.analyze() (agents/sentiment-agent.js) destructures
      // `commercials` (plural) from its input, but COTReportParser.analyze()
      // (feeds/cot-report-parser.js) returns the field as `commercial` (singular).
      // Passing the raw analysis straight through would silently zero out
      // the commercial-hedger side of the signal while largeSpec/smallSpec
      // (whose key names happen to match) kept working. Bridge explicitly.
      if (analysis) {
        data.cot = {
          commercials:  { long: analysis.commercial.long, short: analysis.commercial.short },
          largeSpec:    { long: analysis.largeSpec.long,  short: analysis.largeSpec.short },
          smallSpec:    { long: analysis.smallSpec.long,  short: analysis.smallSpec.short },
          openInterest: analysis.openInterest,
        };
      }
    } catch (err) {
      log.debug(`COT fetch failed for ${symbol}: ${err.message}`);
    }
  }

  // FIX: SentimentAgent WAS being called every cycle and DID feed a real vote
  // into signal scoring (macroSent), but its news component was silently
  // dead: index.js never passed `newsApiKey`, so SentimentAgent's internal
  // NewsFetcher always fell through to a neutral synthetic placeholder
  // article — real headlines never reached it, from any source, ever. Also
  // fixed a NaN bug in aggregateArticles() (agents/sentiment-agent.js) that
  // would have silently zeroed out real news scoring anyway even with a key.
  // This system already has a connected FinnhubFeed (used for the economic
  // calendar) with a free market-news endpoint, so reuse it instead of
  // requiring a second, unset API key.
  if (finnhubFeed?.enabled?.()) {
    try {
      const isCrypto = symbol.endsWith('USDT') || symbol.endsWith('USDC') || symbol.endsWith('BTC');
      const category = isCrypto ? 'crypto' : 'forex';
      const cached = _newsCache[category];
      const stale = !cached || (Date.now() - cached.ts) > 15 * 60000;
      let raw = cached?.articles;
      if (stale) {
        raw = await finnhubFeed.marketNews(category);
        _newsCache[category] = { articles: raw, ts: Date.now() };
      }
      if (Array.isArray(raw) && raw.length) {
        // Map Finnhub's {headline, summary, datetime (unix seconds), source,
        // url} shape to what NLPAnalyzer.aggregateArticles() expects.
        data.articles = raw.slice(0, 20).map(a => ({
          title: a.headline,
          description: a.summary,
          content: '',
          source: { name: a.source },
          publishedAt: (a.datetime ? a.datetime * 1000 : Date.now()),
          url: a.url,
        }));
      }
    } catch (err) {
      log.debug(`Finnhub news fetch failed for ${symbol}: ${err.message}`);
    }
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

  // FIX: attach real funding/OI (see bybitFundingOI declaration above) to the
  // candle actually sitting in the store — must happen AFTER the push/replace
  // above, and must mutate `arr[arr.length-1]` (not the raw `candle` param),
  // since a later in-progress update would otherwise overwrite it with a
  // fresh candle object lacking these fields.
  const liveOI = bybitFundingOI[symbol];
  if (liveOI) {
    const target = arr[arr.length - 1];
    if (liveOI.fundingRate != null) target.fundingRate = liveOI.fundingRate;
    if (liveOI.openInterest != null) target.openInterest = liveOI.openInterest;
  }

  // FIX: manual-mode.js's ExecutionEngine needs a live price feed to detect
  // TP/SL/breakeven/trailing hits on manually-tracked positions. Runs on
  // every tick (not gated by isClosed) for timely execution — a position
  // shouldn't have to wait for candle close to register a stop-out.
  // ATR is intentionally omitted for now (only affects the ATR-based
  // trailing-distance branch inside onPrice — core TP/SL/BE detection via
  // Position.onPrice() doesn't require it); a follow-up could source it from
  // the same ATRCalculator sl-tp-engine.js already uses.
  if (executionEngine?.onPrice && candle) {
    try { executionEngine.onPrice(symbol, candle.close, null); }
    catch (e) { log.warn(`ExecutionEngine.onPrice error [${symbol}]: ${e.message}`); }
  }

  // FIX: market_update (the frontend's live price ticker) was gated behind
  // `if (isClosed)` below — meaning it only updated once per candle CLOSE,
  // i.e. once every 15 minutes at best (M15 is the fastest configured
  // timeframe). A user watching the Mini App would see a price sit frozen
  // for up to 15 minutes, which looks exactly like a dead feed rather than
  // a market that ticks every second. This now runs on every tick
  // (isClosed true or false), throttled to ~1/sec per symbol so a busy
  // pair sending many ticks/sec doesn't flood the socket. runAnalysisCycle
  // below stays gated on isClosed — re-running full agent analysis on
  // every raw tick would be far too expensive/noisy; only the price
  // stream needed to be tick-driven, not the analysis.
  if (wsBus && candle) {
    const now = Date.now();
    if (!lastMarketEmit[symbol] || now - lastMarketEmit[symbol] >= 1000) {
      lastMarketEmit[symbol] = now;
      wsBus.emit('market_update', {
        symbol,
        price:  candle.close,
        change: candle.open ? ((candle.close - candle.open) / candle.open * 100) : 0,
        bias:   lastVotes[symbol]?.smc?.direction?.toLowerCase() || 'wait',
      });
    }
  }

  // Only run analysis on closed candles to avoid noise
  if (isClosed) {
    setImmediate(() => runAnalysisCycle(symbol, timeframe));
  }
}

// ── 7. Instantiate singletons ──────────────────────────────────────────────

let dispatcher, scorer, sltp, entryOptimizer, regimeEngine, institutionalGates,
    adaptiveLearning, drawdownGuard, riskEngine, sessionFilter, correlationFilter, memory,
    monteCarlo, bayesianEng, statValidator, walkForward, ensembleEng,
    signalMonitor, institutionalRiskManager, executionManagers, myfxbookFeed, openInsiderFeed,
    finnhubFeed, cftcCotFeed, cotParser, executionEngine, opportunityRanker, relativeStrength,
    dataIntegrityMonitor, intermarketAnalyzer, alphaVantageFeed, fmpFeed;

// FIX: ExecutionManager's MarketMicrostructureAnalyzer keeps a single shared
// orderBookHistory/tradeHistory/spreadHistory with no per-symbol keying — one
// shared instance across multiple crypto symbols would mix BTCUSDT's spread
// with ETHUSDT's order flow. One ExecutionManager per symbol, created lazily.
// FIX: several feeds (Bybit, TwelveData, Myfxbook, OpenInsider) emit errors
// in two different shapes — a raw Error (has .message) from the underlying
// connection, and a { source, error } wrapper from their own parse/poll
// handlers (the real message is nested at .error.message). Naive
// `err.message` access silently produces "undefined" or "[object Object]"
// for the wrapper shape, right when the message is what you need most.
// Shared here so all four feeds extract it the same, correct way.
function feedErrorMessage(err) {
  return err?.error?.message || err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
}

function getExecutionManager(symbol) {
  if (!ExecutionManager) return null;
  if (!executionManagers) executionManagers = new Map();
  if (!executionManagers.has(symbol)) {
    const em = new ExecutionManager();
    em.connect().catch(e => log.warn(`ExecutionManager connect error (${symbol}): ${e.message}`));
    executionManagers.set(symbol, em);
    log.info(`ExecutionManager instantiated for ${symbol}`);
  }
  return executionManagers.get(symbol);
}

function buildSingletons() {
  // AlertDispatcher
  if (AlertDispatcher && BOT_TOKEN) {
    dispatcher = new AlertDispatcher({ token: BOT_TOKEN, chatIds: CHAT_IDS, store: mongoStore });
    log.info(`AlertDispatcher created — ${CHAT_IDS.length} chat(s) + auto-subscribe enabled`);

    // FIX: the /win, /loss, /be Telegram commands emitted 'trade_outcome' but
    // nothing in this file ever listened for it — dispatcher._recordOutcome()
    // sent a confirmation message and recorded the outcome NOWHERE (it called
    // `this.scorer.recordTradeOutcome()`, and `dispatcher.scorer` is never
    // assigned anywhere in this codebase). This is the primary real-world way
    // a manual-mode user reports a trade result, so wire it into the same
    // pipeline /api/outcomes and the record_outcome socket event already use.
    dispatcher.on('trade_outcome', async ({ signalId, outcome, signal }) => {
      if (!recordOutcomeEverywhere) return;
      const result = await recordOutcomeEverywhere({
        signalId, signal, outcome, mongoStore,
        engines: { adaptiveLearning, bayesianEng, walkForward, institutionalGates, sessionFilter, drawdownGuard, institutionalRiskManager, riskEngine },
      });
      if (!result.ok) {
        log.warn(`/${outcome.result?.toLowerCase()} outcome recording failed for ${signalId}: ${result.error}`);
      } else {
        log.info(`Outcome recorded via Telegram command: ${signalId} → ${result.saved.result} (${result.saved.pnlR}R)`);
      }
    });
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

    // FIX: risk_update (the frontend's Session PnL / Circuit Breaker /
    // Sizing display) previously only broadcast from inside the
    // signal-approval code path (see onSignal-adjacent block further down)
    // — meaning risk state, which is a standing system property that
    // exists whether or not any trade has ever happened (circuit breaker
    // status, current sizing factor), never reached the frontend until
    // the first signal was approved. A quiet system with zero approved
    // signals looked completely static even though DrawdownGuard was
    // tracking real state the entire time. Now also broadcasts on a
    // timer, independent of signal activity — the on-approval emission
    // stays as-is for immediate updates right after a trade.
    if (wsBus) {
      const broadcastRiskUpdate = () => {
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
      };
      broadcastRiskUpdate();
      setInterval(broadcastRiskUpdate, 30000); // every 30s, independent of signal activity
    }
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
    // FIX: AlertDispatcher was constructed without `scorer` in its config,
    // so this.scorer was always null in production — silently no-opping the
    // WIN/LOSS/BE handler's scorer.recordTradeOutcome() call and leaving
    // getStats()'s scorer/risk/signals fields permanently empty.
    if (dispatcher) dispatcher.scorer = scorer;
    log.info('SignalScorer created');
  } else {
    log.error('SignalScorer module missing — signals cannot be scored');
  }

  // Getter (not a captured snapshot) so a future /outlook command always
  // reads whatever regimeEngine/candleStores/sessionFilter/cotParser
  // currently hold, regardless of the order the rest of this init
  // sequence assigns them in.
  if (dispatcher) {
    dispatcher.getMarketOutlookDeps = () => ({ regimeEngine, candleStores, sessionFilter, cotParser, symbols: SYMBOLS });
  }

  // FIX: manual-mode.js's ExecutionEngine (~1,700 lines — SignalJournal,
  // RiskEnforcer, PriceMonitor, partial TP/trailing/breakeven tracking) was
  // imported nowhere in the entire codebase. Mode is MANUAL (not SEMI_AUTO):
  // no exchange orders are placed — that's what the MT5 EA bridge is for.
  // This purely tracks trades a person takes manually off the Telegram
  // signal, with real price-driven TP/SL/BE/trail detection instead of the
  // WIN/LOSS/BE buttons' guessed R-multiples.
  if (ExecutionEngine && dispatcher) {
    executionEngine = new ExecutionEngine({
      mode: 'MANUAL',
      dispatcher,
      drawdownGuard,
      maxOpenPositions: 5,
      maxRiskPct: RISK_PCT * 3, // hard ceiling across all concurrently-tracked manual positions
      sendJournalDaily: true,
    });
    dispatcher.executionEngine = executionEngine; // consumed by _handleCallback's TAKE/WATCH cases

    // FIX: real, computed P&L from actual price action — closing this loop
    // properly is what the WIN/LOSS/BE buttons could never do (they only
    // ever recorded a placeholder R-multiple). Feed the SAME comprehensive
    // outcome pipeline used by /api/outcomes and the WIN/LOSS/BE fix above.
    executionEngine.on('position_closed', async ({ position, outcome }) => {
      if (!recordOutcomeEverywhere) return;
      try {
        // FIX: fetch the actual full stored signal (matching the pattern
        // /api/outcomes already uses) instead of reconstructing a minimal
        // one from Position's own limited fields — adaptiveLearning.
        // recordOutcome()'s fingerprint() needs entry/tradePlan/riskEvaluation
        // fields that Position doesn't carry.
        const recent = await mongoStore.getRecentSignals?.({ limit: 200 }).catch(() => []);
        const signal = (recent || []).find(s => s.id === position.signalId) || {
          id: position.signalId, symbol: position.symbol, regime: position.regime,
          session: position.session, score: { grade: position.grade },
        };

        const liveEngines = require('./api/realtime').getEngines();
        // FIX: refactored to use the shared recordOutcomeEverywhere utility
        // instead of hand-rolled duplicate calls — picks up
        // institutionalRiskManager.recordTradeResult() and
        // riskEngine.recordTrade() (feeds the Kelly Criterion overlay) which
        // this listener was originally missing, and gets cross-path
        // idempotency for free via mongoStore.getTradeOutcome() (e.g. if
        // this same signal was somehow also WIN/LOSS/BE-tapped).
        // drawdownGuard is deliberately OMITTED from the engines object here:
        // ExecutionEngine._handlePositionClosed() already calls
        // this._dd.record() directly with the real outcome (see
        // manual-mode.js) — including it here would double-count this
        // trade's PnL in the circuit breaker's daily total.
        const { drawdownGuard: _omit, ...engines } = liveEngines;
        const result = await recordOutcomeEverywhere({
          signalId: position.signalId, signal, outcome, mongoStore, engines,
        });
        if (!result.ok && result.error !== 'Outcome already recorded for this signal') {
          log.warn(`Manual-mode outcome recording failed for ${position.signalId}: ${result.error}`);
        }
      } catch (err) {
        log.warn(`Manual-mode outcome pipeline error: ${err.message}`);
      }
    });

    log.info('ExecutionEngine created (MANUAL mode) — Take/Watch buttons active');
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

  if (OpportunityRanker) {
    opportunityRanker = new OpportunityRanker({ staleAfterMs: 15 * 60 * 1000 });
    log.info('OpportunityRanker created — watchlist scoreboard active');
  }

  if (RelativeStrengthEngine) {
    relativeStrength = new RelativeStrengthEngine({ lookback: 20 });
    log.info('RelativeStrengthEngine created');
  }

  if (DataIntegrityMonitor) {
    dataIntegrityMonitor = new DataIntegrityMonitor({ staleFactor: 3 });
    log.info('DataIntegrityMonitor created');
  }

  if (IntermarketAnalyzer) {
    intermarketAnalyzer = new IntermarketAnalyzer({ lookback: 10 });
    log.info('IntermarketAnalyzer created (DXY/equity-index cross-confirmation, advisory only)');
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
      // FIX: useKelly defaulted to false and _performanceStats had zero real
      // trade data feeding it (recordTrade() existed with no call sites) —
      // now wired via signal-pipeline/outcome-recorder.js. Safe to enable:
      // the Kelly overlay only ever REDUCES size below the ATR-based amount
      // (see position-sizer.js ~line 465 — `if (kellySize < sizing.units)`),
      // never increases it, and stays inactive until 10+ real trades exist.
      useKelly:       true,
      // FIX: without this, DrawdownGuard's circuit breaker never actually
      // influenced position sizing/approval — see position-sizer.js.
      drawdownGuard,
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
    // FIX: without this handler, SignalMonitor's periodic check_signal ticks
    // had nothing to act on — no market data was ever fed back in, so
    // weakening/reversal detection could never actually fire.
    signalMonitor.on('check_signal', ({ signalId }) => {
      const status = signalMonitor.getSignalStatus(signalId);
      const meta = status?.metadata;
      if (!meta?.symbol) return;
      const tf = meta.timeframe || TIMEFRAMES_STR[0];
      const candles = candleStores[meta.symbol]?.[tf];
      if (!candles || candles.length < 2) return;

      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const priceDirection = last.close >= prev.close ? 'bullish' : 'bearish';
      const volumeConfirmation = Number(last.volume || 0) >= Number(prev.volume || 0);

      signalMonitor.updateSignal(signalId, {
        priceConfirmation: true,
        priceDirection,
        volumeConfirmation,
        regime: lastVotes[meta.symbol]?.smc?.direction || null,
      });
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

  // Execution Manager - TWAP/VWAP/POV execution algorithms (one per symbol — see getExecutionManager)
  if (ExecutionManager) {
    executionManagers = new Map();
    log.info('ExecutionManager factory ready (TWAP, VWAP, POV algorithms) — instantiated per crypto symbol as order-book data arrives');
  }

  // Myfxbook Feed - Economic calendar and community sentiment
  if (MyfxbookFeed && process.env.MYFXBOOK_EMAIL && process.env.MYFXBOOK_PASSWORD) {
    myfxbookFeed = new MyfxbookFeed({
      email: process.env.MYFXBOOK_EMAIL,
      password: process.env.MYFXBOOK_PASSWORD,
      pollIntervalMs: 5 * 60000,
    });
    // FIX: this feed emits 'error' (feeds/myfxbook-feed.js — connection and
    // poll failures) but had NO listener registered anywhere. Node's
    // EventEmitter throws synchronously when an 'error' event has zero
    // listeners — confirmed directly, not assumed. This process does have a
    // global process.on('uncaughtException') safety net (setupShutdown()
    // below) that would prevent a hard crash, but relying on that loses all
    // diagnostic context (which feed, what actually failed) and Node's own
    // docs explicitly warn against treating that as safe to keep running on.
    myfxbookFeed.on('error', (err) => log.error(`MyfxbookFeed error: ${feedErrorMessage(err)}`));
    myfxbookFeed.on('economic_surprise', (data) => {
      log.info(`[Myfxbook] Economic surprise: ${data.event.name} - ${data.impact}`);
      dispatcher?.sendMessage?.(`📊 *Economic Surprise*\n${data.event.name}\nImpact: ${data.impact}\nCurrencies: ${data.affectedCurrencies.join(', ')}`)?.catch(() => {});
      // FIX: this event only ever reached Telegram — the web/Mini App
      // frontend had zero visibility into institutional flow data despite
      // the backend fully computing it. Relay to the live dashboard too.
      wsBus?.emit('intel', { kind: 'economic_surprise', ...data, timestamp: Date.now() });
    });
    myfxbookFeed.on('extreme_retail_positioning', (data) => {
      log.warn(`[Myfxbook] Extreme retail positioning: ${data.symbol} - ${data.data.contrarianReason}`);
      wsBus?.emit('intel', { kind: 'extreme_retail_positioning', ...data, timestamp: Date.now() });
    });
    myfxbookFeed.on('upcoming_events', (data) => {
      log.info(`[Myfxbook] ${data.count} high-impact events upcoming`);
      wsBus?.emit('intel', { kind: 'upcoming_events', ...data, timestamp: Date.now() });
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
    // FIX: same missing-listener issue as myfxbookFeed above — this feed
    // emits 'error' (feeds/openinsider-feed.js — connection and poll
    // failures) with nothing listening for it anywhere.
    openInsiderFeed.on('error', (err) => log.error(`OpenInsiderFeed error: ${feedErrorMessage(err)}`));
    openInsiderFeed.on('cluster_buy', (data) => {
      log.info(`[OpenInsider] Cluster buy detected: ${data.ticker} - ${data.insiderCount} insiders`);
      dispatcher?.sendMessage?.(`💼 *Cluster Buy*\n${data.ticker}\n${data.insiderCount} insiders in ${data.windowDays} days\nConfidence: ${data.confidence}%`)?.catch(() => {});
      wsBus?.emit('intel', { kind: 'cluster_buy', ...data, timestamp: Date.now() });
    });
    openInsiderFeed.on('executive_activity', (data) => {
      log.info(`[OpenInsider] Executive activity: ${data.ticker} - ${data.signal}`);
      wsBus?.emit('intel', { kind: 'executive_activity', ...data, timestamp: Date.now() });
    });
    log.info('OpenInsiderFeed created');
  }

  // Alpha Vantage Feed - macro news sentiment
  if (AlphaVantageFeed) {
    alphaVantageFeed = new AlphaVantageFeed({});
    if (alphaVantageFeed.enabled()) {
      // Same convention as myfxbookFeed/openInsiderFeed above — an
      // unhandled 'error' event on an EventEmitter crashes the process.
      alphaVantageFeed.on('error', (err) => log.error(`AlphaVantageFeed error: ${feedErrorMessage(err)}`));
      alphaVantageFeed.on('sentiment_shift', (data) => {
        log.info(`[AlphaVantage] Macro sentiment shifted to ${data.label} (${data.score}, ${data.articleCount} articles)`);
        dispatcher?.sendMessage?.(`🗞️ *Macro Sentiment: ${data.label}*\nScore: ${data.score}\n${data.topHeadline || ''}`)?.catch(() => {});
        wsBus?.emit('intel', { kind: 'news_sentiment', ...data, timestamp: Date.now() });
      });
      log.info('AlphaVantageFeed created — macro news sentiment polling active');
    } else {
      log.warn('AlphaVantageFeed disabled - missing ALPHA_VANTAGE_API_KEY');
    }
  }

  // FIX: FinnhubFeed existed but was never instantiated anywhere, and its
  // economic-calendar data (added alongside this fix) was the missing real
  // data source for sessionFilter's EconomicCalendarTierSystem — that gate
  // was fully built and (as of an earlier fix this session) correctly
  // consulted before every trade, but nothing ever fed it real events, so it
  // silently reported "CLEAR" 100% of the time. Poll it periodically here.
  // FIX: this poll used to run only when Finnhub was configured, meaning
  // sessionFilter's EconomicCalendarTierSystem gate had zero real event
  // awareness whenever FINNHUB_API_KEY was unset (or Finnhub had an outage
  // or hit its quota) — a single point of failure feeding a safety-critical
  // blackout gate. FMPFeed (feeds/fmp-feed.js) is a second, independent
  // source normalized to the identical shape; either feed alone is enough
  // to keep the gate fed, and having both gives real redundancy instead of
  // a silent single point of failure.
  if (FinnhubFeed) finnhubFeed = new FinnhubFeed({ apiKey: process.env.FINNHUB_API_KEY || '' });
  if (FMPFeed)     fmpFeed     = new FMPFeed({ apiKey: process.env.FMP_API_KEY || '' });

  if (finnhubFeed?.enabled() || fmpFeed?.enabled()) {
    const pollEconomicCalendar = async () => {
      const raw = [];
      if (finnhubFeed?.enabled()) {
        try { raw.push(...await finnhubFeed.economicCalendar()); }
        catch (err) { log.warn(`Finnhub economic calendar poll failed: ${err.message}`); }
      }
      if (fmpFeed?.enabled()) {
        try { raw.push(...await fmpFeed.economicCalendar()); }
        catch (err) { log.warn(`FMP economic calendar poll failed: ${err.message}`); }
      }
      // Dedupe: same currency + same normalized name within a 30-minute
      // window counts as one release reported by two providers, not two.
      const events = [];
      for (const e of raw) {
        const key = e.name.toLowerCase().replace(/[^a-z]/g, '');
        const dup = events.find(x =>
          x.currency === e.currency && Math.abs(x.time - e.time) < 30 * 60000 &&
          x.name.toLowerCase().replace(/[^a-z]/g, '') === key
        );
        if (!dup) events.push(e);
      }
      try {
        if (sessionFilter?.addNewsEvents && events.length) {
          // FIX: only use a provider's impact rating to PROMOTE an event that
          // none of EconomicCalendarTierSystem._inferTier's own name-regexes
          // would catch — never to override/downgrade a name that's already
          // correctly recognized. Mirrors _inferTier's tier1/tier2/tier3
          // patterns so a same-tier or higher inference always wins.
          const TIER1_RE = /nfp|non.?farm|fomc|cpi|rate decision|interest rate/i;
          const TIER2_RE = /gdp|pmi|retail sales|unemployment/i;
          const TIER3_RE = /building permit|confidence|trade balance/i;
          sessionFilter.addNewsEvents(events.map(e => ({
            name: e.name,
            currency: e.currency,
            time: e.time,
            tier: TIER1_RE.test(e.name) || TIER2_RE.test(e.name) || TIER3_RE.test(e.name)
              ? undefined // let _inferTier's own regex classify it
              : e.impact === 'high'   ? 'TIER_2'
              : e.impact === 'medium' ? 'TIER_3'
              : undefined, // stays TIER_4 via _inferTier's default
          })));
        }
        const src = [finnhubFeed?.enabled() ? 'Finnhub' : null, fmpFeed?.enabled() ? 'FMP' : null].filter(Boolean).join('+');
        log.info(`EconomicCalendar: ${events.length} events loaded for the next 7 days (${src})`);
      } catch (err) {
        log.warn(`EconomicCalendar addNewsEvents failed: ${err.message}`);
      }
    };
    pollEconomicCalendar();
    setInterval(pollEconomicCalendar, 4 * 3600000); // every 4 hours
  }
  log.info(finnhubFeed?.enabled() ? 'FinnhubFeed created — economic calendar polling active' : 'FinnhubFeed disabled - missing FINNHUB_API_KEY');
  log.info(fmpFeed?.enabled() ? 'FMPFeed created — economic calendar polling active (redundant source)' : 'FMPFeed disabled - missing FMP_API_KEY');

  // FIX: real COT (Commitment of Traders) data — CFTCCotFeed and
  // COTReportParser were fully built but nothing anywhere fetched real CFTC
  // data or fed it to them. Free public API, no key required, updates
  // weekly (Fridays ~15:30 ET). See buildSentimentExternalData() below for
  // how this gets bridged into SentimentAgent's expected shape.
  if (CFTCCotFeed && COTReportParser) {
    cftcCotFeed = new CFTCCotFeed();
    cotParser = new COTReportParser();
    log.info(`CFTCCotFeed created — supports: ${cftcCotFeed.supportedSymbols().join(', ')}`);
  }

  // FIX: publish the live singleton instances so api/server.js's /api/outcomes
  // handler can record real trade outcomes into the SAME objects this pipeline
  // actually consults during scoring — see api/realtime.js for the full story.
  try {
    require('./api/realtime').setEngines({
      adaptiveLearning, bayesianEng, walkForward, institutionalGates,
      drawdownGuard, sessionFilter, riskEngine, institutionalRiskManager,
      opportunityRanker, relativeStrength, dataIntegrityMonitor, executionEngine,
      auditTrail, symbolManager, cotParser, memory,
      // For GET /api/outlook (signal-pipeline/market-outlook.js)
      regimeEngine, candleStores, symbols: SYMBOLS,
    });
    log.info('Live engine singletons published for outcome-feedback wiring');
  } catch (err) {
    log.error(`Failed to publish engine registry — API endpoints (watchlist, journal, health, audit-trail, etc) will serve stale or empty data: ${err.message}`);
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
    binanceFeed.on('error', (err) => log.error(`BinanceFeed error: ${feedErrorMessage(err)}`));
    binanceFeed.on('connected', () => log.info(`BinanceFeed connected for: ${cryptoSymbols.join(', ')}`));
    feeds.push({ name: 'BinanceFeed', instance: binanceFeed, symbols: cryptoSymbols });
    log.info(`BinanceFeed configured for: ${cryptoSymbols.join(', ')}`);
    if (dataIntegrityMonitor) dataIntegrityMonitor.registerFeed('BinanceFeed', binanceFeed, cryptoSymbols);
  }

  // FIX: BybitFeed (funding rate, open interest, liquidation cascades, CVD —
  // 971 lines) was never instantiated anywhere. BinanceFeed already handles
  // crypto candles, so this deliberately does NOT listen to BybitFeed's
  // 'candle'/'candle_update' events (that would just be redundant duplicate
  // candle ingestion) — only the funding/OI/liquidation side channel, which
  // feeds bybitFundingOI so onCandle() can attach real values to candles for
  // VolumeOIAgent's pre-existing (previously always-zero) reads.
  if (BybitFeed && cryptoSymbols.length) {
    const bybitFeed = new BybitFeed({
      symbols: cryptoSymbols,
      timeframes: TIMEFRAMES_STR,
      liquidations: true,
      // FIX: ExecutionManager (TWAP/VWAP/POV) was instantiated but never
      // consulted — its MarketMicrostructureAnalyzer needs real L2 order book
      // depth and a trade tape, neither of which was ever streamed anywhere
      // in this codebase (BybitFeed supports both but they were off by
      // default). Enabling here is what makes execution advisory real instead
      // of permanently blind (spread=0, imbalance=0 → always "optimal").
      orderBook: true,
      trades: true,
    });
    bybitFeed.on('open_interest', (analysis) => {
      const sym = analysis.symbol;
      if (!bybitFundingOI[sym]) bybitFundingOI[sym] = {};
      bybitFundingOI[sym].openInterest = analysis.oiValue ?? analysis.value ?? null;
    });
    bybitFeed.on('price', ({ symbol }) => {
      const rate = bybitFeed.funding?._rates?.get(symbol)?.current;
      if (rate != null) {
        if (!bybitFundingOI[symbol]) bybitFundingOI[symbol] = {};
        bybitFundingOI[symbol].fundingRate = rate;
      }
    });
    bybitFeed.on('liquidation_cascade', (data) => {
      log.warn(`Bybit liquidation cascade: ${data.alert}`);
      if (wsBus) wsBus.emit('liquidation_cascade', data);
    });
    // FIX: feed the per-symbol ExecutionManager's microstructure analyzer with
    // real order book depth (converting Bybit's [price, qty] tuples to the
    // {price, quantity} shape MarketMicrostructureAnalyzer expects) and the
    // live trade tape. Without this, getOptimalExecution() has no real data.
    bybitFeed.on('orderbook', (snapshot) => {
      const em = getExecutionManager(snapshot.symbol);
      if (!em) return;
      em.updateOrderBook({
        bids: snapshot.bids.map(([price, quantity]) => ({ price, quantity })),
        asks: snapshot.asks.map(([price, quantity]) => ({ price, quantity })),
      });
    });
    bybitFeed.on('tick', (trade) => {
      const em = getExecutionManager(trade.symbol);
      if (!em) return;
      em.addTrade({ price: trade.price, quantity: trade.size, timestamp: trade.timestamp });
    });
    bybitFeed.on('error', (err) => log.error(`BybitFeed error: ${feedErrorMessage(err)}`));
    bybitFeed.on('connected', () => log.info(`BybitFeed connected for: ${cryptoSymbols.join(', ')}`));
    feeds.push({ name: 'BybitFeed', instance: bybitFeed, symbols: cryptoSymbols });
    log.info(`BybitFeed configured for: ${cryptoSymbols.join(', ')}`);
    if (dataIntegrityMonitor) dataIntegrityMonitor.registerFeed('BybitFeed', bybitFeed, cryptoSymbols);
  }

  // TwelveData feed for forex/commodities
  if (TwelveDataFeed && fxSymbols.length && TWELVE_KEY) {
    // FIX: DXY/equity-index candles must NOT go through onCandle() — it
    // early-returns for any symbol not in the tradeable SYMBOLS list, so a
    // macro symbol added there would be silently discarded, not analyzed.
    // Subscribe them separately and route explicitly to intermarketAnalyzer.
    const macroSymbols = intermarketAnalyzer ? [DXY_SYMBOL, EQUITY_INDEX_SYMBOL] : [];
    const tdSymbols = [...new Set([...fxSymbols, ...macroSymbols])];

    const tdFeed = new TwelveDataFeed({
      apiKey:     TWELVE_KEY,
      symbols:    tdSymbols,
      timeframes: TIMEFRAMES_STR,
    });
    tdFeed.on('candle',        (d) => macroSymbols.includes(d.symbol) ? intermarketAnalyzer.updatePrice(d.symbol, d.candle.close, d.candle.timestamp || Date.now()) : onCandle(d));
    tdFeed.on('candle_update', (d) => macroSymbols.includes(d.symbol) ? intermarketAnalyzer.updatePrice(d.symbol, d.candle.close, d.candle.timestamp || Date.now()) : onCandle(d));
    tdFeed.on('price',         (d) => macroSymbols.includes(d.symbol) && intermarketAnalyzer.updatePrice(d.symbol, d.price, d.timestamp || Date.now()));
    tdFeed.on('error', (err) => log.error(`TwelveData error: ${feedErrorMessage(err)}`));
    tdFeed.on('connected', () => log.info(`TwelveDataFeed connected for: ${tdSymbols.join(', ')}`));
    feeds.push({ name: 'TwelveDataFeed', instance: tdFeed, symbols: fxSymbols });
    log.info(`TwelveDataFeed configured for: ${fxSymbols.join(', ')}${macroSymbols.length ? ` (+ macro: ${macroSymbols.join(', ')})` : ''}`);
    if (dataIntegrityMonitor) dataIntegrityMonitor.registerFeed('TwelveDataFeed', tdFeed, fxSymbols);
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

  // i. Execution manager instances are created lazily per crypto symbol as
  // order-book data arrives (see getExecutionManager) — nothing to connect here.

  if (connected === 0 && feeds.length > 0) {
    log.error('No feeds connected — check your API keys and network connection');
  }

  if (feeds.length === 0) {
    log.warn('No feeds configured. Add BINANCE_API_KEY and/or TWELVE_DATA_API_KEY to .env');
    log.info('Running in dry-run mode — use the test script to inject synthetic candles');
  }

  // j. Data integrity watchdog — was previously nothing here at all: a feed
  // that stopped pushing candles without firing an 'error' event (dropped
  // WS connection, exchange outage) would silently keep the pipeline
  // scoring against stale, non-moving candles with no log line and no
  // alert. Checked every 2 minutes; first check delayed 90s to let feeds
  // finish their initial connect/backfill.
  if (dataIntegrityMonitor) {
    const runIntegrityCheck = () => {
      const report = dataIntegrityMonitor.check(candleStores);
      if (!report.ok) {
        for (const f of report.feeds.filter(x => x.connected === false)) {
          log.warn(`DataIntegrity: ${f.name} reports disconnected (symbols: ${f.symbols.join(', ')})`);
        }
        for (const s of report.staleSeries) {
          log.warn(`DataIntegrity: ${s.symbol} ${s.timeframe} stale — last candle ${Math.round(s.ageMs / 1000)}s ago (threshold ${Math.round(s.thresholdMs / 1000)}s)`);
        }
      }
      if (wsBus) wsBus.emit('feed_health', report);
    };
    setTimeout(() => {
      runIntegrityCheck();
      setInterval(runIntegrityCheck, 2 * 60000);
    }, 90000);
    log.info('DataIntegrityMonitor watchdog scheduled (every 2m, first check at +90s)');
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
