// AUDIT TRAIL AI Trading Assistant · Layer 6 · Observability Extracted from orchestrator/task-planner.js (found orphaned — never required anywhere — during a full dependency-graph audit).

'use strict';

const MAX_AUDIT_ENTRIES = 500;

class AuditTrail {
  constructor() {
    this._entries = [];
  }

  record(entry) {
    this._entries.push({
      ...entry,
      recordedAt: Date.now(),
    });
    if (this._entries.length > MAX_AUDIT_ENTRIES) {
      this._entries.shift();
    }
  }

  getRecent(n = 20) {
    return this._entries.slice(-n).reverse();
  }

  getBySymbol(symbol, n = 10) {
    return this._entries
      .filter(e => e.symbol === symbol)
      .slice(-n)
      .reverse();
  }

  getSignalFired() {
    return this._entries.filter(e => e.signalFired);
  }

  size() { return this._entries.length; }
}

module.exports = { AuditTrail };
