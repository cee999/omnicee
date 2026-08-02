/**
 * Crypto Fear & Greed Index — Alternative.me, free, no key
 * https://api.alternative.me/fng/
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
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

class FearGreedFeed {
  constructor() {
    this._cache = null;
    this._cacheTs = 0;
    this.cacheMs = 30 * 60 * 1000; // 30 min
  }

  enabled() { return true; }
  isConnected() { return true; }

  async getLatest() {
    const now = Date.now();
    if (this._cache && (now - this._cacheTs) < this.cacheMs) return this._cache;

    const data = await httpGetJSON('https://api.alternative.me/fng/?limit=1');
    const row = data?.data?.[0];
    if (!row) throw new Error('no fear-greed data');

    const value = Number(row.value);
    const out = {
      value,
      label: row.value_classification || 'Unknown',
      timestamp: row.timestamp ? Number(row.timestamp) * 1000 : now,
      source: 'alternative.me',
    };
    this._cache = out;
    this._cacheTs = now;
    return out;
  }
}

module.exports = { FearGreedFeed };
