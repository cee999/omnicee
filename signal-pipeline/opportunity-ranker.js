'use strict';

class OpportunityRanker {
  constructor({ staleAfterMs = 15 * 60 * 1000 } = {}) {
    this.staleAfterMs = staleAfterMs;
    this._entries = new Map();
  }

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

  get(symbol) {
    return this._entries.get(symbol) || null;
  }

  prune(activeSymbols = []) {
    const active = new Set(activeSymbols);
    for (const sym of this._entries.keys()) {
      if (!active.has(sym)) this._entries.delete(sym);
    }
  }
}

module.exports = { OpportunityRanker };
