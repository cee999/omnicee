/**
 * ============================================================
 *  EXECUTION ALGORITHMS — Jane Street / Wall Street Style
 *  AI Trading Assistant · Layer 13 · Execution Module
 *  File: orchestrator/execution-algorithms.js
 * ============================================================
 *
 *  Institutional-grade execution algorithms inspired by:
 *  - Jane Street: TWAP/VWAP execution, optimal execution timing
 *  - Citadel: Momentum-aware execution, liquidity detection
 *  - Two Sigma: Bayesian execution, uncertainty-aware sizing
 *  - Virtu: Microstructure-aware execution, spread optimization
 *
 *  Features:
 *  1. TWAP (Time-Weighted Average Price) Execution
 *  2. VWAP (Volume-Weighted Average Price) Execution
 *  3. POV (Percentage of Volume) Execution
 *  4. Implementation Shortfall Tracking
 *  5. Market Microstructure Awareness
 *  6. Adaptive Slicing Algorithms
 *  7. Slippage Minimization
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const DEFAULT_TWAP_SLICES = 10;
const DEFAULT_VWAP_PARTICIPATION_RATE = 0.05; // 5% of volume
const MAX_SLIPPAGE_TOLERANCE = 0.001; // 0.1%
const MIN_SPREAD_THRESHOLD = 0.0002; // 0.02%

function round(n, d = 2) { return parseFloat((n ?? 0).toFixed(d)); }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function avg(arr) { return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length; }

// ─────────────────────────────────────────────
//  MARKET MICROSTRUCTURE ANALYZER
// ─────────────────────────────────────────────

class MarketMicrostructureAnalyzer {
  constructor() {
    this.orderBookHistory = [];
    this.tradeHistory = [];
    this.spreadHistory = [];
  }

  updateOrderBook(orderBook) {
    this.orderBookHistory.push({
      bids: orderBook.bids,
      asks: orderBook.asks,
      timestamp: Date.now(),
    });

    if (this.orderBookHistory.length > 100) this.orderBookHistory.shift();

    // Calculate spread
    if (orderBook.bids.length > 0 && orderBook.asks.length > 0) {
      const bestBid = orderBook.bids[0].price;
      const bestAsk = orderBook.asks[0].price;
      const spread = (bestAsk - bestBid) / bestBid;
      this.spreadHistory.push(spread);
      if (this.spreadHistory.length > 50) this.spreadHistory.shift();
    }
  }

  addTrade(trade) {
    this.tradeHistory.push(trade);
    if (this.tradeHistory.length > 200) this.tradeHistory.shift();
  }

  getCurrentSpread() {
    if (this.spreadHistory.length === 0) return 0;
    return this.spreadHistory[this.spreadHistory.length - 1];
  }

  getAverageSpread() {
    if (this.spreadHistory.length === 0) return 0;
    return avg(this.spreadHistory);
  }

  getLiquidityDepth(side, levels = 5) {
    if (this.orderBookHistory.length === 0) return 0;

    const latest = this.orderBookHistory[this.orderBookHistory.length - 1];
    const orders = side === 'bid' ? latest.bids : latest.asks;
    
    return orders.slice(0, levels).reduce((sum, order) => sum + order.quantity, 0);
  }

  getImbalance() {
    if (this.orderBookHistory.length === 0) return 0;

    const latest = this.orderBookHistory[this.orderBookHistory.length - 1];
    const bidDepth = this.getLiquidityDepth('bid', 5);
    const askDepth = this.getLiquidityDepth('ask', 5);

    if (bidDepth + askDepth === 0) return 0;
    return (bidDepth - askDepth) / (bidDepth + askDepth);
  }

  getVolumeProfile(windowMs = 3600000) {
    const cutoff = Date.now() - windowMs;
    const recentTrades = this.tradeHistory.filter(t => t.timestamp >= cutoff);

    if (recentTrades.length === 0) return null;

    const volumeByPrice = new Map();
    for (const trade of recentTrades) {
      const priceLevel = round(trade.price, 2);
      volumeByPrice.set(priceLevel, (volumeByPrice.get(priceLevel) || 0) + trade.quantity);
    }

    return {
      totalVolume: recentTrades.reduce((sum, t) => sum + t.quantity, 0),
      priceLevels: [...volumeByPrice.entries()].map(([price, volume]) => ({ price, volume })),
      vwap: recentTrades.reduce((sum, t) => sum + t.price * t.quantity, 0) / 
             recentTrades.reduce((sum, t) => sum + t.quantity, 0),
    };
  }

  isOptimalExecutionTime(direction) {
    const spread = this.getCurrentSpread();
    const imbalance = this.getImbalance();

    // Good execution conditions:
    // - Low spread
    // - Order flow in our direction (for passive fills)
    const spreadOk = spread <= MIN_SPREAD_THRESHOLD * 5;
    const flowOk = (direction === 'LONG' && imbalance > 0.2) || 
                   (direction === 'SHORT' && imbalance < -0.2);

    return {
      optimal: spreadOk && flowOk,
      spread: round(spread, 4),
      imbalance: round(imbalance, 3),
      reason: spreadOk ? (flowOk ? 'Favorable order flow' : 'Neutral flow') : 'Wide spread',
    };
  }
}

// ─────────────────────────────────────────────
//  TWAP EXECUTION
// ─────────────────────────────────────────────

class TWAPExecutor {
  constructor(microstructureAnalyzer) {
    this.microstructure = microstructureAnalyzer;
    this.activeExecutions = new Map();
  }

  /**
   * Time-Weighted Average Price execution
   * Slices order over time to minimize market impact
   */
  execute(symbol, totalQuantity, direction, durationMs, slices = DEFAULT_TWAP_SLICES) {
    const sliceQuantity = totalQuantity / slices;
    const sliceInterval = durationMs / slices;

    const executionId = `${symbol}-${Date.now()}`;
    const execution = {
      id: executionId,
      symbol,
      totalQuantity,
      direction,
      durationMs,
      slices,
      sliceQuantity: round(sliceQuantity, 4),
      sliceInterval,
      startTime: Date.now(),
      endTime: Date.now() + durationMs,
      completedSlices: 0,
      filledQuantity: 0,
      avgFillPrice: 0,
      fills: [],
      status: 'ACTIVE',
    };

    this.activeExecutions.set(executionId, execution);

    return {
      executionId,
      schedule: this._generateSchedule(execution),
      estimatedCompletion: execution.endTime,
    };
  }

  _generateSchedule(execution) {
    const schedule = [];
    for (let i = 0; i < execution.slices; i++) {
      schedule.push({
        sliceIndex: i,
        executeAt: execution.startTime + (i * execution.sliceInterval),
        quantity: execution.sliceQuantity,
      });
    }
    return schedule;
  }

  processSlice(executionId, currentPrice) {
    const execution = this.activeExecutions.get(executionId);
    if (!execution || execution.status !== 'ACTIVE') return null;

    const now = Date.now();
    if (now > execution.endTime) {
      execution.status = 'COMPLETED';
      return { status: 'COMPLETED', execution };
    }

    // Check if it's time for next slice
    const nextSliceIndex = execution.completedSlices;
    const nextSliceTime = execution.startTime + (nextSliceIndex * execution.sliceInterval);

    if (now >= nextSliceTime) {
      const fill = {
        sliceIndex: nextSliceIndex,
        quantity: execution.sliceQuantity,
        price: currentPrice,
        timestamp: now,
      };

      execution.fills.push(fill);
      execution.completedSlices++;
      execution.filledQuantity += fill.quantity;

      // Update average fill price
      const totalValue = execution.fills.reduce((sum, f) => sum + f.price * f.quantity, 0);
      execution.avgFillPrice = totalValue / execution.filledQuantity;

      if (execution.completedSlices >= execution.slices) {
        execution.status = 'COMPLETED';
      }

      return { fill, execution };
    }

    return null;
  }

  getExecutionStatus(executionId) {
    return this.activeExecutions.get(executionId) || null;
  }

  cancelExecution(executionId) {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.status = 'CANCELLED';
      execution.cancelledAt = Date.now();
      return execution;
    }
    return null;
  }
}

