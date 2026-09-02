'use strict';

/**
 * FinceptTerminal-inspired OrderValidator adapted for Omnicee MANUAL mode.
 * Does not place orders — validates signal geometry + risk before desk approval.
 *
 * Source patterns: FinceptTerminal trading/OrderValidator + PositionManager
 * (latency, geometry, daily limits, consecutive loss).
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rrFrom(entry, sl, tp) {
  const e = num(entry);
  const s = num(sl);
  const t = num(tp);
  if (e == null || s == null || t == null) return null;
  const risk = Math.abs(e - s);
  if (risk <= 0) return null;
  return Math.abs(t - e) / risk;
}

class FinceptOrderValidator {
  constructor(config = {}) {
    this.minRR = config.minRR ?? 1.5;
    this.maxRiskPct = config.maxRiskPct ?? 1.5;
    this.requireSL = config.requireSL !== false;
    this.requireTP = config.requireTP !== false;
    this.maxSpreadPts = config.maxSpreadPts ?? null;
    this.minHoldMinutesHint = config.minHoldMinutesHint ?? 3;
  }

  /**
   * @param {object} signal normalized Omnicee signal
   * @param {object} [ctx] { balance, bid, ask, consecLoss, tradesToday }
   */
  validate(signal, ctx = {}) {
    const failures = [];
    const warnings = [];
    const action = String(signal?.action || '').toUpperCase();
    if (action !== 'BUY' && action !== 'SELL' && action !== 'LONG' && action !== 'SHORT') {
      return { ok: false, failures: ['Not a FIRE action'], warnings, metrics: {} };
    }

    const entry = num(signal.entry ?? signal.currentPrice);
    const sl = num(signal.stopLoss);
    const tp1 = num(Array.isArray(signal.targets) ? signal.targets[0] : signal.targets?.tp1);
    const tp2 = num(Array.isArray(signal.targets) ? signal.targets[1] : signal.targets?.tp2);

    if (entry == null) failures.push('Missing entry');
    if (this.requireSL && sl == null) failures.push('Missing stop-loss (mandatory)');
    if (this.requireTP && tp1 == null) warnings.push('Missing TP1 — discretionary exits underperformed in sample');

    const side = action === 'BUY' || action === 'LONG' ? 'BUY' : 'SELL';
    if (entry != null && sl != null) {
      if (side === 'BUY' && sl >= entry) failures.push('BUY SL must be below entry');
      if (side === 'SELL' && sl <= entry) failures.push('SELL SL must be above entry');
    }
    if (entry != null && tp1 != null) {
      if (side === 'BUY' && tp1 <= entry) failures.push('BUY TP must be above entry');
      if (side === 'SELL' && tp1 >= entry) failures.push('SELL TP must be below entry');
    }

    const rr = rrFrom(entry, sl, tp1);
    if (rr != null && rr < this.minRR) failures.push(`R:R ${rr.toFixed(2)} < min ${this.minRR}`);

    const balance = num(ctx.balance);
    if (balance != null && balance > 0 && entry != null && sl != null) {
      // 0.01 lot gold ≈ $0.01 per 0.01 price move on many cent/micro accounts;
      // use % of balance vs stop distance in price as soft risk proxy.
      const stopDist = Math.abs(entry - sl);
      const riskPctProxy = (stopDist / entry) * 100;
      if (riskPctProxy > this.maxRiskPct * 3) {
        warnings.push(`Wide stop vs price (${riskPctProxy.toFixed(2)}%) — reduce size`);
      }
    }

    if (ctx.bid != null && ctx.ask != null && this.maxSpreadPts != null) {
      const spread = Math.abs(Number(ctx.ask) - Number(ctx.bid));
      if (spread > this.maxSpreadPts) warnings.push(`Spread ${spread} exceeds soft max ${this.maxSpreadPts}`);
    }

    const consec = Number(ctx.consecLoss || 0);
    if (consec >= 4) failures.push(`Consecutive losses ${consec} — Fincept PositionManager halt`);
    else if (consec >= 2) warnings.push(`Consecutive losses ${consec} — reduce size`);

    const tradesToday = Number(ctx.tradesToday || 0);
    if (tradesToday >= 12) failures.push(`Daily trade count ${tradesToday} — overtrade block`);
    else if (tradesToday >= 8) warnings.push(`Daily trade count ${tradesToday} elevated`);

    const metrics = {
      entry,
      stopLoss: sl,
      tp1,
      tp2,
      rr: rr != null ? Math.round(rr * 100) / 100 : null,
      side,
      minHoldMinutesHint: this.minHoldMinutesHint,
    };

    return {
      ok: failures.length === 0,
      failures,
      warnings,
      metrics,
    };
  }
}

module.exports = { FinceptOrderValidator, rrFrom };
