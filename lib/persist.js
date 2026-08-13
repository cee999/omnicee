'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const MARKET_FILE = path.join(CACHE_DIR, 'market.json');
const CANDLES_FILE = path.join(CACHE_DIR, 'candles.json');
const CANDLE_WRITE_INTERVAL_MS = Math.max(1000, Number(process.env.CANDLE_PERSIST_INTERVAL_MS || 15000));

let pendingCandles = null;
let candleWriteTimer = null;
let lastCandleWriteAt = 0;

function ensureDir() {
  try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
}

function atomicWrite(filePath, data) {
  try {
    ensureDir();
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8' });
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.warn('[persist] write failed:', err.message);
    return false;
  }
}

function loadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[persist] load failed:', err.message);
    return null;
  }
}

function saveMarket(marketRows) {
  return atomicWrite(MARKET_FILE, { ts: Date.now(), rows: marketRows });
}

function loadMarket() {
  const doc = loadJson(MARKET_FILE);
  return doc && Array.isArray(doc.rows) ? doc.rows : null;
}

function flushCandles() {
  candleWriteTimer = null;
  if (!pendingCandles) return true;
  const payload = pendingCandles;
  pendingCandles = null;
  const ok = atomicWrite(CANDLES_FILE, { ts: Date.now(), candles: payload });
  if (ok) lastCandleWriteAt = Date.now();
  return ok;
}

function saveCandles(candles) {
  pendingCandles = candles;
  const elapsed = Date.now() - lastCandleWriteAt;
  if (!lastCandleWriteAt || elapsed >= CANDLE_WRITE_INTERVAL_MS) return flushCandles();
  if (!candleWriteTimer) {
    candleWriteTimer = setTimeout(flushCandles, CANDLE_WRITE_INTERVAL_MS - elapsed);
    candleWriteTimer.unref?.();
  }
  return true;
}

function loadCandles() {
  const doc = loadJson(CANDLES_FILE);
  return doc && doc.candles ? doc.candles : null;
}

module.exports = { saveMarket, loadMarket, saveCandles, loadCandles };
