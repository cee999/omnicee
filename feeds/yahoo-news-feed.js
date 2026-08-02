/**
 * Yahoo Finance news — no API key
 * Uses public search endpoint: /v1/finance/search?q=...&newsCount=N
 */
'use strict';

const https = require('https');

const UA = 'Mozilla/5.0 (compatible; OMNICEE/1.0; +https://github.com/cee999/omnicee)';

// Topics we pull so News tab always has market-relevant stories
const TOPICS = [
  'forex EUR USD',
  'dollar index DXY',
  'Federal Reserve interest rates',
  'gold XAUUSD',
  'crude oil WTI OPEC',
  'bitcoin ethereum crypto',
  'ECB Bank of England BoJ',
  'US CPI NFP inflation',
  'geopolitics oil markets',
];

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON: ${data.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function guessCategory(query, title) {
  const t = `${query} ${title}`.toLowerCase();
  if (/oil|opec|wti|brent|crude/.test(t)) return 'oil';
  if (/gold|xau|silver/.test(t)) return 'gold';
  if (/bitcoin|btc|ethereum|eth|crypto/.test(t)) return 'crypto';
  if (/dollar index|dxy|\buup\b/.test(t)) return 'dxy';
  if (/forex|eur|gbp|jpy|fx |currency|ecb|fed |fomc|cpi|nfp/.test(t)) return 'forex';
  return 'markets';
}

function thumbUrl(item) {
  const res = item?.thumbnail?.resolutions;
  if (!Array.isArray(res) || !res.length) return null;
  const mid = res.find(r => r.width >= 200 && r.width <= 400) || res[res.length - 1] || res[0];
  return mid?.url || null;
}

class YahooNewsFeed {
  constructor(config = {}) {
    this.topics = config.topics || TOPICS;
    this._cache = null;
    this._cacheTs = 0;
    this.cacheMs = Number(config.cacheMs || process.env.YAHOO_NEWS_CACHE_MS || 10 * 60 * 1000);
  }

  enabled() { return true; }
  isConnected() { return true; }

  async fetchTopic(query, count = 8) {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=${count}&quotesCount=0`;
    const data = await httpGetJSON(url);
    const news = Array.isArray(data?.news) ? data.news : [];
    return news.map(n => ({
      headline: n.title || '',
      summary: '',
      source: n.publisher || 'Yahoo Finance',
      url: n.link || null,
      image: thumbUrl(n),
      datetime: n.providerPublishTime
        ? (n.providerPublishTime < 1e12 ? n.providerPublishTime * 1000 : n.providerPublishTime)
        : Date.now(),
      category: guessCategory(query, n.title || ''),
      symbol: Array.isArray(n.relatedTickers) ? n.relatedTickers[0] : null,
      relatedTickers: n.relatedTickers || [],
    })).filter(n => n.headline);
  }

  async getNews({ limit = 30 } = {}) {
    const now = Date.now();
    if (this._cache && (now - this._cacheTs) < this.cacheMs) {
      return this._cache.slice(0, limit);
    }

    const bags = await Promise.all(
      this.topics.map(t => this.fetchTopic(t, 6).catch(() => []))
    );
    const seen = new Set();
    const merged = [];
    for (const bag of bags) {
      for (const item of bag) {
        const key = item.headline.toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    merged.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
    this._cache = merged;
    this._cacheTs = now;
    return merged.slice(0, limit);
  }
}

module.exports = { YahooNewsFeed };
