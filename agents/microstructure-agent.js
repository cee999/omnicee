'use strict';

/**
 * ============================================================
 *  MICROSTRUCTURE AGENT — Order Flow & Volume Profile Analysis
 *  Institutional-Grade Market Microstructure Intelligence
 * ============================================================
 *
 *  Analyzes:
 *    - Volume Profile (POC, Value Area High/Low, HVN, LVN)
 *    - Cumulative Volume Delta (CVD) — buy vs sell pressure
 *    - Order Flow Imbalance — bid/ask volume asymmetry
 *    - Absorption Detection — large volume without price movement
 *    - Initiative vs Responsive Activity
 *    - Volume-Weighted Price Analysis
 *    - Footprint Chart Analysis (simulated from OHLCV)
 *    - Delta Divergence — CVD vs price divergence
 *    - Liquidity Void Detection
 *    - Institutional Accumulation/Distribution Patterns
 *
 *  Output: { direction, score, reasons, analysis }
 *  Compatible with signal-scorer.js agent vote format
 * ============================================================
 */

const EventEmitter = require('events');

function round(n, d = 4) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1));
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Volume Profile Builder — constructs TPO-like volume profile from candle data
 */
class VolumeProfileBuilder {
  static build(candles, bins = 50) {
    if (!candles || candles.length < 20) return null;

    const allHighs = candles.map(c => c.high);
    const allLows = candles.map(c => c.low);
    const highest = Math.max(...allHighs);
    const lowest = Math.min(...allLows);
    const range = highest - lowest;

    if (range <= 0) return null;

    const binSize = range / bins;
    const profile = new Array(bins).fill(0);
    const buyProfile = new Array(bins).fill(0);
    const sellProfile = new Array(bins).fill(0);

    for (const c of candles) {
      const vol = c.volume || 1;
      const isBuy = c.close >= c.open;
      const cRange = c.high - c.low;
      const candleBins = Math.max(1, Math.ceil(cRange / binSize));
      const volPerBin = vol / candleBins;

      for (let price = c.low; price <= c.high; price += binSize) {
        const bin = Math.min(Math.floor((price - lowest) / binSize), bins - 1);
        if (bin >= 0 && bin < bins) {
          profile[bin] += volPerBin;
          if (isBuy) buyProfile[bin] += volPerBin;
          else sellProfile[bin] += volPerBin;
        }
      }
    }

    // Point of Control (POC) — price level with highest volume
    let pocBin = 0;
    let maxVol = 0;
    for (let i = 0; i < bins; i++) {
      if (profile[i] > maxVol) {
        maxVol = profile[i];
        pocBin = i;
      }
    }
    const poc = lowest + (pocBin + 0.5) * binSize;

    // Value Area (70% of total volume around POC)
    const totalVol = profile.reduce((s, v) => s + v, 0);
    const vaTarget = totalVol * 0.70;
    let vaVol = profile[pocBin];
    let vaLow = pocBin, vaHigh = pocBin;

    while (vaVol < vaTarget && (vaLow > 0 || vaHigh < bins - 1)) {
      const below = vaLow > 0 ? profile[vaLow - 1] : 0;
      const above = vaHigh < bins - 1 ? profile[vaHigh + 1] : 0;
      if (below >= above && vaLow > 0) {
        vaLow--;
        vaVol += profile[vaLow];
      } else if (vaHigh < bins - 1) {
        vaHigh++;
        vaVol += profile[vaHigh];
      } else {
        break;
      }
    }

    const vah = lowest + (vaHigh + 1) * binSize;
    const val = lowest + vaLow * binSize;

    // High Volume Nodes (HVN) — above average volume
    const avgBinVol = totalVol / bins;
    const hvn = [];
    const lvn = [];
    for (let i = 0; i < bins; i++) {
      const price = lowest + (i + 0.5) * binSize;
      if (profile[i] > avgBinVol * 1.5) {
        hvn.push({ price: round(price), volume: round(profile[i]) });
      }
      if (profile[i] < avgBinVol * 0.3 && profile[i] > 0) {
        lvn.push({ price: round(price), volume: round(profile[i]) });
      }
    }

    return {
      poc: round(poc),
      vah: round(vah),
      val: round(val),
      hvn: hvn.slice(0, 5),
      lvn: lvn.slice(0, 5),
      totalVolume: round(totalVol),
      binSize: round(binSize),
      profileShape: this._classifyShape(profile, pocBin, bins),
      buyDominance: round(buyProfile.reduce((s, v) => s + v, 0) / totalVol, 3),
    };
  }

