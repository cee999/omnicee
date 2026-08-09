'use strict';

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const mean = avg(arr);
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
}

function stddev(arr) {
  return Math.sqrt(variance(arr));
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalCDF(z) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function pValue2Tail(z) {
  return 2 * (1 - normalCDF(Math.abs(z)));
}

class StatisticalValidator {
  constructor(config = {}) {
    this.minTestsPassed = config.minTestsPassed || 5;
    this.significanceLevel = config.significanceLevel || 0.05;
    this.bootstrapIterations = config.bootstrapIterations || 2000;
  }

  validate({ candles, signal, tradePlan, regime }) {
    if (!candles || candles.length < 50) {
      return this._insufficient('Need at least 50 candles for statistical validation');
    }

    const closes = candles.map(c => c.close);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
      }
    }

    const direction = (signal?.action || signal?.direction || 'WAIT').toUpperCase();
    const entry = tradePlan?.entry?.midPoint || signal?.entry?.midpoint || closes[closes.length - 1];
    const sl = tradePlan?.stopLoss?.price || signal?.stopLoss?.price || null;

    const tests = [];

    tests.push(this._meanReversionTest(closes, direction));

    tests.push(this._trendSignificanceTest(closes, direction));

    tests.push(this._autocorrelationTest(returns));

    tests.push(this._varianceRatioTest(returns));

    tests.push(this._runsTest(returns));

    tests.push(this._hurstExponent(returns));

    tests.push(this._signalZScore(signal));

    tests.push(this._bootstrapCI(returns, direction));

    tests.push(this._cusumTest(returns));

    tests.push(this._volatilityStabilityTest(returns));

    const passed = tests.filter(t => t.passed).length;
    const failed = tests.filter(t => !t.passed && !t.neutral).length;
    const neutral = tests.filter(t => t.neutral).length;
    const approved = passed >= this.minTestsPassed;

    const compositeScore = round(
      tests.reduce((s, t) => s + (t.passed ? t.weight : t.neutral ? 0 : -t.weight * 0.5), 0)
      / tests.reduce((s, t) => s + t.weight, 0) * 100,
      1
    );

    return {
      approved,
      passed,
      failed,
      neutral,
      total: tests.length,
      compositeScore,
      tests: tests.map(t => ({
        name: t.name,
        passed: t.passed,
        neutral: t.neutral || false,
        pValue: t.pValue != null ? round(t.pValue, 4) : null,
        statistic: t.statistic != null ? round(t.statistic, 4) : null,
        note: t.note,
        weight: t.weight,
      })),
      penalty: approved ? 0 : Math.min(15, Math.round((this.minTestsPassed - passed) * 3)),
      reasons: approved
        ? [`Statistical validation passed ${passed}/${tests.length} tests (composite: ${compositeScore})`]
        : [`Statistical validation failed: only ${passed}/${tests.length} tests passed (need ${this.minTestsPassed})`],
    };
  }

  _meanReversionTest(closes, direction) {
    const period = Math.min(50, closes.length);
    const recent = closes.slice(-period);
    const mean = avg(recent);
    const std = stddev(recent);
    const current = closes[closes.length - 1];
    const zScore = std > 0 ? (current - mean) / std : 0;

    const passed = direction === 'LONG'
      ? zScore < 2.0 && zScore > -2.5
      : zScore > -2.0 && zScore < 2.5;

    return {
      name: 'Mean Reversion Extension',
      passed,
      pValue: pValue2Tail(zScore),
      statistic: zScore,
      note: `Price z-score: ${round(zScore, 2)} (${zScore > 2 ? 'overbought' : zScore < -2 ? 'oversold' : 'normal'})`,
      weight: 1.5,
    };
  }

  _trendSignificanceTest(closes, direction) {
    const n = Math.min(30, closes.length);
    const data = closes.slice(-n);

    const xMean = (n - 1) / 2;
    const yMean = avg(data);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (data[i] - yMean);
      den += (i - xMean) ** 2;
    }
    const slope = den !== 0 ? num / den : 0;

    const residuals = data.map((y, i) => y - (yMean + slope * (i - xMean)));
    const sse = residuals.reduce((s, r) => s + r * r, 0);
    const mse = sse / (n - 2);
    const slopeStdErr = Math.sqrt(mse / den);
    const tStat = slopeStdErr > 0 ? slope / slopeStdErr : 0;
    const pVal = pValue2Tail(tStat);

    const trendAligned = direction === 'LONG' ? slope > 0 : slope < 0;
    const significant = pVal < this.significanceLevel;

    return {
      name: 'Trend Significance',
      passed: significant && trendAligned,
      neutral: !significant,
      pValue: pVal,
      statistic: tStat,
      note: `Slope: ${round(slope, 6)}, t=${round(tStat, 2)}, p=${round(pVal, 4)} — ${significant ? 'significant' : 'not significant'}, ${trendAligned ? 'aligned' : 'opposing'}`,
      weight: 2.0,
    };
  }

  _autocorrelationTest(returns) {
    const n = returns.length;
    if (n < 30) return { name: 'Autocorrelation', passed: false, neutral: true, note: 'Insufficient data', weight: 1.0 };

    const mean = avg(returns);
    const denom = returns.reduce((s, r) => s + (r - mean) ** 2, 0);

    const lags = [1, 2, 3, 4, 5];
    const acfs = lags.map(lag => {
      let num = 0;
      for (let i = lag; i < n; i++) {
        num += (returns[i] - mean) * (returns[i - lag] - mean);
      }
      return denom > 0 ? num / denom : 0;
    });

    let Q = 0;
    for (let k = 0; k < lags.length; k++) {
      Q += (acfs[k] ** 2) / (n - lags[k]);
    }
    Q *= n * (n + 2);

    const df = lags.length;
    const z = Math.pow(Q / df, 1 / 3) - (1 - 2 / (9 * df));
    const pVal = 1 - normalCDF(z / Math.sqrt(2 / (9 * df)));

    const hasAutocorrelation = pVal < this.significanceLevel;

    return {
      name: 'Autocorrelation (Ljung-Box)',
      passed: hasAutocorrelation,
      neutral: !hasAutocorrelation,
      pValue: round(pVal, 4),
      statistic: round(Q, 2),
      note: `Q=${round(Q, 2)}, p=${round(pVal, 4)} — ${hasAutocorrelation ? 'significant serial dependence' : 'consistent with random walk'}`,
      weight: 1.0,
    };
  }

  _varianceRatioTest(returns) {
    const n = returns.length;
    if (n < 30) return { name: 'Variance Ratio', passed: false, neutral: true, note: 'Insufficient data', weight: 1.5 };

    const q = 5;
    const var1 = variance(returns);

    const qReturns = [];
    for (let i = q; i <= n; i++) {
      const sum = returns.slice(i - q, i).reduce((s, r) => s + r, 0);
      qReturns.push(sum);
    }
    const varQ = variance(qReturns);

    const vr = var1 > 0 ? varQ / (q * var1) : 1;

    const zStat = (vr - 1) / Math.sqrt(2 * (q - 1) / (n * q));
    const pVal = pValue2Tail(zStat);

    const isTrending = vr > 1;
    const significant = pVal < this.significanceLevel;

    return {
      name: 'Variance Ratio Test',
      passed: significant,
      neutral: !significant,
      pValue: round(pVal, 4),
      statistic: round(vr, 4),
      note: `VR(${q})=${round(vr, 3)}, z=${round(zStat, 2)} — ${isTrending ? 'trending' : 'mean-reverting'}${significant ? ' (significant)' : ''}`,
      weight: 1.5,
    };
  }

  _runsTest(returns) {
    const n = returns.length;
    if (n < 20) return { name: 'Runs Test', passed: false, neutral: true, note: 'Insufficient data', weight: 1.0 };

    const med = median(returns);
    const signs = returns.map(r => r >= med ? 1 : 0);

    let runs = 1;
    for (let i = 1; i < n; i++) {
      if (signs[i] !== signs[i - 1]) runs++;
    }

    const n1 = signs.filter(s => s === 1).length;
    const n0 = n - n1;
    const expectedRuns = 1 + (2 * n1 * n0) / n;
    const stdRuns = Math.sqrt((2 * n1 * n0 * (2 * n1 * n0 - n)) / (n * n * (n - 1)));
    const zStat = stdRuns > 0 ? (runs - expectedRuns) / stdRuns : 0;
    const pVal = pValue2Tail(zStat);

    const nonRandom = pVal < this.significanceLevel;

    return {
      name: 'Runs Test',
      passed: nonRandom,
      neutral: !nonRandom,
      pValue: round(pVal, 4),
      statistic: round(zStat, 2),
      note: `Runs=${runs}, expected=${round(expectedRuns, 1)}, z=${round(zStat, 2)} — ${nonRandom ? 'non-random' : 'random'}`,
      weight: 1.0,
    };
  }

  _hurstExponent(returns) {
    const n = returns.length;
    if (n < 40) return { name: 'Hurst Exponent', passed: false, neutral: true, note: 'Insufficient data', weight: 2.0 };

    const partitions = [10, 15, 20, 30, 40].filter(p => p <= n / 2);
    if (partitions.length < 2) return { name: 'Hurst Exponent', passed: false, neutral: true, note: 'Insufficient data for R/S', weight: 2.0 };

    const logN = [];
    const logRS = [];

    for (const size of partitions) {
      const nBlocks = Math.floor(n / size);
      let rsSum = 0;

      for (let b = 0; b < nBlocks; b++) {
        const block = returns.slice(b * size, (b + 1) * size);
        const mean = avg(block);
        const deviations = block.map(r => r - mean);

        const cumDev = [];
        let cumSum = 0;
        for (const d of deviations) {
          cumSum += d;
          cumDev.push(cumSum);
        }

        const R = Math.max(...cumDev) - Math.min(...cumDev);
        const S = stddev(block);
        rsSum += S > 0 ? R / S : 0;
      }

      const avgRS = rsSum / nBlocks;
      if (avgRS > 0) {
        logN.push(Math.log(size));
        logRS.push(Math.log(avgRS));
      }
    }

    if (logN.length < 2) return { name: 'Hurst Exponent', passed: false, neutral: true, note: 'R/S regression failed', weight: 2.0 };

    const xMean = avg(logN);
    const yMean = avg(logRS);
    let num = 0, den = 0;
    for (let i = 0; i < logN.length; i++) {
      num += (logN[i] - xMean) * (logRS[i] - yMean);
      den += (logN[i] - xMean) ** 2;
    }
    const H = den !== 0 ? num / den : 0.5;

    const passed = H > 0.55 || H < 0.45;
    const isTrending = H > 0.55;

    return {
      name: 'Hurst Exponent',
      passed,
      neutral: !passed,
      statistic: round(H, 4),
      note: `H=${round(H, 3)} — ${isTrending ? 'trending/persistent' : H < 0.45 ? 'mean-reverting' : 'random walk'}`,
      weight: 2.0,
    };
  }

  _signalZScore(signal) {
    const score = signal?.score?.final || 0;
    const baselineMean = 65;
    const baselineStd = 12;
    const zScore = baselineStd > 0 ? (score - baselineMean) / baselineStd : 0;

    return {
      name: 'Signal Z-Score',
      passed: zScore > 0.8,
      pValue: 1 - normalCDF(zScore),
      statistic: round(zScore, 2),
      note: `Signal score z=${round(zScore, 2)} (${score}/100) — ${zScore > 1.5 ? 'exceptional' : zScore > 0.8 ? 'strong' : 'average'}`,
      weight: 1.5,
    };
  }

  _bootstrapCI(returns, direction) {
    const n = returns.length;
    if (n < 20) return { name: 'Bootstrap CI', passed: false, neutral: true, note: 'Insufficient data', weight: 1.5 };

    const means = [];
    for (let i = 0; i < this.bootstrapIterations; i++) {
      const sample = [];
      for (let j = 0; j < n; j++) {
        sample.push(returns[Math.floor(Math.random() * n)]);
      }
      means.push(avg(sample));
    }

    means.sort((a, b) => a - b);
    const ci95Low = means[Math.floor(means.length * 0.025)];
    const ci95High = means[Math.floor(means.length * 0.975)];
    const bootstrapMean = avg(means);

    const aligned = direction === 'LONG'
      ? ci95Low > -0.0001
      : ci95High < 0.0001;

    return {
      name: 'Bootstrap Confidence Interval',
      passed: aligned,
      statistic: round(bootstrapMean, 6),
      note: `Mean return: ${round(bootstrapMean * 100, 3)}%, 95% CI: [${round(ci95Low * 100, 3)}%, ${round(ci95High * 100, 3)}%]`,
      weight: 1.5,
    };
  }

  _cusumTest(returns) {
    const n = returns.length;
    if (n < 30) return { name: 'CUSUM Regime Change', passed: true, neutral: false, note: 'Insufficient data — no regime change assumed', weight: 1.0 };

    const mean = avg(returns);
    const cumSum = [];
    let s = 0;
    for (const r of returns) {
      s += (r - mean);
      cumSum.push(s);
    }

    const maxAbsCusum = Math.max(...cumSum.map(Math.abs));
    const std = stddev(returns);
    const threshold = std * Math.sqrt(n) * 1.36;

    const recentCusum = cumSum.slice(-10);
    const recentMaxAbs = Math.max(...recentCusum.map(Math.abs));
    const recentRegimeChange = recentMaxAbs > threshold * 0.7;

    return {
      name: 'CUSUM Regime Change',
      passed: !recentRegimeChange,
      statistic: round(recentMaxAbs, 4),
      note: `CUSUM peak: ${round(recentMaxAbs, 4)} (threshold: ${round(threshold, 4)}) — ${recentRegimeChange ? 'regime shift detected!' : 'stable regime'}`,
      weight: 1.5,
    };
  }

  _volatilityStabilityTest(returns) {
    const n = returns.length;
    if (n < 40) return { name: 'Volatility Stability', passed: true, neutral: false, note: 'Insufficient data', weight: 1.0 };

    const recentVol = stddev(returns.slice(-15));
    const historicalVol = stddev(returns.slice(0, -15));

    const volRatio = historicalVol > 0 ? recentVol / historicalVol : 1;

    const fStat = (recentVol ** 2) / (historicalVol ** 2 || 1e-10);
    const df1 = 14;
    const df2 = returns.length - 16;

    const stable = volRatio >= 0.5 && volRatio <= 2.0;

    return {
      name: 'Volatility Stability',
      passed: stable,
      statistic: round(volRatio, 3),
      note: `Vol ratio: ${round(volRatio, 2)} (recent/historical) — ${stable ? 'stable' : volRatio > 2 ? 'expanding dangerously' : 'compressing'}`,
      weight: 1.0,
    };
  }

  _insufficient(reason) {
    return {
      approved: true,
      passed: 0,
      failed: 0,
      total: 0,
      tests: [],
      penalty: 0,
      reasons: [reason],
    };
  }
}

module.exports = { StatisticalValidator };
