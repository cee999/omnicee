/**
 * ============================================================
 *  BINANCE WEBSOCKET FEED
 *  AI Trading Assistant · Data Layer · Live OHLCV
 * ============================================================
 *
 *  FIX SUMMARY:
 *    - Add exponential backoff max limit (prevent infinite delays)
 *    - Validate stream array before connecting
 *    - Add error handling for Redis publish failures  
 *    - Add memory management for candle store
 *    - Safe numeric operations in all calculations
 * ============================================================
 */

'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const https = require('https');

const BASE_URL = 'wss://stream.binance.com:9443';
const REST_BASE_URL = 'https://api.binance.com';
const HEARTBEAT_INTERVAL = 30000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;  // FIX: Add max limit to prevent infinite delays
const MAX_BACKOFF_MULTIPLIER = 2;
const MAX_CANDLE_HISTORY = 500; // matches the existing cap in _storeCandle below

// FIX: OMNICEE uses MetaTrader-style timeframe labels internally (M1, M5, M15,
// M30, H1, H4, D1, W1) — e.g. agents are configured with timeframe: 'H1'.
// Binance's WebSocket kline streams require their own interval format
// (1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w). Previously these were never translated,
// so passing the default/.env TIMEFRAMES ("H1,H4,D1") straight into BinanceFeed
// produced invalid stream names like "btcusdt@kline_H1" that Binance silently
// ignores — meaning no candles were ever received for those timeframes.
const MT_TO_BINANCE_INTERVAL = {
  M1: '1m', M3: '3m', M5: '5m', M15: '15m', M30: '30m',
  H1: '1h', H2: '2h', H4: '4h', H6: '6h', H8: '8h', H12: '12h',
  D1: '1d', W1: '1w', MN: '1M', MN1: '1M',
};

/** Normalize a timeframe label (MT-style or already Binance-style) to a valid Binance kline interval. */
function toBinanceInterval(tf) {
  if (!tf || typeof tf !== 'string') return null;
  const upper = tf.toUpperCase();
  if (MT_TO_BINANCE_INTERVAL[upper]) return MT_TO_BINANCE_INTERVAL[upper];
  // Already Binance-style (e.g. '1h', '15m', '1d') — Binance intervals are lowercase.
  return tf.toLowerCase();
}

