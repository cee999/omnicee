'use strict';

const https = require('https');

// IMPORTANT — direction convention: CFTC currency futures are always quoted as "foreign currency per USD" from the perspective of the futures contract itself (e.g.
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
    this.cacheMs = Number(config.cacheMs || 12 * 3600000);
    this.timeoutMs = Number(config.timeoutMs || 15000);
    this._cache = new Map();
  }

  enabled() { return true; }
  isConnected() { return true; }

  supportedSymbols() { return Object.keys(SYMBOL_TO_CFTC_CONTRACT); }

  async fetchForSymbol(symbol) {
    const mapping = SYMBOL_TO_CFTC_CONTRACT[symbol];
    if (!mapping) return null;

    const rows = await this._fetchContract(mapping.contract);
    if (!rows || rows.length === 0) return null;

    const ordered = [...rows].reverse();
    if (!mapping.inverted) return ordered;

    // FIX-in-advance: without this, USDJPY/USDCHF/USDCAD would silently get the exact opposite COT bias, since CFTC always reports these contracts in terms of the foreign currency, not the USD-base trading...
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
