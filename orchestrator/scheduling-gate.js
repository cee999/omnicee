// never require()'d or loadModule()'d anywhere — index.js implements its own inline per-symbol pipeline instead). Most of task-planner.js's design (persistent agent processes with self-healing...

'use strict';

class MarketHoursGate {
  static shouldAnalyze(timeframe, timestampMs) {
    const d       = new Date(timestampMs || Date.now());
    const utcHour = d.getUTCHours();
    const utcDay  = d.getUTCDay();

    if ((utcDay === 0 || utcDay === 6) && ['M1', 'M5', 'M15'].includes(timeframe)) {
      return false;
    }

    if (utcDay === 0 && utcHour >= 21) return false;

    return true;
  }

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
    this._metadata  = new Map();
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

  unblacklist(symbol) {
    this._blacklist.delete(symbol);
  }

  getPriority() { return this._priority; }

  getMetadata(symbol) {
    return this._metadata.get(symbol) || {};
  }

  getAll() { return [...this._whitelist]; }
}

module.exports = { MarketHoursGate, SymbolManager };
