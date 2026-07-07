/**
 * ============================================================
 *  BYBIT WEBSOCKET ENGINE — Perpetuals, Funding & Order Flow
 *  AI Trading Assistant · Layer 10 · Data Feed Module
 *  File: feeds/bybit-ws.js
 * ============================================================
 *
 *  Built on Bybit's v5 Unified Trading API WebSocket spec.
 *
 *  Modules inside this file:
 *
 *  1. BybitCandleStore        — multi-TF OHLCV per symbol (spot + linear + inverse)
 *  2. BybitOrderBookEngine    — full L2 depth (50/200/500 levels) with delta merge
 *  3. BybitFundingEngine      — funding rate history, predicted rate, basis tracking
 *  4. BybitOpenInterestEngine — OI snapshots + OI/price divergence
 *  5. BybitLiquidationEngine  — liquidation stream + cascade detection + heatmap
 *  6. BybitInsuranceFundTracker — insurance fund balance changes (systemic risk signal)
 *  7. BybitTickerEngine       — 24h ticker, mark/index price, basis spread
 *  8. BybitTradeFlowEngine    — public trade stream → CVD, large-print detection
 *  9. BybitWSConnection       — low-level WS wrapper: auth, ping/pong, reconnect
 *  10. BybitFeed (main class) — orchestrates everything, EventEmitter API
 *
 *  Bybit-specific features this captures that Binance doesn't expose the
 *  same way:
 *    - category-based routing (spot / linear / inverse / option)
 *    - predicted next funding rate (not just last funding)
 *    - basis (perp vs spot) tracking for arbitrage/sentiment signal
 *    - insurance fund balance — a systemic stress indicator
 *    - open interest value in both base coin AND USD
 * ============================================================
 */

'use strict';

const WebSocket    = require('ws');
const EventEmitter = require('events');
const https        = require('https');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const BYBIT_WS_PUBLIC = {
  spot:    'wss://stream.bybit.com/v5/public/spot',
  linear:  'wss://stream.bybit.com/v5/public/linear',
  inverse: 'wss://stream.bybit.com/v5/public/inverse',
  option:  'wss://stream.bybit.com/v5/public/option',
};

const BYBIT_REST_BASE = 'https://api.bybit.com';

const TIMEFRAMES = {
  M1: '1', M3: '3', M5: '5', M15: '15', M30: '30',
  H1: '60', H2: '120', H4: '240', H6: '360', H12: '720',
  D1: 'D', W1: 'W', MN: 'M',
};

const MAX_RECONNECT_ATTEMPTS = 25;
const RECONNECT_BASE_DELAY   = 1000;
const HEARTBEAT_INTERVAL     = 20000; // Bybit recommends ping every 20s
const MAX_CANDLE_HISTORY     = 500;
const ORDER_BOOK_DEPTH       = 50;
const MAX_TOPICS_PER_CONN    = 200; // Bybit caps args per subscribe call

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────

function round(n, d = 5) { return parseFloat((n ?? 0).toFixed(d)); }

// ─────────────────────────────────────────────
//  1. CANDLE STORE
// ─────────────────────────────────────────────

class BybitCandleStore {
  constructor() {
    this._store = new Map(); // `${category}_${symbol}_${tf}` → candles[]
  }

  key(category, symbol, tf) { return `${category}_${symbol}_${tf}`; }

  upsert(category, symbol, tf, candle) {
    const k = this.key(category, symbol, tf);
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

  get(category, symbol, tf) {
    return this._store.get(this.key(category, symbol, tf)) || [];
  }

  size() {
    let total = 0;
    for (const arr of this._store.values()) total += arr.length;
    return total;
  }
}

// ─────────────────────────────────────────────
//  2. ORDER BOOK ENGINE
// ─────────────────────────────────────────────

class BybitOrderBookEngine {
  constructor(symbol, depth = ORDER_BOOK_DEPTH) {
    this.symbol = symbol;
    this.depth  = depth;
    this.bids   = new Map();
    this.asks   = new Map();
    this._lastUpdateId = 0;
    this._snapshotReceived = false;
  }

