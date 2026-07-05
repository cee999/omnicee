'use strict';

/**
 * MOMENTUM AGENT — RSI, MACD, EMA, VWAP, Ichimoku
 * Output: { direction, score, grade, reasons, analysis }
 * Compatible with signal-scorer.js agentVotes.momentum
 */

const EventEmitter = require('events');

// ── Constants ──────────────────────────────────────────────────────────────

const DIRECTION = { LONG: 'LONG', SHORT: 'SHORT', WAIT: 'WAIT' };

const GRADE = { A: 'A', B: 'B', C: 'C' };

// RSI
const RSI_OVERSOLD      = 30;
const RSI_OVERBOUGHT    = 70;
const RSI_MILD_OS       = 40;
const RSI_MILD_OB       = 60;
const RSI_PERIOD        = 14;

// MACD defaults
const MACD_FAST         = 12;
const MACD_SLOW         = 26;
const MACD_SIGNAL       = 9;

// EMA periods
const EMA_FAST          = 9;
const EMA_MED           = 21;
const EMA_SLOW          = 50;
const EMA_TREND         = 200;

// VWAP
const VWAP_BAND_MULT    = 1.0;   // ± 1 std dev for bands

// Ichimoku
const TENKAN_PERIOD     = 9;
const KIJUN_PERIOD      = 26;
const SENKOU_B_PERIOD   = 52;
const DISPLACEMENT      = 26;

// ── Utility math ───────────────────────────────────────────────────────────

function _round(n, d = 4) { return parseFloat((+n).toFixed(d)); }
function _avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

function _ema(prices, period) {
  if (prices.length < period) return null;
  const k   = 2 / (period + 1);
  let  ema  = _avg(prices.slice(0, period));
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return _round(ema);
}

function _sma(prices, period) {
  if (prices.length < period) return null;
  return _round(_avg(prices.slice(-period)));
}

function _rsi(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return (avgGain === 0 ? 50 : 100);
  const rs = avgGain / avgLoss;
  return _round(100 - 100 / (1 + rs));
}

function _atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1);
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    sum += tr;
  }
  return _round(sum / period);
}

// ── RSI Engine ─────────────────────────────────────────────────────────────

class RSIEngine {
  compute(closes, period = RSI_PERIOD) {
    const rsi = _rsi(closes, period);
    if (rsi === null) return null;

    // Divergence: last 5 candles
    const divergence = this._divergence(closes, period);

    let direction = DIRECTION.WAIT;
    let score     = 50;
    const reasons = [];

    if (rsi <= RSI_OVERSOLD) {
      direction = DIRECTION.LONG;
      score     = 80;
      reasons.push(`RSI oversold (${rsi}) — strong reversal zone`);
    } else if (rsi >= RSI_OVERBOUGHT) {
      direction = DIRECTION.SHORT;
      score     = 80;
      reasons.push(`RSI overbought (${rsi}) — strong reversal zone`);
    } else if (rsi <= RSI_MILD_OS) {
      direction = DIRECTION.LONG;
      score     = 60;
      reasons.push(`RSI in mild oversold (${rsi})`);
    } else if (rsi >= RSI_MILD_OB) {
      direction = DIRECTION.SHORT;
      score     = 60;
      reasons.push(`RSI in mild overbought (${rsi})`);
    } else if (rsi > 50) {
      direction = DIRECTION.LONG;
      score     = 52;
      reasons.push(`RSI above 50 midline — mild bullish momentum`);
    } else {
      direction = DIRECTION.SHORT;
      score     = 52;
      reasons.push(`RSI below 50 midline — mild bearish momentum`);
    }

    if (divergence.type === 'BULLISH_DIVERGENCE') {
      if (direction !== DIRECTION.LONG) score -= 15;
      else score = Math.min(100, score + 15);
      reasons.push('✅ Bullish RSI divergence detected');
    } else if (divergence.type === 'BEARISH_DIVERGENCE') {
      if (direction !== DIRECTION.SHORT) score -= 15;
      else score = Math.min(100, score + 15);
      reasons.push('✅ Bearish RSI divergence detected');
    }

    return { rsi, direction, score, reasons, divergence };
  }

