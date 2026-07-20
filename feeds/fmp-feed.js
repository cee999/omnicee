/**
 * ============================================================
 *  FMP FEED — Economic Calendar (redundant source)
 *  File: feeds/fmp-feed.js
 * ============================================================
 *  Financial Modeling Prep's economic calendar, normalized to the
 *  exact same {name, currency, time, impact, actual, estimate,
 *  prev, unit} shape FinnhubFeed.economicCalendar() already
 *  produces (feeds/finnhub-feed.js). This exists specifically as
 *  a second, independent source for sessionFilter's
 *  EconomicCalendarTierSystem blackout gate — if FINNHUB_API_KEY
 *  is unset or Finnhub has an outage/quota issue, that safety
 *  gate would otherwise silently report "CLEAR" with zero real
 *  event awareness (see index.js's pollEconomicCalendar). Optional
 *  — if FMP_API_KEY is unset, this feed simply reports disabled.
 * ============================================================
 */

'use strict';

const https = require('https');

class FMPFeed {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.FMP_API_KEY || '';
    this.cacheMs = Number(config.cacheMs || process.env.FMP_CACHE_MS || 30 * 60000);
    this._cache = new Map();
    this._baseUrl = 'https://financialmodelingprep.com/api/v3';
  }

  enabled() {
    return Boolean(this.apiKey);
  }

  _get(path) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this._baseUrl}${path}${sep}apikey=${this.apiKey}`;
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Failed to parse FMP response: ${data.slice(0, 200)}`)); }
        });
      }).on('error', reject);
    });
  }

  async economicCalendar(from, to) {
    if (!this.apiKey) return [];
    const start = from || new Date().toISOString().slice(0, 10);
    const end = to || new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    const result = await this._cached(`econ-cal:${start}:${end}`, () =>
      this._get(`/economic_calendar?from=${start}&to=${end}`)
    );

    // FMP returns a plain object (often {"Error Message": "..."}) instead of
    // an array on bad/missing key or rate-limit — same silent-shape risk
    // Alpha Vantage's Note/Information has, so check explicitly rather than
    // let Array.isArray's false fall through unnoticed.
    if (!Array.isArray(result)) {
      throw new Error(result?.['Error Message'] || 'FMP economic_calendar returned a non-array response');
    }

    return result
      .filter(e => e.date && e.country)
      .map(e => ({
        name: e.event || 'Economic Event',
        currency: this._countryToCurrency(e.country),
        time: new Date(e.date).getTime(),
        impact: (e.impact || '').toLowerCase() || null, // FMP: 'Low' | 'Medium' | 'High'
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        prev: e.previous ?? null,
        unit: '',
      }))
      .filter(e => e.currency && Number.isFinite(e.time));
  }

  // Same mapping as FinnhubFeed._countryToCurrency (feeds/finnhub-feed.js) —
  // kept as an independent copy rather than a shared import so this feed has
  // no dependency on Finnhub being present, matching every other feed's
  // fully self-contained convention in this codebase.
  _countryToCurrency(country) {
    const map = {
      US: 'USD', EU: 'EUR', 'United States': 'USD', 'Euro Area': 'EUR',
      GB: 'GBP', UK: 'GBP', JP: 'JPY', CH: 'CHF', CA: 'CAD', AU: 'AUD', NZ: 'NZD',
      China: 'USD',
    };
    return map[country] || null;
  }

  async _cached(key, loader) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheMs) return hit.value;
    const value = await loader();
    this._cache.set(key, { value, ts: Date.now() });
    if (this._cache.size > 100) this._cache.delete(this._cache.keys().next().value);
    return value;
  }
}

module.exports = { FMPFeed };
