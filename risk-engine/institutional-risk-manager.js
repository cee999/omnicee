/**
 * ============================================================
 *  INSTITUTIONAL RISK MANAGER — Jane Street / Wall Street Grade
 *  AI Trading Assistant · Layer 12 · Risk Management Module
 *  File: risk-engine/institutional-risk-manager.js
 * ============================================================
 *
 *  Institutional-grade risk management inspired by:
 *  - Jane Street: Kelly criterion, position sizing, correlation risk
 *  - Citadel: Multi-timeframe risk, regime-aware sizing
 *  - Two Sigma: Volatility-adjusted exposure, tail risk hedging
 *  - DE Shaw: Factor exposure limits, liquidity risk
 *
 *  Features:
 *  1. Kelly Criterion Position Sizing
 *  2. Portfolio Correlation Analysis
 *  3. Tail Risk Management (VaR, CVaR)
 *  4. Liquidity-Aware Sizing
 *  5. Regime-Adjusted Risk Limits
 *  6. Multi-Asset Exposure Limits
 *  7. Drawdown Control with Dynamic Scaling
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const BASE_RISK_PER_TRADE = 0.01; // 1% base risk
const MAX_PORTFOLIO_RISK = 0.05; // 5% max portfolio risk
const MAX_CORRELATION_EXPOSURE = 0.15; // 15% max in correlated assets
const KELLY_FRACTION = 0.25; // Quarter Kelly for safety
const MIN_LIQUIDITY_RATIO = 0.001; // 0.1% of daily volume max position
const TAIL_RISK_CONFIDENCE = 0.95; // 95% VaR

function round(n, d = 2) { return parseFloat((n ?? 0).toFixed(d)); }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function avg(arr) { return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / (arr.length - 1));
}

// ─────────────────────────────────────────────
//  KELLY CRITERION CALCULATOR
// ─────────────────────────────────────────────

class KellyCriterionCalculator {
  /**
   * Calculates optimal position size using Kelly Criterion.
   * Uses quarter Kelly for safety (institutional standard).
   * 
   * Kelly % = (win_rate * avg_win - loss_rate * avg_loss) / avg_win
   */
  static calculate(winRate, avgWin, avgLoss, accountBalance, currentPrice) {
    const winRateDec = winRate / 100;
    const lossRateDec = 1 - winRateDec;
    
    if (avgLoss === 0 || isNaN(avgLoss)) return { kellyPercent: 0, positionSize: 0, riskAdjusted: false };
    if (avgWin === 0 || isNaN(avgWin)) return { kellyPercent: 0, positionSize: 0, riskAdjusted: false };
    
    const kellyPercent = (winRateDec * avgWin - lossRateDec * avgLoss) / avgWin;
    const quarterKelly = kellyPercent * KELLY_FRACTION;
    
    // Cap at reasonable limits
    const cappedKelly = clamp(quarterKelly, 0, 0.10); // Max 10% of account
    
    const positionValue = accountBalance * cappedKelly;
    const positionSize = positionValue / currentPrice;
    
    return {
      kellyPercent: round(cappedKelly * 100, 2),
      positionSize: round(positionSize, 4),
      positionValue: round(positionValue, 2),
      rawKelly: round(kellyPercent * 100, 2),
      quarterKelly: round(quarterKelly * 100, 2),
      riskAdjusted: true,
    };
  }

  /**
   * Adaptive Kelly based on recent performance
   */
  static adaptiveKelly(tradeHistory, accountBalance, currentPrice) {
    if (tradeHistory.length < 10) {
      // Not enough data - use conservative default
      return this.calculate(50, 2, 1, accountBalance, currentPrice);
    }

    const recentTrades = tradeHistory.slice(-50); // Last 50 trades
    const wins = recentTrades.filter(t => t.pnl > 0);
    const losses = recentTrades.filter(t => t.pnl <= 0);

    const winRate = (wins.length / recentTrades.length) * 100;
    const avgWin = wins.length > 0 ? avg(wins.map(t => t.pnl)) : 1;
    const avgLoss = losses.length > 0 ? avg(losses.map(t => Math.abs(t.pnl))) : 1;

    return this.calculate(winRate, avgWin, avgLoss, accountBalance, currentPrice);
  }
}

