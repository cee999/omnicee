'use strict';

/**
 * ============================================================
 *  MONTE CARLO SIMULATION ENGINE
 *  Institutional-Grade Pre-Signal Validation
 * ============================================================
 *
 *  Runs thousands of price path simulations before any signal
 *  fires, estimating:
 *    - Probability of hitting TP1/TP2/TP3 before SL
 *    - Expected value distribution
 *    - Worst-case drawdown paths
 *    - Time-to-target distribution
 *    - Risk-of-ruin percentage
 *    - Confidence intervals on P&L
 *
 *  Methods:
 *    - Geometric Brownian Motion (GBM) with calibrated vol
 *    - Bootstrap resampling of recent returns
 *    - Block bootstrap (preserves autocorrelation)
 *    - Regime-aware simulation (different params per regime)
 *
 *  Usage:
 *    const mc = new MonteCarloEngine({ simulations: 5000 });
 *    const result = mc.simulate({ candles, signal, tradePlan });
 *    if (!result.approved) reject the signal;
 * ============================================================
 */

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1));
}

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function quantile(arr, q) {
  const sorted = [...arr].sort((a, b) => a - b);
  return percentile(sorted, q * 100);
}

// Seeded PRNG for reproducibility (xoshiro128**)
class PRNG {
  constructor(seed = Date.now()) {
    this.s = new Uint32Array(4);
    this.s[0] = seed >>> 0;
    this.s[1] = (seed * 1103515245 + 12345) >>> 0;
    this.s[2] = (this.s[1] * 1103515245 + 12345) >>> 0;
    this.s[3] = (this.s[2] * 1103515245 + 12345) >>> 0;
  }

  next() {
    const s = this.s;
    const result = (s[1] * 5) | 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = (s[3] << 11) | (s[3] >>> 21);
    return (result >>> 0) / 4294967296;
  }

  // Box-Muller normal distribution
  normal(mu = 0, sigma = 1) {
    const u1 = this.next();
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
    return mu + sigma * z;
  }
}

class MonteCarloEngine {
  constructor(config = {}) {
    this.simulations = config.simulations || 5000;
    this.maxSteps = config.maxSteps || 200;
    this.minWinProb = config.minWinProb || 0.55;
    this.minExpectedR = config.minExpectedR || 0.3;
    this.maxRiskOfRuin = config.maxRiskOfRuin || 0.15;
    this.blockSize = config.blockSize || 5;
    this.seed = config.seed || null;
  }

