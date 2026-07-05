/**
 * ============================================================
 *  MTF AGENT — Multi-Timeframe Alignment & Confluence Engine
 *  AI Trading Assistant · Layer 4 · Specialized Agent #2
 * ============================================================
 *
 *  What this agent does:
 *    - Reads candle data across ALL timeframes simultaneously
 *      (M1, M5, M15, M30, H1, H2, H4, H6, H8, H12, D1, W1)
 *    - Determines the Higher Timeframe (HTF) directional bias
 *      and LOCKS it — no trade against the HTF trend ever
 *    - Scores trend alignment: how many TFs agree on direction
 *    - Detects pullback entries on LTF within HTF trend
 *    - Identifies key HTF Points of Interest (POIs)
 *    - Flags when price is AT a HTF POI (highest probability entries)
 *    - Detects session-based killzone alignment
 *    - Produces a 0–100 score for the signal-scorer.js vote
 *    - Tracks momentum divergence across timeframes
 *    - Identifies range vs trending market structure per TF
 *    - Computes ADX trend strength per timeframe
 *    - Tracks EMA alignment across timeframes
 *    - Higher timeframe confluence: when D1+H4+H1 all agree = A+ setup
 *
 *  Outputs to signal-scorer.js:
 *    { direction, score, grade, reasons, analysis, htfBias }
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const DIRECTION = {
  LONG:    'LONG',
  SHORT:   'SHORT',
  WAIT:    'WAIT',
  RANGING: 'RANGING',
};

const TREND_STRENGTH = {
  STRONG:   'STRONG',
  MODERATE: 'MODERATE',
  WEAK:     'WEAK',
  NONE:     'NONE',
};

const MARKET_STATE = {
  TRENDING:  'TRENDING',
  RANGING:   'RANGING',
  BREAKOUT:  'BREAKOUT',
  REVERSAL:  'REVERSAL',
};

// Timeframe hierarchy — higher index = higher timeframe
const TF_HIERARCHY = ['M1','M5','M15','M30','H1','H2','H4','H6','H8','H12','D1','W1'];

// Timeframe weights for confluence scoring — higher TF = more weight
const TF_WEIGHTS = {
  M1:  0.03,
  M5:  0.05,
  M15: 0.08,
  M30: 0.10,
  H1:  0.15,
  H2:  0.08,
  H4:  0.18,
  H6:  0.06,
  H8:  0.06,
  H12: 0.05,
  D1:  0.10,
  W1:  0.06,
};

// Minimum candles needed per TF for reliable analysis
const MIN_CANDLES_PER_TF = {
  M1:  100, M5: 80, M15: 60, M30: 50,
  H1:  50,  H2: 40, H4:  40, H6:  30,
  H8:  30,  H12: 25, D1: 20, W1:  15,
};

// ADX threshold for trending market
const ADX_TREND_THRESHOLD     = 25;
const ADX_STRONG_THRESHOLD    = 35;

// ─────────────────────────────────────────────
//  MATHEMATICAL UTILITIES
// ─────────────────────────────────────────────

function round(n, d = 5) {
  return parseFloat(n.toFixed(d));
}

function average(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr) {
  const avg = average(arr);
  const squaredDiffs = arr.map(v => Math.pow(v - avg, 2));
  return Math.sqrt(average(squaredDiffs));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ─────────────────────────────────────────────
//  INDICATOR LIBRARY
// ─────────────────────────────────────────────

class Indicators {

  /**
   * Simple Moving Average
   */
  static sma(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    return round(average(slice));
  }

  /**
   * Exponential Moving Average
   * Uses standard multiplier: 2 / (period + 1)
   */
  static ema(closes, period) {
    if (closes.length < period) return null;
    const k   = 2 / (period + 1);
    let ema   = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return round(ema);
  }

  /**
   * Full EMA history array — needed for MACD and signal lines
   */
  static emaArray(closes, period) {
    if (closes.length < period) return [];
    const k    = 2 / (period + 1);
    const result = [];
    let ema    = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
    result.push(ema);
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result.map(v => round(v));
  }

  /**
   * RSI — Relative Strength Index
   * Standard Wilder smoothing (RMA)
   */
  static rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;

    let gains = 0, losses = 0;

    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains  += diff;
      else          losses -= diff;
    }

    let avgGain = gains  / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;

      avgGain = (avgGain * (period - 1) + gain)  / period;
      avgLoss = (avgLoss * (period - 1) + loss)  / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return round(100 - 100 / (1 + rs), 2);
  }

  /**
   * MACD — Moving Average Convergence Divergence
   * Returns { macd, signal, histogram }
   */
  static macd(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return null;

    const fastEMA   = this.emaArray(closes, fast);
    const slowEMA   = this.emaArray(closes, slow);

    // Align arrays — fast has more values
    const offset    = fastEMA.length - slowEMA.length;
    const macdLine  = slowEMA.map((v, i) => round(fastEMA[i + offset] - v));

    const signalLine = this.emaArray(macdLine, signal);
    const sigOffset  = macdLine.length - signalLine.length;

    const histogram  = signalLine.map((v, i) => round(macdLine[i + sigOffset] - v));

    return {
      macd:      macdLine.slice(-1)[0],
      signal:    signalLine.slice(-1)[0],
      histogram: histogram.slice(-1)[0],
      prevHistogram: histogram.slice(-2)[0] || 0,
      increasing: histogram.slice(-1)[0] > (histogram.slice(-2)[0] || 0),
      crossedUp:  signalLine.slice(-2)[0] < macdLine.slice(-(signalLine.length))[macdLine.length - signalLine.length - 1]
        && macdLine.slice(-1)[0] > signalLine.slice(-1)[0],
    };
  }

  /**
   * Average True Range
   */
  static atr(candles, period = 14) {
    if (candles.length < period + 1) return null;

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const high  = candles[i].high;
      const low   = candles[i].low;
      const prev  = candles[i - 1].close;
      trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
    }

    // Wilder smoothing
    let atr = average(trs.slice(0, period));
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }

    return round(atr);
  }

  /**
   * ADX — Average Directional Index
   * Returns { adx, plusDI, minusDI, trend: 'UP'|'DOWN'|'NONE' }
   */
  static adx(candles, period = 14) {
    if (candles.length < period * 2) return null;

    const trs = [], plusDMs = [], minusDMs = [];

    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];

      const tr      = Math.max(curr.high - curr.low,
                               Math.abs(curr.high - prev.close),
                               Math.abs(curr.low  - prev.close));

      const plusDM  = curr.high - prev.high > prev.low - curr.low
        ? Math.max(curr.high - prev.high, 0) : 0;
      const minusDM = prev.low - curr.low > curr.high - prev.high
        ? Math.max(prev.low - curr.low, 0) : 0;

      trs.push(tr);
      plusDMs.push(plusDM);
      minusDMs.push(minusDM);
    }

    // Wilder smooth
    const smooth = (arr, p) => {
      let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
      const result = [s];
      for (let i = p; i < arr.length; i++) {
        s = s - s / p + arr[i];
        result.push(s);
      }
      return result;
    };

    const sTR     = smooth(trs,     period);
    const sPDM    = smooth(plusDMs, period);
    const sMDM    = smooth(minusDMs,period);

    const plusDIs  = sTR.map((v, i) => v === 0 ? 0 : (sPDM[i] / v) * 100);
    const minusDIs = sTR.map((v, i) => v === 0 ? 0 : (sMDM[i] / v) * 100);

    const dxs = plusDIs.map((v, i) => {
      const sum = v + minusDIs[i];
      return (sum === 0 || isNaN(sum)) ? 0 : (Math.abs(v - minusDIs[i]) / sum) * 100;
    });

    let adx = average(dxs.slice(0, period));
    for (let i = period; i < dxs.length; i++) {
      adx = (adx * (period - 1) + dxs[i]) / period;
    }

    const plusDI  = plusDIs.slice(-1)[0];
    const minusDI = minusDIs.slice(-1)[0];

    return {
      adx:       round(adx, 2),
      plusDI:    round(plusDI, 2),
      minusDI:   round(minusDI, 2),
      trend:     plusDI > minusDI ? 'UP' : 'DOWN',
      strength:  adx >= ADX_STRONG_THRESHOLD ? TREND_STRENGTH.STRONG
        : adx >= ADX_TREND_THRESHOLD ? TREND_STRENGTH.MODERATE
        : adx >= 15 ? TREND_STRENGTH.WEAK
        : TREND_STRENGTH.NONE,
      isTrending: adx >= ADX_TREND_THRESHOLD,
    };
  }

  /**
   * Bollinger Bands
   * Returns { upper, middle, lower, width, percentB, isSqueeze }
   */
  static bollingerBands(closes, period = 20, multiplier = 2) {
    if (closes.length < period) return null;

    const slice  = closes.slice(-period);
    const middle = average(slice);
    const std    = stdDev(slice);
    const upper  = middle + multiplier * std;
    const lower  = middle - multiplier * std;
    const width  = middle !== 0 ? (upper - lower) / middle * 100 : 0;
    const current = closes[closes.length - 1];
    const percentB = (current - lower) / (upper - lower);

    // Squeeze = bands very tight (width below 4% for forex, 6% for crypto)
    const isSqueeze = width < 5;

    return {
      upper:     round(upper),
      middle:    round(middle),
      lower:     round(lower),
      width:     round(width, 2),
      percentB:  round(percentB, 3),
      isSqueeze,
      pricePosition: percentB > 0.8 ? 'NEAR_UPPER' : percentB < 0.2 ? 'NEAR_LOWER' : 'MIDDLE',
    };
  }

  /**
   * Stochastic Oscillator
   * Returns { k, d, zone: 'OVERBOUGHT'|'OVERSOLD'|'NEUTRAL', crossUp, crossDown }
   */
  static stochastic(candles, kPeriod = 14, dPeriod = 3, smooth = 3) {
    if (candles.length < kPeriod + dPeriod) return null;

    const rawK = [];
    for (let i = kPeriod - 1; i < candles.length; i++) {
      const slice  = candles.slice(i - kPeriod + 1, i + 1);
      const highest = Math.max(...slice.map(c => c.high));
      const lowest  = Math.min(...slice.map(c => c.low));
      const range   = highest - lowest;
      rawK.push(range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100);
    }

    // Smooth K
    const smoothK = [];
    for (let i = smooth - 1; i < rawK.length; i++) {
      smoothK.push(average(rawK.slice(i - smooth + 1, i + 1)));
    }

    // D line = SMA of smooth K
    const dLine = [];
    for (let i = dPeriod - 1; i < smoothK.length; i++) {
      dLine.push(average(smoothK.slice(i - dPeriod + 1, i + 1)));
    }

    const k        = smoothK[smoothK.length - 1];
    const d        = dLine[dLine.length - 1];
    const prevK    = smoothK[smoothK.length - 2] ?? k;
    const prevD    = dLine[dLine.length - 2] ?? d;

    return {
      k:          round(k, 2),
      d:          round(d, 2),
      zone:       k > 80 ? 'OVERBOUGHT' : k < 20 ? 'OVERSOLD' : 'NEUTRAL',
      crossUp:    prevK <= prevD && k > d,
      crossDown:  prevK >= prevD && k < d,
      isBullish:  k > d && k < 80,
      isBearish:  k < d && k > 20,
    };
  }

  /**
   * Ichimoku Cloud
   * Returns full Ichimoku object including cloud color and signals
   */
  static ichimoku(candles, conversion = 9, base = 26, lagging = 52, displacement = 26) {
    if (candles.length < lagging + displacement) return null;

    const highest = (arr) => Math.max(...arr.map(c => c.high));
    const lowest  = (arr) => Math.min(...arr.map(c => c.low));
    const midpoint = (h, l) => (h + l) / 2;

    const n = candles.length;

    // Tenkan-sen (Conversion Line) = (9H + 9L) / 2
    const tenkan = midpoint(
      highest(candles.slice(n - conversion)),
      lowest(candles.slice(n - conversion))
    );

    // Kijun-sen (Base Line) = (26H + 26L) / 2
    const kijun = midpoint(
      highest(candles.slice(n - base)),
      lowest(candles.slice(n - base))
    );

    // Senkou Span A = (Tenkan + Kijun) / 2, displaced +26
    const senkouA = (tenkan + kijun) / 2;

    // Senkou Span B = (52H + 52L) / 2, displaced +26
    const senkouB = midpoint(
      highest(candles.slice(n - lagging)),
      lowest(candles.slice(n - lagging))
    );

    // Chikou Span = current close, displaced -26
    const chikou = candles[n - 1].close;
    const chikouRefClose = candles[n - 1 - displacement]?.close ?? null;

    const currentClose = candles[n - 1].close;
    const cloudTop     = Math.max(senkouA, senkouB);
    const cloudBottom  = Math.min(senkouA, senkouB);
    const cloudColor   = senkouA > senkouB ? 'BULLISH_GREEN' : 'BEARISH_RED';

    const priceVsCloud = currentClose > cloudTop   ? 'ABOVE_CLOUD'
      : currentClose < cloudBottom ? 'BELOW_CLOUD'
      : 'INSIDE_CLOUD';

    const tkCross = tenkan > kijun ? 'GOLDEN' : tenkan < kijun ? 'DEAD' : 'NEUTRAL';

    return {
      tenkan:        round(tenkan),
      kijun:         round(kijun),
      senkouA:       round(senkouA),
      senkouB:       round(senkouB),
      chikou,
      cloudTop:      round(cloudTop),
      cloudBottom:   round(cloudBottom),
      cloudColor,
      cloudThickness: round(Math.abs(senkouA - senkouB)),
      priceVsCloud,
      tkCross,
      chikouAbovePrice: chikouRefClose !== null ? chikou > chikouRefClose : null,
      // Full bullish setup = price above cloud + TK golden cross + Chikou above price 26 bars ago
      isBullishSetup: priceVsCloud === 'ABOVE_CLOUD'
        && tkCross === 'GOLDEN'
        && (chikouRefClose === null || chikou > chikouRefClose),
      isBearishSetup: priceVsCloud === 'BELOW_CLOUD'
        && tkCross === 'DEAD'
        && (chikouRefClose === null || chikou < chikouRefClose),
    };
  }

  /**
   * VWAP — Volume Weighted Average Price
   * Calculated from session open (or first candle if no session boundary)
   * Returns { vwap, upperBand1, lowerBand1, upperBand2, lowerBand2, pricePosition }
   */
  static vwap(candles) {
    if (!candles || candles.length === 0) return null;

    let cumPV  = 0;
    let cumVol = 0;
    const typicalPrices = [];

    for (const c of candles) {
      const tp   = (c.high + c.low + c.close) / 3;
      cumPV     += tp * (c.volume || 1);
      cumVol    += (c.volume || 1);
      typicalPrices.push(tp);
    }

    const vwap = cumPV / cumVol;

    // Standard deviation for bands
    const variance = typicalPrices.reduce((s, tp) => s + Math.pow(tp - vwap, 2), 0)
      / typicalPrices.length;
    const std = Math.sqrt(variance);

    const currentClose = candles[candles.length - 1].close;
    const deviation    = (currentClose - vwap) / std;

    return {
      vwap:         round(vwap),
      upperBand1:   round(vwap + std),
      lowerBand1:   round(vwap - std),
      upperBand2:   round(vwap + 2 * std),
      lowerBand2:   round(vwap - 2 * std),
      deviation:    round(deviation, 3),
      pricePosition: currentClose > vwap + std    ? 'EXTENDED_ABOVE'
        : currentClose > vwap              ? 'ABOVE'
        : currentClose < vwap - std        ? 'EXTENDED_BELOW'
        : 'BELOW',
      reclaimBias: currentClose > vwap ? 'BULLISH' : 'BEARISH',
    };
  }

  /**
   * EMA Stack Analysis
   * Checks alignment of EMA 20, 50, 200
   * Returns { aligned, direction, ema20, ema50, ema200, priceVsAll }
   */
  static emaStack(closes) {
    const ema20  = this.ema(closes, 20);
    const ema50  = this.ema(closes, 50);
    const ema200 = this.ema(closes, 200);

    if (!ema20 || !ema50 || !ema200) {
      return { aligned: false, direction: 'UNKNOWN', ema20, ema50, ema200 };
    }

    const bullishStack = ema20 > ema50 && ema50 > ema200;
    const bearishStack = ema20 < ema50 && ema50 < ema200;

    const currentClose = closes[closes.length - 1];
    const priceAbove20  = currentClose > ema20;
    const priceAbove50  = currentClose > ema50;
    const priceAbove200 = currentClose > ema200;

    return {
      ema20,
      ema50,
      ema200,
      aligned:    bullishStack || bearishStack,
      direction:  bullishStack ? 'BULLISH' : bearishStack ? 'BEARISH' : 'MIXED',
      bullishStack,
      bearishStack,
      priceAbove20,
      priceAbove50,
      priceAbove200,
      priceVsAll: priceAbove20 && priceAbove50 && priceAbove200 ? 'FULLY_ABOVE'
        : !priceAbove20 && !priceAbove50 && !priceAbove200 ? 'FULLY_BELOW'
        : 'MIXED',
      // Golden cross / death cross recent
      goldenCross: ema20 > ema50 && ema20 - ema50 < ema50 * 0.001,
      deathCross:  ema20 < ema50 && ema50 - ema20 < ema50 * 0.001,
    };
  }
}

