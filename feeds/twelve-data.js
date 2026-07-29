/**
 * ============================================================
 *  TWELVE DATA FEED — Forex, Stocks, Indices, Commodities
 *  AI Trading Assistant · Layer 10 · Data Feed Module
 *  File: feeds/twelve-data.js
 * ============================================================
 *
 *  Twelve Data covers what Binance/Bybit can't: forex pairs,
 *  individual stocks, stock indices, and commodities (oil, gas)
 *  via a unified REST + WebSocket API.
 *
 *  Modules inside this file:
 *
 *  1. QuotaManager
 *     - Tracks BOTH the per-minute rate limit (free tier: 8/min)
 *       AND the per-day cap (free tier: 800/day). The per-minute
 *       throttle alone is not enough — a live poll loop running
 *       24/7 can stay perfectly within 8/min and still blow past
 *       800/day in a couple of hours. See the daily-cap fix below.
 *
 *  2. TDCandleStore
 *     - Multi-symbol, multi-timeframe OHLCV store identical
 *       shape to BinanceFeed's CandleStore so SMC/MTF/Momentum
 *       agents don't need symbol-source-aware branching.
 *
 *  3. TDWebSocketEngine
 *     - Real-time price streaming via Twelve Data's WS endpoint
 *       (available on paid tiers; gracefully degrades to REST
 *       polling on free tier — this is handled transparently).
 *
 *  4. TDRESTPoller
 *     - Polls REST time_series + quote endpoints on an interval
 *       respecting QuotaManager. Used for historical preload AND
 *       as the live-data fallback when WS isn't available/paid.
 *
 *  5. TDMarketStateEngine
 *     - Tracks market hours per exchange (forex 24/5, NYSE/NASDAQ
 *       cash session, LSE, commodities) so the rest of the system
 *       knows whether a "stale" price is expected (market closed)
 *       or a real feed problem.
 *
 *  6. TDEarningsCalendar
 *     - For stock symbols: tracks upcoming earnings dates —
 *       critical blackout info that session-filter.js's economic
 *       calendar doesn't cover (company-specific, not macro).
 *
 *  7. TDSymbolResolver
 *     - Normalizes symbol formats across forex (EUR/USD vs EURUSD),
 *       stocks (AAPL), indices (SPX vs ^GSPC vs US500), and
 *       commodities (WTI/USD vs CL=F) into one canonical form.
 *
 *  8. TwelveDataFeed (main class)
 *     - Same EventEmitter API shape as BinanceFeed/BybitFeed:
 *       'candle', 'candle_update', 'price', 'connected', etc.
 *     - NEW: every configured timeframe now gets its own live
 *       refresh cycle (previously only the single lowest
 *       timeframe was ever re-checked after boot — H1/H4/D1
 *       candles loaded once at preload and then silently went
 *       stale for the life of the process).
 *     - NEW: optional config.fallbackFeed (e.g. a FinnhubFeed
 *       instance) is used for live candle data once the daily
 *       Twelve Data quota is exhausted, instead of immediately
 *       falling all the way back to a potentially many-hours-old
 *       Mongo cache entry.
 * ============================================================
 */

'use strict';

const https        = require('https');
const EventEmitter = require('events');

let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = null; }

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const TD_REST_BASE = 'https://api.twelvedata.com';
const TD_WS_BASE    = 'wss://ws.twelvedata.com/v1/quotes/price';

const TIMEFRAMES = {
  M1: '1min', M5: '5min', M15: '15min', M30: '30min',
  H1: '1h', H2: '2h', H4: '4h', H8: '8h',
  D1: '1day', W1: '1week', MN: '1month',
};

// Minutes-per-candle for each timeframe — used to pace live polling to the
// timeframe's own candle-close interval instead of a single fixed cadence.
const TF_MINUTES = {
  M1: 1, M5: 5, M15: 15, M30: 30,
  H1: 60, H2: 120, H4: 240, H6: 360, H8: 480, H12: 720,
  D1: 1440, W1: 10080,
};

const MAX_CANDLE_HISTORY = 500;
const HISTORY_LOAD_DELAY_MS = 8000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Free tier defaults — override via config.requestsPerMinute /
// config.requestsPerDay for paid tiers (paid tiers effectively have no
// daily cap; pass a very large number, e.g. Infinity, to disable it).
const DEFAULT_REQUESTS_PER_MINUTE = 8;
const DEFAULT_REQUESTS_PER_DAY = 800;
const QUOTA_SAFETY_MARGIN = 0.85;       // per-minute: use 85% of stated quota
const DAILY_SAFETY_MARGIN = 0.9;        // per-day: use 90%, leaving headroom for /quote calls etc.

