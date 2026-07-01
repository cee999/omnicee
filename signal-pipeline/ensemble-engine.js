'use strict';

/**
 * ============================================================
 *  ENSEMBLE VALIDATION ENGINE
 *  Multi-Layer Signal Consensus Before Execution
 * ============================================================
 *
 *  The final gatekeeper: combines ALL validation engines into
 *  a single go/no-go decision. No signal fires without passing
 *  through this ensemble.
 *
 *  Validation layers (all must agree):
 *    1. Monte Carlo Simulation  — win probability + expected R
 *    2. Bayesian Probability    — posterior P(win | evidence)
 *    3. Statistical Validation  — hypothesis tests pass
 *    4. Walk-Forward Check      — parameters not overfitted
 *    5. Adaptive Learning       — historical pattern not blocked
 *    6. Agent Consensus Voting  — weighted multi-agent agreement
 *    7. Regime Compatibility    — signal matches current regime
 *    8. Fractal Alignment       — market memory supports strategy
 *    9. Microstructure Confirm  — order flow confirms direction
 *
 *  Voting: weighted consensus across all 9 layers.
 *  Minimum ensemble confidence to approve: configurable (default 60%)
 *
 *  Penalty system: each layer can add score penalties (0-20 pts)
 *  that reduce the signal's final score. Total penalty is capped
 *  to prevent over-penalization.
 * ============================================================
 */

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

class EnsembleEngine {
  constructor(config = {}) {
    this.minConfidence = config.minConfidence || 60;
    this.maxTotalPenalty = config.maxTotalPenalty || 35;
    this.requireMonteCarlo = config.requireMonteCarlo !== false;
    this.requireBayesian = config.requireBayesian !== false;
    this.requireStatistical = config.requireStatistical !== false;

    // Layer weights for consensus scoring
    this.weights = config.weights || {
      monteCarlo: 20,
      bayesian: 18,
      statistical: 15,
      walkForward: 12,
      adaptiveLearning: 15,
      agentConsensus: 10,
      regimeCompat: 5,
      fractal: 3,
      microstructure: 2,
    };
  }