// ─────────────────────────────────────────────
//  CORRELATION ANALYZER
// ─────────────────────────────────────────────

class CorrelationAnalyzer {
  constructor() {
    this.returnsHistory = new Map(); // symbol → [returns]
    this.correlationMatrix = new Map(); // pair → correlation
  }

  addReturns(symbol, returns) {
    this.returnsHistory.set(symbol, returns.slice(-100)); // Keep last 100 data points
    this._updateCorrelations();
  }

  _updateCorrelations() {
    const symbols = [...this.returnsHistory.keys()];
    
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const sym1 = symbols[i];
        const sym2 = symbols[j];
        const corr = this._calculateCorrelation(
          this.returnsHistory.get(sym1),
          this.returnsHistory.get(sym2)
        );
        
        const pair = [sym1, sym2].sort().join('-');
        this.correlationMatrix.set(pair, round(corr, 3));
      }
    }
  }

  _calculateCorrelation(arr1, arr2) {
    const n = Math.min(arr1.length, arr2.length);
    if (n < 2) return 0;

    const slice1 = arr1.slice(-n);
    const slice2 = arr2.slice(-n);

    const mean1 = avg(slice1);
    const mean2 = avg(slice2);

    let numerator = 0;
    let denom1 = 0;
    let denom2 = 0;

    for (let i = 0; i < n; i++) {
      const diff1 = slice1[i] - mean1;
      const diff2 = slice2[i] - mean2;
      numerator += diff1 * diff2;
      denom1 += diff1 * diff1;
      denom2 += diff2 * diff2;
    }

    const denominator = Math.sqrt(denom1 * denom2);
    if (denominator === 0 || isNaN(denominator)) return 0;
    return numerator / denominator;
  }

  getCorrelation(symbol1, symbol2) {
    const pair = [symbol1, symbol2].sort().join('-');
    return this.correlationMatrix.get(pair) || 0;
  }

  getHighlyCorrelated(symbol, threshold = 0.7) {
    const correlations = [];
    for (const [pair, corr] of this.correlationMatrix.entries()) {
      if (pair.includes(symbol) && Math.abs(corr) >= threshold) {
        const otherSymbol = pair.split('-').find(s => s !== symbol);
        correlations.push({ symbol: otherSymbol, correlation: corr });
      }
    }
    return correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  }

  getPortfolioCorrelation(portfolio) {
    if (portfolio.length < 2) return { avgCorrelation: 0, maxCorrelation: 0 };

    const correlations = [];
    for (let i = 0; i < portfolio.length; i++) {
      for (let j = i + 1; j < portfolio.length; j++) {
        const corr = this.getCorrelation(portfolio[i], portfolio[j]);
        correlations.push(Math.abs(corr));
      }
    }

    return {
      avgCorrelation: round(avg(correlations), 3),
      maxCorrelation: round(Math.max(...correlations), 3),
      pairCount: correlations.length,
    };
  }
}

// ─────────────────────────────────────────────
//  TAIL RISK CALCULATOR
// ─────────────────────────────────────────────