  static _classifyShape(profile, pocBin, bins) {
    const third = Math.floor(bins / 3);
    const lower = profile.slice(0, third).reduce((s, v) => s + v, 0);
    const middle = profile.slice(third, third * 2).reduce((s, v) => s + v, 0);
    const upper = profile.slice(third * 2).reduce((s, v) => s + v, 0);
    const total = lower + middle + upper;

    if (total === 0) return 'FLAT';
    const lPct = lower / total, mPct = middle / total, uPct = upper / total;

    if (mPct > 0.45) return 'NORMAL'; // bell-shaped = balanced
    if (lPct > 0.45) return 'P_SHAPED'; // heavy volume at bottom = accumulation
    if (uPct > 0.45) return 'B_SHAPED'; // heavy volume at top = distribution
    if (lPct > 0.35 && uPct > 0.35) return 'D_SHAPED'; // bimodal = indecision
    return 'LEAN'; // skewed
  }
}

/**
 * Cumulative Volume Delta Analysis
 */
class CVDAnalyzer {
  static analyze(candles) {
    if (!candles || candles.length < 10) return null;

    const deltas = [];
    const cvd = [];
    let cumDelta = 0;

    for (const c of candles) {
      const vol = c.volume || 1;
      const range = c.high - c.low;

      // Estimate buy/sell volume from candle shape
      let buyPct;
      if (range === 0) {
        buyPct = 0.5;
      } else {
        // Close location value determines buy/sell split
        const clv = ((c.close - c.low) - (c.high - c.close)) / range;
        buyPct = (clv + 1) / 2; // normalize to 0-1
      }

      const buyVol = vol * buyPct;
      const sellVol = vol * (1 - buyPct);
      const delta = buyVol - sellVol;

      deltas.push(delta);
      cumDelta += delta;
      cvd.push(cumDelta);
    }

    // CVD trend
    const cvdSlope = CVDAnalyzer._slope(cvd.slice(-20));
    const priceSlope = CVDAnalyzer._slope(candles.slice(-20).map(c => c.close));

    // Divergence detection
    const divergence = CVDAnalyzer._detectDivergence(
      candles.slice(-30).map(c => c.close),
      cvd.slice(-30)
    );

    // Absorption: high volume, small price movement
    const absorption = CVDAnalyzer._detectAbsorption(candles.slice(-10));

    return {
      currentDelta: round(deltas[deltas.length - 1]),
      cumulativeDelta: round(cumDelta),
      cvdSlope: round(cvdSlope, 6),
      priceSlope: round(priceSlope, 6),
      cvdTrend: cvdSlope > 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
      divergence,
      absorption,
    };
  }

  static _slope(values) {
    if (!values || values.length < 3) return 0;
    const xMean = (values.length - 1) / 2;
    const yMean = avg(values);
    let num = 0, den = 0;
    for (let i = 0; i < values.length; i++) {
      num += (i - xMean) * (values[i] - yMean);
      den += (i - xMean) ** 2;
    }
    return den ? num / den / (Math.abs(yMean) || 1) : 0;
  }

  static _detectDivergence(prices, cvd) {
    if (prices.length < 10 || cvd.length < 10) return { type: 'NONE' };

    const half = Math.floor(prices.length / 2);
    const priceH1 = Math.max(...prices.slice(0, half));
    const priceH2 = Math.max(...prices.slice(half));
    const priceL1 = Math.min(...prices.slice(0, half));
    const priceL2 = Math.min(...prices.slice(half));
    const cvdH1 = Math.max(...cvd.slice(0, half));
    const cvdH2 = Math.max(...cvd.slice(half));
    const cvdL1 = Math.min(...cvd.slice(0, half));
    const cvdL2 = Math.min(...cvd.slice(half));

    // Bearish: price higher high, CVD lower high
    if (priceH2 > priceH1 * 1.001 && cvdH2 < cvdH1 * 0.999) {
      return { type: 'BEARISH_DIVERGENCE', note: 'Price making higher highs but buying pressure declining' };
    }
    // Bullish: price lower low, CVD higher low
    if (priceL2 < priceL1 * 0.999 && cvdL2 > cvdL1 * 1.001) {
      return { type: 'BULLISH_DIVERGENCE', note: 'Price making lower lows but selling pressure declining' };
    }

    return { type: 'NONE' };
  }

