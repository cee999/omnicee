
'use strict';

const DEFAULTS = {
  MAX_OPEN_POSITIONS:        5,
  MAX_CORRELATED_POSITIONS:  2,
  HIGH_CORRELATION_THRESHOLD: 0.70,
  REGIME_CHANGE_THRESHOLD:    0.40,
  DEFAULT_RISK_PCT:           1.0,
  CORRELATION_WINDOW:         50,
};

const CORRELATION_GROUPS = {
  USD_MAJORS:    ['EURUSD','GBPUSD','AUDUSD','NZDUSD'],
  USD_JPY_GROUP: ['USDJPY','EURJPY','GBPJPY','AUDJPY','CADJPY','CHFJPY'],
  USD_SAFE:      ['USDCHF','USDCAD'],
  GOLD_SILVER:   ['XAUUSD','XAGUSD','GOLD','SILVER'],
  CRYPTO_MAJOR:  ['BTCUSDT','ETHUSDT','BTCUSD','ETHUSD','BTCPERP','ETHPERP'],
  CRYPTO_ALT_L1: ['SOLUSDT','ADAUSDT','AVAXUSDT','DOTUSDT'],
  CRYPTO_ALT_EXCH: ['BNBUSDT','OKBUSDT'],
  CRYPTO_MEME:   ['DOGEUSDT','SHIBUSDT','PEPEUSDT'],
  INDICES_US:    ['SPX500','NAS100','US30','US2000'],
  INDICES_EU:    ['GER40','UK100','FRA40','EU50'],
  OIL_ENERGY:    ['USOIL','UKOIL','CRUDE','NATGAS'],
};

const KNOWN_CORRELATIONS = {
  'EURUSD_GBPUSD':  0.85,
  'EURUSD_USDCHF': -0.90,
  'EURUSD_XAUUSD':  0.45,
  'GBPUSD_AUDUSD':  0.70,
  'USDJPY_XAUUSD': -0.55,
  'XAUUSD_XAGUSD':  0.85,
  'BTCUSDT_ETHUSDT': 0.90,
  'SPX500_NAS100':  0.95,
  'SPX500_XAUUSD': -0.30,
  'USOIL_USDCAD':  -0.65,
  'DXY_EURUSD':    -0.97,
};

const ASSET_CLASSES = {
  FOREX_MAJOR: ['EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD'],
  FOREX_CROSS: ['EURJPY','GBPJPY','EURGBP','AUDJPY','EURAUD','GBPAUD'],
  METALS:      ['XAUUSD','XAGUSD','GOLD','SILVER'],
  CRYPTO:      ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','ADAUSDT','XRPUSDT','DOGEUSDT'],
  INDICES:     ['SPX500','NAS100','US30','GER40','UK100'],
  ENERGY:      ['USOIL','UKOIL','NATGAS'],
};

const MAX_CLASS_EXPOSURE_PCT = {
  FOREX_MAJOR: 6,
  FOREX_CROSS: 4,
  METALS:      4,
  CRYPTO:      5,
  INDICES:     4,
  ENERGY:      2,
};

const CURRENCY_DIRECTION = {
};

const r     = (n, d = 4) => parseFloat((n ?? 0).toFixed(d));
const avg   = arr => arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function parseCurrencyPair(symbol) {
  const forexCurrencies = ['EUR','GBP','USD','JPY','CHF','CAD','AUD','NZD'];

  for (const base of forexCurrencies) {
    if (symbol.startsWith(base)) {
      const rest = symbol.slice(base.length);
      for (const quote of forexCurrencies) {
        if (rest.startsWith(quote)) {
          return { base, quote, isForex: true };
        }
      }
    }
  }

  if (symbol.startsWith('XAU')) return { base: 'XAU', quote: 'USD', isForex: false, isMetal: true };
  if (symbol.startsWith('XAG')) return { base: 'XAG', quote: 'USD', isForex: false, isMetal: true };

  if (symbol.endsWith('USDT')) return { base: symbol.slice(0, -4), quote: 'USDT', isForex: false, isCrypto: true };
  if (symbol.endsWith('USD'))  return { base: symbol.slice(0, -3), quote: 'USD',  isForex: false, isCrypto: true };

  return { base: symbol, quote: null, isForex: false };
}

