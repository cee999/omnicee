'use strict';

/**
 * ============================================================
 *  BAYESIAN PROBABILITY ENGINE
 *  Real-Time Posterior Updates for Trade Success
 * ============================================================
 *
 *  Uses Bayes' theorem to continuously update the probability
 *  that a signal will be profitable, given multiple evidence
 *  streams:
 *
 *    P(Win | Evidence) = P(Evidence | Win) * P(Win) / P(Evidence)
 *
 *  Evidence factors:
 *    - Agent agreement level
 *    - Regime classification
 *    - Historical pattern win rate
 *    - Volume confirmation strength
 *    - Session quality
 *    - Momentum alignment
 *    - Structure confirmation
 *    - Entry quality score
 *    - Risk/reward ratio
 *    - Correlation exposure
 *    - Volatility regime
 *    - Time-of-day performance
 *
 *  Also maintains a Naive Bayes classifier trained on historical
 *  outcomes, and a Beta-Binomial model for win rate estimation
 *  with uncertainty quantification.
 * ============================================================
 */

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

// Beta distribution PDF (unnormalized, for comparison)
function betaPDF(x, a, b) {
  if (x <= 0 || x >= 1) return 0;
  return Math.pow(x, a - 1) * Math.pow(1 - x, b - 1);
}

// Beta distribution mean and variance
function betaStats(a, b) {
  const mean = a / (a + b);
  const variance = (a * b) / ((a + b) ** 2 * (a + b + 1));
  return { mean: round(mean, 4), variance: round(variance, 6), stddev: round(Math.sqrt(variance), 4) };
}

// Log-gamma (Stirling approximation for large values)
function logGamma(x) {
  if (x <= 0) return 0;
  if (x < 7) {
    let result = 0;
    let xx = x;
    while (xx < 7) { result -= Math.log(xx); xx++; }
    return result + logGamma(xx);
  }
  return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI)
    + 1 / (12 * x) - 1 / (360 * x ** 3);
}

// Beta function B(a, b)
function logBeta(a, b) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Evidence Factor: defines a likelihood ratio for a single piece of evidence.
 * P(evidence | win) / P(evidence | loss)
 */
class EvidenceFactor {
  constructor(name, likelihoodWin, likelihoodLoss) {
    this.name = name;
    this.likelihoodWin = likelihoodWin;   // P(this evidence | trade wins)
    this.likelihoodLoss = likelihoodLoss; // P(this evidence | trade loses)
  }

  likelihoodRatio() {
    if (this.likelihoodLoss === 0) return this.likelihoodWin > 0 ? 10 : 1;
    return this.likelihoodWin / this.likelihoodLoss;
  }
}

/**
 * Naive Bayes classifier trained on historical trade features
 */
class NaiveBayesClassifier {
  constructor() {
    this._classCounts = { WIN: 0, LOSS: 0 };
    this._featureStats = {}; // feature -> { WIN: { sum, sumSq, count }, LOSS: {...} }
    this._totalSamples = 0;
  }

  train(features, outcome) {
    const cls = outcome === 'WIN' ? 'WIN' : 'LOSS';
    this._classCounts[cls]++;
    this._totalSamples++;

    for (const [key, value] of Object.entries(features)) {
      if (!Number.isFinite(value)) continue;
      if (!this._featureStats[key]) {
        this._featureStats[key] = {
          WIN: { sum: 0, sumSq: 0, count: 0 },
          LOSS: { sum: 0, sumSq: 0, count: 0 },
        };
      }
      const stat = this._featureStats[key][cls];
      stat.sum += value;
      stat.sumSq += value * value;
      stat.count++;
    }
  }

