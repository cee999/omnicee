'use strict';

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function bucket(value, bands) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'unknown';
  for (const [label, max] of bands) {
    if (n <= max) return label;
  }
  return bands[bands.length - 1]?.[0] || 'unknown';
}

class AdaptiveLearningEngine {
  constructor(config = {}) {
    this.store = config.store || null;
    this.minSamples = Number(config.minSamples || process.env.LEARNING_MIN_SAMPLES || 6);
    this.blockWinRate = Number(config.blockWinRate || process.env.LEARNING_BLOCK_WIN_RATE || 0.28);
    this.warnWinRate = Number(config.warnWinRate || process.env.LEARNING_WARN_WIN_RATE || 0.42);
    this.cacheTtlMs = Number(config.cacheTtlMs || process.env.LEARNING_CACHE_TTL_MS || 5 * 60 * 1000);
    this._cache = new Map();
  }

  fingerprint({ signal, regime, entryOptimization, riskEvaluation }) {
    const score = Number(signal?.score?.final || 0);
    const rr = Number(signal?.targets?.tp1?.rr || signal?.tradePlan?.targets?.tp1?.rr || 0);
    const risk = Number(riskEvaluation?.effectiveRisk || signal?.riskEvaluation?.effectiveRisk || 0);
    const entryQuality = Number(entryOptimization?.qualityScore || signal?.entryOptimization?.qualityScore || 0);
    const agentStatuses = (signal?.agentBreakdown || [])
      .map(a => `${String(a.agent || '').split(' ')[0]}:${a.status || a.direction || 'NA'}`)
      .slice(0, 5)
      .join('|');

    return {
      symbol: signal?.symbol || 'UNKNOWN',
      timeframe: signal?.timeframe || 'UNKNOWN',
      direction: signal?.action || signal?.direction || 'WAIT',
      grade: signal?.score?.grade || 'NA',
      scoreBucket: bucket(score, [['sub70', 70], ['70_79', 79], ['80_89', 89], ['90_plus', Infinity]]),
      rrBucket: bucket(rr, [['sub15', 1.49], ['15_2', 2], ['2_3', 3], ['3_plus', Infinity]]),
      riskBucket: bucket(risk, [['sub50bp', 0.5], ['50_100bp', 1], ['100_150bp', 1.5], ['150bp_plus', Infinity]]),
      entryBucket: bucket(entryQuality, [['sub55', 55], ['55_69', 69], ['70_84', 84], ['85_plus', Infinity]]),
      regime: regime?.regime || signal?.regime?.regime || 'UNKNOWN',
      structure: regime?.structure || signal?.regime?.structure || 'UNKNOWN',
      volatility: regime?.volatility || signal?.regime?.volatility || 'UNKNOWN',
      session: signal?.session?.current || 'UNKNOWN',
      agents: agentStatuses || 'UNKNOWN',
    };
  }

  key(fp) {
    return [
      fp.symbol,
      fp.timeframe,
      fp.direction,
      fp.grade,
      fp.regime,
      fp.structure,
      fp.volatility,
      fp.scoreBucket,
      fp.rrBucket,
      fp.entryBucket,
    ].join('|');
  }

  async evaluateSetup(ctx) {
    const fingerprint = this.fingerprint(ctx);
    const patternKey = this.key(fingerprint);
    const profile = await this._profile(patternKey);

    if (!profile || profile.samples < this.minSamples) {
      return {
        patternKey,
        fingerprint,
        action: 'ALLOW',
        penalty: 0,
        confidence: 0,
        note: `Learning warmup: ${profile?.samples || 0}/${this.minSamples} matching outcomes`,
      };
    }

    const expectancyR = Number(profile.expectancyR || 0);
    const winRate = Number(profile.winRate || 0);
    const drawdownPenalty = Math.max(0, Math.abs(Number(profile.avgLossR || 0)) - Math.abs(Number(profile.avgWinR || 0))) * 4;
    let penalty = 0;
    let action = 'ALLOW';

    if (winRate <= this.blockWinRate && expectancyR < 0) {
      action = 'BLOCK';
      penalty = 18 + drawdownPenalty;
    } else if (winRate <= this.warnWinRate || expectancyR < 0) {
      action = 'WARN';
      penalty = 8 + drawdownPenalty;
    } else if (expectancyR > 0.35 && winRate > 0.5) {
      penalty = -3;
    }

    return {
      patternKey,
      fingerprint,
      action,
      penalty: round(penalty, 2),
      confidence: round(Math.min(100, profile.samples * 7), 2),
      profile,
      note: `Pattern ${profile.samples} samples | WR ${round(winRate * 100, 1)}% | EV ${round(expectancyR, 2)}R`,
    };
  }

  async recordOutcome({ signalId, signal, outcome }) {
    const fingerprint = this.fingerprint({
      signal,
      regime: signal?.regime,
      entryOptimization: signal?.entryOptimization,
      riskEvaluation: signal?.riskEvaluation,
    });
    const patternKey = this.key(fingerprint);
    const pnlR = Number(outcome?.pnlR ?? outcome?.r ?? 0);
    const result = pnlR > 0 ? 'WIN' : pnlR < 0 ? 'LOSS' : 'BREAKEVEN';
    const doc = {
      signalId: signalId || signal?.id || null,
      symbol: signal?.symbol || fingerprint.symbol,
      timeframe: signal?.timeframe || fingerprint.timeframe,
      patternKey,
      fingerprint,
      result,
      pnlR: round(pnlR, 4),
      pnlPct: round(Number(outcome?.pnlPct || 0), 4),
      notes: outcome?.notes || '',
      closedAt: outcome?.closedAt || Date.now(),
    };

    if (this.store?.saveTradeOutcome) {
      await this.store.saveTradeOutcome(doc);
    }
    this._cache.delete(patternKey);
    return doc;
  }

  async _profile(patternKey) {
    const hit = this._cache.get(patternKey);
    if (hit && Date.now() - hit.ts < this.cacheTtlMs) return hit.value;
    const value = this.store?.getLearningProfile
      ? await this.store.getLearningProfile(patternKey)
      : null;
    this._cache.set(patternKey, { value, ts: Date.now() });
    return value;
  }
}

module.exports = { AdaptiveLearningEngine };
