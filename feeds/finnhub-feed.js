'use strict';

const https = require('https');

class FinnhubFeed {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.FINNHUB_API_KEY || '';
    this.cacheMs = Number(config.cacheMs || process.env.FINNHUB_CACHE_MS || 5 * 60 * 1000);
    this._cache = new Map();
    this._baseUrl = 'https://finnhub.io/api/v1';
  }

  enabled() {
    return Boolean(this.apiKey);
  }

  _get(path) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this._baseUrl}${path}${sep}token=${this.apiKey}`;
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  async marketNews(category = 'general') {
    if (!this.apiKey) return [];
    return this._cached(`news:${category}`, () => this._get(`/news?category=${category}`));
  }

  async companyNews(symbol, from, to) {
    if (!this.apiKey) return [];
    const end = to || new Date().toISOString().slice(0, 10);
    const start = from || new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    return this._cached(`company:${symbol}:${start}:${end}`, () =>
      this._get(`/company-news?symbol=${symbol}&from=${start}&to=${end}`)
    );
  }

  // FIX: added — this was the missing real data source for
  // risk-engine/session-filter.js's EconomicCalendarTierSystem, which had a
  // fully-built blackout/pre-event size-reduction gate but nothing ever
  // called addNewsEvents() with real events, so it silently reported "CLEAR"
  // 100% of the time. Finnhub's /calendar/economic endpoint returns
  // scheduled macro releases (NFP, CPI, rate decisions, etc.) for a date
  // range, which is exactly what that gate needs.
  async economicCalendar(from, to) {
    if (!this.apiKey) return [];
    const start = from || new Date().toISOString().slice(0, 10);
    const end = to || new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    const result = await this._cached(`econ-cal:${start}:${end}`, () =>
      this._get(`/calendar/economic?from=${start}&to=${end}`)
    );
    const events = Array.isArray(result?.economicCalendar) ? result.economicCalendar : [];
    // Normalize to the {name, currency, time, tier} shape EconomicCalendarTierSystem expects
    return events
      .filter(e => e.time && e.country)
      .map(e => ({
        name: e.event || 'Economic Event',
        currency: this._countryToCurrency(e.country),
        time: new Date(e.time).getTime(),
        impact: e.impact || null,          // Finnhub: 'low' | 'medium' | 'high'
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        prev: e.prev ?? null,
        unit: e.unit || '',
      }))
      .filter(e => e.currency && Number.isFinite(e.time));
  }

  _countryToCurrency(country) {
    const map = {
      US: 'USD', EU: 'EUR', 'United States': 'USD', 'Euro Area': 'EUR',
      GB: 'GBP', UK: 'GBP', JP: 'JPY', CH: 'CHF', CA: 'CAD', AU: 'AUD', NZ: 'NZD',
      China: 'USD', // CNY events mostly move USD-pairs/risk sentiment in practice
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

module.exports = { FinnhubFeed };
