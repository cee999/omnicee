'use strict';

const https = require('https');

const UA = 'Mozilla/5.0 (compatible; OMNICEE/1.0; +https://github.com/cee999/omnicee)';

const TOPICS = [
  // Crypto (priority — more queries = more crypto headlines)
  'bitcoin BTC price',
  'bitcoin ETF BTC',
  'ethereum ETH price',
  'crypto market bitcoin ethereum',
  'crypto regulation SEC binance coinbase',
  'solana SOL crypto',
  'stablecoin USDT USDC',
  'crypto exchange trading volume',
  // Forex (priority)
  'forex market EURUSD GBPUSD',
  'EURUSD euro dollar forex',
  'GBPUSD pound dollar FX',
  'USDJPY yen dollar forex',
  'US dollar index DXY FX',
  'Federal Reserve interest rate decision',
  'ECB interest rate euro',
  'Bank of England rate GBP',
  'Bank of Japan yen intervention',
  'US CPI inflation NFP jobs report',
  'FOMC minutes treasury yields',
  // Metals / energy (FX & risk drivers)
  'gold price XAUUSD Fed',
  'crude oil WTI OPEC inventory',
  // Light cross-asset only (lower weight later)
  'bond yields treasury dollar',
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
    this.cacheMs = Number(config.cacheMs || process.env.YAHOO_NEWS_CACHE_MS || 5 * 60 * 1000);
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
    const RELEVANT = /forex|currency|eur|usd|gbp|jpy|aud|cad|nzd|chf|dxy|dollar|fed\b|fomc|ecb|boj|boe|cpi|nfp|inflation|rate decision|treasury|yield|gold|xau|oil|wti|brent|opec|bitcoin|btc|ethereum|eth|crypto|nasdaq|s&p|equit|bond|liquidity|central bank|nonfarm|payroll/i;
    const scored = merged.map(item => {
      const text = `${item.headline} ${item.summary || ''} ${item.category || ''}`;
      let score = 0;
      if (RELEVANT.test(text)) score += 4;
      // Crypto & forex weighted highest
      if (/bitcoin|btc|ethereum|eth|crypto|solana|stablecoin|binance|coinbase|sec\b.*crypto|crypto.*etf/i.test(text)) score += 8;
      if (/forex|eurusd|gbpusd|usdjpy|\bfx\b|currency pair/i.test(text)) score += 8;
      if (/dxy|dollar index|greenback/i.test(text)) score += 5;
      if (/fed\b|fomc|ecb|boj|boe|cpi|nfp|inflation|interest rate/i.test(text)) score += 4;
      if (/gold|xau|oil|wti|brent|opec/i.test(text)) score += 3;
      // Penalize pure equity/general unless FX/crypto also present
      if (/\b(s&p|nasdaq|dow jones|stock market)\b/i.test(text) && !/forex|crypto|bitcoin|btc|dollar|fed\b/i.test(text)) score -= 4;
      const ageH = (Date.now() - (item.datetime || 0)) / 3600000;
      if (ageH < 6) score += 2;
      else if (ageH < 24) score += 1;
      return { ...item, _rel: score };
    }).filter(item => item._rel >= 5); // stricter: prefer real crypto/FX
    scored.sort((a, b) => (b._rel - a._rel) || ((b.datetime || 0) - (a.datetime || 0)));
    const out = scored.map(({ _rel, ...rest }) => rest);
    this._cache = out;
    this._cacheTs = now;
    return out.slice(0, limit);
  }
}

module.exports = { YahooNewsFeed };
