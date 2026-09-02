'use strict';

/**
 * Daily gold (XAU) trader profile — derived from live Exness history
 * account 223847775 (2026 Jul 26 – Aug 27 statement + CSV).
 *
 * Empirical facts (159 XAUUSDm trades, 14 sessions):
 *  - Win rate 57.2% but profit factor 0.91 (avg win +4.26 vs avg loss −6.24)
 *  - Close reasons: user 115 | SL 33 | SO 7 | TP 4  → exits are mostly discretionary
 *  - SL present on only ~34% of trades; stop-outs alone wiped large equity chunks
 *  - Median hold ~6.8 min (scalp); p90 ~58 min
 *  - Avg ~11 trades/day; worst day Aug 27: 30 trades, −$40
 *  - Max consecutive losses: 7
 *  - BUY side historically stronger than SELL on this book
 *
 * FinceptTerminal techniques adapted:
 *  - OrderValidator-style hard requirements (SL mandatory, RR floor)
 *  - PositionManager streak / daily trade caps
 *  - Session-aware sizing (London/NY overlap)
 *
 * MiroFish techniques adapted:
 *  - Pre-fire "swarm rehearsal" consensus gate before FIRE is trusted
 *  - Persona caution after loss streaks (do not stack same-direction losers)
 *
 * This module does NOT auto-trade. It annotates / soft-gates signal output
 * so the desk protects a daily scalper on gold.
 */

const GOLD_RE = /XAU|GOLD/i;

const PROFILE = {
  symbolFocus: 'XAUUSD',
  preferredTimeframes: ['M5', 'M15', 'H1'],
  sampleWinRate: 0.572,
  sampleAvgWin: 4.26,
  sampleAvgLoss: -6.24,
  sampleProfitFactor: 0.91,
  sampleBuyWinRate: 0.656,
  sampleSellWinRate: 0.52,
  sampleTpHits: 4,
  sampleSlHits: 33,
  sampleStopOuts: 7,
  peakUtcHours: [13, 14, 15, 16, 18, 19, 20],
  // Stricter than previous defaults — Aug 27 (30 trades) is the anti-pattern
  maxConsecLossWarn: 2,
  maxConsecLossBlock: 4,
  maxTradesPerDayWarn: 8,
  maxTradesPerDayBlock: 12,
  maxTradesPerHourBlock: 4,
  requireStopLoss: true,
  minRewardRisk: 1.5,
  minScoreForFire: 65,
  minAgentConsensus: 0.55,
  sellCautionAfterLosses: 2,
  cooldownMinutesAfterStopOut: 45,
  cooldownMinutesAfterConsecLoss: 20,
  maxRiskPctPerTrade: 1.0,
  preferTpOverManual: true,
};

function isGoldSymbol(symbol) {
  return GOLD_RE.test(String(symbol || ''));
}

function utcHour(ts = Date.now()) {
  return new Date(ts).getUTCHours();
}

function inPeakGoldSession(ts = Date.now()) {
  const h = utcHour(ts);
  return PROFILE.peakUtcHours.includes(h);
}

/**
 * MiroFish-inspired: lightweight swarm rehearsal score from agent votes.
 * Returns 0–1 consensus quality; does not call external LLMs.
 */
function swarmRehearsal(agents, action) {
  const list = Array.isArray(agents) ? agents : [];
  if (!list.length) return { consensus: 0, aligned: 0, total: 0, note: 'No agent votes' };
  const dir = String(action || '').toUpperCase();
  let aligned = 0;
  let scoreSum = 0;
  for (const a of list) {
    const ad = String(a.direction || a.action || '').toUpperCase();
    const sc = Number(a.score) || 0;
    if (ad === dir || (dir === 'BUY' && ad === 'LONG') || (dir === 'SELL' && ad === 'SHORT')) {
      aligned += 1;
      scoreSum += sc;
    }
  }
  const consensus = aligned / list.length;
  const avgAligned = aligned ? scoreSum / aligned : 0;
  return {
    consensus: Math.round(consensus * 1000) / 1000,
    aligned,
    total: list.length,
    avgAlignedScore: Math.round(avgAligned * 10) / 10,
    note: `${aligned}/${list.length} agents aligned (${Math.round(consensus * 100)}%)`,
  };
}