  /**
   * Main simulation entry point.
   * Runs GBM + bootstrap simulations and aggregates results.
   */
  simulate({ candles, signal, tradePlan, regime }) {
    if (!candles || candles.length < 50 || !signal) {
      return this._insufficient('Not enough data for Monte Carlo simulation');
    }

    const direction = (signal.action || signal.direction || 'WAIT').toUpperCase();
    if (direction === 'WAIT') {
      return this._insufficient('Signal is WAIT — no simulation needed');
    }

    const currentPrice = candles[candles.length - 1].close;
    const entry = tradePlan?.entry?.midPoint || signal?.entry?.midpoint || currentPrice;
    const sl = tradePlan?.stopLoss?.price || signal?.stopLoss?.price || null;
    const targets = this._extractTargets(tradePlan, signal);

    if (!sl || targets.length === 0) {
      return this._insufficient('Missing SL or targets for simulation');
    }

    const closes = candles.map(c => c.close);
    const returns = this._logReturns(closes);
    const calibration = this._calibrate(returns, candles, regime);

    const prng = new PRNG(this.seed || Date.now());

    // Run GBM simulation
    const gbmResults = this._runGBM(entry, sl, targets, direction, calibration, prng);

    // Run bootstrap simulation
    const bootstrapResults = this._runBootstrap(entry, sl, targets, direction, returns, prng);

    // Run block bootstrap (preserves autocorrelation)
    const blockResults = this._runBlockBootstrap(entry, sl, targets, direction, returns, prng);

    // Aggregate across all methods (weighted: GBM 30%, Bootstrap 40%, Block 30%)
    const combined = this._aggregate(gbmResults, bootstrapResults, blockResults);

    // Risk of ruin calculation
    const riskOfRuin = this._riskOfRuin(combined, calibration);

    // Decision
    const approved = combined.winProb >= this.minWinProb
      && combined.expectedR >= this.minExpectedR
      && riskOfRuin.probability <= this.maxRiskOfRuin;

    const reasons = [];
    if (combined.winProb < this.minWinProb) {
      reasons.push(`Win probability ${round(combined.winProb * 100, 1)}% below ${this.minWinProb * 100}% threshold`);
    }
    if (combined.expectedR < this.minExpectedR) {
      reasons.push(`Expected R ${round(combined.expectedR, 2)} below ${this.minExpectedR} minimum`);
    }
    if (riskOfRuin.probability > this.maxRiskOfRuin) {
      reasons.push(`Risk of ruin ${round(riskOfRuin.probability * 100, 1)}% exceeds ${this.maxRiskOfRuin * 100}% cap`);
    }
    if (approved) {
      reasons.push(`MC approved: ${round(combined.winProb * 100, 1)}% win prob, ${round(combined.expectedR, 2)}R expected`);
    }

    return {
      approved,
      simulations: this.simulations * 3,
      winProbability: round(combined.winProb, 4),
      expectedR: round(combined.expectedR, 4),
      medianR: round(combined.medianR, 4),
      riskOfRuin: round(riskOfRuin.probability, 4),
      maxDrawdownPct: round(combined.maxDrawdown, 2),
      confidenceInterval: {
        ci90: [round(combined.ci90[0], 4), round(combined.ci90[1], 4)],
        ci95: [round(combined.ci95[0], 4), round(combined.ci95[1], 4)],
      },
      targetProbabilities: combined.targetProbs.map(tp => ({
        target: round(tp.target, 5),
        probability: round(tp.prob, 4),
        avgStepsToHit: round(tp.avgSteps, 1),
      })),
      methods: {
        gbm: { winProb: round(gbmResults.winProb, 4), expectedR: round(gbmResults.expectedR, 4) },
        bootstrap: { winProb: round(bootstrapResults.winProb, 4), expectedR: round(bootstrapResults.expectedR, 4) },
        blockBootstrap: { winProb: round(blockResults.winProb, 4), expectedR: round(blockResults.expectedR, 4) },
      },
      calibration: {
        annualizedVol: round(calibration.annualizedVol * 100, 2),
        drift: round(calibration.drift, 6),
        skew: round(calibration.skew, 4),
        kurtosis: round(calibration.kurtosis, 4),
      },
      reasons,
      penalty: approved ? 0 : Math.min(20, Math.round((this.minWinProb - combined.winProb) * 40)),
    };
  }

  // Calibrate model parameters from historical returns
  _calibrate(returns, candles, regime) {
    const mu = avg(returns);
    const sigma = stddev(returns);
    const n = returns.length;

    // Skewness
    const m3 = returns.reduce((s, r) => s + ((r - mu) / sigma) ** 3, 0) / n;
    // Excess kurtosis
    const m4 = returns.reduce((s, r) => s + ((r - mu) / sigma) ** 4, 0) / n - 3;

    // Annualized vol estimate (assume H1 candles ~ 24 per day)
    const annualizedVol = sigma * Math.sqrt(252 * 24);

    // Regime-adjusted drift
    let driftAdj = 0;
    if (regime?.trend === 'BULL_TREND') driftAdj = sigma * 0.05;
    else if (regime?.trend === 'BEAR_TREND') driftAdj = -sigma * 0.05;

    // Volatility clustering (simple GARCH-like)
    const recentVol = stddev(returns.slice(-20));
    const historicalVol = sigma;
    const volRatio = historicalVol > 0 ? recentVol / historicalVol : 1;

    return {
      mu,
      sigma,
      annualizedVol,
      skew: m3,
      kurtosis: m4,
      drift: mu + driftAdj,
      recentVol,
      volRatio: round(volRatio, 3),
      adjustedSigma: sigma * Math.min(Math.max(volRatio, 0.5), 2.0),
    };
  }

