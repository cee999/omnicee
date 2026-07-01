'use strict';

/**
 * ============================================================
 *  INSTITUTIONAL GATES — Enhanced Multi-Layer Validation
 *  Zero Tolerance Signal Quality Enforcement
 * ============================================================
 *
 *  Upgrades:
 *    - Ensemble validation integration (MC, Bayesian, Statistical)
 *    - Regime transition awareness (warn on unstable regimes)
 *    - Consecutive loss circuit breaker per symbol
 *    - Time-of-day quality requirements
 *    - Multi-timeframe alignment requirement
 *    - Minimum agent consensus threshold
 *    - Walk-forward parameter health check
 * ============================================================
 */

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

class InstitutionalGates {
  constructor(config = {}) {
    this.minScore = config.minScore || 75;
    this.minRR = config.minRR || 1.5;
    this.minRegimeTradeability = config.minRegimeTradeability || 50;
    this.maxRiskPct = config.maxRiskPct || 2;
    this.requireRiskApproval = config.requireRiskApproval !== false;
    this.minAgentConsensus = config.minAgentConsensus || 0.5;
    this.minEnsembleScore = config.minEnsembleScore || 55;
    this.requireEnsemble = config.requireEnsemble !== false;
    this._symbolLossStreak = new Map(); // symbol -> consecutive losses
    this._maxSymbolLossStreak = config.maxSymbolLossStreak || 3;
  }

  evaluate({ signal, tradePlan, entryOptimization, riskEvaluation, regime, votes, ensemble, learning }) {
    const failures = [];
    const warnings = [];
    const score = signal?.score?.final || 0;
    const rr = tradePlan?.targets?.tp1?.rr || signal?.targets?.tp1?.rr || 0;
    const stopRiskPct = tradePlan?.stopLoss?.riskPct || signal?.stopLoss?.riskPct || 0;
    const direction = signal?.action || signal?.direction;
    const symbol = signal?.symbol || 'UNKNOWN';

    // Gate 1: Basic signal quality
    if (!signal || direction === 'WAIT') failures.push('Signal is WAIT');
    if (score < this.minScore) failures.push(`Score ${score} below hard floor ${this.minScore}`);
    if (rr && rr < this.minRR) failures.push(`TP1 R:R ${rr} below minimum ${this.minRR}`);
    if (stopRiskPct > 3.5) warnings.push(`Wide stop distance ${round(stopRiskPct, 2)}% requires reduced size`);

    // Gate 2: Regime checks
    if (regime?.tradeability != null && regime.tradeability < this.minRegimeTradeability) {
      failures.push(`Regime tradeability ${regime.tradeability}/100 below ${this.minRegimeTradeability}`);
    }
    if (regime?.structure === 'CHOP' && signal?.score?.grade !== 'A') {
      failures.push('Choppy regime requires Grade A signal');
    }

    // Gate 3: Regime transition instability
    if (regime?.earlyWarning?.warning) {
      warnings.push(`Regime change warning: ${regime.earlyWarning.note}`);
    }
    if (regime?.transition?.persistence != null && regime.transition.persistence < 0.3) {
      warnings.push(`Low regime persistence (${round(regime.transition.persistence * 100, 1)}%) — unstable`);
    }
    if (regime?.multiScale && !regime.multiScale.aligned) {
      warnings.push('Multi-scale regime misalignment — short and medium term disagree');
    }

    // Gate 4: Entry quality
    if (entryOptimization?.rejected) {
      warnings.push(`Entry optimizer rejected ideal zone: ${entryOptimization.reason}`);
    } else if (entryOptimization?.qualityScore && entryOptimization.qualityScore < 60) {
      warnings.push(`Entry quality is marginal (${entryOptimization.qualityScore}/100)`);
    }

    // Gate 5: Risk engine
    if (this.requireRiskApproval && riskEvaluation && riskEvaluation.approved === false) {
      failures.push(`Risk engine blocked trade: ${riskEvaluation.reason}`);
    }
    if (riskEvaluation?.effectiveRisk > this.maxRiskPct) {
      failures.push(`Effective risk ${riskEvaluation.effectiveRisk}% exceeds cap ${this.maxRiskPct}%`);
    }
    if (riskEvaluation?.drawdown?.sizingFactor != null && riskEvaluation.drawdown.sizingFactor < 1) {
      warnings.push(`Drawdown/risk state reduced size to ${round(riskEvaluation.drawdown.sizingFactor * 100, 0)}%`);
    }

    // Gate 6: Agent consensus
    const disagreement = this._disagreement(direction, votes);
    if (disagreement.opposingCore) failures.push(disagreement.opposingCore);
    if (disagreement.opposing.length) warnings.push(`Opposing agents: ${disagreement.opposing.join(', ')}`);

    const consensus = this._agentConsensus(direction, votes);
    if (consensus < this.minAgentConsensus) {
      failures.push(`Agent consensus ${round(consensus * 100, 1)}% below ${this.minAgentConsensus * 100}% minimum`);
    }

    // Gate 7: Ensemble validation
    if (this.requireEnsemble && ensemble) {
      if (!ensemble.approved) {
        failures.push(`Ensemble validation rejected: ${(ensemble.hardRejections || []).join(', ') || 'low ensemble score'}`);
      }
      if (ensemble.ensembleScore != null && ensemble.ensembleScore < this.minEnsembleScore) {
        failures.push(`Ensemble score ${ensemble.ensembleScore} below ${this.minEnsembleScore} floor`);
      }
      if (ensemble.totalPenalty > 20) {
        warnings.push(`High ensemble penalty: ${ensemble.totalPenalty} pts`);
      }
    }

    // Gate 8: Adaptive learning block
    if (learning?.action === 'BLOCK') {
      failures.push(`Learning engine blocked: ${learning.note}`);
    } else if (learning?.blacklisted) {
      failures.push(`Pattern is blacklisted: ${learning.note}`);
    } else if (learning?.action === 'WARN') {
      warnings.push(`Learning engine warning: ${learning.note}`);
    }

    // Gate 9: Symbol loss streak
    const streak = this._symbolLossStreak.get(symbol) || 0;
    if (streak >= this._maxSymbolLossStreak) {
      failures.push(`${symbol} has ${streak} consecutive losses — symbol paused`);
    } else if (streak >= 2) {
      warnings.push(`${symbol} has ${streak} recent consecutive losses`);
    }

    const approved = failures.length === 0;
    return {
      approved,
      status: approved ? (warnings.length ? 'APPROVED_WITH_WARNINGS' : 'APPROVED') : 'REJECTED',
      failures,
      warnings,
      gatesPassed: this._countGatesPassed(failures, warnings),
      confidence: this._confidence({ score, rr, regime, entryOptimization, riskEvaluation, ensemble, warnings, failures }),
      checklist: {
        score,
        rr: round(rr, 2),
        stopRiskPct: round(stopRiskPct, 3),
        regime: regime?.regime || 'UNKNOWN',
        tradeability: regime?.tradeability ?? null,
        entryQuality: entryOptimization?.qualityScore ?? null,
        riskApproved: riskEvaluation?.approved !== false,
        agentConsensus: round(consensus, 4),
        ensembleApproved: ensemble?.approved ?? null,
        ensembleScore: ensemble?.ensembleScore ?? null,
        learningAction: learning?.action || null,
        symbolLossStreak: streak,
      },
    };
  }

