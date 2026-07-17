'use strict';
/**
 * backtest/stats.js
 * Computes standard trading performance statistics from a closed-trade list.
 */

function computeStats(trades, equityCurve, startBalance) {
  if (!trades.length) {
    return { totalTrades: 0, message: 'No trades were fired during this backtest window.' };
  }

  const wins = trades.filter(t => t.pnlR > 0);
  const losses = trades.filter(t => t.pnlR <= 0);
  const winRate = wins.length / trades.length;

  const grossWinR = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossLossR = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const profitFactor = grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? Infinity : 0);

  const avgWinR = wins.length ? grossWinR / wins.length : 0;
  const avgLossR = losses.length ? grossLossR / losses.length : 0;
  const expectancyR = trades.reduce((s, t) => s + t.pnlR, 0) / trades.length;

  // Max drawdown from the equity curve (peak-to-trough, in %).
  let peak = startBalance, maxDD = 0;
  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const dd = ((peak - point.balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Simple Sharpe-like ratio on the per-trade pnlPct series (not annualized —
  // meaningful only as a relative comparison between backtest runs, not as
  // a formal annualized Sharpe ratio).
  const pnlPcts = trades.map(t => t.pnlPct);
  const meanPct = pnlPcts.reduce((s, v) => s + v, 0) / pnlPcts.length;
  const variance = pnlPcts.reduce((s, v) => s + (v - meanPct) ** 2, 0) / pnlPcts.length;
  const stdDev = Math.sqrt(variance);
  const sharpeApprox = stdDev > 0 ? (meanPct / stdDev) * Math.sqrt(trades.length) : 0;

  const bySymbol = groupStats(trades, t => t.symbol);
  const byGrade = groupStats(trades, t => t.grade || 'UNGRADED');
  const byDirection = groupStats(trades, t => t.direction);
  // Doc item 47 (Scenario Simulator): "trending, ranging, volatile,
  // low-volatility" — bucketing this single run's trades by the regime
  // active at each trade's entry answers the same question a suite of
  // separate curated-window backtests would, without needing to hunt down
  // and hand-pick historical date ranges for each scenario.
  const byMarketStructure  = groupStats(trades, t => t.structure  || 'UNKNOWN'); // DIRECTIONAL / RANGE / CHOP
  const byVolatilityRegime = groupStats(trades, t => t.volatility || 'UNKNOWN'); // EXPANSION / NORMAL / COMPRESSION

  const finalBalance = equityCurve.length ? equityCurve[equityCurve.length - 1].balance : startBalance;
  const totalReturnPct = ((finalBalance - startBalance) / startBalance) * 100;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate * 100, 2),
    profitFactor: round(profitFactor, 2),
    expectancyR: round(expectancyR, 3),
    avgWinR: round(avgWinR, 3),
    avgLossR: round(avgLossR, 3),
    maxDrawdownPct: round(maxDD, 2),
    sharpeApprox: round(sharpeApprox, 2),
    startBalance: round(startBalance, 2),
    finalBalance: round(finalBalance, 2),
    totalReturnPct: round(totalReturnPct, 2),
    bySymbol,
    byGrade,
    byDirection,
    byMarketStructure,
    byVolatilityRegime,
  };
}

function groupStats(trades, keyFn) {
  const groups = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  }
  const out = {};
  for (const [k, list] of Object.entries(groups)) {
    const wins = list.filter(t => t.pnlR > 0).length;
    out[k] = {
      trades: list.length,
      winRate: round((wins / list.length) * 100, 1),
      avgR: round(list.reduce((s, t) => s + t.pnlR, 0) / list.length, 3),
    };
  }
  return out;
}

function round(n, d) { return Math.round(n * 10 ** d) / 10 ** d; }

