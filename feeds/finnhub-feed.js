'use strict';

const finnhub = require('finnhub');

class FinnhubFeed {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.FINNHUB_API_KEY || '';
    this.cacheMs = Number(config.cacheMs || process.env.FINNHUB_CACHE_MS || 5 * 60 * 1000);
    this._cache = new Map();
    this._client = null;
    if (this.apiKey) {
      const apiKey = finnhub.ApiClient.instance.authentications.api_key;
      apiKey.apiKey = this.apiKey;
      this._client = new finnhub.DefaultApi();
    }
  }

  enabled() {
    return Boolean(this._client);
  }

  async marketNews(category = 'general') {
    return this._cached(`news:${category}`, () => new Promise((resolve, reject) => {
      if (!this._client) return resolve([]);
      this._client.marketNews(category, {}, (err, data) => err ? reject(err) : resolve(data || []));
    }));
  }

  async companyNews(symbol, from, to) {
    const end = to || new Date().toISOString().slice(0, 10);
    const start = from || new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    return this._cached(`company:${symbol}:${start}:${end}`, () => new Promise((resolve, reject) => {
      if (!this._client) return resolve([]);
      this._client.companyNews(symbol, start, end, (err, data) => err ? reject(err) : resolve(data || []));
    }));
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