class TailRiskCalculator {
  /**
   * Calculates Value at Risk (VaR) and Conditional VaR (CVaR)
   * for tail risk management.
   */
  static calculateVaR(returns, confidence = TAIL_RISK_CONFIDENCE) {
    if (returns.length < 30) return null;

    const sorted = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidence) * sorted.length);
    
    return {
      var: round(sorted[index], 4),
      confidence,
      period: 'daily',
    };
  }

  static calculateCVaR(returns, confidence = TAIL_RISK_CONFIDENCE) {
    if (returns.length < 30) return null;

    const sorted = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidence) * sorted.length);
    const tailReturns = sorted.slice(0, index);
    
    return {
      cvar: round(avg(tailReturns), 4),
      confidence,
      tailSize: tailReturns.length,
    };
  }

  static calculateExpectedShortfall(returns, confidence = TAIL_RISK_CONFIDENCE) {
    return this.calculateCVaR(returns, confidence);
  }

  static getTailRiskMetrics(returns, confidence = TAIL_RISK_CONFIDENCE) {
    const varResult = this.calculateVaR(returns, confidence);
    const cvarResult = this.calculateCVaR(returns, confidence);
    
    if (!varResult || !cvarResult) return null;

    const skewness = this._calculateSkewness(returns);
    const kurtosis = this._calculateKurtosis(returns);

    return {
      var: varResult.var,
      cvar: cvarResult.cvar,
      expectedShortfall: cvarResult.cvar,
      skewness: round(skewness, 3),
      kurtosis: round(kurtosis, 3),
      tailRisk: Math.abs(skewness) > 1 || kurtosis > 3 ? 'HIGH' : 'NORMAL',
    };
  }

  static _calculateSkewness(returns) {
    if (returns.length < 3) return 0;
    const n = returns.length;
    const mean = avg(returns);
    const variance = std(returns) ** 2;
    
    if (variance === 0) return 0;
    
    const skew = returns.reduce((sum, r) => sum + Math.pow((r - mean) / Math.sqrt(variance), 3), 0);
    return (n / ((n - 1) * (n - 2))) * skew;
  }

  static _calculateKurtosis(returns) {
    if (returns.length < 4) return 0;
    const n = returns.length;
    const mean = avg(returns);
    const variance = std(returns) ** 2;
    
    if (variance === 0) return 0;
    
    const kurt = returns.reduce((sum, r) => sum + Math.pow((r - mean) / Math.sqrt(variance), 4), 0);
    return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * kurt - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  }
}

// ─────────────────────────────────────────────
//  LIQUIDITY RISK MANAGER
// ─────────────────────────────────────────────

class LiquidityRiskManager {
  constructor() {
    this.liquidityData = new Map(); // symbol → { volume, avgVolume, spread }
  }

  updateLiquidity(symbol, volume, spread) {
    const existing = this.liquidityData.get(symbol) || { volumeHistory: [] };
    
    existing.volumeHistory.push(volume);
    if (existing.volumeHistory.length > 20) existing.volumeHistory.shift();
    
    existing.avgVolume = avg(existing.volumeHistory);
    existing.currentVolume = volume;
    existing.spread = spread;
    existing.timestamp = Date.now();
    
    this.liquidityData.set(symbol, existing);
  }

  getMaxPositionSize(symbol, accountBalance, dailyVolume) {
    const liquidityRatio = MIN_LIQUIDITY_RATIO;
    const maxByLiquidity = dailyVolume * liquidityRatio;
    const maxByRisk = accountBalance * BASE_RISK_PER_TRADE;
    
    return {
      maxPositionSize: Math.min(maxByLiquidity, maxByRisk),
      liquidityConstraint: maxByLiquidity < maxByRisk,
      liquidityRatio,
      dailyVolume,
    };
  }

  getLiquidityScore(symbol) {
    const data = this.liquidityData.get(symbol);
    if (!data) return { score: 50, category: 'UNKNOWN' };

    const volumeRatio = data.currentVolume / (data.avgVolume || 1);
    const spreadPenalty = data.spread > 0.001 ? 20 : 0;
    
    let score = 50;
    score += clamp((volumeRatio - 1) * 30, -20, 20);
    score -= spreadPenalty;
    
    const category = score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';
    
    return { score: clamp(score, 0, 100), category, volumeRatio, spread: data.spread };
  }