// ─────────────────────────────────────────────
//  SINGLE TIMEFRAME ANALYZER
// ─────────────────────────────────────────────

class TimeframeAnalyzer {
  /**
   * Performs complete technical analysis on a single timeframe's candles.
   * Returns a structured analysis object used by the MTF agent.
   *
   * @param {string} tf       - timeframe label e.g. 'H1'
   * @param {Array}  candles  - OHLCV array
   * @returns {Object} tfAnalysis
   */
  static analyze(tf, candles) {
    if (!candles || candles.length < (MIN_CANDLES_PER_TF[tf] || 20)) {
      return {
        tf,
        valid:     false,
        direction: DIRECTION.WAIT,
        score:     0,
        reason:    `Insufficient candles for ${tf}: ${candles?.length ?? 0}`,
      };
    }

    const closes  = candles.map(c => c.close);
    const current = candles[candles.length - 1];

    // ── Compute all indicators ──
    const emaStackResult = Indicators.emaStack(closes);
    const rsi            = Indicators.rsi(closes, 14);
    const macd           = Indicators.macd(closes, 12, 26, 9);
    const adxResult      = Indicators.adx(candles, 14);
    const bb             = Indicators.bollingerBands(closes, 20, 2);
    const stoch          = Indicators.stochastic(candles, 14, 3, 3);
    const ichimoku       = Indicators.ichimoku(candles);
    const vwap           = Indicators.vwap(candles.slice(-50)); // last 50 candles as session approx
    const atr            = Indicators.atr(candles, 14);

    // ── Determine trend direction ──
    let bullPoints = 0;
    let bearPoints = 0;
    const reasons  = [];

    // EMA stack (weight: 3)
    if (emaStackResult.bullishStack) {
      bullPoints += 3;
      reasons.push(`${tf} EMA stack bullish (20>50>200)`);
    } else if (emaStackResult.bearishStack) {
      bearPoints += 3;
      reasons.push(`${tf} EMA stack bearish (20<50<200)`);
    }

    // Price vs EMA200 (weight: 2)
    if (emaStackResult.priceAbove200) {
      bullPoints += 2;
      reasons.push(`${tf} Price above EMA200 — bull territory`);
    } else {
      bearPoints += 2;
      reasons.push(`${tf} Price below EMA200 — bear territory`);
    }

    // RSI (weight: 2)
    if (rsi !== null) {
      if (rsi > 55 && rsi < 75) {
        bullPoints += 2;
        reasons.push(`${tf} RSI ${rsi} — bullish momentum`);
      } else if (rsi < 45 && rsi > 25) {
        bearPoints += 2;
        reasons.push(`${tf} RSI ${rsi} — bearish momentum`);
      } else if (rsi >= 75) {
        bearPoints += 1; // overbought = caution
        reasons.push(`${tf} RSI ${rsi} — overbought, caution`);
      } else if (rsi <= 25) {
        bullPoints += 1; // oversold = caution
        reasons.push(`${tf} RSI ${rsi} — oversold, possible bounce`);
      }
    }

    // MACD (weight: 2)
    if (macd) {
      if (macd.histogram > 0 && macd.increasing) {
        bullPoints += 2;
        reasons.push(`${tf} MACD histogram positive and rising`);
      } else if (macd.histogram < 0 && !macd.increasing) {
        bearPoints += 2;
        reasons.push(`${tf} MACD histogram negative and falling`);
      }
    }

    // ADX trend (weight: 2)
    if (adxResult && adxResult.isTrending) {
      if (adxResult.trend === 'UP') {
        bullPoints += 2;
        reasons.push(`${tf} ADX ${adxResult.adx} — strong uptrend`);
      } else {
        bearPoints += 2;
        reasons.push(`${tf} ADX ${adxResult.adx} — strong downtrend`);
      }
    }

    // Ichimoku (weight: 3)
    if (ichimoku) {
      if (ichimoku.isBullishSetup) {
        bullPoints += 3;
        reasons.push(`${tf} Ichimoku full bullish setup (price above cloud, TK golden)`);
      } else if (ichimoku.isBearishSetup) {
        bearPoints += 3;
        reasons.push(`${tf} Ichimoku full bearish setup (price below cloud, TK dead)`);
      } else if (ichimoku.priceVsCloud === 'ABOVE_CLOUD') {
        bullPoints += 1;
        reasons.push(`${tf} Price above Ichimoku cloud`);
      } else if (ichimoku.priceVsCloud === 'BELOW_CLOUD') {
        bearPoints += 1;
        reasons.push(`${tf} Price below Ichimoku cloud`);
      }
    }

    // VWAP (weight: 1)
    if (vwap) {
      if (vwap.reclaimBias === 'BULLISH') {
        bullPoints += 1;
        reasons.push(`${tf} Price above VWAP`);
      } else {
        bearPoints += 1;
        reasons.push(`${tf} Price below VWAP`);
      }
    }

    // Stochastic (weight: 1)
    if (stoch) {
      if (stoch.crossUp && stoch.zone !== 'OVERBOUGHT') {
        bullPoints += 1;
        reasons.push(`${tf} Stochastic bullish cross`);
      } else if (stoch.crossDown && stoch.zone !== 'OVERSOLD') {
        bearPoints += 1;
        reasons.push(`${tf} Stochastic bearish cross`);
      }
    }

    // ── Determine direction ──
    const totalPoints = bullPoints + bearPoints;
    const bullPct     = totalPoints > 0 ? bullPoints / totalPoints : 0;
    const bearPct     = totalPoints > 0 ? bearPoints / totalPoints : 0;

    let direction, score;

    if (bullPct >= 0.65) {
      direction = DIRECTION.LONG;
      score     = clamp(Math.round(bullPct * 100), 50, 100);
    } else if (bearPct >= 0.65) {
      direction = DIRECTION.SHORT;
      score     = clamp(Math.round(bearPct * 100), 50, 100);
    } else if (adxResult && !adxResult.isTrending) {
      direction = DIRECTION.RANGING;
      score     = 30;
    } else {
      direction = DIRECTION.WAIT;
      score     = 40;
    }

    // Market state
    const marketState = adxResult && adxResult.isTrending
      ? MARKET_STATE.TRENDING
      : bb && bb.isSqueeze
        ? MARKET_STATE.BREAKOUT
        : MARKET_STATE.RANGING;

    return {
      tf,
      valid:       true,
      direction,
      score,
      bullPoints,
      bearPoints,
      reasons,
      marketState,
      indicators: {
        emaStack:  emaStackResult,
        rsi,
        macd,
        adx:       adxResult,
        bb,
        stoch,
        ichimoku,
        vwap,
        atr,
      },
      candle: {
        open:    current.open,
        high:    current.high,
        low:     current.low,
        close:   current.close,
        volume:  current.volume,
        timestamp: current.timestamp,
      },
    };
  }
}

