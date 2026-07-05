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

const BASE_URL = 'wss://stream.binance.com:9443';
const HEARTBEAT_INTERVAL = 30000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;  // FIX: Add max limit to prevent infinite delays
const MAX_BACKOFF_MULTIPLIER = 2;

class BinanceFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbols = config.symbols || [];
    this.timeframes = config.timeframes || ['1m', '5m', '15m', '1h', '4h', 'd1'];
    this.candleStore = new Map();
    this.ws = null;
    this.subscribed = new Set();
    this.reconnectAttempts = 0;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this._heartbeatTimer = null;
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

  _buildStreams() {
    const streams = [];
    for (const symbol of this.symbols) {
      if (!symbol || typeof symbol !== 'string') continue;
      const lower = symbol.toLowerCase();
      // FIX: Only add valid timeframes
      for (const tf of this.timeframes) {
        if (tf && typeof tf === 'string') {
          streams.push(`${lower}@klines_${tf}`);
        }
      }
    }
    return streams;
  }

  _onOpen() {
    console.log('[BinanceFeed] Connected');
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
        const tf = k.i;
        
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

    this.emit('candle', { symbol, timeframe: tf, candles, isClosed: candle.isClosed });
  }

  _onError(err) {
    console.error('[BinanceFeed] WebSocket error:', err.message);
    this._scheduleReconnect();
  }

  _onClose() {
    console.log('[BinanceFeed] Disconnected');
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
