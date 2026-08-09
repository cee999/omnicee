'use strict';

class MarketOutlookBuilder {
  static build({ symbols = [], candleStores = {}, regimeEngine, sessionFilter, timeframe = 'H1', fundingSnapshots = null, cotParser = null }) {
    const now = Date.now();

    const perSymbol = [];
    const tfOrder = [timeframe, 'H1', 'H4', 'M15', 'M5', 'D1'].filter((v, i, a) => v && a.indexOf(v) === i);

    for (const symbol of symbols) {
      const entry = { symbol };
      let candles = null;
      let usedTf = null;
      for (const tf of tfOrder) {
        const arr = candleStores?.[symbol]?.[tf];
        if (arr && arr.length >= 40) {
          candles = arr;
          usedTf = tf;
          break;
        }
      }
      const allCounts = {};
      for (const tf of tfOrder) {
        const n = candleStores?.[symbol]?.[tf]?.length || 0;
        if (n) allCounts[tf] = n;
      }
      entry.candleCount = candles?.length || 0;
      entry.regimeTimeframe = usedTf;
      entry.candleCounts = allCounts;

      if (candles && candles.length >= 40 && regimeEngine?.classify) {
        try {
          const regime = regimeEngine.classify(candles);
          entry.regime = regime.regime || regime.state || 'UNKNOWN';
          entry.tradeability = regime.tradeability ?? regime.score ?? null;
          entry.reasons = regime.reasons?.slice(0, 2) || [];
        } catch (_) { }
      } else {
        entry.regime = entry.regime || null;
        entry.dataNote = Object.keys(allCounts).length
          ? `Need ≥40 bars (have ${JSON.stringify(allCounts)})`
          : 'No OHLC candles yet — attach MT5 EA or set TWELVE_DATA_API_KEY';
      }

      if (sessionFilter?.check) {
        try {
          const sq = sessionFilter.check(symbol, now);
          entry.sessionStatus = sq.allowed ? 'CLEAR' : (sq.reason || 'RESTRICTED');
          entry.sessionMultiplier = sq.multiplier ?? null;
          if (sq.reason) entry.sessionReason = sq.reason;
        } catch (_) { }
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
        } catch (_) { }
      }

      perSymbol.push(entry);
    }

    return {
      generatedAt: now,
      symbols: perSymbol,
      narrative: MarketOutlookBuilder._narrative({ tier1Today: [], tier1Week: [], tier2Week: [], tier1NextWeek: [], tier2NextWeek: [], perSymbol }),
      note: 'Outlook = regime + session stance per symbol. Calendar is on the Calendar API / News desk only.',
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
    const utcHour = new Date().getUTCHours();
    let sessionName = 'Off-hours';
    if (utcHour >= 0 && utcHour < 8) sessionName = 'Asia';
    else if (utcHour >= 8 && utcHour < 13) sessionName = 'London';
    else if (utcHour >= 13 && utcHour < 21) sessionName = 'New York / London overlap→NY';
    else sessionName = 'Late NY / thin liquidity';
    lines.push(`Session context: ${sessionName} (${String(utcHour).padStart(2, '0')}:00 UTC).`);

    if (tier1Today.length > 0) {
      const names = tier1Today.map(e => `${e.name} (${e.currency}, ${e.hoursAway.toFixed(1)}h)`).join(', ');
      lines.push(`Tier-1 today: ${names}. Expect size cuts or blackouts into those windows.`);
    }
    const weekEvents = tier1Week.length + tier2Week.length;
    if (weekEvents > 0) {
      lines.push(`This week: ${tier1Week.length} Tier-1, ${tier2Week.length} Tier-2 on the calendar.`);
    }

    const withRegime = perSymbol.filter(s => s.regime && s.regime !== 'UNKNOWN');
    const blocked = perSymbol.filter(s => s.sessionStatus && s.sessionStatus !== 'CLEAR');
    const noData = perSymbol.filter(s => !s.regime || s.dataNote);

    if (withRegime.length > 0) {
      const ranked = [...withRegime].sort((a, b) => (Number(b.tradeability) || 0) - (Number(a.tradeability) || 0));
      const bits = ranked.map(s => {
        const tb = s.tradeability != null ? `, tradeability ${Math.round(Number(s.tradeability))}` : '';
        return `${s.symbol}=${s.regime}${tb}`;
      });
      lines.push(`Regimes: ${bits.join(' · ')}.`);
    }

    if (blocked.length > 0) {
      lines.push(`Session gate blocking signals: ${blocked.map(s => `${s.symbol} (${s.sessionReason || s.sessionStatus})`).join('; ')}.`);
    }

    if (noData.length > 0 && withRegime.length < perSymbol.length) {
      lines.push(
        `Awaiting OHLC for regime on: ${noData.map(s => s.symbol).join(', ')} ` +
        `(need ≥40 bars from MT5 EA or Twelve Data — ticker price alone is not enough).`
      );
    }

    const extremePositioning = perSymbol.filter(s => s.institutionalPositioning?.isExtreme);
    if (extremePositioning.length > 0) {
      for (const s of extremePositioning) {
        const p = s.institutionalPositioning;
        lines.push(`${s.symbol} COT extreme: large speculators (hedge funds) ${Math.round(p.largeSpecPercentile)}th percentile (${p.date}) — ${p.note}.`);
      }
    }

    if (blocked.length === perSymbol.length && perSymbol.length > 0) {
      lines.push('Bottom line: all tracked symbols are session-restricted right now — signal pipeline will not fire new FX setups until the gate clears.');
    } else if (withRegime.length > 0) {
      const best = [...withRegime].sort((a, b) => (Number(b.tradeability) || 0) - (Number(a.tradeability) || 0))[0];
      lines.push(`Bottom line: focus watchlist on ${best.symbol} (${best.regime}); treat low-tradeability or gated symbols as stand-aside.`);
    } else {
      lines.push('Bottom line: no regime scores yet — system is in price-ticker mode only. Attach MT5 EA or enable Twelve Data for analysis-grade candles.');
    }

    return lines.join(' ');
  }
}

module.exports = { MarketOutlookBuilder };