// ─────────────────────────────────────────────
//  VWAP EXECUTION
// ─────────────────────────────────────────────

class VWAPExecutor {
  constructor(microstructureAnalyzer) {
    this.microstructure = microstructureAnalyzer;
    this.activeExecutions = new Map();
  }

  /**
   * Volume-Weighted Average Price execution
   * Participates in volume proportionally to minimize impact
   */
  execute(symbol, totalQuantity, direction, participationRate = DEFAULT_VWAP_PARTICIPATION_RATE) {
    const executionId = `${symbol}-vwap-${Date.now()}`;
    const execution = {
      id: executionId,
      symbol,
      totalQuantity,
      direction,
      participationRate,
      startTime: Date.now(),
      filledQuantity: 0,
      avgFillPrice: 0,
      fills: [],
      status: 'ACTIVE',
      targetVWAP: null,
      achievedVWAP: null,
    };

    this.activeExecutions.set(executionId, execution);

    return {
      executionId,
      participationRate,
      estimatedDuration: 'Until filled or cancelled',
    };
  }

  processTick(executionId, currentPrice, volume) {
    const execution = this.activeExecutions.get(executionId);
    if (!execution || execution.status !== 'ACTIVE') return null;

    const remainingQuantity = execution.totalQuantity - execution.filledQuantity;
    if (remainingQuantity <= 0) {
      execution.status = 'COMPLETED';
      return { status: 'COMPLETED', execution };
    }

    // Calculate slice size based on participation rate
    const sliceQuantity = volume * execution.participationRate;
    const actualSlice = Math.min(sliceQuantity, remainingQuantity);

    if (actualSlice > 0) {
      const fill = {
        quantity: round(actualSlice, 4),
        price: currentPrice,
        volume: volume,
        timestamp: Date.now(),
      };

      execution.fills.push(fill);
      execution.filledQuantity += fill.quantity;

      // Update VWAP
      const totalValue = execution.fills.reduce((sum, f) => sum + f.price * f.quantity, 0);
      execution.achievedVWAP = totalValue / execution.filledQuantity;

      // Get market VWAP from microstructure
      const volumeProfile = this.microstructure.getVolumeProfile();
      if (volumeProfile) {
        execution.targetVWAP = volumeProfile.vwap;
      }

      if (execution.filledQuantity >= execution.totalQuantity) {
        execution.status = 'COMPLETED';
      }

      return { fill, execution };
    }

    return null;
  }