function printReport(stats, rejections) {
  if (stats.totalTrades === 0) {
    console.log('\n' + stats.message + '\n');
    if (rejections) console.log('Rejection breakdown:', JSON.stringify(rejections, null, 2));
    return;
  }
  console.log(`
═══════════════════════════════════════════════════
  OMNICEE BACKTEST REPORT
═══════════════════════════════════════════════════
  Total Trades:        ${stats.totalTrades}  (${stats.wins}W / ${stats.losses}L)
  Win Rate:             ${stats.winRate}%
  Profit Factor:        ${stats.profitFactor}
  Expectancy:           ${stats.expectancyR}R per trade
  Avg Win / Avg Loss:   ${stats.avgWinR}R / -${stats.avgLossR}R
  Max Drawdown:         ${stats.maxDrawdownPct}%
  Sharpe (approx):      ${stats.sharpeApprox}
───────────────────────────────────────────────────
  Start Balance:        $${stats.startBalance}
  Final Balance:        $${stats.finalBalance}
  Total Return:         ${stats.totalReturnPct}%
═══════════════════════════════════════════════════

By Symbol:`);
  for (const [sym, s] of Object.entries(stats.bySymbol)) {
    console.log(`  ${sym.padEnd(10)} ${s.trades} trades, ${s.winRate}% WR, ${s.avgR}R avg`);
  }
  console.log('\nBy Grade:');
  for (const [g, s] of Object.entries(stats.byGrade)) {
    console.log(`  ${g.padEnd(10)} ${s.trades} trades, ${s.winRate}% WR, ${s.avgR}R avg`);
  }
  console.log('\nScenario Simulator — By Market Structure (trending / ranging / choppy):');
  for (const [k, s] of Object.entries(stats.byMarketStructure || {})) {
    console.log(`  ${k.padEnd(12)} ${s.trades} trades, ${s.winRate}% WR, ${s.avgR}R avg`);
  }
  console.log('\nScenario Simulator — By Volatility Regime (expansion / normal / compression):');
  for (const [k, s] of Object.entries(stats.byVolatilityRegime || {})) {
    console.log(`  ${k.padEnd(12)} ${s.trades} trades, ${s.winRate}% WR, ${s.avgR}R avg`);
  }
  if (rejections) {
    console.log('\nSignals filtered out before firing (this is normal — it means the risk/quality gates are doing their job):');
    console.log(`  Gate rejected:        ${rejections.gate}`);
    console.log(`  Correlation blocked:  ${rejections.correlation}`);
    console.log(`  Session blocked:      ${rejections.session}`);
    console.log(`  Drawdown blocked:     ${rejections.drawdown}`);
    console.log(`  Entry/risk failed:    ${rejections.entryFailed}`);
    console.log(`  No signal (WAIT):     ${rejections.noSignal}`);
  }
  console.log('');
}

function printWalkForwardReport(wf) {
  if (!wf) return;
  if (!wf.sufficient) {
    console.log(`\nWalk-Forward Validation: ${wf.note}\n`);
    return;
  }
  console.log(`
───────────────────────────────────────────────────
  WALK-FORWARD VALIDATION
───────────────────────────────────────────────────
  Walk-Forward Efficiency (WFE): ${wf.wfe}  ${wf.robust ? '(robust)' : '(below robustness threshold)'}
  Needs Recalibration:  ${wf.needsRecalibration ? 'YES' : 'no'}

  In-Sample  (${wf.inSample.count} trades):  ${round(wf.inSample.winRate * 100, 1)}% WR, ${wf.inSample.expectancy}R expectancy, Sharpe ${wf.inSample.sharpe}
  Out-of-Sample (${wf.outOfSample.count} trades): ${round(wf.outOfSample.winRate * 100, 1)}% WR, ${wf.outOfSample.expectancy}R expectancy, Sharpe ${wf.outOfSample.sharpe}
`);
  if (wf.degradation?.degrading) {
    console.log(`  ⚠ Performance degradation detected: ${wf.degradation.reason || ''}`);
  }
  if (wf.reasons?.length) {
    console.log('  Notes:');
    for (const r of wf.reasons) console.log(`    - ${r}`);
  }
  console.log('───────────────────────────────────────────────────\n');
}

module.exports = { computeStats, printReport, printWalkForwardReport };