  /**
   * Bybit sends a 'snapshot' first, then 'delta' updates.
   * type: 'snapshot' resets the book; 'delta' merges.
   */
  process(data, type) {
    const { b: bids, a: asks, u: updateId, seq } = data;

    if (type === 'snapshot') {
      this.bids.clear();
      this.asks.clear();
      this._snapshotReceived = true;
    }

    if (!this._snapshotReceived) return; // wait for snapshot before applying deltas

    for (const [price, qty] of bids || []) {
      const p = parseFloat(price), q = parseFloat(qty);
      if (q === 0) this.bids.delete(p); else this.bids.set(p, q);
    }
    for (const [price, qty] of asks || []) {
      const p = parseFloat(price), q = parseFloat(qty);
      if (q === 0) this.asks.delete(p); else this.asks.set(p, q);
    }

    this._lastUpdateId = updateId ?? this._lastUpdateId;
  }

  getSnapshot(levels = this.depth) {
    const sortedBids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, levels);
    const sortedAsks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, levels);

    const bestBid = sortedBids[0]?.[0] ?? 0;
    const bestAsk = sortedAsks[0]?.[0] ?? 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPct = bestBid > 0 ? (spread / bestBid) * 100 : 0;

    const bidVolume = sortedBids.reduce((s, [, q]) => s + q, 0);
    const askVolume = sortedAsks.reduce((s, [, q]) => s + q, 0);
    const imbalance = (bidVolume + askVolume > 0 && !isNaN(bidVolume + askVolume))
      ? ((bidVolume - askVolume) / (bidVolume + askVolume)) * 100
      : 0;

    return {
      symbol: this.symbol,
      bids: sortedBids, asks: sortedAsks,
      bestBid, bestAsk,
      midPrice: round(midPrice), spread: round(spread, 6), spreadPct: round(spreadPct, 4),
      bidVolume: round(bidVolume, 4), askVolume: round(askVolume, 4),
      imbalance: round(imbalance, 2),
      imbalanceBias: imbalance > 10 ? 'BULLISH' : imbalance < -10 ? 'BEARISH' : 'NEUTRAL',
      timestamp: Date.now(),
    };
  }
}

// ─────────────────────────────────────────────
//  3. FUNDING ENGINE (with predicted rate + basis)
// ─────────────────────────────────────────────

class BybitFundingEngine {
  constructor() {
    this._rates = new Map(); // symbol → { current, predicted, history[], basis }
  }

  updateCurrent(symbol, fundingRate, fundingRateTimestamp) {
    const existing = this._rates.get(symbol) || { history: [] };
    existing.current = parseFloat(fundingRate);
    existing.lastUpdate = fundingRateTimestamp;
    existing.annualized = existing.current * 3 * 365 * 100; // Bybit settles 3x/day

    existing.history.push({ rate: existing.current, timestamp: Date.now() });
    if (existing.history.length > 200) existing.history.shift();

    existing.bias = existing.current > 0.001 ? 'OVERHEATED_LONGS_PAY'
      : existing.current < -0.001 ? 'OVERHEATED_SHORTS_PAY' : 'NEUTRAL';
    existing.meanReversionSignal = Math.abs(existing.current) > 0.003
      ? 'HIGH_PROBABILITY_MEAN_REVERSION' : 'NORMAL';

    this._rates.set(symbol, existing);
  }

  /**
   * Predicted next funding rate (from tickers stream, updates continuously
   * leading up to settlement — useful to front-run a known funding flip)
   */
  updatePredicted(symbol, predictedRate) {
    const existing = this._rates.get(symbol) || { history: [] };
    existing.predicted = parseFloat(predictedRate);
    existing.predictedAnnualized = existing.predicted * 3 * 365 * 100;
    this._rates.set(symbol, existing);
  }

  /**
   * Basis = (perp mark price - spot index price) / spot index price.
   * Positive basis = perp trading at premium = bullish leverage demand.
   * Negative basis = perp trading at discount = bearish leverage demand.
   */
  updateBasis(symbol, markPrice, indexPrice) {
    const existing = this._rates.get(symbol) || { history: [] };
    const basis = indexPrice > 0 ? ((markPrice - indexPrice) / indexPrice) * 100 : 0;
    existing.basis = round(basis, 4);
    existing.basisSignal = basis > 0.05 ? 'PREMIUM_BULLISH_LEVERAGE'
      : basis < -0.05 ? 'DISCOUNT_BEARISH_LEVERAGE' : 'NEUTRAL';
    this._rates.set(symbol, existing);
  }

  get(symbol) { return this._rates.get(symbol) || null; }

  getExtremes(threshold = 0.003) {
    const extremes = [];
    for (const [sym, data] of this._rates) {
      if (Math.abs(data.current ?? 0) > threshold) extremes.push({ symbol: sym, ...data });
    }
    return extremes.sort((a, b) => Math.abs(b.current) - Math.abs(a.current));
  }

