'use strict';

/**
 * US Treasury FiscalData — official quarterly exchange rates
 * https://fiscaldata.treasury.gov
 *
 * NOT live ticks. Ranked very low. Useful when all live feeds are down,
 * and as macro context (official rate vs market).
 *
 * Treasury quotes foreign currency units per 1 USD for most series.
 */

const https = require('https');
const EventEmitter = require('events');

const BASE =
  'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange';

/** OMNICEE symbol → Treasury country_currency_desc + invert flag */
const MAP = {
  EURUSD: { desc: 'Euro Zone-Euro', invert: true },   // EUR per USD → EURUSD = 1/rate
  GBPUSD: { desc: 'United Kingdom-Pound', invert: true },
  USDJPY: { desc: 'Japan-Yen', invert: false },       // JPY per USD = USDJPY
};

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
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
      reject(new Error('treasury fiscal timeout'));
    });
  });
}

class TreasuryFiscalFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = Array.isArray(config.symbols)
      ? config.symbols.filter((s) => MAP[s])
      : Object.keys(MAP);
    this.pollMs = Math.max(60 * 60 * 1000, Number(config.pollMs || process.env.TREASURY_POLL_MS || 6 * 3600 * 1000));
    this._timer = null;
    this._running = false;
    this._lastOk = 0;
    this._lastBySymbol = {};
  }

  enabled() {
    return process.env.DISABLE_TREASURY !== '1' && this.symbols.length > 0;
  }

  isConnected() {
    return this._running && (Date.now() - this._lastOk) < this.pollMs * 2;
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
    const descs = this.symbols.map((s) => MAP[s].desc);
    const filter = `country_currency_desc:in:(${descs.join(',')}),record_date:gte:2023-01-01`;
    const qs = new URLSearchParams({
      fields: 'country_currency_desc,exchange_rate,record_date',
      filter,
      sort: '-record_date',
      'page[size]': '50',
    });
    try {
      const { status, body } = await httpGetJSON(`${BASE}?${qs.toString()}`);
      if (status >= 400) throw new Error(`treasury HTTP ${status}`);
      const rows = Array.isArray(body?.data) ? body.data : [];
      const latest = {};
      for (const row of rows) {
        const desc = row.country_currency_desc;
        if (latest[desc]) continue; // already have newest (sorted desc)
        latest[desc] = row;
      }
      this._lastOk = Date.now();
      for (const sym of this.symbols) {
        const meta = MAP[sym];
        const row = latest[meta.desc];
        if (!row) continue;
        let rate = Number(row.exchange_rate);
        if (!Number.isFinite(rate) || rate <= 0) continue;
        const price = meta.invert ? 1 / rate : rate;
        if (!Number.isFinite(price) || price <= 0) continue;
        this._lastBySymbol[sym] = {
          price,
          asOf: row.record_date,
          official: rate,
        };
        this.emit('price', {
          symbol: sym,
          price,
          source: 'treasury',
          change: null,
          bid: null,
          ask: null,
          asOf: row.record_date,
          mode: 'official_quarterly',
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

module.exports = { TreasuryFiscalFeed, MAP };
