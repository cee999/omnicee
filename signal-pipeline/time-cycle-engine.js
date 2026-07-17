/**
 * ============================================================
 *  TIME CYCLE ENGINE
 *  AI Trading Assistant · Layer 5 · Signal Pipeline
 * ============================================================
 *
 *  Doc item #30: "Tracks recurring seasonal and intraday behavior."
 *
 *  Rather than a vague seasonality claim, this answers a concrete
 *  question with actual historical evidence from the candles this
 *  system already stores: "at this hour of day / day of week / month,
 *  has this symbol historically trended up, down, or chopped — and
 *  how reliable is that pattern (sample size, consistency)?"
 *
 *  Three cycle dimensions, each computed the same way: bucket every
 *  historical candle's forward return by its time bucket, then report
 *  the bucket's average forward return, win rate, and sample count.
 *
 *    - Hour-of-day (0-23, in the timestamp's UTC hour unless a
 *      timezone offset is supplied)
 *    - Day-of-week (0=Sun .. 6=Sat)
 *    - Month-of-year (1-12) — needs daily+ candles with real history
 *      to be meaningful; flags itself as low-confidence otherwise
 *
 *  This is descriptive statistics over the symbol's own history, not
 *  a prediction — every bucket reports its sample size so a thin
 *  bucket (e.g. 4 observations) can be told apart from a robust one
 *  (e.g. 400 observations), and the engine refuses to call a bucket
 *  "significant" below a minimum sample floor.
 *
 *  Input:  candles (OHLCV with timestamp/time), forwardBars (how many
 *          bars ahead defines "the move" attributed to that bucket)
 *  Output: { hourOfDay: [...], dayOfWeek: [...], monthOfYear: [...],
 *            currentBucket: {...} }
 *
 *  Usage:
 *    const { TimeCycleEngine } = require('./time-cycle-engine');
 *    const engine = new TimeCycleEngine();
 *    const result = engine.analyze({ candles, forwardBars: 4 });
 * ============================================================
 */

'use strict';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function round(n, d = 3) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

function candleTime(c) {
  const ts = c.timestamp ?? c.time ?? null;
  if (ts == null) return null;
  // Accept both ms and second epoch timestamps.
  return ts > 1e12 ? ts : ts * 1000;
}

class TimeCycleEngine {
  constructor(config = {}) {
    this.minSampleSize = config.minSampleSize ?? 20;
    this.utcOffsetHours = config.utcOffsetHours ?? 0; // shift bucket to a trading-desk timezone if desired
  }

  /**
   * Build forward returns keyed by an arbitrary time-bucket function.
   * @param {Array} candles
   * @param {number} forwardBars
   * @param {(date: Date) => (number|string)} bucketFn
   */
  _bucketReturns(candles, forwardBars, bucketFn) {
    const buckets = new Map(); // key -> [] returns

    for (let i = 0; i < candles.length - forwardBars; i++) {
      const c = candles[i];
      const t = candleTime(c);
      if (t == null) continue;

      const d = new Date(t + this.utcOffsetHours * 3600000);
      const key = bucketFn(d);
      const entry = candles[i + forwardBars];
      if (!entry || !c.close) continue;

      const fwdReturn = (entry.close - c.close) / c.close;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(fwdReturn);
    }

    return buckets;
  }

  _summarize(buckets, labelFn) {
    const rows = [];
    for (const [key, returns] of buckets.entries()) {
      const n = returns.length;
      const meanReturn = avg(returns);
      const wins = returns.filter(r => r > 0).length;
      const winRate = n ? round(wins / n, 3) : 0;
      rows.push({
        bucket: key,
        label: labelFn(key),
        sampleSize: n,
        avgForwardReturnPct: round(meanReturn * 100, 4),
        winRate,
        significant: n >= this.minSampleSize,
      });
    }
    return rows.sort((a, b) => (typeof a.bucket === 'number' && typeof b.bucket === 'number' ? a.bucket - b.bucket : String(a.bucket).localeCompare(String(b.bucket))));
  }

  /**
   * @param {Object} params
   * @param {Array}  params.candles      OHLCV array, most recent last, needs
   *                                     timestamp/time on each candle
   * @param {number} [params.forwardBars=4] bars ahead used to define "the move"
   * @returns {Object}
   */
  analyze({ candles, forwardBars = 4 } = {}) {
    if (!Array.isArray(candles) || candles.length < this.minSampleSize * 2) {
      return { hourOfDay: [], dayOfWeek: [], monthOfYear: [], currentBucket: null, reason: 'insufficient_candles' };
    }

    const hourBuckets = this._bucketReturns(candles, forwardBars, d => d.getUTCHours());
    const dowBuckets = this._bucketReturns(candles, forwardBars, d => d.getUTCDay());
    const monthBuckets = this._bucketReturns(candles, forwardBars, d => d.getUTCMonth() + 1);

    const hourOfDay = this._summarize(hourBuckets, h => `${String(h).padStart(2, '0')}:00 UTC`);
    const dayOfWeek = this._summarize(dowBuckets, d => DAY_NAMES[d]);
    const monthOfYear = this._summarize(monthBuckets, m => m);

    // Where does "right now" (the most recent candle's timestamp) sit,
    // and what does its historical bucket say?
    const lastTime = candleTime(candles[candles.length - 1]);
    let currentBucket = null;
    if (lastTime != null) {
      const d = new Date(lastTime + this.utcOffsetHours * 3600000);
      const hourRow = hourOfDay.find(r => r.bucket === d.getUTCHours());
      const dowRow = dayOfWeek.find(r => r.bucket === d.getUTCDay());
      currentBucket = {
        hour: hourRow || null,
        dayOfWeek: dowRow || null,
      };
    }

    return {
      forwardBars,
      hourOfDay,
      dayOfWeek,
      monthOfYear: monthOfYear.some(r => r.significant) ? monthOfYear : monthOfYear.map(r => ({ ...r, note: 'insufficient multi-year history for a reliable monthly read' })),
      currentBucket,
    };
  }

  /**
   * Convenience: is right now historically a favorable, unfavorable, or
   * neutral window for this symbol, based on hour-of-day + day-of-week
   * evidence only (the two buckets that get meaningful sample sizes from
   * a single instrument's intraday history)?
   */
  currentWindowBias({ candles, forwardBars = 4, minWinRateEdge = 0.08 } = {}) {
    const { currentBucket } = this.analyze({ candles, forwardBars });
    if (!currentBucket) return { bias: 'UNKNOWN', reason: 'no_data' };

    const rows = [currentBucket.hour, currentBucket.dayOfWeek].filter(r => r && r.significant);
    if (!rows.length) return { bias: 'UNKNOWN', reason: 'insufficient_sample_at_current_time' };

    const avgWinRate = avg(rows.map(r => r.winRate));
    const avgReturn = avg(rows.map(r => r.avgForwardReturnPct));

    let bias = 'NEUTRAL';
    if (avgWinRate >= 0.5 + minWinRateEdge && avgReturn > 0) bias = 'FAVORABLE_LONG';
    else if (avgWinRate <= 0.5 - minWinRateEdge && avgReturn < 0) bias = 'FAVORABLE_SHORT';

    return {
      bias,
      avgWinRate: round(avgWinRate, 3),
      avgForwardReturnPct: round(avgReturn, 4),
      basis: rows,
    };
  }
}

module.exports = { TimeCycleEngine };
