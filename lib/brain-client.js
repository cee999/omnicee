'use strict';

/**
 * Client for the Python brain service.
 *
 * Deliberately conservative. The brain is an ENHANCEMENT to the existing Node
 * pipeline, never a dependency of it: if the brain is unreachable, slow, or
 * returns garbage, this client returns null and the caller carries on with
 * the Node analysis exactly as before.
 *
 * Failure policy:
 *   - hard timeout, shorter than the analysis interval
 *   - circuit breaker opens after repeated failures so a dead brain does not
 *     add latency to every single scan
 *   - never throws to the caller
 */

const DEFAULTS = {
  baseUrl: (process.env.BRAIN_URL || '').trim().replace(/\/+$/, ''),
  secret: (process.env.BRAIN_SHARED_SECRET || '').trim(),
  timeoutMs: Number(process.env.BRAIN_TIMEOUT_MS || 5000),
  failureThreshold: Number(process.env.BRAIN_FAILURE_THRESHOLD || 5),
  cooldownMs: Number(process.env.BRAIN_COOLDOWN_MS || 60000),
};

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function enabled() {
  return Boolean(DEFAULTS.baseUrl);
}

function circuitOpen() {
  return Date.now() < circuitOpenUntil;
}

function recordFailure(reason) {
  consecutiveFailures += 1;
  if (consecutiveFailures >= DEFAULTS.failureThreshold) {
    circuitOpenUntil = Date.now() + DEFAULTS.cooldownMs;
    consecutiveFailures = 0;
    console.warn(
      `[brain] unreachable (${reason}); pausing calls for ${DEFAULTS.cooldownMs}ms. ` +
      'Node analysis continues unaffected.'
    );
  }
}

function recordSuccess() {
  consecutiveFailures = 0;
}

async function call(path, body, { requestId } = {}) {
  if (!enabled() || circuitOpen()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULTS.timeoutMs);

  try {
    const res = await fetch(`${DEFAULTS.baseUrl}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-brain-secret': DEFAULTS.secret,
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      recordFailure(`HTTP ${res.status}`);
      return null;
    }
    recordSuccess();
    return await res.json();
  } catch (err) {
    recordFailure(err.name === 'AbortError' ? 'timeout' : err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert the Node in-memory candle store into the brain's MarketSnapshot.
 *
 * Every candle is validated here rather than at the HTTP boundary, so a
 * malformed bar is dropped locally instead of costing a 422 round trip.
 */
function buildSnapshot(symbol, seriesByTimeframe, opts = {}) {
  const series = {};

  for (const [timeframe, candles] of Object.entries(seriesByTimeframe || {})) {
    if (!Array.isArray(candles) || candles.length === 0) continue;

    const clean = [];
    let lastTime = -Infinity;

    for (const c of candles) {
      const time = Number(c.time ?? c.t ?? c.timestamp);
      const open = Number(c.open ?? c.o);
      const high = Number(c.high ?? c.h);
      const low = Number(c.low ?? c.l);
      const close = Number(c.close ?? c.c);

      if (![time, open, high, low, close].every(Number.isFinite)) continue;
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
      if (high < low) continue;
      if (open < low || open > high || close < low || close > high) continue;
      if (time <= lastTime) continue;

      lastTime = time;
      clean.push({
        time,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(Number(c.volume ?? c.v)) ? Number(c.volume ?? c.v) : 0,
      });
    }

    if (clean.length) {
      series[timeframe] = { symbol, timeframe, candles: clean };
    }
  }

  if (!Object.keys(series).length) return null;

  return {
    symbol,
    series,
    spread: opts.spread ?? null,
    pip_size: opts.pipSize ?? 0.0001,
    contract_size: opts.contractSize ?? 100000,
    received_at: Date.now(),
    source: opts.source ?? null,
  };
}

/**
 * Ask the brain to analyse one symbol. Returns null on any failure.
 */
async function analyze(snapshot, account = null, requestId = null) {
  if (!snapshot) return null;
  return call('/v1/analyze', { snapshot, account }, { requestId });
}

/**
 * Refit the probability calibration on closed outcomes.
 * Call this periodically from the existing outcome-recorder.
 */
async function fitCalibration(scores, wins) {
  if (!Array.isArray(scores) || scores.length !== (wins || []).length) return null;
  return call('/v1/calibration/fit', { scores, wins });
}

async function health() {
  if (!enabled()) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${DEFAULTS.baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

module.exports = {
  enabled,
  analyze,
  fitCalibration,
  buildSnapshot,
  health,
  _state: () => ({ consecutiveFailures, circuitOpenUntil }),
};