/**
 * Fincept-inspired order validation for manual desk (no broker send).
 */
function priceOf(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'object') {
    const n = Number(v.price ?? v.midPoint ?? v.midpoint ?? v.zoneLow);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validateOrderPlan(plan = {}, signal = {}) {
  const failures = [];
  const warnings = [];
  const entry = priceOf(plan.entry?.midPoint ?? plan.entry?.midpoint ?? plan.entry)
    ?? priceOf(signal.entry);
  const sl = priceOf(plan.stopLoss) ?? priceOf(plan.sl) ?? priceOf(signal.stopLoss);
  const tp = priceOf(plan.targets?.tp1) ?? priceOf(plan.takeProfit) ?? priceOf(plan.tp1)
    ?? priceOf(Array.isArray(signal.targets) ? signal.targets[0] : signal.targets?.tp1);
  const action = String(signal.action || plan.action || '').toUpperCase();

  if (!Number.isFinite(entry) || entry <= 0) failures.push('Entry price missing or invalid');
  if (!Number.isFinite(sl) || sl <= 0) failures.push('Stop-loss required (Fincept OrderValidator rule)');
  if (!Number.isFinite(tp) || tp <= 0) warnings.push('No TP — discretionary exits dominated sample losses');

  if (Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(tp)) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    if (risk <= 0) failures.push('Zero risk distance');
    else {
      const rr = reward / risk;
      if (rr < PROFILE.minRewardRisk) {
        failures.push(`R:R ${rr.toFixed(2)} < ${PROFILE.minRewardRisk} minimum`);
      }
      if (action === 'BUY' && !(sl < entry && tp > entry)) failures.push('BUY geometry invalid (SL < entry < TP)');
      if (action === 'SELL' && !(sl > entry && tp < entry)) failures.push('SELL geometry invalid (TP < entry < SL)');
    }
  }
  return { ok: failures.length === 0, failures, warnings, entry, sl, tp };
}