  /**
   * Flags symbols where predicted funding diverges sharply from current —
   * signals an imminent funding flip (positioning shift incoming)
   */
  getImminentFlips(threshold = 0.0015) {
    const flips = [];
    for (const [sym, data] of this._rates) {
      if (data.current === undefined || data.predicted === undefined) continue;
      const delta = data.predicted - data.current;
      if (Math.abs(delta) >= threshold && Math.sign(data.current) !== Math.sign(data.predicted)) {
        flips.push({ symbol: sym, current: data.current, predicted: data.predicted, delta: round(delta, 5) });
      }
    }
    return flips;
  }
}

// ─────────────────────────────────────────────
//  4. OPEN INTEREST ENGINE
// ─────────────────────────────────────────────

class BybitOpenInterestEngine {
  constructor() {
    this._oi = new Map(); // symbol → { value, valueUSD, history[] }
  }

  update(symbol, openInterest, openInterestValue) {
    const oi = parseFloat(openInterest);
    const oiUSD = parseFloat(openInterestValue ?? 0);
    const existing = this._oi.get(symbol) || { history: [] };

    const prev = existing.history.slice(-1)[0]?.value ?? oi;
    const change = prev > 0 ? ((oi - prev) / prev) * 100 : 0;

    existing.value = oi;
    existing.valueUSD = oiUSD;
    existing.change = round(change, 4);
    existing.history.push({ value: oi, timestamp: Date.now() });
    if (existing.history.length > 200) existing.history.shift();
    existing.trend = change > 0.5 ? 'INCREASING' : change < -0.5 ? 'DECREASING' : 'STABLE';

    this._oi.set(symbol, existing);
  }

  get(symbol) { return this._oi.get(symbol) || null; }

  analyzeWithPrice(symbol, currentPrice, prevPrice) {
    const oi = this._oi.get(symbol);
    if (!oi) return null;

    const priceChange = prevPrice > 0 ? ((currentPrice - prevPrice) / prevPrice) * 100 : 0;
    const oiChange = oi.change;

    let signal, strength;
    if (oiChange > 0.5 && priceChange > 0)       { signal = 'TREND_CONTINUATION_BULLISH'; strength = 'STRONG'; }
    else if (oiChange < -0.5 && priceChange > 0) { signal = 'SHORT_COVERING_BOUNCE';      strength = 'CAUTION'; }
    else if (oiChange > 0.5 && priceChange < 0)  { signal = 'BEARISH_CONVICTION';          strength = 'STRONG'; }
    // FIX: was mislabeled 'SHORT_COVERING_BOUNCE' — short covering (shorts
    // buying back to close) mechanically pushes price UP, not down. Falling
    // price + decreasing OI is longs exiting/getting liquidated, a weaker
    // bearish signal (declining conviction), not a bullish bounce setup.
    else if (oiChange < -0.5 && priceChange < 0) { signal = 'LONG_LIQUIDATION_WEAKENING_BEARISH'; strength = 'MEDIUM'; }
    else                                          { signal = 'NEUTRAL';                     strength = 'WEAK'; }

    return {
      symbol, oiValue: oi.value, oiValueUSD: oi.valueUSD, oiChange: oi.change,
      priceChange: round(priceChange, 4), signal, strength,
      note: `OI ${oi.trend} + price ${priceChange > 0 ? 'rising' : 'falling'} = ${signal}`,
    };
  }
}

// ─────────────────────────────────────────────
//  5. LIQUIDATION ENGINE
// ─────────────────────────────────────────────

class BybitLiquidationEngine {
  constructor() {
    this._recent = [];
    this._heatmapBySymbol = new Map(); // symbol → price bucket → cumulative liq value
  }

  add(liq) {
    this._recent.push(liq);
    if (this._recent.length > 300) this._recent.shift();

    // Heatmap: bucket by price rounded to a sensible granularity
    if (!this._heatmapBySymbol.has(liq.symbol)) this._heatmapBySymbol.set(liq.symbol, new Map());
    const heatmap = this._heatmapBySymbol.get(liq.symbol);
    const bucket = this._priceToBucket(liq.symbol, liq.price);
    heatmap.set(bucket, (heatmap.get(bucket) || 0) + liq.usdtValue);
  }

  _priceToBucket(symbol, price) {
    // Bucket size scales with price magnitude (rough heuristic)
    if (price <= 0 || !Number.isFinite(price)) return 0;
    const magnitude = Math.pow(10, Math.floor(Math.log10(price)) - 2);
    if (magnitude === 0) return price;
    return Math.round(price / magnitude) * magnitude;
  }

