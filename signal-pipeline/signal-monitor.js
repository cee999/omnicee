/**
 * ============================================================
 *  SIGNAL MONITOR — Real-Time Signal Strength & Lifecycle Tracking
 *  AI Trading Assistant · Layer 11 · Signal Monitoring Module
 *  File: signal-pipeline/signal-monitor.js
 * ============================================================
 *
 *  Monitors signals in real-time to detect:
 *  1. Signal strength degradation (weakening)
 *  2. Early reversal warnings
 *  3. Signal confirmation/strengthening
 *  4. Optimal exit timing
 *
 *  This provides the "zero margin of error" requirement by
 *  continuously validating signal integrity and alerting on
 *  any deterioration.
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const SIGNAL_STRENGTH_THRESHOLDS = {
  STRONG: 80,
  MODERATE: 60,
  WEAK: 40,
  FAILING: 20,
};

const WEAKENING_THRESHOLD = 15; // Drop of 15 points = weakening
const REVERSAL_THRESHOLD = 30; // Drop of 30 points = reversal risk

function round(n, d = 2) { return parseFloat((n ?? 0).toFixed(d)); }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// ─────────────────────────────────────────────
//  SIGNAL STATE TRACKER
// ─────────────────────────────────────────────

class SignalStateTracker {
  constructor() {
    this.signals = new Map(); // signalId → { initialScore, currentScore, history, timestamp, status }
  }

  createSignal(signalId, initialScore, metadata = {}) {
    this.signals.set(signalId, {
      signalId,
      initialScore,
      currentScore: initialScore,
      history: [{ score: initialScore, timestamp: Date.now() }],
      timestamp: Date.now(),
      status: 'ACTIVE',
      metadata,
      alerts: [],
    });
  }

  updateSignal(signalId, newScore, context = {}) {
    const signal = this.signals.get(signalId);
    if (!signal) return null;

    const previousScore = signal.currentScore;
    const scoreChange = newScore - previousScore;
    
    signal.currentScore = newScore;
    signal.history.push({ score: newScore, timestamp: Date.now(), context });
    
    // Keep only last 100 history points
    if (signal.history.length > 100) signal.history.shift();

    // Detect status changes
    const statusChange = this._detectStatusChange(signal, previousScore, newScore);
    
    if (statusChange) {
      signal.status = statusChange.newStatus;
      signal.alerts.push({
        type: statusChange.type,
        message: statusChange.message,
        timestamp: Date.now(),
        previousScore,
        newScore,
        change: scoreChange,
      });
    }

    return {
      signalId,
      previousScore,
      newScore,
      change: scoreChange,
      status: signal.status,
      alert: statusChange,
    };
  }

  _detectStatusChange(signal, previousScore, newScore) {
    const change = newScore - previousScore;
    
    // Weakening detection
    if (change <= -WEAKENING_THRESHOLD && newScore >= SIGNAL_STRENGTH_THRESHOLDS.MODERATE) {
      return {
        type: 'WEAKENING',
        newStatus: 'WEAKENING',
        message: `Signal weakening: ${previousScore} → ${newScore} (change: ${round(change)})`,
      };
    }
    
    // Reversal risk
    if (change <= -REVERSAL_THRESHOLD) {
      return {
        type: 'REVERSAL_RISK',
        newStatus: 'REVERSAL_RISK',
        message: `Reversal risk: Signal dropped ${round(Math.abs(change))} points`,
      };
    }
    
    // Signal failed
    if (newScore <= SIGNAL_STRENGTH_THRESHOLDS.FAILING) {
      return {
        type: 'SIGNAL_FAILED',
        newStatus: 'FAILED',
        message: `Signal failed: Score dropped to ${newScore}`,
      };
    }
    
    // Strengthening
    if (change >= WEAKENING_THRESHOLD && newScore > previousScore) {
      return {
        type: 'STRENGTHENING',
        newStatus: signal.status === 'WEAKENING' ? 'RECOVERING' : signal.status,
        message: `Signal strengthening: ${previousScore} → ${newScore}`,
      };
    }
    
    // Recovery
    if (signal.status === 'WEAKENING' && newScore >= signal.initialScore - 10) {
      return {
        type: 'RECOVERED',
        newStatus: 'ACTIVE',
        message: `Signal recovered to ${newScore}`,
      };
    }
    
    return null;
  }

  getSignal(signalId) {
    return this.signals.get(signalId) || null;
  }

  getAllSignals() {
    return [...this.signals.values()];
  }

  getSignalsByStatus(status) {
    return this.getAllSignals().filter(s => s.status === status);
  }

  terminateSignal(signalId, reason = 'MANUAL') {
    const signal = this.signals.get(signalId);
    if (!signal) return null;

    signal.status = 'TERMINATED';
    signal.terminatedAt = Date.now();
    signal.terminationReason = reason;
    
    signal.alerts.push({
      type: 'TERMINATED',
      message: `Signal terminated: ${reason}`,
      timestamp: Date.now(),
    });

    return signal;
  }
}

// ─────────────────────────────────────────────
//  SIGNAL STRENGTH CALCULATOR
// ─────────────────────────────────────────────

class SignalStrengthCalculator {
  /**
   * Calculates signal strength based on multiple factors:
   * - Original signal score
   * - Price action confirmation
   * - Volume confirmation
   * - Time decay
   * - Market regime alignment
   */
  static calculate(originalSignal, currentMarketData, timeElapsed) {
    let strength = originalSignal.score || 0;
    
    // Time decay: signals weaken over time
    const timeDecay = Math.min(timeElapsed / (24 * 60 * 60 * 1000), 1) * 10; // Max 10% decay per day
    strength -= timeDecay;
    
    // Price action confirmation
    if (currentMarketData.priceConfirmation) {
      const priceDirection = currentMarketData.priceDirection; // 'bullish' or 'bearish'
      const signalDirection = originalSignal.direction; // 'LONG' or 'SHORT'
      
      if ((priceDirection === 'bullish' && signalDirection === 'LONG') ||
          (priceDirection === 'bearish' && signalDirection === 'SHORT')) {
        strength += 5; // Confirmation adds strength
      } else {
        strength -= 10; // Divergence reduces strength
      }
    }
    
    // Volume confirmation
    if (currentMarketData.volumeConfirmation) {
      strength += 3;
    } else {
      strength -= 3;
    }
    
    // Market regime alignment
    if (currentMarketData.regime) {
      const regime = currentMarketData.regime;
      if ((regime.includes('BULL') && originalSignal.direction === 'LONG') ||
          (regime.includes('BEAR') && originalSignal.direction === 'SHORT')) {
        strength += 5;
      } else {
        strength -= 5;
      }
    }
    
    // Volatility penalty (high volatility = less reliable)
    if (currentMarketData.volatility && currentMarketData.volatility > 2) {
      strength -= 5;
    }
    
    return clamp(round(strength), 0, 100);
  }
}

