'use strict';
const https = require('https');
const EventEmitter = require('events');
const WebSocket = require('ws');

// ─────────────────────────────────────────────
//  CANDLE SUPPORT — ADDED
// ─────────────────────────────────────────────
//
// Finnhub's free tier restricts intraday/historical candle endpoints on
// STOCK symbols (confirmed: returns 403 "You don't have access to this
// resource"). Whether that same restriction applies to /forex/candle for
// non-stock symbols was NOT confirmed while writing this — Finnhub's
// public docs list forex_candles as a real endpoint, but multiple
// third-party summaries only specifically call out STOCK candles as
// premium-gated. Treat this as unverified: the circuit breaker below
// means if your account also gets a 403 here, the feed disables itself
// cleanly after one failed attempt rather than burning further requests
// or spamming logs — but you should confirm access on your own Finnhub
// plan before relying on this in production.
//
// Symbol format is ALSO unverified for gold/commodities specifically —
// Finnhub forex candles expect broker-prefixed symbols like
// 'OANDA:XAU_USD', taken from their own /forex/symbol?exchange=oanda
// lookup. The defaults below are best-effort guesses. Override via
// config.forexSymbolMap if your account's actual symbol list differs.
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

// Finnhub candle 'resolution' values: 1, 5, 15, 30, 60, D, W, M.
// There is no native 4-hour resolution — H4 is served by fetching 60min
// candles and aggregating 4 at a time (see _aggregateHourly()).
const TF_TO_FINNHUB_RESOLUTION = {
  M1: '1', M5: '5', M15: '15', M30: '30',
  H1: '60', H4: '60', // H4 aggregated from 60min, see getLatestCandles()
  D1: 'D', W1: 'W',
};

const CANDLE_ACCESS_BLOCK_MS = 24 * 3600 * 1000; // stop retrying for 24h after a confirmed 403

class FinnhubFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.FINNHUB_API_KEY || '';
    this.cacheMs = Number(config.cacheMs || process.env.FINNHUB_CACHE_MS || 5 * 60 * 1000);
    this._cache = new Map();
    this._baseUrl = 'https://finnhub.io/api/v1';

    // Candle circuit breaker — see note above. Null until we know either way.
    this._candleAccessBlockedUntil = null;
    this._candleAccessConfirmed = null; // true | false | null (unknown)
    this.forexSymbolMap = { ...DEFAULT_FOREX_SYMBOL_MAP, ...(config.forexSymbolMap || {}) };

    // Live price stream (WS) state — see connectPriceStream() below.
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

  // Real macro-release data for EconomicCalendarTierSystem's blackout/
  // pre-event size-reduction gate — unchanged from before.
  async economicCalendar(from, to) {
    if (!this.apiKey) return [];
    const start = from || new Date().toISOString().slice(0, 10);
    const end = to || new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    const result = await this._cached(`econ-cal:${start}:${end}`, async () =>
      (await this._get(`/calendar/economic?from=${start}&to=${end}`)).body
    );
    const events = Array.isArray(result?.economicCalendar) ? result.economicCalendar : [];
    return events
      .filter(e => e.time && e.country)
      .map(e => ({
        name: e.event || 'Economic Event',
        currency: this._countryToCurrency(e.country),
        time: new Date(e.time).getTime(),
        impact: e.impact || null,
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        prev: e.prev ?? null,
        unit: e.unit || '',
      }))
      .filter(e => e.currency && Number.isFinite(e.time));
  }

  _countryToCurrency(country) {
    const map = {
      US: 'USD', EU: 'EUR', 'United States': 'USD', 'Euro Area': 'EUR',
      GB: 'GBP', UK: 'GBP', JP: 'JPY', CH: 'CHF', CA: 'CAD', AU: 'AUD', NZ: 'NZD',
      China: 'USD',
    };
    return map[country] || null;
  }

  async _cached(key, loader) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheMs) return hit.value;
    const value = await loader();
    this._cache.set(key, { value, ts: Date.now() });
    if (this._cache.size > 100) this._cache.delete(this._cache.keys().next().value);
    return value;
  }

  // ── Candle access (fallback data source for a rate-limited primary feed) ──

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

  /**
   * Fetch the most recent `count` candles for a symbol/timeframe, returned
   * in the same normalized shape TwelveDataFeed uses:
   * { timestamp, open, high, low, close, volume, isClosed }
   *
   * Returns [] on any failure (no access, no data, network error) — never
   * throws. Callers should treat an empty array as "fallback unavailable
   * right now", not as a hard error.
   */
  async getLatestCandles(symbol, tf, count = 2) {
    if (!this.apiKey || !this.candleAccessAvailable()) return [];

    const resolution = TF_TO_FINNHUB_RESOLUTION[tf];
    if (!resolution) {
      console.warn(`[FinnhubFeed] No resolution mapping for timeframe ${tf} — skipping fallback fetch`);
      return [];
    }

    // H4 has no native resolution — pull enough 60min candles and aggregate.
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
    // Pull a comfortable multiple of `count` candles worth of range —
    // resolution is in minutes except 'D'/'W'.
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
        // 'no_data' or malformed — not necessarily a permissions problem,
        // could just be an unmapped/unsupported symbol. Don't trip the
        // circuit breaker for this, just return empty.
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

  // ─────────────────────────────────────────────
  //  LIVE PRICE STREAM (WebSocket) — ADDED
  // ─────────────────────────────────────────────
  //
  // Separate from the REST candle machinery above, which is 403-gated on
  // an unconfirmed basis (see the note at the top of this file) — this
  // path is confirmed free-tier per Finnhub's own docs (finnhub.io/docs/
  // api/websocket-trades): real-time trade streaming, "1 API key can only
  // open 1 connection at a time" is the only stated constraint, no
  // paid-plan gate. Used here specifically for FOREX — crypto already has
  // a strictly better source (Binance's own WS: no third-party hop, no
  // key, no per-connection limit) so this is never subscribed for crypto
  // symbols. Finnhub's docs also note some FX brokers don't support
  // streaming (FXCM, Forex.com, FHFX) — the default forexSymbolMap above
  // uses OANDA-sourced symbols, which isn't on that exclusion list, but
  // this is genuinely a supplementary tick source layered on top of
  // TwelveData's own polling, not a replacement for it — TwelveData
  // remains the source of the OHLC candles the agents actually analyze;
  // this only feeds the live price ticker (see the 'price' event below).
  connectPriceStream(symbols = []) {
    if (!this.apiKey) {
      console.warn('[FinnhubFeed] connectPriceStream: no apiKey configured, skipping');
      return;
    }
    this._wsSymbols = symbols.filter(s => this.forexSymbolMap[s]);
    if (!this._wsSymbols.length) {
      console.warn('[FinnhubFeed] connectPriceStream: none of the requested symbols have a forexSymbolMap entry');
      return;
    }
    this._wsClosedByUser = false;
    this._openWs();
  }

  disconnectPriceStream() {
    this._wsClosedByUser = true;
    this._wsConnected = false;
    if (this._ws) {
      try { this._ws.close(); } catch (_) { /* already closed */ }
      this._ws = null;
    }
  }

  /** DataIntegrityMonitor calls this (see feeds/data-integrity-monitor.js) —
   * without it, this feed's status was indistinguishable from "not tracked"
   * and always rendered as an ambiguous unknown/down state regardless of
   * whether the price stream was actually up. */
  isConnected() {
    if (!this.apiKey) return false;
    return this._wsConnected === true;
  }

  _openWs() {
    this._ws = new WebSocket(`wss://ws.finnhub.io?token=${this.apiKey}`);

    this._ws.on('open', () => {
      this._wsReconnectAttempts = 0;
      this._wsBackoffMs = 2000;
      this._wsConnected = true;
      for (const sym of this._wsSymbols) {
        this._ws.send(JSON.stringify({ type: 'subscribe', symbol: this.forexSymbolMap[sym] }));
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
        // volume 0 means "price update, no actual trade" per Finnhub's own
        // docs — still a real, usable price tick, not fabricated data.
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
      for (const [omniceeSymbol, finnhubSymbol] of Object.entries(this.forexSymbolMap)) {
        this._reverseMap[finnhubSymbol] = omniceeSymbol;
      }
    }
    return this._reverseMap;
  }
}

module.exports = { FinnhubFeed };