  // Geometric Brownian Motion simulation
  _runGBM(entry, sl, targets, direction, calibration, prng) {
    const { drift, adjustedSigma } = calibration;
    const sims = this.simulations;
    const outcomes = [];
    const targetHits = targets.map(() => 0);
    const targetSteps = targets.map(() => []);
    let maxDD = 0;

    for (let i = 0; i < sims; i++) {
      let price = entry;
      let peak = entry;
      let localDD = 0;
      let outcome = null;
      const hitTargets = new Set();

      for (let step = 0; step < this.maxSteps; step++) {
        // GBM step: S(t+1) = S(t) * exp((mu - 0.5*sigma^2)*dt + sigma*sqrt(dt)*Z)
        const z = prng.normal();
        const dt = 1;
        price = price * Math.exp((drift - 0.5 * adjustedSigma ** 2) * dt + adjustedSigma * Math.sqrt(dt) * z);

        // Track drawdown
        if (price > peak) peak = price;
        const dd = (peak - price) / peak;
        if (dd > localDD) localDD = dd;

        // Check SL hit
        if (direction === 'LONG' && price <= sl) {
          outcome = -(entry - sl) / entry;
          break;
        }
        if (direction === 'SHORT' && price >= sl) {
          outcome = -(sl - entry) / entry;
          break;
        }

        // Check target hits
        for (let t = 0; t < targets.length; t++) {
          if (hitTargets.has(t)) continue;
          if (direction === 'LONG' && price >= targets[t]) {
            hitTargets.add(t);
            targetHits[t]++;
            targetSteps[t].push(step + 1);
          }
          if (direction === 'SHORT' && price <= targets[t]) {
            hitTargets.add(t);
            targetHits[t]++;
            targetSteps[t].push(step + 1);
          }
        }

        // Use first target hit as outcome if SL not hit
        if (hitTargets.size > 0 && outcome === null) {
          const bestTarget = Math.max(...[...hitTargets]);
          if (direction === 'LONG') {
            outcome = (targets[bestTarget] - entry) / entry;
          } else {
            outcome = (entry - targets[bestTarget]) / entry;
          }
        }
      }

      // If no outcome after all steps, mark at current unrealized P&L
      if (outcome === null) {
        if (direction === 'LONG') outcome = (price - entry) / entry;
        else outcome = (entry - price) / entry;
      }

      if (localDD > maxDD) maxDD = localDD;
      outcomes.push(outcome);
    }

    return this._summarize(outcomes, targetHits, targetSteps, targets, sims, maxDD);
  }

  // Bootstrap resampling simulation
  _runBootstrap(entry, sl, targets, direction, returns, prng) {
    const sims = this.simulations;
    const outcomes = [];
    const targetHits = targets.map(() => 0);
    const targetSteps = targets.map(() => []);
    let maxDD = 0;

    for (let i = 0; i < sims; i++) {
      let price = entry;
      let peak = entry;
      let localDD = 0;
      let outcome = null;
      const hitTargets = new Set();

      for (let step = 0; step < this.maxSteps; step++) {
        // Random sample from historical returns
        const idx = Math.floor(prng.next() * returns.length);
        const ret = returns[idx];
        price = price * Math.exp(ret);

        if (price > peak) peak = price;
        const dd = (peak - price) / peak;
        if (dd > localDD) localDD = dd;

        if (direction === 'LONG' && price <= sl) {
          outcome = -(entry - sl) / entry;
          break;
        }
        if (direction === 'SHORT' && price >= sl) {
          outcome = -(sl - entry) / entry;
          break;
        }

        for (let t = 0; t < targets.length; t++) {
          if (hitTargets.has(t)) continue;
          if (direction === 'LONG' && price >= targets[t]) {
            hitTargets.add(t);
            targetHits[t]++;
            targetSteps[t].push(step + 1);
          }
          if (direction === 'SHORT' && price <= targets[t]) {
            hitTargets.add(t);
            targetHits[t]++;
            targetSteps[t].push(step + 1);
          }
        }

        if (hitTargets.size > 0 && outcome === null) {
          const bestTarget = Math.max(...[...hitTargets]);
          outcome = direction === 'LONG'
            ? (targets[bestTarget] - entry) / entry
            : (entry - targets[bestTarget]) / entry;
        }
      }

      if (outcome === null) {
        outcome = direction === 'LONG' ? (price - entry) / entry : (entry - price) / entry;
      }
      if (localDD > maxDD) maxDD = localDD;
      outcomes.push(outcome);
    }

    return this._summarize(outcomes, targetHits, targetSteps, targets, sims, maxDD);
  }

