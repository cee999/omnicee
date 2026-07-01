'use strict';

const EventEmitter = require('events');

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return Math.sqrt(avg(values.map(v => (v - mean) ** 2)));
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

class VolumeOIAgent extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbol = config.symbol || 'UNKNOWN';
    this.timeframe = config.timeframe || 'H1';
    this.lookback = config.lookback || 80;
  }

  async analyze(candles = []) {
    if (!Array.isArray(candles) || candles.length < 30) {
      return this._wait('Not enough candles for volume/OI confirmation');
    }

    const recent = candles.slice(-this.lookback);
    const last = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    const volumes = recent.map(c => Number(c.volume || c.vol || 0));
    const closes = recent.map(c => Number(c.close || 0));
    const volumeMean = avg(volumes.slice(0, -1));
    const volumeStd = stdev(volumes.slice(0, -1));
    const volumeZ = volumeStd ? (Number(last.volume || 0) - volumeMean) / volumeStd : 0;

    const obv = this._obv(recent);
    const obvSlope = this._slope(obv.slice(-20));
    const priceSlope = this._slope(closes.slice(-20));
    const candleSpread = Math.max(0, Number(last.high) - Number(last.low));
    const closeLocation = candleSpread ? (Number(last.close) - Number(last.low)) / candleSpread : 0.5;
    const body = Math.abs(Number(last.close) - Number(last.open));
    const bodyShare = candleSpread ? body / candleSpread : 0;

    let longScore = 45;
    let shortScore = 45;
    const reasons = [];

    if (volumeZ > 1.2 && last.close > last.open && closeLocation > 0.62) {
      longScore += 18;
      reasons.push(`Bullish volume expansion z=${round(volumeZ, 2)} with strong close location`);
    }
    if (volumeZ > 1.2 && last.close < last.open && closeLocation < 0.38) {
      shortScore += 18;
      reasons.push(`Bearish volume expansion z=${round(volumeZ, 2)} with weak close location`);
    }

    if (obvSlope > 0 && priceSlope >= 0) {
      longScore += 12;
      reasons.push('OBV accumulation confirms rising price structure');
    } else if (obvSlope < 0 && priceSlope <= 0) {
      shortScore += 12;
      reasons.push('OBV distribution confirms falling price structure');
    } else if (obvSlope > 0 && priceSlope < 0) {
      longScore += 8;
      reasons.push('Bullish OBV divergence while price pulls back');
    } else if (obvSlope < 0 && priceSlope > 0) {
      shortScore += 8;
      reasons.push('Bearish OBV divergence while price pushes higher');
    }

    if (bodyShare > 0.62 && Number(last.volume || 0) > volumeMean) {
      const dir = last.close >= last.open ? 'LONG' : 'SHORT';
      if (dir === 'LONG') longScore += 8;
      else shortScore += 8;
      reasons.push(`${dir} initiative candle printed on above-average volume`);
    }

    const oi = Number(last.openInterest ?? last.oi ?? 0);
    const prevOi = Number(prev.openInterest ?? prev.oi ?? 0);
    if (oi && prevOi) {
      const oiChange = (oi - prevOi) / prevOi;
      if (oiChange > 0.005 && last.close > prev.close) {
        longScore += 10;
        reasons.push(`Open interest expanding into upside move (${round(oiChange * 100, 2)}%)`);
      } else if (oiChange > 0.005 && last.close < prev.close) {
        shortScore += 10;
        reasons.push(`Open interest expanding into downside move (${round(oiChange * 100, 2)}%)`);
      } else if (oiChange < -0.006) {
        longScore -= 5;
        shortScore -= 5;
        reasons.push('Open interest contraction warns of de-risking');
      }
    }

    const funding = Number(last.fundingRate ?? last.funding ?? 0);
    if (funding > 0.0005) {
      shortScore += 4;
      reasons.push('Positive funding adds contrarian long-crowding pressure');
    } else if (funding < -0.0005) {
      longScore += 4;
      reasons.push('Negative funding adds contrarian short-crowding pressure');
    }

    longScore = clamp(longScore, 0, 100);
    shortScore = clamp(shortScore, 0, 100);
    const edge = Math.abs(longScore - shortScore);
    const direction = edge < 8 ? 'WAIT' : (longScore > shortScore ? 'LONG' : 'SHORT');
    const score = direction === 'LONG' ? longScore : direction === 'SHORT' ? shortScore : Math.max(longScore, shortScore);

    const result = {
      agent: 'VolumeOIAgent',
      symbol: this.symbol,
      timeframe: this.timeframe,
      direction,
      score: round(score, 2),
      reasons: reasons.length ? reasons : ['Volume/OI profile is balanced; no decisive confirmation'],
      analysis: {
        volumeZ: round(volumeZ, 3),
        volumeMean: round(volumeMean, 2),
        obvSlope: round(obvSlope, 6),
        priceSlope: round(priceSlope, 6),
        closeLocation: round(closeLocation, 3),
        bodyShare: round(bodyShare, 3),
        longScore: round(longScore, 2),
        shortScore: round(shortScore, 2),
      },
    };

    this.emit('analysis', result);
    return result;
  }

  _wait(reason) {
    return {
      agent: 'VolumeOIAgent',
      symbol: this.symbol,
      timeframe: this.timeframe,
      direction: 'WAIT',
      score: 45,
      reasons: [reason],
      analysis: {},
    };
  }

  _obv(candles) {
    const values = [0];
    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];
      const volume = Number(curr.volume || 0);
      const delta = curr.close > prev.close ? volume : curr.close < prev.close ? -volume : 0;
      values.push(values[values.length - 1] + delta);
    }
    return values;
  }

  _slope(values) {
    if (!values || values.length < 3) return 0;
    const xMean = (values.length - 1) / 2;
    const yMean = avg(values);
    let num = 0;
    let den = 0;
    values.forEach((y, x) => {
      num += (x - xMean) * (y - yMean);
      den += (x - xMean) ** 2;
    });
    return den ? num / den / (Math.abs(yMean) || 1) : 0;
  }
}

module.exports = { VolumeOIAgent };