class CorrelationMatrixBuilder {
  static pearson(seriesA, seriesB) {
    const n = Math.min(seriesA.length, seriesB.length);
    if (n < 2) return 0;

    const a = seriesA.slice(-n);
    const b = seriesB.slice(-n);

    const meanA = avg(a);
    const meanB = avg(b);

    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      num  += da * db;
      denA += da * da;
      denB += db * db;
    }

    const den = Math.sqrt(denA * denB);
    if (den === 0) return 0;

    return r(num / den, 4);
  }

  static toReturns(candles) {
    if (!candles || candles.length < 2) return [];

    const returns = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1].close;
      const curr = candles[i].close;
      if (prev > 0) returns.push((curr - prev) / prev);
    }
    return returns;
  }

  static buildMatrix(candleMap, window = DEFAULTS.CORRELATION_WINDOW) {
    const symbols = Object.keys(candleMap);
    const returnsMap = {};

    for (const sym of symbols) {
      const returns = this.toReturns(candleMap[sym]);
      returnsMap[sym] = returns.slice(-window);
    }

    const matrix = {};
    for (const symA of symbols) {
      matrix[symA] = {};
      for (const symB of symbols) {
        if (symA === symB) {
          matrix[symA][symB] = 1.0;
        } else if (matrix[symB]?.[symA] !== undefined) {
          matrix[symA][symB] = matrix[symB][symA];
        } else {
          matrix[symA][symB] = this.pearson(returnsMap[symA], returnsMap[symB]);
        }
      }
    }

    return { matrix, symbols, window, computedAt: Date.now() };
  }

  static getCorrelation(matrix, symA, symB) {
    return matrix?.[symA]?.[symB] ?? null;
  }

  static findHighCorrelations(matrixResult, threshold = DEFAULTS.HIGH_CORRELATION_THRESHOLD) {
    const { matrix, symbols } = matrixResult;
    const pairs = [];

    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const symA = symbols[i], symB = symbols[j];
        const corr = matrix[symA][symB];

        if (Math.abs(corr) >= threshold) {
          pairs.push({
            symbolA: symA,
            symbolB: symB,
            correlation: corr,
            type: corr > 0 ? 'POSITIVE' : 'NEGATIVE',
            strength: Math.abs(corr) >= 0.85 ? 'VERY_HIGH' : 'HIGH',
          });
        }
      }
    }

    return pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  }
}

class DynamicCorrelationTracker {
  constructor(config = {}) {
    this.window         = config.window ?? DEFAULTS.CORRELATION_WINDOW;
    this.minCandles     = config.minCandles ?? 20;
    this._matrix        = null;
    this._previousMatrix = null;
    this._lastUpdate    = null;
    this._regimeChanges = [];
  }

  update(candleMap) {
    const validMap = {};
    for (const [sym, candles] of Object.entries(candleMap)) {
      if (candles && candles.length >= this.minCandles) {
        validMap[sym] = candles;
      }
    }

    if (Object.keys(validMap).length < 2) return null;

    this._previousMatrix = this._matrix;
    this._matrix = CorrelationMatrixBuilder.buildMatrix(validMap, this.window);
    this._lastUpdate = Date.now();

    if (this._previousMatrix) {
      this._detectRegimeChanges();
    }

    return this._matrix;
  }

  _detectRegimeChanges() {
    const { matrix, symbols } = this._matrix;
    const prevMatrix = this._previousMatrix.matrix;

    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const symA = symbols[i], symB = symbols[j];
        const curr = matrix[symA]?.[symB];
        const prev = prevMatrix[symA]?.[symB];

        if (curr === undefined || prev === undefined) continue;

        const shift = Math.abs(curr - prev);
        if (shift >= DEFAULTS.REGIME_CHANGE_THRESHOLD) {
          this._regimeChanges.push({
            symbolA: symA,
            symbolB: symB,
            previousCorr: prev,
            currentCorr:  curr,
            shift:        r(shift, 3),
            timestamp:    Date.now(),
            note: `${symA}/${symB} correlation shifted from ${prev} to ${curr} — regime change`,
          });

          if (this._regimeChanges.length > 50) this._regimeChanges.shift();
        }
      }
    }
  }

  getCorrelation(symA, symB) {
    if (symA === symB) return 1.0;

    if (this._matrix) {
      const live = CorrelationMatrixBuilder.getCorrelation(this._matrix, symA, symB);
      if (live !== null) return { value: live, source: 'LIVE' };
    }

    const key1 = `${symA}_${symB}`;
    const key2 = `${symB}_${symA}`;
    if (KNOWN_CORRELATIONS[key1] !== undefined) return { value: KNOWN_CORRELATIONS[key1], source: 'STATIC' };
    if (KNOWN_CORRELATIONS[key2] !== undefined) return { value: KNOWN_CORRELATIONS[key2], source: 'STATIC' };

    const groupA = this._getGroup(symA);
    const groupB = this._getGroup(symB);

    if (groupA && groupA === groupB) {
      return { value: 0.75, source: 'GROUP_ESTIMATE', group: groupA };
    }

    return { value: 0, source: 'UNKNOWN' };
  }

  _getGroup(symbol) {
    for (const [group, symbols] of Object.entries(CORRELATION_GROUPS)) {
      if (symbols.some(s => symbol.includes(s) || s.includes(symbol))) return group;
    }
    return null;
  }

  getRecentRegimeChanges(n = 10) {
    return this._regimeChanges.slice(-n).reverse();
  }

  getMatrix() {
    return this._matrix;
  }

  getHighCorrelations(threshold = DEFAULTS.HIGH_CORRELATION_THRESHOLD) {
    if (!this._matrix) return [];
    return CorrelationMatrixBuilder.findHighCorrelations(this._matrix, threshold);
  }
}

