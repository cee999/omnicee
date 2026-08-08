#!/usr/bin/env node
'use strict';
/**
 * backtest/compare-gates.js
 *
 * Answers a specific question: "was softening the signal gates
 * (MIN_SIGNAL_SCORE 78→65, hard session block → SIGNAL_SOFT_GATES) actually
 * profitable, or did it just mean more (worse) trades?"
 *
 * It runs the SAME historical candles through the SAME production pipeline
 * (backtest/engine.js — which now actually mirrors index.js's soft-gate
 * logic; see the FIX comments in engine.js) four times, changing exactly
 * one or two levers at a time, so each row isolates what that lever alone
 * did instead of conflating both changes into a single before/after
 * number:
 *
 *   strict        minScore=78  softGates=false   (pre-change baseline)
 *   soft_only     minScore=78  softGates=true     (isolates the gate softening)
 *   lowscore_only minScore=65  softGates=false     (isolates the score drop)
 *   current       minScore=65  softGates=true     (today's actual live default)
 *
 * Usage — same data flags as backtest/run.js:
 *   node backtest/compare-gates.js --symbol BTCUSDT --timeframe H1 --htf H4 --from 2025-01-01 --to 2025-12-31
 *   node backtest/compare-gates.js --csv ./data/EURUSD_H1.csv --symbol EURUSD --timeframe H1
 *   node backtest/compare-gates.js --synthetic --symbol BTCUSDT --candles 3000   (ENGINE SELF-TEST ONLY, not a real answer)
 *
 * --configs lets you override the grid entirely with your own JSON, e.g.:
 *   --configs '[{"name":"65/soft","minScore":65,"softGates":true},{"name":"70/hard","minScore":70,"softGates":false}]'
 *
 * IMPORTANT: like run.js, --symbol without --csv/--synthetic needs real
 * internet access to Binance and will not run inside a network-sandboxed
 * environment — run it on your own machine, a VPS, or on Render itself.
 * Every row here uses IDENTICAL candle data (loaded once, reused for all
 * configs) so the comparison isn't contaminated by different data windows.
 */

const path = require('path');
const fs = require('fs');
const { BacktestEngine } = require('./engine');
const { computeStats } = require('./stats');
const { fetchBinanceKlines, loadCSV, generateSyntheticCandles } = require('./data-loader');

const DEFAULT_GRID = [
  { name: 'strict (pre-change)', minScore: 78, softGates: false },
  { name: 'soft gates only',     minScore: 78, softGates: true },
  { name: 'lower score only',    minScore: 65, softGates: false },
  { name: 'current (both)',      minScore: 65, softGates: true },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

// Two-proportion z-test on win rate, so the report can flag "this
// difference is small-sample noise" instead of implying every row is
// equally trustworthy just because it printed a number. Backtests
// routinely produce too few trades for their win-rate gap to mean
// anything — this makes that visible instead of hiding it.
function winRateSignificance(a, b) {
  const n1 = a.totalTrades, n2 = b.totalTrades;
  if (!n1 || !n2 || n1 < 5 || n2 < 5) return { z: null, pLt05: false, note: 'too few trades to test' };
  const p1 = a.wins / n1, p2 = b.wins / n2;
  const pPool = (a.wins + b.wins) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pLt05: false, note: 'no variance' };
  const z = (p1 - p2) / se;
  return { z: round(z, 2), pLt05: Math.abs(z) >= 1.96, note: Math.abs(z) >= 1.96 ? 'significant at p<0.05' : 'not significant at p<0.05' };
}

function round(n, d = 2) { return Math.round(n * 10 ** d) / 10 ** d; }