  // Block bootstrap (preserves serial correlation)
  _runBlockBootstrap(entry, sl, targets, direction, returns, prng) {
    const sims = this.simulations;
    const bs = this.blockSize;
    const outcomes = [];
    const targetHits = targets.map(() => 0);
    const targetSteps = targets.map(() => []);
    let maxDD = 0;

    for (let i = 0; i < sims; i++) {
      let price = entry;
      let peak = entry;
      let localDD = 0;
      let outcome = null;
      const hitTargets = new Set();
      let step = 0;

      while (step < this.maxSteps) {
        // Pick a random block start
        const blockStart = Math.floor(prng.next() * Math.max(1, returns.length - bs));
        const block = returns.slice(blockStart, blockStart + bs);

        for (const ret of block) {
          if (step >= this.maxSteps) break;
          price = price * Math.exp(ret);

          if (price > peak) peak = price;
          const dd = (peak - price) / peak;
          if (dd > localDD) localDD = dd;

          if (direction === 'LONG' && price <= sl) {
            outcome = -(entry - sl) / entry;
            break;
          }
          if (direction === 'SHORT' && price >= sl) {
            outcome = -(sl - entry) / entry;
            break;
          }

          for (let t = 0; t < targets.length; t++) {
            if (hitTargets.has(t)) continue;
            if (direction === 'LONG' && price >= targets[t]) {
              hitTargets.add(t);
              targetHits[t]++;
              targetSteps[t].push(step + 1);
            }
            if (direction === 'SHORT' && price <= targets[t]) {
              hitTargets.add(t);
              targetHits[t]++;
              targetSteps[t].push(step + 1);
            }
          }

          if (hitTargets.size > 0 && outcome === null) {
            const bestTarget = Math.max(...[...hitTargets]);
            outcome = direction === 'LONG'
              ? (targets[bestTarget] - entry) / entry
              : (entry - targets[bestTarget]) / entry;
          }

          step++;
          if (outcome !== null) break;
        }
        if (outcome !== null) break;
      }

      if (outcome === null) {
        outcome = direction === 'LONG' ? (price - entry) / entry : (entry - price) / entry;
      }
      if (localDD > maxDD) maxDD = localDD;
      outcomes.push(outcome);
    }

    return this._summarize(outcomes, targetHits, targetSteps, targets, sims, maxDD);
  }

  _summarize(outcomes, targetHits, targetSteps, targets, sims, maxDD) {
    const sorted = [...outcomes].sort((a, b) => a - b);
    const wins = outcomes.filter(o => o > 0).length;

    return {
      winProb: wins / sims,
      expectedR: avg(outcomes),
      medianR: percentile(sorted, 50),
      maxDrawdown: maxDD * 100,
      ci90: [percentile(sorted, 5), percentile(sorted, 95)],
      ci95: [percentile(sorted, 2.5), percentile(sorted, 97.5)],
      targetProbs: targets.map((t, i) => ({
        target: t,
        prob: targetHits[i] / sims,
        avgSteps: targetSteps[i].length > 0 ? avg(targetSteps[i]) : Infinity,
      })),
      var95: percentile(sorted, 5),
      cvar95: avg(sorted.slice(0, Math.max(1, Math.floor(sims * 0.05)))),
    };
  }