  getStats(windowMs = 60000) {
    const cutoff = Date.now() - windowMs;
    const inWindow = this._recent.filter(l => l.timestamp > cutoff);

    const longLiqs  = inWindow.filter(l => l.side === 'Sell'); // Bybit: Sell side liq = long position liquidated
    const shortLiqs = inWindow.filter(l => l.side === 'Buy');

    const longUSDT  = longLiqs.reduce((s, l) => s + l.usdtValue, 0);
    const shortUSDT = shortLiqs.reduce((s, l) => s + l.usdtValue, 0);
    const totalUSDT = longUSDT + shortUSDT;

    return {
      window: windowMs, total: inWindow.length,
      longCount: longLiqs.length, shortCount: shortLiqs.length,
      longUSDT: round(longUSDT, 2), shortUSDT: round(shortUSDT, 2), totalUSDT: round(totalUSDT, 2),
      dominance: longUSDT > shortUSDT ? 'LONG_DOMINATED' : 'SHORT_DOMINATED',
      marketSignal: longUSDT > shortUSDT * 2 ? 'BEARISH_LONGS_REKT'
        : shortUSDT > longUSDT * 2 ? 'BULLISH_SHORTS_REKT' : 'BALANCED',
    };
  }

  detectCascade(thresholdUSDT = 750000, windowMs = 10000) {
    const stats = this.getStats(windowMs);
    return { isCascade: stats.totalUSDT > thresholdUSDT, ...stats };
  }

