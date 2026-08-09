
'use strict';

function _round(n, d = 5)    {
  if (!Number.isFinite(n)) return 0;
  return parseFloat((+n).toFixed(d));
}

function _pct(a, b)          {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return b !== 0 ? Math.abs(a - b) / Math.abs(b) : 0;
}

function _within(a, b, tol)  { return _pct(a, b) <= tol; }

function _avg(arr)            {
  // FIX: Check for empty array before reducing
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const valid = arr.filter(v => Number.isFinite(v));
  if (valid.length === 0) return 0;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function _clamp(v, min, max)  { return Math.max(min, Math.min(max, v)); }
function _now()               { return Date.now(); }

class EntryOptimizer {
  constructor(config = {}) {
    this.minQuality = config.minQuality || 50;
  }

  optimize({ smcAnalysis, signal, candles }) {
    try {
      if (!smcAnalysis) {
        return this._defaultEntry(signal);
      }

      const direction = signal.direction || 'LONG';
      const isLong = direction === 'LONG';
      const currentPrice = candles && candles.length > 0 ? candles[candles.length - 1].close : null;

      const orderBlocks = smcAnalysis.orderBlocks || {};
      // FIX: was reading smcAnalysis.fairValueGaps, which doesn't exist on the analysis object at all — SMCAgent.analyze() returns it as smcAnalysis.fvgs.{bullish,bearish} (already direction-split, each...
      const fvgsByDir = smcAnalysis.fvgs || {};
      const eqLevels = smcAnalysis.equalLevels || {};

      const relevantOB = isLong ? orderBlocks.bullish : orderBlocks.bearish;
      if (!relevantOB || relevantOB.length === 0) {
        return this._defaultEntry(signal);
      }

      const primary = relevantOB[0];
      // FIX: obLow/obHigh were being swapped based on direction (isLong ?
      const obLow = primary.obLow;
      const obHigh = primary.obHigh;

      let fvgZone = null;
      const relevantFVGs = isLong
        ? (fvgsByDir.bullish || [])
        : (fvgsByDir.bearish || []);
      if (relevantFVGs.length > 0) {
        const fvg = relevantFVGs[0];
        // FIX: same zone-inversion issue as the OB fix above — fvgHigh/fvgLow are always literal numeric bounds (fvgHigh >= fvgLow) regardless of bullish/bearish type, so these must not be swapped by direction...
        fvgZone = {
          low: fvg.fvgLow,
          high: fvg.fvgHigh,
          type: 'FVG',
        };
      }

      let liquidityZone = null;
      const relevant = isLong ? eqLevels.eql : eqLevels.eqh;
      if (relevant && relevant.length > 0) {
        const prices = relevant.map(l => l.price).filter(p => Number.isFinite(p));
        if (prices.length > 0) {
          const avgPrice = _avg(prices);
          liquidityZone = {
            price: _round(avgPrice),
            type: 'LIQUIDITY',
            touches: relevant.length,
          };
        }
      }

      const entries = [];

      entries.push({
        zoneLow: _round(obLow),
        zoneHigh: _round(obHigh),
        midPoint: _round((obLow + obHigh) / 2),
        type: 'OB_CONSERVATIVE',
        quality: 70,
        note: 'Inside primary orderblock — safest entry',
      });

      if (fvgZone) {
        entries.push({
          zoneLow: _round(fvgZone.low),
          zoneHigh: _round(fvgZone.high),
          midPoint: _round((fvgZone.low + fvgZone.high) / 2),
          type: 'FVG_TIGHT',
          quality: 85,
          note: 'Inside fair value gap — best momentum entry',
        });
      }

      if (liquidityZone) {
        const halfSpread = Math.abs(obHigh - obLow) / 4;
        entries.push({
          zoneLow: _round(liquidityZone.price - halfSpread),
          zoneHigh: _round(liquidityZone.price + halfSpread),
          midPoint: _round(liquidityZone.price),
          type: 'LIQUIDITY_POOL',
          quality: 80,
          touches: liquidityZone.touches,
          note: `At ${liquidityZone.touches} touch liquidity pool`,
        });
      }

      let best = entries[0];
      for (const e of entries) {
        if (e.quality > best.quality) best = e;
      }

      let qualityScore = best.quality;
      if (currentPrice) {
        const zoneSpread = Math.abs(best.zoneHigh - best.zoneLow);
        const distToMid = Math.abs(currentPrice - best.midPoint);
        if (zoneSpread > 0 && distToMid < zoneSpread * 0.5) qualityScore += 10;
      }

      return {
        entry: {
          ...best,
          quality: _round(Math.min(qualityScore, 100)),
          qualityScore: _round(Math.min(qualityScore, 100)),
        },
        alternatives: entries.slice(1),
      };
    } catch (err) {
      console.warn('[EntryOptimizer] Optimization error:', err.message);
      return this._defaultEntry(signal);
    }
  }

  _defaultEntry(signal) {
    const midPoint = signal.entry?.midPoint || signal.entryPrice || 0;
    const spread = midPoint * 0.005;

    return {
      entry: {
        zoneLow: _round(midPoint - spread),
        zoneHigh: _round(midPoint + spread),
        midPoint: _round(midPoint),
        type: 'DEFAULT',
        quality: 50,
        qualityScore: 50,
        note: 'Default entry zone',
      },
      alternatives: [],
    };
  }

  getQualityLabel(score) {
    if (score >= 90) return 'EXCELLENT';
    if (score >= 80) return 'VERY_GOOD';
    if (score >= 70) return 'GOOD';
    if (score >= 60) return 'FAIR';
    if (score >= 50) return 'ACCEPTABLE';
    return 'POOR';
  }
}

module.exports = { EntryOptimizer };