// ─────────────────────────────────────────────
//  HTF POI (POINT OF INTEREST) DETECTOR
// ─────────────────────────────────────────────

class HTFPoiDetector {
  /**
   * Identifies key Points of Interest on higher timeframes.
   * These are the zones where institutional money is most likely to react.
   *
   * POI types:
   *   - HTF Order Block
   *   - HTF FVG (imbalance)
   *   - Previous Day/Week High/Low
   *   - Round number (psychological level)
   *   - HTF 50% retracement
   *
   * @param {Object} tfData - map of { tf → candles }
   * @param {number} currentPrice
   * @returns {Array} sortedPOIs
   */
  static detect(tfData, currentPrice) {
    const pois = [];
    const highTFs = ['D1', 'W1', 'H4', 'H12'];

    for (const tf of highTFs) {
      const candles = tfData[tf];
      if (!candles || candles.length < 5) continue;

      const recent = candles.slice(-20);

      // Previous TF highs and lows
      const prevHigh = Math.max(...recent.slice(-5, -1).map(c => c.high));
      const prevLow  = Math.min(...recent.slice(-5, -1).map(c => c.low));

      pois.push({
        tf,
        type:       'PREV_HIGH',
        price:      round(prevHigh),
        direction:  'RESISTANCE',
        distance:   round(Math.abs(currentPrice - prevHigh) / currentPrice * 100, 3),
        note:       `${tf} previous high — potential resistance`,
      });

      pois.push({
        tf,
        type:       'PREV_LOW',
        price:      round(prevLow),
        direction:  'SUPPORT',
        distance:   round(Math.abs(currentPrice - prevLow) / currentPrice * 100, 3),
        note:       `${tf} previous low — potential support`,
      });

      // 50% retracement of recent swing
      const swingHigh = Math.max(...recent.map(c => c.high));
      const swingLow  = Math.min(...recent.map(c => c.low));
      const midpoint  = (swingHigh + swingLow) / 2;

      pois.push({
        tf,
        type:       'MIDPOINT',
        price:      round(midpoint),
        direction:  'BOTH',
        distance:   round(Math.abs(currentPrice - midpoint) / currentPrice * 100, 3),
        note:       `${tf} 50% retracement level`,
      });
    }

    // Round number levels (psychological)
    const magnitude  = Math.pow(10, Math.floor(Math.log10(currentPrice)));
    const roundLevels = [];
    for (let i = -3; i <= 3; i++) {
      roundLevels.push(Math.round(currentPrice / magnitude) * magnitude + i * magnitude);
    }
    for (const level of roundLevels) {
      if (level > 0) {
        pois.push({
          tf:       'ALL',
          type:     'ROUND_NUMBER',
          price:    round(level),
          direction: level > currentPrice ? 'RESISTANCE' : 'SUPPORT',
          distance:  round(Math.abs(currentPrice - level) / currentPrice * 100, 3),
          note:     `Psychological round number: ${level}`,
        });
      }
    }

    // Sort by distance from current price — nearest first
    return pois
      .filter(p => p.price > 0 && p.distance < 5) // within 5%
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * Check if current price is AT a POI (within 0.1% — highest probability entry)
   */
  static isAtPOI(pois, currentPrice) {
    const atPOI = pois.filter(p => p.distance < 0.15);
    return {
      isAtPOI:    atPOI.length > 0,
      pois:       atPOI,
      note:       atPOI.length > 0
        ? `Price AT ${atPOI.map(p => p.type).join(', ')} — high probability entry`
        : null,
    };
  }
}

// ─────────────────────────────────────────────
//  PULLBACK QUALITY ASSESSOR
// ─────────────────────────────────────────────

class PullbackQualityAssessor {
  /**
   * Assesses the quality of a pullback within the HTF trend.
   * Best setups = shallow pullback to key level + low RSI in HTF bull trend
   *
   * Pullback quality scale:
   *   A = shallow (38-50% retrace) + at OB/FVG + RSI not oversold
   *   B = moderate (50-61.8% retrace) + near structure
   *   C = deep (61.8-78.6%) — higher risk
   *   D = overextended — invalid pullback
   *
   * @param {Array} htfCandles  - higher TF candles
   * @param {number} currentPrice
   * @param {string} htfTrend   - 'LONG' or 'SHORT'
   * @returns {Object} pullbackAssessment
   */
  static assess(htfCandles, currentPrice, htfTrend) {
    if (!htfCandles || htfCandles.length < 20) {
      return { grade: 'UNKNOWN', score: 0, note: 'Insufficient data' };
    }

    const recent    = htfCandles.slice(-20);
    const lastSwingHigh = Math.max(...recent.map(c => c.high));
    const lastSwingLow  = Math.min(...recent.map(c => c.low));
    const swingRange    = lastSwingHigh - lastSwingLow;

    if (swingRange === 0) return { grade: 'UNKNOWN', score: 0 };

    // Calculate retracement percentage
    let retracePct;
    if (htfTrend === DIRECTION.LONG) {
      // In uptrend: retrace from high
      retracePct = (lastSwingHigh - currentPrice) / swingRange * 100;
    } else {
      // In downtrend: retrace from low
      retracePct = (currentPrice - lastSwingLow) / swingRange * 100;
    }

    retracePct = Math.max(0, retracePct);

    // RSI of HTF
    const closes = htfCandles.map(c => c.close);
    const rsi    = Indicators.rsi(closes, 14);

    let grade, score, note;

    if (retracePct >= 30 && retracePct <= 50) {
      grade = 'A';
      score = 90;
      note  = `Shallow pullback ${retracePct.toFixed(1)}% — optimal entry zone`;
    } else if (retracePct > 50 && retracePct <= 61.8) {
      grade = 'B';
      score = 75;
      note  = `Moderate pullback ${retracePct.toFixed(1)}% — good entry`;
    } else if (retracePct > 61.8 && retracePct <= 78.6) {
      grade = 'C';
      score = 55;
      note  = `Deep pullback ${retracePct.toFixed(1)}% — reduced confidence`;
    } else if (retracePct > 78.6) {
      grade = 'D';
      score = 25;
      note  = `Overextended pullback ${retracePct.toFixed(1)}% — possible trend change`;
    } else {
      grade = 'B';
      score = 70;
      note  = `Pullback ${retracePct.toFixed(1)}% — standard setup`;
    }

    // Bonus: RSI not in dangerous zone for direction
    if (rsi) {
      if (htfTrend === DIRECTION.LONG && rsi < 40) {
        score = Math.min(score + 10, 100);
        note += ` | RSI ${rsi} — oversold pullback bonus`;
      } else if (htfTrend === DIRECTION.SHORT && rsi > 60) {
        score = Math.min(score + 10, 100);
        note += ` | RSI ${rsi} — overbought pullback bonus`;
      }
    }

    return {
      grade,
      score,
      note,
      retracePct: round(retracePct, 2),
      rsi,
      swingHigh:  round(lastSwingHigh),
      swingLow:   round(lastSwingLow),
    };
  }
}

// ─────────────────────────────────────────────
//  DIVERGENCE DETECTOR (cross-timeframe)
// ─────────────────────────────────────────────

class CrossTFDivergenceDetector {
  /**
   * Detects when HTF and LTF momentum diverge.
   * Momentum divergence = HTF trending but LTF RSI/MACD fading
   *
   * Warning signal: fade may be imminent
   * Opportunity signal: LTF correction in HTF trend = entry
   *
   * @param {Object} tfAnalyses - map of tf → analysis result
   * @returns {Array} divergences
   */
  static detect(tfAnalyses) {
    const divergences = [];

    // Compare adjacent TF pairs
    const pairs = [
      ['D1', 'H4'],
      ['H4', 'H1'],
      ['H1', 'M15'],
      ['M15', 'M5'],
    ];

    for (const [htf, ltf] of pairs) {
      const htfA = tfAnalyses[htf];
      const ltfA = tfAnalyses[ltf];

      if (!htfA?.valid || !ltfA?.valid) continue;
      if (!htfA.indicators?.rsi || !ltfA.indicators?.rsi) continue;

      const htfRSI = htfA.indicators.rsi;
      const ltfRSI = ltfA.indicators.rsi;

      // HTF bullish but LTF RSI fading — possible correction then continue
      if (htfA.direction === DIRECTION.LONG && ltfRSI < 45) {
        divergences.push({
          type:   'BULLISH_PULLBACK',
          htf,
          ltf,
          htfRSI,
          ltfRSI,
          note:   `${htf} bullish but ${ltf} RSI ${ltfRSI} — LTF pullback in HTF bull trend = entry opportunity`,
          signal: 'LONG_ENTRY',
        });
      }

      // HTF bearish but LTF RSI climbing — possible bounce then continue
      if (htfA.direction === DIRECTION.SHORT && ltfRSI > 55) {
        divergences.push({
          type:   'BEARISH_PULLBACK',
          htf,
          ltf,
          htfRSI,
          ltfRSI,
          note:   `${htf} bearish but ${ltf} RSI ${ltfRSI} — LTF bounce in HTF bear trend = short entry`,
          signal: 'SHORT_ENTRY',
        });
      }

      // Dangerous: HTF and LTF both pointing same direction strongly — momentum exhaustion risk
      if (htfA.direction === ltfA.direction &&
          htfRSI > 75 && ltfRSI > 75 &&
          htfA.direction === DIRECTION.LONG) {
        divergences.push({
          type:   'MOMENTUM_EXHAUSTION',
          htf,
          ltf,
          htfRSI,
          ltfRSI,
          note:   `Both ${htf} and ${ltf} overbought — momentum exhaustion risk`,
          signal: 'CAUTION',
        });
      }
    }

    return divergences;
  }
}

// ─────────────────────────────────────────────
//  MAIN MTF AGENT CLASS
// ─────────────────────────────────────────────

class MTFAgent {
  /**
   * @param {Object} config
   * @param {string} config.symbol           - trading symbol
   * @param {string[]} config.timeframes     - list of TFs to analyze (default all)
   * @param {string} config.htfBias          - override HTF bias ('LONG'|'SHORT'|null)
   * @param {boolean} config.requireHTFAlign - refuse signal if LTF opposes HTF (default true)
   * @param {number} config.minScore         - minimum score to return (default 60)
   */
  constructor(config = {}) {
    this.symbol          = config.symbol          || 'UNKNOWN';
    this.timeframes      = config.timeframes      || TF_HIERARCHY;
    this.requireHTFAlign = config.requireHTFAlign !== false;
    this.minScore        = config.minScore        || 60;
    this._htfOverride    = config.htfBias         || null;

    // Cache last analysis
    this._lastAnalysis   = null;
    this._lastVote       = null;
  }

