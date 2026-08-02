/**
 * CoinGecko simple market snapshot — free, often works without a key
 * https://api.coingecko.com/api/v3/...
 */
'use strict';

const https = require('https');

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'OMNICEE/1.0', Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 80)}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

class CoinGeckoFeed {
  constructor() {
    this._cache = null;
    this._cacheTs = 0;
    this.cacheMs = 5 * 60 * 1000;
  }

  enabled() { return true; }
  isConnected() { return true; }

  async getSnapshot() {
    const now = Date.now();
    if (this._cache && (now - this._cacheTs) < this.cacheMs) return this._cache;

    const [prices, global] = await Promise.all([
      httpGetJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true'),
      httpGetJSON('https://api.coingecko.com/api/v3/global').catch(() => null),
    ]);

    const g = global?.data || {};
    const out = {
      btc: {
        usd: prices?.bitcoin?.usd ?? null,
        change24h: prices?.bitcoin?.usd_24h_change ?? null,
      },
      eth: {
        usd: prices?.ethereum?.usd ?? null,
        change24h: prices?.ethereum?.usd_24h_change ?? null,
      },
      btcDominance: g.market_cap_percentage?.btc ?? null,
      totalMarketCapUsd: g.total_market_cap?.usd ?? null,
      marketCapChange24h: g.market_cap_change_percentage_24h_usd ?? null,
      source: 'coingecko',
      timestamp: now,
    };
    this._cache = out;
    this._cacheTs = now;
    return out;
  }
}

module.exports = { CoinGeckoFeed };