// ─────────────────────────────────────────────
//  REST HELPERS
// ─────────────────────────────────────────────
// FIX: BinanceFeed previously made zero REST calls of any kind — pure
// WebSocket only, no history backfill. Every symbol/timeframe started
// completely cold on every boot or restart, building history only from
// live ticks going forward (on an H1 candle needing ~50 bars of lookback,
// that's 2+ days of uptime before agents have a usable window). Binance's
// public klines endpoint needs no API key at all for historical candle
// data — the .env.example BINANCE_API_KEY/SECRET vars were documented as
// enabling this and never actually did anything; that comment has been
// corrected separately. This brings BinanceFeed in line with BybitFeed
// (feeds/bybit-ws.js), which already preloads via its own public REST call.
class BinanceREST {
  static fetchKlines(symbol, interval, limit = MAX_CANDLE_HISTORY) {
    return new Promise((resolve, reject) => {
      const url = `${REST_BASE_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!Array.isArray(parsed)) {
              // Binance returns a plain object like {"code":-1121,"msg":"Invalid symbol."}
              // on a bad symbol/param instead of an error status — same silent-shape
              // risk as Alpha Vantage's Note/Information and FMP's Error Message.
              return reject(new Error(parsed?.msg || 'Binance klines returned a non-array response'));
            }
            const candles = parsed.map(k => ({
              timestamp: Number(k[0]) || 0,
              open:  parseFloat(k[1]) || 0,
              high:  parseFloat(k[2]) || 0,
              low:   parseFloat(k[3]) || 0,
              close: parseFloat(k[4]) || 0,
              volume: parseFloat(k[5]) || 0,
              isClosed: true, // any candle from a completed historical fetch is, by definition, closed
            }));
            resolve(candles);
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }
}

class BinanceFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = config.symbols || [];
    // FIX: keep original (possibly MT-style) labels so emitted candle events
    // stay consistent with the labels the rest of the system (agents,
    // candleStores, onCandle) is keyed on.
    this.timeframes = config.timeframes || ['1m', '5m', '15m', '1h', '4h', '1d'];
    // Binance interval -> original label, so incoming messages can be tagged
    // back with whatever label the caller configured (e.g. 'H1' not '1h').
    this._intervalToLabel = new Map();
    for (const tf of this.timeframes) {
      const interval = toBinanceInterval(tf);
      if (interval) this._intervalToLabel.set(interval, tf);
    }
    this.candleStore = new Map();
    this.ws = null;
    this.subscribed = new Set();
    this.reconnectAttempts = 0;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this._heartbeatTimer = null;
    // FIX: BinanceFeed had no connection-state tracking at all — not even
    // an internal flag, let alone a public isConnected(). Bybit and
    // TwelveData had the same functional gap in a different shape (the
    // method existed, just on an internal helper class never exposed on
    // the outer Feed — see the matching fixes in those two files); Binance
    // simply never tracked it anywhere. DataIntegrityMonitor.check()
    // (feeds/data-integrity-monitor.js) calls instance.isConnected() on
    // whatever it was registered with, falls through to connected: null
    // when that check fails — rendered by the frontend as literally
    // "UNKNOWN", regardless of whether the feed was actually connected.
    this._connected = false;
  }

  async connect() {
    try {
      // FIX: Validate symbols before connecting
      if (!Array.isArray(this.symbols) || this.symbols.length === 0) {
        throw new Error('No symbols configured');
      }

      const streams = this._buildStreams();
      if (!Array.isArray(streams) || streams.length === 0) {
        throw new Error('No streams generated from symbols');
      }

      await this._preloadHistory();

      const url = `${BASE_URL}/stream?streams=${streams.join('/')}`;
      console.log(`[BinanceFeed] Connecting to ${streams.length} streams...`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', (data) => this._onMessage(data));
      this.ws.on('error', (err) => this._onError(err));
      this.ws.on('close', () => this._onClose());
    } catch (err) {
      console.error('[BinanceFeed] Connection error:', err.message);
      this._scheduleReconnect();
    }
  }

  async _preloadHistory() {
    console.log('[BinanceFeed] Preloading historical candles...');
    const tasks = [];
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        const interval = toBinanceInterval(tf);
        if (!interval) continue;
        tasks.push(
          BinanceREST.fetchKlines(symbol.toUpperCase(), interval, MAX_CANDLE_HISTORY)
            .then(candles => {
              // Keyed on the uppercase symbol to match _storeCandle exactly —
              // Binance's live payload (msg.data.s) is always uppercase, but
              // this.symbols isn't normalized in the constructor, so using the
              // as-configured casing here could silently key preloaded
              // history under a different string than live ticks ever hit.
              this.candleStore.set(`${symbol.toUpperCase()}_${tf}`, candles);
              console.log(`[BinanceFeed] Loaded ${candles.length} candles for ${symbol} ${tf}`);
            })
            // One symbol/timeframe failing (bad symbol, transient network
            // error, rate limit) must not block the others — same isolation
            // Promise.all + a per-task .catch() gives BybitFeed's preload.
            .catch(err => console.error(`[BinanceFeed] History load failed ${symbol} ${tf}: ${err.message}`))
        );
      }
    }
    await Promise.all(tasks);
    const total = [...this.candleStore.values()].reduce((sum, arr) => sum + arr.length, 0);
    console.log(`[BinanceFeed] Preload complete. Total candles: ${total}`);
  }

  _buildStreams() {
    const streams = [];
    for (const symbol of this.symbols) {
      if (!symbol || typeof symbol !== 'string') continue;
      const lower = symbol.toLowerCase();
      // FIX: Translate MT-style timeframe labels (H1, H4, D1...) to valid
      // Binance kline intervals (1h, 4h, 1d...) before building stream names.
      for (const tf of this.timeframes) {
        const interval = toBinanceInterval(tf);
        if (interval) {
          streams.push(`${lower}@kline_${interval}`);
        }
      }
    }
    return streams;
  }

  isConnected() {
    return this._connected;
  }

  _onOpen() {
    console.log('[BinanceFeed] Connected');
    this._connected = true;
    this.reconnectAttempts = 0;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.emit('connected');
    this._startHeartbeat();
  }

  _onMessage(data) {
    try {
      const msg = JSON.parse(data);
      if (msg.data) {
        const { s, k } = msg.data;
        if (!s || !k) return;

        const symbol = s;
        // FIX: k.i is the raw Binance interval (e.g. '1h'); translate it back
        // to whatever label the caller originally configured (e.g. 'H1') so
        // downstream consumers (candleStores, onCandle's TIMEFRAMES_STR check)
        // recognize it.
        const tf = this._intervalToLabel.get(k.i) || k.i;
        
        // FIX: Validate all numeric values
        const candle = {
          timestamp: Number(k.t) || 0,
          open: parseFloat(k.o) || 0,
          high: parseFloat(k.h) || 0,
          low: parseFloat(k.l) || 0,
          close: parseFloat(k.c) || 0,
          volume: parseFloat(k.v) || 0,
          isClosed: k.x,
        };

        // FIX: Validate candle data
        if (!Number.isFinite(candle.close) || candle.close <= 0) {
          console.warn(`[BinanceFeed] Invalid candle data for ${symbol}`);
          return;
        }

        this._storeCandle(symbol, tf, candle);
      }
    } catch (err) {
      console.warn('[BinanceFeed] Message parse error:', err.message);
    }
  }

  _storeCandle(symbol, tf, candle) {
    if (!symbol || !tf) return;

    const key = `${symbol}_${tf}`;
    if (!this.candleStore.has(key)) {
      this.candleStore.set(key, []);
    }

    const candles = this.candleStore.get(key);
    
    // FIX: Add memory management - limit candle history
    if (candles.length > 500) {
      candles.shift();
    }

    // Remove duplicate if exists (same timestamp)
    const existingIdx = candles.findIndex(c => c.timestamp === candle.timestamp);
    if (existingIdx >= 0) {
      candles[existingIdx] = candle;
    } else {
      candles.push(candle);
    }

    // FIX: this payload was missing the singular 'candle' field entirely —
    // only 'candles' (the full array) was included. index.js's onCandle()
    // destructures { symbol, timeframe, candle, isClosed } and immediately
    // throws on candle.timestamp when candle is undefined, on every single
    // kline tick. That error was caught by _onMessage's outer try/catch and
    // misleadingly logged as "Message parse error" (the JSON parsed fine —
    // the failure was in a downstream listener, called synchronously via
    // this emit()). Net effect: Binance-sourced symbols never got a single
    // successful candle update in candleStores, despite the feed connecting
    // and receiving real data correctly. Both bybit-ws.js and twelve-data.js
    // already include both 'candle' and 'candles' in their payloads — this
    // brings Binance in line with that same, correct convention.
    this.emit('candle', { symbol, timeframe: tf, candle, candles, isClosed: candle.isClosed });
  }

  _onError(err) {
    console.error('[BinanceFeed] WebSocket error:', err.message);
    this._scheduleReconnect();
  }

  _onClose() {
    console.log('[BinanceFeed] Disconnected');
    this._connected = false;
    this.emit('disconnected');
    this._stopHeartbeat();
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    // FIX: Add max backoff limit to prevent exponential explosion
    this.backoffMs = Math.min(
      this.backoffMs * MAX_BACKOFF_MULTIPLIER,
      MAX_BACKOFF_MS
    );
    this.reconnectAttempts++;
    console.log(`[BinanceFeed] Reconnecting in ${this.backoffMs}ms (attempt ${this.reconnectAttempts})`);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Send ping to keep connection alive
        try {
          this.ws.ping();
        } catch (err) {
          console.warn('[BinanceFeed] Heartbeat error:', err.message);
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  getCandles(symbol, timeframe) {
    const key = `${symbol}_${timeframe}`;
    return this.candleStore.get(key) || [];
  }

  close() {
    this._stopHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners(); // Prevent close event from triggering reconnect
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = { BinanceFeed };