  getExecutionStatus(executionId) {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) return null;

    const slippage = execution.targetVWAP && execution.achievedVWAP 
      ? ((execution.achievedVWAP - execution.targetVWAP) / execution.targetVWAP) * 100 
      : 0;

    // FIX: MAX_SLIPPAGE_TOLERANCE was defined but never checked against actual
    // slippage anywhere — an execution could drift arbitrarily far from its
    // target VWAP with no signal to the caller. Flag it explicitly now.
    const excessiveSlippage = Math.abs(slippage / 100) > MAX_SLIPPAGE_TOLERANCE;
    if (excessiveSlippage && execution.status === 'ACTIVE' && !execution._slippageWarned) {
      execution._slippageWarned = true;
      this.emit?.('excessive_slippage', {
        executionId,
        slippage: round(slippage, 3),
        toleranceBps: round(MAX_SLIPPAGE_TOLERANCE * 10000, 1),
      });
    }

    return {
      ...execution,
      slippage: round(slippage, 3),
      excessiveSlippage,
      slippageTolerancePct: round(MAX_SLIPPAGE_TOLERANCE * 100, 3),
      completionPct: round((execution.filledQuantity / execution.totalQuantity) * 100, 1),
    };
  }

  cancelExecution(executionId) {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.status = 'CANCELLED';
      execution.cancelledAt = Date.now();
      return execution;
    }
    return null;
  }
}

// ─────────────────────────────────────────────
//  POV EXECUTION
// ─────────────────────────────────────────────

class POVExecutor {
  constructor(microstructureAnalyzer) {
    this.microstructure = microstructureAnalyzer;
    this.activeExecutions = new Map();
  }

  /**
   * Percentage of Volume execution
   * Executes a fixed percentage of each trade's volume
   */
  execute(symbol, totalQuantity, direction, povPercentage = 0.1) {
    const executionId = `${symbol}-pov-${Date.now()}`;
    const execution = {
      id: executionId,
      symbol,
      totalQuantity,
      direction,
      povPercentage,
      startTime: Date.now(),
      filledQuantity: 0,
      avgFillPrice: 0,
      fills: [],
      status: 'ACTIVE',
    };

    this.activeExecutions.set(executionId, execution);

    return {
      executionId,
      povPercentage,
      estimatedDuration: 'Until filled or cancelled',
    };
  }

