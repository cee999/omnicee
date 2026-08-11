'use strict';

try { require('dotenv').config(); } catch (_) { }

// FIX: index.js never required db.js at all before — only api/server.js did.
const db = require('./db');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const log = {
  debug: (...a) => LOG_LEVEL === 'debug' && console.log('[DEBUG]', ...a),
  info:  (...a) => ['debug','info'].includes(LOG_LEVEL) && console.log('[INFO] ', ...a),
  warn:  (...a) => console.warn('[WARN] ', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

// Validate critical env vars

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
const SYMBOLS         = (requireEnv('SYMBOLS', 'XAUUSD,BTCUSDT,ETHUSDT,EURUSD,GBPUSD,USDJPY,USOIL,UUP') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TIMEFRAMES_STR  = (requireEnv('TIMEFRAMES', 'H1,H4') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const MIN_SCORE       = parseFloat(requireEnv('MIN_SIGNAL_SCORE', '65'));
const RISK_PCT        = parseFloat(requireEnv('RISK_PCT_PER_TRADE', '1.0'));
const MAX_DAILY_LOSS  = parseFloat(requireEnv('MAX_DAILY_LOSS_PCT', '3.0'));
const MAX_DRAWDOWN    = parseFloat(requireEnv('MAX_DRAWDOWN_PCT', '10.0'));
const ACCOUNT_BALANCE = parseFloat(requireEnv('ACCOUNT_BALANCE', '10000'));
const REQUIRE_KZ      = requireEnv('REQUIRE_KILLZONE', 'false') === 'true';
const SIGNAL_SOFT_GATES = requireEnv('SIGNAL_SOFT_GATES', 'true') !== 'false';
// FIX: intermarket analysis (DXY/equity cross-confirmation) — the last item on the original audit's "does not exist" list.
const DXY_SYMBOL          = process.env.DXY_SYMBOL          || 'UUP';
const EQUITY_INDEX_SYMBOL = process.env.EQUITY_INDEX_SYMBOL || 'SPY';

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
const { HurstAnalysisEngine }= loadModule('./signal-pipeline/hurst-analysis',    'HurstAnalysisEngine') || {};
const { DrawdownGuard }      = loadModule('./risk-engine/drawdown-guard',        'DrawdownGuard')     || {};
const { RiskEngine }         = loadModule('./risk-engine/position-sizer',        'RiskEngine')        || {};
const { SessionFilter }      = loadModule('./risk-engine/session-filter',        'SessionFilter')     || {};
const { CorrelationFilter }  = loadModule('./risk-engine/correlation',           'CorrelationFilter') || {};
const { ConflictResolver: ConflictResolverClass } = loadModule('./orchestrator/conflict-resolver', 'ConflictResolver') || {};
const { MemoryManager }      = loadModule('./orchestrator/memory-manager',       'MemoryManager')     || {};
const { SignalMonitor }      = loadModule('./signal-pipeline/signal-monitor',     'SignalMonitor')     || {};
const { InstitutionalRiskManager } = loadModule('./risk-engine/institutional-risk-manager', 'InstitutionalRiskManager') || {};
const { MyfxbookFeed }       = loadModule('./feeds/myfxbook-feed',               'MyfxbookFeed')      || {};
const { OpenInsiderFeed }    = loadModule('./feeds/openinsider-feed',            'OpenInsiderFeed')   || {};
const { AlphaVantageFeed }   = loadModule('./feeds/alpha-vantage-feed',          'AlphaVantageFeed')  || {};
const { FinnhubFeed }        = loadModule('./feeds/finnhub-feed',                'FinnhubFeed')       || {};
const { FMPFeed }            = loadModule('./feeds/fmp-feed',                    'FMPFeed')           || {};
const { ForexFactoryCalendar } = loadModule('./feeds/forex-factory-calendar',   'ForexFactoryCalendar') || {};
const { DerivFeed }            = loadModule('./feeds/deriv-feed',               'DerivFeed')            || {};
const { CryptoVolatilityAlert } = loadModule('./feeds/crypto-volatility-alert', 'CryptoVolatilityAlert') || {};
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

const conflictResolver = ConflictResolverClass ? new ConflictResolverClass() : null;

const trapDetector        = TrapDetector        ? new TrapDetector()        : null;
const compressionDetector = CompressionDetector ? new CompressionDetector() : null;
const abnormalMarketDetector = AbnormalMarketDetector ? new AbnormalMarketDetector() : null;
const cryptoVolAlert = CryptoVolatilityAlert
  ? new CryptoVolatilityAlert({
      symbols: (SYMBOLS || []).filter(s =>
        /USDT$|USDC$|BTC|ETH|XAUUSD|^GOLD$/i.test(s)
      ),
    })
  : null;
const timeCycleEngine     = TimeCycleEngine     ? new TimeCycleEngine()     : null;
const strategySelector    = StrategySelector    ? new StrategySelector()    : null;
const candleIntelligence  = CandleIntelligence  ? new CandleIntelligence()  : null;
const aiAdvisor = AIAdvisor ? new AIAdvisor({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
if (aiAdvisor) {
  log.info(aiAdvisor.enabled
    ? `AI Advisor active (model=${aiAdvisor.model}) — advisory-only, fails open on any error`
    : 'AI Advisor loaded but disabled — ANTHROPIC_API_KEY not set in .env');
}
const symbolManager = SymbolManager ? new SymbolManager({ symbols: SYMBOLS }) : null;

const auditTrail = AuditTrail ? new AuditTrail() : null;

const candleStores = {};
// BybitFeed (which has a fully-built funding/OI engine) was never even instantiated anywhere.
const bybitFundingOI = {};
const lastMarketEmit = {};

const agentPool = {};

const lastVotes = {};

const inFlight = new Set();
/** Live analysis throttle state */
const lastAnalysisAt = new Map();   // key → last run ms
const lastAnalysisScore = new Map(); // key → last final score (0–100)
const lastTickAt = new Map();        // symbol → last accepted tick ms
let engineReadyEmitted = false;
let bootStartAt = Date.now();
const BOOT_GRACE_MS = Number(process.env.BOOT_GRACE_MS || 60000); // first 60s: relaxed requirements

// Load persisted candles + last-market cache so cold-starts have immediate data
try {
  const persist = require('./lib/persist');
  const persisted = persist.loadCandles();
  if (persisted && typeof persisted === 'object') {
    // persisted expected shape: { candleStores: { symbol: { tf: [...] } }, lastPrices: { symbol: { price, bid, ask, source, ts } } }
    if (persisted.candleStores) {
      Object.assign(candleStores, persisted.candleStores);
      log.info('Loaded persisted candleStores — symbols:', Object.keys(persisted.candleStores).length);
    }
    if (persisted.lastPrices) {
      for (const [s, v] of Object.entries(persisted.lastPrices)) {
        lastPriceBySymbol[s] = v;
      }
      log.info('Loaded persisted last prices — symbols:', Object.keys(persisted.lastPrices).length);
    }
  }
} catch (e) { log.debug('No persisted state loaded'); }
const LIVE_ANALYSIS_INTERVAL_MS = Number(process.env.ANALYSIS_INTERVAL_MS || 45000);
const ADAPTIVE_THROTTLE = process.env.ADAPTIVE_THROTTLE !== 'false'; // default ON

/**
 * Adaptive throttle interval (ms) per symbol:timeframe.
 * Fast when: high volatility, killzone session, near minScore, active ticks.
 * Slow when: quiet range, off-hours, cold start with thin data, system busy.
 */
function getAdaptiveAnalysisIntervalMs(symbol, timeframe) {
  const key = `${symbol}:${timeframe}`;
  // Floor / ceiling (env overrides)
  const floorMs = Number(process.env.LIVE_ANALYSIS_MIN_MS || 8000);   // never faster than 8s
  const ceilMs  = Number(process.env.LIVE_ANALYSIS_MAX_MS || 120000); // never slower than 2m

  if (!ADAPTIVE_THROTTLE) {
    return Number(process.env.LIVE_ANALYSIS_MIN_MS || 20000);
  }

  let ms = 30000; // baseline 30s

  // 1) Session quality (UTC)
  const utcHour = new Date().getUTCHours();
  const utcDay = new Date().getUTCDay();
  const isWeekend = utcDay === 0 || utcDay === 6;
  const isCrypto = /USDT|USDC|BTC$|ETH$/.test(symbol);
  if (utcHour >= 13 && utcHour < 16) ms *= 0.55;       // London/NY overlap — hottest
  else if (utcHour >= 8 && utcHour < 13) ms *= 0.7;    // London
  else if (utcHour >= 16 && utcHour < 21) ms *= 0.75;  // NY
  else if (utcHour >= 0 && utcHour < 8) ms *= 1.25;    // Asia
  else ms *= 1.5;                                       // thin / rollover
  if (isWeekend && !isCrypto) ms *= 1.6;              // FX weekend dead

  // 2) Realized volatility from last ~20 bars (range/close)
  const candles = candleStores[symbol]?.[timeframe];
  if (candles && candles.length >= 10) {
    const slice = candles.slice(-20);
    let sum = 0;
    for (const c of slice) {
      const mid = (Number(c.high) + Number(c.low)) / 2 || Number(c.close) || 0;
      if (mid > 0) sum += (Number(c.high) - Number(c.low)) / mid;
    }
    const avgRange = sum / slice.length;
    if (avgRange > 0.004) ms *= 0.5;       // very active
    else if (avgRange > 0.002) ms *= 0.7;  // active
    else if (avgRange < 0.0006) ms *= 1.5; // quiet
  }

  // 3) Near-miss: last score close to fire threshold → check more often
  const score = lastAnalysisScore.get(key);
  if (score != null) {
    const gap = MIN_SCORE - score;
    if (score >= MIN_SCORE) ms *= 0.6;          // already firing zone — stay tight
    else if (gap <= 8) ms *= 0.55;              // very near miss
    else if (gap <= 15) ms *= 0.75;             // near miss
    else if (score < 30) ms *= 1.2;             // cold / no setup
  }

  // 4) Tick velocity: fresh ticks → slightly faster
  const tickAge = Date.now() - (lastTickAt.get(symbol) || 0);
  if (tickAge < 3000) ms *= 0.85;
  else if (tickAge > 60000) ms *= 1.3; // stale feed

  // 5) System load: many in-flight analyses → back off
  if (inFlight.size >= 4) ms *= 1.5;
  else if (inFlight.size >= 2) ms *= 1.15;

  // 6) Reason boost applied by caller via multiplier on return — clamp here
  ms = Math.max(floorMs, Math.min(ceilMs, Math.round(ms)));
  return ms;
}

/**
 * Schedule analysis like a live chart: on ticks + heartbeat, with adaptive gaps.
 */
function scheduleLiveAnalysis(symbol, reason = 'tick') {
  if (!SYMBOLS.includes(symbol)) return;
  if (reason === 'tick' || reason === 'mt5_ea' || reason === 'deriv') {
    lastTickAt.set(symbol, Date.now());
  }
  for (const tf of TIMEFRAMES_STR) {
    const key = `${symbol}:${tf}`;
    const n = candleStores[symbol]?.[tf]?.length || 0;
    let minBars = SIGNAL_SOFT_GATES ? 40 : 50;
    // During initial boot grace period, allow fewer bars so signals can seed faster
    if (reason === 'boot' && (Date.now() - bootStartAt) < BOOT_GRACE_MS) {
      minBars = Math.min(8, minBars);
    }
    if (n < minBars) continue;
    if (inFlight.has(key)) continue;

    let needMs = getAdaptiveAnalysisIntervalMs(symbol, tf);
    // Event urgency
    if (reason === 'boot' || reason === 'seed') needMs = Math.min(needMs, 5000);
    if (reason === 'close' || reason === 'bar_close') needMs = Math.min(needMs, 8000);
    if (reason === 'heartbeat') {
      // heartbeat only runs if overdue relative to adaptive interval
    }

    const last = lastAnalysisAt.get(key) || 0;
    if (Date.now() - last < needMs) continue;

    lastAnalysisAt.set(key, Date.now());
    setImmediate(() => {
      runAnalysisCycle(symbol, tf).catch(e =>
        log.warn(`live analysis [${key}] (${reason}): ${e.message}`)
      );
    });
  }
}


function initAgentsForSymbol(symbol) {
  agentPool[symbol] = {
    smc:            SMCAgent           ? new SMCAgent({ symbol, timeframe: 'H1', lookback: 30, pivotStrength: 3, minScore: 65 }) : null,
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

async function runAnalysisCycle(symbol, timeframe) {
  const key = `${symbol}:${timeframe}`;
  if (inFlight.has(key)) {
    log.debug(`Analysis already in flight for ${key} — skipping`);
    return;
  }

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
    const minBars = SIGNAL_SOFT_GATES ? 40 : 50;
    if (!candles || candles.length < minBars) {
      log.debug(`${key}: not enough candles (${candles?.length || 0}/${minBars}) — waiting`);
      try {
        auditTrail?.record?.({
          symbol, timeframe, signalFired: false,
          blockedReason: `need_${minBars}_candles_have_${candles?.length || 0}`,
          score: 0,
          reasons: [`candles ${candles?.length || 0}/${minBars}`],
          gatesFailed: ['candle_history'],
        });
      } catch (_) {}
      return;
    }

    // FIX: nothing in this pipeline ever asked "is the data I'm about to trade on actually trustworthy?" — a flash-crash wick, a frozen/stale feed repeating the same price, or a huge range on almost no...
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
    if (wsBus) {
      try {
        wsBus.emit('telemetry_update', {
          type: 'analysis_live',
          symbol,
          timeframe,
          candles: candles.length,
          timestamp: Date.now(),
        });
      } catch (_) {}
    }

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

    // FIX: this comment already documented the intent to run BOTH sentiment and pattern on a reduced cadence, but the code only ever called agents.sentiment — agents.pattern.analyze() was never called...
    const runReducedCadenceAgents = Math.random() > 0.66;

    const sentResult = agents.sentiment && runReducedCadenceAgents
      ? await buildSentimentExternalData(symbol)
          .then(extData => agents.sentiment.analyze(extData))
          .catch(() => null)
      : lastVotes[symbol]?.macroSent || null;

    const patternResult = agents.pattern && runReducedCadenceAgents
      ? await agents.pattern.analyze(candles).catch(e => { log.warn(`Pattern error [${key}]: ${e.message}`); return null; })
      : lastVotes[symbol]?.pattern || null;

    if (smcResult)   lastVotes[symbol].smc       = smcResult;
    if (mtfResult)   lastVotes[symbol].mtf        = mtfResult;
    if (momResult)   lastVotes[symbol].momentum   = momResult;
    if (sentResult)  lastVotes[symbol].macroSent  = sentResult;
    if (patternResult) lastVotes[symbol].pattern       = patternResult;
    if (volumeResult)  lastVotes[symbol].volumeOI       = volumeResult;
    if (microResult)   lastVotes[symbol].microstructure  = microResult;
    if (fractalResult) lastVotes[symbol].fractal         = fractalResult;

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

    // Hurst analysis layer — independent of signal scoring / agent votes
    if (hurstAnalysis && candleStores) {
      try {
        const board = hurstAnalysis.buildBoard(candleStores, SYMBOLS);
        if (wsBus) wsBus.emit('hurst_update', { board, ts: Date.now() });
      } catch (e) {
        log.debug(`Hurst board: ${e.message}`);
      }
    }

    // FIX: institutionalRiskManager was instantiated + connected but never fed live data — setRegime()/updateLiquidity() had zero call sites, so its regime-aware Kelly multiplier and liquidity check were...
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

    // FIX: sessionFilter (holiday/weekend/liquidity/killzone/rollover/news-blackout gate) was instantiated in buildSingletons() but its .check() method was never called anywhere in the pipeline — it was...
    let sessionQuality = null;
    if (sessionFilter?.check) {
      sessionQuality = sessionFilter.check(symbol, Date.now());
      if (!sessionQuality.allowed) {
        const isCrypto = /USDT|USDC|BTC$|ETH$/.test(symbol);
        if (SIGNAL_SOFT_GATES || isCrypto) {
          log.debug(`${key}: session soft-block (${sessionQuality.reason}) — continuing under soft gates`);
          try {
            auditTrail?.record?.({
              symbol, timeframe, signalFired: false,
              blockedReason: `session_soft: ${sessionQuality.reason}`,
              score: 0,
              reasons: ['session_restricted', sessionQuality.reason],
              gatesFailed: ['session'],
              gatesPassed: [],
            });
          } catch (_) {}
        } else {
          log.debug(`${key}: session filter blocked — ${sessionQuality.reason}`);
          try {
            auditTrail?.record?.({
              symbol, timeframe, signalFired: false,
              blockedReason: `session: ${sessionQuality.reason}`,
              score: 0,
              reasons: [sessionQuality.reason],
              gatesFailed: ['session'],
            });
          } catch (_) {}
          return;
        }
      }
    }

    // FIX: drawdownGuard.evaluate() — the actual pre-trade circuit-breaker / daily-loss / recovery-mode gate — was never called.
    let drawdownEval = null;
    if (drawdownGuard?.evaluate) {
      drawdownEval = drawdownGuard.evaluate({ price: currentPrice });
      if (!drawdownEval.allowed) {
        log.warn(`${key}: drawdown guard blocked — ${drawdownEval.reason}`);
        return;
      }
    }

    if (!scorer) { log.warn('SignalScorer not available'); return; }

    let signal = await scorer.score(resolvedVotes, {
      symbol,
      timeframe,
      currentPrice,
      timestamp: Date.now(),
    });

    // Feed adaptive throttle: near-miss scores → shorter intervals next time
    try {
      const sc = signal?.score?.final ?? (typeof signal?.score === 'number' ? signal.score : 0);
      lastAnalysisScore.set(key, Number(sc) || 0);
    } catch (_) {}

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
      const sc = signal?.score?.final ?? 0;
      const why = signal?.waitReason || signal?.reason || signal?.note || 'no_signal_or_wait';
      // This used to be log.debug — invisible unless LOG_LEVEL=debug is set,
      // which it isn't by default. Since the overwhelming majority of
      // analysis cycles end here, that meant close to zero signal-pipeline
      // activity was ever actually visible in production logs.
      log.info(`${key}: WAIT — score=${sc} — ${why}`);
      if (auditTrail) {
        auditTrail.record({
          symbol, timeframe, signalFired: false,
          blockedReason: why,
          score: sc,
          reasons: [String(why)],
          gatesFailed: sc > 0 && sc < MIN_SCORE ? ['min_score'] : ['consensus_or_agents'],
          gatesPassed: sc >= 40 ? ['partial_score'] : [],
          nearMiss: sc >= MIN_SCORE - 15 && sc < MIN_SCORE,
        });
      }
      return;
    }

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

    let compressionContext = null;
    if (compressionDetector) {
      compressionContext = compressionDetector.analyze({ candles });
    }

    if (abnormalMarket?.abnormal && abnormalMarket.severity === 'elevated') {
      signal = { ...signal, riskFlags: { ...(signal.riskFlags || {}), abnormalMarket: true, abnormalReasons: abnormalMarket.reasons } };
    }

    // Never blocks or resizes on its own; sample sizes from a single symbol's own history aren't strong enough evidence for that, but they're useful context on the signal card.
    let timeCycleContext = null;
    if (timeCycleEngine) {
      timeCycleContext = timeCycleEngine.currentWindowBias({ candles });
    }

    // never lower) the minimum-score bar for choppier/less tradeable regimes — it does not mutate the shared scorer instance, so there's no cross-symbol race condition from concurrent regimes.
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

    // FIX: correlationFilter was instantiated but its .check() method was never called — nothing prevented stacking correlated/duplicate/ over-limit positions before a signal fired.
    if (correlationFilter?.check) {
      const corrCheck = correlationFilter.check(symbol, signal.action, RISK_PCT);
      if (!corrCheck.allowed) {
        log.debug(`${key}: correlation filter blocked — ${corrCheck.reason}`);
        return;
      }
    }

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

          // FIX: institutionalRiskManager.validateAndSizePosition() was never called anywhere (only .connect() was) — its Kelly/regime/liquidity/ portfolio-cap sizing had zero influence on any real trade.
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

          // FIX: sessionQuality.multiplier and drawdownEval.sizingFactor were computed above but nothing ever applied them to the actual position size — they were pure dead weight.
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
            // FIX: /api/ea/signals (the MT5 EA polling endpoint) was sending a completely static riskPct straight from an env var — ignoring effectiveRisk (RiskEngine's own correlation/session adjustment) AND the...
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

    const wfResult = walkForward?.analyze ? walkForward.analyze() : null;

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

      if (ensembleResult?.totalPenalty && signal.score?.final != null) {
        signal.score = {
          ...signal.score,
          preEnsemble: signal.score.final,
          final: Math.max(0, Math.round(signal.score.final - ensembleResult.totalPenalty)),
          ensemblePenalty: ensembleResult.totalPenalty,
        };
      }

      log.info(`[ENSEMBLE] ${symbol} ${timeframe}: score=${ensembleResult.ensembleScore} approved=${ensembleResult.approved} layers=${ensembleResult.approvedLayers}/${ensembleResult.layerCount}${ensembleResult.hardRejections?.length ? ` | vetoed by: ${ensembleResult.hardRejections.join(', ')}` : ''}`);
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

    if (riskEvaluation?.positionSize != null && riskEvaluation.positionSize <= 0) {
      log.warn(`[RISK BLOCK] ${symbol} ${timeframe}: position size scaled to zero (session/drawdown/institutional risk combined)`);
      return;
    }

    let executionPlan = null; // purged: ExecutionManager was advisory-only (TWAP/VWAP never gated)

    // FIX: intermarket analysis (DXY/equity-index cross-confirmation) — the last item from the original audit's "does not exist" list.
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

    // never adjusts risk parameters or touches execution directly, and any error/timeout/ missing-key fails OPEN (proceeds as TAKE) rather than blocking a trade on an LLM outage.
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

    if (memory?.saveSignal) {
      memory.saveSignal(fullSignal).catch(e => log.warn(`Memory save error: ${e.message}`));
    }
    if (mongoStore.saveSignal) {
      mongoStore.saveSignal(fullSignal).catch(e => log.warn(`Mongo signal save error: ${e.message}`));
    }

    if (aiAdvisorVerdict?.recommendation === 'SKIP') {
      log.info(`${key}: AI Advisor recommends SKIP — ${aiAdvisorVerdict.reasoning}`);
      if (auditTrail) {
        auditTrail.record({ symbol, timeframe, signalFired: false, blockedReason: 'ai_advisor_skip', score: fullSignal.score?.final ?? 0 });
      }
      return;
    }
    if (auditTrail) {
      auditTrail.record({
        symbol, timeframe, signalFired: true,
        action: fullSignal.action,
        score: fullSignal.score?.final ?? 0,
        grade: fullSignal.score?.grade,
        reasons: ['passed_all_core_gates', fullSignal.action],
        gatesPassed: ['score', 'agents', 'risk'],
        gatesFailed: [],
      });
    }

    if (institutionalRiskManager?.executePosition) {
      try {
        institutionalRiskManager.executePosition(symbol, riskEvaluation.positionSize, currentPrice, signal.action);
      } catch (e) { log.warn(`InstitutionalRiskManager executePosition error: ${e.message}`); }
    }

    // FIX: when ExecutionEngine is active, route through it instead of calling dispatcher.sendSignal() directly — onSignal() calls dispatcher.sendSignal() internally (so the Telegram message is unchanged)...
    if (executionEngine?.onSignal) {
      await executionEngine.onSignal(fullSignal).catch(e => {
        log.error(`ExecutionEngine dispatch error: ${e.message}`);
      });
    } else if (dispatcher?.sendSignal) {
      await dispatcher.sendSignal(fullSignal).catch(e => {
        log.error(`Dispatch error: ${e.message}`);
      });
    }

    if (wsBus) {
      wsBus.emit('signal', fullSignal);
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

    if (drawdownGuard?.recordSignal) {
      drawdownGuard.recordSignal(fullSignal);
    }

    // FIX: SignalMonitor was instantiated and connected but createSignal() was never called anywhere, so its weakening/reversal-risk tracking never actually monitored any live signal.
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

function buildMTFData(symbol) {
  const store = candleStores[symbol] || {};
  const data  = {};
  for (const tf of TIMEFRAMES_STR) {
    if (store[tf] && store[tf].length > 0) data[tf] = store[tf];
  }
  return data;
}

// FIX: agents.sentiment.analyze() was being called with a raw candles ARRAY (agents.sentiment.analyze(candles)) where it expects a structured { cot, fearGreed, lsRatio, upcomingEvents, social, articles...
const _cotCache = {};
const insiderIntel = {
  direction: 'NEUTRAL',
  score: 0,
  note: '',
  clusters: 0,
  executiveBias: null,
  updatedAt: 0,
  recentClusters: [],
};

function updateInsiderIntelFromFeed(feed) {
  if (!feed) return;
  try {
    const clusters = feed.getAllClusters?.() || [];
    const execs = feed.getAllExecutiveActivity?.() || [];
    const sentiment = feed.getSentiment?.(14) || null;

    let buyClusters = 0, sellClusters = 0, buyVal = 0, sellVal = 0;
    for (const c of clusters) {
      const side = String(c.dominantSide || c.type || c.signal || '').toUpperCase();
      const conf = Number(c.confidence) || 50;
      if (side.includes('BUY') || side === 'LONG' || side === 'BULLISH') {
        buyClusters++; buyVal += conf;
      } else if (side.includes('SELL') || side === 'SHORT' || side === 'BEARISH') {
        sellClusters++; sellVal += conf;
      }
    }
    let execBuy = 0, execSell = 0;
    for (const e of execs) {
      const sig = String(e.signal || e.type || '').toUpperCase();
      if (sig.includes('BUY') || sig === 'LONG' || sig === 'BULLISH') execBuy++;
      else if (sig.includes('SELL') || sig === 'SHORT' || sig === 'BEARISH') execSell++;
    }

    let direction = 'NEUTRAL';
    let score = 40;
    const notes = [];
    if (buyClusters >= 2 && buyClusters > sellClusters) {
      direction = 'LONG';
      score = Math.min(95, 55 + buyClusters * 8 + execBuy * 5);
      notes.push(`${buyClusters} insider cluster buy(s)`);
    } else if (sellClusters >= 2 && sellClusters > buyClusters) {
      direction = 'SHORT';
      score = Math.min(95, 55 + sellClusters * 8 + execSell * 5);
      notes.push(`${sellClusters} insider cluster sell(s)`);
    }
    if (execBuy >= 2 && execBuy > execSell) {
      if (direction !== 'SHORT') direction = 'LONG';
      score = Math.max(score, 60 + execBuy * 6);
      notes.push(`${execBuy} key executive purchase(s)`);
    } else if (execSell >= 2 && execSell > execBuy) {
      if (direction !== 'LONG') direction = 'SHORT';
      score = Math.max(score, 60 + execSell * 6);
      notes.push(`${execSell} key executive sale(s)`);
    }
    if (sentiment?.score != null && Number.isFinite(sentiment.score)) {
      const s = Number(sentiment.score);
      if (s > 20 && direction !== 'SHORT') { direction = direction === 'NEUTRAL' ? 'LONG' : direction; score = Math.max(score, 50 + s / 5); }
      if (s < -20 && direction !== 'LONG') { direction = direction === 'NEUTRAL' ? 'SHORT' : direction; score = Math.max(score, 50 + Math.abs(s) / 5); }
    }

    insiderIntel.direction = direction;
    insiderIntel.score = Math.round(score);
    insiderIntel.note = notes.join('; ') || 'no significant insider clusters';
    insiderIntel.clusters = clusters.length;
    insiderIntel.executiveBias = execBuy - execSell;
    insiderIntel.updatedAt = Date.now();
    insiderIntel.recentClusters = clusters.slice(0, 8).map(c => ({
      ticker: c.ticker, confidence: c.confidence, side: c.dominantSide || c.type,
    }));
  } catch (e) {
    log.warn(`updateInsiderIntelFromFeed error: ${e.message}`);
  }
}

const _newsCache = {};

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
      // FIX: COTAnalyzer.analyze() (agents/sentiment-agent.js) destructures `commercials` (plural) from its input, but COTReportParser.analyze() (feeds/cot-report-parser.js) returns the field as `commercial`...
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

  // Also fixed a NaN bug in aggregateArticles() (agents/sentiment-agent.js) that would have silently zeroed out real news scoring anyway even with a key.
  if (finnhubFeed?.enabled?.()) {
    try {
      const isCrypto = symbol.endsWith('USDT') || symbol.endsWith('USDC') || symbol.endsWith('BTC');
      const category = isCrypto ? 'crypto' : 'forex';
      const cached = _newsCache[category];
      const stale = !cached || (Date.now() - cached.ts) > 5 * 60000;
      let raw = cached?.articles;
      if (stale) {
        raw = await finnhubFeed.marketNews(category);
        _newsCache[category] = { articles: raw, ts: Date.now() };
      }
      if (Array.isArray(raw) && raw.length) {
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

  if (insiderIntel && insiderIntel.updatedAt) {
    data.insider = {
      direction: insiderIntel.direction,
      score: insiderIntel.score,
      note: insiderIntel.note,
      clusters: insiderIntel.clusters,
      executiveBias: insiderIntel.executiveBias,
      recentClusters: insiderIntel.recentClusters,
    };
  }

  return data;
}

const MAX_CANDLES_PER_TF = 500;

function onCandle({ symbol, timeframe, candle, isClosed }) {
  if (!SYMBOLS.includes(symbol)) return;
  if (!TIMEFRAMES_STR.includes(timeframe)) return;

  const src = candle?.source || '';
  const isBroker = src === 'mt5_ea';
  if (!isBroker) {
    const last = lastPriceBySymbol[symbol];
    // FIX: PC-off / MT5-offline fallback was inconsistent across three
    // separate guards. onLivePrice() (the ticker/quotes path) and the
    // derivFeed.on('price', ...) handler that calls this function on bar
    // close both already use a reduced 12s hold specifically so Deriv
    // takes over quickly once the broker goes quiet ("MT5 only blocks
    // Deriv for 12s after last broker tick (PC off = Deriv wins)" per the
    // commit that added that reduced hold). But THIS guard — the one that
    // actually gates whether a Deriv bar-close reaches candleStores *and*
    // triggers scheduleLiveAnalysis() below — still used the full 60s
    // BROKER_PRICE_HOLD_MS. So for roughly 12-60s after turning the PC
    // off, the ticker would already show live Deriv prices while the
    // chart stayed frozen on the last MT5 bar, and worse: any Deriv bar
    // that closed in that window had its analysis trigger silently
    // dropped here even though the bar itself still landed in
    // candleStores via the caller's own array mutation — a live
    // signal-generation gap, not just a display lag. Only Deriv reaches
    // this branch now (Yahoo/TwelveData/Binance/Bybit are gone), so this
    // just matches the hold everywhere else already uses.
    const holdMs = src === 'deriv' ? Math.min(BROKER_PRICE_HOLD_MS, 12000) : BROKER_PRICE_HOLD_MS;
    if (last && last.source === 'mt5_ea' && (Date.now() - last.ts) < holdMs) {
      return;
    }
  }

  const store = candleStores[symbol];
  if (!store) return;

  if (!store[timeframe]) store[timeframe] = [];

  const arr = store[timeframe];

  if (arr.length && arr[arr.length - 1].timestamp === candle.timestamp) {
    arr[arr.length - 1] = candle;
  } else {
    arr.push(candle);
    if (arr.length > MAX_CANDLES_PER_TF) arr.shift();
  }

  // FIX: attach real funding/OI (see bybitFundingOI declaration above) to the candle actually sitting in the store — must happen AFTER the push/replace above, and must mutate `arr[arr.length-1]` (not the...
  const liveOI = bybitFundingOI[symbol];
  if (liveOI) {
    const target = arr[arr.length - 1];
    if (liveOI.fundingRate != null) target.fundingRate = liveOI.fundingRate;
    if (liveOI.openInterest != null) target.openInterest = liveOI.openInterest;
  }

  // FIX: this was inlined here, reachable ONLY through onCandle() — meaning any live price source that doesn't go through the full candle pipeline (Finnhub's WS ticks, the MT5 EA's pushed ticks — see...
  onLivePrice(symbol, candle.close, {
    change: candle.open ? ((candle.close - candle.open) / candle.open * 100) : 0,
  });

  if (isClosed) {
    setImmediate(() => { lastAnalysisAt.delete(`${symbol}:${timeframe}`); scheduleLiveAnalysis(symbol, 'bar_close'); });
  }
}

// FIX: see the comment above where this replaced onCandle()'s inlined version.
const PRICE_SOURCE_RANK = {
  mt5_ea: 100,
  tradingview: 90,
  deriv: 55,
  finnhub: 50,
  candle: 40,
  unknown: 0,
};
const BROKER_PRICE_HOLD_MS = Number(process.env.BROKER_PRICE_HOLD_MS) || 60000;
const lastPriceBySymbol = {};

function onLivePrice(symbol, price, { change = null, bias = null, source = 'candle', bid = null, ask = null } = {}) {
  if (!SYMBOLS.includes(symbol)) return;
  if (!Number.isFinite(price)) return;

  const now = Date.now();
  const rank = PRICE_SOURCE_RANK[source] ?? PRICE_SOURCE_RANK.unknown;
  const prev = lastPriceBySymbol[symbol];

  // If the EA / PC is offline, mt5_ea timestamps go stale and Deriv must win.
  const holdMs = source === 'deriv'
    ? Math.min(BROKER_PRICE_HOLD_MS, 12000)
    : BROKER_PRICE_HOLD_MS;
  if (prev && prev.rank > rank && (now - prev.ts) < holdMs) {
    return;
  }
  const sameRankMin = source === 'mt5_ea' ? 50 : 400;
  if (prev && prev.rank === rank && (now - prev.ts) < sameRankMin) {
    return;
  }

  const b = Number.isFinite(bid) ? bid : (prev?.bid ?? null);
  const a = Number.isFinite(ask) ? ask : (prev?.ask ?? null);
  lastPriceBySymbol[symbol] = { price, bid: b, ask: a, source, rank, ts: now };

  // Always-on analysis: same spirit as live chart — rescore while ticks flow
  try { scheduleLiveAnalysis(symbol, source); } catch (_) {}

  // Emit a one-time engine readiness signal so clients know the trading
  // engine has started receiving live ticks and can flip out of "waking".
  if (!engineReadyEmitted) {
    engineReadyEmitted = true;
    try {
      if (wsBus) wsBus.emit('engine_ready', { ts: Date.now(), symbol, source });
    } catch (_) {}
  }
  // persist a lightweight snapshot to disk so restarts have immediate data
  try {
    const persist = require('./lib/persist');
    persist.saveCandles({ candleStores, lastPrices: lastPriceBySymbol });
  } catch (_) {}
  // keep cache fresh periodically
  try {
    const persist = require('./lib/persist');
    setInterval(() => {
      try { persist.saveCandles({ candleStores, lastPrices: lastPriceBySymbol }); } catch (_) {}
    }, 15 * 1000);
  } catch (_) {}

  // Crypto volatility alerts (BTC/ETH short-window % moves)
  if (cryptoVolAlert && cryptoVolAlert.watches(symbol)) {
    try {
      const alert = cryptoVolAlert.onPrice(symbol, price, now);
      if (alert && wsBus) {
        const channel = alert.assetClass === 'gold' ? 'gold_volatility_alert' : 'crypto_volatility_alert';
        wsBus.emit('crypto_volatility_alert', alert); // UI listens on one channel
        wsBus.emit(channel, alert);
        wsBus.emit('telemetry_update', { type: alert.type, ...alert });
        log.warn(`[VolAlert] ${alert.message}`);
        if (dispatcher?.sendMessage && (alert.severity === 'high' || alert.severity === 'severe')) {
          const title = alert.assetClass === 'gold' ? 'Gold volatility' : 'Crypto volatility';
          dispatcher.sendMessage(
            `⚡ *${title}*\n${alert.symbol} ${alert.direction} ${alert.absPct}% / ${alert.window}\nPrice ${alert.price}`
          ).catch(() => {});
        }
        try {
          auditTrail?.record?.({
            symbol, timeframe: alert.window, signalFired: false,
            blockedReason: `vol_${alert.assetClass}_${alert.direction}_${alert.absPct}pct`,
            score: alert.absPct,
            reasons: [alert.message],
            gatesFailed: [],
            gatesPassed: ['volatility_watch'],
          });
        } catch (_) {}
      }
    } catch (e) {
      log.debug(`cryptoVolAlert: ${e.message}`);
    }
  }

  if (executionEngine?.onPrice) {
    try { executionEngine.onPrice(symbol, price, null); }
    catch (e) { log.warn(`ExecutionEngine.onPrice error [${symbol}]: ${e.message}`); }
  }

  if (wsBus) {
    const emitMin = source === 'mt5_ea' ? 50 : 350;
    if (!lastMarketEmit[symbol] || now - lastMarketEmit[symbol] >= emitMin) {
      lastMarketEmit[symbol] = now;
      wsBus.emit('market_update', {
        symbol,
        price,
        bid: b,
        ask: a,
        change,
        bias: bias ?? lastVotes[symbol]?.smc?.direction?.toLowerCase() ?? 'wait',
        source,
      });
    }
  }
}

const TIMEFRAME_MS = {
  M1: 60e3, M5: 5 * 60e3, M15: 15 * 60e3, M30: 30 * 60e3,
  H1: 3600e3, H2: 2 * 3600e3, H4: 4 * 3600e3, H8: 8 * 3600e3, H12: 12 * 3600e3,
  D1: 86400e3, W1: 7 * 86400e3,
};

// FIX: the MT5 EA sits on James's own broker's live tick feed — the single most real-time forex price source available here, cheaper and higher- fidelity than any REST/WS API on a free tier — but its...
const mt5CandleBuilders = {};

function onMT5Tick(symbol, price, { bid, ask, timestamp } = {}) {
  if (!SYMBOLS.includes(symbol)) return;
  if (!Number.isFinite(price)) return;
  const now = timestamp || Date.now();

  for (const tf of TIMEFRAMES_STR) {
    const durationMs = TIMEFRAME_MS[tf];
    if (!durationMs) continue;
    const bucketStart = Math.floor(now / durationMs) * durationMs;
    const key = `${symbol}_${tf}`;
    const prev = mt5CandleBuilders[key];

    if (!prev || prev.timestamp !== bucketStart) {
      if (prev) {
        try { onCandle({ symbol, timeframe: tf, candle: { ...prev }, isClosed: true }); }
        catch (e) { log.warn(`onMT5Tick close [${symbol} ${tf}]: ${e.message}`); }
      }
      const baseOpen = Number.isFinite(bid) ? bid : price;
      mt5CandleBuilders[key] = {
        timestamp: bucketStart, open: baseOpen, high: baseOpen, low: baseOpen, close: baseOpen,
        volume: 0, bid, ask, source: 'mt5_ea',
        // FIX: chart-vs-ticker mismatch — candleStores' OHLC here is built
        // from `price`, which api/server.js's /api/ea/prices computes as
        // (bid+ask)/2 (mid), a deliberate choice for technical analysis
        // (keeps indicators clean of spread noise) that stays correct and
        // unchanged for the agents. But the ticker/header display bid and
        // ask as two separate numbers, and mid sits between them by
        // definition — so the chart's close could never equal either
        // number the user is actually looking at above it, on every
        // symbol, all the time, not just occasionally. MT5 terminals plot
        // bid for exactly this reason. Track bid's own O/H/L/C alongside
        // the existing mid-based fields (additive, nothing here changes
        // what candleStores' open/high/low/close mean or what the agents
        // read) so /api/candles can serve bid-accurate bars without
        // touching signal generation's price basis at all.
        bidOpen: bid, bidHigh: bid, bidLow: bid, bidClose: bid,
      };
    } else {
      // Prefer bid when available and sane (avoid large instantaneous spread artifacts)
      let tickVal = Number.isFinite(bid) ? bid : price;
      try {
        const base = Number(price) || 0;
        const diff = Math.abs((Number(bid) || base) - base);
        if (base > 0 && diff / base > 0.02) {
          // spread >2% of mid — treat as anomalous and stick to mid for OHLC
          tickVal = price;
        }
      } catch (_) { tickVal = Number.isFinite(bid) ? bid : price; }
      prev.high = Math.max(prev.high, tickVal);
      prev.low = Math.min(prev.low, tickVal);
      prev.close = tickVal;
      prev.bid = bid;
      prev.ask = ask;
      if (Number.isFinite(bid)) {
        if (prev.bidOpen == null) prev.bidOpen = bid;
        prev.bidHigh = prev.bidHigh != null ? Math.max(prev.bidHigh, bid) : bid;
        prev.bidLow = prev.bidLow != null ? Math.min(prev.bidLow, bid) : bid;
        prev.bidClose = bid;
      }
    }

    try { onCandle({ symbol, timeframe: tf, candle: { ...mt5CandleBuilders[key] }, isClosed: false }); }
    catch (e) { log.warn(`onMT5Tick update [${symbol} ${tf}]: ${e.message}`); }
  }

  onLivePrice(symbol, price, { source: 'mt5_ea', bid, ask });
}

let dispatcher, scorer, sltp, entryOptimizer, regimeEngine, hurstAnalysis, institutionalGates,
    adaptiveLearning, drawdownGuard, riskEngine, sessionFilter, correlationFilter, memory,
    monteCarlo, bayesianEng, statValidator, walkForward, ensembleEng,
    signalMonitor, institutionalRiskManager, myfxbookFeed, openInsiderFeed,
    finnhubFeed, cftcCotFeed, cotParser, executionEngine, opportunityRanker, relativeStrength,
    dataIntegrityMonitor, intermarketAnalyzer, alphaVantageFeed, fmpFeed;

// FIX: several feeds (Bybit, TwelveData, Myfxbook) emit errors in two different shapes — a raw Error (has .message) from the underlying connection, and a { source, error } wrapper from their own...
function feedErrorMessage(err) {
  return err?.error?.message || err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
}

function buildSingletons() {
  if (AlertDispatcher && BOT_TOKEN) {
    dispatcher = new AlertDispatcher({ token: BOT_TOKEN, chatIds: CHAT_IDS, store: mongoStore });
    log.info(`AlertDispatcher created — ${CHAT_IDS.length} chat(s) + auto-subscribe enabled`);

    // FIX: the /win, /loss, /be Telegram commands emitted 'trade_outcome' but nothing in this file ever listened for it — dispatcher._recordOutcome() sent a confirmation message and recorded the outcome...
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

    // FIX: risk_update (the frontend's Session PnL / Circuit Breaker / Sizing display) previously only broadcast from inside the signal-approval code path (see onSignal-adjacent block further down) —...
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
      setInterval(broadcastRiskUpdate, 30000);
    }
  }

  if (SignalScorer) {
    scorer = new SignalScorer({
      minScore:      MIN_SCORE,
      sessionFilter: !SIGNAL_SOFT_GATES,
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
    // FIX: AlertDispatcher was constructed without `scorer` in its config, so this.scorer was always null in production — silently no-opping the WIN/LOSS/BE handler's scorer.recordTradeOutcome() call and...
    if (dispatcher) dispatcher.scorer = scorer;
    log.info('SignalScorer created');
  } else {
    log.error('SignalScorer module missing — signals cannot be scored');
  }

  if (dispatcher) {
    dispatcher.getMarketOutlookDeps = () => ({ regimeEngine, candleStores, sessionFilter, cotParser, symbols: SYMBOLS });
  }

  // FIX: manual-mode.js's ExecutionEngine (~1,700 lines — SignalJournal, RiskEnforcer, PriceMonitor, partial TP/trailing/breakeven tracking) was imported nowhere in the entire codebase.
  if (ExecutionEngine && dispatcher) {
    executionEngine = new ExecutionEngine({
      mode: 'MANUAL',
      dispatcher,
      drawdownGuard,
      maxOpenPositions: 5,
      maxRiskPct: RISK_PCT * 3,
      sendJournalDaily: true,
    });
    dispatcher.executionEngine = executionEngine;

    // FIX: real, computed P&L from actual price action — closing this loop properly is what the WIN/LOSS/BE buttons could never do (they only ever recorded a placeholder R-multiple).
    executionEngine.on('position_closed', async ({ position, outcome }) => {
      if (!recordOutcomeEverywhere) return;
      try {
        // FIX: fetch the actual full stored signal (matching the pattern /api/outcomes already uses) instead of reconstructing a minimal one from Position's own limited fields — adaptiveLearning.
        const recent = await mongoStore.getRecentSignals?.({ limit: 200 }).catch(() => []);
        const signal = (recent || []).find(s => s.id === position.signalId) || {
          id: position.signalId, symbol: position.symbol, regime: position.regime,
          session: position.session, score: { grade: position.grade },
        };

        const liveEngines = require('./api/realtime').getEngines();
        // FIX: refactored to use the shared recordOutcomeEverywhere utility instead of hand-rolled duplicate calls — picks up institutionalRiskManager.recordTradeResult() and riskEngine.recordTrade() (feeds...
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

  if (SLTPEngine) {
    sltp = new SLTPEngine();
    log.info('SLTPEngine created');
  }

  if (EntryOptimizer) {
    entryOptimizer = new EntryOptimizer();
    log.info('EntryOptimizer created');
  }

  if (RegimeEngine) {
    regimeEngine = new RegimeEngine({ lookback: 120 });
  if (HurstAnalysisEngine) {
    hurstAnalysis = new HurstAnalysisEngine({ timeframes: ['H1', 'H4'] });
    log.info('Hurst analysis layer online (separate from signal votes)');
  }
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
      minRR: SIGNAL_SOFT_GATES ? 1.2 : 1.5,
      maxRiskPct: Math.min(RISK_PCT, 2.0),
      minRegimeTradeability: SIGNAL_SOFT_GATES ? 35 : 50,
      requireEnsemble: !SIGNAL_SOFT_GATES,
      minAgentConsensus: SIGNAL_SOFT_GATES ? 0.35 : 0.5,
    });
    log.info('InstitutionalGates created');
  }

  if (AdaptiveLearningEngine) {
    adaptiveLearning = new AdaptiveLearningEngine({ store: mongoStore });
    log.info('AdaptiveLearningEngine created (with RL + Mistake Blacklist)');
  }

  if (MonteCarloEngine) {
    monteCarlo = new MonteCarloEngine({
      simulations: parseInt(process.env.MC_SIMULATIONS || '5000', 10),
      minWinProb: parseFloat(process.env.MC_MIN_WIN_PROB || '0.55'),
      minExpectedR: parseFloat(process.env.MC_MIN_EXPECTED_R || '0.3'),
    });
    log.info('MonteCarloEngine created (5000 sims × 3 methods = 15000 paths)');
  }

  if (BayesianEngine) {
    bayesianEng = new BayesianEngine({
      basePrior: parseFloat(process.env.BAYES_PRIOR || '0.50'),
      minPosterior: parseFloat(process.env.BAYES_MIN_POSTERIOR || '0.52'),
    });
    log.info('BayesianEngine created (LR + NaiveBayes + BetaBinomial)');
  }

  if (StatisticalValidator) {
    statValidator = new StatisticalValidator({
      minTestsPassed: parseInt(process.env.STAT_MIN_TESTS || '5', 10),
      significanceLevel: parseFloat(process.env.STAT_SIGNIFICANCE || '0.05'),
    });
    log.info('StatisticalValidator created (10 hypothesis tests)');
  }

  if (WalkForwardOptimizer) {
    walkForward = new WalkForwardOptimizer({
      minSamples: parseInt(process.env.WF_MIN_SAMPLES || '20', 10),
      minWFE: parseFloat(process.env.WF_MIN_WFE || '0.35'),
    });
    log.info('WalkForwardOptimizer created');
  }

  if (EnsembleEngine) {
    ensembleEng = new EnsembleEngine({
      minConfidence: parseFloat(process.env.ENSEMBLE_MIN_CONFIDENCE || '60'),
    });
    log.info('EnsembleEngine created (9-layer consensus validation)');
  }

  if (RiskEngine) {
    riskEngine = new RiskEngine({
      accountBalance: ACCOUNT_BALANCE,
      riskPct:        RISK_PCT,
      sizingMethod:   'ATR',
      // FIX: useKelly defaulted to false and _performanceStats had zero real trade data feeding it (recordTrade() existed with no call sites) — now wired via signal-pipeline/outcome-recorder.js.
      useKelly:       true,
      // FIX: without this, DrawdownGuard's circuit breaker never actually influenced position sizing/approval — see position-sizer.js.
      drawdownGuard,
    });
    log.info('RiskEngine (position sizer) created');
  }

  if (SessionFilter) {
    sessionFilter = new SessionFilter();
    log.info('SessionFilter created');
  }

  if (CorrelationFilter) {
    correlationFilter = new CorrelationFilter({ maxOpenPositions: 5 });
    log.info('CorrelationFilter created');
  }

  if (MemoryManager) {
    memory = new MemoryManager({
      redisUrl:    process.env.REDIS_URL    || null,
      databaseUrl: process.env.DATABASE_URL || null,
    });
    log.info('MemoryManager created (in-memory fallback active if no Redis/PG)');
  }

  if (SignalMonitor) {
    signalMonitor = new SignalMonitor({
      checkIntervalMs: 60000,
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
    // FIX: without this handler, SignalMonitor's periodic check_signal ticks had nothing to act on — no market data was ever fed back in, so weakening/reversal detection could never actually fire.
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

  if (MyfxbookFeed && process.env.MYFXBOOK_EMAIL && process.env.MYFXBOOK_PASSWORD) {
    myfxbookFeed = new MyfxbookFeed({
      email: process.env.MYFXBOOK_EMAIL,
      password: process.env.MYFXBOOK_PASSWORD,
      pollIntervalMs: 5 * 60000,
    });
    // FIX: this feed emits 'error' (feeds/myfxbook-feed.js — connection and poll failures) but had NO listener registered anywhere.
    myfxbookFeed.on('error', (err) => log.error(`MyfxbookFeed error: ${feedErrorMessage(err)}`));
    myfxbookFeed.on('economic_surprise', (data) => {
      log.info(`[Myfxbook] Economic surprise: ${data.event.name} - ${data.impact}`);
      dispatcher?.sendMessage?.(`📊 *Economic Surprise*\n${data.event.name}\nImpact: ${data.impact}\nCurrencies: ${data.affectedCurrencies.join(', ')}`)?.catch(() => {});
      // FIX: this event only ever reached Telegram — the web/Mini App frontend had zero visibility into institutional flow data despite the backend fully computing it.
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

  if (OpenInsiderFeed) {
    openInsiderFeed = new OpenInsiderFeed({});
    openInsiderFeed.on('error', (err) => log.error(`OpenInsiderFeed error: ${feedErrorMessage(err)}`));
    openInsiderFeed.on('cluster_buy', (data) => {
      log.info(`[OpenInsider] Cluster buy: ${data.ticker} — ${data.insiderCount || data.size || '?'} insiders (conf=${data.confidence})`);
      updateInsiderIntelFromFeed(openInsiderFeed);
      wsBus?.emit('intel', { kind: 'insider_cluster', ...data, timestamp: Date.now() });
      dispatcher?.sendMessage?.(
        `🏛️ *Insider Cluster Buy*\n${data.ticker} — ${data.insiderCount || data.size || '?'} insiders\nConf: ${data.confidence || 'n/a'}`
      )?.catch(() => {});
    });
    openInsiderFeed.on('executive_activity', (data) => {
      log.info(`[OpenInsider] Executive activity: ${data.ticker} — ${data.signal}`);
      updateInsiderIntelFromFeed(openInsiderFeed);
      wsBus?.emit('intel', { kind: 'executive_activity', ...data, timestamp: Date.now() });
    });
    openInsiderFeed.on('ready', () => {
      updateInsiderIntelFromFeed(openInsiderFeed);
      log.info('OpenInsiderFeed ready — insider intel active');
    });
    log.info('OpenInsiderFeed created — SEC Form 4 cluster/executive tracking active');
  }

  if (AlphaVantageFeed) {
    alphaVantageFeed = new AlphaVantageFeed({});
    if (alphaVantageFeed.enabled()) {
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

  // FIX: FinnhubFeed existed but was never instantiated anywhere, and its economic-calendar data (added alongside this fix) was the missing real data source for sessionFilter's EconomicCalendarTierSystem...
  if (FinnhubFeed) finnhubFeed = new FinnhubFeed({ apiKey: process.env.FINNHUB_API_KEY || '' });
  if (FMPFeed)     fmpFeed     = new FMPFeed({ apiKey: process.env.FMP_API_KEY || '' });

  {
    let ffCalendar = null;
    if (ForexFactoryCalendar) {
      ffCalendar = new ForexFactoryCalendar();
      log.info('ForexFactoryCalendar enabled — free weekly economic calendar (no API key)');
    }
    const pollEconomicCalendar = async () => {
      const raw = [];
      if (ffCalendar) {
        try { raw.push(...await ffCalendar.economicCalendar()); }
        catch (err) { log.warn(`ForexFactory calendar poll failed: ${err.message}`); }
      }
      if (finnhubFeed?.enabled()) {
        try { raw.push(...await finnhubFeed.economicCalendar()); }
        catch (err) { log.warn(`Finnhub economic calendar poll failed: ${err.message}`); }
      }
      if (fmpFeed?.enabled()) {
        try { raw.push(...await fmpFeed.economicCalendar()); }
        catch (err) { log.warn(`FMP economic calendar poll failed: ${err.message}`); }
      }
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
          // FIX: only use a provider's impact rating to PROMOTE an event that none of EconomicCalendarTierSystem._inferTier's own name-regexes would catch — never to override/downgrade a name that's already...
          const TIER1_RE = /nfp|non.?farm|fomc|cpi|rate decision|interest rate/i;
          const TIER2_RE = /gdp|pmi|retail sales|unemployment/i;
          const TIER3_RE = /building permit|confidence|trade balance/i;
          sessionFilter.addNewsEvents(events.map(e => ({
            name: e.name,
            currency: e.currency,
            time: e.time,
            tier: TIER1_RE.test(e.name) || TIER2_RE.test(e.name) || TIER3_RE.test(e.name)
              ? undefined
              : e.tierHint
                || (e.impact === 'high' || e.impact === 'High' ? 'TIER_1'
                : e.impact === 'medium' || e.impact === 'Medium' ? 'TIER_2'
                : e.impact === 'low' || e.impact === 'Low' ? 'TIER_3'
                : undefined),
          })));
        }
        const src = [ffCalendar ? 'ForexFactory' : null, finnhubFeed?.enabled() ? 'Finnhub' : null, fmpFeed?.enabled() ? 'FMP' : null].filter(Boolean).join('+') || 'none';
        if (events.length) {
          log.info(`EconomicCalendar: ${events.length} events loaded for the next 7 days (${src})`);
        } else {
          log.warn(`EconomicCalendar: 0 events from ${src || 'no providers'} — check FINNHUB_API_KEY/FMP_API_KEY plan supports /calendar/economic (Finnhub free tier often blocks this endpoint)`);
        }
      } catch (err) {
        log.warn(`EconomicCalendar addNewsEvents failed: ${err.message}`);
      }
    };
    pollEconomicCalendar();
    setTimeout(pollEconomicCalendar, 2 * 60000);
    setInterval(pollEconomicCalendar, 1 * 3600000);
  }
  log.info(finnhubFeed?.enabled() ? 'FinnhubFeed created' : 'FinnhubFeed disabled - missing FINNHUB_API_KEY');
  log.info(fmpFeed?.enabled() ? 'FMPFeed created' : 'FMPFeed disabled - missing FMP_API_KEY');

  // FIX: real COT (Commitment of Traders) data — CFTCCotFeed and COTReportParser were fully built but nothing anywhere fetched real CFTC data or fed it to them.
  if (CFTCCotFeed && COTReportParser) {
    cftcCotFeed = new CFTCCotFeed();
    cotParser = new COTReportParser();
    log.info(`CFTCCotFeed created — supports: ${cftcCotFeed.supportedSymbols().join(', ')}`);
  }

  // FIX: publish the live singleton instances so api/server.js's /api/outcomes handler can record real trade outcomes into the SAME objects this pipeline actually consults during scoring — see...
  try {
    require('./api/realtime').setEngines({
      adaptiveLearning, bayesianEng, walkForward, institutionalGates,
      drawdownGuard, sessionFilter, riskEngine, institutionalRiskManager,
      opportunityRanker, relativeStrength, dataIntegrityMonitor, executionEngine,
      auditTrail, symbolManager, cotParser, memory,
      regimeEngine, hurstAnalysis, candleStores, symbols: SYMBOLS,
      onLivePrice, onMT5Tick,
      lastPriceBySymbol,
    });
    log.info('Live engine singletons published for outcome-feedback wiring');
  } catch (err) {
    log.error(`Failed to publish engine registry — API endpoints (watchlist, journal, health, audit-trail, etc) will serve stale or empty data: ${err.message}`);
  }
}

function buildFeeds() {
  const feeds = [];

  const cryptoSymbols = SYMBOLS.filter(s => s.endsWith('USDT') || s.endsWith('USDC') || s.endsWith('BTC'));
  const fxSymbols     = SYMBOLS.filter(s => !cryptoSymbols.includes(s));

  if (DerivFeed && SYMBOLS.length && process.env.DISABLE_DERIV !== '1') {
    const derivFeed = new DerivFeed({
      symbols: SYMBOLS,
      appId: process.env.DERIV_APP_ID || '1089',
    });
    derivFeed.on('price', ({ symbol, price, bid, ask, change }) => {
      const last = lastPriceBySymbol[symbol];
      if (last && last.source === 'mt5_ea' && (Date.now() - last.ts) < 12000) {
        return;
      }
      onLivePrice(symbol, price, { source: 'deriv', change, bid, ask });
      try {
        for (const tf of TIMEFRAMES_STR) {
          if (!candleStores[symbol]) candleStores[symbol] = {};
          const arr = candleStores[symbol][tf] || (candleStores[symbol][tf] = []);
          const ms = ({ M1: 60e3, M5: 300e3, M15: 900e3, H1: 3600e3, H4: 14400e3, D1: 86400e3 })[tf] || 3600e3;
          const bucket = Math.floor(Date.now() / ms) * ms;
          const lastBar = arr[arr.length - 1];
          if (!lastBar || lastBar.timestamp !== bucket) {
            if (lastBar && lastBar.isClosed === false) {
              lastBar.isClosed = true;
              // Closed bar → analysis (same path as MT5)
              try { onCandle({ symbol, timeframe: tf, candle: { ...lastBar }, isClosed: true }); } catch (_) {}
            }
            arr.push({ open: price, high: price, low: price, close: price, volume: 0, timestamp: bucket, isClosed: false, source: 'deriv' });
            if (arr.length > 500) arr.splice(0, arr.length - 500);
          } else {
            lastBar.high = Math.max(lastBar.high, price);
            lastBar.low = Math.min(lastBar.low, price);
            lastBar.close = price;
          }
        }
      } catch (_) {}
    });
    derivFeed.on('candles', ({ symbol, timeframe, candles }) => {
      if (!candleStores[symbol]) candleStores[symbol] = {};
      const prev = candleStores[symbol][timeframe] || [];
      const last = lastPriceBySymbol[symbol];
      if (last && last.source === 'mt5_ea' && (Date.now() - last.ts) < BROKER_PRICE_HOLD_MS * 4 && prev.length >= 50) {
        return;
      }
      if (candles.length > (prev.length * 0.5) || prev.length < 40) {
        candleStores[symbol][timeframe] = candles.slice(-500);
        log.info(`Deriv candles: ${symbol} ${timeframe} ${candles.length} bars`);
        // CRITICAL: history seed must run analysis — isClosed path only fires on live bar close
        if (TIMEFRAMES_STR.includes(timeframe) && candles.length >= (SIGNAL_SOFT_GATES ? 40 : 50)) {
          setImmediate(() => { lastAnalysisAt.delete(`${symbol}:${timeframe}`); scheduleLiveAnalysis(symbol, 'bar_close'); });
        }
      }
    });
    derivFeed.on('connected', () => log.info(`DerivFeed connected (app_id=${process.env.DERIV_APP_ID || '1089'}) — ticks + OHLC; MT5 overrides when online`));
    derivFeed.on('disconnected', () => log.warn('DerivFeed disconnected — will reconnect'));
    derivFeed.on('error', (err) => log.warn(`DerivFeed: ${feedErrorMessage(err)}`));
    derivFeed.start();
    feeds.push({ name: 'DerivFeed', instance: derivFeed, symbols: SYMBOLS });
    if (dataIntegrityMonitor) dataIntegrityMonitor.registerFeed('Deriv', derivFeed, SYMBOLS);
    log.info(`DerivFeed (primary free live) for: ${SYMBOLS.join(', ')}`);
  }

  // Yahoo never overwrites a symbol that has a recent mt5_ea tick.

  if (dataIntegrityMonitor && finnhubFeed?.enabled?.()) {
    dataIntegrityMonitor.registerFeed('Finnhub', finnhubFeed, fxSymbols.length ? fxSymbols : SYMBOLS);
  }
  if (dataIntegrityMonitor && alphaVantageFeed?.enabled?.()) {
    dataIntegrityMonitor.registerFeed('Alpha Vantage', alphaVantageFeed, []);
  }
  if (dataIntegrityMonitor && fmpFeed?.enabled?.()) {
    dataIntegrityMonitor.registerFeed('FMP', fmpFeed, []);
  }
  if (dataIntegrityMonitor && cftcCotFeed) {
    dataIntegrityMonitor.registerFeed('CFTC COT', cftcCotFeed, []);
  }
  if (dataIntegrityMonitor && myfxbookFeed) {
    dataIntegrityMonitor.registerFeed('Myfxbook', myfxbookFeed, []);
  }

  return feeds;
}

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

async function main() {
  log.info('╔══════════════════════════════════════╗');
  log.info('║  OMNICEE  — Institutional Grade v2   ║');
  log.info('║  Monte Carlo · Bayesian · Ensemble   ║');
  log.info('╚══════════════════════════════════════╝');
  log.info(`Symbols:    ${SYMBOLS.join(', ')}`);
  log.info(`Timeframes: ${TIMEFRAMES_STR.join(', ')}`);
  log.info(`Min score:  ${MIN_SCORE} | Risk: ${RISK_PCT}% | Max DD: ${MAX_DRAWDOWN}%`);

  buildSingletons();

  for (const sym of SYMBOLS) {
    initAgentsForSymbol(sym);
  }

  if (dispatcher) {
    try {
      await dispatcher.init();
      log.info('Telegram bot initialised');
      await dispatcher.sendMessage?.('🚀 *OMNICEE Online*\nSystem initialized. Monitoring markets...');
      try { require('./api/realtime').setDispatcher(dispatcher); } catch (_) {}
    } catch (err) {
      log.error(`Telegram init failed: ${err.message}. Signals will still run — just no Telegram output.`);
    }
  }

  if (memory?.init) {
    try { await memory.init(); } catch (e) { log.warn(`Memory init: ${e.message}`); }
  }

  const feeds = buildFeeds();
  // Always-on analysis loop (chart-like): keeps checking while server is up
  setInterval(() => {
    for (const symbol of SYMBOLS) {
      scheduleLiveAnalysis(symbol, 'heartbeat');
    }
  }, LIVE_ANALYSIS_INTERVAL_MS);
  const triggerBootAnalysis = () => {
    for (const symbol of SYMBOLS) scheduleLiveAnalysis(symbol, 'boot');
  };
  triggerBootAnalysis();
  setTimeout(triggerBootAnalysis, 5000);
  setTimeout(triggerBootAnalysis, 15000);
  setTimeout(triggerBootAnalysis, 30000);
  log.info(`Live analysis: adaptive throttle ${ADAPTIVE_THROTTLE ? 'ON' : 'OFF'} · heartbeat ${LIVE_ANALYSIS_INTERVAL_MS/1000}s · symbols ${SYMBOLS.join(',')}`);

  const keepUrl = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (keepUrl) {
    setInterval(() => {
      const https = require('https');
      try {
        https.get(String(keepUrl).replace(/\/$/, '') + '/health', (r) => { r.resume(); }).on('error', () => {});
      } catch (_) {}
    }, 4 * 60 * 1000);
    log.info(`Keepalive scheduled for ${keepUrl}`);
  }
  try {
    const rt = require('./api/realtime');
    const prev = rt.getEngines() || {};
    rt.setEngines({ ...prev, lastPriceBySymbol, candleStores, onLivePrice, onMT5Tick });
  } catch (e) { log.warn(`re-publish engines: ${e.message}`); }
  setupShutdown(feeds);

  const connectTasks = feeds.map(async (f) => {
    try {
      if (typeof f.instance.connect === 'function') {
        await f.instance.connect();
      } else if (typeof f.instance.start === 'function') {
        f.instance.start();
      }
      f.seed?.();
      log.info(`${f.name} connected`);
      return true;
    } catch (err) {
      // Deriv may already be started in buildFeeds(); do not treat as fatal
      if (typeof f.instance.isConnected === 'function' && f.instance.isConnected()) {
        log.info(`${f.name} already live`);
        return true;
      }
      log.error(`${f.name} connection failed: ${err.message}`);
      return false;
    }
  });
  const connectResults = await Promise.all(connectTasks);
  const connected = connectResults.filter(Boolean).length;

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
      updateInsiderIntelFromFeed(openInsiderFeed);
      log.info('OpenInsiderFeed connected — insider flow infused into sentiment');
    } catch (err) {
      log.error(`OpenInsiderFeed connection failed: ${err.message}`);
    }
  }

  if (signalMonitor) {
    try {
      await signalMonitor.connect();
      log.info('SignalMonitor connected');
    } catch (err) {
      log.error(`SignalMonitor connection failed: ${err.message}`);
    }
  }

  if (institutionalRiskManager) {
    try {
      await institutionalRiskManager.connect();
      log.info('InstitutionalRiskManager connected');
    } catch (err) {
      log.error(`InstitutionalRiskManager connection failed: ${err.message}`);
    }
  }

  if (connected === 0 && feeds.length > 0) {
    log.error('No feeds connected — check your API keys and network connection');
  }

  if (feeds.length === 0) {
    log.warn('No live feeds configured — enable Deriv (DERIV_APP_ID) and/or attach MT5 OmniceeEA');
    log.info('Running in dry-run mode — use the test script to inject synthetic candles');
  }

  // FIX: the check above only ever logged and reported via /api/health — it never actually stopped anything.
  const staleAutoBlacklisted = new Set();
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
      if (symbolManager) {
        const staleSymbolsNow = new Set(report.staleSeries.map(s => s.symbol));
        for (const symbol of staleSymbolsNow) {
          if (!staleAutoBlacklisted.has(symbol)) {
            symbolManager.blacklist(symbol);
            staleAutoBlacklisted.add(symbol);
            log.warn(`DataIntegrity: blacklisting ${symbol} until its feed is fresh again — no new signals will fire for it`);
          }
        }
        for (const symbol of [...staleAutoBlacklisted]) {
          if (!staleSymbolsNow.has(symbol)) {
            symbolManager.unblacklist(symbol);
            staleAutoBlacklisted.delete(symbol);
            log.info(`DataIntegrity: ${symbol}'s feed is fresh again — un-blacklisting`);
          }
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

module.exports = { main, onCandle, runAnalysisCycle, candleStores, agentPool, lastVotes };