  predict(features) {
    if (this._totalSamples < 10) {
      return { winProb: 0.5, confidence: 0, note: 'Insufficient training data' };
    }

    const priorWin = this._classCounts.WIN / this._totalSamples;
    const priorLoss = this._classCounts.LOSS / this._totalSamples;

    let logProbWin = Math.log(Math.max(priorWin, 0.01));
    let logProbLoss = Math.log(Math.max(priorLoss, 0.01));

    for (const [key, value] of Object.entries(features)) {
      if (!Number.isFinite(value)) continue;
      const stat = this._featureStats[key];
      if (!stat) continue;

      const winLik = this._gaussianLikelihood(value, stat.WIN);
      const lossLik = this._gaussianLikelihood(value, stat.LOSS);

      logProbWin += Math.log(Math.max(winLik, 1e-10));
      logProbLoss += Math.log(Math.max(lossLik, 1e-10));
    }

    // Normalize via log-sum-exp
    const maxLog = Math.max(logProbWin, logProbLoss);
    const probWin = Math.exp(logProbWin - maxLog);
    const probLoss = Math.exp(logProbLoss - maxLog);
    const total = probWin + probLoss;

    const winProb = total > 0 ? probWin / total : 0.5;
    const confidence = round(Math.min(100, this._totalSamples * 2), 1);

    return {
      winProb: round(winProb, 4),
      lossProb: round(1 - winProb, 4),
      confidence,
      featuresUsed: Object.keys(features).length,
      trainingSamples: this._totalSamples,
    };
  }

  _gaussianLikelihood(x, stat) {
    if (stat.count < 3) return 0.5; // uniform if not enough data
    const mean = stat.sum / stat.count;
    const variance = Math.max(
      (stat.sumSq / stat.count - mean * mean),
      1e-6
    );
    const std = Math.sqrt(variance);
    const exponent = -((x - mean) ** 2) / (2 * variance);
    return (1 / (std * Math.sqrt(2 * Math.PI))) * Math.exp(exponent);
  }

  getStats() {
    return {
      totalSamples: this._totalSamples,
      wins: this._classCounts.WIN,
      losses: this._classCounts.LOSS,
      features: Object.keys(this._featureStats).length,
    };
  }
}

/**
 * Beta-Binomial model for win rate estimation with uncertainty
 */
class BetaBinomialModel {
  constructor(priorAlpha = 2, priorBeta = 2) {
    // Weakly informative prior (slightly biased toward 50%)
    this._alpha = priorAlpha;
    this._beta = priorBeta;
    this._history = [];
  }

  update(isWin) {
    if (isWin) this._alpha++;
    else this._beta++;
    this._history.push({ isWin, timestamp: Date.now() });
  }

  // Posterior mean (point estimate of win rate)
  posteriorMean() {
    return round(this._alpha / (this._alpha + this._beta), 4);
  }

  // Credible interval (Bayesian confidence interval)
  credibleInterval(level = 0.95) {
    // Use normal approximation for Beta distribution
    const stats = betaStats(this._alpha, this._beta);
    const z = level === 0.99 ? 2.576 : level === 0.95 ? 1.96 : 1.645;
    return {
      lower: round(Math.max(0, stats.mean - z * stats.stddev), 4),
      upper: round(Math.min(1, stats.mean + z * stats.stddev), 4),
      mean: stats.mean,
      stddev: stats.stddev,
    };
  }

  // Probability that true win rate > threshold
  probAboveThreshold(threshold = 0.5) {
    // Numerical integration using Simpson's rule
    const n = 1000;
    const h = (1 - threshold) / n;
    let sum = 0;
    for (let i = 0; i <= n; i++) {
      const x = threshold + i * h;
      const y = betaPDF(x, this._alpha, this._beta);
      const w = i === 0 || i === n ? 1 : i % 2 === 0 ? 2 : 4;
      sum += w * y;
    }
    const integralAbove = (h / 3) * sum;

    // FIX: betaPDF() is explicitly documented as unnormalized (x^(a-1)*(1-x)^(b-1)
    // without dividing by B(a,b)). To get a true probability, the integral of the
    // unnormalized density must be DIVIDED by B(a,b) = exp(logBeta(a,b)), not
    // multiplied by it. The old code did `integralAbove * total`, which for any
    // non-trivial alpha/beta (i.e. after real trade history accumulates) collapses
    // toward ~0 regardless of the true win rate — verified numerically: a 50-10
    // win/loss record produced probAbove50 ≈ 1e-27 instead of the correct ≈ 0.9999999.
    const total = Math.exp(logBeta(this._alpha, this._beta));
    return round(total > 0 ? integralAbove / total : 0.5, 4);
  }

