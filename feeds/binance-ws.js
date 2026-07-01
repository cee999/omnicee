/**
 * ============================================================
 *  BINANCE WEBSOCKET ENGINE — Real-Time Market Data Feed
 *  AI Trading Assistant · Layer 10 · Data Feed Module
 * ============================================================
 *
 *  Features:
 *    - Multi-symbol WebSocket streams (spot + futures)
 *    - Kline/OHLCV streams (all timeframes simultaneously)
 *    - Order book depth (L2 bid/ask)
 *    - Aggravated trade streams (real-time tick data)
 *    - Funding rate streams (perpetual futures)
 *    - Open Interest tracking
 *    - Liquidation streams (whale liquidation detection)
 *    - Auto-reconnect with exponential backoff
 *    - Heartbeat monitoring
 *    - Built-in OHLCV candle builder from tick data
 *    - Redis pub/sub integration for agent broadcasting
 *    - Rate limit compliance
 *    - Full error handling + recovery
 *
 *  Usage:
 *    const BinanceFeed = require('./binance-ws');
 *    const feed = new BinanceFeed({ symbols: ['BTCUSDT','ETHUSDT','XAUUSDT'] });
 *    feed.on('candle', (data) => smcAgent.analyze(data.candles));
 *    feed.on('liquidation', (data) => alertDispatcher.send(data));
 *    await feed.connect();
 * ============================================================
 */

'use strict';

const WebSocket   = require('ws');
const EventEmitter = require('events');
const https       = require('https');

// ─────────────────────────────────────────────
//  CONSTANTS & CONFIG
// ─────────────────────────────────────────────

const BINANCE_WS_BASE_SPOT    = 'wss://stream.binance.com:9443/stream';
const BINANCE_WS_BASE_FUTURES = 'wss://fstream.binance.com/stream';
const BINANCE_REST_SPOT       = 'https://api.binance.com';
const BINANCE_REST_FUTURES    = 'https://fapi.binance.com';

const TIMEFRAMES = {
  M1:  '1m',
  M3:  '3m',
  M5:  '5m',
  M15: '15m',
  M30: '30m',
  H1:  '1h',
  H2:  '2h',
  H4:  '4h',
  H6:  '6h',
  H8:  '8h',
  H12: '12h',
  D1:  '1d',
  W1:  '1w',
  MN:  '1M',
};

// Max reconnect attempts before giving up
const MAX_RECONNECT_ATTEMPTS = 20;

// Reconnect delay base (ms) — doubles each attempt (exponential backoff)
const RECONNECT_BASE_DELAY = 1000;

// Heartbeat ping interval (ms)
const HEARTBEAT_INTERVAL = 30000;

// Max candles to keep in memory per symbol/timeframe
const MAX_CANDLE_HISTORY = 500;

// Order book depth levels to maintain
const ORDER_BOOK_DEPTH = 20;

// ─────────────────────────────────────────────
//  CANDLE STORE — in-memory OHLCV storage per symbol/TF
// ─────────────────────────────────────────────

class CandleStore {
  constructor() {
    // Map: `${symbol}_${timeframe}` → Array of candles
    this._store = new Map();
  }

  key(symbol, timeframe) {
    return `${symbol}_${timeframe}`;
  }

  /**
   * Upsert a candle. If the last candle has the same openTime, update it.
   * Otherwise push a new candle. Trim to MAX_CANDLE_HISTORY.
   */
  upsert(symbol, timeframe, candle) {
    const k = this.key(symbol, timeframe);
    if (!this._store.has(k)) this._store.set(k, []);

    const arr = this._store.get(k);

    if (arr.length > 0 && arr[arr.length - 1].timestamp === candle.timestamp) {
      // Update existing (candle not closed yet)
      arr[arr.length - 1] = candle;
    } else {
      arr.push(candle);
      // Trim
      if (arr.length > MAX_CANDLE_HISTORY) {
        arr.splice(0, arr.length - MAX_CANDLE_HISTORY);
      }
    }

    return arr;
  }

  get(symbol, timeframe) {
    return this._store.get(this.key(symbol, timeframe)) || [];
  }

  getAll() {
    const result = {};
    for (const [key, candles] of this._store) {
      result[key] = candles;
    }
    return result;
  }

  size() {
    let total = 0;
    for (const arr of this._store.values()) total += arr.length;
    return total;
  }
}

// ─────────────────────────────────────────────
//  ORDER BOOK — maintains L2 bid/ask state
// ─────────────────────────────────────────────

class OrderBook {
  constructor(symbol, depth = ORDER_BOOK_DEPTH) {
    this.symbol  = symbol;
    this.depth   = depth;
    this.bids    = new Map(); // price → quantity
    this.asks    = new Map();
    this.lastUpdateId = 0;
  }

  /**
   * Process a depth update from Binance.
   * Binance sends [price, qty] pairs. qty=0 means remove.
   */
  update(bids, asks, updateId) {
    if (updateId <= this.lastUpdateId) return;
    this.lastUpdateId = updateId;

    for (const [price, qty] of bids) {
      const p = parseFloat(price);
      const q = parseFloat(qty);
      if (q === 0) {
        this.bids.delete(p);
      } else {
        this.bids.set(p, q);
      }
    }

    for (const [price, qty] of asks) {
      const p = parseFloat(price);
      const q = parseFloat(qty);
      if (q === 0) {
        this.asks.delete(p);
      } else {
        this.asks.set(p, q);
      }
    }
  }

