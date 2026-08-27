'use strict';

/**
 * Curated finance/market APIs from ApiVault (github.com/exa-studio/ApiVault)
 * for Omnicee feed expansion. Prefer free / no-key endpoints first.
 *
 * Omnicee already has: Finnhub, FMP, ExchangeRate, FRED, CoinGecko, StockData,
 * Deriv, TradingView quotes, Forex Factory calendar, Binance public.
 *
 * This catalog is a ranked shortlist of ADDITIONAL candidates — not auto-enabled.
 * Enable via env only after verifying rate limits and ToS.
 */

const CATALOG = [
  {
    id: 'frankfurter',
    name: 'Frankfurter',
    category: 'fx',
    url: 'https://www.frankfurter.app/docs',
    auth: 'none',
    https: true,
    note: 'ECB FX rates, free time series — good EUR/USD etc. fallback',
    priority: 40,
    envKey: null,
  },
  {
    id: 'freeforexapi',
    name: 'FreeForexAPI',
    category: 'fx',
    url: 'https://freeforexapi.com/Home/Api',
    auth: 'none',
    https: true,
    note: 'Major pairs real-time; pair with MT5 for gold (not always on free FX APIs)',
    priority: 35,
    envKey: null,
  },
  {
    id: 'exchangerate_host',
    name: 'exchangerate.host',
    category: 'fx',
    url: 'https://exchangerate.host',
    auth: 'none',
    https: true,
    note: 'FX + crypto rates; already partially covered by ExchangeRate feed',
    priority: 30,
    envKey: null,
  },
  {
    id: 'coingecko',
    name: 'CoinGecko',
    category: 'crypto',
    url: 'https://www.coingecko.com/api',
    auth: 'none',
    https: true,
    note: 'Already integrated as coingecko-feed.js',
    priority: 50,
    envKey: null,
    integrated: true,
  },
  {
    id: 'finnhub',
    name: 'Finnhub',
    category: 'multi',
    url: 'https://finnhub.io/docs/api',
    auth: 'apiKey',
    https: true,
    note: 'Already integrated',
    priority: 80,
    envKey: 'FINNHUB_API_KEY',
    integrated: true,
  },
  {
    id: 'fred',
    name: 'FRED',
    category: 'macro',
    url: 'https://fred.stlouisfed.org/docs/api/fred/',
    auth: 'apiKey',
    https: true,
    note: 'Already integrated — expand series for DXY / rates when FRED_API_KEY set',
    priority: 70,
    envKey: 'FRED_API_KEY',
    integrated: true,
  },
  {
    id: 'stockdata',
    name: 'StockData.org',
    category: 'equities_fx',
    url: 'https://www.StockData.org',
    auth: 'apiKey',
    https: true,
    note: 'Already integrated as optional fallback',
    priority: 45,
    envKey: 'STOCKDATA_API_TOKEN',
    integrated: true,
  },
  {
    id: 'marketstack',
    name: 'marketstack',
    category: 'equities',
    url: 'https://marketstack.com/',
    auth: 'apiKey',
    https: true,
    note: 'Intraday/historical equities — optional if expanding beyond XAU/FX/crypto',
    priority: 25,
    envKey: 'MARKETSTACK_API_KEY',
  },
  {
    id: 'messari',
    name: 'Messari',
    category: 'crypto',
    url: 'https://messari.io/api',
    auth: 'none',
    https: true,
    note: 'Crypto asset metrics / research endpoints',
    priority: 28,
    envKey: null,
  },
  {
    id: 'technical_analysis_api',
    name: 'Technical Analysis API',
    category: 'crypto',
    url: 'https://technical-analysis-api.com',
    auth: 'apiKey',
    https: true,
    note: 'Crypto TA endpoints — optional secondary signal input only',
    priority: 20,
    envKey: 'TECHNICAL_ANALYSIS_API_KEY',
  },
];

function listByCategory(category) {
  return CATALOG.filter((c) => !category || c.category === category);
}

function notIntegrated() {
  return CATALOG.filter((c) => !c.integrated).sort((a, b) => b.priority - a.priority);
}

function statusReport() {
  return {
    total: CATALOG.length,
    integrated: CATALOG.filter((c) => c.integrated).length,
    candidates: notIntegrated(),
    source: 'ApiVault curated subset — finance/fx/crypto/macro only',
  };
}

module.exports = {
  CATALOG,
  listByCategory,
  notIntegrated,
  statusReport,
};