async function loadAllCandles(args) {
  const symbols = (args.symbol || 'BTCUSDT').split(',').map(s => s.trim());
  const timeframe = args.timeframe || 'H1';
  const htfList = (args.htf || '').split(',').map(s => s.trim()).filter(Boolean);
  const perSymbol = {};

  for (const symbol of symbols) {
    let candles, htfCandles = {};
    if (args.synthetic) {
      console.log(`[data] Generating synthetic data for ${symbol} (ENGINE SELF-TEST ONLY — not real market data)`);
      const opts = {
        startPrice: symbol.includes('XAU') ? 2000 : symbol.includes('BTC') ? 60000 : 1.1,
        volatility: symbol.includes('BTC') ? 0.012 : 0.004,
      };
      candles = generateSyntheticCandles(parseInt(args.candles || '3000', 10), opts);
      for (const htf of htfList) {
        htfCandles[htf] = generateSyntheticCandles(Math.ceil(parseInt(args.candles || '3000', 10) / 4), { ...opts, intervalMs: 4 * 3600_000 });
      }
    } else if (args.csv) {
      console.log(`[data] Loading ${symbol} from CSV: ${args.csv}`);
      candles = loadCSV(path.resolve(args.csv));
    } else {
      const from = args.from ? new Date(args.from).getTime() : Date.now() - 180 * 86400_000;
      const to = args.to ? new Date(args.to).getTime() : Date.now();
      console.log(`[data] Fetching ${symbol} ${timeframe} from Binance: ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);
      candles = await fetchBinanceKlines(symbol, timeframe, from, to);
      for (const htf of htfList) {
        console.log(`[data] Fetching ${symbol} ${htf} (HTF context)...`);
        htfCandles[htf] = await fetchBinanceKlines(symbol, htf, from, to);
      }
    }
    console.log(`[data] Loaded ${candles.length} candles for ${symbol}`);
    perSymbol[symbol] = { candles, htfCandles };
  }
  return { symbols, timeframe, htfList, perSymbol };
}

async function runConfig(cfg, loaded, sharedOpts) {
  const engine = new BacktestEngine({
    symbols: loaded.symbols,
    timeframe: loaded.timeframe,
    accountBalance: sharedOpts.balance,
    riskPct: sharedOpts.riskPct,
    minScore: cfg.minScore,
    softGates: cfg.softGates,
    requireKillzone: cfg.requireKillzone ?? false,
  });
  for (const symbol of loaded.symbols) {
    const { candles, htfCandles } = loaded.perSymbol[symbol];
    engine.loadCandles(symbol, loaded.timeframe, candles);
    for (const [htf, hc] of Object.entries(htfCandles)) engine.loadCandles(symbol, htf, hc);
  }
  const result = await engine.run();
  const stats = computeStats(result.trades, result.equityCurve, sharedOpts.balance);
  return { config: cfg, stats, rejections: result.rejections };
}

function printComparisonTable(rows) {
  const cols = [
    ['Config', r => r.config.name],
    ['minScore', r => r.config.minScore],
    ['softGates', r => r.config.softGates ? 'on' : 'off'],
    ['Trades', r => r.stats.totalTrades ?? 0],
    ['WinRate', r => r.stats.totalTrades ? `${r.stats.winRate}%` : '—'],
    ['ProfitFactor', r => r.stats.totalTrades ? r.stats.profitFactor : '—'],
    ['ExpectancyR', r => r.stats.totalTrades ? r.stats.expectancyR : '—'],
    ['MaxDD%', r => r.stats.totalTrades ? r.stats.maxDrawdownPct : '—'],
    ['Sharpe~', r => r.stats.totalTrades ? r.stats.sharpeApprox : '—'],
    ['Return%', r => r.stats.totalTrades ? r.stats.totalReturnPct : '—'],
  ];
  const widths = cols.map(([label], i) => Math.max(label.length, ...rows.map(r => String(cols[i][1](r)).length)) + 2);
  console.log('\n' + '═'.repeat(widths.reduce((a, b) => a + b, 0)));
  console.log('  OMNICEE GATE COMPARISON — same candles, four configs');
  console.log('═'.repeat(widths.reduce((a, b) => a + b, 0)));
  console.log(cols.map(([label], i) => label.padEnd(widths[i])).join(''));
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0)));
  for (const r of rows) {
    console.log(cols.map(([, fn], i) => String(fn(r)).padEnd(widths[i])).join(''));
  }
  console.log('');

  // Headline comparison: current (both changes) vs strict (pre-change baseline).
  const current = rows.find(r => r.config.name.includes('current'));
  const strict = rows.find(r => r.config.name.includes('strict'));
  const softOnly = rows.find(r => r.config.name.includes('soft gates only'));
  const lowOnly = rows.find(r => r.config.name.includes('lower score only'));
  if (current && strict && current.stats.totalTrades && strict.stats.totalTrades) {
    const sig = winRateSignificance(current.stats, strict.stats);
    console.log('Current (65 + soft) vs strict baseline (78 + hard):');
    console.log(`  Expectancy:  ${current.stats.expectancyR}R vs ${strict.stats.expectancyR}R per trade`);
    console.log(`  ProfitFactor: ${current.stats.profitFactor} vs ${strict.stats.profitFactor}`);
    console.log(`  Trade volume: ${current.stats.totalTrades} vs ${strict.stats.totalTrades} (${current.stats.totalTrades > strict.stats.totalTrades ? 'more' : 'fewer'} trades under softening)`);
    console.log(`  Win-rate gap significance: z=${sig.z ?? 'n/a'} — ${sig.note}`);
  }
  if (softOnly && lowOnly && softOnly.stats.totalTrades && lowOnly.stats.totalTrades) {
    console.log('\nWhich lever moved the needle more:');
    console.log(`  Soft gates alone:   ${softOnly.stats.expectancyR}R expectancy, ${softOnly.stats.totalTrades} trades`);
    console.log(`  Lower score alone:  ${lowOnly.stats.expectancyR}R expectancy, ${lowOnly.stats.totalTrades} trades`);
  }
  console.log(`
Read this with real skepticism, not just the headline row:
  - Trade counts under ~30 make win rate and Sharpe unreliable — treat any
    row like that as directional, not conclusive.
  - This is one candle window. Rerun across several non-overlapping date
    ranges (or several symbols) before trusting any single verdict — a
    softer gate that looks better on one 6-month window can easily be
    curve-fit to that window's regime mix.
  - "More trades, similar expectancy" is not neutral: more trades means
    more spread/slippage paid in reality than this simulator charges (it
    doesn't model spread/commission yet — see the README's Known Gaps).
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const balance = parseFloat(args.balance || '10000');
  const riskPct = parseFloat(args.risk || '1.0');

  const grid = args.configs ? JSON.parse(args.configs) : DEFAULT_GRID;
  const loaded = await loadAllCandles(args);

  console.log(`\n[engine] Running ${grid.length} configs over identical candle data...\n`);
  const rows = [];
  for (const cfg of grid) {
    process.stdout.write(`  [${cfg.name}] minScore=${cfg.minScore} softGates=${cfg.softGates} ... `);
    const t0 = Date.now();
    const row = await runConfig(cfg, loaded, { balance, riskPct });
    console.log(`${row.stats.totalTrades ?? 0} trades in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    rows.push(row);
  }

  printComparisonTable(rows);

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
    console.log(`Full results written to ${outPath}`);
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
