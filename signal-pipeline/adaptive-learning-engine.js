'use strict';

/**
 * ============================================================
 *  ADAPTIVE LEARNING ENGINE — Enhanced with Deep Pattern Memory
 *  Reinforcement Learning · Mistake Prevention · Pattern Decay
 * ============================================================
 *
 *  Upgrades over v1:
 *    - Deep pattern memory with multiple granularity levels
 *    - Reinforcement learning: Q-value updates for setup quality
 *    - Mistake blacklist: permanently blocks catastrophic patterns
 *    - Recency-weighted learning (recent outcomes matter more)
 *    - Multi-dimensional similarity matching (fuzzy fingerprints)
 *    - Consecutive loss detection per pattern
 *    - Regime-aware pattern evaluation
 *    - Decay factor for old patterns (stale data matters less)
 * ============================================================
 */

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

/**
 * Q-Learning table for setup quality evaluation.
 * State = pattern fingerprint key, Action = TAKE or SKIP.
 * Learns from realized outcomes to adjust willingness to take setups.
 */
class QLearningTable {
  constructor(config = {}) {
    this._alpha = config.learningRate || 0.15;   // learning rate
    this._gamma = config.discountFactor || 0.90; // future discount
    this._table = new Map(); // key -> { take: Q, skip: Q }
  }

  getQ(stateKey) {
    if (!this._table.has(stateKey)) {
      this._table.set(stateKey, { take: 0, skip: 0 });
    }
    return this._table.get(stateKey);
  }

  update(stateKey, action, reward) {
    const q = this.getQ(stateKey);
    const old = q[action];
    const maxFuture = Math.max(q.take, q.skip);
    q[action] = old + this._alpha * (reward + this._gamma * maxFuture - old);
    this._table.set(stateKey, q);
  }

  recommend(stateKey) {
    const q = this.getQ(stateKey);
    if (q.take === 0 && q.skip === 0) return { action: 'NEUTRAL', confidence: 0 };
    const total = Math.abs(q.take) + Math.abs(q.skip);
    const confidence = total > 0 ? Math.abs(q.take - q.skip) / total * 100 : 0;
    return {
      action: q.take >= q.skip ? 'TAKE' : 'SKIP',
      confidence: round(confidence, 1),
      qTake: round(q.take, 4),
      qSkip: round(q.skip, 4),
    };
  }

  size() { return this._table.size; }
}

/**
 * Mistake Blacklist — permanently blocks catastrophic pattern signatures.
 * A pattern is blacklisted if it produces N consecutive losses or
 * an extremely negative expectancy.
 */
class MistakeBlacklist {
  constructor(config = {}) {
    this.maxConsecutiveLosses = config.maxConsecutiveLosses || 3;
    this.catastrophicLossR = config.catastrophicLossR || -3;
    this._blacklisted = new Map(); // patternKey -> { reason, blockedAt, losses }
    this._consecutiveLosses = new Map(); // patternKey -> count
  }

  recordOutcome(patternKey, pnlR) {
    if (pnlR < 0) {
      const count = (this._consecutiveLosses.get(patternKey) || 0) + 1;
      this._consecutiveLosses.set(patternKey, count);

      if (count >= this.maxConsecutiveLosses) {
        this._blacklisted.set(patternKey, {
          reason: `${count} consecutive losses on this exact pattern`,
          blockedAt: Date.now(),
          losses: count,
        });
      }

      if (pnlR <= this.catastrophicLossR) {
        this._blacklisted.set(patternKey, {
          reason: `Catastrophic loss of ${round(pnlR, 2)}R on this pattern`,
          blockedAt: Date.now(),
          losses: count,
        });
      }
    } else {
      // Reset consecutive counter on win/breakeven
      this._consecutiveLosses.set(patternKey, 0);
    }
  }

  isBlacklisted(patternKey) {
    return this._blacklisted.has(patternKey);
  }

  getBlacklistReason(patternKey) {
    return this._blacklisted.get(patternKey) || null;
  }