  getStats() {
    const ci = this.credibleInterval(0.95);
    return {
      alpha: this._alpha,
      beta: this._beta,
      posteriorMean: this.posteriorMean(),
      ci95: ci,
      samples: this._alpha + this._beta - 4, // subtract prior
      probAbove50: this.probAboveThreshold(0.5),
      probAbove55: this.probAboveThreshold(0.55),
    };
  }
}

/**
 * Main Bayesian Engine
 */
class BayesianEngine {
  constructor(config = {}) {
    this.basePrior = config.basePrior || 0.50; // 50% base rate
    this.minPosterior = config.minPosterior || 0.52;
    this.classifier = new NaiveBayesClassifier();
    this._symbolModels = {}; // symbol -> BetaBinomialModel
    this._regimeModels = {}; // regime -> BetaBinomialModel
    this._sessionModels = {}; // session -> BetaBinomialModel
  }

  /**
   * Compute posterior probability that a signal will win.
   * Combines likelihood ratios from multiple evidence streams.
   */
  evaluate({ signal, tradePlan, regime, entryOptimization, riskEvaluation, votes, session }) {
    const evidence = this._extractEvidence({
      signal, tradePlan, regime, entryOptimization, riskEvaluation, votes, session,
    });

    // Method 1: Likelihood ratio chain
    const lrResult = this._likelihoodRatioUpdate(evidence);

    // Method 2: Naive Bayes classifier
    const nbResult = this.classifier.predict(evidence.features);

    // Method 3: Beta-Binomial model (if data available)
    const bbResult = this._betaBinomialEstimate(signal, regime, session);

    // Ensemble: weighted combination
    const weights = { lr: 0.40, nb: 0.25, bb: 0.35 };
    const nbWeight = nbResult.confidence > 20 ? weights.nb : 0;
    const bbWeight = bbResult.confidence > 10 ? weights.bb : 0;
    const lrWeight = weights.lr + (weights.nb - nbWeight) + (weights.bb - bbWeight);

    const totalWeight = lrWeight + nbWeight + bbWeight;
    const posterior = totalWeight > 0
      ? (lrResult.posterior * lrWeight + nbResult.winProb * nbWeight + bbResult.posteriorMean * bbWeight) / totalWeight
      : lrResult.posterior;

    const approved = posterior >= this.minPosterior;
    const penalty = approved ? 0 : Math.min(15, Math.round((this.minPosterior - posterior) * 60));

    return {
      approved,
      posterior: round(posterior, 4),
      prior: round(this.basePrior, 4),
      evidenceCount: evidence.factors.length,
      methods: {
        likelihoodRatio: {
          posterior: round(lrResult.posterior, 4),
          cumulativeLR: round(lrResult.cumulativeLR, 4),
        },
        naiveBayes: {
          winProb: round(nbResult.winProb, 4),
          confidence: nbResult.confidence,
          trainingSamples: nbResult.trainingSamples,
        },
        betaBinomial: {
          posteriorMean: round(bbResult.posteriorMean, 4),
          ci95: bbResult.ci95,
          confidence: bbResult.confidence,
        },
      },
      topFactors: evidence.factors
        .sort((a, b) => Math.abs(Math.log(b.likelihoodRatio())) - Math.abs(Math.log(a.likelihoodRatio())))
        .slice(0, 5)
        .map(f => ({
          name: f.name,
          lr: round(f.likelihoodRatio(), 3),
          direction: f.likelihoodRatio() > 1 ? 'SUPPORTS' : 'OPPOSES',
        })),
      penalty,
      reasons: approved
        ? [`Bayesian posterior ${round(posterior * 100, 1)}% exceeds ${this.minPosterior * 100}% threshold`]
        : [`Bayesian posterior ${round(posterior * 100, 1)}% below ${this.minPosterior * 100}% threshold`],
    };
  }

