/**
 * ============================================================
 *  AUDIT TRAIL
 *  AI Trading Assistant · Layer 6 · Observability
 * ============================================================
 *
 *  Extracted from orchestrator/task-planner.js (found orphaned — never
 *  required anywhere — during a full dependency-graph audit). Logic is
 *  unchanged from the original; this just gives it a live home.
 *
 *  A bounded, in-memory record of every analysis cycle result — not just
 *  the ones that fired a signal. Before this, index.js's own memory/Mongo
 *  saves only ever ran on signals that actually cleared every gate and
 *  dispatched (see the SKIP/blocked branches throughout runAnalysisCycle),
 *  so there was no lightweight way to answer "what did the pipeline
 *  decide about symbol X in the last hour, fired or not" without digging
 *  through logs.
 *
 *  Usage:
 *    const { AuditTrail } = require('./audit-trail');
 *    const auditTrail = new AuditTrail();
 *    auditTrail.record({ symbol, timeframe, signalFired: false, blockedReason: 'below min score', score });
 *    auditTrail.getBySymbol('BTCUSDT', 10);
 * ============================================================
 */

'use strict';

const MAX_AUDIT_ENTRIES = 500;

class AuditTrail {
  constructor() {
    this._entries = [];
  }

  /** Record a complete analysis cycle result. */
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