  isLiquiditySufficient(symbol, positionSize) {
    const data = this.liquidityData.get(symbol);
    if (!data) return { sufficient: false, reason: 'No liquidity data' };

    const positionToVolumeRatio = positionSize / (data.avgVolume || 1);
    
    if (positionToVolumeRatio > 0.01) {
      return {
        sufficient: false,
        reason: `Position too large: ${round(positionToVolumeRatio * 100, 2)}% of daily volume`,
      };
    }

    return { sufficient: true, ratio: round(positionToVolumeRatio * 100, 2) };
  }
}

// ─────────────────────────────────────────────
//  REGIME-AWARE RISK MANAGER
// ─────────────────────────────────────────────

class RegimeAwareRiskManager {
  constructor() {
    this.currentRegime = 'NEUTRAL';
    this.regimeHistory = [];
  }

  setRegime(regime) {
    this.currentRegime = regime;
    this.regimeHistory.push({ regime, timestamp: Date.now() });
    if (this.regimeHistory.length > 50) this.regimeHistory.shift();
  }

  getRiskMultiplier() {
    const multipliers = {
      'BULL_TREND': 1.2,
      'BEAR_TREND': 0.8,
      'RANGE_EXPANSION': 1.0,
      'RANGE_CONTRACTION': 0.7,
      'HIGH_VOLATILITY': 0.5,
      'LOW_VOLATILITY': 1.1,
      'NEUTRAL': 1.0,
    };

    return multipliers[this.currentRegime] || 1.0;
  }

  getMaxDrawdownLimit() {
    const limits = {
      'BULL_TREND': 0.15,
      'BEAR_TREND': 0.08,
      'HIGH_VOLATILITY': 0.05,
      'LOW_VOLATILITY': 0.12,
      'NEUTRAL': 0.10,
    };

    return limits[this.currentRegime] || 0.10;
  }

  getPositionSizeLimit(baseSize) {
    return baseSize * this.getRiskMultiplier();
  }
}

// ─────────────────────────────────────────────
//  PORTFOLIO RISK MANAGER
// ─────────────────────────────────────────────

class PortfolioRiskManager {
  constructor() {
    this.positions = new Map(); // symbol → { size, entryPrice, currentPrice, direction }
    this.correlationAnalyzer = new CorrelationAnalyzer();
    this.liquidityManager = new LiquidityRiskManager();
    this.regimeManager = new RegimeAwareRiskManager();
    this.tradeHistory = [];
  }

  addPosition(symbol, size, entryPrice, direction) {
    this.positions.set(symbol, {
      size,
      entryPrice,
      currentPrice: entryPrice,
      direction,
      timestamp: Date.now(),
    });
  }

  updatePosition(symbol, currentPrice) {
    const position = this.positions.get(symbol);
    if (position) {
      position.currentPrice = currentPrice;
    }
  }

  closePosition(symbol) {
    const position = this.positions.get(symbol);
    if (position) {
      const pnl = this._calculatePnL(position);
      this.tradeHistory.push({
        symbol,
        pnl,
        entryPrice: position.entryPrice,
        exitPrice: position.currentPrice,
        direction: position.direction,
        timestamp: Date.now(),
      });
      this.positions.delete(symbol);
      return pnl;
    }
    return 0;
  }

  _calculatePnL(position) {
    const priceChange = position.currentPrice - position.entryPrice;
    const multiplier = position.direction === 'LONG' ? 1 : -1;
    return round(priceChange * position.size * multiplier, 2);
  }

  getTotalExposure() {
    let totalLong = 0;
    let totalShort = 0;

    for (const [symbol, position] of this.positions) {
      const value = position.size * position.currentPrice;
      if (position.direction === 'LONG') {
        totalLong += value;
      } else {
        totalShort += value;
      }
    }

    return {
      totalLong: round(totalLong, 2),
      totalShort: round(totalShort, 2),
      netExposure: round(totalLong - totalShort, 2),
      grossExposure: round(totalLong + totalShort, 2),
    };
  }

  getPortfolioValue(accountBalance) {
    const exposure = this.getTotalExposure();
    return accountBalance + exposure.netExposure;
  }