// ─────────────────────────────────────────────
//  REVERSAL DETECTOR
// ─────────────────────────────────────────────

class ReversalDetector {
  constructor() {
    this.patterns = new Map(); // symbol → pattern history
  }

  /**
   * Detects early reversal patterns:
   * - Divergence between price and signal strength
   * - Key level rejections
   * - Volume spikes against signal direction
   * - Momentum shifts
   */
  detectReversal(signal, marketData) {
    const warnings = [];
    
    // Price-signal divergence

    if (signal.direction === 'LONG' && marketData.priceDirection === 'bearish') {
      warnings.push({
        type: 'PRICE_DIVERGENCE',
        severity: 'HIGH',
        message: 'Price moving against LONG signal direction',
      });
    } else if (signal.direction === 'SHORT' && marketData.priceDirection === 'bullish') {
      warnings.push({
        type: 'PRICE_DIVERGENCE',
        severity: 'HIGH',
        message: 'Price moving against SHORT signal direction',
      });
    }
    
    // Volume spike against direction
    if (marketData.volumeSpike) {
      const volumeDirection = marketData.volumeDirection;
      if ((signal.direction === 'LONG' && volumeDirection === 'selling') ||
          (signal.direction === 'SHORT' && volumeDirection === 'buying')) {
        warnings.push({
          type: 'VOLUME_REVERSAL',
          severity: 'HIGH',
          message: 'High volume against signal direction',
        });
      }
    }
    
    // Key level rejection
    if (marketData.rejectionLevel) {
      warnings.push({
        type: 'LEVEL_REJECTION',
        severity: 'MEDIUM',
        message: `Price rejected at key level: ${marketData.rejectionLevel}`,
      });
    }
    
    // Momentum shift
    if (marketData.momentumShift) {
      warnings.push({
        type: 'MOMENTUM_SHIFT',
        severity: 'MEDIUM',
        message: `Momentum shifted to ${marketData.momentumShift}`,
      });
    }
    
    // Calculate overall reversal risk
    const highSeverityCount = warnings.filter(w => w.severity === 'HIGH').length;
    const reversalRisk = highSeverityCount >= 2 ? 'CRITICAL' 
                        : highSeverityCount === 1 ? 'HIGH' 
                        : warnings.length > 0 ? 'MEDIUM' 
                        : 'LOW';
    
    return {
      reversalRisk,
      warnings,
      timestamp: Date.now(),
    };
  }

