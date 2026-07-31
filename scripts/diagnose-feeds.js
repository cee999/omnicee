'use strict';
/**
 * ============================================================
 *  DIAGNOSE FEEDS — bypasses the entire pipeline and just asks:
 *  is there a real, live price coming back right now, yes or no?
 * ============================================================
 *
 *  Run it directly: node scripts/diagnose-feeds.js
 *  (loads .env the same way index.js does, via dotenv)
 *
 *  No candles, no agents, no gates, no signals — just three raw
 *  HTTP calls (Binance needs no key; TwelveData/Finnhub use
 *  whatever's in your .env) and the actual response printed.
 *  This exists because I (Claude) cannot reach finnhub.io or
 *  twelvedata.com from my own sandbox to test this myself — my
 *  network access is restricted to a fixed allowlist that
 *  doesn't include either. Every price-feed module I've written
 *  has been verified for correctness (symbol formats matching
 *  official docs, parsing logic, aggregation math) but NOT for
 *  "does a real call actually return a real price" — that can
 *  only be confirmed by running this where the network is open.
 * ============================================================
 */

try { require('dotenv').config(); } catch (_) { /* optional */ }
const https = require('https');

function get(url, headers = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, ms: Date.now() - start, body: data }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout after 8s', ms: Date.now() - start }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message, ms: Date.now() - start }));
  });
}

function print(name, result, extract) {
  const line = (s) => console.log(`  ${s}`);
  console.log(`\n── ${name} ${'─'.repeat(Math.max(1, 50 - name.length))}`);
  if (!result.ok) {
    line(`FAIL — network error: ${result.error}`);
    return false;
  }
  line(`HTTP ${result.status} in ${result.ms}ms`);
  if (result.status !== 200) {
    line(`FAIL — non-200 response:`);
    line(result.body.slice(0, 300));
    return false;
  }
  let json;
  try { json = JSON.parse(result.body); } catch {
    line(`FAIL — response wasn't JSON:`);
    line(result.body.slice(0, 300));
    return false;
  }
  const extracted = extract(json);
  if (extracted == null) {
    line(`FAIL — got a response, but no usable price in it. Raw response:`);
    line(JSON.stringify(json).slice(0, 400));
    return false;
  }
  line(`PASS — live price: ${extracted}`);
  return true;
}

async function main() {
  console.log('Testing each price feed directly — no pipeline, no keys withheld from the output except redacted.');
  const results = {};

  // 1. Binance — public, no key, known-good baseline for comparison.
  const binance = await get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
  results.binance = print('Binance (BTCUSDT, no key needed)', binance, (j) => j.price ? `$${Number(j.price).toLocaleString()}` : null);

  // 2. TwelveData
  const tdKey = process.env.TWELVE_DATA_API_KEY || '';
  if (!tdKey) {
    console.log('\n── TwelveData ────────────────────────────────────');
    console.log('  SKIPPED — TWELVE_DATA_API_KEY is not set in your environment.');
    results.twelvedata = false;
  } else {
    const td = await get(`https://api.twelvedata.com/price?symbol=EUR/USD&apikey=${tdKey}`);
    results.twelvedata = print('TwelveData (EUR/USD)', td, (j) => {
      if (j.code || j.status === 'error') return null; // TwelveData returns {code, message} on auth/plan errors
      return j.price ? `${j.price}` : null;
    });
    if (td.ok && td.status === 200) {
      try {
        const j = JSON.parse(td.body);
        if (j.code || j.status === 'error') console.log(`  → TwelveData's own error message: ${j.message || JSON.stringify(j)}`);
      } catch {}
    }
  }

  // 3. Finnhub
  const fhKey = process.env.FINNHUB_API_KEY || '';
  if (!fhKey) {
    console.log('\n── Finnhub ───────────────────────────────────────');
    console.log('  SKIPPED — FINNHUB_API_KEY is not set in your environment.');
    results.finnhub = false;
  } else {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 24 * 3;
    const fh = await get(`https://finnhub.io/api/v1/forex/candle?symbol=OANDA:EUR_USD&resolution=60&from=${from}&to=${to}&token=${fhKey}`);
    results.finnhub = print('Finnhub (OANDA:EUR_USD candles)', fh, (j) => {
      if (j.s !== 'ok' || !Array.isArray(j.c) || !j.c.length) return null;
      return `${j.c[j.c.length - 1]} (${j.c.length} candles returned)`;
    });
    if (fh.ok && fh.status === 200) {
      try {
        const j = JSON.parse(fh.body);
        if (j.s && j.s !== 'ok') console.log(`  → Finnhub's own status field: "${j.s}" (e.g. "no_data" means the key works but this symbol/plan combo returned nothing)`);
      } catch {}
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY:', Object.entries(results).map(([k, v]) => `${k}=${v ? 'LIVE' : 'NOT WORKING'}`).join('  '));
  console.log('='.repeat(60));
  if (!results.twelvedata && !results.finnhub) {
    console.log('\nNeither forex source is returning live data. If Binance above');
    console.log('passed, your network access is fine — the problem is specific');
    console.log('to these two: check the exact error/status printed above first');
    console.log('(invalid key, expired trial, wrong plan for this endpoint, or');
    console.log('symbol not covered are the usual causes).');
  }
}

main();