  /**
   * Record a trade outcome for learning
   */
  recordOutcome({ signal, outcome, regime, session }) {
    const isWin = outcome === 'WIN' || (outcome?.pnlR > 0);
    const symbol = signal?.symbol || 'UNKNOWN';
    const regimeKey = regime?.regime || signal?.regime?.regime || 'UNKNOWN';
    const sessionKey = session?.best?.name || 'UNKNOWN';

    // Update Beta-Binomial models
    if (!this._symbolModels[symbol]) this._symbolModels[symbol] = new BetaBinomialModel();
    this._symbolModels[symbol].update(isWin);

    if (!this._regimeModels[regimeKey]) this._regimeModels[regimeKey] = new BetaBinomialModel();
    this._regimeModels[regimeKey].update(isWin);

    if (!this._sessionModels[sessionKey]) this._sessionModels[sessionKey] = new BetaBinomialModel();
    this._sessionModels[sessionKey].update(isWin);

    // Update Naive Bayes classifier
    const features = this._buildFeatures({ signal, regime, session });
    this.classifier.train(features, isWin ? 'WIN' : 'LOSS');
  }

  _likelihoodRatioUpdate(evidence) {
    let odds = this.basePrior / (1 - this.basePrior); // prior odds

    for (const factor of evidence.factors) {
      const lr = factor.likelihoodRatio();
      odds *= clamp(lr, 0.1, 10); // cap extreme LRs
    }

    const posterior = odds / (1 + odds);
    return {
      posterior: clamp(posterior, 0.01, 0.99),
      cumulativeLR: odds / (this.basePrior / (1 - this.basePrior)),
    };
  }

  _betaBinomialEstimate(signal, regime, session) {
    const symbol = signal?.symbol || 'UNKNOWN';
    const regimeKey = regime?.regime || 'UNKNOWN';
    const sessionKey = session?.best?.name || 'UNKNOWN';

    const symbolModel = this._symbolModels[symbol];
    const regimeModel = this._regimeModels[regimeKey];
    const sessionModel = this._sessionModels[sessionKey];

    const models = [symbolModel, regimeModel, sessionModel].filter(Boolean);
    if (models.length === 0) {
      return { posteriorMean: this.basePrior, ci95: { lower: 0.3, upper: 0.7 }, confidence: 0 };
    }

    // Weighted average of Beta-Binomial posteriors
    const means = models.map(m => m.posteriorMean());
    const totalSamples = models.reduce((s, m) => s + (m._alpha + m._beta - 4), 0);
    const posteriorMean = means.reduce((s, m) => s + m, 0) / means.length;

    const cis = models.map(m => m.credibleInterval(0.95));
    const ci95 = {
      lower: round(Math.min(...cis.map(c => c.lower)), 4),
      upper: round(Math.max(...cis.map(c => c.upper)), 4),
    };

    return {
      posteriorMean: round(posteriorMean, 4),
      ci95,
      confidence: round(Math.min(100, totalSamples * 3), 1),
    };
  }