const RECONNECT_BASE_DELAY = 2000;
const MAX_RECONNECT_ATTEMPTS = 20;
const HEARTBEAT_INTERVAL = 30000;

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────

function round(n, d = 5) { return parseFloat((n ?? 0).toFixed(d)); }

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse response: ${data.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────
//  1. QUOTA MANAGER
// ─────────────────────────────────────────────

class QuotaManager {
  /**
   * Tracks API call usage against BOTH a per-minute rate limit and a
   * per-day cap, and queues requests so the feed degrades gracefully
   * instead of throwing 429s or (worse) silently exceeding a daily quota
   * that doesn't reset for hours.
   */
  constructor(requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE, requestsPerDay = DEFAULT_REQUESTS_PER_DAY) {
    this.limit = Math.floor(requestsPerMinute * QUOTA_SAFETY_MARGIN);
    this.dailyLimit = Number.isFinite(requestsPerDay)
      ? Math.floor(requestsPerDay * DAILY_SAFETY_MARGIN)
      : Infinity;
    this._callLog = [];      // timestamps, last 60s
    this._dailyCallLog = []; // timestamps, last 24h
    this._queue = [];
    this._processing = false;
  }

  canCall() {
    this._prune();
    return this._callLog.length < this.limit && this._canCallToday();
  }

  _canCallToday() {
    this._pruneDaily();
    return this._dailyCallLog.length < this.dailyLimit;
  }

  _prune() {
    const cutoff = Date.now() - 60000;
    this._callLog = this._callLog.filter(t => t > cutoff);
  }

  _pruneDaily() {
    const cutoff = Date.now() - 86400000;
    this._dailyCallLog = this._dailyCallLog.filter(t => t > cutoff);
  }

  /**
   * Schedule a function to run respecting quota. Returns a Promise that
   * resolves with the function's result whenever quota allows execution,
   * or rejects immediately (no queueing) if the DAILY quota is already
   * exhausted — waiting for a reset that could be many hours away isn't
   * useful for a live-polling loop, so callers get a fast, typed failure
   * (err.tdCode === 'DAILY_QUOTA_EXCEEDED') and can fall back immediately.
   */
  schedule(fn) {
    return new Promise((resolve, reject) => {
      if (!this._canCallToday()) {
        const err = new Error('Twelve Data daily quota exhausted — request skipped');
        err.tdCode = 'DAILY_QUOTA_EXCEEDED';
        return reject(err);
      }
      this._queue.push({ fn, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;

    while (this._queue.length > 0) {
      if (!this._canCallToday()) {
        // Daily budget ran out while jobs were queued (e.g. several
        // symbols queued back-to-back near the boundary) — fail the rest
        // fast rather than hold them until tomorrow.
        while (this._queue.length > 0) {
          const job = this._queue.shift();
          const err = new Error('Twelve Data daily quota exhausted — request skipped');
          err.tdCode = 'DAILY_QUOTA_EXCEEDED';
          job.reject(err);
        }
        break;
      }

      if (!this.canCall()) {
        const oldestCall = this._callLog[0];
        const waitMs = Math.max(0, 60000 - (Date.now() - oldestCall)) + 100;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      const job = this._queue.shift();
      this._callLog.push(Date.now());
      this._dailyCallLog.push(Date.now());

      try {
        const result = await job.fn();
        job.resolve(result);
      } catch (err) {
        job.reject(err);
      }

      // Small stagger between calls even within quota, to be a good API citizen
      await new Promise(r => setTimeout(r, 250));
    }

    this._processing = false;
  }

  getStats() {
    this._prune();
    this._pruneDaily();
    return {
      limit: this.limit,
      used: this._callLog.length,
      remaining: Math.max(0, this.limit - this._callLog.length),
      queueDepth: this._queue.length,
      dailyLimit: this.dailyLimit,
      dailyUsed: this._dailyCallLog.length,
      dailyRemaining: Number.isFinite(this.dailyLimit) ? Math.max(0, this.dailyLimit - this._dailyCallLog.length) : Infinity,
    };
  }
}

// ─────────────────────────────────────────────
//  2. CANDLE STORE
// ─────────────────────────────────────────────

class TDCandleStore {
  constructor() {
    this._store = new Map();
  }

  key(symbol, tf) { return `${symbol}_${tf}`; }

  upsert(symbol, tf, candle) {
    const k = this.key(symbol, tf);
    if (!this._store.has(k)) this._store.set(k, []);
    const arr = this._store.get(k);

    if (arr.length > 0 && arr[arr.length - 1].timestamp === candle.timestamp) {
      arr[arr.length - 1] = candle;
    } else {
      arr.push(candle);
      if (arr.length > MAX_CANDLE_HISTORY) arr.splice(0, arr.length - MAX_CANDLE_HISTORY);
    }
    return arr;
  }

  bulkLoad(symbol, tf, candles) {
    const k = this.key(symbol, tf);
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    this._store.set(k, sorted.slice(-MAX_CANDLE_HISTORY));
    return this._store.get(k);
  }

  get(symbol, tf) { return this._store.get(this.key(symbol, tf)) || []; }
  size() { let t = 0; for (const a of this._store.values()) t += a.length; return t; }
}

// ─────────────────────────────────────────────
//  3. SYMBOL RESOLVER
// ─────────────────────────────────────────────

class TDSymbolResolver {
  static toCanonical(symbol) {
    return symbol.replace('/', '').toUpperCase();
  }

  static toTwelveDataFormat(symbol, assetType = null) {
    const type = assetType || this.inferType(symbol);

    if (type === 'forex') {
      const known = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
      for (const base of known) {
        if (symbol.startsWith(base)) {
          const quote = symbol.slice(base.length);
          if (known.includes(quote)) return `${base}/${quote}`;
        }
      }
      return symbol;
    }

    if (type === 'commodity') {
      const map = { XAUUSD: 'XAU/USD', XAGUSD: 'XAG/USD', WTIUSD: 'WTI/USD', USOIL: 'WTI/USD', BRENTUSD: 'BRENT/USD' };
      return map[symbol] || symbol;
    }

    return symbol;
  }

  static inferType(symbol) {
    const forexCurrencies = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
    const isForexPair = forexCurrencies.some(c => symbol.startsWith(c)) &&
      forexCurrencies.some(c => symbol.endsWith(c)) && symbol.length === 6;

    if (isForexPair) return 'forex';
    if (['XAUUSD','XAGUSD','WTIUSD','USOIL','BRENTUSD','NATGASUSD'].includes(symbol)) return 'commodity';
    if (['SPX','NDX','DJI','UK100','GER40','US500','US30','US100'].includes(symbol)) return 'index';
    return 'stock';
  }
}

// ─────────────────────────────────────────────
//  4. MARKET STATE ENGINE
// ─────────────────────────────────────────────

class TDMarketStateEngine {
  static isOpen(symbol, timestamp) {
    const type = TDSymbolResolver.inferType(symbol);
    const d = new Date(timestamp || Date.now());
    const utcDay = d.getUTCDay();
    const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;

    if (type === 'forex' || type === 'commodity') {
      const isFridayAfterClose = utcDay === 5 && utcHour >= 21;
      const isSaturday = utcDay === 6;
      const isSundayBeforeOpen = utcDay === 0 && utcHour < 21;
      return { open: !(isFridayAfterClose || isSaturday || isSundayBeforeOpen), type, note: 'Forex/commodities trade ~24/5' };
    }

    if (type === 'stock' || type === 'index') {
      const isWeekday = utcDay >= 1 && utcDay <= 5;
      const inHours = utcHour >= 13.5 && utcHour < 20;
      return {
        open: isWeekday && inHours, type,
        note: 'US cash session 13:30-20:00 UTC, Mon-Fri (holidays not accounted for here — see session-filter.js)',
      };
    }

    return { open: true, type, note: 'Unknown type — assuming open' };
  }
}

// ─────────────────────────────────────────────
//  5. EARNINGS CALENDAR
// ─────────────────────────────────────────────

class TDEarningsCalendar {
  constructor() {
    this._earnings = new Map();
  }

  set(symbol, earningsData) {
    this._earnings.set(symbol.toUpperCase(), earningsData);
  }

  get(symbol) {
    return this._earnings.get(symbol.toUpperCase()) || null;
  }

  isNearEarnings(symbol, daysWindow = 2) {
    const data = this.get(symbol);
    if (!data?.date) return { near: false };

    const earningsDate = new Date(data.date).getTime();
    const now = Date.now();
    const daysAway = (earningsDate - now) / 86400000;

    return {
      near: daysAway >= -1 && daysAway <= daysWindow,
      daysAway: round(daysAway, 1),
      date: data.date,
      time: data.time,
      note: daysAway >= 0 && daysAway <= daysWindow
        ? `Earnings in ${round(daysAway,1)} days (${data.time || 'time unknown'}) — expect elevated IV and gap risk`
        : daysAway < 0 && daysAway >= -1
          ? 'Earnings just reported — post-earnings volatility window'
          : null,
    };
  }

  async fetchUpcoming(symbol, apiKey) {
    try {
      const url = `${TD_REST_BASE}/earnings?symbol=${symbol}&apikey=${apiKey}`;
      const result = await httpGetJSON(url);
      const next = result?.earnings?.[0];
      if (next) {
        this.set(symbol, { date: next.date, time: next.time, estimate: next.eps_estimate });
      }
      return next || null;
    } catch (e) {
      return null;
    }
  }
}

// ─────────────────────────────────────────────
//  6. REST POLLER
// ─────────────────────────────────────────────

class TDRESTPoller {
  constructor(apiKey, quotaManager) {
    this.apiKey = apiKey;
    this.quota = quotaManager;
  }

  async fetchTimeSeries(symbol, interval, outputsize = 500) {
    return this.quota.schedule(async () => {
      const tdSymbol = TDSymbolResolver.toTwelveDataFormat(symbol);
      const url = `${TD_REST_BASE}/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${this.apiKey}`;
      const result = await httpGetJSON(url);

      if (result.status === 'error') {
        const err = new Error(`Twelve Data error for ${symbol}: ${result.message}`);
        err.tdCode = result.code; // 429 = rate limit exceeded
        throw err;
      }

      const values = result.values || [];
      return values.reverse().map(v => ({
        timestamp: new Date(v.datetime).getTime(),
        open:  parseFloat(v.open), high: parseFloat(v.high),
        low:   parseFloat(v.low),  close: parseFloat(v.close),
        volume: parseFloat(v.volume || 0),
        isClosed: true,
      }));
    });
  }

  async fetchQuote(symbol) {
    return this.quota.schedule(async () => {
      const tdSymbol = TDSymbolResolver.toTwelveDataFormat(symbol);
      const url = `${TD_REST_BASE}/quote?symbol=${encodeURIComponent(tdSymbol)}&apikey=${this.apiKey}`;
      const result = await httpGetJSON(url);

      if (result.status === 'error') throw new Error(`Quote error for ${symbol}: ${result.message}`);

      return {
        symbol, price: parseFloat(result.close),
        open: parseFloat(result.open), high: parseFloat(result.high), low: parseFloat(result.low),
        prevClose: parseFloat(result.previous_close),
        change: parseFloat(result.change), pctChange: parseFloat(result.percent_change),
        volume: parseFloat(result.volume || 0),
        timestamp: result.timestamp ? result.timestamp * 1000 : Date.now(),
        isMarketOpen: result.is_market_open,
      };
    });
  }

  async fetchBatchQuotes(symbols) {
    return this.quota.schedule(async () => {
      const tdSymbols = symbols.map(s => TDSymbolResolver.toTwelveDataFormat(s));
      const url = `${TD_REST_BASE}/quote?symbol=${encodeURIComponent(tdSymbols.join(','))}&apikey=${this.apiKey}`;
      const result = await httpGetJSON(url);

      if (symbols.length === 1) {
        return { [symbols[0]]: result };
      }
      return result;
    });
  }
}

// ─────────────────────────────────────────────
//  7. WEBSOCKET ENGINE
// ─────────────────────────────────────────────

class TDWebSocketEngine extends EventEmitter {
  constructor(apiKey, symbols) {
    super();
    this.apiKey = apiKey;
    this.symbols = symbols;
    this._ws = null;
    this._connected = false;
    this._reconnectAttempts = 0;
    this._heartbeatTimer = null;
    this._wsAvailable = !!WebSocket;
  }

  connect() {
    if (!this._wsAvailable) {
      this.emit('unavailable', { reason: "'ws' package not installed" });
      return;
    }

    const url = `${TD_WS_BASE}?apikey=${this.apiKey}`;
    this._ws = new WebSocket(url);

    this._ws.on('open', () => {
      this._connected = true;
      this._reconnectAttempts = 0;
      this._subscribe();
      this._startHeartbeat();
      this.emit('open');
    });

    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleMessage(msg);
      } catch (e) {
        this.emit('error', { source: 'parse', error: e });
      }
    });

    this._ws.on('close', (code) => {
      this._connected = false;
      this._stopHeartbeat();
      this.emit('close', { code });

      if (code === 1008 || code === 4001) {
        this.emit('unavailable', { reason: 'WebSocket requires paid plan or invalid auth' });
        return;
      }
      this._scheduleReconnect();
    });

    this._ws.on('error', (err) => this.emit('error', { source: 'ws', error: err }));
  }

  _subscribe() {
    const tdSymbols = this.symbols.map(s => TDSymbolResolver.toTwelveDataFormat(s));
    this._ws.send(JSON.stringify({ action: 'subscribe', params: { symbols: tdSymbols.join(',') } }));
  }

  _handleMessage(msg) {
    if (msg.event === 'price') {
      this.emit('price', {
        symbol: TDSymbolResolver.toCanonical(msg.symbol),
        price: parseFloat(msg.price),
        timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
        dayVolume: msg.day_volume ? parseFloat(msg.day_volume) : null,
      });
    } else if (msg.event === 'subscribe-status') {
      this.emit('subscribed', msg);
    } else if (msg.event === 'heartbeat') {
      // server heartbeat — connection healthy
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ action: 'heartbeat' }));
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  _scheduleReconnect() {
    this._reconnectAttempts++;
    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.emit('fatal', { message: 'Max reconnect attempts reached' });
      return;
    }
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this._reconnectAttempts - 1), 60000);
    setTimeout(() => this.connect(), delay);
  }

  close() {
    this._stopHeartbeat();
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.close(1000, 'Graceful shutdown');
  }

  isConnected() { return this._connected; }
  isAvailable() { return this._wsAvailable; }
}