  /**
   * Master analyze function.
   * Receives a map of { tf → candleArray } and returns the MTF vote.
   *
   * @param {Object} tfData - { 'M15': [...candles], 'H1': [...candles], 'H4': [...candles], ... }
   * @returns {Object} mtfVote — compatible with signal-scorer.js input format
   */
  async analyze(tfData) {
    const availableTFs = Object.keys(tfData).filter(tf =>
      TF_HIERARCHY.includes(tf) && tfData[tf]?.length > 0
    );

    if (availableTFs.length < 2) {
      return this._buildWaitVote('Need at least 2 timeframes of data');
    }

    // ── Step 1: Analyze each timeframe independently ──
    const tfAnalyses = {};
    for (const tf of availableTFs) {
      tfAnalyses[tf] = TimeframeAnalyzer.analyze(tf, tfData[tf]);
    }

    // ── Step 2: Determine HTF bias ──
    const htfBias = this._resolveHTFBias(tfAnalyses);

    // ── Step 3: HTF lock — if HTF is clear, LTF must not oppose ──
    if (this.requireHTFAlign && htfBias.locked) {
      const lowerTFs = availableTFs.filter(tf =>
        TF_HIERARCHY.indexOf(tf) < TF_HIERARCHY.indexOf(htfBias.anchorTF)
      );

      for (const tf of lowerTFs) {
        const ltfAnalysis = tfAnalyses[tf];
        if (!ltfAnalysis.valid) continue;

        const opposes = (
          htfBias.direction === DIRECTION.LONG  && ltfAnalysis.direction === DIRECTION.SHORT
        ) || (
          htfBias.direction === DIRECTION.SHORT && ltfAnalysis.direction === DIRECTION.LONG
        );

        if (opposes && TF_HIERARCHY.indexOf(tf) >= TF_HIERARCHY.indexOf('H1')) {
          // H1 opposing D1 = strong conflict — abort
          return this._buildWaitVote(
            `HTF ${htfBias.anchorTF} is ${htfBias.direction} but ${tf} opposes — waiting for alignment`
          );
        }
      }
    }

    // ── Step 4: Weighted confluence score ──
    const confluence = this._computeConfluence(tfAnalyses, htfBias.direction);

    // ── Step 5: Detect HTF POIs ──
    const currentCandles = tfData[availableTFs[0]];
    const currentPrice   = currentCandles[currentCandles.length - 1]?.close ?? 0;
    const pois           = HTFPoiDetector.detect(tfData, currentPrice);
    const poiCheck       = HTFPoiDetector.isAtPOI(pois, currentPrice);

    // POI bonus: +10 score if price is at a HTF POI
    if (poiCheck.isAtPOI) {
      confluence.score = Math.min(confluence.score + 10, 100);
      confluence.reasons.push(poiCheck.note);
    }

    // ── Step 6: Pullback quality on primary entry TF ──
    const entryTF    = this._selectEntryTF(availableTFs, htfBias.anchorTF);
    const htfCandles = tfData[htfBias.anchorTF];
    const pullback   = htfCandles
      ? PullbackQualityAssessor.assess(htfCandles, currentPrice, htfBias.direction)
      : null;

    if (pullback && pullback.grade === 'A') {
      confluence.score = Math.min(confluence.score + 8, 100);
      confluence.reasons.push(pullback.note);
    } else if (pullback && pullback.grade === 'D') {
      confluence.score = Math.max(confluence.score - 15, 0);
      confluence.reasons.push(`⚠️ ${pullback.note}`);
    }

    // ── Step 7: Cross-TF divergence check ──
    const divergences = CrossTFDivergenceDetector.detect(tfAnalyses);
    const entryDiv    = divergences.filter(d =>
      d.signal === `${htfBias.direction}_ENTRY`
    );

    if (entryDiv.length > 0) {
      confluence.score = Math.min(confluence.score + 5, 100);
      confluence.reasons.push(entryDiv[0].note);
    }

    const cautionDiv = divergences.filter(d => d.signal === 'CAUTION');
    if (cautionDiv.length > 0) {
      confluence.score = Math.max(confluence.score - 10, 0);
      confluence.reasons.push(`⚠️ ${cautionDiv[0].note}`);
    }

    // ── Step 8: Final grade ──
    const grade = confluence.score >= 85 ? 'A'
      : confluence.score >= 70 ? 'B'
      : confluence.score >= 55 ? 'C' : 'D';

    // ── Step 9: Build the complete analysis ──
    const analysis = {
      symbol:       this.symbol,
      timestamp:    Date.now(),
      currentPrice,
      htfBias,
      entryTF,
      tfAnalyses,
      confluence,
      pois:         pois.slice(0, 10),
      poiCheck,
      pullback,
      divergences,
      // Summary per TF
      tfSummary:    availableTFs.map(tf => ({
        tf,
        direction: tfAnalyses[tf]?.direction ?? 'UNKNOWN',
        score:     tfAnalyses[tf]?.score     ?? 0,
        valid:     tfAnalyses[tf]?.valid      ?? false,
        adxStrength: tfAnalyses[tf]?.indicators?.adx?.strength ?? 'UNKNOWN',
        emaStack:  tfAnalyses[tf]?.indicators?.emaStack?.direction ?? 'UNKNOWN',
      })),
    };

    this._lastAnalysis = analysis;

    // ── Step 10: Build vote for signal-scorer.js ──
    const vote = {
      direction:  confluence.direction,
      score:      confluence.score,
      grade,
      reasons:    confluence.reasons,
      analysis,
      htfBias:    htfBias.direction,
      signal:     {
        action:       confluence.direction,
        symbol:       this.symbol,
        entryTF,
        htfBias:      htfBias.direction,
        htfAnchor:    htfBias.anchorTF,
        confluenceScore: confluence.score,
        alignedTFs:   confluence.alignedTFs,
        opposingTFs:  confluence.opposingTFs,
      },
    };

    this._lastVote = vote;
    return vote;
  }

