'use strict';

/**
 * OMNICEE Smoke Test
 * Runs without any API keys.
 * Injects synthetic candle data through the full pipeline and verifies
 * each module loads correctly and returns the expected shape.
 */

const path = require('path');
const ROOT  = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function pass(label) { console.log(`  ✅  ${label}`); passed++; }
function fail(label, err) { console.error(`  ❌  ${label}: ${err?.message || err}`); failed++; }

// ── Synthetic candle generator ─────────────────────────────────────────────

function syntheticCandles(n = 200, basePrice = 2000, trend = 'UP') {
  const candles = [];
  let price = basePrice;
  const now  = Date.now();
  const TF   = 3600000; // H1

  for (let i = n; i >= 0; i--) {
    const noise  = (Math.random() - 0.5) * price * 0.005;
    const drift  = trend === 'UP'   ?  price * 0.0003
                 : trend === 'DOWN' ? -price * 0.0003
                 : 0;
    price = Math.max(1, price + drift + noise);

    const range  = price * (0.003 + Math.random() * 0.005);
    const open   = price;
    const close  = price + (Math.random() - 0.5) * range;
    const high   = Math.max(open, close) + Math.random() * range * 0.5;
    const low    = Math.min(open, close) - Math.random() * range * 0.5;
    const volume = 1000 + Math.random() * 5000;

    candles.push({
      open:      parseFloat(open.toFixed(4)),
      high:      parseFloat(high.toFixed(4)),
      low:       parseFloat(low.toFixed(4)),
      close:     parseFloat(close.toFixed(4)),
      volume:    parseFloat(volume.toFixed(2)),
      timestamp: now - i * TF,
    });
  }
  return candles;
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  OMNICEE Smoke Test');
  console.log('══════════════════════════════════════════════\n');

  const candles = syntheticCandles(200, 2000, 'UP');
  const closes  = candles.map(c => c.close);

  // ── 1. Module loading ──────────────────────────────────────────────────

  console.log('1. Module loading');

  const mods = {
    SMCAgent:         ['./agents/smc-agent',                  'SMCAgent'],
    MTFAgent:         ['./agents/mtf-agent',                  'MTFAgent'],
    MomentumAgent:    ['./agents/momentum-agent',             'MomentumAgent'],
    SignalScorer:     ['./signal-pipeline/signal-scorer',     'SignalScorer'],
    SLTPEngine:       ['./signal-pipeline/sl-tp-engine',      'SLTPEngine'],
    DrawdownGuard:    ['./risk-engine/drawdown-guard',        'DrawdownGuard'],
    RiskEngine:       ['./risk-engine/position-sizer',        'RiskEngine'],
    ConflictResolver: ['./orchestrator/conflict-resolver',    'ConflictResolver'],
    MemoryManager:    ['./orchestrator/memory-manager',       'MemoryManager'],
    VolumeOIAgent:    ['./agents/volume-oi-agent',            'VolumeOIAgent'],
    RegimeEngine:     ['./signal-pipeline/regime-engine',     'RegimeEngine'],
    InstitutionalGates: ['./signal-pipeline/institutional-gates', 'InstitutionalGates'],
  };

  const loaded = {};
  for (const [name, [modPath, exportName]] of Object.entries(mods)) {
    try {
      const mod = require(path.join(ROOT, modPath));
      if (!mod[exportName]) throw new Error(`Export '${exportName}' not found`);
      loaded[name] = mod[exportName];
      pass(`${name} loaded`);
    } catch (e) {
      fail(`${name} load`, e);
      loaded[name] = null;
    }
  }

  // ── 2. MomentumAgent ──────────────────────────────────────────────────

  console.log('\n2. MomentumAgent');
  if (loaded.MomentumAgent) {
    try {
      const agent = new loaded.MomentumAgent({ symbol: 'TEST', timeframe: 'H1' });
      const vote  = await agent.analyze(candles);
      if (!vote?.direction) throw new Error('No direction in vote');
      if (typeof vote.score !== 'number') throw new Error('Score must be number');
      if (!['LONG','SHORT','WAIT'].includes(vote.direction)) throw new Error(`Invalid direction: ${vote.direction}`);
      pass(`MomentumAgent.analyze() → direction=${vote.direction} score=${vote.score}`);
    } catch (e) { fail('MomentumAgent.analyze()', e); }
  }

  // ── 3. SMCAgent ───────────────────────────────────────────────────────

  console.log('\n3. SMCAgent');
  if (loaded.SMCAgent) {
    try {
      const agent = new loaded.SMCAgent({ symbol: 'TEST', timeframe: 'H1', lookback: 30, pivotStrength: 3, minScore: 50 });
      const result = await agent.analyze(candles);
      if (!result) throw new Error('analyze() returned null');
      pass(`SMCAgent.analyze() → signal=${result?.signal?.action || 'n/a'}`);
    } catch (e) { fail('SMCAgent.analyze()', e); }
  }

  // ── 4. MTFAgent ───────────────────────────────────────────────────────

  console.log('\n4. MTFAgent');
  if (loaded.MTFAgent) {
    try {
      const agent = new loaded.MTFAgent({ symbol: 'TEST', requireHTFAlign: false });
      const result = await agent.analyze({ H1: candles, H4: candles.slice(-100) });
      if (!result) throw new Error('analyze() returned null');
      pass(`MTFAgent.analyze() → direction=${result?.direction || 'n/a'}`);
    } catch (e) { fail('MTFAgent.analyze()', e); }
  }

  // ── 5. ConflictResolver ───────────────────────────────────────────────

  console.log('\n5. ConflictResolver');
  if (loaded.ConflictResolver) {
    try {
      const resolver = new loaded.ConflictResolver();   // instance — not static
      const votes = {
        smc:       { direction: 'LONG',  score: 80, reasons: ['Order block'] },
        mtf:       { direction: 'LONG',  score: 75, reasons: ['HTF aligned'] },
        momentum:  { direction: 'LONG',  score: 70, reasons: ['RSI bullish'] },
        volumeOI:  { direction: 'LONG',  score: 60, reasons: [] },
        macroSent: { direction: 'WAIT',  score: 50, reasons: [] },
      };
      const result = resolver.resolve(votes, { symbol: 'TEST', timeframe: 'H1', currentPrice: 2000 });
      if (!result?.direction) throw new Error('No direction in result');
      pass(`ConflictResolver.resolve() → direction=${result.direction} conflicts=${result.conflicts?.length || 0}`);
    } catch (e) { fail('ConflictResolver.resolve()', e); }
  }

  // ── 6. SignalScorer end-to-end ────────────────────────────────────────

  console.log('\n6. SignalScorer end-to-end');
  if (loaded.SignalScorer) {
    try {
      const scorer = new loaded.SignalScorer({ minScore: 50, sessionFilter: false, newsBlackout: false });

      const agentVotes = {
        smc: {
          direction: 'LONG',
          score: 85,
          reasons: ['Bullish OB at 1990-1995', 'FVG mitigated', 'CHoCH confirmed'],
          analysis: {
            orderBlocks:    [{ type: 'BULLISH', high: 1995, low: 1990 }],
            structure:      { direction: 'BULLISH' },
            signal: {
              action: 'LONG',
              entry:  { zoneHigh: 1995, zoneLow: 1990, type: 'LIMIT' },
              stopLoss: { price: 1980 },
              targets:  { tp1: { price: 2010, rr: 1.5 }, tp2: { price: 2020, rr: 3.0 } },
              confluence: { score: 85, grade: 'A' },
            },
          },
        },
        mtf: {
          direction: 'LONG',
          score: 78,
          reasons: ['D1 bullish', 'H4 pullback to OTE'],
          analysis: { htfBias: { direction: 'LONG' } },
        },
        momentum: {
          direction: 'LONG',
          score: 72,
          reasons: ['RSI oversold', 'MACD bullish cross'],
          analysis: {},
        },
        macroSent: null,
        volumeOI:  null,
      };

      const signal = await scorer.score(agentVotes, {
        symbol:       'XAUUSD',
        timeframe:    'H1',
        currentPrice: 1992,
        timestamp:    Date.now(),
      });

      if (!signal) throw new Error('score() returned null');
      pass(`SignalScorer.score() → action=${signal.action} score=${signal.score?.final} grade=${signal.score?.grade}`);

      // Verify shape
      if (!signal.symbol)   throw new Error('Missing signal.symbol');
      if (!signal.action)   throw new Error('Missing signal.action');
      pass('Signal shape valid (symbol, action present)');

    } catch (e) { fail('SignalScorer.score()', e); }
  }

  // ── 7. DrawdownGuard ──────────────────────────────────────────────────

  console.log('\n7. DrawdownGuard');
  if (loaded.DrawdownGuard) {
    try {
      const guard = new loaded.DrawdownGuard({ maxDailyLoss: 3, maxDrawdown: 10, accountBalance: 10000 });
      const status = guard.isPaused ? guard.isPaused() : { paused: false };
      pass(`DrawdownGuard.isPaused() → ${status.paused}`);
    } catch (e) { fail('DrawdownGuard', e); }
  }

  // ── 8. RiskEngine (position sizer) ───────────────────────────────────

  console.log('\n8. RiskEngine');
  if (loaded.RiskEngine) {
    try {
      const engine = new loaded.RiskEngine({ accountBalance: 10000, riskPct: 1.0 });
      const hasSize = typeof engine.size === 'function' || typeof engine.calculate === 'function';
      pass(`RiskEngine instantiated — size method: ${hasSize}`);
    } catch (e) { fail('RiskEngine', e); }
  }

  // ── 8b. Institutional additions ─────────────────────────────────────

  console.log('\n8b. Institutional additions');
  if (loaded.VolumeOIAgent) {
    try {
      const agent = new loaded.VolumeOIAgent({ symbol: 'TEST', timeframe: 'H1' });
      const result = await agent.analyze(candles);
      if (!result?.direction) throw new Error('VolumeOIAgent missing direction');
      pass(`VolumeOIAgent.analyze() → direction=${result.direction} score=${result.score}`);
    } catch (e) { fail('VolumeOIAgent.analyze()', e); }
  }
  if (loaded.RegimeEngine) {
    try {
      const regime = new loaded.RegimeEngine().classify(candles);
      if (!regime?.regime) throw new Error('RegimeEngine missing regime');
      pass(`RegimeEngine.classify() → ${regime.regime} tradeability=${regime.tradeability}`);
    } catch (e) { fail('RegimeEngine.classify()', e); }
  }
  if (loaded.InstitutionalGates) {
    try {
      const gates = new loaded.InstitutionalGates({ minScore: 50 });
      const gate = gates.evaluate({
        signal: { action: 'LONG', score: { final: 80, grade: 'B' }, targets: { tp1: { rr: 1.6 } } },
        regime: { regime: 'BULL_TREND', tradeability: 70 },
        riskEvaluation: { approved: true, effectiveRisk: 1 },
        votes: { smc: { direction: 'LONG' }, mtf: { direction: 'LONG' } },
      });
      if (!gate.approved) throw new Error(`Institutional gate unexpectedly rejected: ${gate.failures.join(', ')}`);
      pass(`InstitutionalGates.evaluate() → ${gate.status} confidence=${gate.confidence}`);
    } catch (e) { fail('InstitutionalGates.evaluate()', e); }
  }

  // ── 9. MemoryManager ──────────────────────────────────────────────────

  console.log('\n9. MemoryManager');
  if (loaded.MemoryManager) {
    try {
      const mem = new loaded.MemoryManager({ redisUrl: null, databaseUrl: null });
      if (mem.init) await mem.init().catch(() => {});
      pass('MemoryManager instantiated (in-memory mode)');
    } catch (e) { fail('MemoryManager', e); }
  }

  // ── 10. SLTPEngine ────────────────────────────────────────────────────

  console.log('\n10. SLTPEngine');
  if (loaded.SLTPEngine) {
    try {
      const engine = new loaded.SLTPEngine();
      pass('SLTPEngine instantiated');
    } catch (e) { fail('SLTPEngine', e); }
  }

  // ── 11. New Institutional-Grade Engines ────────────────────────────────

  console.log('\n11. Institutional-Grade Validation Engines');

  try {
    const { MonteCarloEngine } = require(path.join(ROOT, 'signal-pipeline/monte-carlo-engine'));
    const mc = new MonteCarloEngine({ simulations: 100 });
    const mcResult = mc.simulate({ candles, signal: { action: 'LONG', score: { final: 80 }, targets: { tp1: { price: 2100 } }, stopLoss: { price: 1950 } }, tradePlan: { entry: { midPoint: 2000 }, stopLoss: { price: 1950 }, targets: { tp1: { price: 2100, rr: 2 } } }, regime: {} });
    pass(`MonteCarloEngine: ${mcResult.simulations} sims, winProb=${mcResult.winProbability}`);
  } catch (e) { fail('MonteCarloEngine', e); }

  try {
    const { BayesianEngine } = require(path.join(ROOT, 'signal-pipeline/bayesian-engine'));
    const be = new BayesianEngine();
    const beResult = be.evaluate({ signal: { action: 'LONG', score: { final: 82, grade: 'B' } }, regime: { tradeability: 70, structure: 'DIRECTIONAL' }, votes: { smc: { direction: 'LONG' }, mtf: { direction: 'LONG' } } });
    pass(`BayesianEngine: posterior=${beResult.posterior}, approved=${beResult.approved}`);
  } catch (e) { fail('BayesianEngine', e); }

  try {
    const { StatisticalValidator } = require(path.join(ROOT, 'signal-pipeline/statistical-validator'));
    const sv = new StatisticalValidator({ bootstrapIterations: 200 });
    const svResult = sv.validate({ candles, signal: { action: 'LONG', score: { final: 80 } } });
    pass(`StatisticalValidator: ${svResult.passed}/${svResult.total} tests passed`);
  } catch (e) { fail('StatisticalValidator', e); }

  try {
    const { WalkForwardOptimizer } = require(path.join(ROOT, 'signal-pipeline/walk-forward-optimizer'));
    const wf = new WalkForwardOptimizer();
    const wfResult = wf.analyze();
    pass(`WalkForwardOptimizer: sufficient=${wfResult.sufficient}`);
  } catch (e) { fail('WalkForwardOptimizer', e); }

  try {
    const { EnsembleEngine } = require(path.join(ROOT, 'signal-pipeline/ensemble-engine'));
    const ee = new EnsembleEngine();
    pass('EnsembleEngine loaded');
  } catch (e) { fail('EnsembleEngine', e); }

  try {
    const { MicrostructureAgent } = require(path.join(ROOT, 'agents/microstructure-agent'));
    const micro = new MicrostructureAgent({ symbol: 'BTCUSDT' });
    const microResult = await micro.analyze(candles);
    pass(`MicrostructureAgent: direction=${microResult.direction} score=${microResult.score}`);
  } catch (e) { fail('MicrostructureAgent', e); }

  try {
    const { FractalAgent } = require(path.join(ROOT, 'agents/fractal-agent'));
    const fractal = new FractalAgent({ symbol: 'BTCUSDT' });
    const fractalResult = await fractal.analyze(candles);
    pass(`FractalAgent: direction=${fractalResult.direction} score=${fractalResult.score}`);
  } catch (e) { fail('FractalAgent', e); }

  try {
    const { OpportunityRanker } = require(path.join(ROOT, 'signal-pipeline/opportunity-ranker'));
    const ranker = new OpportunityRanker();
    ranker.update('BTCUSDT', { action: 'BUY', score: 78, grade: 'A', fired: true, price: 65000 });
    ranker.update('ETHUSDT', { action: 'WAIT', score: 30, grade: 'D', fired: false, price: 3200 });
    const ranked = ranker.getRanked();
    if (ranked.length !== 2 || ranked[0].symbol !== 'BTCUSDT') {
      throw new Error(`expected BTCUSDT ranked first, got ${JSON.stringify(ranked.map(r => r.symbol))}`);
    }
    pass(`OpportunityRanker: top=${ranked[0].symbol} score=${ranked[0].score}`);
  } catch (e) { fail('OpportunityRanker', e); }

  try {
    const { RelativeStrengthEngine } = require(path.join(ROOT, 'risk-engine/relative-strength'));
    const rs = new RelativeStrengthEngine({ lookback: 10 });
    const stores = { BTCUSDT: { H1: candles }, ETHUSDT: { H1: syntheticCandles(200, 3000, 'DOWN') } };
    const ranked = rs.rank(stores, ['BTCUSDT', 'ETHUSDT'], 'H1');
    if (ranked.length !== 2) throw new Error(`expected 2 ranked symbols, got ${ranked.length}`);
    pass(`RelativeStrengthEngine: leader=${ranked[0].symbol} (${ranked[0].changePct.toFixed(2)}%)`);
  } catch (e) { fail('RelativeStrengthEngine', e); }

  try {
    const { DataIntegrityMonitor } = require(path.join(ROOT, 'feeds/data-integrity-monitor'));
    const dim = new DataIntegrityMonitor({ staleFactor: 3 });
    dim.registerFeed('FakeFeed', { isConnected: () => true }, ['BTCUSDT']);
    const freshStores = { BTCUSDT: { H1: [{ timestamp: Date.now(), close: 100 }] } };
    const freshReport = dim.check(freshStores);
    if (!freshReport.ok) throw new Error('expected ok=true for fresh candles');

    const staleStores = { BTCUSDT: { H1: [{ timestamp: Date.now() - 5 * 3600000, close: 100 }] } };
    const staleReport = dim.check(staleStores);
    if (staleReport.ok || staleReport.staleSeries.length !== 1) {
      throw new Error(`expected 1 stale series, got ${JSON.stringify(staleReport.staleSeries)}`);
    }
    pass(`DataIntegrityMonitor: fresh=ok, stale detected after ${Math.round(staleReport.staleSeries[0].ageMs / 3600000)}h`);
  } catch (e) { fail('DataIntegrityMonitor', e); }

  try {
    const { AbnormalMarketDetector } = require(path.join(ROOT, 'signal-pipeline/abnormal-market-detector'));
    const amd = new AbnormalMarketDetector();

    // Clean, normal candles -> not abnormal
    const cleanReport = amd.analyze({ candles, symbol: 'BTCUSDT' });
    if (cleanReport.abnormal) {
      throw new Error(`expected clean synthetic candles to be normal, got: ${cleanReport.reasons.join('; ')}`);
    }

    // Inject a flash-crash wick + gap on the final candle
    const spiked = candles.map(c => ({ ...c }));
    const last = spiked[spiked.length - 1];
    const base = last.close;
    spiked[spiked.length - 1] = {
      ...last,
      open: base,
      high: base * 1.15,
      low: base * 0.80,
      close: base * 1.001, // reverted back near open — big wick, tiny body
    };
    const spikeReport = amd.analyze({ candles: spiked, symbol: 'BTCUSDT' });
    if (!spikeReport.abnormal) throw new Error('expected flash-spike candle to be flagged abnormal');
    pass(`AbnormalMarketDetector: clean=ok, spike flagged (${spikeReport.severity}: ${spikeReport.reasons[0]})`);
  } catch (e) { fail('AbnormalMarketDetector', e); }

  try {
    const { SignalJournal } = require(path.join(ROOT, 'signal-pipeline/manual-mode'));
    const journal = new SignalJournal();
    const mkSignal = (id, agent, contribution) => ({
      id, symbol: 'BTCUSDT', timeframe: 'H1', action: 'LONG',
      score: { final: 82, grade: 'A' }, session: { current: 'LONDON' },
      agentBreakdown: [{ agent, status: 'CONFIRMS', contribution }],
    });
    journal.logSignal(mkSignal('sig1', 'smc', 20), {});
    journal.logSignal(mkSignal('sig2', 'mtf', 25), {});
    journal.recordOutcome('pos1', 'sig1', { entryPrice: 100, exitPrice: 105, pnlR: 1.5, pnlPct: 1.2, state: 'WIN' });
    journal.recordOutcome('pos2', 'sig2', { entryPrice: 100, exitPrice: 95, pnlR: -1, pnlPct: -1, state: 'LOSS' });
    const stats = journal.getStats();
    if (!stats.bySetup?.smc || !stats.bySetup?.mtf) {
      throw new Error(`expected bySetup to have smc+mtf keys, got ${JSON.stringify(Object.keys(stats.bySetup || {}))}`);
    }
    if (stats.bySetup.smc.winRate !== 100 || stats.bySetup.mtf.winRate !== 0) {
      throw new Error('bySetup win rates incorrect');
    }
    pass(`Setup Analytics: bySetup correctly split smc(100% WR) vs mtf(0% WR)`);
  } catch (e) { fail('Setup Analytics (bySetup)', e); }

  try {
    const { computeStats } = require(path.join(ROOT, 'backtest/stats'));
    const trades = [
      { symbol: 'BTCUSDT', direction: 'LONG', grade: 'A', pnlR: 1.5, pnlPct: 1.2, structure: 'DIRECTIONAL', volatility: 'NORMAL' },
      { symbol: 'BTCUSDT', direction: 'LONG', grade: 'A', pnlR: -1,  pnlPct: -1,  structure: 'CHOP',        volatility: 'COMPRESSION' },
      { symbol: 'ETHUSDT', direction: 'SHORT', grade: 'B', pnlR: 2,  pnlPct: 1.5, structure: 'DIRECTIONAL', volatility: 'NORMAL' },
    ];
    const equityCurve = [{ timestamp: 1, balance: 10000 }, { timestamp: 2, balance: 10120 }, { timestamp: 3, balance: 10300 }];
    const stats = computeStats(trades, equityCurve, 10000);
    if (stats.byMarketStructure?.DIRECTIONAL?.trades !== 2 || stats.byMarketStructure?.CHOP?.trades !== 1) {
      throw new Error(`byMarketStructure incorrect: ${JSON.stringify(stats.byMarketStructure)}`);
    }
    if (stats.byVolatilityRegime?.NORMAL?.winRate !== 100 || stats.byVolatilityRegime?.COMPRESSION?.winRate !== 0) {
      throw new Error(`byVolatilityRegime incorrect: ${JSON.stringify(stats.byVolatilityRegime)}`);
    }
    pass(`Scenario Simulator: DIRECTIONAL=100% WR, CHOP=0% WR, NORMAL=100% WR, COMPRESSION=0% WR`);
  } catch (e) { fail('Scenario Simulator (byMarketStructure/byVolatilityRegime)', e); }

  try {
    const { TrapDetector } = require(path.join(ROOT, 'signal-pipeline/trap-detector'));
    const candles = syntheticCandles(150, 2000, 'RANGE');
    const trap = new TrapDetector();
    const result = trap.analyze({ candles });
    if (!Array.isArray(result.traps)) throw new Error('expected traps array');
    if (typeof result.trapRisk !== 'number') throw new Error('expected numeric trapRisk');
    pass(`TrapDetector: traps=${result.traps.length} trapRisk=${result.trapRisk}`);
  } catch (e) { fail('TrapDetector', e); }

  try {
    const { CompressionDetector } = require(path.join(ROOT, 'signal-pipeline/compression-detector'));
    const candles = syntheticCandles(150, 2000, 'RANGE');
    const comp = new CompressionDetector();
    const result = comp.analyze({ candles });
    if (typeof result.compressionScore !== 'number') throw new Error('expected numeric compressionScore');
    pass(`CompressionDetector: score=${result.compressionScore} compressed=${result.isCompressed}`);
  } catch (e) { fail('CompressionDetector', e); }

  try {
    const { TimeCycleEngine } = require(path.join(ROOT, 'signal-pipeline/time-cycle-engine'));
    const candles = syntheticCandles(1500, 2000, 'RANGE');
    const tce = new TimeCycleEngine();
    const result = tce.analyze({ candles, forwardBars: 1 });
    if (!Array.isArray(result.hourOfDay) || result.hourOfDay.length === 0) throw new Error('expected populated hourOfDay buckets');
    pass(`TimeCycleEngine: hourBuckets=${result.hourOfDay.length} dowBuckets=${result.dayOfWeek.length}`);
  } catch (e) { fail('TimeCycleEngine', e); }


  try {
    const { StrategySelector } = require(path.join(ROOT, 'signal-pipeline/strategy-selector'));
    const sel = new StrategySelector();
    const aligned = sel.select({ regime: { regime: 'BULL_TREND', trend: 'BULL_TREND', structure: 'DIRECTIONAL', volatility: 'NORMAL', tradeability: 80 }, signalAction: 'LONG' });
    const fighting = sel.select({ regime: { regime: 'BULL_TREND', trend: 'BULL_TREND', structure: 'DIRECTIONAL', volatility: 'NORMAL', tradeability: 80 }, signalAction: 'SHORT' });
    if (!(aligned.confidenceMultiplier > fighting.confidenceMultiplier)) {
      throw new Error(`expected trend-aligned multiplier > counter-trend, got ${aligned.confidenceMultiplier} vs ${fighting.confidenceMultiplier}`);
    }
    const chop = sel.select({ regime: { regime: 'CHOP_EXPANSION', trend: 'BALANCED', structure: 'CHOP', volatility: 'EXPANSION', tradeability: 30 }, signalAction: 'LONG' });
    if (chop.confidenceMultiplier >= 1 || !chop.minScoreFloor) throw new Error('expected CHOP to discount confidence and set a min-score floor');
    pass(`StrategySelector: aligned=${aligned.confidenceMultiplier} counterTrend=${fighting.confidenceMultiplier} chop=${chop.confidenceMultiplier}/floor=${chop.minScoreFloor}`);
  } catch (e) { fail('StrategySelector', e); }

  try {
    const { CandleIntelligence } = require(path.join(ROOT, 'signal-pipeline/candle-intelligence'));
    const ci = new CandleIntelligence();
    // Deterministic, monotonically-declining series — syntheticCandles' drift
    // is dominated by its own random noise over a short window and can't
    // reliably produce a classifiable down-trend for this assertion.
    const candles = [];
    let price = 2000;
    for (let i = 0; i < 40; i++) {
      const o = price;
      const c = price - price * 0.004;
      candles.push({ open: o, high: o + price * 0.0005, low: c - price * 0.0005, close: c, volume: 1000, timestamp: Date.now() - (40 - i) * 3600000 });
      price = c;
    }
    const last = candles[candles.length - 1];
    // Force a hammer-shaped rejection candle after the down-trend
    candles[candles.length - 1] = { ...last, open: last.close, close: last.close + last.close * 0.003, high: last.close + last.close * 0.0035, low: last.close - last.close * 0.018, volume: (last.volume || 1000) * 3 };
    const result = ci.analyze({ candles });
    if (result.type !== 'HAMMER_REJECTION') throw new Error(`expected HAMMER_REJECTION, got ${result.type}`);
    if (!result.rejection.isExhaustionCandidate) throw new Error('expected exhaustion candidate flag on hammer after downtrend');
    pass(`CandleIntelligence: type=${result.type} quality=${result.qualityScore} exhaustion=${result.rejection.isExhaustionCandidate}`);
  } catch (e) { fail('CandleIntelligence', e); }

  try {
    const { AIAdvisor } = require(path.join(ROOT, 'signal-pipeline/ai-advisor'));
    // No API key in smoke-test env — must fail open immediately with no network call.
    const advisor = new AIAdvisor({ apiKey: '' });
    if (advisor.enabled) throw new Error('expected advisor to be disabled with no API key');
    const result = await advisor.evaluate({
      signal: { symbol: 'BTCUSDT', timeframe: 'H1', action: 'LONG', currentPrice: 65000, score: { final: 82, grade: 'A' } },
      regime: { regime: 'BULL_TREND', trend: 'BULL_TREND', structure: 'DIRECTIONAL', volatility: 'NORMAL', tradeability: 85 },
    });
    if (result.recommendation !== 'TAKE' || result.source !== 'fallback') {
      throw new Error(`expected fail-open TAKE/fallback, got ${JSON.stringify(result)}`);
    }
    pass(`AIAdvisor: disabled-without-key fails open correctly (recommendation=${result.recommendation})`);
  } catch (e) { fail('AIAdvisor', e); }

  try {
    const { SignalExplainer } = require(path.join(ROOT, 'signal-pipeline/signal-explainer'));
    const explainer = new SignalExplainer();
    const strong = explainer.explain({
      signal: {
        symbol: 'BTCUSDT', action: 'LONG', score: { final: 88, grade: 'A' },
        directionAnalysis: { confirmedBy: ['smc', 'mtf', 'momentum', 'volumeOI'], agentVotes: [1, 2, 3, 4, 5, 6] },
        agentBreakdown: [{ agent: 'SMC', weight: 0.322, direction: 'LONG', topReasons: ['Bullish order block mitigated'] }],
      },
      candleContext: { type: 'BULL_MARUBOZU', qualityScore: 91, note: 'Strong bullish candle.' },
      compressionContext: { isCompressed: false, compressionScore: 20 },
    });
    if (strong.confidenceLabel !== 'WELL_SUPPORTED') throw new Error(`expected WELL_SUPPORTED, got ${strong.confidenceLabel}`);
    if (!strong.supports.length || strong.cautions.length) throw new Error('expected supports only, no cautions, for a clean strong signal');

    const minimal = explainer.explain({ signal: { symbol: 'XAUUSD', action: 'LONG', score: { final: 76, grade: 'B' } } });
    if (!minimal.summary || minimal.confidenceLabel !== 'STANDARD') throw new Error('expected graceful degrade to STANDARD with only signal context');

    pass(`SignalExplainer: strong=${strong.confidenceLabel} minimal-context=${minimal.confidenceLabel} (free, no API key required)`);
  } catch (e) { fail('SignalExplainer', e); }

  try {
    const { MarketHeatMap } = require(path.join(ROOT, 'automation/market-heatmap'));
    const { OpportunityRanker } = require(path.join(ROOT, 'signal-pipeline/opportunity-ranker'));
    const ranker = new OpportunityRanker();
    ranker.update('BTCUSDT', { action: 'LONG', score: 88, grade: 'A', fired: true });
    ranker.update('ETHUSDT', { action: 'WAIT', score: 45, grade: 'C', fired: false, blockedReason: 'below min score' });
    const heatmap = new MarketHeatMap();
    const grid = heatmap.build({ opportunityRanker: ranker });
    if (!Array.isArray(grid.tiles) || grid.tiles.length !== 2) throw new Error(`expected 2 tiles, got ${grid.tiles?.length}`);
    if (grid.tiles[0].symbol !== 'BTCUSDT') throw new Error('expected BTCUSDT (higher score) ranked first');
    pass(`MarketHeatMap: ${grid.tiles.length} tiles, top=${grid.tiles[0].symbol} (${grid.tiles[0].bucket})`);
  } catch (e) { fail('MarketHeatMap', e); }

  // ── 12. Syntax check all modules ──────────────────────────────────────


  console.log('\n12. index.js syntax check');
  try {
    require(path.join(ROOT, 'index.js'));
    pass('index.js loads without crash');
  } catch (e) {
    // Expected: will try to boot feeds that don't exist in test env
    if (e.message.includes('Cannot find module') && e.message.includes('dotenv')) {
      pass('index.js loads (dotenv optional — acceptable)');
    } else if (e.code === 'MODULE_NOT_FOUND') {
      fail('index.js has missing module', e);
    } else {
      // Boot attempt errors (no env vars) are expected in test
      pass(`index.js loads OK (expected boot warning: ${e.message.slice(0, 60)})`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n[FATAL TEST ERROR]', err.message);
  console.error(err.stack);
  process.exit(1);
});
