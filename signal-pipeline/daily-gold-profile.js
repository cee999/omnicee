'use strict';

/**
 * Daily gold (XAU) trader profile — derived from live Exness history
 * (account 223847775, Jul 2026–Aug 2026 sample):
 *
 *  - 159/159 trades were XAUUSDm
 *  - Median hold ~7 minutes (scalp), peak hours UTC 14–16 and 19
 *  - Win rate ~57% but negative expectancy: avg win +4.26 vs avg loss −6.24
 *  - Only 4 TP hits vs 33 SL; 7 stop-outs alone ≈ −$146 (account killers)
 *  - BUY side +$36.55 (WR 65.6%); SELL side −$72.98 (WR 52%)
 *  - Max consecutive losses: 7
 *
 * This module does NOT auto-trade. It annotates / soft-gates signal output
 * so the desk protects a daily scalper on gold.
 */

const GOLD_RE = /XAU|GOLD/i;

const PROFILE = {
  symbolFocus: 'XAUUSD',
  preferredTimeframes: ['M15', 'M5', 'H1'],
  // Empirical edge from sample (not a guarantee)
  sampleWinRate: 0.57,
  sampleAvgWin: 4.26,
  sampleAvgLoss: -6.24,
  sampleBuyWinRate: 0.656,
  sampleSellWinRate: 0.52,
  peakUtcHours: [14, 15, 16, 19],
  // Soft risk defaults for small / daily accounts
  maxConsecLossWarn: 3,
  maxConsecLossBlock: 5,
  maxTradesPerDayWarn: 12,
  maxTradesPerDayBlock: 20,
  requireStopLoss: true,
  minRewardRisk: 1.2,
  // Prefer not stacking market sells after recent sell losses
  sellCautionAfterLosses: 2,
};

function isGoldSymbol(symbol) {
  return GOLD_RE.test(String(symbol || ''));
}

function utcHour(ts = Date.now()) {
  return new Date(ts).getUTCHours();
}

function inPeakGoldSession(ts = Date.now()) {
  const h = utcHour(ts);
  return PROFILE.peakUtcHours.includes(h) || (h >= 13 && h < 17) || (h >= 18 && h < 21);
}

/**
 * @param {object} ctx
 * @param {string} ctx.symbol
 * @param {string} ctx.action  BUY|SELL
 * @param {number} [ctx.score]
 * @param {object} [ctx.tradePlan]
 * @param {object} [ctx.drawdownStatus] from drawdownGuard.getStatus()
 * @param {Array}  [ctx.recentOutcomes] [{action, profit, closeReason}]
 */