class CurrencyExposureCalculator {
  static compute(positions) {
    const exposure = {};

    for (const pos of positions) {
      const { base, quote, isForex, isMetal, isCrypto } = parseCurrencyPair(pos.symbol);
      const dirMult = pos.direction === 'LONG' ? 1 : -1;
      const risk    = pos.riskPct ?? DEFAULTS.DEFAULT_RISK_PCT;

      if (isForex || isMetal) {
        exposure[base]  = (exposure[base]  || 0) + dirMult * risk;
        if (quote) {
          exposure[quote] = (exposure[quote] || 0) - dirMult * risk;
        }
      } else if (isCrypto) {
        exposure[base] = (exposure[base] || 0) + dirMult * risk;
      } else {
        exposure[pos.symbol] = (exposure[pos.symbol] || 0) + dirMult * risk;
      }
    }

    for (const k of Object.keys(exposure)) exposure[k] = r(exposure[k], 3);

    const warnings = [];
    for (const [currency, exp] of Object.entries(exposure)) {
      if (Math.abs(exp) > 4) {
        warnings.push({
          currency,
          netExposure: exp,
          direction:   exp > 0 ? 'NET_LONG' : 'NET_SHORT',
          note:        `${currency} net exposure ${exp > 0 ? '+' : ''}${exp}% — concentration risk`,
        });
      }
    }

    return {
      exposure,
      warnings,
      totalGrossExposure: r(positions.reduce((s, p) => s + Math.abs(p.riskPct ?? 1), 0), 3),
      mostExposedCurrency: Object.entries(exposure)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] ?? null,
    };
  }

  static simulateAdd(positions, newSymbol, newDirection, riskPct = DEFAULTS.DEFAULT_RISK_PCT) {
    const simulated = [...positions, { symbol: newSymbol, direction: newDirection, riskPct }];
    return this.compute(simulated);
  }
}

class DiversificationScorer {
  static score(positions, corrTracker) {
    if (positions.length === 0) {
      return { score: 100, effectiveBets: 0, clusters: [], note: 'No open positions' };
    }
    if (positions.length === 1) {
      return { score: 100, effectiveBets: 1, clusters: [[positions[0].symbol]], note: 'Single position — fully independent' };
    }

    const n = positions.length;
    const weights = positions.map(p => p.riskPct ?? DEFAULTS.DEFAULT_RISK_PCT);
    const totalWeight = weights.reduce((s, w) => s + w, 0);

    let sumSqAdjusted = 0;

    for (let i = 0; i < n; i++) {
      let correlatedWeight = weights[i];

      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const corrResult = corrTracker.getCorrelation(positions[i].symbol, positions[j].symbol);
        const corr = Math.abs(corrResult.value);

        const sameDir = positions[i].direction === positions[j].direction;
        const effectiveCorr = sameDir ? corr : -corr;

        if (effectiveCorr > 0) {
          correlatedWeight += weights[j] * effectiveCorr * 0.5;
        }
      }

      const normWeight = correlatedWeight / totalWeight;
      sumSqAdjusted += normWeight * normWeight;
    }