  _divergence(closes, period) {
    if (closes.length < period + 10) return { type: 'NONE' };

    const recent   = closes.slice(-10);
    const prices   = recent;
    const rsiVals  = recent.map((_, i) =>
      _rsi(closes.slice(0, closes.length - 10 + i + 1), period)
    ).filter(Boolean);

    if (rsiVals.length < 6) return { type: 'NONE' };

    const priceH1  = Math.max(...prices.slice(0, 5));
    const priceH2  = Math.max(...prices.slice(5));
    const rsiH1    = Math.max(...rsiVals.slice(0, 5));
    const rsiH2    = Math.max(...rsiVals.slice(5));

    const priceL1  = Math.min(...prices.slice(0, 5));
    const priceL2  = Math.min(...prices.slice(5));
    const rsiL1    = Math.min(...rsiVals.slice(0, 5));
    const rsiL2    = Math.min(...rsiVals.slice(5));

    if (priceH2 > priceH1 && rsiH2 < rsiH1) return { type: 'BEARISH_DIVERGENCE' };
    if (priceL2 < priceL1 && rsiL2 > rsiL1) return { type: 'BULLISH_DIVERGENCE' };
    return { type: 'NONE' };
  }
}

// ── MACD Engine ────────────────────────────────────────────────────────────

class MACDEngine {
  compute(closes, fast = MACD_FAST, slow = MACD_SLOW, signal = MACD_SIGNAL) {
    if (closes.length < slow + signal) return null;

    const emaFast   = _ema(closes, fast);
    const emaSlow   = _ema(closes, slow);
    if (emaFast === null || emaSlow === null) return null;

    const macdLine  = _round(emaFast - emaSlow);

    // Compute signal line from macd history
    const macdHistory = [];
    for (let i = slow; i <= closes.length; i++) {
      const f = _ema(closes.slice(0, i), fast);
      const s = _ema(closes.slice(0, i), slow);
      if (f !== null && s !== null) macdHistory.push(_round(f - s));
    }

    const signalLine = macdHistory.length >= signal ? _ema(macdHistory, signal) : null;
    const histogram  = signalLine !== null ? _round(macdLine - signalLine) : null;

    // Histogram trend (last 3 bars)
    const histTrend = macdHistory.length >= signal + 3
      ? macdHistory.slice(-3).map((v, i, arr) => i === 0 ? 0 : v - arr[i - 1])
      : [];

    let direction = DIRECTION.WAIT;
    let score     = 50;
    const reasons = [];

    if (histogram !== null) {
      if (macdLine > 0 && histogram > 0) {
        direction = DIRECTION.LONG;
        score     = histogram > 0 && histTrend.some(v => v > 0) ? 72 : 62;
        reasons.push(`MACD bullish — line above zero (${macdLine}), positive histogram`);
      } else if (macdLine < 0 && histogram < 0) {
        direction = DIRECTION.SHORT;
        score     = histogram < 0 && histTrend.some(v => v < 0) ? 72 : 62;
        reasons.push(`MACD bearish — line below zero (${macdLine}), negative histogram`);
      } else if (macdLine > 0 && histogram < 0) {
        direction = DIRECTION.SHORT;
        score     = 55;
        reasons.push(`MACD bearish crossover forming — histogram turning negative`);
      } else if (macdLine < 0 && histogram > 0) {
        direction = DIRECTION.LONG;
        score     = 55;
        reasons.push(`MACD bullish crossover forming — histogram turning positive`);
      }
    }

    return { macdLine, signalLine, histogram, direction, score, reasons };
  }
}

// ── EMA Stack Engine ───────────────────────────────────────────────────────

