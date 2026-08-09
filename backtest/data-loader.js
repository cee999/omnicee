'use strict';
// exported from TradingView, Dukascopy, your broker, etc.) IMPORTANT: this must be run somewhere with real internet access to api.binance.com.

const fs = require('fs');
const https = require('https');

const BINANCE_REST = 'https://api.binance.com/api/v3/klines';
const MAX_LIMIT = 1000;

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

async function fetchBinanceKlines(symbol, timeframe, startTime, endTime) {
  const interval = toBinanceInterval(timeframe);
  const candles = [];
  let cursor = startTime;
  let guard = 0;
  const MAX_PAGES = 500;

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
    if (lastOpenTime <= cursor) break;
    cursor = lastOpenTime + 1;

    await new Promise(r => setTimeout(r, 150));
  }

  return candles;
}

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

// This is NEVER a substitute for real historical data — results from synthetic data say nothing about real strategy performance.
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
