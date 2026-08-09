
'use strict';

const https = require('https');

class FMPFeed {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.FMP_API_KEY || '';
    this.cacheMs = Number(config.cacheMs || process.env.FMP_CACHE_MS || 30 * 60000);
    this._cache = new Map();
    // FIX: /api/v3/economic_calendar is FMP's deprecated legacy endpoint.
    this._baseUrl = 'https://financialmodelingprep.com/stable';
  }

  enabled() {
    return Boolean(this.apiKey);
  }

  isConnected() { return this.enabled(); }

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
      this._get(`/economic-calendar?from=${start}&to=${end}`)
    );

    // Note/Information has, so check explicitly rather than let Array.isArray's false fall through unnoticed.
    if (!Array.isArray(result)) {
      throw new Error(result?.['Error Message'] || 'FMP economic_calendar returned a non-array response');
    }

    return result
      .filter(e => e.date && e.country)
      .map(e => ({
        name: e.event || 'Economic Event',
        currency: this._countryToCurrency(e.country),
        time: new Date(e.date).getTime(),
        impact: (e.impact || '').toLowerCase() || null,
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        prev: e.previous ?? null,
        unit: e.unit || '',
      }))
      .filter(e => e.currency && Number.isFinite(e.time));
  }

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