/**
 * @param {object} ctx
 * @param {string} ctx.symbol
 * @param {string} ctx.action  BUY|SELL
 * @param {number} [ctx.score]
 * @param {object} [ctx.tradePlan]
 * @param {object} [ctx.signal]
 * @param {object} [ctx.drawdownStatus]
 * @param {Array}  [ctx.recentOutcomes]
 * @param {Array}  [ctx.agents]
 * @param {number} [ctx.tradesLastHour]
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
      swarm: null,
      orderValidation: null,
    };
  }

  notes.push('Gold desk: daily scalp profile (median hold ~7m; protect small equity)');

  if (!inPeakGoldSession(ctx.timestamp || Date.now())) {
    warnings.push('Outside peak gold hours (UTC 13–16 / 18–20) — thinner edge historically');
    sizeMult *= 0.7;
  } else {
    notes.push('Inside London/NY gold window');
  }

  if (action === 'SELL') {
    warnings.push('Sample edge: BUY outperformed SELL on this book — require stronger structure for sells');
    sizeMult *= 0.8;
  }

  const score = Number(ctx.score ?? ctx.signal?.score?.final ?? ctx.signal?.score ?? 0);
  if (score > 0 && score < PROFILE.minScoreForFire) {
    softBlock = true;
    warnings.push(`Score ${score} below daily-trader floor ${PROFILE.minScoreForFire}`);
    sizeMult *= 0.5;
  }

  const swarm = swarmRehearsal(ctx.agents || ctx.signal?.agents, action);
  if (swarm.total > 0 && swarm.consensus < PROFILE.minAgentConsensus) {
    softBlock = true;
    warnings.push(`Swarm consensus ${Math.round(swarm.consensus * 100)}% < ${Math.round(PROFILE.minAgentConsensus * 100)}% (MiroFish-style rehearsal)`);
    sizeMult *= 0.6;
  } else if (swarm.total > 0) {
    notes.push(swarm.note);
  }

  const orderValidation = validateOrderPlan(ctx.tradePlan || {}, ctx.signal || {});
  // Geometry / missing SL → soft only. Capital limits remain hard below.
  if (!orderValidation.ok) {
    softBlock = true;
    sizeMult *= 0.5;
    for (const f of orderValidation.failures) warnings.push(f);
  } else {
    for (const w of orderValidation.warnings) warnings.push(w);
  }

  const plan = ctx.tradePlan || {};
  const sig = ctx.signal || {};
  const slPrice = orderValidation.sl
    ?? priceOf(plan.stopLoss) ?? priceOf(plan.sl) ?? priceOf(sig.stopLoss);
  const hasSL = Number.isFinite(Number(slPrice)) && Number(slPrice) > 0;
  if (PROFILE.requireStopLoss && !hasSL) {
    warnings.push('No stop-loss — stop-outs destroyed equity in sample; set SL before entry');
    softBlock = true;
    sizeMult *= 0.5;
  }

  const rr = Number(plan.rewardRisk || plan.rr || plan.risk?.rr || plan.targets?.tp1?.rr || 0);
  if (rr > 0 && rr < PROFILE.minRewardRisk) {
    warnings.push(`R:R ${rr.toFixed(2)} below ${PROFILE.minRewardRisk}`);
    sizeMult *= 0.75;
  }

  const dd = ctx.drawdownStatus || {};
  const consec = Number(dd.consecLoss ?? dd.consecutiveLosses ?? dd.daily?.consecLoss ?? 0);
  if (consec >= PROFILE.maxConsecLossBlock) {
    hardBlock = true;
    warnings.push(`Hard pause: ${consec} consecutive losses (sample max streak 7)`);
  } else if (consec >= PROFILE.maxConsecLossWarn) {
    softBlock = true;
    sizeMult *= 0.45;
    warnings.push(`Cooling: ${consec} consecutive losses — sit out or half size`);
  }

  const tradesToday = Number(dd.daily?.trades ?? dd.tradesToday ?? 0);
  if (tradesToday >= PROFILE.maxTradesPerDayBlock) {
    hardBlock = true;
    warnings.push(`Daily trade cap ${PROFILE.maxTradesPerDayBlock} — overtrading (Aug 27 = 30 trades was lethal)`);
  } else if (tradesToday >= PROFILE.maxTradesPerDayWarn) {
    warnings.push(`High trade count today (${tradesToday}/${PROFILE.maxTradesPerDayBlock})`);
    sizeMult *= 0.65;
  }

  const tradesLastHour = Number(ctx.tradesLastHour ?? dd.tradesLastHour ?? 0);
  if (tradesLastHour >= PROFILE.maxTradesPerHourBlock) {
    hardBlock = true;
    warnings.push(`Hourly cap ${PROFILE.maxTradesPerHourBlock} reached — forced pause`);
  }

  const recent = Array.isArray(ctx.recentOutcomes) ? ctx.recentOutcomes : [];
  const recentSellLosses = recent
    .filter((o) => String(o.action || '').toUpperCase() === 'SELL' && Number(o.profit) < 0)
    .slice(0, 5);
  if (action === 'SELL' && recentSellLosses.length >= PROFILE.sellCautionAfterLosses) {
    warnings.push('Recent sell losses on gold — avoid stacking market sells');
    softBlock = true;
    sizeMult *= 0.5;
  }

  const stopOuts = recent.filter((o) => String(o.closeReason || '').toLowerCase() === 'so');
  if (stopOuts.length > 0) {
    warnings.push(`Recent stop-out — reduce risk ${PROFILE.cooldownMinutesAfterStopOut}m`);
    sizeMult *= 0.4;
    softBlock = true;
  }

  notes.push('Always SL; prefer TP exit; 0.01 lot until equity recovers; quality > quantity');

  return {
    applies: true,
    softBlock,
    hardBlock,
    sizeMult: Math.max(0.2, Math.min(1, sizeMult)),
    notes,
    warnings,
    profile: PROFILE,
    sessionPeak: inPeakGoldSession(ctx.timestamp || Date.now()),
    swarm,
    orderValidation,
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
      swarm: evalResult.swarm,
      orderValidation: evalResult.orderValidation,
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
  swarmRehearsal,
  validateOrderPlan,
  evaluateGoldDesk,
  annotateSignal,
};
