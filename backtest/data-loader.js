'use strict';
/**
 * backtest/data-loader.js
 *
 * Fetches historical OHLCV candles for backtesting. Two sources:
 *   1. Binance public REST klines API (crypto symbols, no key needed)
 *   2. CSV file import (forex/stocks/anything else — e.g. exported from
 *      TradingView, Dukascopy, your broker, etc.)
 *
 * IMPORTANT: this must be run somewhere with real internet access to
 * api.binance.com. It will NOT work inside a sandboxed environment whose
 * network egress is restricted to package registries only.
 *
 * Candle shape matches exactly what the live feeds produce (see
 * feeds/binance-ws.js), so it can be fed straight into the real agent
 * pipeline unmodified:
 *   { timestamp, open, high, low, close, volume }
 */

const fs = require('fs');
const https = require('https');

const BINANCE_REST = 'https://api.binance.com/api/v3/klines';
const MAX_LIMIT = 1000; // Binance's per-request cap

// MT-style label -> Binance interval (same mapping as feeds/binance-ws.js,
// duplicated here so this module has zero dependency on the live feed code).
const MT_TO_BINANCE_INTERVAL = {
  M1: '1m', M3: '3m', M5: '5m', M15: '15m', M30: '30m',
  H1: '1h', H2: '2h', H4: '4h', H6: '6h', H8: '8h', H12: '12h',
  D1: '1d', W1: '1w', MN: '1M', MN1: '1M',
};
function toBinanceInterval(tf) {
  if (!tf) return null;
  const upper = String(tf).toUpperCase();
  return MT_TO_BINANCE_INTERVAL[upper] || String(tf).toLowerCase();
}

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'omnicee-backtest/1.0' } }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Binance API ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Failed to parse Binance response: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch historical klines from Binance, paginating automatically since
 * Binance caps each request at 1000 candles.
 *
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} timeframe - MT-style ('H1') or Binance-style ('1h')
 * @param {number} startTime - ms since epoch
 * @param {number} endTime - ms since epoch
 * @returns {Promise<Array>} candles sorted ascending by timestamp
 */
async function fetchBinanceKlines(symbol, timeframe, startTime, endTime) {
  const interval = toBinanceInterval(timeframe);
  const candles = [];
  let cursor = startTime;
  let guard = 0;
  const MAX_PAGES = 500; // hard safety cap (~500k candles) against runaway loops

  while (cursor < endTime && guard < MAX_PAGES) {
    guard++;
    const url = `${BINANCE_REST}?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endTime}&limit=${MAX_LIMIT}`;
    const rows = await httpGetJSON(url);
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const k of rows) {
      candles.push({
        timestamp: Number(k[0]) || 0,
        open: parseFloat(k[1]) || 0,
        high: parseFloat(k[2]) || 0,
        low: parseFloat(k[3]) || 0,
        close: parseFloat(k[4]) || 0,
        volume: parseFloat(k[5]) || 0,
      });
    }

    const lastOpenTime = Number(rows[rows.length - 1][0]);
    if (lastOpenTime <= cursor) break; // safety: no forward progress, stop
    cursor = lastOpenTime + 1;

    // Be polite to Binance's rate limits between pages.
    await new Promise(r => setTimeout(r, 150));
  }

  return candles;
}

/**
 * Load candles from a CSV file. Expects a header row containing at least:
 * timestamp (or date/time — ISO or epoch ms), open, high, low, close, and
 * optionally volume. Column order and casing are flexible.
 */
function loadCSV(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8').trim();
  const lines = raw.split('\n');
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());

  const idx = {
    timestamp: header.findIndex(h => ['timestamp', 'time', 'date', 'datetime'].includes(h)),
    open: header.indexOf('open'),
    high: header.indexOf('high'),
    low: header.indexOf('low'),
    close: header.indexOf('close'),
    volume: header.indexOf('volume'),
  };
  if (idx.timestamp === -1 || idx.open === -1 || idx.high === -1 || idx.low === -1 || idx.close === -1) {
    throw new Error(`CSV must have timestamp/date, open, high, low, close columns. Found: ${header.join(', ')}`);
  }

  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    let ts = cols[idx.timestamp].trim();
    // Accept either epoch ms or an ISO/parseable date string.
    ts = /^\d+$/.test(ts) ? Number(ts) : new Date(ts).getTime();
    if (!Number.isFinite(ts)) continue;

    candles.push({
      timestamp: ts,
      open: parseFloat(cols[idx.open]) || 0,
      high: parseFloat(cols[idx.high]) || 0,
      low: parseFloat(cols[idx.low]) || 0,
      close: parseFloat(cols[idx.close]) || 0,
      volume: idx.volume !== -1 ? (parseFloat(cols[idx.volume]) || 0) : 0,
    });
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

/**
 * Generates synthetic-but-plausible OHLCV data purely for testing the
 * backtest engine's mechanics (candle iteration, signal firing, position
 * lifecycle, stats) when no real market data source is reachable. This is
 * NEVER a substitute for real historical data — results from synthetic
 * data say nothing about real strategy performance. It exists only so the
 * engine itself can be verified end-to-end without network access.
 */
function generateSyntheticCandles(count, { startPrice = 100, startTime = Date.now() - count * 3600_000, intervalMs = 3600_000, volatility = 0.006, drift = 0, seed = 42 } = {}) {
  let rngState = seed;
  function rand() { // simple deterministic PRNG (mulberry32) for reproducibility
    rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const move = (rand() - 0.5) * volatility + drift;
    const open = price;
    const close = Math.max(0.0001, open * (1 + move));
    const wick = Math.abs(close - open) * (1 + rand());
    const high = Math.max(open, close) + wick * rand();
    const low = Math.min(open, close) - wick * rand();
    candles.push({
      timestamp: startTime + i * intervalMs,
      open, high, low, close,
      volume: 100 + rand() * 900,
    });
    price = close;
  }
  return candles;
}

module.exports = { fetchBinanceKlines, loadCSV, generateSyntheticCandles, toBinanceInterval };