  /**
   * Returns sorted top N bids (descending) and asks (ascending)
   */
  getSnapshot(levels = this.depth) {
    const sortedBids = [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, levels);

    const sortedAsks = [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, levels);

    const bestBid   = sortedBids[0]?.[0] ?? 0;
    const bestAsk   = sortedAsks[0]?.[0] ?? 0;
    const midPrice  = (bestBid + bestAsk) / 2;
    const spread    = bestAsk - bestBid;
    const spreadPct = bestBid > 0 ? (spread / bestBid) * 100 : 0;

    // Bid/Ask volume imbalance — useful for order flow
    const bidVolume = sortedBids.reduce((s, [, q]) => s + q, 0);
    const askVolume = sortedAsks.reduce((s, [, q]) => s + q, 0);
    const imbalance = bidVolume + askVolume > 0
      ? ((bidVolume - askVolume) / (bidVolume + askVolume)) * 100
      : 0;

    return {
      symbol:       this.symbol,
      bids:         sortedBids,
      asks:         sortedAsks,
      bestBid,
      bestAsk,
      midPrice:     parseFloat(midPrice.toFixed(5)),
      spread:       parseFloat(spread.toFixed(5)),
      spreadPct:    parseFloat(spreadPct.toFixed(4)),
      bidVolume:    parseFloat(bidVolume.toFixed(4)),
      askVolume:    parseFloat(askVolume.toFixed(4)),
      imbalance:    parseFloat(imbalance.toFixed(2)),
      imbalanceBias: imbalance > 10 ? 'BULLISH' : imbalance < -10 ? 'BEARISH' : 'NEUTRAL',
      timestamp:    Date.now(),
    };
  }
}

// ─────────────────────────────────────────────
//  LIQUIDATION TRACKER
// ─────────────────────────────────────────────

class LiquidationTracker {
  constructor() {
    this._recent = []; // rolling last 100 liquidations
  }

  add(liq) {
    this._recent.push(liq);
    if (this._recent.length > 100) this._recent.shift();
  }

  /**
   * Returns aggregated liquidation stats for the last N seconds
   */
  getStats(windowMs = 60000) {
    const cutoff = Date.now() - windowMs;
    const inWindow = this._recent.filter(l => l.timestamp > cutoff);

    const longLiqs  = inWindow.filter(l => l.side === 'SELL'); // long positions liquidated
    const shortLiqs = inWindow.filter(l => l.side === 'BUY');  // short positions liquidated

    const longUSDT  = longLiqs.reduce((s, l) => s + l.usdtValue, 0);
    const shortUSDT = shortLiqs.reduce((s, l) => s + l.usdtValue, 0);
    const totalUSDT = longUSDT + shortUSDT;

    return {
      window:       windowMs,
      total:        inWindow.length,
      longCount:    longLiqs.length,
      shortCount:   shortLiqs.length,
      longUSDT:     parseFloat(longUSDT.toFixed(2)),
      shortUSDT:    parseFloat(shortUSDT.toFixed(2)),
      totalUSDT:    parseFloat(totalUSDT.toFixed(2)),
      dominance:    longUSDT > shortUSDT ? 'LONG_DOMINATED' : 'SHORT_DOMINATED',
      // If massive long liquidations → bearish signal
      // If massive short liquidations → bullish signal (short squeeze)
      marketSignal: longUSDT > shortUSDT * 2 ? 'BEARISH_LONGS_REKT'
        : shortUSDT > longUSDT * 2 ? 'BULLISH_SHORTS_REKT'
        : 'BALANCED',
    };
  }

  /**
   * Detect a liquidation cascade — high value in short window = danger
   */
  detectCascade(thresholdUSDT = 1000000, windowMs = 10000) {
    const stats = this.getStats(windowMs);
    return {
      isCascade: stats.totalUSDT > thresholdUSDT,
      ...stats,
    };
  }
}

// ─────────────────────────────────────────────
//  FUNDING RATE TRACKER
// ─────────────────────────────────────────────

class FundingRateTracker {
  constructor() {
    this._rates = new Map(); // symbol → { rate, nextTime, history[] }
  }

  update(symbol, rate, nextFundingTime) {
    const existing = this._rates.get(symbol) || { history: [] };
    existing.rate          = parseFloat(rate);
    existing.nextFundingTime = nextFundingTime;
    existing.annualized    = parseFloat(rate) * 3 * 365 * 100; // 3 fundings/day
    existing.history.push({
      rate:      parseFloat(rate),
      timestamp: Date.now(),
    });
    if (existing.history.length > 100) existing.history.shift();

    // Signal interpretation
    existing.bias = parseFloat(rate) > 0.001  ? 'OVERHEATED_LONGS_PAY'
      : parseFloat(rate) < -0.001 ? 'OVERHEATED_SHORTS_PAY'
      : 'NEUTRAL';

    existing.meanReversionSignal = Math.abs(parseFloat(rate)) > 0.003
      ? 'HIGH_PROBABILITY_MEAN_REVERSION'
      : 'NORMAL';

    this._rates.set(symbol, existing);
  }

