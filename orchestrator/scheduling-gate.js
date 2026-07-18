/**
 * ============================================================
 *  MARKET HOURS GATE + SYMBOL MANAGER
 *  AI Trading Assistant · Layer 2 · Scheduling / Symbol Control
 * ============================================================
 *
 *  Extracted from orchestrator/task-planner.js, which was found during a
 *  full dependency-graph audit to be entirely orphaned (never require()'d
 *  or loadModule()'d anywhere — index.js implements its own inline
 *  per-symbol pipeline instead). Most of task-planner.js's design
 *  (persistent agent processes with self-healing restarts) doesn't map
 *  onto that stateless-per-cycle architecture and shouldn't be forced in.
 *  These two pieces, however, are genuinely useful and had no equivalent
 *  anywhere in the live codebase — extracted as-is (logic unchanged) into
 *  their own module rather than resurrecting the whole orphaned file.
 *
 *  MarketHoursGate — should analysis even run right now? Skips M1/M5/M15
 *  scans on weekends (nothing meaningful moves) and the Sunday-evening
 *  dead zone around market open, and gives a session-quality multiplier
 *  (London/NY overlap = best liquidity, Asia/dead-zone = worst) usable as
 *  a soft signal-confidence adjustment.
 *
 *  SymbolManager — a whitelist/blacklist gate. If a symbol misbehaves
 *  (bad feed data, repeated abnormal-market flags, whatever the operator
 *  decides), blacklisting it here stops new analysis cycles from running
 *  on it without having to touch the rest of the pipeline config.
 *
 *  Usage:
 *    const { MarketHoursGate, SymbolManager } = require('./scheduling-gate');
 *    if (!MarketHoursGate.shouldAnalyze(timeframe)) return; // skip this cycle
 *    if (!symbolManager.isAllowed(symbol)) return;
 * ============================================================
 */

'use strict';

class MarketHoursGate {
  /**
   * Returns true if market analysis should proceed based on UTC hour.
   * Skips analysis during true dead hours (21:00–23:59 UTC Sunday, the
   * gap before Monday's open) and skips M1/M5/M15 scans on weekends,
   * where nothing meaningful moves for symbols that actually close.
   */
  static shouldAnalyze(timeframe, timestampMs) {
    const d       = new Date(timestampMs || Date.now());
    const utcHour = d.getUTCHours();
    const utcDay  = d.getUTCDay(); // 0=Sun, 6=Sat

    // Skip M1/M5/M15 analysis on weekends
    if ((utcDay === 0 || utcDay === 6) && ['M1', 'M5', 'M15'].includes(timeframe)) {
      return false;
    }

    // True dead zone: Sunday 21:00-23:59 (market-open gap)
    if (utcDay === 0 && utcHour >= 21) return false;

    // Allow all other times — crypto runs 24/7, forex 5 days
    return true;
  }

  /**
   * Returns a quality multiplier + label for the current UTC time, based
   * on which session is active. Meant as a soft input (e.g. into
   * StrategySelector or the scorer), not a hard gate.
   */
  static getQuality(timestampMs) {
    const d       = new Date(timestampMs || Date.now());
    const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;

    if (utcHour >= 13 && utcHour < 16) return { quality: 1.1, label: 'London/NY Overlap' };
    if (utcHour >= 8  && utcHour < 13) return { quality: 1.0, label: 'London' };
    if (utcHour >= 16 && utcHour < 21) return { quality: 0.95, label: 'New York' };
    if (utcHour >= 0  && utcHour < 8)  return { quality: 0.80, label: 'Asia' };
    return { quality: 0.5, label: 'Dead Zone' };
  }
}

class SymbolManager {
  constructor(config = {}) {
    this._whitelist = new Set(config.symbols    || []);
    this._blacklist = new Set(config.blacklist  || []);
    this._priority  = config.priority           || [];
    this._metadata  = new Map(); // symbol -> { type, exchange, pipSize }
  }

  isAllowed(symbol) {
    if (this._blacklist.has(symbol)) return false;
    if (this._whitelist.size > 0) return this._whitelist.has(symbol);
    return true;
  }

  addSymbol(symbol, metadata = {}) {
    this._whitelist.add(symbol);
    this._metadata.set(symbol, metadata);
  }

  removeSymbol(symbol) {
    this._whitelist.delete(symbol);
    this._blacklist.add(symbol);
  }

  blacklist(symbol) {
    this._blacklist.add(symbol);
  }

  getPriority() { return this._priority; }

  getMetadata(symbol) {
    return this._metadata.get(symbol) || {};
  }

  getAll() { return [...this._whitelist]; }
}

module.exports = { MarketHoursGate, SymbolManager };
