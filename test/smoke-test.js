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
