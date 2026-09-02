'use strict';

/**
 * Smart-money intelligence layer for Omnicee.
 * Aggregates free/public sources so the desk "thinks" like positioning + news + session flow:
 *  - Yahoo news (no key)
 *  - Fear & Greed (crypto/macro mood)
 *  - COT commercials vs specs (when CFTC path is live)
 *  - Session open windows (London / NY) for opportunity timing
 *
 * Does not place trades. Feeds sentiment + score context only.
 */

const https = require('https');

function httpGetJSON(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'OmniceeSmartMoney/1.0', Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

const BULL = /\b(rally|surge|breakout|beat|hawkish|dovish cut|inflow|accumulation|buy|bullish|record high|etf inflow)\b/i;
const BEAR = /\b(crash|plunge|miss|selloff|sell-off|outflow|liquidation|bearish|recession|hike|hawkish hold|default)\b/i;

function scoreHeadline(title = '') {
  let s = 0;
  if (BULL.test(title)) s += 1;
  if (BEAR.test(title)) s -= 1;
  return s;
}

function sessionContext(now = Date.now()) {
  const d = new Date(now);
  const utcH = d.getUTCHours() + d.getUTCMinutes() / 60;
  const dow = d.getUTCDay(); // 0 Sun
  const isWeekend = dow === 0 || dow === 6;

  // FX/gold: London ~07–16 UTC, NY ~12–21 UTC, opens ~07–09 and ~12–14 hottest
  let phase = 'ASIA';
  let opportunity = 0.35;
  let label = 'Asia / quiet';
  if (isWeekend) {
    phase = 'WEEKEND';
    opportunity = 0.15;
    label = 'Weekend — limited FX/gold, crypto only';
  } else if (utcH >= 7 && utcH < 9) {
    phase = 'LONDON_OPEN';
    opportunity = 0.92;
    label = 'London open — smart money liquidity window';
  } else if (utcH >= 9 && utcH < 12) {
    phase = 'LONDON';
    opportunity = 0.75;
    label = 'London session';
  } else if (utcH >= 12 && utcH < 14) {
    phase = 'NY_OPEN';
    opportunity = 0.95;
    label = 'New York open — highest overlap opportunity';
  } else if (utcH >= 14 && utcH < 17) {
    phase = 'LONDON_NY';
    opportunity = 0.88;
    label = 'London–NY overlap';
  } else if (utcH >= 17 && utcH < 21) {
    phase = 'NY';
    opportunity = 0.7;
    label = 'New York session';
  } else {
    phase = 'OFF_HOURS';
    opportunity = 0.4;
    label = 'Off-hours — selective only';
  }

  return {
    phase,
    label,
    opportunity,
    isOpenWindow: opportunity >= 0.85,
    isWeekend,
    utcHour: utcH,
  };
}

class SmartMoneyIntel {
  constructor(deps = {}) {
    this.yahooNews = deps.yahooNews || null;
    this.fearGreed = deps.fearGreed || null;
    this._fgCache = null;
    this._fgTs = 0;
    this._newsByTopic = new Map();
    this._lastBundle = null;
    this._lastBundleTs = 0;
  }

  async getFearGreed() {
    const now = Date.now();
    if (this._fgCache && now - this._fgTs < 15 * 60 * 1000) return this._fgCache;
    try {
      if (this.fearGreed?.fetch) {
        const fg = await this.fearGreed.fetch();
        this._fgCache = fg;
        this._fgTs = now;
        return fg;
      }
      const { status, body } = await httpGetJSON('https://api.alternative.me/fng/?limit=1');
      if (status >= 400) return null;
      const row = body?.data?.[0];
      if (!row) return null;
      const out = {
        value: Number(row.value),
        label: row.value_classification || 'Unknown',
        source: 'alternative.me',
        timestamp: row.timestamp ? Number(row.timestamp) * 1000 : now,
      };
      this._fgCache = out;
      this._fgTs = now;
      return out;
    } catch (_) {
      return this._fgCache;
    }
  }

  async getNewsArticles(symbol) {
    const topic = /XAU|GOLD/i.test(symbol) ? 'gold'
      : /USDT|BTC|ETH/i.test(symbol) ? 'crypto'
        : /USOIL|OIL|WTI/i.test(symbol) ? 'oil'
          : /UUP/i.test(symbol) ? 'dollar'
            : 'forex';

    const now = Date.now();
    const cached = this._newsByTopic.get(topic);
    if (cached && now - cached.ts < 4 * 60 * 1000) return cached.articles;

    let articles = [];
    try {
      if (this.yahooNews?.fetchAll || this.yahooNews?.getNews) {
        const bundle = this.yahooNews.fetchAll
          ? await this.yahooNews.fetchAll()
          : await this.yahooNews.getNews();
        const list = Array.isArray(bundle) ? bundle
          : Array.isArray(bundle?.items) ? bundle.items
            : Array.isArray(bundle?.articles) ? bundle.articles
              : [];
        articles = list
          .filter((a) => {
            const cat = String(a.category || a.topic || '').toLowerCase();
            if (!cat || cat === 'markets') return true;
            if (topic === 'gold') return /gold|xau|metal/.test(cat + (a.title || ''));
            if (topic === 'crypto') return /crypto|bitcoin|btc|eth/.test(cat + (a.title || ''));
            if (topic === 'oil') return /oil|crude|wti|brent/.test(cat + (a.title || ''));
            if (topic === 'dollar') return /dollar|dxy|fed|yield/.test(cat + (a.title || ''));
            return /forex|fx|eur|gbp|jpy|fed|ecb|cpi|nfp/.test(cat + (a.title || ''));
          })
          .slice(0, 20)
          .map((a) => ({
            title: a.title || a.headline || '',
            description: a.summary || a.description || '',
            content: '',
            source: { name: a.source || a.publisher || 'yahoo' },
            publishedAt: a.publishedAt || a.providerPublishTime || Date.now(),
            url: a.link || a.url || '',
          }));
      }
    } catch (_) { /* soft */ }

    // Direct Yahoo finance search fallback (no key)
    if (!articles.length) {
      try {
        const q = topic === 'gold' ? 'gold price'
          : topic === 'crypto' ? 'bitcoin ethereum'
            : topic === 'oil' ? 'crude oil WTI'
              : topic === 'dollar' ? 'US dollar index'
                : 'forex Federal Reserve';
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=12&quotesCount=0`;
        const { body } = await httpGetJSON(url);
        const news = body?.news || [];
        articles = news.map((n) => ({
          title: n.title || '',
          description: n.summary || '',
          content: '',
          source: { name: n.publisher || 'yahoo' },
          publishedAt: (n.providerPublishTime || 0) * 1000 || Date.now(),
          url: n.link || '',
        }));
      } catch (_) { /* soft */ }
    }

    this._newsByTopic.set(topic, { articles, ts: now });
    return articles;
  }

  /**
   * Build external payload for SentimentAgent + scoring context.
   */
  async buildForSymbol(symbol, extras = {}) {
    const session = sessionContext();
    const [articles, fearGreed] = await Promise.all([
      this.getNewsArticles(symbol),
      this.getFearGreed(),
    ]);

    let newsBias = 0;
    for (const a of (articles || []).slice(0, 12)) {
      newsBias += scoreHeadline(a.title);
    }
    const newsDirection = newsBias >= 2 ? 'LONG' : newsBias <= -2 ? 'SHORT' : 'NEUTRAL';
    const newsScore = Math.max(20, Math.min(80, 50 + newsBias * 8));

    const fg = fearGreed;
    let fgNote = null;
    if (fg && Number.isFinite(fg.value)) {
      if (fg.value <= 25) fgNote = { lean: 'LONG', note: 'Extreme fear — contrarian bid zone' };
      else if (fg.value >= 75) fgNote = { lean: 'SHORT', note: 'Extreme greed — caution on longs' };
    }

    const cot = extras.cot || null;
    let smartMoneyLean = 'NEUTRAL';
    let smartMoneyNote = session.label;
    if (cot?.commercials) {
      const cLong = Number(cot.commercials.long) || 0;
      const cShort = Number(cot.commercials.short) || 0;
      const sLong = Number(cot.largeSpec?.long) || 0;
      const sShort = Number(cot.largeSpec?.short) || 0;
      if (cLong > cShort * 1.15) {
        smartMoneyLean = 'LONG';
        smartMoneyNote = 'Commercials net long (smart money bias)';
      } else if (cShort > cLong * 1.15) {
        smartMoneyLean = 'SHORT';
        smartMoneyNote = 'Commercials net short (smart money bias)';
      }
      if (sLong > sShort * 1.25 && smartMoneyLean === 'SHORT') {
        smartMoneyNote += ' · specs crowded long (fade risk)';
      }
      if (sShort > sLong * 1.25 && smartMoneyLean === 'LONG') {
        smartMoneyNote += ' · specs crowded short (fade risk)';
      }
    }

    const bundle = {
      articles,
      fearGreed: fg,
      session,
      newsDirection,
      newsScore,
      smartMoneyLean,
      smartMoneyNote,
      fgNote,
      cot,
      insider: extras.insider || null,
      opportunityBoost: session.isOpenWindow ? 1.12 : session.opportunity >= 0.7 ? 1.06 : 1.0,
      timestamp: Date.now(),
    };
    this._lastBundle = bundle;
    this._lastBundleTs = Date.now();
    return bundle;
  }

  getLastBundle() {
    return this._lastBundle;
  }
}

module.exports = { SmartMoneyIntel, sessionContext };
