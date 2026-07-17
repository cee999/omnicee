'use strict';

/**
 * OpportunityRanker
 * ------------------
 * The signal pipeline only ever surfaced a symbol once it cleared every gate
 * and actually fired — everything that scored below threshold, or got
 * blocked by conflict resolution / session filter / drawdown guard, was
 * silently discarded every cycle. That's fine for alerting, but it means
 * there was no way to answer "what's close to setting up right now?" across
 * the whole watchlist without reading logs.
 *
 * This module is a lightweight in-memory scoreboard: every symbol's most
 * recent evaluation (fired or not) gets recorded here, and getRanked()
 * returns them sorted by opportunity quality. No new data feeds required —
 * it's fed directly from the same scorer.score() call the pipeline already
 * makes each cycle.
 */
class OpportunityRanker {
  constructor({ staleAfterMs = 15 * 60 * 1000 } = {}) {
    this.staleAfterMs = staleAfterMs;
    this._entries = new Map(); // symbol -> latest entry
  }

  /**
   * Record the latest evaluation for a symbol. Call this every cycle,
   * regardless of whether the signal ultimately fired or was blocked.
   */
  update(symbol, {
    action = 'WAIT',
    score = 0,
    grade = null,
    regime = null,
    tradeability = null,
    session = null,
    fired = false,
    blockedReason = null,
    price = null,
    timestamp = Date.now(),
  } = {}) {
    if (!symbol) return;
    this._entries.set(symbol, {
      symbol, action, score, grade, regime, tradeability,
      session, fired, blockedReason, price, timestamp,
    });
  }

  /**
   * Ranked, non-stale opportunities — highest score first.
   * @param {Object} opts
   * @param {number} [opts.limit]
   * @param {boolean} [opts.includeStale] - include entries older than staleAfterMs
   */
  getRanked({ limit = null, includeStale = false } = {}) {
    const now = Date.now();
    let list = [...this._entries.values()].map(e => ({
      ...e,
      ageMs: now - e.timestamp,
      stale: (now - e.timestamp) > this.staleAfterMs,
    }));

    if (!includeStale) list = list.filter(e => !e.stale);

    list.sort((a, b) => (b.score || 0) - (a.score || 0));

    return typeof limit === 'number' ? list.slice(0, limit) : list;
  }

  /** Single symbol's latest entry, or null. */
  get(symbol) {
    return this._entries.get(symbol) || null;
  }

  /** Drop entries for symbols no longer being tracked. */
  prune(activeSymbols = []) {
    const active = new Set(activeSymbols);
    for (const sym of this._entries.keys()) {
      if (!active.has(sym)) this._entries.delete(sym);
    }
  }
}

module.exports = { OpportunityRanker };