class EMAStackEngine {
  compute(closes) {
    const fast   = _ema(closes, EMA_FAST);
    const med    = _ema(closes, EMA_MED);
    const slow   = _ema(closes, EMA_SLOW);
    const trend  = _ema(closes, EMA_TREND);
    const price  = closes[closes.length - 1];

    const available = [fast, med, slow, trend].filter(Boolean);
    if (available.length < 2) return null;

    let direction = DIRECTION.WAIT;
    let score     = 50;
    const reasons = [];

    // Perfect bull stack: fast > med > slow > trend, price > all
    const bullStack = fast && med && slow && fast > med && med > slow;
    const bearStack = fast && med && slow && fast < med && med < slow;

    if (bullStack && trend && price > trend) {
      direction = DIRECTION.LONG;
      score     = 78;
      reasons.push(`Perfect EMA bull stack: EMA${EMA_FAST} > EMA${EMA_MED} > EMA${EMA_SLOW} > EMA${EMA_TREND}`);
    } else if (bearStack && trend && price < trend) {
      direction = DIRECTION.SHORT;
      score     = 78;
      reasons.push(`Perfect EMA bear stack: EMA${EMA_FAST} < EMA${EMA_MED} < EMA${EMA_SLOW} < EMA${EMA_TREND}`);
    } else if (bullStack) {
      direction = DIRECTION.LONG;
      score     = 62;
      reasons.push(`EMA bull stack (fast>med>slow) without 200 confirmation`);
    } else if (bearStack) {
      direction = DIRECTION.SHORT;
      score     = 62;
      reasons.push(`EMA bear stack (fast<med<slow) without 200 confirmation`);
    } else if (fast && med) {
      if (fast > med) { direction = DIRECTION.LONG;  score = 54; reasons.push(`EMA fast above med — mild bullish`); }
      else            { direction = DIRECTION.SHORT; score = 54; reasons.push(`EMA fast below med — mild bearish`); }
    }

    // Price relative to EMA200
    if (trend) {
      if (price > trend) reasons.push(`Price above EMA200 — long-term uptrend`);
      else               reasons.push(`Price below EMA200 — long-term downtrend`);
    }

    return { fast, med, slow, trend, price, direction, score, reasons };
  }
}

// ── VWAP Engine ────────────────────────────────────────────────────────────

class VWAPEngine {
  compute(candles) {
    if (candles.length < 5) return null;

    // Use today's session candles only (reset at midnight UTC)
    const now  = Date.now();
    const midnight = now - (now % 86400000);
    const session  = candles.filter(c => c.timestamp >= midnight);
    const data     = session.length >= 5 ? session : candles.slice(-30);

    let cumTPV = 0, cumVol = 0;
    const prices = [];
    for (const c of data) {
      const tp = (c.high + c.low + c.close) / 3;
      cumTPV  += tp * (c.volume || 1);
      cumVol  += (c.volume || 1);
      prices.push(tp);
    }
    const vwap    = _round(cumTPV / cumVol);
    const price   = candles[candles.length - 1].close;
    const std     = Math.sqrt(_avg(prices.map(p => Math.pow(p - vwap, 2))));
    const upper   = _round(vwap + std * VWAP_BAND_MULT);
    const lower   = _round(vwap - std * VWAP_BAND_MULT);
    const distPct = _round((price - vwap) / vwap * 100, 3);

    let direction = DIRECTION.WAIT;
    let score     = 50;
    const reasons = [];

    if (price > upper) {
      direction = DIRECTION.SHORT;
      score     = 65;
      reasons.push(`Price above VWAP upper band (${upper}) — extended, mean-reversion risk`);
    } else if (price < lower) {
      direction = DIRECTION.LONG;
      score     = 65;
      reasons.push(`Price below VWAP lower band (${lower}) — oversold vs VWAP`);
    } else if (price > vwap) {
      direction = DIRECTION.LONG;
      score     = 58;
      reasons.push(`Price above VWAP (${vwap}) — bullish intraday bias`);
    } else {
      direction = DIRECTION.SHORT;
      score     = 58;
      reasons.push(`Price below VWAP (${vwap}) — bearish intraday bias`);
    }

    return { vwap, upper, lower, price, distPct, direction, score, reasons };
  }
}

// ── Ichimoku Engine ────────────────────────────────────────────────────────

class IchimokuEngine {
  _midpoint(candles, period) {
    const slice = candles.slice(-period);
    const high  = Math.max(...slice.map(c => c.high));
    const low   = Math.min(...slice.map(c => c.low));
    return _round((high + low) / 2);
  }

