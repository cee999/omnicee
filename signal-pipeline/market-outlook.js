'use strict';

/**
 * MarketOutlookBuilder
 * ─────────────────────────────────────────────
 * Aggregates real, already-live data sources into a single daily/weekly/
 * two-week market outlook: no invented numbers, no filler — every field
 * here is either read directly from a real feed/engine or omitted if
 * unavailable.
 *
 *  - Economic calendar: risk-engine/session-filter.js's EconomicCalendarTierSystem,
 *    now fed real events by FinnhubFeed (see index.js). Split into today,
 *    this week (0-7 days out), and next week (7-14 days out).
 *  - Institutional positioning: feeds/cot-report-parser.js's COTReportParser, fed
 *    real weekly CFTC Commitment of Traders data by feeds/cftc-cot-feed.js.
 *    This is the honest, real answer to "what are hedge funds/corporations
 *    actually doing" — CFTC's own regulatory data on commercial (hedgers/
 *    corporates) vs. large speculator (hedge fund) futures positioning. It
 *    is NOT a prediction and updates once a week (Fridays); treat it as
 *    real context on institutional positioning, not a signal to blindly
 *    copy — extreme positioning is informative but can stay extreme for
 *    a long time before it reverses.
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
   * @param {object} [opts.cotParser] - feeds/cot-report-parser.js's COTReportParser instance, has .analyze(symbol)
   */
  static build({ symbols = [], candleStores = {}, regimeEngine, sessionFilter, timeframe = 'H1', fundingSnapshots = null, cotParser = null }) {
    const now = Date.now();

    const calendar = sessionFilter?.calendar || null;
    const today    = calendar ? calendar.getUpcoming(24) : [];
    const twoWeeks = calendar ? calendar.getUpcoming(24 * 14) : [];
    const week     = twoWeeks.filter(e => e.hoursAway <= 24 * 7);
    const nextWeek = twoWeeks.filter(e => e.hoursAway > 24 * 7);
    const tier1Today    = today.filter(e => e.tier === 'TIER_1');
    const tier1Week     = week.filter(e => e.tier === 'TIER_1');
    const tier2Week     = week.filter(e => e.tier === 'TIER_2');
    const tier1NextWeek = nextWeek.filter(e => e.tier === 'TIER_1');
    const tier2NextWeek = nextWeek.filter(e => e.tier === 'TIER_2');

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

      if (cotParser?.analyze) {
        try {
          const cot = cotParser.analyze(symbol);
          if (cot) {
            entry.institutionalPositioning = {
              date: cot.date,
              commercialNet: cot.commercial.net,
              largeSpecNet: cot.largeSpec.net,
              weekOverWeekChange: cot.weekOverWeekChange,
              largeSpecPercentile: cot.largeSpecPercentile,
              isExtreme: cot.isExtreme,
              signal: cot.signal,
              note: cot.note,
            };
          }
        } catch (_) { /* no COT data for this symbol/contract — leave absent */ }
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
      nextWeek: {
        tier1Events: tier1NextWeek.map(MarketOutlookBuilder._formatEvent),
        tier2Events: tier2NextWeek.map(MarketOutlookBuilder._formatEvent),
        eventCount: nextWeek.length,
      },
      symbols: perSymbol,
      narrative: MarketOutlookBuilder._narrative({ tier1Today, tier1Week, tier2Week, tier1NextWeek, tier2NextWeek, perSymbol }),
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

  static _narrative({ tier1Today, tier1Week, tier2Week, tier1NextWeek, tier2NextWeek, perSymbol }) {
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

    if (tier1NextWeek.length > 0 || tier2NextWeek.length > 0) {
      const names = tier1NextWeek.slice(0, 3).map(e => `${e.name} (${e.currency})`).join(', ');
      lines.push(`Next week: ${tier1NextWeek.length} Tier-1 and ${tier2NextWeek.length} Tier-2 release${(tier1NextWeek.length + tier2NextWeek.length) === 1 ? '' : 's'} on the calendar${names ? ` — ${names}` : ''}. Positions held into next week should account for these.`);
    } else {
      lines.push('Calendar is quiet for the week after next — nothing Tier-1/2 flagged yet, though the calendar does get updated as new events are confirmed.');
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

    // Real institutional positioning (CFTC Commitment of Traders) — this is
    // the honest answer to "what are hedge funds/corporations doing", not a
    // prediction. Only surfaced when a symbol's positioning is actually at
    // a historical extreme, since normal-range positioning isn't news.
    const extremePositioning = perSymbol.filter(s => s.institutionalPositioning?.isExtreme);
    if (extremePositioning.length > 0) {
      for (const s of extremePositioning) {
        const p = s.institutionalPositioning;
        lines.push(`${s.symbol}: large speculators (hedge funds) are at the ${Math.round(p.largeSpecPercentile)}th percentile of 3-year positioning as of ${p.date} — ${p.note}.`);
      }
    }

    return lines.join(' ');
  }
}

module.exports = { MarketOutlookBuilder };
