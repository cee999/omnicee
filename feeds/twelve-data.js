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
 *     - Twelve Data free/paid tiers have hard rate limits
 *       (e.g. 8 req/min on free tier). This tracks usage and
 *       throttles requests BEFORE hitting a 429, with a queue
 *       so nothing silently fails — slow is better than blocked.
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

const MAX_CANDLE_HISTORY = 500;
// FIX: TwelveData's free tier caps at 8 API credits/minute. Each history
// request costs 1 credit, and _preloadHistory() below was firing one
// request per symbol/timeframe combo back-to-back with no pacing at all —
// the "respecting quota" log message was aspirational, not actually
// implemented. With 5+ symbols x 4 timeframes, that's 20+ requests fired
// within seconds, blowing through the 8/minute cap almost immediately
// (confirmed in production logs: "9 API credits were used... current
// limit being 8" on request #9, seconds after boot). 8000ms between
// requests keeps this safely under 8/minute (7.5/min) with margin.
const HISTORY_LOAD_DELAY_MS = 8000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Free tier default — override via config.requestsPerMinute for paid tiers
const DEFAULT_REQUESTS_PER_MINUTE = 8;
const QUOTA_SAFETY_MARGIN = 0.85; // use only 85% of stated quota to leave headroom

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
   * Tracks API call usage against a per-minute rate limit and queues
   * requests so the feed degrades gracefully (slower updates) instead
   * of throwing 429 errors and losing data entirely.
   */
  constructor(requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE) {
    this.limit = Math.floor(requestsPerMinute * QUOTA_SAFETY_MARGIN);
    this._callLog = []; // timestamps of recent calls
    this._queue = [];
    this._processing = false;
  }

  /**
   * Returns true if a call can be made right now without exceeding quota.
   */
  canCall() {
    this._prune();
    return this._callLog.length < this.limit;
  }

  _prune() {
    const cutoff = Date.now() - 60000;
    this._callLog = this._callLog.filter(t => t > cutoff);
  }

  /**
   * Schedule a function to run respecting quota. Returns a Promise that
   * resolves with the function's result whenever quota allows execution.
   */
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;

    while (this._queue.length > 0) {
      if (!this.canCall()) {
        // Wait until the oldest call ages out of the window
        const oldestCall = this._callLog[0];
        const waitMs = Math.max(0, 60000 - (Date.now() - oldestCall)) + 100;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      const job = this._queue.shift();
      this._callLog.push(Date.now());

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
    return {
      limit: this.limit,
      used: this._callLog.length,
      remaining: Math.max(0, this.limit - this._callLog.length),
      queueDepth: this._queue.length,
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
  /**
   * Normalizes symbol formats. Twelve Data expects 'EUR/USD' for forex,
   * 'AAPL' for stocks, 'SPX' style for indices. Our internal convention
   * (matching binance-ws.js / bybit-ws.js) is 'EURUSD' (no slash).
   */
  static toCanonical(symbol) {
    return symbol.replace('/', '').toUpperCase();
  }

  /**
   * Converts our canonical 'EURUSD' → Twelve Data's 'EUR/USD' for forex pairs.
   * Stocks/indices pass through unchanged (no slash needed).
   */
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

    return symbol; // stocks, indices pass through
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
  /**
   * Knows when each market type is open so a "stale" quote can be
   * correctly interpreted as "market closed" rather than "feed broken".
   */
  static isOpen(symbol, timestamp) {
    const type = TDSymbolResolver.inferType(symbol);
    const d = new Date(timestamp || Date.now());
    const utcDay = d.getUTCDay();
    const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;

    if (type === 'forex' || type === 'commodity') {
      // Forex: Sunday 21:00 UTC → Friday 21:00 UTC, 24h between
      const isFridayAfterClose = utcDay === 5 && utcHour >= 21;
      const isSaturday = utcDay === 6;
      const isSundayBeforeOpen = utcDay === 0 && utcHour < 21;
      return { open: !(isFridayAfterClose || isSaturday || isSundayBeforeOpen), type, note: 'Forex/commodities trade ~24/5' };
    }

    if (type === 'stock' || type === 'index') {
      // Approximate US market hours: 13:30-20:00 UTC, Mon-Fri (ignores holidays)
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
  /**
   * Company-specific earnings dates — distinct from session-filter.js's
   * macro economic calendar. A single stock can gap 10%+ around earnings
   * regardless of broader market conditions.
   */
  constructor() {
    this._earnings = new Map(); // symbol → { date, time: 'BMO'|'AMC', estimate, actual }
  }

  set(symbol, earningsData) {
    this._earnings.set(symbol.toUpperCase(), earningsData);
  }

  get(symbol) {
    return this._earnings.get(symbol.toUpperCase()) || null;
  }

  /**
   * Is this symbol within N days of its next earnings date?
   */
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
  /**
   * @param {string} apiKey
   * @param {QuotaManager} quotaManager
   */
  constructor(apiKey, quotaManager) {
    this.apiKey = apiKey;
    this.quota = quotaManager;
  }

  /**
   * Fetch historical time series. Respects quota via scheduling.
   */
  async fetchTimeSeries(symbol, interval, outputsize = 500) {
    return this.quota.schedule(async () => {
      const tdSymbol = TDSymbolResolver.toTwelveDataFormat(symbol);
      const url = `${TD_REST_BASE}/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${this.apiKey}`;
      const result = await httpGetJSON(url);

      if (result.status === 'error') {
        const err = new Error(`Twelve Data error for ${symbol}: ${result.message}`);
        err.tdCode = result.code; // 429 = rate limit exceeded — let callers detect this reliably
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

  /**
   * Fetch a real-time quote (used for polling fallback when WS unavailable)
   */
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

  /**
   * Batch multiple symbols in a single request where Twelve Data supports it
   * (comma-separated symbol param) — saves quota vs N individual calls.
   */
  async fetchBatchQuotes(symbols) {
    return this.quota.schedule(async () => {
      const tdSymbols = symbols.map(s => TDSymbolResolver.toTwelveDataFormat(s));
      const url = `${TD_REST_BASE}/quote?symbol=${encodeURIComponent(tdSymbols.join(','))}&apikey=${this.apiKey}`;
      const result = await httpGetJSON(url);

      // Single symbol returns object directly; multi returns keyed by symbol
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
  /**
   * Real-time price WebSocket — available on paid Twelve Data plans.
   * If WS connection fails repeatedly (e.g. free-tier account), the
   * parent TwelveDataFeed automatically falls back to REST polling.
   */
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

      // If we get a paid-tier-required style close, signal fallback
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

// How fresh Mongo-stored candle history needs to be, per timeframe, to
// skip re-fetching from the API entirely on boot. Roughly 2x each
// timeframe's own candle-close interval — stale enough data still gets a
// normal fetch (and gets persisted fresh afterward), but data from a
// recent restart (the common case on a Render free-tier instance cycling
// through spin-down/wake-up) is reused directly.
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
   * @param {number}   config.requestsPerMinute - your plan's rate limit (default 8 = free tier)
   * @param {boolean}  config.useWebSocket      - attempt WS first (default true, auto-falls back)
   * @param {number}   config.pollIntervalMs    - REST poll interval when WS unavailable (default 15000)
   * @param {boolean}  config.trackEarnings     - fetch earnings calendar for stock symbols
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

    this.quota       = new QuotaManager(config.requestsPerMinute || DEFAULT_REQUESTS_PER_MINUTE);
    this.candleStore = new TDCandleStore();
    this.poller      = new TDRESTPoller(this.apiKey, this.quota);
    this.earnings    = new TDEarningsCalendar();
    // Optional — enables persisting/restoring candle history across
    // restarts so boot doesn't need to re-fetch everything from this
    // rate-limited feed every single time. No-ops safely if not provided
    // or if MONGODB_URI isn't configured (db.js's own functions already
    // handle that).
    this.db = config.db || null;

    this._prices = new Map();
    this._prevPrices = new Map();
    this._wsEngine = null;
    this._pollTimer = null;
    this._candlePollTimer = null;
    this._usingWS = false;

    this._stats = { quotesReceived: 0, candlesEmitted: 0, errorsCount: 0, startTime: null, mode: 'UNINITIALIZED' };
  }

  // FIX: DataIntegrityMonitor.check() (feeds/data-integrity-monitor.js) calls
  // instance.isConnected() on whatever it was registered with — but the
  // registered instance is TwelveDataFeed, and the only isConnected() in
  // this file lived on the internal TDWebSocketEngine class instead, never
  // exposed here. `typeof instance.isConnected === 'function'` was false,
  // so every check silently fell through to connected: null, which the
  // frontend renders as literally "UNKNOWN" — regardless of whether the
  // feed was actually connected, disconnected, or never even started.
  // Reflects whichever live mode is actually active: real WebSocket
  // (paid tier) or the REST-poll fallback (free tier, this.pollIntervalMs).
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
    // Two complementary fixes here, found independently from the same
    // production rate-limit errors:
    //
    // 1. THROTTLE (below, via sleep(HISTORY_LOAD_DELAY_MS)): nothing here
    //    used to pace requests at all — with 5+ symbols x 4 timeframes,
    //    20+ requests fired within seconds of boot, blowing through the
    //    free tier's 8-credits/minute cap almost immediately (confirmed in
    //    production logs: request #9 already over the limit).
    //
    // 2. RETRY-AFTER-RESET (_retryAfterQuotaReset below): rapid redeploys
    //    are common during active development (this app's own render.yaml
    //    auto-deploys on every commit), and QuotaManager's per-minute call
    //    log is in-memory only — a fresh process starts with an empty log
    //    even though Twelve Data's own server-side per-minute counter for
    //    this API key does NOT reset on restart. A new process can
    //    therefore believe it has full budget while the account is
    //    actually already near/over the real limit from calls the
    //    previous process just made. The throttle above prevents most of
    //    this, but can't know about quota consumed by a different,
    //    already-exited process — so anything that still fails on a 429
    //    gets one background retry ~65s later, once the real per-minute
    //    window has actually rolled over, rather than being abandoned
    //    permanently.
    let isFirst = true;
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        // FIX: check Mongo BEFORE touching the API at all. If we have
        // fresh-enough persisted history from a previous run (very common
        // on a Render free-tier instance that just cycled through a
        // spin-down/wake-up), use it directly — zero API credits spent,
        // zero throttle delay needed. This is the actual fix for "always
        // running out of TwelveData/AlphaVantage keys": the API usage
        // itself was already correctly throttled (see below), but every
        // restart still needed a FULL re-fetch of everything because
        // nothing persisted history across restarts at all.
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

        // FIX: this delay is the actual fix — previously nothing here
        // paced requests at all, so the free tier's 8-credits/minute cap
        // was blown through in the first ~10 seconds of boot.
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
          if (err.tdCode === 429 || /run out of API credits/i.test(err.message)) {
            this._retryAfterQuotaReset(symbol, tf, interval);
          }
        }
      }
    }
    console.log(`[TwelveDataFeed] Preload complete. Total candles: ${this.candleStore.size()}`);
  }

  // Fire-and-forget: not awaited by _preloadHistory(), so it never delays
  // connect() or anything sequenced after it. One retry only — if the
  // real per-minute window is still exhausted 65s later (e.g. something
  // else is also actively consuming this same account's quota), give up
  // for that symbol/timeframe rather than retrying indefinitely; it will
  // still pick up live data going forward.
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
    if (this._pollTimer) return; // already polling
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
        this.emit('error', { source: 'rest_poll', error: err });
      }
    };

    poll();
    this._pollTimer = setInterval(poll, this.pollIntervalMs);
  }

  _startCandlePolling() {
    // Poll for new candle closes every minute, checking only the lowest
    // (fastest-updating) configured timeframe — higher timeframes close far
    // less often (an H4 candle only closes every 4 hours) so re-checking
    // them every 60s is both wasteful and, on a rate-limited free tier,
    // actively harmful.
    // FIX: the comment above already said "checks the lowest configured
    // TF", but the code below looped over ALL of this.timeframes — a real
    // mismatch between stated intent and implementation. Combined with zero
    // throttling between requests, this meant every single 60-second cycle
    // fired one request per symbol PER timeframe, back-to-back — with 5+
    // symbols x 4 timeframes, ~20 requests every minute, permanently
    // blowing through TwelveData's free-tier 8-credits/minute cap on every
    // cycle for as long as the app runs (not just once at boot, unlike
    // _preloadHistory() above). Now: only the fastest timeframe is checked,
    // and remaining per-symbol requests are paced.
    const TF_ORDER = ['M1','M5','M15','M30','H1','H2','H4','H6','H8','H12','D1','W1'];
    const lowestTf = [...this.timeframes].sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b))[0];
    if (!lowestTf) return;

    const checkIntervalMs = 60000;
    const runCycle = async () => {
      let isFirst = true;
      for (const symbol of this.symbols) {
        if (!isFirst) await sleep(HISTORY_LOAD_DELAY_MS);
        isFirst = false;

        try {
          const interval = TIMEFRAMES[lowestTf] || lowestTf;
          const recent = await this.poller.fetchTimeSeries(symbol, interval, 2);
          if (recent.length === 0) continue;

          const latest = recent[recent.length - 1];
          const existing = this.candleStore.get(symbol, lowestTf);
          const lastStored = existing[existing.length - 1];

          const isNew = !lastStored || latest.timestamp > lastStored.timestamp;
          const candles = this.candleStore.upsert(symbol, lowestTf, latest);

          this.emit('candle_update', { symbol, timeframe: lowestTf, candle: latest, candles, isClosed: true });

          if (isNew) {
            this._stats.candlesEmitted++;
            if (this.db) this.db.saveCandleHistory('twelvedata', symbol, lowestTf, candles).catch(() => {});
            this.emit('candle', {
              symbol, timeframe: lowestTf, candle: latest, candles: [...candles],
              marketState: TDMarketStateEngine.isOpen(symbol, Date.now()),
              earningsProximity: this.trackEarnings ? this.earnings.isNearEarnings(symbol) : null,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          this._stats.errorsCount++;
          // Don't spam errors for every symbol — log once per cycle is enough context
        }
      }
      // Self-rescheduling rather than setInterval: guarantees the next
      // cycle only starts checkIntervalMs after THIS one (including all its
      // internal per-symbol delays) fully finishes, regardless of symbol
      // count — setInterval would fire on a fixed clock and could overlap
      // with a still-running previous cycle once there are enough symbols
      // for the throttled loop to exceed 60s on its own.
      this._candlePollTimer = setTimeout(runCycle, checkIntervalMs);
    };
    this._candlePollTimer = setTimeout(runCycle, checkIntervalMs);
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
    if (this._candlePollTimer) clearInterval(this._candlePollTimer);
    this.emit('closed');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  TwelveDataFeed, QuotaManager, TDCandleStore, TDSymbolResolver,
  TDMarketStateEngine, TDEarningsCalendar, TDRESTPoller, TDWebSocketEngine,
  TIMEFRAMES,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { TwelveDataFeed } = require('./feeds/twelve-data');
 *
 *  const feed = new TwelveDataFeed({
 *    apiKey: process.env.TWELVE_DATA_API_KEY,
 *    symbols: ['EURUSD', 'GBPUSD', 'XAUUSD', 'AAPL'],
 *    timeframes: ['M15', 'H1', 'H4'],
 *    requestsPerMinute: 8,     // free tier — raise if you upgrade
 *    useWebSocket: true,       // auto-falls back to REST if not on a paid plan
 *    trackEarnings: true,      // fetches earnings dates for AAPL
 *  });
 *
 *  feed.on('candle', ({ symbol, timeframe, candles, earningsProximity }) => {
 *    if (earningsProximity?.near) console.log(earningsProximity.note);
 *    // → pass candles to smc-agent.js / mtf-agent.js
 *  });
 *
 *  feed.on('price', ({ symbol, price, marketState }) => {
 *    if (!marketState.open) return; // expected — market closed, not a feed error
 *    console.log(`${symbol}: ${price}`);
 *  });
 *
 *  await feed.connect();
 *
 *  console.log(feed.getStats().quota); // { limit, used, remaining, queueDepth }
 * ─────────────────────────────────────────────
 */