  compute(candles) {
    if (candles.length < SENKOU_B_PERIOD + DISPLACEMENT) return null;

    const tenkan   = this._midpoint(candles, TENKAN_PERIOD);
    const kijun    = this._midpoint(candles, KIJUN_PERIOD);
    const senkouA  = _round((tenkan + kijun) / 2);

    const senkouBSlice = candles.slice(-SENKOU_B_PERIOD - DISPLACEMENT, -DISPLACEMENT);
    const senkouB  = senkouBSlice.length >= SENKOU_B_PERIOD
      ? _round((Math.max(...senkouBSlice.map(c => c.high)) + Math.min(...senkouBSlice.map(c => c.low))) / 2)
      : null;

    const price    = candles[candles.length - 1].close;
    const cloudTop    = senkouB ? Math.max(senkouA, senkouB) : senkouA;
    const cloudBottom = senkouB ? Math.min(senkouA, senkouB) : senkouA;

    let direction = DIRECTION.WAIT;
    let score     = 50;
    const reasons = [];

    const aboveCloud = price > cloudTop;
    const belowCloud = price < cloudBottom;
    const inCloud    = !aboveCloud && !belowCloud;
    const tkCross    = tenkan > kijun;

    if (aboveCloud && tkCross) {
      direction = DIRECTION.LONG;
      score     = 76;
      reasons.push(`Price above Kumo cloud + Tenkan/Kijun bullish cross — strong bull setup`);
    } else if (belowCloud && !tkCross) {
      direction = DIRECTION.SHORT;
      score     = 76;
      reasons.push(`Price below Kumo cloud + Tenkan/Kijun bearish cross — strong bear setup`);
    } else if (aboveCloud) {
      direction = DIRECTION.LONG;
      score     = 62;
      reasons.push(`Price above Kumo — bullish Ichimoku bias`);
    } else if (belowCloud) {
      direction = DIRECTION.SHORT;
      score     = 62;
      reasons.push(`Price below Kumo — bearish Ichimoku bias`);
    } else {
      direction = DIRECTION.WAIT;
      score     = 40;
      reasons.push(`Price inside Kumo cloud — congestion zone, low probability`);
    }

    return { tenkan, kijun, senkouA, senkouB, cloudTop, cloudBottom, price, direction, score, reasons };
  }
}

// ── Bollinger Bands ────────────────────────────────────────────────────────

class BollingerEngine {
  compute(closes, period = 20, mult = 2) {
    if (closes.length < period) return null;
    const slice  = closes.slice(-period);
    const sma    = _round(_avg(slice));
    const std    = Math.sqrt(_avg(slice.map(p => Math.pow(p - sma, 2))));
    const upper  = _round(sma + std * mult);
    const lower  = _round(sma - std * mult);
    const price  = closes[closes.length - 1];
    const bWidth = _round((upper - lower) / sma * 100, 3);  // bandwidth %
    const pctB   = _round((price - lower) / (upper - lower), 3);

    let direction = DIRECTION.WAIT;
    let score     = 50;
    const reasons = [];

    if (price <= lower) {
      direction = DIRECTION.LONG;
      score     = 68;
      reasons.push(`Price at/below BB lower band — mean-reversion long setup`);
    } else if (price >= upper) {
      direction = DIRECTION.SHORT;
      score     = 68;
      reasons.push(`Price at/above BB upper band — mean-reversion short setup`);
    } else if (pctB > 0.5) {
      direction = DIRECTION.LONG;
      score     = 52;
      reasons.push(`Price in upper BB half — mild bullish bias`);
    } else {
      direction = DIRECTION.SHORT;
      score     = 52;
      reasons.push(`Price in lower BB half — mild bearish bias`);
    }

    if (bWidth < 1.5) reasons.push(`BB squeeze detected — breakout imminent (bWidth: ${bWidth}%)`);
    else if (bWidth > 5) reasons.push(`BB expansion — strong trend/volatility`);

    return { upper, lower, sma, bWidth, pctB, price, direction, score, reasons };
  }
}

// ── Main MomentumAgent ─────────────────────────────────────────────────────

