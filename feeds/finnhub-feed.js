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