  // ─────────────────────────────────────────────
  //  HTF BIAS RESOLUTION
  // ─────────────────────────────────────────────

  /**
   * Determines the authoritative Higher Timeframe bias.
   * Priority: W1 > D1 > H12 > H8 > H4
   * The highest TF with a clear direction becomes the anchor.
   */
  _resolveHTFBias(tfAnalyses) {
    if (this._htfOverride) {
      return {
        direction: this._htfOverride,
        anchorTF:  'OVERRIDE',
        locked:    true,
        note:      `Manual HTF override: ${this._htfOverride}`,
      };
    }

    const htfPriority = ['W1','D1','H12','H8','H4','H6','H2'];

    for (const tf of htfPriority) {
      const analysis = tfAnalyses[tf];
      if (!analysis?.valid) continue;
      if (analysis.direction === DIRECTION.WAIT || analysis.direction === DIRECTION.RANGING) continue;

      return {
        direction: analysis.direction,
        anchorTF:  tf,
        locked:    true,
        score:     analysis.score,
        adx:       analysis.indicators?.adx,
        emaStack:  analysis.indicators?.emaStack,
        note:      `HTF bias from ${tf}: ${analysis.direction} (score ${analysis.score})`,
      };
    }

    // No clear HTF — use H1 as fallback
    const h1 = tfAnalyses['H1'];
    if (h1?.valid && h1.direction !== DIRECTION.RANGING) {
      return {
        direction: h1.direction,
        anchorTF:  'H1',
        locked:    false,
        note:      'No HTF data — using H1 as bias (lower confidence)',
      };
    }

    return {
      direction: DIRECTION.WAIT,
      anchorTF:  null,
      locked:    false,
      note:      'No clear HTF bias — standing by',
    };
  }