  processTrade(executionId, trade) {
    const execution = this.activeExecutions.get(executionId);
    if (!execution || execution.status !== 'ACTIVE') return null;

    const remainingQuantity = execution.totalQuantity - execution.filledQuantity;
    if (remainingQuantity <= 0) {
      execution.status = 'COMPLETED';
      return { status: 'COMPLETED', execution };
    }

    // Check if trade direction matches our execution direction
    const tradeDirection = trade.side === 'buy' ? 'LONG' : 'SHORT';
    if (tradeDirection !== execution.direction) return null;

    // Calculate our share
    const ourQuantity = trade.quantity * execution.povPercentage;
    const actualQuantity = Math.min(ourQuantity, remainingQuantity);

    if (actualQuantity > 0) {
      const fill = {
        quantity: round(actualQuantity, 4),
        price: trade.price,
        tradeId: trade.id,
        timestamp: Date.now(),
      };

      execution.fills.push(fill);
      execution.filledQuantity += fill.quantity;

      const totalValue = execution.fills.reduce((sum, f) => sum + f.price * f.quantity, 0);
      execution.avgFillPrice = totalValue / execution.filledQuantity;

      if (execution.filledQuantity >= execution.totalQuantity) {
        execution.status = 'COMPLETED';
      }

      return { fill, execution };
    }

    return null;
  }

  getExecutionStatus(executionId) {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) return null;

    return {
      ...execution,
      completionPct: round((execution.filledQuantity / execution.totalQuantity) * 100, 1),
    };
  }

  cancelExecution(executionId) {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.status = 'CANCELLED';
      execution.cancelledAt = Date.now();
      return execution;
    }
    return null;
  }
}

// ─────────────────────────────────────────────
//  IMPLEMENTATION SHORTFALL TRACKER
// ─────────────────────────────────────────────

class ImplementationShortfallTracker {
  constructor() {
    this.executions = new Map();
  }

  trackExecution(executionId, benchmarkPrice, targetQuantity) {
    this.executions.set(executionId, {
      benchmarkPrice,
      targetQuantity,
      startTime: Date.now(),
      fills: [],
    });
  }

  addFill(executionId, price, quantity) {
    const execution = this.executions.get(executionId);
    if (!execution) return null;

    execution.fills.push({ price, quantity, timestamp: Date.now() });
    return this.calculateShortfall(executionId);
  }

  calculateShortfall(executionId) {
    const execution = this.executions.get(executionId);
    if (!execution || execution.fills.length === 0) return null;

    const totalFilled = execution.fills.reduce((sum, f) => sum + f.quantity, 0);
    const avgFillPrice = execution.fills.reduce((sum, f) => sum + f.price * f.quantity, 0) / totalFilled;

    // Market impact: difference between fill price and benchmark
    const marketImpact = (avgFillPrice - execution.benchmarkPrice) / execution.benchmarkPrice;

    // Timing cost: price drift from start to fill
    const timingCost = execution.fills.reduce((sum, f) => {
      const timeElapsed = f.timestamp - execution.startTime;
      const priceDrift = (f.price - execution.benchmarkPrice) / execution.benchmarkPrice;
      return sum + priceDrift * (timeElapsed / 3600000); // Per hour
    }, 0);

    // Opportunity cost: unfilled quantity
    const opportunityCost = (execution.targetQuantity - totalFilled) / execution.targetQuantity;

    const totalShortfall = marketImpact + timingCost + opportunityCost;

    return {
      executionId,
      marketImpact: round(marketImpact * 100, 2), // bps
      timingCost: round(timingCost * 100, 2), // bps
      opportunityCost: round(opportunityCost * 100, 2), // bps
      totalShortfall: round(totalShortfall * 100, 2), // bps
      avgFillPrice: round(avgFillPrice, 2),
      fillRate: round((totalFilled / execution.targetQuantity) * 100, 1),
    };
  }
}

// ─────────────────────────────────────────────
//  ADAPTIVE SLICING ALGORITHM
// ─────────────────────────────────────────────

class AdaptiveSlicingAlgorithm {
  constructor(microstructureAnalyzer) {
    this.microstructure = microstructureAnalyzer;
  }