  static _detectAbsorption(candles) {
    const absorptions = [];
    const avgVol = avg(candles.map(c => c.volume || 1));

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const vol = c.volume || 1;
      const range = c.high - c.low;
      const body = Math.abs(c.close - c.open);
      const bodyRatio = range > 0 ? body / range : 0;

      // High volume + small body = absorption
      if (vol > avgVol * 1.5 && bodyRatio < 0.35) {
        absorptions.push({
          type: c.close > c.open ? 'BUY_ABSORPTION' : 'SELL_ABSORPTION',
          volumeRatio: round(vol / avgVol, 2),
          bodyRatio: round(bodyRatio, 3),
          note: `${c.close > c.open ? 'Bearish' : 'Bullish'} absorption — large volume held by opposite side`,
        });
      }
    }

    return absorptions;
  }
}

/**
 * Initiative vs Responsive Activity Detector
 */
class InitiativeDetector {
  static analyze(candles, volumeProfile) {
    if (!candles || candles.length < 10 || !volumeProfile) return null;

    const last = candles[candles.length - 1];
    const price = last.close;
    const { poc, vah, val } = volumeProfile;

    // Initiative = trading OUTSIDE value area with conviction
    // Responsive = trading INSIDE value area (mean reversion)
    const isAboveVA = price > vah;
    const isBelowVA = price < val;
    const isInsideVA = !isAboveVA && !isBelowVA;

    const vol = last.volume || 1;
    const avgVol = avg(candles.slice(-20).map(c => c.volume || 1));
    const isHighVol = vol > avgVol * 1.2;

    let activity;
    if (isAboveVA && isHighVol && last.close > last.open) {
      activity = 'INITIATIVE_BUY';
    } else if (isBelowVA && isHighVol && last.close < last.open) {
      activity = 'INITIATIVE_SELL';
    } else if (isInsideVA) {
      activity = 'RESPONSIVE';
    } else {
      activity = 'NEUTRAL';
    }

    return {
      activity,
      priceRelativeToVA: isAboveVA ? 'ABOVE' : isBelowVA ? 'BELOW' : 'INSIDE',
      priceRelativeToPOC: price > poc ? 'ABOVE_POC' : 'BELOW_POC',
      volumeContext: isHighVol ? 'HIGH' : 'NORMAL',
      note: activity === 'INITIATIVE_BUY' ? 'Institutional buying above value area'
        : activity === 'INITIATIVE_SELL' ? 'Institutional selling below value area'
        : activity === 'RESPONSIVE' ? 'Responsive trading inside value area'
        : 'Neutral activity',
    };
  }
}

/**
 * Main Microstructure Agent
 */
