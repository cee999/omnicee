'use strict';

const https = require('https');

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

const COUNTRY_TO_CCY = {
  USD: 'USD', US: 'USD', 'United States': 'USD',
  EUR: 'EUR', EU: 'EUR', EMU: 'EUR', All: 'USD',
  GBP: 'GBP', UK: 'GBP', GBR: 'GBP',
  JPY: 'JPY', JP: 'JPY',
  AUD: 'AUD', AU: 'AUD',
  CAD: 'CAD', CA: 'CAD',
  NZD: 'NZD', NZ: 'NZD',
  CHF: 'CHF', CH: 'CHF',
  CNY: 'CNY', CN: 'CNY',
};

function httpGetJSON(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OMNICEE/1.0)',
        Accept: 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('429 rate limited'));
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        if (String(data).trimStart().startsWith('<')) {
          return reject(new Error('non-JSON response (blocked or rate limited)'));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 60)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function impactToTier(impact) {
  const i = String(impact || '').toLowerCase();
  if (i === 'high') return 'TIER_1';
  if (i === 'medium') return 'TIER_2';
  if (i === 'low') return 'TIER_3';
  if (i === 'holiday') return 'TIER_4';
  return null;
}

function mapRow(e) {
  let time = NaN;
  const rawDate = e.date || e.datetime || e.time;
  if (rawDate != null) {
    if (typeof rawDate === 'number') time = rawDate < 1e12 ? rawDate * 1000 : rawDate;
    else time = new Date(String(rawDate)).getTime();
  }
  const country = e.country || e.currency || '';
  const currency = COUNTRY_TO_CCY[country]
    || COUNTRY_TO_CCY[String(country).toUpperCase()]
    || (String(country).length === 3 ? String(country).toUpperCase() : 'USD');
  return {
    name: e.title || e.name || e.event || 'Economic Event',
    currency,
    time,
    impact: e.impact || null,
    forecast: e.forecast || null,
    previous: e.previous || null,
    source: 'forex-factory',
    tierHint: impactToTier(e.impact),
  };
}

class ForexFactoryCalendar {
  constructor() {
    this._cache = null;
    this._cacheTs = 0;
    this._backoffUntil = 0;
    this._lastError = null;
    this.cacheMs = 15 * 60 * 1000;
  }

  enabled() { return true; }
  isConnected() { return Array.isArray(this._cache) && this._cache.length > 0; }
  lastError() { return this._lastError; }

  async economicCalendar() {
    const now = Date.now();
    if (this._cache?.length && (now - this._cacheTs) < this.cacheMs) return this._cache;
    if (now < this._backoffUntil && this._cache?.length) return this._cache;

    try {
      const rows = await httpGetJSON(FF_URL);
      if (!Array.isArray(rows)) throw new Error('FF calendar not an array');
      const mapped = rows.map(mapRow).filter(e => e.name && Number.isFinite(e.time) && e.time > 0);
      this._cache = mapped;
      this._cacheTs = now;
      this._lastError = null;
      return mapped;
    } catch (err) {
      this._lastError = err.message;
      if (String(err.message).includes('429') || String(err.message).includes('rate')) {
        this._backoffUntil = now + 20 * 60 * 1000;
      }
      if (this._cache?.length) return this._cache;
      throw err;
    }
  }
}

module.exports = { ForexFactoryCalendar };