    const effectiveBets = sumSqAdjusted > 0 ? r(1 / sumSqAdjusted, 2) : n;
    const score = clamp(r((effectiveBets / n) * 100, 1), 0, 100);

    const clusters = this._findClusters(positions, corrTracker);

    return {
      score,
      effectiveBets,
      totalPositions: n,
      clusters,
      note: score >= 80 ? 'Well diversified'
        : score >= 50 ? 'Moderate diversification'
        : 'Low diversification — positions are highly correlated',
    };
  }

  static _findClusters(positions, corrTracker) {
    const clusters = [];
    const assigned = new Set();

    for (const pos of positions) {
      if (assigned.has(pos.symbol)) continue;

      const cluster = [pos.symbol];
      assigned.add(pos.symbol);

      for (const other of positions) {
        if (assigned.has(other.symbol)) continue;
        const corrResult = corrTracker.getCorrelation(pos.symbol, other.symbol);
        if (Math.abs(corrResult.value) >= DEFAULTS.HIGH_CORRELATION_THRESHOLD) {
          cluster.push(other.symbol);
          assigned.add(other.symbol);
        }
      }

      clusters.push(cluster);
    }

    return clusters.filter(c => c.length > 0);
  }

  static suggestImprovement(positions, candidateSymbols, corrTracker) {
    const currentScore = this.score(positions, corrTracker).score;
    const suggestions  = [];

    for (const candidate of candidateSymbols) {
      const simulated = [...positions, { symbol: candidate, direction: 'LONG', riskPct: DEFAULTS.DEFAULT_RISK_PCT }];
      const newScore  = this.score(simulated, corrTracker).score;

      suggestions.push({
        symbol: candidate,
        scoreImprovement: r(newScore - currentScore, 2),
        newScore,
      });
    }

    return suggestions.sort((a, b) => b.scoreImprovement - a.scoreImprovement).slice(0, 5);
  }
}

class CorrelationFilter {
  constructor(config = {}) {
    this.maxOpenPositions   = config.maxOpenPositions       ?? DEFAULTS.MAX_OPEN_POSITIONS;
    this.maxCorrelated      = config.maxCorrelatedPositions ?? DEFAULTS.MAX_CORRELATED_POSITIONS;
    this.corrThreshold      = config.correlationThreshold   ?? DEFAULTS.HIGH_CORRELATION_THRESHOLD;

    this._openPositions = new Map();
    this.corrTracker    = new DynamicCorrelationTracker({ window: config.correlationWindow });
  }

  updateCorrelations(candleMap) {
    return this.corrTracker.update(candleMap);
  }

  addPosition(signalId, symbol, direction, riskPct) {
    this._openPositions.set(signalId, {
      signalId, symbol, direction,
      riskPct: riskPct ?? DEFAULTS.DEFAULT_RISK_PCT,
      timestamp: Date.now(),
    });
  }

  removePosition(signalId) {
    this._openPositions.delete(signalId);
  }