  detectPatternReversal(symbol, patternData) {
    // Detect pattern-specific reversals (e.g., failed patterns)
    const warnings = [];
    
    if (patternData.type === 'HEAD_AND_SHOULDERS' && patternData.status === 'FAILED') {
      warnings.push({
        type: 'PATTERN_FAILURE',
        severity: 'HIGH',
        message: 'Head & Shoulders pattern failed',
      });
    }
    
    if (patternData.type === 'DOUBLE_TOP' && patternData.breakout === 'FALSE') {
      warnings.push({
        type: 'PATTERN_FAILURE',
        severity: 'MEDIUM',
        message: 'Double Top failed to break down',
      });
    }
    
    return warnings;
  }
}

// ─────────────────────────────────────────────
//  SIGNAL LIFECYCLE MANAGER
// ─────────────────────────────────────────────

class SignalLifecycleManager {
  constructor() {
    this.tracker = new SignalStateTracker();
    this.reversalDetector = new ReversalDetector();
    this.strengthCalculator = SignalStrengthCalculator;
  }

  /**
   * Signal lifecycle:
   * 1. CREATED - Initial signal generated
   * 2. ACTIVE - Signal is being monitored
   * 3. WEAKENING - Signal strength declining
   * 4. REVERSAL_RISK - High probability of reversal
   * 5. RECOVERING - Signal regaining strength
   * 6. FAILED - Signal no longer valid
   * 7. TERMINATED - Signal manually closed or expired
   */
  createSignal(signalId, signal, metadata = {}) {
    this.tracker.createSignal(signalId, signal.score || 75, {
      ...metadata,
      direction: signal.direction,
      symbol: signal.symbol,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
    });
    
    return {
      signalId,
      status: 'CREATED',
      initialScore: signal.score || 75,
    };
  }

  updateSignal(signalId, marketData) {
    const signal = this.tracker.getSignal(signalId);
    if (!signal) return null;

    const timeElapsed = Date.now() - signal.timestamp;
    const newStrength = this.strengthCalculator.calculate(
      { score: signal.initialScore, direction: signal.metadata.direction },
      marketData,
      timeElapsed
    );

    const update = this.tracker.updateSignal(signalId, newStrength, { marketData });
    
    // Check for reversal patterns
    const reversalAnalysis = this.reversalDetector.detectReversal(
      { direction: signal.metadata.direction },
      marketData
    );

    return {
      ...update,
      reversalAnalysis,
    };
  }

  getSignalStatus(signalId) {
    const signal = this.tracker.getSignal(signalId);
    if (!signal) return null;

    return {
      signalId,
      status: signal.status,
      currentScore: signal.currentScore,
      initialScore: signal.initialScore,
      scoreChange: round(signal.currentScore - signal.initialScore),
      alerts: signal.alerts,
      history: signal.history,
      metadata: signal.metadata,
      age: Date.now() - signal.timestamp,
    };
  }

  getAllActiveSignals() {
    return this.tracker.getSignalsByStatus('ACTIVE')
      .concat(this.tracker.getSignalsByStatus('WEAKENING'))
      .concat(this.tracker.getSignalsByStatus('RECOVERING'));
  }