class MomentumAgent extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string} config.symbol
   * @param {string} config.timeframe
   * @param {number} [config.rsiPeriod=14]
   */
  constructor(config = {}) {
    super();
    this.symbol    = config.symbol    || 'UNKNOWN';
    this.timeframe = config.timeframe || 'H1';
    this.rsiPeriod = config.rsiPeriod || RSI_PERIOD;

    this._rsi     = new RSIEngine();
    this._macd    = new MACDEngine();
    this._ema     = new EMAStackEngine();
    this._vwap    = new VWAPEngine();
    this._ichi    = new IchimokuEngine();
    this._bb      = new BollingerEngine();

    this._lastVote = null;
  }

  /**
   * Primary analyze method.
   * @param {Array} candles  - [{open,high,low,close,volume,timestamp}, ...]
   * @returns {Object}       - { direction, score, grade, reasons, analysis }
   */
  async analyze(candles) {
    if (!candles || candles.length < 30) {
      return this._waitVote('Insufficient candle data (need ≥30)');
    }

    const closes = candles.map(c => c.close);

    // Run all sub-engines
    const rsi  = this._rsi.compute(closes, this.rsiPeriod);
    const macd = this._macd.compute(closes);
    const ema  = this._ema.compute(closes);
    const vwap = this._vwap.compute(candles);
    const ichi = this._ichi.compute(candles);
    const bb   = this._bb.compute(closes);

    // Collect votes + scores from each sub-engine
    const subVotes = [rsi, macd, ema, vwap, ichi, bb].filter(Boolean);
    if (subVotes.length === 0) return this._waitVote('No indicators computed');

    // Weighted vote aggregation
    const weights = { rsi: 1.5, macd: 1.5, ema: 2.0, vwap: 1.0, ichi: 1.5, bb: 1.0 };
    const labels  = ['rsi', 'macd', 'ema', 'vwap', 'ichi', 'bb'];
    const engines = [rsi, macd, ema, vwap, ichi, bb];

    let longWeight  = 0;
    let shortWeight = 0;
    let waitWeight  = 0;
    let totalWeight = 0;
    const allReasons = [];

    for (let i = 0; i < engines.length; i++) {
      const e = engines[i];
      if (!e) continue;
      const w = weights[labels[i]] || 1.0;
      totalWeight += w;
      if (e.direction === DIRECTION.LONG)  longWeight  += w;
      else if (e.direction === DIRECTION.SHORT) shortWeight += w;
      else waitWeight += w;
      allReasons.push(...(e.reasons || []));
    }

    const longPct  = longWeight  / totalWeight;
    const shortPct = shortWeight / totalWeight;

    let direction, score;

    if (longPct >= 0.55) {
      direction = DIRECTION.LONG;
      score = _round(50 + (longPct - 0.5) * 100);
    } else if (shortPct >= 0.55) {
      direction = DIRECTION.SHORT;
      score = _round(50 + (shortPct - 0.5) * 100);
    } else {
      // Mixed — use score from highest-weight engine
      const dominant = engines
        .map((e, i) => ({ e, w: weights[labels[i]] || 1 }))
        .filter(x => x.e)
        .sort((a, b) => b.w - a.w)[0];
      direction = dominant?.e?.direction || DIRECTION.WAIT;
      score = dominant?.e?.score || 45;
    }

    score = Math.min(100, Math.max(0, score));

    // ATR for volatility context
    const atr = _atr(candles);

    const vote = {
      direction,
      score,
      grade: score >= 80 ? GRADE.A : score >= 65 ? GRADE.B : GRADE.C,
      reasons: allReasons.slice(0, 8),
      analysis: {
        rsi:   rsi  ? { value: rsi.rsi,  direction: rsi.direction  } : null,
        macd:  macd ? { line: macd.macdLine, hist: macd.histogram, direction: macd.direction } : null,
        ema:   ema  ? { fast: ema.fast, med: ema.med, slow: ema.slow, trend: ema.trend, direction: ema.direction } : null,
        vwap:  vwap ? { vwap: vwap.vwap, price: vwap.price, direction: vwap.direction } : null,
        ichi:  ichi ? { tenkan: ichi.tenkan, kijun: ichi.kijun, direction: ichi.direction } : null,
        bb:    bb   ? { upper: bb.upper, lower: bb.lower, bWidth: bb.bWidth, direction: bb.direction } : null,
        atr,
        symbol:    this.symbol,
        timeframe: this.timeframe,
        timestamp: Date.now(),
      },
    };

    this._lastVote = vote;
    this.emit('vote', vote);
    return vote;
  }

  getLastVote() { return this._lastVote; }

  getSummary() {
    const v = this._lastVote;
    if (!v) return `MomentumAgent [${this.symbol}] — no analysis yet`;
    return `MomentumAgent [${this.symbol}] ${v.direction} | Score: ${v.score} | Grade: ${v.grade}`;
  }

  _waitVote(reason) {
    return {
      direction: DIRECTION.WAIT,
      score:     0,
      grade:     GRADE.C,
      reasons:   [reason],
      analysis:  { symbol: this.symbol, timeframe: this.timeframe },
    };
  }
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  MomentumAgent,
  RSIEngine,
  MACDEngine,
  EMAStackEngine,
  VWAPEngine,
  IchimokuEngine,
  BollingerEngine,
  DIRECTION,
};
