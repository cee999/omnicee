'use strict';

/**
 * MarketOutlookBuilder
 * ─────────────────────────────────────────────
 * Aggregates real, already-live data sources into a single daily/weekly
 * market outlook: no invented numbers, no filler — every field here is
 * either read directly from a real feed/engine or omitted if unavailable.
 *
 *  - Economic calendar: risk-engine/session-filter.js's EconomicCalendarTierSystem,
 *    now fed real events by FinnhubFeed (see index.js).
 *  - Regime per symbol: signal-pipeline/regime-engine.js, run against each
 *    symbol's live candle cache.
 *  - Session quality per symbol: risk-engine/session-filter.js's full check()
 *    (killzone/liquidity/holiday/rollover/news-blackout).
 *  - Funding/OI extremes: read from the last known Bybit funding/OI snapshot
 *    if the caller supplies one (crypto symbols only).
 */
class MarketOutlookBuilder {
  /**
   * @param {object} opts
   * @param {string[]} opts.symbols
   * @param {object} opts.candleStores - candleStores[symbol][timeframe] -> candle[]
   * @param {object} opts.regimeEngine - has .classify(candles)
   * @param {object} opts.sessionFilter - has .check(symbol, timestamp) [assetClass is inferred internally] and .calendar
   * @param {string} opts.timeframe - which timeframe's candles to classify regime on
   * @param {Map|object} [opts.fundingSnapshots] - symbol -> { fundingRate, oiChangePct } (optional)
   */
  static build({ symbols = [], candleStores = {}, regimeEngine, sessionFilter, timeframe = 'H1', fundingSnapshots = null }) {
    const now = Date.now();

    const calendar = sessionFilter?.calendar || null;
    const today = calendar ? calendar.getUpcoming(24) : [];
    const week  = calendar ? calendar.getUpcoming(24 * 7) : [];
    const tier1Today = today.filter(e => e.tier === 'TIER_1');
    const tier1Week  = week.filter(e => e.tier === 'TIER_1');
    const tier2Week  = week.filter(e => e.tier === 'TIER_2');

    const perSymbol = [];
    for (const symbol of symbols) {
      const candles = candleStores?.[symbol]?.[timeframe];
      const entry = { symbol };

      if (candles && candles.length >= 50 && regimeEngine?.classify) {
        try {
          const regime = regimeEngine.classify(candles);
          entry.regime = regime.regime;
          entry.tradeability = regime.tradeability;
          entry.reasons = regime.reasons?.slice(0, 2) || [];
        } catch (_) { /* leave regime fields absent if classification fails */ }
      }

      if (sessionFilter?.check) {
        try {
          const sq = sessionFilter.check(symbol, now);
          entry.sessionStatus = sq.allowed ? 'CLEAR' : (sq.reason || 'RESTRICTED');
          entry.sessionMultiplier = sq.multiplier ?? null;
          if (sq.reason) entry.sessionReason = sq.reason;
        } catch (_) { /* leave session fields absent */ }
      }

      const funding = fundingSnapshots?.get ? fundingSnapshots.get(symbol) : fundingSnapshots?.[symbol];
      if (funding) {
        entry.fundingRate = funding.fundingRate ?? null;
        entry.oiChangePct = funding.oiChangePct ?? null;
      }

      perSymbol.push(entry);
    }

    return {
      generatedAt: now,
      today: {
        tier1Events: tier1Today.map(MarketOutlookBuilder._formatEvent),
        eventCount: today.length,
      },
      week: {
        tier1Events: tier1Week.map(MarketOutlookBuilder._formatEvent),
        tier2Events: tier2Week.map(MarketOutlookBuilder._formatEvent),
        eventCount: week.length,
      },
      symbols: perSymbol,
      narrative: MarketOutlookBuilder._narrative({ tier1Today, tier1Week, tier2Week, perSymbol }),
    };
  }

  static _formatEvent(e) {
    return {
      name: e.name,
      currency: e.currency,
      time: e.time,
      hoursAway: e.hoursAway,
      tier: e.tier,
    };
  }

  static _narrative({ tier1Today, tier1Week, tier2Week, perSymbol }) {
    const lines = [];

    if (tier1Today.length > 0) {
      const names = tier1Today.map(e => `${e.name} (${e.currency}, ${e.hoursAway.toFixed(1)}h)`).join(', ');
      lines.push(`Today has ${tier1Today.length} market-moving release${tier1Today.length > 1 ? 's' : ''}: ${names}. Expect size reductions or blackouts around these windows.`);
    } else {
      lines.push('No Tier-1 economic releases scheduled today.');
    }

    if (tier1Week.length > 0 || tier2Week.length > 0) {
      lines.push(`This week: ${tier1Week.length} Tier-1 and ${tier2Week.length} Tier-2 release${(tier1Week.length + tier2Week.length) === 1 ? '' : 's'} ahead.`);
    }

    const tradeable = perSymbol.filter(s => s.tradeability != null).sort((a, b) => (b.tradeability || 0) - (a.tradeability || 0));
    if (tradeable.length > 0) {
      const best = tradeable[0];
      const worst = tradeable[tradeable.length - 1];
      lines.push(`${best.symbol} shows the strongest regime right now (${best.regime}, tradeability ${best.tradeability}).`);
      if (worst.symbol !== best.symbol && worst.tradeability < 40) {
        lines.push(`${worst.symbol} looks choppiest (${worst.regime}, tradeability ${worst.tradeability}) — reduced conviction expected there.`);
      }
    }

    const blocked = perSymbol.filter(s => s.sessionStatus && s.sessionStatus !== 'CLEAR');
    if (blocked.length > 0) {
      lines.push(`Session gate is currently restricting: ${blocked.map(s => `${s.symbol} (${s.sessionStatus})`).join(', ')}.`);
    }

    return lines.join(' ');
  }
}

module.exports = { MarketOutlookBuilder };