// ─────────────────────────────────────────────
//  8. MAIN TWELVE DATA FEED CLASS
// ─────────────────────────────────────────────

const CANDLE_FRESHNESS_MS = {
  M1: 2 * 60000, M5: 10 * 60000, M15: 30 * 60000, M30: 60 * 60000,
  H1: 2 * 3600000, H2: 4 * 3600000, H4: 8 * 3600000, H6: 12 * 3600000,
  H8: 16 * 3600000, H12: 24 * 3600000, D1: 2 * 86400000, W1: 14 * 86400000,
};

class TwelveDataFeed extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string}   config.apiKey            - Twelve Data API key (required)
   * @param {string[]} config.symbols           - e.g. ['EURUSD','GBPUSD','AAPL','XAUUSD']
   * @param {string[]} config.timeframes        - e.g. ['M15','H1','H4','D1']
   * @param {number}   config.requestsPerMinute - your plan's per-minute limit (default 8 = free tier)
   * @param {number}   config.requestsPerDay    - your plan's daily cap (default 800 = free tier; pass Infinity for paid/uncapped)
   * @param {boolean}  config.useWebSocket      - attempt WS first (default true, auto-falls back)
   * @param {number}   config.pollIntervalMs    - REST poll interval when WS unavailable (default 15000)
   * @param {boolean}  config.trackEarnings     - fetch earnings calendar for stock symbols
   * @param {Object}   config.fallbackFeed      - optional secondary feed (e.g. FinnhubFeed instance)
   *                                               exposing getLatestCandles(symbol, tf, count) — used
   *                                               for live candle data once the daily quota is exhausted,
   *                                               before falling back to a stale Mongo cache entry.
   */
  constructor(config = {}) {
    super();

    if (!config.apiKey) {
      console.warn('[TwelveDataFeed] No apiKey provided — feed will fail on first request. Get a free key at twelvedata.com');
    }

    this.apiKey       = config.apiKey || '';
    this.symbols      = (config.symbols || []).map(s => TDSymbolResolver.toCanonical(s));
    this.timeframes   = config.timeframes || ['M15', 'H1', 'H4'];
    this.useWebSocket = config.useWebSocket !== false;
    this.pollIntervalMs = config.pollIntervalMs || 15000;
    this.trackEarnings = config.trackEarnings ?? false;

    this.quota       = new QuotaManager(
      config.requestsPerMinute || DEFAULT_REQUESTS_PER_MINUTE,
      config.requestsPerDay !== undefined ? config.requestsPerDay : DEFAULT_REQUESTS_PER_DAY,
    );
    this.candleStore = new TDCandleStore();
    this.poller      = new TDRESTPoller(this.apiKey, this.quota);
    this.earnings    = new TDEarningsCalendar();
    this.db = config.db || null;
    this.fallbackFeed = config.fallbackFeed || null;

    this._prices = new Map();
    this._prevPrices = new Map();
    this._wsEngine = null;
    this._pollTimer = null;
    this._candlePollTimers = {}; // one per timeframe now, keyed by tf
    this._usingWS = false;
    this._dailyExhaustedNotified = false;
    this._quotaResetDay = null;

    this._stats = { quotesReceived: 0, candlesEmitted: 0, errorsCount: 0, fallbackCandlesUsed: 0, startTime: null, mode: 'UNINITIALIZED' };
  }

  isConnected() {
    if (this._wsEngine) return this._wsEngine.isConnected();
    return Boolean(this._pollTimer);
  }

  async connect() {
    console.log(`[TwelveDataFeed] Connecting for: ${this.symbols.join(', ')}`);
    this._stats.startTime = Date.now();

    await this._preloadHistory();

    if (this.trackEarnings) {
      for (const symbol of this.symbols) {
        if (TDSymbolResolver.inferType(symbol) === 'stock') {
          this.earnings.fetchUpcoming(symbol, this.apiKey).catch(() => {});
        }
      }
    }

    if (this.useWebSocket && WebSocket) {
      this._connectWebSocket();
    } else {
      this._startRESTPolling();
    }

    this._startCandlePolling();
    this.emit('ready', { symbols: this.symbols, timeframes: this.timeframes });
  }

  async _preloadHistory() {
    console.log(`[TwelveDataFeed] Preloading historical candles (respecting free-tier quota — ~${HISTORY_LOAD_DELAY_MS / 1000}s between requests, this will take a few minutes)...`);
    let isFirst = true;
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        if (this.db) {
          try {
            const stored = await this.db.loadCandleHistory('twelvedata', symbol, tf);
            if (stored && stored.updatedAt) {
              const ageMs = Date.now() - new Date(stored.updatedAt).getTime();
              const freshWindow = CANDLE_FRESHNESS_MS[tf] || 3600000;
              if (ageMs < freshWindow) {
                this.candleStore.bulkLoad(symbol, tf, stored.candles);
                console.log(`[TwelveDataFeed] Restored ${stored.candles.length} candles for ${symbol} ${tf} from Mongo (${Math.round(ageMs / 60000)}min old, API call skipped)`);
                continue;
              }
            }
          } catch (_) { /* Mongo read failed — fall through to normal API fetch */ }
        }

        if (!isFirst) await sleep(HISTORY_LOAD_DELAY_MS);
        isFirst = false;

        const interval = TIMEFRAMES[tf] || tf;
        try {
          const candles = await this.poller.fetchTimeSeries(symbol, interval, MAX_CANDLE_HISTORY);
          this.candleStore.bulkLoad(symbol, tf, candles);
          console.log(`[TwelveDataFeed] Loaded ${candles.length} candles for ${symbol} ${tf}`);
          if (this.db) this.db.saveCandleHistory('twelvedata', symbol, tf, candles).catch(() => {});
        } catch (err) {
          console.error(`[TwelveDataFeed] History load failed ${symbol} ${tf}: ${err.message}`);
          this._stats.errorsCount++;
          if (err.tdCode === 'DAILY_QUOTA_EXCEEDED') {
            // Budget's gone for the day — whatever's already in the candle
            // store (Mongo-restored or from an earlier symbol/tf this same
            // boot) stands until reset. Retrying won't help.
            continue;
          }
          if (err.tdCode === 429 || /run out of API credits/i.test(err.message)) {
            this._retryAfterQuotaReset(symbol, tf, interval);
          }
        }
      }
    }
    console.log(`[TwelveDataFeed] Preload complete. Total candles: ${this.candleStore.size()}`);
  }

  _retryAfterQuotaReset(symbol, tf, interval) {
    setTimeout(async () => {
      try {
        const candles = await this.poller.fetchTimeSeries(symbol, interval, MAX_CANDLE_HISTORY);
        this.candleStore.bulkLoad(symbol, tf, candles);
        console.log(`[TwelveDataFeed] Retry succeeded: loaded ${candles.length} candles for ${symbol} ${tf}`);
        if (this.db) this.db.saveCandleHistory('twelvedata', symbol, tf, candles).catch(() => {});
      } catch (err) {
        console.error(`[TwelveDataFeed] Retry also failed for ${symbol} ${tf}: ${err.message}`);
        this._stats.errorsCount++;
      }
    }, 65000);
  }

  _connectWebSocket() {
    this._wsEngine = new TDWebSocketEngine(this.apiKey, this.symbols);

    this._wsEngine.on('open', () => {
      this._usingWS = true;
      this._stats.mode = 'WEBSOCKET';
      console.log('[TwelveDataFeed] WebSocket connected');
      this.emit('connected', { mode: 'WEBSOCKET' });
    });

    this._wsEngine.on('price', (data) => this._handlePrice(data));

    this._wsEngine.on('unavailable', ({ reason }) => {
      console.warn(`[TwelveDataFeed] WebSocket unavailable (${reason}) — falling back to REST polling`);
      this._usingWS = false;
      this._startRESTPolling();
    });

    this._wsEngine.on('error', (e) => { this._stats.errorsCount++; this.emit('error', e); });
    this._wsEngine.on('close', () => this.emit('disconnected', { mode: 'WEBSOCKET' }));
    this._wsEngine.on('fatal', () => {
      console.warn('[TwelveDataFeed] WS reconnect exhausted — falling back to REST polling');
      this._startRESTPolling();
    });

    this._wsEngine.connect();
  }

  _startRESTPolling() {
    if (this._pollTimer) return;
    this._stats.mode = 'REST_POLL';
    console.log(`[TwelveDataFeed] Starting REST polling every ${this.pollIntervalMs}ms`);

    const poll = async () => {
      try {
        const quotes = await this.poller.fetchBatchQuotes(this.symbols);
        for (const symbol of this.symbols) {
          const q = quotes[symbol] || quotes[TDSymbolResolver.toTwelveDataFormat(symbol)];
          if (q?.close) {
            this._handlePrice({ symbol, price: parseFloat(q.close), timestamp: Date.now() });
          }
        }
      } catch (err) {
        this._stats.errorsCount++;
        if (err.tdCode === 'DAILY_QUOTA_EXCEEDED') {
          this._checkDailyReset();
          if (!this._dailyExhaustedNotified) {
            console.warn(`[TwelveDataFeed] Daily quota exhausted — ${this.fallbackFeed ? 'using fallback feed for live candles where possible, ' : ''}quote polling paused until reset.`);
            this._dailyExhaustedNotified = true;
            this.emit('quota_exhausted', { provider: 'twelvedata', timestamp: Date.now() });
          }
        } else {
          this.emit('error', { source: 'rest_poll', error: err });
        }
      }
    };

    poll();
    this._pollTimer = setInterval(poll, this.pollIntervalMs);
  }

  // FIX: previously only ever scheduled a poll cycle for the single
  // LOWEST configured timeframe — H1/H4/D1 candles were loaded once at
  // _preloadHistory() and then never updated again for the life of the
  // process, regardless of how long it ran. Every configured timeframe
  // now gets its own self-rescheduling cycle, each paced to roughly 1/3
  // of ITS OWN candle-close interval (frequent enough to catch a close
  // promptly, without re-checking a candle that can't possibly have
  // changed yet — the previous fixed 60s cadence checked a 15-minute
  // candle ~15x more often than necessary, and never checked H1/H4/D1
  // at all after boot).
  _startCandlePolling() {
    for (const tf of this.timeframes) {
      this._scheduleTimeframePoll(tf);
    }
  }

  _checkDailyReset() {
    const today = new Date().toISOString().slice(0, 10);
    if (this._quotaResetDay !== today) {
      this._quotaResetDay = today;
      this._dailyExhaustedNotified = false;
    }
  }

  _scheduleTimeframePoll(tf) {
    const tfMinutes = TF_MINUTES[tf] || 15;
    // Floor of 60s so we never poll faster than once/minute even for M1.
    const checkIntervalMs = Math.max(60000, Math.round((tfMinutes * 60000) / 3));

    const runCycle = async () => {
      this._checkDailyReset();
      let isFirst = true;
      for (const symbol of this.symbols) {
        if (!isFirst) await sleep(HISTORY_LOAD_DELAY_MS);
        isFirst = false;

        try {
          const interval = TIMEFRAMES[tf] || tf;
          const recent = await this.poller.fetchTimeSeries(symbol, interval, 2);
          this._applyLiveCandle(symbol, tf, recent, 'twelvedata');
        } catch (err) {
          this._stats.errorsCount++;

          if (err.tdCode === 'DAILY_QUOTA_EXCEEDED') {
            if (!this._dailyExhaustedNotified) {
              console.warn(`[TwelveDataFeed] Daily quota exhausted — ${this.fallbackFeed ? 'using fallback feed for live candles where possible, ' : ''}serving last-known candles otherwise until reset.`);
              this._dailyExhaustedNotified = true;
              this.emit('quota_exhausted', { provider: 'twelvedata', timestamp: Date.now() });
            }
            await this._tryFallbackCandle(symbol, tf);
          }
          // Non-daily errors (429 per-minute, network blip, etc.) — the
          // next cycle will simply try again; no need to spam logs per
          // symbol per cycle for a transient issue.
        }
      }
      this._candlePollTimers[tf] = setTimeout(runCycle, checkIntervalMs);
    };

    this._candlePollTimers[tf] = setTimeout(runCycle, checkIntervalMs);
  }

  async _tryFallbackCandle(symbol, tf) {
    if (!this.fallbackFeed || typeof this.fallbackFeed.getLatestCandles !== 'function') return;
    try {
      const recent = await this.fallbackFeed.getLatestCandles(symbol, tf, 2);
      if (recent && recent.length) {
        this._stats.fallbackCandlesUsed++;
        this._applyLiveCandle(symbol, tf, recent, 'finnhub_fallback');
      }
    } catch (_) {
      // Fallback is best-effort — failure here just means we keep
      // whatever's already in the candle store (Mongo/last-known).
    }
  }

  // Shared by both the primary Twelve Data poll and the fallback path so
  // candle-store update / event-emit logic isn't duplicated between them.
  // `source` is tagged onto the emitted event so downstream consumers can
  // tell the difference between a primary-feed candle and a fallback one
  // if data-source confidence matters to them.
  _applyLiveCandle(symbol, tf, recentCandles, source) {
    if (!recentCandles || recentCandles.length === 0) return;

    const latest = recentCandles[recentCandles.length - 1];
    const existing = this.candleStore.get(symbol, tf);
    const lastStored = existing[existing.length - 1];

    const isNew = !lastStored || latest.timestamp > lastStored.timestamp;
    const candles = this.candleStore.upsert(symbol, tf, latest);

    this.emit('candle_update', { symbol, timeframe: tf, candle: latest, candles, isClosed: true, source });

    if (isNew) {
      this._stats.candlesEmitted++;
      if (this.db) this.db.saveCandleHistory('twelvedata', symbol, tf, candles).catch(() => {});
      this.emit('candle', {
        symbol, timeframe: tf, candle: latest, candles: [...candles],
        marketState: TDMarketStateEngine.isOpen(symbol, Date.now()),
        earningsProximity: this.trackEarnings ? this.earnings.isNearEarnings(symbol) : null,
        timestamp: Date.now(),
        source, // 'twelvedata' | 'finnhub_fallback'
      });
    }
  }

  _handlePrice(data) {
    this._stats.quotesReceived++;
    const { symbol, price, timestamp } = data;

    this._prevPrices.set(symbol, this._prices.get(symbol) ?? price);
    this._prices.set(symbol, price);

    this.emit('price', {
      symbol, price, prevPrice: this._prevPrices.get(symbol),
      timestamp: timestamp || Date.now(),
      marketState: TDMarketStateEngine.isOpen(symbol, timestamp || Date.now()),
    });
  }

  // ── Public API ──

  getPrice(symbol) { return this._prices.get(TDSymbolResolver.toCanonical(symbol)) || null; }
  getCandles(symbol, tf) { return this.candleStore.get(TDSymbolResolver.toCanonical(symbol), tf); }
  isMarketOpen(symbol) { return TDMarketStateEngine.isOpen(TDSymbolResolver.toCanonical(symbol), Date.now()); }
  getEarningsProximity(symbol) { return this.earnings.isNearEarnings(symbol); }

  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return {
      ...this._stats, uptime,
      usingWebSocket: this._usingWS,
      symbols: this.symbols,
      candleCount: this.candleStore.size(),
      prices: Object.fromEntries(this._prices),
      quota: this.quota.getStats(),
    };
  }

  disconnect() {
    console.log('[TwelveDataFeed] Disconnecting...');
    if (this._wsEngine) this._wsEngine.close();
    if (this._pollTimer) clearInterval(this._pollTimer);
    for (const timer of Object.values(this._candlePollTimers)) {
      clearTimeout(timer);
    }
    this._candlePollTimers = {};
    this.emit('closed');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  TwelveDataFeed, QuotaManager, TDCandleStore, TDSymbolResolver,
  TDMarketStateEngine, TDEarningsCalendar, TDRESTPoller, TDWebSocketEngine,
  TIMEFRAMES, TF_MINUTES,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { TwelveDataFeed } = require('./feeds/twelve-data');
 *  const { FinnhubFeed } = require('./feeds/finnhub-feed');
 *
 *  const finnhub = new FinnhubFeed({ apiKey: process.env.FINNHUB_API_KEY });
 *
 *  const feed = new TwelveDataFeed({
 *    apiKey: process.env.TWELVE_DATA_API_KEY,
 *    symbols: ['EURUSD', 'GBPUSD', 'XAUUSD', 'AAPL'],
 *    timeframes: ['M15', 'H1', 'H4', 'D1'],
 *    requestsPerMinute: 8,       // free tier — raise if you upgrade
 *    requestsPerDay: 800,        // free tier — pass Infinity on a paid/uncapped plan
 *    useWebSocket: true,         // auto-falls back to REST if not on a paid plan
 *    trackEarnings: true,        // fetches earnings dates for AAPL
 *    fallbackFeed: finnhub,      // used for live candles once daily quota is hit
 *  });
 *
 *  feed.on('candle', ({ symbol, timeframe, candles, source, earningsProximity }) => {
 *    if (earningsProximity?.near) console.log(earningsProximity.note);
 *    if (source === 'finnhub_fallback') console.log(`${symbol} ${timeframe}: served from fallback feed`);
 *    // → pass candles to smc-agent.js / mtf-agent.js
 *  });
 *
 *  feed.on('quota_exhausted', ({ provider }) => {
 *    // e.g. surface a banner in the dashboard — see api/server.js's
 *    // existing feed_health / abnormal_market forward() pattern for how
 *    // to relay this over the socket if you want it visible live.
 *  });
 *
 *  feed.on('price', ({ symbol, price, marketState }) => {
 *    if (!marketState.open) return;
 *    console.log(`${symbol}: ${price}`);
 *  });
 *
 *  await feed.connect();
 *
 *  console.log(feed.getStats().quota); // { limit, used, remaining, dailyLimit, dailyUsed, dailyRemaining, queueDepth }
 * ─────────────────────────────────────────────
 */
