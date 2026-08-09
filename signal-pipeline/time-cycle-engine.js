
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
  return ts > 1e12 ? ts : ts * 1000;
}

class TimeCycleEngine {
  constructor(config = {}) {
    this.minSampleSize = config.minSampleSize ?? 20;
    this.utcOffsetHours = config.utcOffsetHours ?? 0;
  }

  _bucketReturns(candles, forwardBars, bucketFn) {
    const buckets = new Map();

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