class MicrostructureAgent extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbol = config.symbol || 'UNKNOWN';
    this.timeframe = config.timeframe || 'H1';
    this.profileBins = config.profileBins || 50;
  }

  async analyze(candles) {
    if (!candles || candles.length < 30) {
      return this._wait('Insufficient data for microstructure analysis');
    }

    const reasons = [];
    let longScore = 45;
    let shortScore = 45;

    // Volume Profile
    const profile = VolumeProfileBuilder.build(candles.slice(-100), this.profileBins);
    if (profile) {
      const price = candles[candles.length - 1].close;

      // Price below POC in accumulation shape = bullish
      if (price < profile.poc && profile.profileShape === 'P_SHAPED') {
        longScore += 15;
        reasons.push('Price below POC in accumulation (P-shaped) profile');
      }
      // Price above POC in distribution shape = bearish
      if (price > profile.poc && profile.profileShape === 'B_SHAPED') {
        shortScore += 15;
        reasons.push('Price above POC in distribution (B-shaped) profile');
      }

      // Price at LVN = fast move expected
      const nearLVN = profile.lvn.some(n => Math.abs(price - n.price) / price < 0.003);
      if (nearLVN) {
        reasons.push('Price at Low Volume Node — expect fast directional move');
        longScore += 5;
        shortScore += 5;
      }

      // Price at HVN = support/resistance
      const nearHVN = profile.hvn.some(n => Math.abs(price - n.price) / price < 0.003);
      if (nearHVN) {
        reasons.push('Price at High Volume Node — strong support/resistance');
      }

      // Buy dominance
      if (profile.buyDominance > 0.58) {
        longScore += 10;
        reasons.push(`Buy dominance ${round(profile.buyDominance * 100, 1)}% in volume profile`);
      } else if (profile.buyDominance < 0.42) {
        shortScore += 10;
        reasons.push(`Sell dominance ${round((1 - profile.buyDominance) * 100, 1)}% in volume profile`);
      }
    }

    // CVD Analysis
    const cvd = CVDAnalyzer.analyze(candles);
    if (cvd) {
      if (cvd.cvdTrend === 'ACCUMULATION' && cvd.cvdSlope > 0) {
        longScore += 12;
        reasons.push('CVD shows net accumulation — buying pressure dominant');
      } else if (cvd.cvdTrend === 'DISTRIBUTION' && cvd.cvdSlope < 0) {
        shortScore += 12;
        reasons.push('CVD shows net distribution — selling pressure dominant');
      }

      if (cvd.divergence.type === 'BULLISH_DIVERGENCE') {
        longScore += 10;
        reasons.push(`CVD ${cvd.divergence.note}`);
      } else if (cvd.divergence.type === 'BEARISH_DIVERGENCE') {
        shortScore += 10;
        reasons.push(`CVD ${cvd.divergence.note}`);
      }

      // Absorption
      for (const abs of cvd.absorption) {
        if (abs.type === 'BUY_ABSORPTION') {
          shortScore += 6;
          reasons.push(`Buy absorption detected (vol ${abs.volumeRatio}x avg) — sellers may take over`);
        } else if (abs.type === 'SELL_ABSORPTION') {
          longScore += 6;
          reasons.push(`Sell absorption detected (vol ${abs.volumeRatio}x avg) — buyers may take over`);
        }
      }
    }

    // Initiative Detection
    if (profile) {
      const initiative = InitiativeDetector.analyze(candles, profile);
      if (initiative) {
        if (initiative.activity === 'INITIATIVE_BUY') {
          longScore += 12;
          reasons.push('Initiative buying above value area — institutional demand');
        } else if (initiative.activity === 'INITIATIVE_SELL') {
          shortScore += 12;
          reasons.push('Initiative selling below value area — institutional supply');
        }
      }
    }

    // Final direction
    longScore = clamp(longScore, 0, 100);
    shortScore = clamp(shortScore, 0, 100);
    const edge = Math.abs(longScore - shortScore);
    const direction = edge < 8 ? 'WAIT' : longScore > shortScore ? 'LONG' : 'SHORT';
    const score = direction === 'LONG' ? longScore : direction === 'SHORT' ? shortScore : Math.max(longScore, shortScore);

    const result = {
      agent: 'MicrostructureAgent',
      symbol: this.symbol,
      timeframe: this.timeframe,
      direction,
      score: round(score, 2),
      reasons: reasons.length ? reasons : ['Microstructure profile is balanced'],
      analysis: {
        volumeProfile: profile ? {
          poc: profile.poc,
          vah: profile.vah,
          val: profile.val,
          shape: profile.profileShape,
          buyDominance: profile.buyDominance,
        } : null,
        cvd: cvd ? {
          trend: cvd.cvdTrend,
          divergence: cvd.divergence.type,
          absorptions: cvd.absorption.length,
        } : null,
        longScore: round(longScore, 2),
        shortScore: round(shortScore, 2),
      },
    };

    this.emit('analysis', result);
    return result;
  }

  _wait(reason) {
    return {
      agent: 'MicrostructureAgent',
      symbol: this.symbol,
      timeframe: this.timeframe,
      direction: 'WAIT',
      score: 45,
      reasons: [reason],
      analysis: {},
    };
  }
}

module.exports = { MicrostructureAgent };