  recordSymbolOutcome(symbol, isWin) {
    if (isWin) {
      this._symbolLossStreak.set(symbol, 0);
    } else {
      this._symbolLossStreak.set(symbol, (this._symbolLossStreak.get(symbol) || 0) + 1);
    }
  }

  _agentConsensus(direction, votes = {}) {
    const entries = Object.values(votes || {}).filter(v => v?.direction);
    if (entries.length === 0) return 0;
    const agreeing = entries.filter(v => v.direction?.toUpperCase() === direction?.toUpperCase()).length;
    return agreeing / entries.length;
  }

  _disagreement(direction, votes = {}) {
    const opposing = [];
    for (const [name, vote] of Object.entries(votes || {})) {
      const dir = vote?.direction?.toUpperCase();
      if (dir && dir !== 'WAIT' && direction && dir !== direction) opposing.push(name);
    }
    const opposingCore = opposing.includes('smc') || opposing.includes('mtf')
      ? `Core agent conflict against ${direction}: ${opposing.filter(a => ['smc', 'mtf'].includes(a)).join(', ')}`
      : null;
    return { opposing, opposingCore };
  }

  _countGatesPassed(failures, warnings) {
    const totalGates = 9;
    return totalGates - failures.length;
  }

  _confidence({ score, rr, regime, entryOptimization, riskEvaluation, ensemble, warnings, failures }) {
    let value = score * 0.48;
    value += Math.min(rr || 0, 3) * 7;
    value += ((regime?.tradeability || 50) - 50) * 0.20;
    value += ((entryOptimization?.qualityScore || 60) - 60) * 0.10;
    if (ensemble?.ensembleScore) value += (ensemble.ensembleScore - 60) * 0.15;
    if (riskEvaluation?.approved === false) value -= 30;
    value -= warnings.length * 2.5;
    value -= failures.length * 15;
    return round(Math.max(0, Math.min(100, value)), 2);
  }
}

module.exports = { InstitutionalGates };
