'use strict';

const https = require('https');

/**
 * CFTCCotFeed
 * ─────────────────────────────────────────────
 * Fetches real weekly Commitment of Traders (Legacy Futures-Only) data from
 * CFTC's free public Socrata API — no API key required. Published every
 * Friday ~3:30pm ET, covering the prior Tuesday's positioning.
 *
 * This was the missing real data source for feeds/news-feed.js's
 * COTReportParser/COTAnalyzer, which are fully built (percentile extremity,
 * week-over-week change, contrarian signal generation) but had zero call
 * sites feeding them real data anywhere in the codebase.
 *
 * IMPORTANT — direction convention: CFTC currency futures are always quoted
 * as "foreign currency per USD" from the perspective of the futures contract
 * itself (e.g. long "JAPANESE YEN" future = long JPY = betting JPY
 * strengthens vs USD). For symbols where the foreign currency is the BASE
 * (EURUSD, GBPUSD, AUDUSD, NZDUSD), that maps directly onto "bullish the
 * symbol". For symbols where USD is the BASE and the foreign currency is
 * the QUOTE (USDJPY, USDCHF, USDCAD), it's INVERTED: long JPY futures means
 * bearish USDJPY. Getting this backwards would silently flip the COT bias
 * for exactly those three pairs. See `inverted` below.
 */
const SYMBOL_TO_CFTC_CONTRACT = {
  EURUSD:  { contract: 'EURO FX - CHICAGO MERCANTILE EXCHANGE',                 inverted: false },
  GBPUSD:  { contract: 'BRITISH POUND STERLING - CHICAGO MERCANTILE EXCHANGE',  inverted: false },
  AUDUSD:  { contract: 'AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',       inverted: false },
  NZDUSD:  { contract: 'NZ DOLLAR - CHICAGO MERCANTILE EXCHANGE',               inverted: false },
  USDJPY:  { contract: 'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE',            inverted: true },
  USDCHF:  { contract: 'SWISS FRANC - CHICAGO MERCANTILE EXCHANGE',             inverted: true },
  USDCAD:  { contract: 'CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',         inverted: true },
  XAUUSD:  { contract: 'GOLD - COMMODITY EXCHANGE INC.',                       inverted: false },
  XAGUSD:  { contract: 'SILVER - COMMODITY EXCHANGE INC.',                     inverted: false },
  BTCUSDT: { contract: 'BITCOIN - CHICAGO MERCANTILE EXCHANGE',                inverted: false },
  BTCUSD:  { contract: 'BITCOIN - CHICAGO MERCANTILE EXCHANGE',                inverted: false },
};

const SODA_LEGACY_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
const USER_AGENT = 'omnicee-trading-system/1.0 (+https://github.com/cee999/omnicee)';

class CFTCCotFeed {
  constructor(config = {}) {
    // CFTC only publishes once a week (Friday ~15:30 ET) — an aggressive
    // cache is correct here, not a workaround. Default 12h.
    this.cacheMs = Number(config.cacheMs || 12 * 3600000);
    this.timeoutMs = Number(config.timeoutMs || 15000);
    this._cache = new Map(); // contract name -> { rows, ts }
  }

  enabled() { return true; } // free public API, no key required

  /** List of trading symbols this feed knows how to map to a CFTC contract. */
  supportedSymbols() { return Object.keys(SYMBOL_TO_CFTC_CONTRACT); }

  /**
   * Fetch the two most recent Legacy report rows for a trading symbol
   * (latest + previous, so COTReportParser can compute week-over-week
   * change from a single call), with the sign of every long/short field
   * flipped if this symbol's CFTC contract is direction-inverted.
   *
   * @returns {Promise<Array|null>} rows in oldest→newest order, ready to
   *          pass straight into COTReportParser.ingest(symbol, row), or
   *          null if this symbol has no known CFTC mapping or the fetch
   *          failed.
   */
  async fetchForSymbol(symbol) {
    const mapping = SYMBOL_TO_CFTC_CONTRACT[symbol];
    if (!mapping) return null;

    const rows = await this._fetchContract(mapping.contract);
    if (!rows || rows.length === 0) return null;

    const ordered = [...rows].reverse(); // API returns newest-first; parser expects oldest-first
    if (!mapping.inverted) return ordered;

    // FIX-in-advance: without this, USDJPY/USDCHF/USDCAD would silently get
    // the exact opposite COT bias, since CFTC always reports these contracts
    // in terms of the foreign currency, not the USD-base trading pair.
    return ordered.map(row => ({
      ...row,
      noncomm_positions_long_all: row.noncomm_positions_short_all,
      noncomm_positions_short_all: row.noncomm_positions_long_all,
      comm_positions_long_all: row.comm_positions_short_all,
      comm_positions_short_all: row.comm_positions_long_all,
      nonrept_positions_long_all: row.nonrept_positions_short_all,
      nonrept_positions_short_all: row.nonrept_positions_long_all,
    }));
  }

  async _fetchContract(contractName) {
    const cached = this._cache.get(contractName);
    if (cached && Date.now() - cached.ts < this.cacheMs) return cached.rows;

    const qs = new URLSearchParams({
      '$where': `market_and_exchange_names='${contractName}'`,
      '$order': 'report_date_as_yyyy_mm_dd DESC',
      '$limit': '2',
    });
    const url = `${SODA_LEGACY_URL}?${qs.toString()}`;

    let rows;
    try {
      rows = await this._get(url);
    } catch (err) {
      // Don't cache failures — retry on next call rather than going dark
      // for the full cache window on a transient network error.
      return cached ? cached.rows : null;
    }
    if (!Array.isArray(rows)) return cached ? cached.rows : null;

    this._cache.set(contractName, { rows, ts: Date.now() });
    return rows;
  }

  _get(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`CFTC API returned HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`CFTC API returned invalid JSON: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('CFTC API request timed out')));
    });
  }
}

module.exports = { CFTCCotFeed, SYMBOL_TO_CFTC_CONTRACT };
