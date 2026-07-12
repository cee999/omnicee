#!/usr/bin/env node
'use strict';
/**
 * backtest/run.js
 *
 * CLI to run an OMNICEE backtest against historical data.
 *
 * Usage:
 *   node backtest/run.js --symbol BTCUSDT --timeframe H1 --htf H4,D1 --from 2025-01-01 --to 2025-12-31
 *   node backtest/run.js --symbol BTCUSDT,XAUUSD --timeframe H1 --htf H4 --from 2025-06-01 --to 2025-07-01 --balance 5000 --risk 1.5
 *   node backtest/run.js --csv ./data/EURUSD_H1.csv --symbol EURUSD --timeframe H1
 *   node backtest/run.js --synthetic --symbol BTCUSDT --timeframe H1 --htf H4 --candles 2000   (engine self-test, NOT real data)
 *
 * --htf lets the MTF agent see higher-timeframe structure (e.g. H4/D1)
 * alongside your primary trading timeframe — without it, MTFAgent only has
 * one timeframe to look at and will always return WAIT (it needs 2+ to do
 * multi-timeframe analysis at all), so no signals will ever fire.
 *
 * NOTE: --symbol without --csv/--synthetic fetches from Binance's public REST
 * API, which requires real internet access. This will not work from a
 * network-sandboxed environment — run it on your own machine, a VPS, or
 * directly on Render after deployment.
 */

const path = require('path');
const fs = require('fs');
const { BacktestEngine } = require('./engine');
const { computeStats, printReport, printWalkForwardReport } = require('./stats');
const { fetchBinanceKlines, loadCSV, generateSyntheticCandles } = require('./data-loader');

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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const symbols = (args.symbol || 'BTCUSDT').split(',').map(s => s.trim());
  const timeframe = args.timeframe || 'H1';
  const balance = parseFloat(args.balance || '10000');
  const riskPct = parseFloat(args.risk || '1.0');
  const maxDailyLossPct = parseFloat(args.maxDailyLoss || '3.0');
  const maxDrawdownPct = parseFloat(args.maxDrawdown || '10.0');
  const minScore = parseFloat(args.minScore || '75');

  console.log(`\nOMNICEE Backtest — symbols=[${symbols.join(', ')}] timeframe=${timeframe} balance=$${balance} risk=${riskPct}%\n`);

  const engine = new BacktestEngine({
    symbols, timeframe, accountBalance: balance, riskPct, maxDailyLossPct, maxDrawdownPct, minScore,
  });

  for (const symbol of symbols) {
    let candles;

    if (args.synthetic) {
      console.log(`[data] Generating synthetic test data for ${symbol} (ENGINE SELF-TEST ONLY — not real market data)...`);
      candles = generateSyntheticCandles(parseInt(args.candles || '1500', 10), {
        startPrice: symbol.includes('XAU') ? 2000 : symbol.includes('BTC') ? 60000 : 1.1,
        volatility: symbol.includes('BTC') ? 0.012 : 0.004,
      });
    } else if (args.csv) {
      console.log(`[data] Loading ${symbol} from CSV: ${args.csv}`);
      candles = loadCSV(path.resolve(args.csv));
    } else {
      const from = args.from ? new Date(args.from).getTime() : Date.now() - 180 * 86400_000;
      const to = args.to ? new Date(args.to).getTime() : Date.now();
      console.log(`[data] Fetching ${symbol} ${timeframe} from Binance: ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);
      candles = await fetchBinanceKlines(symbol, timeframe, from, to);
    }

    console.log(`[data] Loaded ${candles.length} candles for ${symbol}`);
    if (candles.length < 50) {
      console.warn(`[warn] ${symbol}: fewer than 50 candles loaded — this symbol will produce no signals (minimum lookback not met).`);
    }
    engine.loadCandles(symbol, timeframe, candles);

    // MTFAgent requires 2+ timeframes to do anything but return WAIT — load
    // higher-timeframe context too (e.g. --htf H4,D1) so results reflect
    // real multi-timeframe confluence instead of an agent that can never fire.
    const htfList = (args.htf || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const htf of htfList) {
      let htfCandles;
      if (args.synthetic) {
        htfCandles = generateSyntheticCandles(Math.ceil(parseInt(args.candles || '1500', 10) / 4), {
          startPrice: symbol.includes('XAU') ? 2000 : symbol.includes('BTC') ? 60000 : 1.1,
          volatility: symbol.includes('BTC') ? 0.012 : 0.004,
          intervalMs: 4 * 3600_000,
        });
      } else if (args.csv) {
        console.warn(`[warn] --htf with --csv requires a separate CSV per timeframe; skipping ${htf} (not supported in this simple loader).`);
        continue;
      } else {
        const from = args.from ? new Date(args.from).getTime() : Date.now() - 180 * 86400_000;
        const to = args.to ? new Date(args.to).getTime() : Date.now();
        console.log(`[data] Fetching ${symbol} ${htf} (HTF context) from Binance...`);
        htfCandles = await fetchBinanceKlines(symbol, htf, from, to);
      }
      console.log(`[data] Loaded ${htfCandles.length} HTF candles (${htf}) for ${symbol}`);
      engine.loadCandles(symbol, htf, htfCandles);
    }
  }

  console.log('\n[engine] Running replay...\n');
  const t0 = Date.now();
  const result = await engine.run();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[engine] Replay complete in ${elapsed}s. ${result.trades.length} trades fired.\n`);

  const stats = computeStats(result.trades, result.equityCurve, balance);
  printReport(stats, result.rejections);
  printWalkForwardReport(result.walkForward);

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, JSON.stringify({ stats, trades: result.trades, equityCurve: result.equityCurve, rejections: result.rejections, walkForward: result.walkForward }, null, 2));
    console.log(`Full results written to ${outPath}`);
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
