'use strict';

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
  }

  evaluate({ signal, tradePlan, entryOptimization, riskEvaluation, regime, votes }) {
    const failures = [];
    const warnings = [];
    const score = signal?.score?.final || 0;
    const rr = tradePlan?.targets?.tp1?.rr || signal?.targets?.tp1?.rr || 0;
    const stopRiskPct = tradePlan?.stopLoss?.riskPct || signal?.stopLoss?.riskPct || 0;
    const direction = signal?.action || signal?.direction;

    if (!signal || direction === 'WAIT') failures.push('Signal is WAIT');
    if (score < this.minScore) failures.push(`Score ${score} below hard floor ${this.minScore}`);
    if (rr && rr < this.minRR) failures.push(`TP1 R:R ${rr} below minimum ${this.minRR}`);
    if (stopRiskPct > 3.5) warnings.push(`Wide stop distance ${round(stopRiskPct, 2)}% requires reduced size`);

    if (regime?.tradeability != null && regime.tradeability < this.minRegimeTradeability) {
      failures.push(`Regime tradeability ${regime.tradeability}/100 below ${this.minRegimeTradeability}`);
    }
    if (regime?.structure === 'CHOP' && signal?.score?.grade !== 'A') {
      failures.push('Choppy regime requires Grade A signal');
    }
    if (entryOptimization?.rejected) {
      warnings.push(`Entry optimizer rejected ideal zone: ${entryOptimization.reason}`);
    } else if (entryOptimization?.qualityScore && entryOptimization.qualityScore < 60) {
      warnings.push(`Entry quality is marginal (${entryOptimization.qualityScore}/100)`);
    }

    if (this.requireRiskApproval && riskEvaluation && riskEvaluation.approved === false) {
      failures.push(`Risk engine blocked trade: ${riskEvaluation.reason}`);
    }
    if (riskEvaluation?.effectiveRisk > this.maxRiskPct) {
      failures.push(`Effective risk ${riskEvaluation.effectiveRisk}% exceeds cap ${this.maxRiskPct}%`);
    }
    if (riskEvaluation?.drawdown?.sizingFactor != null && riskEvaluation.drawdown.sizingFactor < 1) {
      warnings.push(`Drawdown/risk state reduced size to ${round(riskEvaluation.drawdown.sizingFactor * 100, 0)}%`);
    }

    const disagreement = this._disagreement(direction, votes);
    if (disagreement.opposingCore) failures.push(disagreement.opposingCore);
    if (disagreement.opposing.length) warnings.push(`Opposing agents: ${disagreement.opposing.join(', ')}`);

    const approved = failures.length === 0;
    return {
      approved,
      status: approved ? (warnings.length ? 'APPROVED_WITH_WARNINGS' : 'APPROVED') : 'REJECTED',
      failures,
      warnings,
      confidence: this._confidence({ score, rr, regime, entryOptimization, riskEvaluation, warnings, failures }),
      checklist: {
        score,
        rr: round(rr, 2),
        stopRiskPct: round(stopRiskPct, 3),
        regime: regime?.regime || 'UNKNOWN',
        tradeability: regime?.tradeability ?? null,
        entryQuality: entryOptimization?.qualityScore ?? null,
        riskApproved: riskEvaluation?.approved !== false,
      },
    };
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

  _confidence({ score, rr, regime, entryOptimization, riskEvaluation, warnings, failures }) {
    let value = score * 0.58;
    value += Math.min(rr || 0, 3) * 8;
    value += ((regime?.tradeability || 50) - 50) * 0.22;
    value += ((entryOptimization?.qualityScore || 60) - 60) * 0.12;
    if (riskEvaluation?.approved === false) value -= 30;
    value -= warnings.length * 3;
    value -= failures.length * 18;
    return round(Math.max(0, Math.min(100, value)), 2);
  }
}

module.exports = { InstitutionalGates };