  calculatePositionSize(signal, accountBalance, currentPrice) {
    // Use Kelly Criterion
    const kellyResult = KellyCriterionCalculator.adaptiveKelly(
      this.tradeHistory,
      accountBalance,
      currentPrice
    );

    // Adjust for regime
    const regimeMultiplier = this.regimeManager.getRiskMultiplier();
    let adjustedSize = kellyResult.positionSize * regimeMultiplier;

    // Check liquidity
    const liquidityCheck = this.liquidityManager.isLiquiditySufficient(
      signal.symbol,
      adjustedSize * currentPrice
    );

    if (!liquidityCheck.sufficient) {
      adjustedSize *= 0.5; // Reduce size by half if liquidity constrained
    }

    // Check correlation with existing positions
    const correlatedPositions = this.correlationAnalyzer.getHighlyCorrelated(signal.symbol, 0.7);
    if (correlatedPositions.length > 0) {
      const correlationPenalty = 1 - (correlatedPositions.length * 0.1);
      adjustedSize *= Math.max(correlationPenalty, 0.5);
    }

    // Ensure within base risk limits
    const maxRiskValue = accountBalance * BASE_RISK_PER_TRADE;
    const maxSizeByRisk = maxRiskValue / currentPrice;
    adjustedSize = Math.min(adjustedSize, maxSizeByRisk);

    return {
      ...kellyResult,
      adjustedSize: round(adjustedSize, 4),
      regimeMultiplier,
      liquidityCheck,
      correlationPenalty: correlatedPositions.length > 0 ? round(1 - (correlatedPositions.length * 0.1), 2) : 1,
    };
  }

  getPortfolioRisk(accountBalance) {
    const exposure = this.getTotalExposure();
    const portfolioValue = this.getPortfolioValue(accountBalance);
    
    // Calculate portfolio VaR
    const returns = this.tradeHistory.map(t => t.pnl / accountBalance);
    const tailRisk = TailRiskCalculator.getTailRiskMetrics(returns);

    // Check correlation risk
    const symbols = [...this.positions.keys()];
    const correlationRisk = this.correlationAnalyzer.getPortfolioCorrelation(symbols);

    return {
      totalExposure: exposure,
      portfolioValue: round(portfolioValue, 2),
      leverage: round(exposure.grossExposure / accountBalance, 2),
      tailRisk,
      correlationRisk,
      regime: this.regimeManager.currentRegime,
      riskMultiplier: this.regimeManager.getRiskMultiplier(),
      maxDrawdownLimit: this.regimeManager.getMaxDrawdownLimit(),
    };
  }
}

// ─────────────────────────────────────────────
//  MAIN INSTITUTIONAL RISK MANAGER CLASS
// ─────────────────────────────────────────────

class InstitutionalRiskManager extends EventEmitter {
  constructor(config = {}) {
    super();

    this.portfolioManager = new PortfolioRiskManager();
    this.accountBalance = config.accountBalance || 100000;
    this.maxDailyLoss = config.maxDailyLossPct || 0.03;
    this.maxDrawdown = config.maxDrawdownPct || 0.10;

    this.dailyPnL = 0;
    this.peakBalance = this.accountBalance;
    this.currentDrawdown = 0;

    // FIX: was never fed real trade results anywhere, so KellyCriterionCalculator
    // .adaptiveKelly() always fell back to its cold-start default (tradeHistory.length
    // < 10) and CorrelationAnalyzer never had real per-symbol return series. Tracked
    // here so recordTradeResult() (wired to /api/outcomes in api/server.js) can feed both.
    this._returnsBySymbol = new Map();

    this._stats = {
      tradesExecuted: 0,
      riskAdjustments: 0,
      liquidityRejections: 0,
      correlationRejections: 0,
      startTime: null,
    };
  }

  async connect() {
    console.log('[InstitutionalRiskManager] Starting...');
    this._stats.startTime = Date.now();
    this.emit('ready');
    console.log('[InstitutionalRiskManager] Connected successfully');
  }