  _aggregate(gbm, bootstrap, block) {
    const wGBM = 0.30;
    const wBoot = 0.40;
    const wBlock = 0.30;

    const winProb = gbm.winProb * wGBM + bootstrap.winProb * wBoot + block.winProb * wBlock;
    const expectedR = gbm.expectedR * wGBM + bootstrap.expectedR * wBoot + block.expectedR * wBlock;
    const medianR = gbm.medianR * wGBM + bootstrap.medianR * wBoot + block.medianR * wBlock;
    const maxDrawdown = Math.max(gbm.maxDrawdown, bootstrap.maxDrawdown, block.maxDrawdown);

    // Conservative CIs — use widest
    const ci90 = [
      Math.min(gbm.ci90[0], bootstrap.ci90[0], block.ci90[0]),
      Math.max(gbm.ci90[1], bootstrap.ci90[1], block.ci90[1]),
    ];
    const ci95 = [
      Math.min(gbm.ci95[0], bootstrap.ci95[0], block.ci95[0]),
      Math.max(gbm.ci95[1], bootstrap.ci95[1], block.ci95[1]),
    ];

    // Target probabilities — conservative (minimum across methods)
    const nTargets = gbm.targetProbs.length;
    const targetProbs = [];
    for (let i = 0; i < nTargets; i++) {
      targetProbs.push({
        target: gbm.targetProbs[i].target,
        prob: Math.min(gbm.targetProbs[i].prob, bootstrap.targetProbs[i].prob, block.targetProbs[i].prob),
        avgSteps: avg([gbm.targetProbs[i].avgSteps, bootstrap.targetProbs[i].avgSteps, block.targetProbs[i].avgSteps].filter(s => isFinite(s))),
      });
    }

    return { winProb, expectedR, medianR, maxDrawdown, ci90, ci95, targetProbs };
  }

  _riskOfRuin(combined, calibration) {
    // Simplified risk-of-ruin: probability of losing X% before recovering
    // Based on gambler's ruin with drift
    const winProb = combined.winProb;
    const lossProb = 1 - winProb;

    if (winProb <= 0.5) {
      return { probability: 1.0, note: 'Edge insufficient — ruin certain over time' };
    }

    // Risk of ruin ≈ ((1-p)/p)^N where N = number of units to ruin
    const ratio = lossProb / winProb;
    const unitsToRuin = 10; // 10R drawdown = ruin
    const ror = Math.pow(ratio, unitsToRuin);

    // Adjust for volatility clustering
    const volAdj = Math.min(2.0, calibration.volRatio);
    const adjRor = Math.min(1.0, ror * volAdj);

    return {
      probability: round(adjRor, 4),
      ratio: round(ratio, 4),
      note: `RoR ${round(adjRor * 100, 1)}% (vol-adjusted)`,
    };
  }

  _logReturns(closes) {
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
      }
    }
    return returns;
  }

  _extractTargets(tradePlan, signal) {
    const targets = [];
    const tp = tradePlan?.targets || signal?.targets || {};
    if (tp.tp1?.price) targets.push(tp.tp1.price);
    if (tp.tp2?.price) targets.push(tp.tp2.price);
    if (tp.tp3?.price) targets.push(tp.tp3.price);
    // Fallback: if no named targets, check array
    if (targets.length === 0 && Array.isArray(tp)) {
      for (const t of tp) {
        if (t?.price) targets.push(t.price);
      }
    }
    return targets;
  }

  _insufficient(reason) {
    return {
      approved: true,
      simulations: 0,
      winProbability: null,
      expectedR: null,
      riskOfRuin: null,
      reasons: [reason],
      penalty: 0,
      note: 'Monte Carlo skipped — insufficient data',
    };
  }
}

module.exports = { MonteCarloEngine };