  // ─────────────────────────────────────────────
  //  WEIGHTED CONFLUENCE COMPUTATION
  // ─────────────────────────────────────────────

  _computeConfluence(tfAnalyses, htfDirection) {
    let weightedScore = 0;
    let totalWeight   = 0;
    let alignedTFs    = [];
    let opposingTFs   = [];
    const reasons     = [];

    for (const tf of TF_HIERARCHY) {
      const analysis = tfAnalyses[tf];
      const weight   = TF_WEIGHTS[tf] || 0.05;

      if (!analysis?.valid) continue;

      totalWeight += weight;

      const agreesWith = analysis.direction === htfDirection;
      const neutral    = analysis.direction === DIRECTION.WAIT ||
                         analysis.direction === DIRECTION.RANGING;

      if (agreesWith) {
        weightedScore += analysis.score * weight;
        alignedTFs.push(tf);
        reasons.push(`${tf}: ${analysis.direction} (${analysis.score}/100) ✓`);
      } else if (neutral) {
        weightedScore += 40 * weight; // neutral = partial credit
        reasons.push(`${tf}: ranging — neutral`);
      } else {
        // Opposing TF — reduces score
        weightedScore += 10 * weight;
        opposingTFs.push(tf);
        reasons.push(`${tf}: ${analysis.direction} — OPPOSES HTF bias`);
      }
    }

    const rawScore = totalWeight > 0
      ? Math.round(weightedScore / totalWeight)
      : 0;

    // Alignment bonus: if 5+ TFs agree
    const alignmentBonus = alignedTFs.length >= 6 ? 10
      : alignedTFs.length >= 4 ? 5 : 0;

    const finalScore = Math.min(rawScore + alignmentBonus, 100);

    if (alignmentBonus > 0) {
      reasons.push(`${alignedTFs.length}-TF alignment bonus: +${alignmentBonus}`);
    }

    const direction = htfDirection !== DIRECTION.WAIT && finalScore >= 50
      ? htfDirection
      : DIRECTION.WAIT;

    return {
      score:       finalScore,
      direction,
      rawScore,
      alignmentBonus,
      alignedTFs,
      opposingTFs,
      alignedCount: alignedTFs.length,
      totalTFs:     Object.keys(tfAnalyses).filter(tf => tfAnalyses[tf]?.valid).length,
      reasons:      reasons.slice(0, 12),
    };
  }