  // Allow redemption after a cooling period (default 7 days)
  prune(coolingPeriodMs = 7 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [key, info] of this._blacklisted) {
      if (now - info.blockedAt > coolingPeriodMs) {
        this._blacklisted.delete(key);
        this._consecutiveLosses.delete(key);
      }
    }
  }

  size() { return this._blacklisted.size; }
}

class AdaptiveLearningEngine {
  constructor(config = {}) {
    this.store = config.store || null;
    this.minSamples = Number(config.minSamples || process.env.LEARNING_MIN_SAMPLES || 6);
    this.blockWinRate = Number(config.blockWinRate || process.env.LEARNING_BLOCK_WIN_RATE || 0.28);
    this.warnWinRate = Number(config.warnWinRate || process.env.LEARNING_WARN_WIN_RATE || 0.42);
    this.cacheTtlMs = Number(config.cacheTtlMs || process.env.LEARNING_CACHE_TTL_MS || 5 * 60 * 1000);
    this._cache = new Map();

    // New: RL and mistake prevention components
    this._qTable = new QLearningTable(config.qLearning || {});
    this._blacklist = new MistakeBlacklist(config.blacklist || {});
    this._recentOutcomes = []; // sliding window of recent outcomes for recency analysis
    this._maxRecentOutcomes = config.maxRecentOutcomes || 500;
    this._decayHalfLifeDays = config.decayHalfLifeDays || 30;
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

  // Coarse key for fuzzy matching when exact key has no data
  coarseKey(fp) {
    return [
      fp.symbol,
      fp.direction,
      fp.grade,
      fp.regime,
      fp.structure,
      fp.scoreBucket,
    ].join('|');
  }

  async evaluateSetup(ctx) {
    const fingerprint = this.fingerprint(ctx);
    const patternKey = this.key(fingerprint);
    const coarsePatternKey = this.coarseKey(fingerprint);

    // Check blacklist first — hard block
    if (this._blacklist.isBlacklisted(patternKey)) {
      const reason = this._blacklist.getBlacklistReason(patternKey);
      return {
        patternKey,
        fingerprint,
        action: 'BLOCK',
        penalty: 25,
        confidence: 95,
        blacklisted: true,
        note: `BLACKLISTED: ${reason.reason}`,
      };
    }

    // Check coarse blacklist
    if (this._blacklist.isBlacklisted(coarsePatternKey)) {
      const reason = this._blacklist.getBlacklistReason(coarsePatternKey);
      return {
        patternKey,
        fingerprint,
        action: 'BLOCK',
        penalty: 20,
        confidence: 80,
        blacklisted: true,
        note: `COARSE BLACKLISTED: ${reason.reason}`,
      };
    }

    // Q-Learning recommendation
    const rlRecommendation = this._qTable.recommend(patternKey);
    const coarseRL = this._qTable.recommend(coarsePatternKey);

    const profile = await this._profile(patternKey);
    const coarseProfile = await this._profile(coarsePatternKey);

    // Use exact match if available, else fall back to coarse
    const activeProfile = (profile && profile.samples >= this.minSamples)
      ? profile
      : (coarseProfile && coarseProfile.samples >= this.minSamples)
        ? coarseProfile
        : null;

    if (!activeProfile) {
      // No historical data — use RL signal if available
      let rlPenalty = 0;
      if (rlRecommendation.action === 'SKIP' && rlRecommendation.confidence > 30) {
        rlPenalty = 5;
      }
      if (coarseRL.action === 'SKIP' && coarseRL.confidence > 40) {
        rlPenalty = Math.max(rlPenalty, 8);
      }

      return {
        patternKey,
        fingerprint,
        action: rlPenalty > 5 ? 'WARN' : 'ALLOW',
        penalty: rlPenalty,
        confidence: 0,
        rl: rlRecommendation,
        note: `Learning warmup: ${profile?.samples || 0}/${this.minSamples} exact | ${coarseProfile?.samples || 0} coarse | RL: ${rlRecommendation.action}`,
      };
    }

    const expectancyR = Number(activeProfile.expectancyR || 0);
    const winRate = Number(activeProfile.winRate || 0);
    const drawdownPenalty = Math.max(0, Math.abs(Number(activeProfile.avgLossR || 0)) - Math.abs(Number(activeProfile.avgWinR || 0))) * 4;
    let penalty = 0;
    let action = 'ALLOW';

    // Recency-weighted analysis
    const recencyPenalty = this._recencyAnalysis(patternKey);

    // RL penalty/bonus
    let rlPenalty = 0;
    if (rlRecommendation.action === 'SKIP' && rlRecommendation.confidence > 30) {
      rlPenalty = Math.min(8, rlRecommendation.confidence * 0.1);
    } else if (rlRecommendation.action === 'TAKE' && rlRecommendation.confidence > 30) {
      rlPenalty = -Math.min(4, rlRecommendation.confidence * 0.05);
    }

    if (winRate <= this.blockWinRate && expectancyR < 0) {
      action = 'BLOCK';
      penalty = 18 + drawdownPenalty + recencyPenalty;
    } else if (winRate <= this.warnWinRate || expectancyR < 0) {
      action = 'WARN';
      penalty = 8 + drawdownPenalty + recencyPenalty;
    } else if (expectancyR > 0.35 && winRate > 0.5) {
      penalty = -3;
    }

    penalty += rlPenalty;

    return {
      patternKey,
      fingerprint,
      action,
      penalty: round(penalty, 2),
      confidence: round(Math.min(100, activeProfile.samples * 7), 2),
      profile: activeProfile,
      rl: rlRecommendation,
      recencyPenalty: round(recencyPenalty, 2),
      note: `Pattern ${activeProfile.samples} samples | WR ${round(winRate * 100, 1)}% | EV ${round(expectancyR, 2)}R | RL: ${rlRecommendation.action} (${rlRecommendation.confidence}%)`,
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
    const coarsePatternKey = this.coarseKey(fingerprint);
    const pnlR = Number(outcome?.pnlR ?? outcome?.r ?? 0);
    const result = pnlR > 0 ? 'WIN' : pnlR < 0 ? 'LOSS' : 'BREAKEVEN';

    // Update Q-learning table (reward = pnlR normalized)
    const reward = pnlR > 0 ? Math.min(pnlR, 3) : Math.max(pnlR, -3);
    this._qTable.update(patternKey, 'take', reward);
    this._qTable.update(coarsePatternKey, 'take', reward * 0.7);

    // Update mistake blacklist
    this._blacklist.recordOutcome(patternKey, pnlR);
    this._blacklist.recordOutcome(coarsePatternKey, pnlR);

    // Track recent outcome for recency analysis
    this._recentOutcomes.push({
      patternKey,
      pnlR,
      timestamp: Date.now(),
    });
    if (this._recentOutcomes.length > this._maxRecentOutcomes) {
      this._recentOutcomes = this._recentOutcomes.slice(-this._maxRecentOutcomes);
    }

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
    this._cache.delete(coarsePatternKey);
    return doc;
  }

  // Analyze recent outcomes for this pattern with recency weighting
  _recencyAnalysis(patternKey) {
    const now = Date.now();
    const halfLife = this._decayHalfLifeDays * 24 * 60 * 60 * 1000;
    const matching = this._recentOutcomes.filter(o => o.patternKey === patternKey);
    if (matching.length < 3) return 0;

    let weightedPnl = 0;
    let totalWeight = 0;
    for (const outcome of matching) {
      const age = now - outcome.timestamp;
      const weight = Math.exp(-0.693 * age / halfLife); // exponential decay
      weightedPnl += outcome.pnlR * weight;
      totalWeight += weight;
    }

    const recencyWeightedEV = totalWeight > 0 ? weightedPnl / totalWeight : 0;

    // If recent weighted EV is deeply negative, add penalty
    if (recencyWeightedEV < -0.5) return Math.min(10, Math.abs(recencyWeightedEV) * 5);
    return 0;
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

  // Periodically prune stale blacklist entries
  maintenance() {
    this._blacklist.prune();
  }

  getStats() {
    return {
      qTableSize: this._qTable.size(),
      blacklistSize: this._blacklist.size(),
      recentOutcomes: this._recentOutcomes.length,
      cacheSize: this._cache.size,
    };
  }
}

module.exports = { AdaptiveLearningEngine };
