'use strict';
const https = require('https');
const EventEmitter = require('events');
const WebSocket = require('ws');

const DEFAULT_FOREX_SYMBOL_MAP = {
  XAUUSD: 'OANDA:XAU_USD',
  XAGUSD: 'OANDA:XAG_USD',
  EURUSD: 'OANDA:EUR_USD',
  GBPUSD: 'OANDA:GBP_USD',
  USDJPY: 'OANDA:USD_JPY',
  AUDUSD: 'OANDA:AUD_USD',
  USDCAD: 'OANDA:USD_CAD',
  NZDUSD: 'OANDA:NZD_USD',
  USDCHF: 'OANDA:USD_CHF',
};

// Exchange-listed equities/ETFs Finnhub's WS trade feed carries under their raw ticker
// (no OANDA:-style prefix — that's a forex-only convention). Neither symbol is on Deriv's
// public tick API, so Finnhub is the only 24/7 source for them.
//   UUP    — real dollar-index ETF, exact 1:1 coverage.
//   USOIL  — broker CFD, not a single listed ticker. USO (WTI crude ETF) is the closest
//            real-time, no-signup proxy; it tracks spot crude closely but won't be
//            byte-for-byte identical to a broker's exact CFD print.
const DEFAULT_EQUITY_SYMBOL_MAP = {
  UUP: 'UUP',
  USOIL: 'USO',
};

const TF_TO_FINNHUB_RESOLUTION = {
  M1: '1', M5: '5', M15: '15', M30: '30',
  H1: '60', H4: '60',
  D1: 'D', W1: 'W',
};

const CANDLE_ACCESS_BLOCK_MS = 24 * 3600 * 1000;

class FinnhubFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.FINNHUB_API_KEY || '';
    this.cacheMs = Number(config.cacheMs || process.env.FINNHUB_CACHE_MS || 5 * 60 * 1000);
    this._cache = new Map();
    this._baseUrl = 'https://finnhub.io/api/v1';

    // Candle circuit breaker — see note above.
    this._candleAccessBlockedUntil = null;
    this._candleAccessConfirmed = null;
    this.forexSymbolMap = { ...DEFAULT_FOREX_SYMBOL_MAP, ...(config.forexSymbolMap || {}) };
    this.equitySymbolMap = { ...DEFAULT_EQUITY_SYMBOL_MAP, ...(config.equitySymbolMap || {}) };

    this._ws = null;
    this._wsSymbols = [];
    this._wsReconnectAttempts = 0;
    this._wsBackoffMs = 2000;
    this._wsClosedByUser = false;
    this._wsConnected = false;
    this._reverseMap = null;
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
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  async marketNews(category = 'general') {
    if (!this.apiKey) return [];
    return this._cached(`news:${category}`, async () => (await this._get(`/news?category=${category}`)).body);
  }

  async companyNews(symbol, from, to) {
    if (!this.apiKey) return [];
    const end = to || new Date().toISOString().slice(0, 10);
    const start = from || new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    return this._cached(`company:${symbol}:${start}:${end}`, async () =>
      (await this._get(`/company-news?symbol=${symbol}&from=${start}&to=${end}`)).body
    );
  }

  async economicCalendar(from, to) {
    if (!this.apiKey) return [];
    const start = from || new Date().toISOString().slice(0, 10);
    const end = to || new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    const result = await this._cached(`econ-cal:${start}:${end}`, async () =>
      (await this._get(`/calendar/economic?from=${start}&to=${end}`)).body
    );
    let events = [];
    if (Array.isArray(result)) events = result;
    else if (Array.isArray(result?.economicCalendar)) events = result.economicCalendar;
    else if (Array.isArray(result?.data)) events = result.data;
    else if (result?.error) {
      console.warn(`[FinnhubFeed] economic calendar error: ${result.error}`);
      return [];
    }

    return events
      .map(e => {
        const rawTime = e.time || e.date || e.datetime;
        const time = rawTime ? new Date(rawTime).getTime() : NaN;
        const country = e.country || e.economy || e.region || '';
        const currency = this._countryToCurrency(country) || e.currency || (country.length === 3 ? country : null) || 'USD';
        return {
          name: e.event || e.title || e.name || 'Economic Event',
          currency,
          time,
          impact: e.impact || e.importance || null,
          actual: e.actual ?? null,
          estimate: e.estimate ?? e.forecast ?? null,
          prev: e.prev ?? e.previous ?? null,
          unit: e.unit || '',
          country,
        };
      })
      .filter(e => e.name && Number.isFinite(e.time) && e.time > 0);
  }

  _countryToCurrency(country) {
    if (!country) return null;
    const c = String(country).trim();
    const map = {
      US: 'USD', USA: 'USD', 'United States': 'USD', 'U.S.': 'USD',
      EU: 'EUR', 'Euro Area': 'EUR', 'Eurozone': 'EUR', EMU: 'EUR', Germany: 'EUR', France: 'EUR', Italy: 'EUR', Spain: 'EUR',
      GB: 'GBP', UK: 'GBP', 'United Kingdom': 'GBP', Britain: 'GBP',
      JP: 'JPY', Japan: 'JPY',
      CH: 'CHF', Switzerland: 'CHF',
      CA: 'CAD', Canada: 'CAD',
      AU: 'AUD', Australia: 'AUD',
      NZ: 'NZD', 'New Zealand': 'NZD',
      CN: 'CNY', China: 'CNY',
      HK: 'HKD', 'Hong Kong': 'HKD',
      SG: 'SGD', Singapore: 'SGD',
    };
    return map[c] || map[c.toUpperCase()] || null;
  }

  async _cached(key, loader) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheMs) return hit.value;
    const value = await loader();
    this._cache.set(key, { value, ts: Date.now() });
    if (this._cache.size > 100) this._cache.delete(this._cache.keys().next().value);
    return value;
  }

  candleAccessAvailable() {
    if (this._candleAccessConfirmed === false && this._candleAccessBlockedUntil && Date.now() < this._candleAccessBlockedUntil) {
      return false;
    }
    return true;
  }

  _blockCandleAccess(reason) {
    this._candleAccessConfirmed = false;
    this._candleAccessBlockedUntil = Date.now() + CANDLE_ACCESS_BLOCK_MS;
    console.warn(`[FinnhubFeed] Candle access blocked for 24h — ${reason}. Falling back to whatever other source/cache is configured.`);
  }

  // never throws. Callers should treat an empty array as "fallback unavailable right now", not as a hard error.
  async getLatestCandles(symbol, tf, count = 2) {
    if (!this.apiKey || !this.candleAccessAvailable()) return [];

    const resolution = TF_TO_FINNHUB_RESOLUTION[tf];
    if (!resolution) {
      console.warn(`[FinnhubFeed] No resolution mapping for timeframe ${tf} — skipping fallback fetch`);
      return [];
    }

    if (tf === 'H4') {
      const hourly = await this._fetchCandles(symbol, '60', count * 4 + 4);
      if (!hourly.length) return [];
      return this._aggregateHourly(hourly).slice(-count);
    }

    const raw = await this._fetchCandles(symbol, resolution, count);
    return raw.slice(-count);
  }

  async _fetchCandles(symbol, resolution, count) {
    const tdLikeSymbol = this.forexSymbolMap[symbol] || symbol;
    const now = Math.floor(Date.now() / 1000);
    const resMinutes = resolution === 'D' ? 1440 : resolution === 'W' ? 10080 : Number(resolution);
    const rangeSeconds = resMinutes * 60 * (count + 5);
    const from = now - rangeSeconds;

    try {
      const { status, body } = await this._get(
        `/forex/candle?symbol=${encodeURIComponent(tdLikeSymbol)}&resolution=${resolution}&from=${from}&to=${now}`
      );

      if (status === 403 || body?.error) {
        this._blockCandleAccess(body?.error || `HTTP ${status}`);
        return [];
      }

      if (body?.s !== 'ok' || !Array.isArray(body?.c) || body.c.length === 0) {
        return [];
      }

      this._candleAccessConfirmed = true;
      const out = [];
      for (let i = 0; i < body.c.length; i++) {
        out.push({
          timestamp: body.t[i] * 1000,
          open: body.o[i], high: body.h[i], low: body.l[i], close: body.c[i],
          volume: body.v?.[i] || 0,
          isClosed: true,
        });
      }
      return out;
    } catch (err) {
      console.warn(`[FinnhubFeed] Candle fetch failed for ${symbol} (${resolution}): ${err.message}`);
      return [];
    }
  }

  _aggregateHourly(hourlyCandles) {
    const out = [];
    for (let i = 0; i + 4 <= hourlyCandles.length; i += 4) {
      const group = hourlyCandles.slice(i, i + 4);
      out.push({
        timestamp: group[0].timestamp,
        open: group[0].open,
        close: group[group.length - 1].close,
        high: Math.max(...group.map(c => c.high)),
        low: Math.min(...group.map(c => c.low)),
        volume: group.reduce((sum, c) => sum + (c.volume || 0), 0),
        isClosed: true,
      });
    }
    return out;
  }

  // Used here specifically for FOREX — crypto already has a strictly better source (Binance's own WS: no third-party hop, no key, no per-connection limit) so this is never subscribed for crypto symbols.

  async getCandles(symbol, timeframe = 'H1', limit = 200) {
    if (!this.apiKey) return [];
    const resolution = TF_TO_FINNHUB_RESOLUTION[timeframe] || '60';
    const fhSym = this.forexSymbolMap[symbol] || symbol;
    const now = Math.floor(Date.now() / 1000);
    const span = resolution === 'D' || resolution === 'W' ? 86400 * 400 : 60 * 60 * Math.max(limit * 2, 200);
    const from = now - span;
    try {
      const { status, body } = await this._get(
        `/forex/candle?symbol=${encodeURIComponent(fhSym)}&resolution=${resolution}&from=${from}&to=${now}`
      );
      if (status !== 200 || !body || body.s !== 'ok' || !Array.isArray(body.c)) return [];
      const out = [];
      for (let i = 0; i < body.c.length; i++) {
        out.push({
          open: Number(body.o[i]), high: Number(body.h[i]), low: Number(body.l[i]), close: Number(body.c[i]),
          volume: Number(body.v?.[i]) || 0, timestamp: Number(body.t[i]) * 1000, isClosed: true, source: 'finnhub',
        });
      }
      return out.slice(-limit);
    } catch (_) {
      return [];
    }
  }

  // Forex pairs use the OANDA:-prefixed map; equities/ETFs (UUP, USOIL→USO) use their raw
  // ticker. Merged here so callers/WS subscribe/reverse-lookup all see one symbol space.
  _wsSymbolMap() {
    return { ...this.forexSymbolMap, ...this.equitySymbolMap };
  }

  connectPriceStream(symbols = []) {
    if (!this.apiKey) {
      console.warn('[FinnhubFeed] connectPriceStream: no apiKey configured, skipping');
      return;
    }
    const symbolMap = this._wsSymbolMap();
    this._wsSymbols = symbols.filter(s => symbolMap[s]);
    if (!this._wsSymbols.length) {
      console.warn('[FinnhubFeed] connectPriceStream: none of the requested symbols have a forex/equity symbol map entry');
      return;
    }
    this._wsClosedByUser = false;
    this._openWs();
  }

  disconnectPriceStream() {
    this._wsClosedByUser = true;
    this._wsConnected = false;
    if (this._ws) {
      try { this._ws.close(); } catch (_) { }
      this._ws = null;
    }
  }

  isConnected() {
    if (!this.apiKey) return false;
    return true;
  }

  _openWs() {
    this._ws = new WebSocket(`wss://ws.finnhub.io?token=${this.apiKey}`);

    this._ws.on('open', () => {
      this._wsReconnectAttempts = 0;
      this._wsBackoffMs = 2000;
      this._wsConnected = true;
      const symbolMap = this._wsSymbolMap();
      for (const sym of this._wsSymbols) {
        this._ws.send(JSON.stringify({ type: 'subscribe', symbol: symbolMap[sym] }));
      }
      console.log(`[FinnhubFeed] Price stream connected for: ${this._wsSymbols.join(', ')}`);
      this.emit('connected');
    });

    this._ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;
      const reverse = this._reverseSymbolMap();
      for (const trade of msg.data) {
        const omniceeSymbol = reverse[trade.s];
        if (!omniceeSymbol || trade.p == null) continue;
        this.emit('price', { symbol: omniceeSymbol, price: Number(trade.p), timestamp: trade.t || Date.now() });
      }
    });

    this._ws.on('error', err => {
      console.warn(`[FinnhubFeed] Price stream error: ${err.message}`);
      this.emit('error', err);
    });

    this._ws.on('close', () => {
      this._wsConnected = false;
      if (this._wsClosedByUser) return;
      this._wsBackoffMs = Math.min(this._wsBackoffMs * 1.6, 60000);
      this._wsReconnectAttempts++;
      console.log(`[FinnhubFeed] Price stream disconnected — reconnecting in ${Math.round(this._wsBackoffMs)}ms (attempt ${this._wsReconnectAttempts})`);
      setTimeout(() => this._openWs(), this._wsBackoffMs);
    });
  }

  _reverseSymbolMap() {
    if (!this._reverseMap) {
      this._reverseMap = {};
      for (const [omniceeSymbol, finnhubSymbol] of Object.entries(this._wsSymbolMap())) {
        this._reverseMap[finnhubSymbol] = omniceeSymbol;
      }
    }
    return this._reverseMap;
  }
}

module.exports = { FinnhubFeed };