function evaluateGoldDesk(ctx = {}) {
  const symbol = ctx.symbol || '';
  const action = String(ctx.action || '').toUpperCase();
  const notes = [];
  const warnings = [];
  let softBlock = false;
  let hardBlock = false;
  let sizeMult = 1;

  if (!isGoldSymbol(symbol)) {
    return {
      applies: false,
      softBlock: false,
      hardBlock: false,
      sizeMult: 1,
      notes: [],
      warnings: [],
      profile: PROFILE,
    };
  }

  notes.push('Gold desk mode: scalp profile (median hold ~minutes, not swing)');

  if (!inPeakGoldSession(ctx.timestamp || Date.now())) {
    warnings.push('Outside peak gold hours (UTC 13–16 / 18–21) — thinner edge historically');
    sizeMult *= 0.75;
  } else {
    notes.push('Inside active London/NY gold window');
  }

  // Historical sample: sells underperformed buys
  if (action === 'SELL') {
    warnings.push('Sample edge: BUY side outperformed SELL on this book — require stronger structure for sells');
    sizeMult *= 0.85;
  }

  const plan = ctx.tradePlan || {};
  const hasSL = plan.stopLoss != null || plan.sl != null || (ctx.signal && ctx.signal.stopLoss != null);
  if (PROFILE.requireStopLoss && !hasSL) {
    warnings.push('No stop-loss on plan — stop-outs destroyed equity in sample history; set SL before entry');
    softBlock = true;
  }

  const rr = Number(plan.rewardRisk || plan.rr || plan.risk?.rr || 0);
  if (rr > 0 && rr < PROFILE.minRewardRisk) {
    warnings.push(`R:R ${rr.toFixed(2)} below ${PROFILE.minRewardRisk} — sample losses averaged larger than wins`);
    sizeMult *= 0.8;
  }

  const dd = ctx.drawdownStatus || {};
  const consec = Number(dd.consecLoss ?? dd.consecutiveLosses ?? dd.daily?.consecLoss ?? 0);
  if (consec >= PROFILE.maxConsecLossBlock) {
    hardBlock = true;
    warnings.push(`Hard pause: ${consec} consecutive losses (sample max streak was 7 — protect capital)`);
  } else if (consec >= PROFILE.maxConsecLossWarn) {
    softBlock = true;
    sizeMult *= 0.5;
    warnings.push(`Cooling: ${consec} consecutive losses — cut size or sit out`);
  }

  const tradesToday = Number(dd.daily?.trades ?? dd.tradesToday ?? 0);
  if (tradesToday >= PROFILE.maxTradesPerDayBlock) {
    hardBlock = true;
    warnings.push(`Daily trade cap ${PROFILE.maxTradesPerDayBlock} reached — overtrading risk`);
  } else if (tradesToday >= PROFILE.maxTradesPerDayWarn) {
    warnings.push(`High trade count today (${tradesToday}) — quality over quantity`);
    sizeMult *= 0.7;
  }

  const recent = Array.isArray(ctx.recentOutcomes) ? ctx.recentOutcomes : [];
  const recentSellLosses = recent
    .filter((o) => String(o.action || '').toUpperCase() === 'SELL' && Number(o.profit) < 0)
    .slice(0, 5);
  if (action === 'SELL' && recentSellLosses.length >= PROFILE.sellCautionAfterLosses) {
    warnings.push('Recent sell losses on gold — avoid stacking market sells');
    softBlock = true;
    sizeMult *= 0.6;
  }

  const stopOuts = recent.filter((o) => String(o.closeReason || '').toLowerCase() === 'so');
  if (stopOuts.length > 0) {
    warnings.push('Recent stop-out on book — reduce risk until equity stabilizes');
    sizeMult *= 0.5;
    softBlock = true;
  }

  notes.push('Always use SL; prefer TP or structured exit over hope; 0.01 lot is fine until equity recovers');

  return {
    applies: true,
    softBlock,
    hardBlock,
    sizeMult: Math.max(0.25, Math.min(1, sizeMult)),
    notes,
    warnings,
    profile: PROFILE,
    sessionPeak: inPeakGoldSession(ctx.timestamp || Date.now()),
  };
}

function annotateSignal(signal, evalResult) {
  if (!signal || !evalResult?.applies) return signal;
  const reasons = Array.isArray(signal.reasons) ? [...signal.reasons] : [];
  for (const w of evalResult.warnings || []) reasons.push(w);
  for (const n of (evalResult.notes || []).slice(0, 2)) reasons.push(n);
  return {
    ...signal,
    reasons,
    goldDesk: {
      softBlock: evalResult.softBlock,
      hardBlock: evalResult.hardBlock,
      sizeMult: evalResult.sizeMult,
      sessionPeak: evalResult.sessionPeak,
      warnings: evalResult.warnings,
    },
    riskFlags: {
      ...(signal.riskFlags || {}),
      goldDeskSoftBlock: !!evalResult.softBlock,
      goldDeskHardBlock: !!evalResult.hardBlock,
      goldSizeMult: evalResult.sizeMult,
    },
  };
}

module.exports = {
  PROFILE,
  isGoldSymbol,
  inPeakGoldSession,
  evaluateGoldDesk,
  annotateSignal,
};