  getCriticalSignals() {
    return this.tracker.getSignalsByStatus('REVERSAL_RISK')
      .concat(this.tracker.getSignalsByStatus('FAILED'));
  }

  terminateSignal(signalId, reason) {
    return this.tracker.terminateSignal(signalId, reason);
  }
}

// ─────────────────────────────────────────────
//  MAIN SIGNAL MONITOR CLASS
// ─────────────────────────────────────────────

class SignalMonitor extends EventEmitter {
  constructor(config = {}) {
    super();

    this.lifecycleManager = new SignalLifecycleManager();
    this.checkIntervalMs = config.checkIntervalMs || 60000; // 1 minute
    this._checkTimer = null;
    this._connected = false;

    this._stats = {
      signalsCreated: 0,
      signalsUpdated: 0,
      weakeningAlerts: 0,
      reversalAlerts: 0,
      signalsTerminated: 0,
      startTime: null,
    };
  }

  async connect() {
    console.log('[SignalMonitor] Starting...');
    this._stats.startTime = Date.now();
    this._connected = true;

    this._checkTimer = setInterval(() => this._checkAllSignals(), this.checkIntervalMs);
    
    this.emit('ready');
    console.log('[SignalMonitor] Connected successfully');
  }

  async _checkAllSignals() {
    if (!this._connected) return;

    const activeSignals = this.lifecycleManager.getAllActiveSignals();
    
    for (const signal of activeSignals) {
      // Market data would be fetched here from the data feed
      // For now, we emit an event that should be handled by the caller
      this.emit('check_signal', { signalId: signal.signalId });
    }
  }

  createSignal(signalId, signal, metadata = {}) {
    const result = this.lifecycleManager.createSignal(signalId, signal, metadata);
    this._stats.signalsCreated++;
    
    this.emit('signal_created', { signalId, ...result });
    
    return result;
  }

  updateSignal(signalId, marketData) {
    const result = this.lifecycleManager.updateSignal(signalId, marketData);
    if (!result) return null;

    this._stats.signalsUpdated++;

    if (result.alert) {
      if (result.alert.type === 'WEAKENING') {
        this._stats.weakeningAlerts++;
        this.emit('signal_weakening', { signalId, alert: result.alert });
      } else if (result.alert.type === 'REVERSAL_RISK') {
        this._stats.reversalAlerts++;
        this.emit('reversal_risk', { signalId, alert: result.alert });
      } else if (result.alert.type === 'SIGNAL_FAILED') {
        this.emit('signal_failed', { signalId, alert: result.alert });
      } else if (result.alert.type === 'STRENGTHENING') {
        this.emit('signal_strengthening', { signalId, alert: result.alert });
      }
    }

    if (result.reversalAnalysis && result.reversalAnalysis.reversalRisk !== 'LOW') {
      this.emit('reversal_detected', {
        signalId,
        analysis: result.reversalAnalysis,
      });
    }

    return result;
  }

  getSignalStatus(signalId) {
    return this.lifecycleManager.getSignalStatus(signalId);
  }

  getAllSignals() {
    return this.lifecycleManager.tracker.getAllSignals();
  }

  getActiveSignals() {
    return this.lifecycleManager.getAllActiveSignals();
  }

  getCriticalSignals() {
    return this.lifecycleManager.getCriticalSignals();
  }

  terminateSignal(signalId, reason = 'MANUAL') {
    const result = this.lifecycleManager.terminateSignal(signalId, reason);
    if (result) {
      this._stats.signalsTerminated++;
      this.emit('signal_terminated', { signalId, reason });
    }
    return result;
  }

  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return {
      ...this._stats,
      uptime,
      connected: this._connected,
      activeSignals: this.getActiveSignals().length,
      criticalSignals: this.getCriticalSignals().length,
    };
  }

  disconnect() {
    console.log('[SignalMonitor] Disconnecting...');
    if (this._checkTimer) clearInterval(this._checkTimer);
    this._connected = false;
    this.emit('closed');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  SignalMonitor,
  SignalLifecycleManager,
  SignalStateTracker,
  SignalStrengthCalculator,
  ReversalDetector,
  SIGNAL_STRENGTH_THRESHOLDS,
};
