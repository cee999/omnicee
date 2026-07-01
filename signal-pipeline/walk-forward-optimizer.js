'use strict';

/**
 * ============================================================
 *  WALK-FORWARD OPTIMIZER
 *  Continuous Out-of-Sample Parameter Validation
 * ============================================================
 *
 *  Prevents overfitting by continuously testing signal parameters
 *  on unseen data:
 *
 *  1. Splits historical signals into in-sample (IS) and
 *     out-of-sample (OOS) windows
 *  2. Evaluates whether IS performance persists OOS
 *  3. Adjusts agent weights, score thresholds, and regime
 *     parameters dynamically
 *  4. Tracks walk-forward efficiency (WFE) — the ratio of
 *     OOS performance to IS performance
 *  5. Detects parameter degradation and triggers recalibration
 *
 *  Walk-Forward Efficiency:
 *    WFE = OOS_Sharpe / IS_Sharpe
 *    WFE > 0.5 = robust parameters
 *    WFE < 0.3 = overfitted, needs recalibration
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

class WalkForwardOptimizer {
  constructor(config = {}) {
    this.isRatio = config.isRatio || 0.7;      // 70% in-sample
    this.oosRatio = config.oosRatio || 0.3;     // 30% out-of-sample
    this.minSamples = config.minSamples || 20;
    this.minWFE = config.minWFE || 0.35;
    this.recalibrationThreshold = config.recalibrationThreshold || 0.25;
    this.windowSize = config.windowSize || 100;
    this.stepSize = config.stepSize || 20;

    this._signalHistory = [];
    this._outcomeHistory = [];
    this._currentWFE = null;
    this._lastCalibration = null;
    this._weightAdjustments = {};
    this._parameterHistory = [];
  }

  /**
   * Record a completed signal with its outcome for walk-forward analysis
   */
  recordOutcome({ signal, outcome }) {
    const record = {
      timestamp: signal?.timestamp || Date.now(),
      symbol: signal?.symbol,
      timeframe: signal?.timeframe,
      direction: signal?.action || signal?.direction,
      score: signal?.score?.final || 0,
      grade: signal?.score?.grade || 'D',
      agentScores: {
        smc: signal?.agentBreakdown?.find(a => a.agent?.includes('SMC'))?.score || 0,
        mtf: signal?.agentBreakdown?.find(a => a.agent?.includes('MTF'))?.score || 0,
        momentum: signal?.agentBreakdown?.find(a => a.agent?.includes('Momentum'))?.score || 0,
        volumeOI: signal?.agentBreakdown?.find(a => a.agent?.includes('Volume'))?.score || 0,
        sentiment: signal?.agentBreakdown?.find(a => a.agent?.includes('Sent'))?.score || 0,
      },
      regime: signal?.regime?.regime || 'UNKNOWN',
      pnlR: Number(outcome?.pnlR || outcome?.r || 0),
      isWin: (outcome?.pnlR || outcome?.r || 0) > 0,
    };

    this._outcomeHistory.push(record);

    // Trim to window
    if (this._outcomeHistory.length > this.windowSize * 3) {
      this._outcomeHistory = this._outcomeHistory.slice(-this.windowSize * 2);
    }
  }

  /**
   * Run walk-forward analysis to check parameter robustness
   */
  analyze() {
    const data = this._outcomeHistory;
    if (data.length < this.minSamples) {
      return {
        sufficient: false,
        wfe: null,
        note: `Need ${this.minSamples} outcomes, have ${data.length}`,
        adjustments: {},
      };
    }

    // Split into IS/OOS
    const splitIdx = Math.floor(data.length * this.isRatio);
    const inSample = data.slice(0, splitIdx);
    const outOfSample = data.slice(splitIdx);

    if (outOfSample.length < 5) {
      return {
        sufficient: false,
        wfe: null,
        note: 'Not enough out-of-sample data yet',
        adjustments: {},
      };
    }

    // Compute IS and OOS metrics
    const isMetrics = this._computeMetrics(inSample);
    const oosMetrics = this._computeMetrics(outOfSample);

    // Walk-Forward Efficiency
    const wfe = isMetrics.sharpe !== 0
      ? oosMetrics.sharpe / isMetrics.sharpe
      : 0;

    this._currentWFE = round(wfe, 4);

    // Agent-level WFE (which agents are robust OOS?)
    const agentWFE = this._computeAgentWFE(inSample, outOfSample);

    // Weight adjustments based on OOS performance
    const adjustments = this._computeAdjustments(agentWFE, oosMetrics);

    // Regime-level analysis
    const regimePerformance = this._regimePerformance(data);

    // Detect parameter degradation
    const degradation = this._detectDegradation(data);

    const needsRecalibration = wfe < this.recalibrationThreshold || degradation.degrading;

    // Store calibration state
    this._lastCalibration = {
      timestamp: Date.now(),
      wfe: round(wfe, 4),
      isMetrics,
      oosMetrics,
      agentWFE,
      adjustments,
    };

    this._parameterHistory.push({
      timestamp: Date.now(),
      wfe: round(wfe, 4),
      winRate: oosMetrics.winRate,
      sharpe: oosMetrics.sharpe,
    });

    return {
      sufficient: true,
      wfe: round(wfe, 4),
      robust: wfe >= this.minWFE,
      needsRecalibration,
      inSample: {
        count: inSample.length,
        winRate: round(isMetrics.winRate, 4),
        sharpe: round(isMetrics.sharpe, 4),
        expectancy: round(isMetrics.expectancy, 4),
        profitFactor: round(isMetrics.profitFactor, 4),
      },
      outOfSample: {
        count: outOfSample.length,
        winRate: round(oosMetrics.winRate, 4),
        sharpe: round(oosMetrics.sharpe, 4),
        expectancy: round(oosMetrics.expectancy, 4),
        profitFactor: round(oosMetrics.profitFactor, 4),
      },
      agentWFE: Object.fromEntries(
        Object.entries(agentWFE).map(([k, v]) => [k, round(v, 4)])
      ),
      adjustments,
      regimePerformance,
      degradation,
      penalty: needsRecalibration ? 10 : wfe < this.minWFE ? 5 : 0,
      reasons: this._buildReasons(wfe, oosMetrics, degradation, needsRecalibration),
    };
  }

  /**
   * Get recommended weight adjustments for the signal scorer
   */
  getWeightAdjustments() {
    return this._weightAdjustments;
  }

  _computeMetrics(records) {
    if (records.length === 0) return { winRate: 0, sharpe: 0, expectancy: 0, profitFactor: 0, maxDD: 0 };

    const pnls = records.map(r => r.pnlR);
    const wins = records.filter(r => r.isWin);
    const losses = records.filter(r => !r.isWin);

    const winRate = wins.length / records.length;
    const expectancy = avg(pnls);
    const std = stddev(pnls);
    const sharpe = std > 0 ? expectancy / std : 0;

    const avgWin = wins.length > 0 ? avg(wins.map(r => r.pnlR)) : 0;
    const avgLoss = losses.length > 0 ? Math.abs(avg(losses.map(r => r.pnlR))) : 0;
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

    // Max drawdown in R
    let peak = 0, dd = 0, maxDD = 0;
    let cum = 0;
    for (const p of pnls) {
      cum += p;
      if (cum > peak) peak = cum;
      dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }

    return { winRate, sharpe, expectancy, profitFactor, maxDD, count: records.length };
  }

  _computeAgentWFE(inSample, outOfSample) {
    const agents = ['smc', 'mtf', 'momentum', 'volumeOI', 'sentiment'];
    const wfe = {};

    for (const agent of agents) {
      // Correlation between agent score and outcome in IS vs OOS
      const isCorr = this._correlation(
        inSample.map(r => r.agentScores[agent] || 0),
        inSample.map(r => r.pnlR)
      );
      const oosCorr = this._correlation(
        outOfSample.map(r => r.agentScores[agent] || 0),
        outOfSample.map(r => r.pnlR)
      );

      wfe[agent] = isCorr !== 0 ? oosCorr / Math.abs(isCorr) : 0;
    }

    return wfe;
  }

  _computeAdjustments(agentWFE, oosMetrics) {
    const adjustments = {};

    for (const [agent, wfe] of Object.entries(agentWFE)) {
      if (wfe > 0.6) {
        adjustments[agent] = { action: 'INCREASE', factor: 1.1, reason: `Strong OOS predictive power (WFE: ${round(wfe, 2)})` };
      } else if (wfe < 0.2) {
        adjustments[agent] = { action: 'DECREASE', factor: 0.8, reason: `Weak OOS predictive power (WFE: ${round(wfe, 2)})` };
      } else if (wfe < 0) {
        adjustments[agent] = { action: 'REDUCE', factor: 0.6, reason: `Negative OOS correlation — agent hurting performance (WFE: ${round(wfe, 2)})` };
      } else {
        adjustments[agent] = { action: 'MAINTAIN', factor: 1.0, reason: 'Adequate OOS performance' };
      }
    }

    this._weightAdjustments = adjustments;
    return adjustments;
  }

  _regimePerformance(data) {
    const regimes = {};
    for (const r of data) {
      const regime = r.regime || 'UNKNOWN';
      if (!regimes[regime]) regimes[regime] = { wins: 0, losses: 0, pnls: [] };
      if (r.isWin) regimes[regime].wins++;
      else regimes[regime].losses++;
      regimes[regime].pnls.push(r.pnlR);
    }

    const result = {};
    for (const [regime, stats] of Object.entries(regimes)) {
      const total = stats.wins + stats.losses;
      result[regime] = {
        winRate: round(stats.wins / total, 4),
        expectancy: round(avg(stats.pnls), 4),
        samples: total,
        tradeable: stats.wins / total > 0.45 && avg(stats.pnls) > 0,
      };
    }

    return result;
  }

  _detectDegradation(data) {
    if (data.length < 20) return { degrading: false, note: 'Insufficient data' };

    // Compare last 10 trades to previous window
    const recent = data.slice(-10);
    const older = data.slice(-30, -10);

    if (older.length < 10) return { degrading: false, note: 'Insufficient comparison data' };

    const recentWR = recent.filter(r => r.isWin).length / recent.length;
    const olderWR = older.filter(r => r.isWin).length / older.length;
    const recentExp = avg(recent.map(r => r.pnlR));
    const olderExp = avg(older.map(r => r.pnlR));

    const wrDrop = olderWR - recentWR;
    const expDrop = olderExp - recentExp;

    const degrading = wrDrop > 0.15 || (expDrop > 0.5 && recentExp < 0);

    return {
      degrading,
      recentWinRate: round(recentWR, 4),
      previousWinRate: round(olderWR, 4),
      winRateDelta: round(-wrDrop, 4),
      recentExpectancy: round(recentExp, 4),
      previousExpectancy: round(olderExp, 4),
      note: degrading
        ? `Performance degradation detected: WR dropped ${round(wrDrop * 100, 1)}pp`
        : 'Performance stable',
    };
  }

  _correlation(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 5) return 0;

    const xSlice = x.slice(0, n);
    const ySlice = y.slice(0, n);
    const xMean = avg(xSlice);
    const yMean = avg(ySlice);

    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xSlice[i] - xMean;
      const dy = ySlice[i] - yMean;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }

    const den = Math.sqrt(denX * denY);
    return den > 0 ? num / den : 0;
  }

  _buildReasons(wfe, oosMetrics, degradation, needsRecalibration) {
    const reasons = [];
    if (wfe >= this.minWFE) {
      reasons.push(`WFE ${round(wfe, 2)} — parameters are robust out-of-sample`);
    } else {
      reasons.push(`WFE ${round(wfe, 2)} below ${this.minWFE} — parameters may be overfitted`);
    }
    if (oosMetrics.winRate < 0.45) {
      reasons.push(`OOS win rate ${round(oosMetrics.winRate * 100, 1)}% is below breakeven`);
    }
    if (degradation.degrading) {
      reasons.push(`Performance degradation: ${degradation.note}`);
    }
    if (needsRecalibration) {
      reasons.push('Recalibration recommended');
    }
    return reasons;
  }

  getStats() {
    return {
      totalOutcomes: this._outcomeHistory.length,
      currentWFE: this._currentWFE,
      lastCalibration: this._lastCalibration?.timestamp || null,
      parameterHistory: this._parameterHistory.slice(-20),
      weightAdjustments: this._weightAdjustments,
    };
  }
}

module.exports = { WalkForwardOptimizer };
