'use strict';

const https = require('https');
const EventEmitter = require('events');
let WebSocket = null;
try { WebSocket = require('ws'); } catch { WebSocket = null; }

/**
 * ============================================================
 *  FINNHUB FEED — News/calendar client, extended with a real
 *  forex/gold candle feed (Layer 10 data feed, alternative to
 *  feeds/twelve-data.js for FX symbols).
 *  File: feeds/finnhub-feed.js
 * ============================================================
 *
 *  Why: TwelveData's free tier is 8 requests/minute (800/day) —
 *  this codebase already has to work hard (QuotaManager, careful
 *  history-load pacing) just to stay under that. Finnhub's free
 *  tier is ~60 calls/minute with a real API key — roughly 7x the
 *  headroom — and this file already had a live, working API key
 *  configured for news/economic-calendar, just unused for prices.
 *
 *  This class does double duty:
 *   - Unchanged: marketNews() / companyNews() / economicCalendar(),
 *     used exactly as before wherever `finnhubFeed` already exists.
 *   - New, opt-in: pass `symbols`/`timeframes`/`db` in the config
 *     and it also becomes a candle feed with the same EventEmitter
 *     shape as TwelveDataFeed (`connect()`, 'candle'/'candle_update'
 *     /'price'/'connected'/'error', `.candleStore.get()`), so it
 *     drops into index.js's feed-wiring loop the same way. A plain
 *     `new FinnhubFeed({ apiKey })` with no symbols behaves exactly
 *     as before — nothing about the existing news-only usage changes.
 *
 *  Symbol format: Finnhub's forex candle endpoint expects broker-
 *  prefixed symbols, e.g. "OANDA:EUR_USD" — confirmed against
 *  Finnhub's own official client libraries (Python/Go/JS/Elixir),
 *  not just third-party docs. Canonical 'EURUSD' -> 'OANDA:EUR_USD'.
 *
 *  Resolutions: Finnhub natively supports 1, 5, 15, 30, 60, D, W, M
 *  (minutes, or D/W/M) — there's no native 4-hour resolution. H4 (and
 *  other H-multiples) are built here by fetching H1 (resolution '60')
 *  and aggregating client-side into UTC-aligned N-hour buckets.
 *
 *  Rate limiting: a simple rolling 60s-window counter keeps this
 *  under FINNHUB_MAX_REQUESTS_PER_MIN (default 50, leaving margin
 *  under the free tier's ~60/min) — same spirit as twelve-data.js's
 *  QuotaManager, just local to this file.
 * ============================================================
 */

const NATIVE_RESOLUTION = { M1: '1', M5: '5', M15: '15', M30: '30', H1: '60', D1: 'D', W1: 'W' };
const AGGREGATE_FROM = {
  H2: { base: 'H1', factor: 2 }, H4: { base: 'H1', factor: 4 },
  H8: { base: 'H1', factor: 8 }, H12: { base: 'H1', factor: 12 },
};
const TF_MS = { H1: 3600e3 };
const MAX_CANDLE_HISTORY = 500;
const DEFAULT_POLL_MS = 20000; // per symbol+resolution — see rate limiter below
const DEFAULT_MAX_REQ_PER_MIN = 50;

function toFinnhubForex(symbol) {
  const s = symbol.toUpperCase();
  return s.length === 6 ? `OANDA:${s.slice(0, 3)}_${s.slice(3)}` : `OANDA:${s}`;
}

// ── same-shape candle store as the other feed modules
class FinnhubCandleStore {
  constructor() { this._store = new Map(); }
  key(symbol, tf) { return `${symbol}_${tf}`; }
  get(symbol, tf) { return this._store.get(this.key(symbol, tf)) || []; }
  set(symbol, tf, candles) { this._store.set(this.key(symbol, tf), candles.slice(-MAX_CANDLE_HISTORY)); }
  upsertLast(symbol, tf, candle) {
    const k = this.key(symbol, tf);
    const arr = this._store.get(k) || [];
    const last = arr[arr.length - 1];
    if (last && last.timestamp === candle.timestamp) arr[arr.length - 1] = candle;
    else arr.push(candle);
    if (arr.length > MAX_CANDLE_HISTORY) arr.shift();
    this._store.set(k, arr);
    return arr;
  }
  size() { let n = 0; for (const arr of this._store.values()) n += arr.length; return n; }
}