  setRegime(regime) {
    this.portfolioManager.regimeManager.setRegime(regime);
    this.emit('regime_change', { regime, riskMultiplier: this.portfolioManager.regimeManager.getRiskMultiplier() });
  }

  updateLiquidity(symbol, volume, spread) {
    this.portfolioManager.liquidityManager.updateLiquidity(symbol, volume, spread);
  }

  addReturns(symbol, returns) {
    this.portfolioManager.correlationAnalyzer.addReturns(symbol, returns);
  }

  // FIX: this whole class was instantiated + connected in index.js but
  // .validateAndSizePosition() was never called anywhere, and nothing ever
  // fed it real trade outcomes — see index.js and api/server.js for the
  // other half of this wiring. Call this whenever a signal's outcome is
  // recorded (win/loss/breakeven, expressed in R-multiples) so Kelly sizing
  // and correlation analysis are based on real history instead of the
  // permanent cold-start default.
  recordTradeResult(symbol, pnlR, timestamp = Date.now()) {
    const pnl = Number(pnlR) || 0;

    this.portfolioManager.tradeHistory.push({
      symbol,
      pnl,
      entryPrice: 0,
      exitPrice: 0,
      direction: null,
      timestamp,
    });
    if (this.portfolioManager.tradeHistory.length > 500) {
      this.portfolioManager.tradeHistory.splice(0, this.portfolioManager.tradeHistory.length - 500);
    }
    this._stats.tradesExecuted++;

    // CorrelationAnalyzer.addReturns() expects the FULL array (it replaces,
    // not appends — see `returns.slice(-100)` above), so maintain our own
    // running per-symbol series and pass the whole thing each time.
    const series = this._returnsBySymbol.get(symbol) || [];
    series.push(pnl);
    const trimmed = series.slice(-100);
    this._returnsBySymbol.set(symbol, trimmed);
    this.addReturns(symbol, trimmed);

    return { tradesExecuted: this._stats.tradesExecuted, seriesLength: trimmed.length };
  }

