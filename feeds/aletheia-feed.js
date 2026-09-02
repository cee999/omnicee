'use strict';

/**
 * Aletheia StockData API — equity/ETF quotes (e.g. UUP DXY proxy).
 * https://api.aletheiaapi.com/StockData?symbol=UUP&summary=true
 *
 * Set ALETHEIA_API_KEY (header or query — docs vary; we send both).
 */

const https = require('https');
const EventEmitter = require('events');

const BASE = 'https://api.aletheiaapi.com/StockData';

/** OMNICEE → Aletheia ticker */
const MAP = {
  UUP: 'UUP',
  USOIL: 'USO',
};

function httpGetJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OMNICEE/1.0',
        ...headers,
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        } catch (e) {
          reject(new Error(`Aletheia parse: ${data.slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('aletheia timeout'));
    });
    req.end();
  });
}

function extractPrice(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.price, body.last, body.lastPrice, body.close, body.c,
    body.summary?.price, body.summary?.last, body.summary?.close,
    body.data?.price, body.data?.last, body.Quote?.Price,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

class AletheiaFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.ALETHEIA_API_KEY || process.env.ALETHEIA_KEY || '';
    this.symbols = Array.isArray(config.symbols)
      ? config.symbols.filter((s) => MAP[s])
      : Object.keys(MAP);
    this.pollMs = Math.max(30000, Number(config.pollMs || process.env.ALETHEIA_POLL_MS || 60000));
    this._timer = null;
    this._running = false;
    this._lastOk = 0;
  }

  enabled() {
    return Boolean(this.apiKey) && this.symbols.length > 0;
  }

  isConnected() {
    return this.enabled() && this._running && (Date.now() - this._lastOk) < this.pollMs * 3;
  }

  start() {
    if (!this.enabled() || this._running) return;
    this._running = true;
    this._poll().catch(() => {});
    this._timer = setInterval(() => this._poll().catch(() => {}), this.pollMs);
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async disconnect() { this.stop(); }
  async connect() { this.start(); }

  async _poll() {
    for (const omni of this.symbols) {
      const ticker = MAP[omni];
      try {
        const qs = new URLSearchParams({
          symbol: ticker,
          summary: 'true',
          key: this.apiKey,
          apikey: this.apiKey,
        });
        const { status, body } = await httpGetJSON(`${BASE}?${qs}`, {
          'X-API-KEY': this.apiKey,
          Authorization: `Bearer ${this.apiKey}`,
        });
        if (status >= 400) throw new Error(`Aletheia HTTP ${status}`);
        const price = extractPrice(body);
        if (price) {
          this._lastOk = Date.now();
          this.emit('price', {
            symbol: omni,
            price,
            source: 'aletheia',
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

module.exports = { AletheiaFeed, MAP };
