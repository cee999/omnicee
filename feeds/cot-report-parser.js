'use strict';

/**
 * ============================================================
 *  COT REPORT PARSER
 *  File: feeds/cot-report-parser.js
 * ============================================================
 *
 * Extracted from feeds/news-feed.js, which originally bundled this
 * alongside six other classes (NewsFeed, NewsIngestionEngine,
 * SentimentLexicon, ClaudeNLPAnalyzer, CentralBankToneTracker,
 * FearGreedEngine) — all of which turned out to be dead code, never
 * imported anywhere outside that file. Real news/sentiment for the live
 * signal pipeline flows through feeds/finnhub-feed.js -> agents/
 * sentiment-agent.js instead; this was leftover from an earlier
 * architecture. COTReportParser was the one piece actually in use
 * (see index.js's loadModule('./feeds/news-feed', 'COTReportParser')),
 * so it's kept here on its own rather than deleted with the rest.
 */

class COTReportParser {
  /**
   * Parses CFTC Commitment of Traders report data (legacy futures-only
   * format). CFTC publishes weekly (Fridays, for Tuesday's data).
   *
   * Categories:
   *   - Commercial (hedgers / "smart money") — net position often
   *     contrarian to retail at extremes
   *   - Non-commercial (large speculators / "smart money momentum")
   *   - Non-reportable (small speculators / "dumb money", often wrong
   *     at extremes)
   */
  constructor() {
    this._reports = new Map(); // symbol → [{ date, commercial, largeSpec, smallSpec }]
  }

  /**
   * Ingest a raw COT report row (format matches CFTC's standard CSV/API fields)
   */
  ingest(symbol, reportData) {
    const parsed = {
      date: reportData.report_date || reportData.date,
      commercialLong:  parseFloat(reportData.comm_positions_long_all ?? reportData.commercialLong ?? 0),
      commercialShort: parseFloat(reportData.comm_positions_short_all ?? reportData.commercialShort ?? 0),
      largeSpecLong:   parseFloat(reportData.noncomm_positions_long_all ?? reportData.largeSpecLong ?? 0),
      largeSpecShort:  parseFloat(reportData.noncomm_positions_short_all ?? reportData.largeSpecShort ?? 0),
      smallSpecLong:   parseFloat(reportData.nonrept_positions_long_all ?? reportData.smallSpecLong ?? 0),
      smallSpecShort:  parseFloat(reportData.nonrept_positions_short_all ?? reportData.smallSpecShort ?? 0),
      openInterest:    parseFloat(reportData.open_interest_all ?? reportData.openInterest ?? 0),
    };

    parsed.commercialNet = parsed.commercialLong - parsed.commercialShort;
    parsed.largeSpecNet  = parsed.largeSpecLong - parsed.largeSpecShort;
    parsed.smallSpecNet  = parsed.smallSpecLong - parsed.smallSpecShort;

    if (!this._reports.has(symbol)) this._reports.set(symbol, []);
    const hist = this._reports.get(symbol);
    hist.push(parsed);
    if (hist.length > 156) hist.shift(); // ~3 years of weekly data

    return this.analyze(symbol);
  }

  /**
   * Full analysis: current positioning, week-over-week change,
   * percentile extremity, and trading signal.
   */
  analyze(symbol) {
    const hist = this._reports.get(symbol);
    if (!hist || hist.length === 0) return null;

    const latest = hist[hist.length - 1];
    const previous = hist[hist.length - 2];

    const wowChange = previous ? {
      commercial: round(latest.commercialNet - previous.commercialNet, 0),
      largeSpec:  round(latest.largeSpecNet - previous.largeSpecNet, 0),
      smallSpec:  round(latest.smallSpecNet - previous.smallSpecNet, 0),
    } : null;

    // Percentile of current large-spec net position vs trailing history
    const largeSpecHistory = hist.map(h => h.largeSpecNet);
    const percentile = this._percentileRank(largeSpecHistory, latest.largeSpecNet);

    const isExtreme = percentile >= COT_EXTREME_PERCENTILE || percentile <= (100 - COT_EXTREME_PERCENTILE);

    // Signal logic: extreme large-spec positioning historically precedes reversals.
    // Commercial net is often the contrarian "smart money" signal.
    let signal = 'NEUTRAL';
    if (isExtreme && percentile >= COT_EXTREME_PERCENTILE) {
      signal = 'EXTREME_LONG_SPEC_REVERSAL_RISK'; // large specs maximally long → contrarian bearish
    } else if (isExtreme && percentile <= (100 - COT_EXTREME_PERCENTILE)) {
      signal = 'EXTREME_SHORT_SPEC_REVERSAL_RISK'; // large specs maximally short → contrarian bullish
    }

    return {
      symbol, date: latest.date,
      commercial: { net: latest.commercialNet, long: latest.commercialLong, short: latest.commercialShort },
      largeSpec:  { net: latest.largeSpecNet, long: latest.largeSpecLong, short: latest.largeSpecShort },
      smallSpec:  { net: latest.smallSpecNet, long: latest.smallSpecLong, short: latest.smallSpecShort },
      openInterest: latest.openInterest,
      weekOverWeekChange: wowChange,
      largeSpecPercentile: round(percentile, 1),
      isExtreme,
      signal,
      note: isExtreme
        ? `Large speculators at ${round(percentile,0)}th percentile of 3yr positioning — ${signal}`
        : 'Positioning within normal historical range',
    };
  }

  _percentileRank(arr, value) {
    if (arr.length < 2) return 50;
    const sorted = [...arr].sort((a, b) => a - b);
    const below = sorted.filter(v => v < value).length;
    return (below / sorted.length) * 100;
  }

  getHistory(symbol, n = 12) {
    const hist = this._reports.get(symbol) || [];
    return hist.slice(-n);
  }
}

module.exports = { COTReportParser };