  /**
   * Validates and sizes a new position
   */
  validateAndSizePosition(signal, currentPrice) {
    const sizing = this.portfolioManager.calculatePositionSize(
      signal,
      this.accountBalance,
      currentPrice
    );

    // Check daily loss limit
    const dailyLossPct = Math.abs(this.dailyPnL) / this.accountBalance;
    if (dailyLossPct >= this.maxDailyLoss * 0.8) {
      this._stats.riskAdjustments++;
      sizing.adjustedSize *= 0.5; // Halve size if approaching daily loss limit
      sizing.warning = 'Approaching daily loss limit - position size reduced';
    }

    // Check drawdown limit
    if (this.currentDrawdown >= this.maxDrawdown * 0.8) {
      this._stats.riskAdjustments++;
      sizing.adjustedSize *= 0.5;
      sizing.warning = 'Approaching max drawdown - position size reduced';
    }

    // FIX: MAX_PORTFOLIO_RISK and MAX_CORRELATION_EXPOSURE were defined at the top
    // of this file but never referenced anywhere — the intended portfolio-wide
    // exposure cap and correlated-exposure cap were silently unenforced. Wired up here.
    const exposure = this.portfolioManager.getTotalExposure();
    const projectedGross = exposure.grossExposure + (sizing.adjustedSize * currentPrice);
    if (this.accountBalance > 0 && (projectedGross / this.accountBalance) > MAX_PORTFOLIO_RISK) {
      const allowedValue = Math.max(0, (MAX_PORTFOLIO_RISK * this.accountBalance) - exposure.grossExposure);
      sizing.adjustedSize = Math.max(0, Math.min(sizing.adjustedSize, allowedValue / currentPrice));
      sizing.portfolioRiskCapped = true;
      sizing.warning = sizing.warning
        ? `${sizing.warning} | Portfolio exposure capped at ${(MAX_PORTFOLIO_RISK * 100).toFixed(0)}% of account`
        : `Portfolio exposure capped at ${(MAX_PORTFOLIO_RISK * 100).toFixed(0)}% of account`;
      this._stats.riskAdjustments++;
    }

    const correlatedPositions = this.portfolioManager.correlationAnalyzer.getHighlyCorrelated(signal.symbol, 0.7);
    if (correlatedPositions.length > 0) {
      const correlatedValue = correlatedPositions.reduce((sum, c) => {
        const pos = this.portfolioManager.positions.get(c.symbol);
        return sum + (pos ? pos.size * pos.currentPrice : 0);
      }, 0);
      const projectedCorrValue = correlatedValue + (sizing.adjustedSize * currentPrice);
      if (this.accountBalance > 0 && (projectedCorrValue / this.accountBalance) > MAX_CORRELATION_EXPOSURE) {
        const allowedCorrValue = Math.max(0, (MAX_CORRELATION_EXPOSURE * this.accountBalance) - correlatedValue);
        sizing.adjustedSize = Math.max(0, Math.min(sizing.adjustedSize, allowedCorrValue / currentPrice));
        sizing.correlationExposureCapped = true;
        sizing.warning = sizing.warning
          ? `${sizing.warning} | Correlated exposure capped at ${(MAX_CORRELATION_EXPOSURE * 100).toFixed(0)}% of account`
          : `Correlated exposure capped at ${(MAX_CORRELATION_EXPOSURE * 100).toFixed(0)}% of account`;
      }
    }

    // Track liquidity rejections
    if (!sizing.liquidityCheck.sufficient) {
      this._stats.liquidityRejections++;
    }

    // Track correlation rejections
    if (sizing.correlationPenalty < 1 || sizing.correlationExposureCapped) {
      this._stats.correlationRejections++;
    }

    return sizing;
  }

  executePosition(symbol, size, entryPrice, direction) {
    this.portfolioManager.addPosition(symbol, size, entryPrice, direction);
    this._stats.tradesExecuted++;
    this.emit('position_opened', { symbol, size, entryPrice, direction });
  }

  updatePosition(symbol, currentPrice) {
    this.portfolioManager.updatePosition(symbol, currentPrice);
    
    // Update PnL
    const position = this.portfolioManager.positions.get(symbol);
    if (position) {
      const pnl = this.portfolioManager._calculatePnL(position);
      this.dailyPnL += pnl;
      
      // Update drawdown
      const currentBalance = this.accountBalance + this.dailyPnL;
      if (currentBalance > this.peakBalance) {
        this.peakBalance = currentBalance;
      }
      this.currentDrawdown = (this.peakBalance - currentBalance) / this.peakBalance;
    }
  }

  closePosition(symbol) {
    const pnl = this.portfolioManager.closePosition(symbol);
    this.dailyPnL += pnl;
    this.emit('position_closed', { symbol, pnl });
    return pnl;
  }

  getPortfolioRisk() {
    return this.portfolioManager.getPortfolioRisk(this.accountBalance);
  }

  getPositions() {
    return [...this.portfolioManager.positions.entries()].map(([symbol, pos]) => ({
      symbol,
      ...pos,
      pnl: this.portfolioManager._calculatePnL(pos),
    }));
  }

  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return {
      ...this._stats,
      uptime,
      accountBalance: this.accountBalance,
      dailyPnL: round(this.dailyPnL, 2),
      currentDrawdown: round(this.currentDrawdown * 100, 2),
      peakBalance: round(this.peakBalance, 2),
      openPositions: this.portfolioManager.positions.size,
    };
  }

  resetDaily() {
    this.dailyPnL = 0;
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  InstitutionalRiskManager,
  PortfolioRiskManager,
  KellyCriterionCalculator,
  CorrelationAnalyzer,
  TailRiskCalculator,
  LiquidityRiskManager,
  RegimeAwareRiskManager,
};