  get(symbol) {
    return this._rates.get(symbol) || null;
  }

  getAll() {
    const result = {};
    for (const [sym, data] of this._rates) {
      result[sym] = data;
    }
    return result;
  }

  /**
   * Returns symbols with extreme funding rates (potential reversal setups)
   */
  getExtremes(threshold = 0.003) {
    const extremes = [];
    for (const [sym, data] of this._rates) {
      if (Math.abs(data.rate) > threshold) {
        extremes.push({ symbol: sym, ...data });
      }
    }
    return extremes.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
  }
}

// ─────────────────────────────────────────────
//  OPEN INTEREST TRACKER
// ─────────────────────────────────────────────

class OpenInterestTracker {
  constructor() {
    this._oi = new Map(); // symbol → { value, history[] }
  }

  update(symbol, openInterest) {
    const oi       = parseFloat(openInterest);
    const existing = this._oi.get(symbol) || { history: [] };

    const prev     = existing.history.slice(-1)[0]?.value ?? oi;
    const change   = ((oi - prev) / prev) * 100;

    existing.value    = oi;
    existing.change   = parseFloat(change.toFixed(4));
    existing.history.push({ value: oi, timestamp: Date.now() });
    if (existing.history.length > 200) existing.history.shift();

    // OI + Price divergence is a powerful signal
    existing.trend = change > 0.5 ? 'INCREASING' : change < -0.5 ? 'DECREASING' : 'STABLE';

    this._oi.set(symbol, existing);
  }

  get(symbol) {
    return this._oi.get(symbol) || null;
  }

  /**
   * Analyze OI + price to detect divergence
   * OI rising + price rising = strong trend continuation
   * OI falling + price rising = weakening trend (potential reversal)
   * OI rising + price falling = bearish conviction
   * OI falling + price falling = shorts covering (potential bounce)
   */
  analyzeWithPrice(symbol, currentPrice, prevPrice) {
    const oi = this._oi.get(symbol);
    if (!oi) return null;

    const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;
    const oiChange    = oi.change;

    let signal, strength;

    if (oiChange > 0.5 && priceChange > 0) {
      signal   = 'TREND_CONTINUATION_BULLISH';
      strength = 'STRONG';
    } else if (oiChange < -0.5 && priceChange > 0) {
      signal   = 'WEAKENING_BULLISH_TREND';
      strength = 'CAUTION';
    } else if (oiChange > 0.5 && priceChange < 0) {
      signal   = 'BEARISH_CONVICTION';
      strength = 'STRONG';
    } else if (oiChange < -0.5 && priceChange < 0) {
      signal   = 'SHORT_COVERING_BOUNCE';
      strength = 'MEDIUM';
    } else {
      signal   = 'NEUTRAL';
      strength = 'WEAK';
    }

    return {
      symbol,
      oiValue:    oi.value,
      oiChange:   oi.change,
      priceChange: parseFloat(priceChange.toFixed(4)),
      signal,
      strength,
      note: `OI ${oi.trend} + price ${priceChange > 0 ? 'rising' : 'falling'} = ${signal}`,
    };
  }
}

// ─────────────────────────────────────────────
//  TICK AGGREGATOR — builds candles from raw trades
// ─────────────────────────────────────────────

class TickAggregator {
  constructor() {
    // Map: `${symbol}_${timeframeMs}` → partial candle
    this._partials = new Map();
  }

  /**
   * Process an incoming trade tick and return a candle if one closed.
   *
   * @param {string} symbol
   * @param {number} timeframeMs - candle duration in milliseconds
   * @param {Object} tick - { price, quantity, isBuyerMaker, timestamp }
   * @returns {{ partial: Object, closed: Object|null }}
   */
  processTick(symbol, timeframeMs, tick) {
    const k         = `${symbol}_${timeframeMs}`;
    const candleOpen = Math.floor(tick.timestamp / timeframeMs) * timeframeMs;

    if (!this._partials.has(k)) {
      this._partials.set(k, this._newCandle(symbol, tick, candleOpen, timeframeMs));
    }

    const partial = this._partials.get(k);

    // New candle period started → close old, open new
    if (tick.timestamp >= partial.closeTime) {
      const closed = { ...partial, isClosed: true };
      const fresh  = this._newCandle(symbol, tick, candleOpen, timeframeMs);
      this._partials.set(k, fresh);
      return { partial: fresh, closed };
    }

    // Update current partial candle
    partial.high   = Math.max(partial.high, tick.price);
    partial.low    = Math.min(partial.low,  tick.price);
    partial.close  = tick.price;
    partial.volume += tick.quantity;
    partial.trades += 1;

    if (tick.isBuyerMaker) {
      partial.sellVolume += tick.quantity;
    } else {
      partial.buyVolume  += tick.quantity;
    }

    partial.delta     = partial.buyVolume - partial.sellVolume;
    partial.cvd       = (partial.cvd || 0) + (tick.isBuyerMaker ? -tick.quantity : tick.quantity);

    return { partial, closed: null };
  }