  /**
   * Returns the price levels with the heaviest historical liquidation
   * concentration for a symbol — these act as "magnet" zones price
   * tends to revisit (stop-hunt targets).
   */
  getHeatmap(symbol, topN = 10) {
    const heatmap = this._heatmapBySymbol.get(symbol);
    if (!heatmap) return [];

    return [...heatmap.entries()]
      .map(([price, value]) => ({ price, value: round(value, 2) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, topN);
  }
}

// ─────────────────────────────────────────────
//  6. INSURANCE FUND TRACKER
// ─────────────────────────────────────────────

class BybitInsuranceFundTracker {
  /**
   * The insurance fund absorbs losses from liquidations that exceed a
   * trader's margin (bankruptcy gap). A rapidly DEPLETING insurance
   * fund during high volatility is a systemic-risk early warning —
   * historically precedes broader deleveraging events.
   */
  constructor() {
    this._history = []; // { timestamp, balance, coin }
  }

  update(coin, balance) {
    this._history.push({ timestamp: Date.now(), balance: parseFloat(balance), coin });
    if (this._history.length > 500) this._history.shift();
  }

  getTrend(windowMs = 3600000) {
    const cutoff = Date.now() - windowMs;
    const inWindow = this._history.filter(h => h.timestamp > cutoff);
    if (inWindow.length < 2) return { trend: 'INSUFFICIENT_DATA', changePct: 0 };

    const first = inWindow[0].balance;
    const last = inWindow[inWindow.length - 1].balance;
    const changePct = first > 0 ? ((last - first) / first) * 100 : 0;

    return {
      trend: changePct < -2 ? 'DEPLETING_FAST' : changePct < -0.5 ? 'DEPLETING' : changePct > 0.5 ? 'GROWING' : 'STABLE',
      changePct: round(changePct, 3),
      current: last,
      systemicRiskFlag: changePct < -2,
      note: changePct < -2
        ? '⚠️ Insurance fund depleting rapidly — systemic deleveraging risk elevated'
        : 'Insurance fund stable',
    };
  }
}

// ─────────────────────────────────────────────
//  7. TICKER ENGINE
// ─────────────────────────────────────────────

class BybitTickerEngine {
  constructor() {
    this._tickers = new Map(); // symbol → latest ticker data
  }

  update(symbol, data) {
    const existing = this._tickers.get(symbol) || {};
    this._tickers.set(symbol, {
      ...existing,
      lastPrice:   parseFloat(data.lastPrice ?? existing.lastPrice ?? 0),
      markPrice:   parseFloat(data.markPrice ?? existing.markPrice ?? 0),
      indexPrice:  parseFloat(data.indexPrice ?? existing.indexPrice ?? 0),
      high24h:     parseFloat(data.highPrice24h ?? existing.high24h ?? 0),
      low24h:      parseFloat(data.lowPrice24h ?? existing.low24h ?? 0),
      volume24h:   parseFloat(data.volume24h ?? existing.volume24h ?? 0),
      turnover24h: parseFloat(data.turnover24h ?? existing.turnover24h ?? 0),
      pctChange24h: parseFloat(data.price24hPcnt ?? existing.pctChange24h ?? 0) * 100,
      openInterest: parseFloat(data.openInterest ?? existing.openInterest ?? 0),
      fundingRate:  parseFloat(data.fundingRate ?? existing.fundingRate ?? 0),
      nextFundingTime: data.nextFundingTime ?? existing.nextFundingTime,
      timestamp: Date.now(),
    });
  }

  get(symbol) { return this._tickers.get(symbol) || null; }
  getAll() { return Object.fromEntries(this._tickers); }
}

// ─────────────────────────────────────────────
//  8. TRADE FLOW ENGINE (CVD + large prints)
// ─────────────────────────────────────────────

class BybitTradeFlowEngine {
  constructor() {
    this._cvd = new Map(); // symbol → running CVD
    this._recentTrades = new Map(); // symbol → recent trade array
  }

  process(symbol, trade) {
    const { side, size, price, timestamp } = trade;
    const usdtValue = parseFloat(price) * parseFloat(size);
    const isBuy = side === 'Buy';

    const currentCVD = this._cvd.get(symbol) || 0;
    const newCVD = currentCVD + (isBuy ? usdtValue : -usdtValue);
    this._cvd.set(symbol, newCVD);

    if (!this._recentTrades.has(symbol)) this._recentTrades.set(symbol, []);
    const arr = this._recentTrades.get(symbol);
    arr.push({ side, size: parseFloat(size), price: parseFloat(price), usdtValue, timestamp });
    if (arr.length > 200) arr.shift();

    return {
      symbol, side, price: parseFloat(price), size: parseFloat(size),
      usdtValue: round(usdtValue, 2), cvd: round(newCVD, 2),
      isLargePrint: usdtValue > 50000,
      timestamp,
    };
  }

  getCVD(symbol) { return round(this._cvd.get(symbol) || 0, 2); }

  getRecentLargePrints(symbol, minUsd = 100000, n = 10) {
    const arr = this._recentTrades.get(symbol) || [];
    return arr.filter(t => t.usdtValue >= minUsd).slice(-n).reverse();
  }
}

// ─────────────────────────────────────────────
//  9. WS CONNECTION WRAPPER
// ─────────────────────────────────────────────

class BybitWSConnection extends EventEmitter {
  /**
   * Low-level WebSocket wrapper handling one Bybit category
   * (spot / linear / inverse). Handles auth-free public stream
   * connect, subscribe batching, ping/pong, and reconnection.
   */
  constructor(category, config = {}) {
    super();
    this.category = category;
    this.url = BYBIT_WS_PUBLIC[category];
    this._ws = null;
    this._topics = new Set();
    this._reconnectAttempts = 0;
    this._heartbeatTimer = null;
    this._connected = false;
    this._reqId = 1;
  }

  connect() {
    this._ws = new WebSocket(this.url);

    this._ws.on('open', () => {
      this._connected = true;
      this._reconnectAttempts = 0;
      this._startHeartbeat();
      this._resubscribeAll();
      this.emit('open');
    });

    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleMessage(msg);
      } catch (err) {
        this.emit('error', { source: 'parse', error: err });
      }
    });