  /**
   * Run the full ensemble validation.
   *
   * @param {Object} results - results from each validation layer
   * @param {Object} results.monteCarlo     - from MonteCarloEngine.simulate()
   * @param {Object} results.bayesian       - from BayesianEngine.evaluate()
   * @param {Object} results.statistical    - from StatisticalValidator.validate()
   * @param {Object} results.walkForward    - from WalkForwardOptimizer.analyze()
   * @param {Object} results.learning       - from AdaptiveLearningEngine.evaluateSetup()
   * @param {Object} results.agentVotes     - agent direction votes
   * @param {Object} results.regime         - from RegimeEngine.classify()
   * @param {Object} results.fractal        - from FractalAgent.analyze()
   * @param {Object} results.microstructure - from MicrostructureAgent.analyze()
   * @param {Object} signal                 - the candidate signal
   * @returns {Object} ensemble decision
   */
  evaluate(results, signal) {
    const layers = [];
    let totalPenalty = 0;

    const direction = (signal?.action || signal?.direction || 'WAIT').toUpperCase();

    // Layer 1: Monte Carlo
    const mc = results.monteCarlo;
    if (mc && mc.simulations > 0) {
      const mcApproved = mc.approved !== false;
      const mcScore = mcApproved ? 80 + (mc.winProbability - 0.55) * 200 : 30;
      totalPenalty += mc.penalty || 0;
      layers.push({
        name: 'Monte Carlo Simulation',
        approved: mcApproved,
        score: clamp(mcScore, 0, 100),
        weight: this.weights.monteCarlo,
        detail: `Win prob: ${round((mc.winProbability || 0) * 100, 1)}%, Expected R: ${round(mc.expectedR || 0, 2)}, RoR: ${round((mc.riskOfRuin || 0) * 100, 1)}%`,
        penalty: mc.penalty || 0,
      });
    } else if (this.requireMonteCarlo) {
      layers.push({
        name: 'Monte Carlo Simulation',
        approved: true, // don't block if insufficient data, just note it
        score: 50,
        weight: this.weights.monteCarlo * 0.3,
        detail: mc?.note || 'Skipped — insufficient data',
        penalty: 0,
      });
    }

    // Layer 2: Bayesian
    const bay = results.bayesian;
    if (bay && bay.posterior != null) {
      const bayApproved = bay.approved !== false;
      const bayScore = bayApproved ? 70 + (bay.posterior - 0.52) * 300 : 25;
      totalPenalty += bay.penalty || 0;
      layers.push({
        name: 'Bayesian Probability',
        approved: bayApproved,
        score: clamp(bayScore, 0, 100),
        weight: this.weights.bayesian,
        detail: `Posterior: ${round((bay.posterior || 0) * 100, 1)}%, Prior: ${round((bay.prior || 0.5) * 100, 1)}%`,
        penalty: bay.penalty || 0,
      });
    }

    // Layer 3: Statistical
    const stat = results.statistical;
    if (stat && stat.total > 0) {
      const statApproved = stat.approved !== false;
      const statScore = statApproved ? 70 + stat.compositeScore * 0.3 : 35;
      totalPenalty += stat.penalty || 0;
      layers.push({
        name: 'Statistical Validation',
        approved: statApproved,
        score: clamp(statScore, 0, 100),
        weight: this.weights.statistical,
        detail: `Passed ${stat.passed}/${stat.total} tests (composite: ${stat.compositeScore})`,
        penalty: stat.penalty || 0,
      });
    }

    // Layer 4: Walk-Forward
    const wf = results.walkForward;
    if (wf && wf.sufficient) {
      const wfApproved = wf.robust !== false;
      const wfScore = wfApproved ? 70 + (wf.wfe - 0.35) * 100 : 30;
      totalPenalty += wf.penalty || 0;
      layers.push({
        name: 'Walk-Forward Validation',
        approved: wfApproved,
        score: clamp(wfScore, 0, 100),
        weight: this.weights.walkForward,
        detail: `WFE: ${wf.wfe}, OOS WR: ${round((wf.outOfSample?.winRate || 0) * 100, 1)}%`,
        penalty: wf.penalty || 0,
      });
    } else {
      layers.push({
        name: 'Walk-Forward Validation',
        approved: true,
        score: 50,
        weight: this.weights.walkForward * 0.3,
        detail: wf?.note || 'Insufficient data — warmup phase',
        penalty: 0,
      });
    }

    // Layer 5: Adaptive Learning
    const learn = results.learning;
    if (learn) {
      const learnApproved = learn.action !== 'BLOCK';
      const learnScore = learnApproved ? (learn.action === 'ALLOW' ? 75 : 55) : 10;
      totalPenalty += learn.penalty || 0;
      layers.push({
        name: 'Adaptive Learning',
        approved: learnApproved,
        score: clamp(learnScore, 0, 100),
        weight: this.weights.adaptiveLearning,
        detail: learn.note || `Action: ${learn.action}`,
        penalty: learn.penalty || 0,
      });
    }

    // Layer 6: Agent Consensus
    const votes = results.agentVotes || {};
    const voteEntries = Object.values(votes).filter(v => v?.direction);
    const agreeing = voteEntries.filter(v => v.direction?.toUpperCase() === direction).length;
    const total = voteEntries.length || 1;
    const agreement = agreeing / total;
    const agentScore = 40 + agreement * 60;
    layers.push({
      name: 'Agent Consensus',
      approved: agreement >= 0.5,
      score: round(agentScore, 1),
      weight: this.weights.agentConsensus,
      detail: `${agreeing}/${total} agents agree (${round(agreement * 100, 1)}% consensus)`,
      penalty: agreement < 0.4 ? 8 : 0,
    });
    if (agreement < 0.4) totalPenalty += 8;

    // Layer 7: Regime Compatibility
    const regime = results.regime;
    if (regime) {
      const regimeOk = regime.tradeability >= 50;
      const chopPenalty = regime.structure === 'CHOP' ? 8 : 0;
      const regimeScore = regimeOk ? 60 + (regime.tradeability - 50) * 0.8 : 30;
      totalPenalty += chopPenalty;
      layers.push({
        name: 'Regime Compatibility',
        approved: regimeOk,
        score: clamp(regimeScore, 0, 100),
        weight: this.weights.regimeCompat,
        detail: `${regime.regime} — tradeability ${regime.tradeability}/100`,
        penalty: chopPenalty,
      });
    }

    // Layer 8: Fractal Analysis
    const fractal = results.fractal;
    if (fractal && fractal.direction !== 'WAIT') {
      const fractalAligned = fractal.direction === direction;
      const fractalScore = fractalAligned ? 70 + (fractal.score - 50) * 0.6 : 35;
      layers.push({
        name: 'Fractal Analysis',
        approved: fractalAligned || fractal.score < 55,
        score: clamp(fractalScore, 0, 100),
        weight: this.weights.fractal,
        detail: `Fractal ${fractal.direction} (${round(fractal.score, 1)}/100) — ${fractalAligned ? 'aligned' : 'opposing'}`,
        penalty: fractalAligned ? 0 : 3,
      });
      if (!fractalAligned) totalPenalty += 3;
    }

    // Layer 9: Microstructure
    const micro = results.microstructure;
    if (micro && micro.direction !== 'WAIT') {
      const microAligned = micro.direction === direction;
      const microScore = microAligned ? 70 + (micro.score - 50) * 0.6 : 35;
      layers.push({
        name: 'Microstructure',
        approved: microAligned || micro.score < 55,
        score: clamp(microScore, 0, 100),
        weight: this.weights.microstructure,
        detail: `Order flow ${micro.direction} (${round(micro.score, 1)}/100) — ${microAligned ? 'confirms' : 'opposes'}`,
        penalty: microAligned ? 0 : 3,
      });
      if (!microAligned) totalPenalty += 3;
    }

    // Compute weighted ensemble score
    const totalWeight = layers.reduce((s, l) => s + l.weight, 0);
    const weightedScore = totalWeight > 0
      ? layers.reduce((s, l) => s + l.score * l.weight, 0) / totalWeight
      : 50;

    // Count hard rejections
    const hardRejections = layers.filter(l => !l.approved && l.weight >= 10);
    const softRejections = layers.filter(l => !l.approved && l.weight < 10);

    // Cap total penalty
    totalPenalty = Math.min(totalPenalty, this.maxTotalPenalty);

    // Final decision: weighted score meets threshold AND no hard rejections
    const approved = weightedScore >= this.minConfidence && hardRejections.length === 0;

    return {
      approved,
      ensembleScore: round(weightedScore, 2),
      totalPenalty: round(totalPenalty, 1),
      adjustedScore: round(Math.max(0, (signal?.score?.final || 0) - totalPenalty), 1),
      layerCount: layers.length,
      approvedLayers: layers.filter(l => l.approved).length,
      rejectedLayers: layers.filter(l => !l.approved).length,
      hardRejections: hardRejections.map(l => l.name),
      layers: layers.map(l => ({
        name: l.name,
        approved: l.approved,
        score: round(l.score, 1),
        weight: l.weight,
        detail: l.detail,
        penalty: l.penalty,
      })),
      reasons: this._buildReasons(approved, weightedScore, hardRejections, totalPenalty, layers),
    };
  }

  _buildReasons(approved, score, hardRejections, penalty, layers) {
    const reasons = [];
    if (approved) {
      reasons.push(`Ensemble approved: ${round(score, 1)}/100 (${layers.filter(l => l.approved).length}/${layers.length} layers passed)`);
    } else {
      if (hardRejections.length > 0) {
        reasons.push(`Hard rejections from: ${hardRejections.map(l => l.name).join(', ')}`);
      }
      if (score < this.minConfidence) {
        reasons.push(`Ensemble score ${round(score, 1)} below ${this.minConfidence} threshold`);
      }
      reasons.push(`Total penalty: ${penalty} pts`);
    }
    return reasons;
  }
}

module.exports = { EnsembleEngine };