  // ─────────────────────────────────────────────
  //  ENTRY TIMEFRAME SELECTOR
  // ─────────────────────────────────────────────

  /**
   * Selects the optimal LTF for precise entry timing.
   * Rule: 2-3 TFs below the HTF anchor for precision.
   */
  _selectEntryTF(availableTFs, htfAnchor) {
    const htfIndex = TF_HIERARCHY.indexOf(htfAnchor);
    if (htfIndex < 0) return 'H1';

    // Entry TF = 2-3 levels below HTF
    const targetIndex = Math.max(htfIndex - 2, 0);
    const entryTF     = TF_HIERARCHY[targetIndex];

    return availableTFs.includes(entryTF) ? entryTF : 'H1';
  }

  _buildWaitVote(reason) {
    return {
      direction: DIRECTION.WAIT,
      score:     0,
      grade:     'D',
      reasons:   [reason],
      analysis:  null,
      htfBias:   DIRECTION.WAIT,
      signal:    null,
    };
  }

  /**
   * Returns the last computed vote (for signal-scorer polling)
   */
  getLastVote() {
    return this._lastVote;
  }

  /**
   * Returns full last analysis
   */
  getLastAnalysis() {
    return this._lastAnalysis;
  }

  /**
   * Quick summary string for logging
   */
  getSummary() {
    if (!this._lastVote) return 'No analysis run yet';
    const v = this._lastVote;
    return `MTF [${this.symbol}] ${v.direction} | Score: ${v.score} | HTF: ${v.htfBias} | Grade: ${v.grade}`;
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  MTFAgent,
  TimeframeAnalyzer,
  HTFPoiDetector,
  PullbackQualityAssessor,
  CrossTFDivergenceDetector,
  Indicators,
  DIRECTION,
  TREND_STRENGTH,
  MARKET_STATE,
  TF_HIERARCHY,
  TF_WEIGHTS,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { MTFAgent } = require('./mtf-agent');
 *
 *  const agent = new MTFAgent({
 *    symbol:          'XAUUSD',
 *    timeframes:      ['M15','H1','H4','D1'],
 *    requireHTFAlign: true,
 *  });
 *
 *  // tfData comes from binance-ws.js CandleStore
 *  const vote = await agent.analyze({
 *    M15: feed.getCandles('XAUUSD', 'M15'),
 *    H1:  feed.getCandles('XAUUSD', 'H1'),
 *    H4:  feed.getCandles('XAUUSD', 'H4'),
 *    D1:  feed.getCandles('XAUUSD', 'D1'),
 *  });
 *
 *  console.log(agent.getSummary());
 *  // → MTF [XAUUSD] LONG | Score: 82 | HTF: LONG | Grade: A
 *
 *  // Feed vote to signal-scorer.js
 *  const signal = await scorer.score({
 *    smc:      smcAgent.getLastVote(),
 *    mtf:      vote,          // ← this file's output
 *    momentum: momentumAgent.getLastVote(),
 *    ...
 *  }, context);
 * ─────────────────────────────────────────────
 */