    this._ws.on('close', (code, reason) => {
      this._connected = false;
      this._stopHeartbeat();
      this.emit('close', { code, reason: reason?.toString() });
      this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      this.emit('error', { source: 'ws', error: err });
    });
  }

  _handleMessage(msg) {
    // Pong response
    if (msg.op === 'pong' || msg.ret_msg === 'pong') return;

    // Subscription ack
    if (msg.op === 'subscribe') {
      this.emit('subscribed', { success: msg.success, topics: msg.req_id });
      return;
    }

    // Actual data message
    if (msg.topic) {
      this.emit('data', msg);
    }
  }

  subscribe(topics) {
    const arr = Array.isArray(topics) ? topics : [topics];
    arr.forEach(t => this._topics.add(t));

    if (this._connected) {
      this._sendSubscribe(arr);
    }
  }

  _sendSubscribe(topics) {
    // Bybit caps args per message — chunk into batches
    for (let i = 0; i < topics.length; i += MAX_TOPICS_PER_CONN) {
      const chunk = topics.slice(i, i + MAX_TOPICS_PER_CONN);
      this._ws.send(JSON.stringify({
        op: 'subscribe',
        req_id: String(this._reqId++),
        args: chunk,
      }));
    }
  }

  _resubscribeAll() {
    if (this._topics.size === 0) return;
    this._sendSubscribe([...this._topics]);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  _scheduleReconnect() {
    this._reconnectAttempts++;
    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.emit('fatal', { category: this.category, message: 'Max reconnect attempts reached' });
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
}

// ─────────────────────────────────────────────
//  REST HELPERS
// ─────────────────────────────────────────────

class BybitREST {
  static fetchKlines(category, symbol, interval, limit = 500) {
    return new Promise((resolve, reject) => {
      const url = `${BYBIT_REST_BASE}/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.retCode !== 0) return reject(new Error(`Bybit API error: ${parsed.retMsg}`));
            const candles = (parsed.result.list || []).reverse().map(k => ({
              timestamp: parseInt(k[0], 10),
              open:  parseFloat(k[1]), high: parseFloat(k[2]),
              low:   parseFloat(k[3]), close: parseFloat(k[4]),
              volume: parseFloat(k[5]), turnover: parseFloat(k[6]),
              isClosed: true,
            }));
            resolve(candles);
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  static fetchInsuranceFund(coin = 'USDT') {
    return new Promise((resolve, reject) => {
      const url = `${BYBIT_REST_BASE}/v5/insurance?coin=${coin}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.result?.list?.[0] || null);
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }
}

// ─────────────────────────────────────────────
//  10. MAIN BYBIT FEED CLASS
// ─────────────────────────────────────────────

class BybitFeed extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string[]} config.symbols     - e.g. ['BTCUSDT','ETHUSDT']
   * @param {string[]} config.timeframes  - e.g. ['M15','H1','H4']
   * @param {string}   config.category    - 'linear' (perps, default), 'spot', 'inverse'
   * @param {boolean}  config.orderBook   - stream L2 depth
   * @param {boolean}  config.liquidations - stream liquidations
   * @param {boolean}  config.trades      - stream public trades
   */
  constructor(config = {}) {
    super();
    this.symbols      = (config.symbols || ['BTCUSDT']).map(s => s.toUpperCase());
    this.timeframes   = config.timeframes || ['M15', 'H1', 'H4'];
    this.category     = config.category || 'linear';
    this.streamOrderBook = config.orderBook ?? false;
    this.streamLiquidations = config.liquidations ?? true;
    this.streamTrades = config.trades ?? false;

    this.candleStore   = new BybitCandleStore();
    this.orderBooks    = new Map();
    this.funding       = new BybitFundingEngine();
    this.openInterest  = new BybitOpenInterestEngine();
    this.liquidations  = new BybitLiquidationEngine();
    this.insuranceFund = new BybitInsuranceFundTracker();
    this.tickers       = new BybitTickerEngine();
    this.tradeFlow     = new BybitTradeFlowEngine();

    this._prices = new Map();
    this._prevPrices = new Map();
    this._conn = null;

    this._stats = { messagesReceived: 0, candlesEmitted: 0, errorsCount: 0, startTime: null };

    for (const sym of this.symbols) this.orderBooks.set(sym, new BybitOrderBookEngine(sym));
  }

  async connect() {
    console.log(`[BybitFeed] Connecting (${this.category}) for: ${this.symbols.join(', ')}`);
    this._stats.startTime = Date.now();

    await this._preloadHistory();

    this._conn = new BybitWSConnection(this.category);
    this._conn.on('open', () => {
      console.log('[BybitFeed] Connected');
      this._subscribeAll();
      this.emit('connected');
    });
    this._conn.on('data', (msg) => this._handleData(msg));
    this._conn.on('error', (e) => { this._stats.errorsCount++; this.emit('error', e); });
    this._conn.on('close', (e) => this.emit('disconnected', e));
    this._conn.on('fatal', (e) => this.emit('fatal', e));
    this._conn.connect();

    this._startPeriodicPolling();
    this.emit('ready', { symbols: this.symbols, category: this.category });
  }

  async _preloadHistory() {
    console.log('[BybitFeed] Preloading historical candles...');
    const tasks = [];
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        const interval = TIMEFRAMES[tf] || tf;
        tasks.push(
          BybitREST.fetchKlines(this.category, symbol, interval, MAX_CANDLE_HISTORY)
            .then(candles => {
              for (const c of candles) this.candleStore.upsert(this.category, symbol, tf, c);
              console.log(`[BybitFeed] Loaded ${candles.length} candles for ${symbol} ${tf}`);
            })
            .catch(err => console.error(`[BybitFeed] History load failed ${symbol} ${tf}: ${err.message}`))
        );
      }
    }
    await Promise.all(tasks);
    console.log(`[BybitFeed] Preload complete. Total candles: ${this.candleStore.size()}`);
  }

  _subscribeAll() {
    const topics = [];
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        topics.push(`kline.${TIMEFRAMES[tf] || tf}.${symbol}`);
      }
      topics.push(`tickers.${symbol}`);
      if (this.streamOrderBook) topics.push(`orderbook.${ORDER_BOOK_DEPTH}.${symbol}`);
      if (this.streamTrades) topics.push(`publicTrade.${symbol}`);
    }
    if (this.streamLiquidations && this.category !== 'spot') {
      for (const symbol of this.symbols) topics.push(`liquidation.${symbol}`);
    }
    this._conn.subscribe(topics);
  }

  _handleData(msg) {
    this._stats.messagesReceived++;
    const topic = msg.topic || '';

    if (topic.startsWith('kline.')) this._handleKline(msg);
    else if (topic.startsWith('tickers.')) this._handleTicker(msg);
    else if (topic.startsWith('orderbook.')) this._handleOrderBook(msg);
    else if (topic.startsWith('publicTrade.')) this._handleTrade(msg);
    else if (topic.startsWith('liquidation.')) this._handleLiquidation(msg);
  }

  _handleKline(msg) {
    const [, interval, symbol] = msg.topic.split('.');
    const tf = this._intervalToTF(interval);
    const k = msg.data?.[0];
    if (!k) return;

    const candle = {
      timestamp: k.start, open: parseFloat(k.open), high: parseFloat(k.high),
      low: parseFloat(k.low), close: parseFloat(k.close), volume: parseFloat(k.volume),
      turnover: parseFloat(k.turnover), isClosed: k.confirm,
    };

    const candles = this.candleStore.upsert(this.category, symbol, tf, candle);
    this.emit('candle_update', { symbol, timeframe: tf, candle, candles, isClosed: k.confirm });

    if (k.confirm) {
      this._stats.candlesEmitted++;
      const payload = {
        symbol, timeframe: tf, candle, candles: [...candles],
        funding: this.funding.get(symbol), openInterest: this.openInterest.get(symbol),
        timestamp: Date.now(),
      };
      this.emit('candle', payload);
    }
  }

  _handleTicker(msg) {
    const symbol = msg.data?.symbol;
    if (!symbol) return;

    this.tickers.update(symbol, msg.data);

    if (msg.data.lastPrice) {
      const price = parseFloat(msg.data.lastPrice);
      this._prevPrices.set(symbol, this._prices.get(symbol) ?? price);
      this._prices.set(symbol, price);
      this.emit('price', { symbol, price, prevPrice: this._prevPrices.get(symbol), timestamp: Date.now() });
    }

    if (msg.data.fundingRate !== undefined) {
      this.funding.updateCurrent(symbol, msg.data.fundingRate, msg.data.nextFundingTime);
    }
    if (msg.data.predictedFundingRate !== undefined) {
      this.funding.updatePredicted(symbol, msg.data.predictedFundingRate);
    }
    if (msg.data.markPrice && msg.data.indexPrice) {
      this.funding.updateBasis(symbol, parseFloat(msg.data.markPrice), parseFloat(msg.data.indexPrice));
    }
    if (msg.data.openInterest !== undefined) {
      this.openInterest.update(symbol, msg.data.openInterest, msg.data.openInterestValue);
    }

    // Check for imminent funding flips
    const flips = this.funding.getImminentFlips();
    if (flips.length > 0) this.emit('funding_flip_imminent', flips);
  }

  _handleOrderBook(msg) {
    const symbol = msg.topic.split('.')[2];
    const book = this.orderBooks.get(symbol);
    if (!book) return;

    book.process(msg.data, msg.type); // msg.type = 'snapshot' | 'delta'
    const snapshot = book.getSnapshot();
    this.emit('orderbook', snapshot);

    if (Math.abs(snapshot.imbalance) > 30) {
      this.emit('orderbook_imbalance', { ...snapshot, alert: `Extreme imbalance: ${snapshot.imbalanceBias} (${snapshot.imbalance}%)` });
    }
  }

  _handleTrade(msg) {
    const symbol = msg.topic.split('.')[1];
    for (const t of msg.data || []) {
      const processed = this.tradeFlow.process(symbol, { side: t.S, size: t.v, price: t.p, timestamp: t.T });
      this.emit('tick', processed);
      if (processed.isLargePrint) {
        this.emit('large_trade', { ...processed, note: `Large ${processed.side} — $${(processed.usdtValue/1000).toFixed(1)}K` });
      }
    }
  }

  _handleLiquidation(msg) {
    const d = msg.data;
    if (!d) return;
    const usdtValue = parseFloat(d.price) * parseFloat(d.size);

    const liq = {
      symbol: d.symbol, side: d.side, price: parseFloat(d.price), quantity: parseFloat(d.size),
      usdtValue: round(usdtValue, 2), timestamp: d.updatedTime || Date.now(),
      note: d.side === 'Sell' ? `LONG liquidated: $${(usdtValue/1000).toFixed(1)}K` : `SHORT liquidated: $${(usdtValue/1000).toFixed(1)}K`,
    };

    this.liquidations.add(liq);
    this.emit('liquidation', liq);

    const cascade = this.liquidations.detectCascade();
    if (cascade.isCascade) {
      this.emit('liquidation_cascade', { ...cascade, alert: `⚠️ Liquidation cascade: $${(cascade.totalUSDT/1e6).toFixed(2)}M in 10s` });
    }
  }

  _startPeriodicPolling() {
    // Insurance fund check every 5 minutes
    setInterval(async () => {
      try {
        const result = await BybitREST.fetchInsuranceFund('USDT');
        if (result?.balance) {
          this.insuranceFund.update('USDT', result.balance);
          const trend = this.insuranceFund.getTrend();
          if (trend.systemicRiskFlag) this.emit('insurance_fund_risk', trend);
        }
      } catch { /* non-critical, ignore */ }
    }, 5 * 60000);

    // OI + price divergence check every 30s
    setInterval(() => {
      for (const symbol of this.symbols) {
        const prevPrice = this._prevPrices.get(symbol);
        const currPrice = this._prices.get(symbol);
        if (prevPrice && currPrice) {
          const analysis = this.openInterest.analyzeWithPrice(symbol, currPrice, prevPrice);
          if (analysis) this.emit('open_interest', analysis);
        }
      }
    }, 30000);
  }

  _intervalToTF(interval) {
    const map = { '1':'M1','3':'M3','5':'M5','15':'M15','30':'M30','60':'H1','120':'H2','240':'H4','360':'H6','720':'H12','D':'D1','W':'W1','M':'MN' };
    return map[interval] || interval;
  }

  getPrice(symbol) { return this._prices.get(symbol.toUpperCase()) || null; }
  getCandles(symbol, tf) { return this.candleStore.get(this.category, symbol.toUpperCase(), tf); }
  getOrderBook(symbol) { return this.orderBooks.get(symbol.toUpperCase())?.getSnapshot() ?? null; }
  getLiquidationHeatmap(symbol, topN = 10) { return this.liquidations.getHeatmap(symbol.toUpperCase(), topN); }

  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return {
      ...this._stats, uptime, connected: this._conn?.isConnected() ?? false,
      symbols: this.symbols, category: this.category,
      candleCount: this.candleStore.size(), prices: Object.fromEntries(this._prices),
    };
  }

  disconnect() {
    console.log('[BybitFeed] Disconnecting...');
    this._conn?.close();
    this._stopHeartbeat();
    this._stopPeriodicPolling();
    this.emit('closed');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  BybitFeed, BybitREST, BybitCandleStore, BybitOrderBookEngine,
  BybitFundingEngine, BybitOpenInterestEngine, BybitLiquidationEngine,
  BybitInsuranceFundTracker, BybitTickerEngine, BybitTradeFlowEngine,
  BybitWSConnection, TIMEFRAMES,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { BybitFeed } = require('./feeds/bybit-ws');
 *
 *  const feed = new BybitFeed({
 *    symbols: ['BTCUSDT', 'ETHUSDT'],
 *    timeframes: ['M15', 'H1', 'H4'],
 *    category: 'linear',
 *    orderBook: true,
 *    liquidations: true,
 *    trades: true,
 *  });
 *
 *  feed.on('candle', ({ symbol, timeframe, candles }) => {
 *    // → pass to smc-agent.js / volume-agent.js
 *  });
 *
 *  feed.on('funding_flip_imminent', (flips) => {
 *    console.log('Funding about to flip:', flips);
 *  });
 *
 *  feed.on('insurance_fund_risk', (trend) => {
 *    console.warn(trend.note); // systemic risk warning
 *  });
 *
 *  feed.on('liquidation_cascade', (c) => console.warn(c.alert));
 *
 *  await feed.connect();
 * ─────────────────────────────────────────────
 */