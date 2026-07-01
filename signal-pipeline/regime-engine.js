'use strict';

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

class RegimeEngine {
  constructor(config = {}) {
    this.lookback = config.lookback || 120;
  }

  classify(candles = []) {
    if (!Array.isArray(candles) || candles.length < 40) {
      return {
        regime: 'UNKNOWN',
        trend: 'UNKNOWN',
        volatility: 'UNKNOWN',
        tradeability: 45,
        confidence: 30,
        reasons: ['Insufficient candles for regime model'],
      };
    }

    const sample = candles.slice(-this.lookback);
    const closes = sample.map(c => Number(c.close));
    const highs = sample.map(c => Number(c.high));
    const lows = sample.map(c => Number(c.low));
    const volumes = sample.map(c => Number(c.volume || 0));
    const current = closes[closes.length - 1];

    const ema21 = this._ema(closes, 21);
    const ema55 = this._ema(closes, 55);
    const atr = this._atr(sample, 14);
    const atrPct = current ? atr / current : 0;
    const recentAtr = sample.slice(-20).map((_, i, arr) => this._trueRange(arr, i)).filter(Boolean);
    const atrExpansion = avg(recentAtr.slice(-5)) / (avg(recentAtr.slice(0, 10)) || atr || 1);
    const rangeHigh = Math.max(...highs.slice(-40));
    const rangeLow = Math.min(...lows.slice(-40));
    const rangePct = current ? (rangeHigh - rangeLow) / current : 0;
    const directionalEfficiency = this._directionalEfficiency(closes.slice(-30));
    const volumeNow = avg(volumes.slice(-5));
    const volumeBase = avg(volumes.slice(-40, -5));
    const liquidity = volumeBase ? volumeNow / volumeBase : 1;

    const trendBias = ema21 > ema55 && current > ema21 ? 'BULL_TREND'
      : ema21 < ema55 && current < ema21 ? 'BEAR_TREND'
      : 'BALANCED';
    const volatility = atrPct > 0.025 || atrExpansion > 1.6 ? 'EXPANSION'
      : atrPct < 0.004 && atrExpansion < 0.85 ? 'COMPRESSION'
      : 'NORMAL';
    const structure = directionalEfficiency > 0.55 ? 'DIRECTIONAL'
      : rangePct < atrPct * 9 ? 'RANGE'
      : 'CHOP';

    let tradeability = 55;
    const reasons = [];

    if (trendBias !== 'BALANCED' && structure === 'DIRECTIONAL') {
      tradeability += 20;
      reasons.push(`${trendBias} with efficient directional movement`);
    }
    if (volatility === 'NORMAL') {
      tradeability += 10;
      reasons.push('Volatility is normal enough for planned stops');
    } else if (volatility === 'EXPANSION') {
      tradeability -= 12;
      reasons.push('Volatility expansion requires reduced size and wider patience');
    } else {
      tradeability -= 6;
      reasons.push('Volatility compression can create false breaks');
    }
    if (liquidity >= 0.85) {
      tradeability += 7;
      reasons.push('Recent liquidity is healthy versus baseline');
    } else {
      tradeability -= 10;
      reasons.push('Recent liquidity is thin versus baseline');
    }
    if (structure === 'CHOP') {
      tradeability -= 18;
      reasons.push('Choppy structure reduces signal reliability');
    }

    const regime = trendBias !== 'BALANCED' && structure === 'DIRECTIONAL'
      ? trendBias
      : `${structure}_${volatility}`;

    return {
      regime,
      trend: trendBias,
      structure,
      volatility,
      tradeability: round(clamp(tradeability, 0, 100), 2),
      confidence: round(clamp(45 + directionalEfficiency * 45 + Math.min(liquidity, 1.5) * 8, 0, 100), 2),
      metrics: {
        ema21: round(ema21, 5),
        ema55: round(ema55, 5),
        atr: round(atr, 5),
        atrPct: round(atrPct * 100, 4),
        atrExpansion: round(atrExpansion, 3),
        rangePct: round(rangePct * 100, 4),
        directionalEfficiency: round(directionalEfficiency, 3),
        liquidityRatio: round(liquidity, 3),
      },
      reasons,
    };
  }

  _ema(values, period) {
    if (!values.length) return 0;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).length === period ? avg(values.slice(0, period)) : values[0];
    for (const v of values.slice(period)) ema = v * k + ema * (1 - k);
    return ema;
  }

  _atr(candles, period) {
    const trs = [];
    for (let i = 1; i < candles.length; i++) trs.push(this._trueRange(candles, i));
    const recent = trs.slice(-period);
    return avg(recent);
  }

  _trueRange(candles, i) {
    if (i <= 0 || !candles[i] || !candles[i - 1]) return 0;
    const c = candles[i];
    const p = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }

  _directionalEfficiency(closes) {
    if (closes.length < 3) return 0;
    const net = Math.abs(closes[closes.length - 1] - closes[0]);
    let path = 0;
    for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
    return path ? clamp(net / path, 0, 1) : 0;
  }
}

module.exports = { RegimeEngine };