  check(symbol, direction, riskPct = DEFAULTS.DEFAULT_RISK_PCT) {
    const openArr = [...this._openPositions.values()];
    const conflicts = [];

    if (openArr.length >= this.maxOpenPositions) {
      return { allowed: false, reason: `Max ${this.maxOpenPositions} open positions reached`, conflicts: [] };
    }

    if (openArr.some(p => p.symbol === symbol)) {
      return { allowed: false, reason: `Already have open position on ${symbol}`, conflicts: [] };
    }

    let highCorrCount = 0;
    for (const pos of openArr) {
      const corrResult = this.corrTracker.getCorrelation(symbol, pos.symbol);
      const corr = corrResult.value;

      if (Math.abs(corr) >= this.corrThreshold) {
        highCorrCount++;

        const sameDir = pos.direction === direction;
        const isCompounding = (corr > 0 && sameDir) || (corr < 0 && !sameDir);

        conflicts.push({
          symbol: pos.symbol,
          direction: pos.direction,
          correlation: corr,
          source: corrResult.source,
          isCompounding,
          note: isCompounding
            ? `${symbol} (${direction}) is ${corr > 0 ? 'positively' : 'negatively'} correlated (${corr}) with open ${pos.direction} ${pos.symbol} — compounds risk`
            : `${symbol} (${direction}) correlated (${corr}) with ${pos.symbol} but direction creates a hedge`,
        });
      }
    }

    const compoundingConflicts = conflicts.filter(c => c.isCompounding);
    if (compoundingConflicts.length >= this.maxCorrelated) {
      return {
        allowed: false,
        reason:  `${compoundingConflicts.length} correlated positions would compound risk (max ${this.maxCorrelated}): ${compoundingConflicts.map(c => c.symbol).join(', ')}`,
        conflicts,
      };
    }

    const assetClass = this._getAssetClass(symbol);
    if (assetClass) {
      const classRisk = openArr
        .filter(p => this._getAssetClass(p.symbol) === assetClass)
        .reduce((s, p) => s + p.riskPct, 0);

      const maxClassRisk = MAX_CLASS_EXPOSURE_PCT[assetClass] ?? 6;
      if (classRisk + riskPct > maxClassRisk) {
        return {
          allowed: false,
          reason:  `Asset class ${assetClass} exposure would reach ${r(classRisk + riskPct, 2)}% (max ${maxClassRisk}%)`,
          conflicts,
        };
      }
    }

    const exposureSim = CurrencyExposureCalculator.simulateAdd(openArr, symbol, direction, riskPct);
    const newWarnings = exposureSim.warnings.filter(w =>
      !this._getCurrentWarnings(openArr).some(existing => existing.currency === w.currency)
    );

    const diversificationBefore = DiversificationScorer.score(openArr, this.corrTracker);
    const diversificationAfter  = DiversificationScorer.score(
      [...openArr, { symbol, direction, riskPct }],
      this.corrTracker
    );

    return {
      allowed:    true,
      reason:     null,
      conflicts,
      assetClass,
      currencyExposure: exposureSim,
      newExposureWarnings: newWarnings,
      diversification: {
        before: diversificationBefore.score,
        after:  diversificationAfter.score,
        change: r(diversificationAfter.score - diversificationBefore.score, 2),
      },
      openCount: openArr.length,
      correlatedCount: compoundingConflicts.length,
    };
  }

  _getAssetClass(symbol) {
    for (const [cls, symbols] of Object.entries(ASSET_CLASSES)) {
      if (symbols.some(s => symbol.includes(s) || s.includes(symbol))) return cls;
    }
    return 'OTHER';
  }

  _getCurrentWarnings(openArr) {
    return CurrencyExposureCalculator.compute(openArr).warnings;
  }

  getOpenPositions() {
    return [...this._openPositions.values()];
  }

  getTotalRisk() {
    return r([...this._openPositions.values()].reduce((s, p) => s + p.riskPct, 0), 3);
  }

  getStats() {
    const positions = [...this._openPositions.values()];
    const exposure  = CurrencyExposureCalculator.compute(positions);
    const diversification = DiversificationScorer.score(positions, this.corrTracker);
    const highCorrs = this.corrTracker.getHighCorrelations(this.corrThreshold);
    const regimeChanges = this.corrTracker.getRecentRegimeChanges(5);

    return {
      openCount:       positions.length,
      totalRisk:       this.getTotalRisk(),
      positions:       positions.map(p => ({
        symbol: p.symbol, direction: p.direction, riskPct: p.riskPct,
        ageMin: Math.round((Date.now() - p.timestamp) / 60000),
        assetClass: this._getAssetClass(p.symbol),
      })),
      currencyExposure: exposure,
      diversification,
      highCorrelations: highCorrs.slice(0, 10),
      regimeChanges,
      byAssetClass: Object.fromEntries(
        Object.keys(ASSET_CLASSES).map(cls => [
          cls,
          {
            count: positions.filter(p => this._getAssetClass(p.symbol) === cls).length,
            risk:  r(positions.filter(p => this._getAssetClass(p.symbol) === cls).reduce((s,p) => s + p.riskPct, 0), 3),
            max:   MAX_CLASS_EXPOSURE_PCT[cls] ?? 6,
          },
        ])
      ),
    };
  }

  suggestDiversification(candidateSymbols) {
    const positions = [...this._openPositions.values()];
    return DiversificationScorer.suggestImprovement(positions, candidateSymbols, this.corrTracker);
  }
}

module.exports = {
  CorrelationFilter,
  CorrelationMatrixBuilder,
  DynamicCorrelationTracker,
  CurrencyExposureCalculator,
  DiversificationScorer,
  DEFAULTS,
  CORRELATION_GROUPS,
  KNOWN_CORRELATIONS,
  ASSET_CLASSES,
  MAX_CLASS_EXPOSURE_PCT,
  parseCurrencyPair,
};