  _extractEvidence({ signal, tradePlan, regime, entryOptimization, riskEvaluation, votes, session }) {
    const factors = [];
    const features = {};

    // Agent agreement
    const agentDirs = Object.values(votes || {}).filter(v => v?.direction).map(v => v.direction.toUpperCase());
    const mainDir = (signal?.action || signal?.direction || 'WAIT').toUpperCase();
    const agreeing = agentDirs.filter(d => d === mainDir).length;
    const total = agentDirs.length || 1;
    const agreement = agreeing / total;
    features.agentAgreement = agreement;

    if (agreement >= 0.8) {
      factors.push(new EvidenceFactor('High agent agreement', 0.75, 0.35));
    } else if (agreement >= 0.6) {
      factors.push(new EvidenceFactor('Moderate agent agreement', 0.60, 0.45));
    } else {
      factors.push(new EvidenceFactor('Low agent agreement', 0.35, 0.65));
    }

    // Score quality
    const score = signal?.score?.final || 0;
    features.score = score;
    if (score >= 85) {
      factors.push(new EvidenceFactor('Grade A score', 0.80, 0.25));
    } else if (score >= 75) {
      factors.push(new EvidenceFactor('Grade B score', 0.60, 0.40));
    } else {
      factors.push(new EvidenceFactor('Below threshold score', 0.35, 0.60));
    }

    // Regime tradeability
    const tradeability = regime?.tradeability || 50;
    features.tradeability = tradeability;
    if (tradeability >= 75) {
      factors.push(new EvidenceFactor('High tradeability regime', 0.72, 0.38));
    } else if (tradeability >= 55) {
      factors.push(new EvidenceFactor('Normal tradeability regime', 0.55, 0.48));
    } else {
      factors.push(new EvidenceFactor('Low tradeability regime', 0.30, 0.65));
    }

    // Structure
    const structure = regime?.structure || 'UNKNOWN';
    features.directional = structure === 'DIRECTIONAL' ? 1 : 0;
    if (structure === 'DIRECTIONAL') {
      factors.push(new EvidenceFactor('Directional structure', 0.70, 0.35));
    } else if (structure === 'CHOP') {
      factors.push(new EvidenceFactor('Choppy structure', 0.25, 0.70));
    }

    // Risk/reward
    const rr = tradePlan?.targets?.tp1?.rr || signal?.targets?.tp1?.rr || 0;
    features.rr = rr;
    if (rr >= 3) {
      factors.push(new EvidenceFactor('Excellent R:R >= 3', 0.72, 0.30));
    } else if (rr >= 2) {
      factors.push(new EvidenceFactor('Good R:R >= 2', 0.62, 0.40));
    } else if (rr >= 1.5) {
      factors.push(new EvidenceFactor('Acceptable R:R >= 1.5', 0.52, 0.48));
    } else if (rr > 0) {
      factors.push(new EvidenceFactor('Poor R:R < 1.5', 0.30, 0.65));
    }

    // Entry quality
    const entryQ = entryOptimization?.qualityScore || 0;
    features.entryQuality = entryQ;
    if (entryQ >= 80) {
      factors.push(new EvidenceFactor('High entry quality', 0.70, 0.32));
    } else if (entryQ >= 60) {
      factors.push(new EvidenceFactor('Moderate entry quality', 0.55, 0.45));
    }

    // Volatility regime
    const vol = regime?.volatility || 'NORMAL';
    features.volExpansion = vol === 'EXPANSION' ? 1 : 0;
    if (vol === 'EXPANSION') {
      factors.push(new EvidenceFactor('Volatile expansion', 0.40, 0.55));
    } else if (vol === 'COMPRESSION') {
      factors.push(new EvidenceFactor('Volatility compression', 0.48, 0.52));
    }

    // Session quality
    const sessQuality = session?.best?.quality || 'LOW';
    features.sessionQuality = sessQuality === 'HIGHEST' ? 1.0 : sessQuality === 'HIGH' ? 0.7 : 0.3;
    if (sessQuality === 'HIGHEST') {
      factors.push(new EvidenceFactor('Prime session (killzone)', 0.68, 0.40));
    } else if (sessQuality === 'HIGH') {
      factors.push(new EvidenceFactor('High quality session', 0.58, 0.45));
    }

    // Risk approval
    if (riskEvaluation?.approved === false) {
      factors.push(new EvidenceFactor('Risk engine rejected', 0.15, 0.80));
      features.riskRejected = 1;
    } else {
      features.riskRejected = 0;
    }

    return { factors, features };
  }

  _buildFeatures({ signal, regime, session }) {
    return {
      score: signal?.score?.final || 0,
      grade: signal?.score?.grade === 'A' ? 3 : signal?.score?.grade === 'B' ? 2 : 1,
      tradeability: regime?.tradeability || 50,
      directional: regime?.structure === 'DIRECTIONAL' ? 1 : 0,
      choppy: regime?.structure === 'CHOP' ? 1 : 0,
      volExpansion: regime?.volatility === 'EXPANSION' ? 1 : 0,
      sessionQuality: session?.best?.quality === 'HIGHEST' ? 3 : session?.best?.quality === 'HIGH' ? 2 : 1,
    };
  }

  getStats() {
    return {
      classifier: this.classifier.getStats(),
      symbolModels: Object.fromEntries(
        Object.entries(this._symbolModels).map(([k, v]) => [k, v.getStats()])
      ),
      regimeModels: Object.fromEntries(
        Object.entries(this._regimeModels).map(([k, v]) => [k, v.getStats()])
      ),
    };
  }
}

module.exports = { BayesianEngine };