// ── rolling 60s-window request limiter, same spirit as twelve-data.js's QuotaManager
class RollingRateLimiter {
  constructor(maxPerMinute = DEFAULT_MAX_REQ_PER_MIN) {
    this.max = maxPerMinute;
    this._timestamps = [];
  }
  canGo() {
    const cutoff = Date.now() - 60000;
    this._timestamps = this._timestamps.filter(t => t > cutoff);
    return this._timestamps.length < this.max;
  }
  record() { this._timestamps.push(Date.now()); }
  msUntilNextSlot() {
    if (this.canGo()) return 0;
    const oldest = this._timestamps[0];
    return Math.max(0, 60000 - (Date.now() - oldest)) + 50;
  }
}

/** Aggregate consecutive base candles into larger UTC-aligned buckets. */
function aggregateCandles(baseCandles, factor, baseMs) {
  const bucketMs = baseMs * factor;
  const buckets = new Map();
  for (const c of baseCandles) {
    const bucketStart = Math.floor(c.timestamp / bucketMs) * bucketMs;
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, { timestamp: bucketStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume || 0;
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
}

class FinnhubFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.FINNHUB_API_KEY || '';
    this.cacheMs = Number(config.cacheMs || process.env.FINNHUB_CACHE_MS || 5 * 60 * 1000);
    this._cache = new Map();
    this._baseUrl = 'https://finnhub.io/api/v1';

    // Candle-feed mode — inert unless symbols are provided.
    this.symbols = config.symbols || [];
    this.timeframes = config.timeframes || [];
    this.db = config.db || null;
    this.candleStore = new FinnhubCandleStore();
    this._prices = new Map();
    this._closed = false;
    this._ws = null;
    this._wsReconnectAttempts = 0;
    this._pollTimers = [];
    this._limiter = new RollingRateLimiter(Number(process.env.FINNHUB_MAX_REQUESTS_PER_MIN || DEFAULT_MAX_REQ_PER_MIN));
    this._stats = { candlesEmitted: 0, ticksReceived: 0, errorsCount: 0, startTime: null };
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
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  /** Rate-limited GET — waits for a free slot in the rolling 60s window. */
  async _getLimited(path) {
    while (!this._limiter.canGo()) {
      await new Promise(r => setTimeout(r, this._limiter.msUntilNextSlot()));
    }
    this._limiter.record();
    return this._get(path);
  }

  async marketNews(category = 'general') {
    if (!this.apiKey) return [];
    return this._cached(`news:${category}`, () => this._get(`/news?category=${category}`));
  }

  async companyNews(symbol, from, to) {
    if (!this.apiKey) return [];
    const end = to || new Date().toISOString().slice(0, 10);
    const start = from || new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    return this._cached(`company:${symbol}:${start}:${end}`, () =>
      this._get(`/company-news?symbol=${symbol}&from=${start}&to=${end}`)
    );
  }

  // FIX: added — this was the missing real data source for
  // risk-engine/session-filter.js's EconomicCalendarTierSystem, which had a
  // fully-built blackout/pre-event size-reduction gate but nothing ever
  // called addNewsEvents() with real events, so it silently reported "CLEAR"
  // 100% of the time. Finnhub's /calendar/economic endpoint returns
  // scheduled macro releases (NFP, CPI, rate decisions, etc.) for a date
  // range, which is exactly what that gate needs.
  async economicCalendar(from, to) {
    if (!this.apiKey) return [];
    const start = from || new Date().toISOString().slice(0, 10);
    const end = to || new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10);
    const result = await this._cached(`econ-cal:${start}:${end}`, () =>
      this._get(`/calendar/economic?from=${start}&to=${end}`)
    );
    const events = Array.isArray(result?.economicCalendar) ? result.economicCalendar : [];
    // Normalize to the {name, currency, time, tier} shape EconomicCalendarTierSystem expects
    return events
      .filter(e => e.time && e.country)
      .map(e => ({
        name: e.event || 'Economic Event',
        currency: this._countryToCurrency(e.country),
        time: new Date(e.time).getTime(),
        impact: e.impact || null,          // Finnhub: 'low' | 'medium' | 'high'
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
      China: 'USD', // CNY events mostly move USD-pairs/risk sentiment in practice
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

  // ── Candle feed (opt-in) ────────────────────────────────────────────

  async connect() {
    if (!this.symbols.length) return; // news-only instance — nothing to start
    this._stats.startTime = Date.now();
    await this._pollAll();
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        const intervalMs = Number(process.env.FINNHUB_POLL_MS || DEFAULT_POLL_MS);
        this._pollTimers.push(setInterval(() => this._pollOne(symbol, tf).catch((err) => {
          this._stats.errorsCount++;
          this.emit('error', { source: 'poll', symbol, tf, error: err });
        }), intervalMs));
      }
    }
    this._connectWebSocket();
    this.emit('connected', { mode: 'POLL+WS' });
  }

  async _pollAll() {
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        try { await this._pollOne(symbol, tf); }
        catch (err) {
          this._stats.errorsCount++;
          this.emit('error', { source: 'preload', symbol, tf, error: err });
        }
      }
    }
  }

  /** Fetch (or aggregate) candles for one symbol+timeframe and emit updates. */
  async _pollOne(symbol, tf) {
    const candles = await this._fetchCandles(symbol, tf);
    if (!candles.length) return;
    this.candleStore.set(symbol, tf, candles);
    this._stats.candlesEmitted += candles.length;
    const latest = candles[candles.length - 1];
    this._prices.set(symbol, latest.close);
    if (this.db) this.db.saveCandleHistory('finnhub', symbol, tf, candles).catch(() => {});
    this.emit('candle', { symbol, timeframe: tf, candle: latest, candles: [...candles], timestamp: Date.now() });
  }

  async _fetchCandles(symbol, tf) {
    if (NATIVE_RESOLUTION[tf]) return this._fetchNativeCandles(symbol, tf);
    const agg = AGGREGATE_FROM[tf];
    if (agg) {
      const base = await this._fetchNativeCandles(symbol, agg.base);
      return aggregateCandles(base, agg.factor, TF_MS[agg.base] || 3600e3);
    }
    // Unrecognized timeframe — fall back to H1 as the closest sane default
    // rather than silently returning nothing.
    return this._fetchNativeCandles(symbol, 'H1');
  }

  async _fetchNativeCandles(symbol, tf) {
    const resolution = NATIVE_RESOLUTION[tf] || '60';
    const instrument = toFinnhubForex(symbol);
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 24 * 30; // 30 days back is ample for MAX_CANDLE_HISTORY at these resolutions
    const json = await this._getLimited(`/forex/candle?symbol=${encodeURIComponent(instrument)}&resolution=${resolution}&from=${from}&to=${to}`);
    if (json?.s !== 'ok' || !Array.isArray(json.c)) return [];
    const candles = [];
    for (let i = 0; i < json.c.length; i++) {
      candles.push({
        timestamp: json.t[i] * 1000,
        open: json.o[i], high: json.h[i], low: json.l[i], close: json.c[i],
        volume: json.v ? json.v[i] : 0,
      });
    }
    return candles.slice(-MAX_CANDLE_HISTORY);
  }

  /** Best-effort live ticks on top of the REST poll — WebSocket trade stream.
   * Free-tier WebSocket access for forex isn't independently confirmed by
   * Finnhub's own (JS-rendered, unfetchable) docs page as of this writing;
   * this fails silently and harmlessly if the connection is rejected — the
   * REST polling above is what actually keeps candles/prices current. */
  _connectWebSocket() {
    if (!WebSocket || this._closed) return;
    try {
      this._ws = new WebSocket(`wss://ws.finnhub.io?token=${this.apiKey}`);
      this._ws.on('open', () => {
        this._wsReconnectAttempts = 0;
        for (const symbol of this.symbols) {
          this._ws.send(JSON.stringify({ type: 'subscribe', symbol: toFinnhubForex(symbol) }));
        }
      });
      this._ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;
        for (const t of msg.data) {
          const symbol = this.symbols.find(s => toFinnhubForex(s) === t.s);
          if (!symbol) continue;
          this._stats.ticksReceived++;
          this._prices.set(symbol, t.p);
          this.emit('price', { symbol, price: t.p, timestamp: t.t || Date.now() });
        }
      });
      this._ws.on('error', () => { /* silent — REST polling remains the source of truth */ });
      this._ws.on('close', () => {
        if (this._closed) return;
        this._wsReconnectAttempts++;
        const delay = Math.min(2000 * 2 ** this._wsReconnectAttempts, 60000);
        setTimeout(() => this._connectWebSocket(), delay);
      });
    } catch {
      // WebSocket unavailable on this tier/route — REST polling still works.
    }
  }

  getPrice(symbol) { return this._prices.get(symbol) || null; }
  getCandles(symbol, tf) { return this.candleStore.get(symbol, tf); }
  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return { ...this._stats, uptime, symbols: this.symbols, candleCount: this.candleStore.size(), prices: Object.fromEntries(this._prices) };
  }
  disconnect() {
    this._closed = true;
    for (const t of this._pollTimers) clearInterval(t);
    if (this._ws) { try { this._ws.close(); } catch {} }
    this.emit('closed');
  }
}

module.exports = { FinnhubFeed, FinnhubCandleStore, toFinnhubForex, aggregateCandles };