  /**
   * Dynamically adjusts slice sizes based on market conditions
   */
  calculateSlices(totalQuantity, direction, durationMs) {
    const baseSlices = DEFAULT_TWAP_SLICES;
    const spread = this.microstructure.getCurrentSpread();
    const imbalance = this.microstructure.getImbalance();
    const liquidityDepth = this.microstructure.getLiquidityDepth(direction === 'LONG' ? 'ask' : 'bid', 5);

    // Adjust slice count based on conditions
    let adjustedSlices = baseSlices;

    // More slices in wide spread conditions
    if (spread > MIN_SPREAD_THRESHOLD * 2) {
      adjustedSlices = Math.min(baseSlices * 2, 20);
    }

    // More slices when liquidity is low
    if (liquidityDepth < totalQuantity * 10) {
      adjustedSlices = Math.min(baseSlices * 1.5, 15);
    }

    // Fewer slices when order flow is favorable
    if ((direction === 'LONG' && imbalance > 0.3) || (direction === 'SHORT' && imbalance < -0.3)) {
      adjustedSlices = Math.max(baseSlices * 0.7, 5);
    }

    // Calculate variable slice sizes (front-loaded or back-loaded)
    const sliceSizes = this._generateVariableSlices(totalQuantity, adjustedSlices, imbalance);

    return {
      sliceCount: adjustedSlices,
      sliceSizes,
      reasoning: {
        spread: round(spread, 4),
        imbalance: round(imbalance, 3),
        liquidityDepth,
        adjustment: round(adjustedSlices / baseSlices, 2),
      },
    };
  }

  _generateVariableSlices(totalQuantity, sliceCount, imbalance) {
    const slices = [];
    const baseSize = totalQuantity / sliceCount;

    // Front-loaded when order flow is favorable
    // Back-loaded when waiting for better prices
    const frontLoad = imbalance > 0.2 ? 1.3 : imbalance < -0.2 ? 0.7 : 1.0;

    for (let i = 0; i < sliceCount; i++) {
      // Exponential decay for front-loading
      const weight = Math.exp(-0.1 * i);
      const adjustedWeight = frontLoad > 1 ? weight * frontLoad : weight;
      
      let sliceSize = baseSize * adjustedWeight;
      
      // Normalize to ensure total equals target
      if (i === sliceCount - 1) {
        const used = slices.reduce((sum, s) => sum + s, 0);
        sliceSize = totalQuantity - used;
      }

      slices.push(round(sliceSize, 4));
    }

    return slices;
  }
}

// ─────────────────────────────────────────────
//  MAIN EXECUTION MANAGER CLASS
// ─────────────────────────────────────────────

class ExecutionManager extends EventEmitter {
  constructor(config = {}) {
    super();

    this.microstructure = new MarketMicrostructureAnalyzer();
    this.twapExecutor = new TWAPExecutor(this.microstructure);
    this.vwapExecutor = new VWAPExecutor(this.microstructure);
    this.povExecutor = new POVExecutor(this.microstructure);
    this.shortfallTracker = new ImplementationShortfallTracker();
    this.adaptiveSlicer = new AdaptiveSlicingAlgorithm(this.microstructure);

    this._stats = {
      executionsStarted: 0,
      executionsCompleted: 0,
      executionsCancelled: 0,
      totalSlippage: 0,
      avgShortfall: 0,
      startTime: null,
    };
  }

  async connect() {
    console.log('[ExecutionManager] Starting...');
    this._stats.startTime = Date.now();
    this.emit('ready');
    console.log('[ExecutionManager] Connected successfully');
  }

  updateOrderBook(orderBook) {
    this.microstructure.updateOrderBook(orderBook);
  }

  addTrade(trade) {
    this.microstructure.addTrade(trade);
  }

  /**
   * Execute using specified algorithm
   */
  execute(algorithm, params) {
    this._stats.executionsStarted++;

    switch (algorithm.toLowerCase()) {
      case 'twap':
        return this.twapExecutor.execute(
          params.symbol,
          params.quantity,
          params.direction,
          params.durationMs,
          params.slices
        );
      case 'vwap':
        return this.vwapExecutor.execute(
          params.symbol,
          params.quantity,
          params.direction,
          params.participationRate
        );
      case 'pov':
        return this.povExecutor.execute(
          params.symbol,
          params.quantity,
          params.direction,
          params.povPercentage
        );
      default:
        throw new Error(`Unknown algorithm: ${algorithm}`);
    }
  }