  _newCandle(symbol, tick, openTime, timeframeMs) {
    return {
      symbol,
      timestamp:   openTime,
      openTime,
      closeTime:   openTime + timeframeMs,
      open:        tick.price,
      high:        tick.price,
      low:         tick.price,
      close:       tick.price,
      volume:      tick.quantity,
      buyVolume:   tick.isBuyerMaker ? 0 : tick.quantity,
      sellVolume:  tick.isBuyerMaker ? tick.quantity : 0,
      trades:      1,
      delta:       tick.isBuyerMaker ? -tick.quantity : tick.quantity,
      cvd:         tick.isBuyerMaker ? -tick.quantity : tick.quantity,
      isClosed:    false,
    };
  }
}

// ─────────────────────────────────────────────
//  REST API HELPER — fetch historical candles
// ─────────────────────────────────────────────

class BinanceREST {
  /**
   * Fetch historical klines from Binance REST API.
   * Returns array of candle objects.
   *
   * @param {string} symbol
   * @param {string} interval - '1m', '5m', '1h', etc.
   * @param {number} limit    - number of candles (max 1500)
   * @param {boolean} futures - true for futures endpoint
   * @returns {Promise<Array>}
   */
  static fetchKlines(symbol, interval, limit = 500, futures = false) {
    return new Promise((resolve, reject) => {
      const base  = futures ? BINANCE_REST_FUTURES : BINANCE_REST_SPOT;
      const path  = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const fPath = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const url   = `${base}${futures ? fPath : path}`;

      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const raw = JSON.parse(data);
            if (!Array.isArray(raw)) {
              return reject(new Error(`Binance API error: ${data}`));
            }
            const candles = raw.map(k => ({
              timestamp:  k[0],
              open:       parseFloat(k[1]),
              high:       parseFloat(k[2]),
              low:        parseFloat(k[3]),
              close:      parseFloat(k[4]),
              volume:     parseFloat(k[5]),
              closeTime:  k[6],
              quoteVol:   parseFloat(k[7]),
              trades:     k[8],
              buyVolume:  parseFloat(k[9]),
              sellVolume: parseFloat(k[5]) - parseFloat(k[9]),
              isClosed:   true,
            }));
            resolve(candles);
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Fetch current funding rate for a futures symbol
   */
  static fetchFundingRate(symbol) {
    return new Promise((resolve, reject) => {
      const url = `${BINANCE_REST_FUTURES}/fapi/v1/premiumIndex?symbol=${symbol}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              symbol:          parsed.symbol,
              fundingRate:     parseFloat(parsed.lastFundingRate),
              nextFundingTime: parsed.nextFundingTime,
              markPrice:       parseFloat(parsed.markPrice),
              indexPrice:      parseFloat(parsed.indexPrice),
            });
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Fetch open interest for a futures symbol
   */
  static fetchOpenInterest(symbol) {
    return new Promise((resolve, reject) => {
      const url = `${BINANCE_REST_FUTURES}/fapi/v1/openInterest?symbol=${symbol}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              symbol:       parsed.symbol,
              openInterest: parseFloat(parsed.openInterest),
              timestamp:    parsed.time,
            });
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Fetch 24h ticker stats for a symbol
   */
  static fetch24hTicker(symbol, futures = false) {
    return new Promise((resolve, reject) => {
      const base = futures ? BINANCE_REST_FUTURES : BINANCE_REST_SPOT;
      const path = futures
        ? `/fapi/v1/ticker/24hr?symbol=${symbol}`
        : `/api/v3/ticker/24hr?symbol=${symbol}`;

      https.get(`${base}${path}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const t = JSON.parse(data);
            resolve({
              symbol:        t.symbol,
              priceChange:   parseFloat(t.priceChange),
              priceChangePct: parseFloat(t.priceChangePercent),
              high24h:       parseFloat(t.highPrice),
              low24h:        parseFloat(t.lowPrice),
              volume24h:     parseFloat(t.volume),
              quoteVolume:   parseFloat(t.quoteVolume),
              lastPrice:     parseFloat(t.lastPrice),
              trades:        t.count,
              timestamp:     t.closeTime,
            });
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }
}

// ─────────────────────────────────────────────
//  MAIN BINANCE FEED CLASS
// ─────────────────────────────────────────────

class BinanceFeed extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string[]} config.symbols     - e.g. ['BTCUSDT', 'ETHUSDT', 'XAUUSDT']
   * @param {string[]} config.timeframes  - e.g. ['M1', 'M15', 'H1', 'H4']
   * @param {boolean}  config.futures     - include futures streams
   * @param {boolean}  config.spot        - include spot streams (default true)
   * @param {boolean}  config.orderBook   - stream L2 order book
   * @param {boolean}  config.liquidations - stream liquidations (futures only)
   * @param {boolean}  config.trades      - stream individual trades
   * @param {Object}   config.redis       - optional redis client for pub/sub
   * @param {number}   config.minScore    - minimum SMC score to broadcast (default 70)
   */
  constructor(config = {}) {
    super();

    this.symbols      = (config.symbols || ['BTCUSDT']).map(s => s.toUpperCase());
    this.timeframes   = config.timeframes || ['M15', 'H1', 'H4'];
    this.futures      = config.futures !== false;
    this.spot         = config.spot    !== false;
    this.orderBook    = config.orderBook || false;
    this.liquidations = config.liquidations || false;
    this.streamTrades = config.trades || false;
    this.redis        = config.redis || null;
    this.minScore     = config.minScore || 70;

    // State
    this._wsSpot     = null;
    this._wsFutures  = null;
    this._reconnectAttempts = { spot: 0, futures: 0 };
    this._heartbeatTimers   = {};
    this._isConnected       = { spot: false, futures: false };
    this._subscriptionId    = 1;

    // Data stores
    this.candleStore    = new CandleStore();
    this.orderBooks     = new Map(); // symbol → OrderBook
    this.liquidations_  = new LiquidationTracker();
    this.fundingRates   = new FundingRateTracker();
    this.openInterest   = new OpenInterestTracker();
    this.tickAgg        = new TickAggregator();

    // Price cache: symbol → last price
    this._prices        = new Map();
    this._prevPrices    = new Map();

    // Initialize order books
    for (const sym of this.symbols) {
      this.orderBooks.set(sym, new OrderBook(sym));
    }

    // Stats
    this._stats = {
      messagesReceived: 0,
      candlesEmitted:   0,
      errorsCount:      0,
      startTime:        null,
      reconnects:       0,
    };
  }

  // ─────────────────────────────────────────────
  //  CONNECTION
  // ─────────────────────────────────────────────

  /**
   * Build the combined stream URL for Binance combined streams.
   * Subscribes to klines for all symbols × all timeframes,
   * plus optional depth / trade / liquidation streams.
   */
  _buildStreamList(isFutures = false) {
    const streams = [];

    for (const symbol of this.symbols) {
      const s = symbol.toLowerCase();

      // Kline streams for every timeframe
      for (const tf of this.timeframes) {
        const interval = TIMEFRAMES[tf] || tf;
        streams.push(`${s}@kline_${interval}`);
      }

      // Mini ticker (always on — we need current price)
      streams.push(`${s}@miniTicker`);

      // Order book depth
      if (this.orderBook) {
        streams.push(`${s}@depth${ORDER_BOOK_DEPTH}@100ms`);
      }

      // Individual trade stream
      if (this.streamTrades) {
        streams.push(`${s}@aggTrade`);
      }
    }

    // Liquidation orders (futures only)
    if (isFutures && this.liquidations) {
      streams.push('!forceOrder@arr');
    }

    // All market ticker (futures) — for funding rates
    if (isFutures) {
      streams.push('!markPrice@arr@1s');
    }

    return streams;
  }

  /**
   * Main connect function. Opens spot and/or futures WebSocket connections.
   * Preloads historical candles from REST API.
   */
  async connect() {
    console.log(`[BinanceFeed] Connecting for symbols: ${this.symbols.join(', ')}`);
    console.log(`[BinanceFeed] Timeframes: ${this.timeframes.join(', ')}`);

    this._stats.startTime = Date.now();

    // Preload historical candles
    await this._preloadHistory();

    // Connect WebSockets
    if (this.spot) {
      this._connectSpot();
    }

    if (this.futures) {
      this._connectFutures();
    }

    // Periodic REST polling for OI + funding (every 30s)
    this._startPeriodicPolling();

    this.emit('ready', {
      symbols:    this.symbols,
      timeframes: this.timeframes,
      futures:    this.futures,
      spot:       this.spot,
    });
  }

  /**
   * Preload historical OHLCV data for all symbols and timeframes.
   * This ensures the agent has enough candle history from the start.
   */
  async _preloadHistory() {
    console.log('[BinanceFeed] Preloading historical candles...');

    const tasks = [];

    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        const interval = TIMEFRAMES[tf] || tf;
        const isFutures = this.futures && symbol.endsWith('USDT');

        tasks.push(
          BinanceREST.fetchKlines(symbol, interval, MAX_CANDLE_HISTORY, isFutures)
            .then(candles => {
              for (const candle of candles) {
                this.candleStore.upsert(symbol, tf, candle);
              }
              console.log(`[BinanceFeed] Loaded ${candles.length} candles for ${symbol} ${tf}`);
            })
            .catch(err => {
              console.error(`[BinanceFeed] Failed to load history for ${symbol} ${tf}: ${err.message}`);
            })
        );
      }
    }

    // Run in parallel but limit concurrency to avoid rate limits
    await this._runWithConcurrency(tasks, 5);
    console.log(`[BinanceFeed] History preload complete. Total candles: ${this.candleStore.size()}`);
  }

  /**
   * Run promises with max concurrency
   */
  async _runWithConcurrency(tasks, concurrency) {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      results.push(...await Promise.all(batch));
    }
    return results;
  }

  // ─────────────────────────────────────────────
  //  SPOT WEBSOCKET
  // ─────────────────────────────────────────────

  _connectSpot() {
    const streams = this._buildStreamList(false);
    const url     = `${BINANCE_WS_BASE_SPOT}?streams=${streams.join('/')}`;

    console.log(`[BinanceFeed:Spot] Connecting to ${streams.length} streams`);

    this._wsSpot = new WebSocket(url);

    this._wsSpot.on('open', () => {
      console.log('[BinanceFeed:Spot] Connected');
      this._isConnected.spot = true;
      this._reconnectAttempts.spot = 0;
      this._startHeartbeat('spot', this._wsSpot);
      this.emit('connected', { type: 'spot' });
    });

    this._wsSpot.on('message', (raw) => {
      this._stats.messagesReceived++;
      try {
        const msg = JSON.parse(raw);
        this._handleSpotMessage(msg);
      } catch (err) {
        this._stats.errorsCount++;
        this.emit('error', { source: 'spot_parse', error: err });
      }
    });

    this._wsSpot.on('close', (code, reason) => {
      console.warn(`[BinanceFeed:Spot] Disconnected (${code}): ${reason}`);
      this._isConnected.spot = false;
      this._stopHeartbeat('spot');
      this.emit('disconnected', { type: 'spot', code });
      this._scheduleReconnect('spot');
    });

    this._wsSpot.on('error', (err) => {
      this._stats.errorsCount++;
      console.error(`[BinanceFeed:Spot] WS Error: ${err.message}`);
      this.emit('error', { source: 'spot_ws', error: err });
    });
  }

  // ─────────────────────────────────────────────
  //  FUTURES WEBSOCKET
  // ─────────────────────────────────────────────

  _connectFutures() {
    const streams = this._buildStreamList(true);
    const url     = `${BINANCE_WS_BASE_FUTURES}?streams=${streams.join('/')}`;

    console.log(`[BinanceFeed:Futures] Connecting to ${streams.length} streams`);

    this._wsFutures = new WebSocket(url);

    this._wsFutures.on('open', () => {
      console.log('[BinanceFeed:Futures] Connected');
      this._isConnected.futures = true;
      this._reconnectAttempts.futures = 0;
      this._startHeartbeat('futures', this._wsFutures);
      this.emit('connected', { type: 'futures' });
    });

    this._wsFutures.on('message', (raw) => {
      this._stats.messagesReceived++;
      try {
        const msg = JSON.parse(raw);
        this._handleFuturesMessage(msg);
      } catch (err) {
        this._stats.errorsCount++;
        this.emit('error', { source: 'futures_parse', error: err });
      }
    });

    this._wsFutures.on('close', (code, reason) => {
      console.warn(`[BinanceFeed:Futures] Disconnected (${code}): ${reason}`);
      this._isConnected.futures = false;
      this._stopHeartbeat('futures');
      this.emit('disconnected', { type: 'futures', code });
      this._scheduleReconnect('futures');
    });

    this._wsFutures.on('error', (err) => {
      this._stats.errorsCount++;
      console.error(`[BinanceFeed:Futures] WS Error: ${err.message}`);
      this.emit('error', { source: 'futures_ws', error: err });
    });
  }

  // ─────────────────────────────────────────────
  //  MESSAGE HANDLERS
  // ─────────────────────────────────────────────

  _handleSpotMessage(msg) {
    const data   = msg.data || msg;
    const stream = msg.stream || '';

    if (stream.includes('@kline')) {
      this._handleKline(data, false);
    } else if (stream.includes('@miniTicker')) {
      this._handleMiniTicker(data);
    } else if (stream.includes('@depth')) {
      this._handleDepth(data);
    } else if (stream.includes('@aggTrade')) {
      this._handleAggTrade(data, false);
    }
  }

  _handleFuturesMessage(msg) {
    const data   = msg.data || msg;
    const stream = msg.stream || '';

    if (stream.includes('@kline')) {
      this._handleKline(data, true);
    } else if (stream.includes('@miniTicker')) {
      this._handleMiniTicker(data);
    } else if (stream.includes('@depth')) {
      this._handleDepth(data);
    } else if (stream.includes('@aggTrade')) {
      this._handleAggTrade(data, true);
    } else if (stream.includes('@markPrice') || stream === '!markPrice@arr@1s') {
      this._handleMarkPrice(data);
    } else if (stream === '!forceOrder@arr' || data.e === 'forceOrder') {
      this._handleLiquidation(data);
    }
  }

  /**
   * Handle kline/candlestick update
   */
  _handleKline(data, isFutures) {
    if (!data || !data.k) return;

    const k      = data.k;
    const symbol = k.s;
    const tf     = this._intervalToTF(k.i);

    const candle = {
      timestamp:  k.t,
      open:       parseFloat(k.o),
      high:       parseFloat(k.h),
      low:        parseFloat(k.l),
      close:      parseFloat(k.c),
      volume:     parseFloat(k.v),
      closeTime:  k.T,
      quoteVol:   parseFloat(k.q),
      trades:     k.n,
      buyVolume:  parseFloat(k.V),
      sellVolume: parseFloat(k.v) - parseFloat(k.V),
      isClosed:   k.x,
      isFutures,
    };

    // Update candle store
    const candles = this.candleStore.upsert(symbol, tf, candle);

    // Emit partial candle update
    this.emit('candle_update', {
      symbol,
      timeframe: tf,
      candle,
      candles,
      isClosed: k.x,
    });

    // If candle just closed — emit full signal event
    if (k.x) {
      this._stats.candlesEmitted++;

      const payload = {
        symbol,
        timeframe: tf,
        candle,
        candles: [...candles],     // snapshot for agents
        isFutures,
        fundingRate: this.fundingRates.get(symbol),
        openInterest: this.openInterest.get(symbol),
        timestamp: Date.now(),
      };

      this.emit('candle', payload);

      // Publish to Redis for agent consumption
      if (this.redis) {
        this.redis.publish(
          `feed:candle:${symbol}:${tf}`,
          JSON.stringify(payload)
        ).catch(err => console.error('[BinanceFeed] Redis publish error:', err));
      }
    }
  }

  /**
   * Handle mini ticker — fast price updates
   */
  _handleMiniTicker(data) {
    if (!data || !data.s) return;

    const symbol = data.s;
    const price  = parseFloat(data.c);

    this._prevPrices.set(symbol, this._prices.get(symbol) ?? price);
    this._prices.set(symbol, price);

    this.emit('price', {
      symbol,
      price,
      prevPrice:  this._prevPrices.get(symbol),
      open24h:    parseFloat(data.o),
      high24h:    parseFloat(data.h),
      low24h:     parseFloat(data.l),
      volume24h:  parseFloat(data.v),
      timestamp:  data.E || Date.now(),
    });
  }

  /**
   * Handle order book depth update
   */
  _handleDepth(data) {
    if (!data || !data.s) return;

    const book = this.orderBooks.get(data.s);
    if (!book) return;

    book.update(data.b || [], data.a || [], data.u || Date.now());

    const snapshot = book.getSnapshot();
    this.emit('orderbook', snapshot);

    // Alert on extreme imbalance
    if (Math.abs(snapshot.imbalance) > 30) {
      this.emit('orderbook_imbalance', {
        ...snapshot,
        alert: `Extreme order book imbalance: ${snapshot.imbalanceBias} (${snapshot.imbalance.toFixed(1)}%)`,
      });
    }
  }

  /**
   * Handle aggregated trade stream
   */
  _handleAggTrade(data, isFutures) {
    if (!data) return;

    const tick = {
      symbol:        data.s,
      price:         parseFloat(data.p),
      quantity:      parseFloat(data.q),
      isBuyerMaker:  data.m,
      timestamp:     data.T || Date.now(),
      isFutures,
    };

    this.emit('tick', tick);

    // Detect large trades (whale activity)
    const usdtValue = tick.price * tick.quantity;
    if (usdtValue > 100000) {
      this.emit('large_trade', {
        ...tick,
        usdtValue: parseFloat(usdtValue.toFixed(2)),
        direction: tick.isBuyerMaker ? 'SELL' : 'BUY',
        note: `Large ${tick.isBuyerMaker ? 'SELL' : 'BUY'} — $${(usdtValue / 1000).toFixed(1)}K`,
      });
    }
  }

  /**
   * Handle mark price + funding rate update
   */
  _handleMarkPrice(data) {
    // Binance sends array of all symbols
    const items = Array.isArray(data) ? data : [data];

    for (const item of items) {
      if (!item.s) continue;

      this.fundingRates.update(item.s, item.r || '0', item.T);

      this.emit('funding_rate', {
        symbol:          item.s,
        markPrice:       parseFloat(item.p),
        indexPrice:      parseFloat(item.i || item.p),
        fundingRate:     parseFloat(item.r || 0),
        nextFundingTime: item.T,
        ...this.fundingRates.get(item.s),
      });
    }

    // Check for funding extremes every update
    const extremes = this.fundingRates.getExtremes(0.003);
    if (extremes.length > 0) {
      this.emit('funding_extreme', extremes);
    }
  }

  /**
   * Handle liquidation orders
   */
  _handleLiquidation(data) {
    if (!data || !data.o) return;

    const o = data.o;
    const usdtValue = parseFloat(o.p) * parseFloat(o.q);

    const liq = {
      symbol:     o.s,
      side:       o.S,        // BUY = short liq, SELL = long liq
      price:      parseFloat(o.p),
      quantity:   parseFloat(o.q),
      usdtValue:  parseFloat(usdtValue.toFixed(2)),
      timestamp:  o.T || Date.now(),
      note:       o.S === 'SELL'
        ? `LONG liquidated: $${(usdtValue / 1000).toFixed(1)}K`
        : `SHORT liquidated: $${(usdtValue / 1000).toFixed(1)}K`,
    };

    this.liquidations_.add(liq);
    this.emit('liquidation', liq);

    // Check for cascade
    const cascade = this.liquidations_.detectCascade(500000, 10000);
    if (cascade.isCascade) {
      this.emit('liquidation_cascade', {
        ...cascade,
        alert: `⚠️ Liquidation cascade detected: $${(cascade.totalUSDT / 1000000).toFixed(2)}M in 10s`,
      });
    }
  }

  // ─────────────────────────────────────────────
  //  HEARTBEAT
  // ─────────────────────────────────────────────

  _startHeartbeat(type, ws) {
    this._stopHeartbeat(type);
    this._heartbeatTimers[type] = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat(type) {
    if (this._heartbeatTimers[type]) {
      clearInterval(this._heartbeatTimers[type]);
      delete this._heartbeatTimers[type];
    }
  }

  // ─────────────────────────────────────────────
  //  RECONNECT
  // ─────────────────────────────────────────────

  _scheduleReconnect(type) {
    const attempts = ++this._reconnectAttempts[type];

    if (attempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(`[BinanceFeed:${type}] Max reconnect attempts reached. Giving up.`);
      this.emit('fatal', { type, message: 'Max reconnect attempts reached' });
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s... capped at 60s
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempts - 1), 60000);
    this._stats.reconnects++;

    console.log(`[BinanceFeed:${type}] Reconnecting in ${delay / 1000}s (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);

    setTimeout(() => {
      if (type === 'spot')    this._connectSpot();
      if (type === 'futures') this._connectFutures();
    }, delay);
  }

  // ─────────────────────────────────────────────
  //  PERIODIC REST POLLING
  // ─────────────────────────────────────────────

  _startPeriodicPolling() {
    // Poll Open Interest every 30 seconds
    setInterval(async () => {
      for (const symbol of this.symbols) {
        if (!this.futures) continue;
        try {
          const oi = await BinanceREST.fetchOpenInterest(symbol);
          this.openInterest.update(symbol, oi.openInterest);

          const prevPrice = this._prevPrices.get(symbol);
          const currPrice = this._prices.get(symbol);

          if (prevPrice && currPrice) {
            const analysis = this.openInterest.analyzeWithPrice(symbol, currPrice, prevPrice);
            if (analysis) {
              this.emit('open_interest', analysis);
            }
          }
        } catch (e) {
          // Silent fail on OI poll — not critical
        }
      }
    }, 30000);
  }

  // ─────────────────────────────────────────────
  //  UTILITIES
  // ─────────────────────────────────────────────

  /**
   * Convert Binance interval string to our TF key
   */
  _intervalToTF(interval) {
    const map = {
      '1m': 'M1', '3m': 'M3', '5m': 'M5', '15m': 'M15', '30m': 'M30',
      '1h': 'H1', '2h': 'H2', '4h': 'H4', '6h': 'H6', '8h': 'H8',
      '12h': 'H12', '1d': 'D1', '1w': 'W1', '1M': 'MN',
    };
    return map[interval] || interval;
  }

  /**
   * Get current price for a symbol
   */
  getPrice(symbol) {
    return this._prices.get(symbol.toUpperCase()) || null;
  }

  /**
   * Get full candle history for symbol + timeframe
   */
  getCandles(symbol, timeframe) {
    return this.candleStore.get(symbol.toUpperCase(), timeframe);
  }

  /**
   * Get order book snapshot for a symbol
   */
  getOrderBook(symbol) {
    const book = this.orderBooks.get(symbol.toUpperCase());
    return book ? book.getSnapshot() : null;
  }

  /**
   * Get connection and performance stats
   */
  getStats() {
    const uptime = this._stats.startTime
      ? Math.floor((Date.now() - this._stats.startTime) / 1000)
      : 0;

    return {
      ...this._stats,
      uptime,
      connected: this._isConnected,
      symbols:   this.symbols,
      candleCount: this.candleStore.size(),
      prices:    Object.fromEntries(this._prices),
    };
  }

  /**
   * Graceful disconnect
   */
  disconnect() {
    console.log('[BinanceFeed] Disconnecting...');
    this._stopHeartbeat('spot');
    this._stopHeartbeat('futures');

    if (this._wsSpot && this._wsSpot.readyState === WebSocket.OPEN) {
      this._wsSpot.close(1000, 'Graceful shutdown');
    }
    if (this._wsFutures && this._wsFutures.readyState === WebSocket.OPEN) {
      this._wsFutures.close(1000, 'Graceful shutdown');
    }

    this.emit('closed');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  BinanceFeed,
  BinanceREST,
  CandleStore,
  OrderBook,
  LiquidationTracker,
  FundingRateTracker,
  OpenInterestTracker,
  TickAggregator,
  TIMEFRAMES,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { BinanceFeed } = require('./binance-ws');
 *  const { SMCAgent }    = require('./smc-agent');
 *
 *  const feed = new BinanceFeed({
 *    symbols:      ['BTCUSDT', 'ETHUSDT', 'XAUUSDT'],
 *    timeframes:   ['M15', 'H1', 'H4'],
 *    futures:      true,
 *    spot:         true,
 *    orderBook:    true,
 *    liquidations: true,
 *  });
 *
 *  const agent = new SMCAgent({ symbol: 'BTCUSDT', timeframe: 'H1' });
 *
 *  // Every closed candle → run SMC analysis
 *  feed.on('candle', async ({ symbol, timeframe, candles }) => {
 *    const result = await agent.analyze(candles);
 *    if (result.signal.action !== 'WAIT') {
 *      console.log('SIGNAL:', result.signal);
 *      // → pass to signal-scorer.js
 *    }
 *  });
 *
 *  // Real-time price
 *  feed.on('price', ({ symbol, price }) => {
 *    console.log(`${symbol}: ${price}`);
 *  });
 *
 *  // Liquidation alert
 *  feed.on('liquidation', (liq) => {
 *    console.log('Liquidation:', liq.note);
 *  });
 *
 *  // Liquidation cascade warning
 *  feed.on('liquidation_cascade', (cascade) => {
 *    console.warn(cascade.alert);
 *  });
 *
 *  // Large whale trade detected
 *  feed.on('large_trade', (trade) => {
 *    console.log('Whale:', trade.note);
 *  });
 *
 *  await feed.connect();
 * ─────────────────────────────────────────────
 */