  /**
   * Get optimal execution recommendation
   */
  getOptimalExecution(symbol, quantity, direction) {
    const optimal = this.microstructure.isOptimalExecutionTime(direction);
    const adaptiveSlices = this.adaptiveSlicer.calculateSlices(quantity, direction, 60000);

    let recommendedAlgorithm = 'TWAP';
    if (optimal.imbalance > 0.3 || optimal.imbalance < -0.3) {
      recommendedAlgorithm = 'VWAP'; // Use VWAP when order flow is strong
    }

    return {
      optimal: optimal.optimal,
      recommendedAlgorithm,
      adaptiveSlices,
      currentSpread: optimal.spread,
      orderFlowImbalance: optimal.imbalance,
      reasoning: optimal.reason,
    };
  }

  processTick(executionId, currentPrice, volume = null) {
    // Process TWAP executions
    const twapResult = this.twapExecutor.processSlice(executionId, currentPrice);
    if (twapResult) {
      if (twapResult.status === 'COMPLETED') {
        this._stats.executionsCompleted++;
        this.emit('execution_completed', { executionId, algorithm: 'TWAP', result: twapResult });
      }
      return twapResult;
    }

    // Process VWAP executions
    if (volume) {
      const vwapResult = this.vwapExecutor.processTick(executionId, currentPrice, volume);
      if (vwapResult) {
        if (vwapResult.status === 'COMPLETED') {
          this._stats.executionsCompleted++;
          this.emit('execution_completed', { executionId, algorithm: 'VWAP', result: vwapResult });
        }
        return vwapResult;
      }
    }

    return null;
  }

  processTrade(executionId, trade) {
    const povResult = this.povExecutor.processTrade(executionId, trade);
    if (povResult && povResult.status === 'COMPLETED') {
      this._stats.executionsCompleted++;
      this.emit('execution_completed', { executionId, algorithm: 'POV', result: povResult });
    }
    return povResult;
  }

  cancelExecution(executionId) {
    this._stats.executionsCancelled++;
    
    const twapCancel = this.twapExecutor.cancelExecution(executionId);
    if (twapCancel) {
      this.emit('execution_cancelled', { executionId, algorithm: 'TWAP' });
      return twapCancel;
    }

    const vwapCancel = this.vwapExecutor.cancelExecution(executionId);
    if (vwapCancel) {
      this.emit('execution_cancelled', { executionId, algorithm: 'VWAP' });
      return vwapCancel;
    }

    const povCancel = this.povExecutor.cancelExecution(executionId);
    if (povCancel) {
      this.emit('execution_cancelled', { executionId, algorithm: 'POV' });
      return povCancel;
    }

    return null;
  }

  getExecutionStatus(executionId, algorithm) {
    switch (algorithm.toLowerCase()) {
      case 'twap':
        return this.twapExecutor.getExecutionStatus(executionId);
      case 'vwap':
        return this.vwapExecutor.getExecutionStatus(executionId);
      case 'pov':
        return this.povExecutor.getExecutionStatus(executionId);
      default:
        return null;
    }
  }

  getMarketState() {
    return {
      currentSpread: round(this.microstructure.getCurrentSpread(), 4),
      averageSpread: round(this.microstructure.getAverageSpread(), 4),
      orderFlowImbalance: round(this.microstructure.getImbalance(), 3),
      bidDepth: this.microstructure.getLiquidityDepth('bid', 5),
      askDepth: this.microstructure.getLiquidityDepth('ask', 5),
      volumeProfile: this.microstructure.getVolumeProfile(),
    };
  }

  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return {
      ...this._stats,
      uptime,
      activeExecutions: 
        this.twapExecutor.activeExecutions.size +
        this.vwapExecutor.activeExecutions.size +
        this.povExecutor.activeExecutions.size,
    };
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  ExecutionManager,
  TWAPExecutor,
  VWAPExecutor,
  POVExecutor,
  MarketMicrostructureAnalyzer,
  ImplementationShortfallTracker,
  AdaptiveSlicingAlgorithm,
};
