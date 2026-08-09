
'use strict';

const EventEmitter = require('events');

function _round(n, d = 4)  { return parseFloat((+n).toFixed(d)); }
function _pct(a, b)        { return b !== 0 ? _round(Math.abs(a - b) / b * 100, 3) : 0; }
function _within(a, b, tol){ return Math.abs(a - b) / b <= tol; }
function _avg(arr)         { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

const FIBO = {
  '0.236': 0.236, '0.382': 0.382, '0.500': 0.500,
  '0.618': 0.618, '0.786': 0.786, '0.886': 0.886,
  '1.000': 1.000, '1.272': 1.272, '1.414': 1.414,
  '1.618': 1.618, '2.000': 2.000, '2.236': 2.236,
  '2.618': 2.618, '3.14':  3.14,
};

const HARMONIC_TOL = 0.05;

class PivotDetector {
  static detect(candles, strength = 3) {
    const highs = [];
    const lows  = [];

    for (let i = strength; i < candles.length - strength; i++) {
      const window     = candles.slice(i - strength, i + strength + 1);
      const c          = candles[i];
      const isHigh     = window.every(w => w.high <= c.high);
      const isLow      = window.every(w => w.low  >= c.low);

      if (isHigh) {
        highs.push({
          price:     c.high,
          index:     i,
          timestamp: c.timestamp,
          candle:    c,
          strength:  PivotDetector._pivotStrength(candles, i, 'HIGH'),
        });
      }
      if (isLow) {
        lows.push({
          price:     c.low,
          index:     i,
          timestamp: c.timestamp,
          candle:    c,
          strength:  PivotDetector._pivotStrength(candles, i, 'LOW'),
        });
      }
    }

    return { highs, lows };
  }

  static _pivotStrength(candles, idx, type) {
    let strength = 1;
    const c = candles[idx];
    let left = idx - 1, right = idx + 1;
    while (left >= 0 && right < candles.length) {
      if (type === 'HIGH') {
        if (candles[left].high < c.high && candles[right].high < c.high) strength++;
        else break;
      } else {
        if (candles[left].low > c.low && candles[right].low > c.low) strength++;
        else break;
      }
      left--; right++;
    }
    return Math.min(strength, 5);
  }

  static getRecent(pivots, n) {
    return [...pivots].sort((a, b) => b.index - a.index).slice(0, n);
  }
}

class WyckoffAnalyzer {
  static analyze(candles) {
    if (!candles || candles.length < 60) return null;

    const { highs, lows } = PivotDetector.detect(candles, 3);
    const closes          = candles.map(c => c.close);
    const volumes         = candles.map(c => c.volume || 1);
    const recent          = candles.slice(-60);

    const avgVol = _avg(volumes.slice(-30));
    const highVolCandles = recent.filter(c => (c.volume || 1) > avgVol * 1.5);
    const lowVolCandles  = recent.filter(c => (c.volume || 1) < avgVol * 0.7);

    const phase = WyckoffAnalyzer._detectPhase(candles, highs, lows, avgVol);

    const events = WyckoffAnalyzer._detectEvents(candles, highs, lows, avgVol);

    const effortResult = WyckoffAnalyzer._effortVsResult(candles);

    const causeEffect = WyckoffAnalyzer._causeEffect(candles, phase);

    let direction = 'NEUTRAL';
    let score     = 0;
    const reasons = [];

    if (phase.type === 'ACCUMULATION' && ['D', 'E'].includes(phase.phase)) {
      direction = 'LONG';
      score     = 75 + (phase.phase === 'E' ? 15 : 0);
      reasons.push(`Wyckoff Accumulation Phase ${phase.phase} — markup imminent`);
    } else if (phase.type === 'ACCUMULATION' && phase.phase === 'C') {
      direction = 'LONG';
      score     = 65;
      reasons.push(`Wyckoff Phase C — Spring/Test detected, buy the dip`);
    } else if (phase.type === 'DISTRIBUTION' && ['D', 'E'].includes(phase.phase)) {
      direction = 'SHORT';
      score     = 75 + (phase.phase === 'E' ? 15 : 0);
      reasons.push(`Wyckoff Distribution Phase ${phase.phase} — markdown imminent`);
    } else if (phase.type === 'DISTRIBUTION' && phase.phase === 'C') {
      direction = 'SHORT';
      score     = 65;
      reasons.push(`Wyckoff Phase C — UTAD/Test detected, sell the rally`);
    }

    for (const evt of events) {
      if (evt.type === 'SPRING' || evt.type === 'SHAKEOUT') {
        if (direction !== 'LONG') { direction = 'LONG'; score = 70; }
        score += 10;
        reasons.push(`Wyckoff ${evt.type}: ${evt.note}`);
      }
      if (evt.type === 'UTAD' || evt.type === 'BUYING_CLIMAX') {
        if (direction !== 'SHORT') { direction = 'SHORT'; score = 70; }
        score += 10;
        reasons.push(`Wyckoff ${evt.type}: ${evt.note}`);
      }
      if (evt.type === 'SOS') { score += 8; reasons.push(`Sign of Strength — demand overwhelming supply`); }
      if (evt.type === 'SOW') { score += 8; reasons.push(`Sign of Weakness — supply overwhelming demand`); }
    }

    if (effortResult.bullish && direction === 'LONG') {
      score += 8;
      reasons.push(`Effort vs Result: ${effortResult.note}`);
    } else if (effortResult.bearish && direction === 'SHORT') {
      score += 8;
      reasons.push(`Effort vs Result: ${effortResult.note}`);
    }

    if (causeEffect.projection && direction !== 'NEUTRAL') {
      reasons.push(`C&E projection: ${causeEffect.direction === direction ? 'target ' + causeEffect.target : 'caution — projection mismatch'}`);
    }

    return {
      phase, events, effortResult, causeEffect,
      direction,
      score:   Math.min(100, Math.round(score)),
      reasons,
      avgVol:  _round(avgVol, 2),
    };
  }

  static _detectPhase(candles, highs, lows, avgVol) {
    const recent60  = candles.slice(-60);
    const recent20  = candles.slice(-20);
    const recentH   = highs.filter(h => h.index >= candles.length - 60);
    const recentL   = lows.filter(l => l.index >= candles.length - 60);

    if (!recentH.length || !recentL.length) return { type: 'UNKNOWN', phase: '?' };

    const priceRange  = recent60.map(c => c.high - c.low);
    const avgRange    = _avg(priceRange);
    const recentRange = _avg(recent20.map(c => c.high - c.low));
    const contracting = recentRange < avgRange * 0.7;

    const highPrices  = recentH.map(h => h.price);
    const lowPrices   = recentL.map(l => l.price);
    const highSlope   = highPrices.length >= 2
      ? (highPrices[highPrices.length-1] - highPrices[0]) / highPrices.length
      : 0;
    const lowSlope    = lowPrices.length >= 2
      ? (lowPrices[lowPrices.length-1] - lowPrices[0]) / lowPrices.length
      : 0;

    const trending    = Math.abs(highSlope) > avgVol * 0.001;
    const isRange     = contracting || (Math.abs(highSlope) < 0.5 && Math.abs(lowSlope) < 0.5);

    const vol60 = _avg(candles.slice(-60).map(c => c.volume || 1));
    const vol20 = _avg(candles.slice(-20).map(c => c.volume || 1));
    const volDecreasing = vol20 < vol60 * 0.8;
    const volIncreasing = vol20 > vol60 * 1.2;

    const currentPrice = candles[candles.length - 1].close;
    const rangeBottom  = Math.min(...lowPrices);
    const rangeTop     = Math.max(...highPrices);
    const pricePos     = (currentPrice - rangeBottom) / Math.max(rangeTop - rangeBottom, 1);

    if (isRange && pricePos < 0.4 && (volDecreasing || contracting)) {
      const phase = volDecreasing && contracting ? 'C' : volIncreasing ? 'D' : 'B';
      return { type: 'ACCUMULATION', phase, pricePos: _round(pricePos, 3), contracting, volTrend: volDecreasing ? 'DEC' : 'INC' };
    }

    if (isRange && pricePos > 0.6 && (volDecreasing || contracting)) {
      const phase = volDecreasing && contracting ? 'C' : volIncreasing ? 'D' : 'B';
      return { type: 'DISTRIBUTION', phase, pricePos: _round(pricePos, 3), contracting, volTrend: volDecreasing ? 'DEC' : 'INC' };
    }

    if (highSlope > 0 && lowSlope > 0) {
      return { type: 'MARKUP', phase: 'E', pricePos: _round(pricePos, 3) };
    }
    if (highSlope < 0 && lowSlope < 0) {
      return { type: 'MARKDOWN', phase: 'E', pricePos: _round(pricePos, 3) };
    }

    return { type: 'TRANSITION', phase: 'A', pricePos: _round(pricePos, 3) };
  }

  static _detectEvents(candles, highs, lows, avgVol) {
    const events  = [];
    const recent  = candles.slice(-40);
    const avgVol30 = _avg(candles.slice(-30).map(c => c.volume || 1));

    for (let i = 5; i < recent.length; i++) {
      const c   = recent[i];
      const vol = c.volume || 1;
      const isLow = lows.some(l => Math.abs(l.price - c.low) < c.low * 0.002);
      if (vol > avgVol30 * 2 && c.close < c.open && isLow) {
        events.push({ type: 'SELLING_CLIMAX', index: i, price: c.low, note: `SC at ${_round(c.low)} — high vol ${_round(vol/avgVol30,1)}x avg` });
      }
    }

    for (let i = 5; i < recent.length; i++) {
      const c   = recent[i];
      const vol = c.volume || 1;
      const isHigh = highs.some(h => Math.abs(h.price - c.high) < c.high * 0.002);
      if (vol > avgVol30 * 2 && c.close > c.open && isHigh) {
        events.push({ type: 'BUYING_CLIMAX', index: i, price: c.high, note: `BC at ${_round(c.high)} — high vol ${_round(vol/avgVol30,1)}x avg` });
      }
    }

    if (lows.length >= 2) {
      const lastTwo = lows.slice(-2);
      const l1 = lastTwo[0], l2 = lastTwo[1];
      const c2 = candles[l2.index];
      const vol2 = c2?.volume || 1;
      if (l2.price < l1.price && vol2 < avgVol30 * 0.8) {
        events.push({ type: 'SPRING', index: l2.index, price: l2.price, note: `Spring below ${_round(l1.price)} on low vol — bull reversal signal` });
      }
    }

    if (highs.length >= 2) {
      const lastTwo = highs.slice(-2);
      const h1 = lastTwo[0], h2 = lastTwo[1];
      const c2 = candles[h2.index];
      const vol2 = c2?.volume || 1;
      if (h2.price > h1.price && vol2 < avgVol30 * 0.8) {
        events.push({ type: 'UTAD', index: h2.index, price: h2.price, note: `UTAD above ${_round(h1.price)} on low vol — bear reversal signal` });
      }
    }

    for (let i = 2; i < recent.length; i++) {
      const c   = recent[i];
      const vol = c.volume || 1;
      const range = c.high - c.low;
      if (vol > avgVol30 * 1.5 && c.close > c.open && range > _avg(candles.slice(-10).map(x => x.high - x.low)) * 1.3) {
        events.push({ type: 'SOS', index: i, price: c.close, note: `SOS at ${_round(c.close)} — demand overwhelming supply` });
      }
    }

    for (let i = 2; i < recent.length; i++) {
      const c   = recent[i];
      const vol = c.volume || 1;
      const range = c.high - c.low;
      if (vol > avgVol30 * 1.5 && c.close < c.open && range > _avg(candles.slice(-10).map(x => x.high - x.low)) * 1.3) {
        events.push({ type: 'SOW', index: i, price: c.close, note: `SOW at ${_round(c.close)} — supply overwhelming demand` });
      }
    }

    return events;
  }

  static _effortVsResult(candles) {
    const recent = candles.slice(-10);
    let bullish = false, bearish = false;
    const notes = [];

    for (let i = 1; i < recent.length; i++) {
      const c    = recent[i];
      const prev = recent[i - 1];
      const vol  = c.volume || 1;
      const prevVol = prev.volume || 1;
      const spread = c.high - c.low;
      const prevSpread = prev.high - prev.low;

      if (vol > prevVol * 1.5 && spread < prevSpread * 0.7) {
        if (c.close > c.open) { bearish = true; notes.push('Bull absorption — effort without result upward'); }
        else { bullish = true; notes.push('Bear absorption — effort without result downward'); }
      }

      if (vol < prevVol * 0.7 && spread > prevSpread * 1.3) {
        if (c.close > c.open) { bullish = true; notes.push('Easy upward movement — low effort, high result'); }
        else { bearish = true; notes.push('Easy downward movement — low effort, high result'); }
      }
    }

    return { bullish, bearish, note: notes[0] || 'Normal effort/result relationship' };
  }

  static _causeEffect(candles, phase) {
    if (!['ACCUMULATION', 'DISTRIBUTION'].includes(phase.type)) {
      return { projection: null, direction: null, target: null };
    }

    const closes = candles.slice(-60).map(c => c.close);
    const high   = Math.max(...closes);
    const low    = Math.min(...closes);
    const range  = high - low;
    const current = closes[closes.length - 1];

    const direction = phase.type === 'ACCUMULATION' ? 'LONG' : 'SHORT';
    const target    = phase.type === 'ACCUMULATION'
      ? _round(high + range * 1.5)
      : _round(low  - range * 1.5);

    return { projection: true, direction, target, range: _round(range, 5) };
  }
}

class ChartPatternDetector {
  static detect(candles) {
    if (!candles || candles.length < 30) return [];

    const { highs, lows } = PivotDetector.detect(candles, 3);
    const patterns        = [];

    const hs   = ChartPatternDetector._headAndShoulders(highs, lows, candles);
    const ihs  = ChartPatternDetector._inverseHeadAndShoulders(highs, lows, candles);
    const dt   = ChartPatternDetector._doubleTop(highs, candles);
    const db   = ChartPatternDetector._doubleBottom(lows, candles);
    const tri  = ChartPatternDetector._triangles(highs, lows, candles);
    const flags = ChartPatternDetector._flags(candles, highs, lows);
    const wedge = ChartPatternDetector._wedges(highs, lows, candles);
    const cup  = ChartPatternDetector._cupAndHandle(candles, lows);

    patterns.push(...[hs, ihs, dt, db, ...tri, ...flags, ...wedge, cup].filter(Boolean));

    return patterns;
  }

  static _headAndShoulders(highs, lows, candles) {
    const recentHighs = PivotDetector.getRecent(highs, 10).reverse();
    if (recentHighs.length < 3) return null;

    for (let i = 0; i < recentHighs.length - 2; i++) {
      const ls = recentHighs[i];
      const h  = recentHighs[i + 1];
      const rs = recentHighs[i + 2];

      if (h.price > ls.price && h.price > rs.price) {
        if (_within(ls.price, rs.price, 0.03)) {
          const troughs = lows.filter(l => l.index > ls.index && l.index < rs.index);
          if (troughs.length < 2) continue;

          const nl1 = troughs[0];
          const nl2 = troughs[troughs.length - 1];
          const neckline = (nl1.price + nl2.price) / 2;
          const target   = neckline - (h.price - neckline);

          const current = candles[candles.length - 1].close;
          const broken  = current < neckline;

          return {
            type:     'HEAD_AND_SHOULDERS',
            direction: 'SHORT',
            confidence: broken ? 90 : 70,
            neckline: _round(neckline),
            target:   _round(target),
            head:     h.price,
            shoulders: [ls.price, rs.price],
            broken,
            note: broken
              ? `H&S complete — neckline broken at ${_round(neckline)}, target ${_round(target)}`
              : `H&S forming — watch for neckline break at ${_round(neckline)}`,
          };
        }
      }
    }
    return null;
  }

  static _inverseHeadAndShoulders(highs, lows, candles) {
    const recentLows = PivotDetector.getRecent(lows, 10).reverse();
    if (recentLows.length < 3) return null;

    for (let i = 0; i < recentLows.length - 2; i++) {
      const ls = recentLows[i];
      const h  = recentLows[i + 1];
      const rs = recentLows[i + 2];

      if (h.price < ls.price && h.price < rs.price) {
        if (_within(ls.price, rs.price, 0.03)) {
          const peaks    = highs.filter(h => h.index > ls.index && h.index < rs.index);
          if (peaks.length < 2) continue;
          const nl1      = peaks[0];
          const nl2      = peaks[peaks.length - 1];
          const neckline = (nl1.price + nl2.price) / 2;
          const target   = neckline + (neckline - h.price);
          const current  = candles[candles.length - 1].close;
          const broken   = current > neckline;

          return {
            type:      'INV_HEAD_AND_SHOULDERS',
            direction: 'LONG',
            confidence: broken ? 90 : 70,
            neckline:  _round(neckline),
            target:    _round(target),
            head:      h.price,
            shoulders: [ls.price, rs.price],
            broken,
            note: broken
              ? `Inverse H&S confirmed — neckline broken, target ${_round(target)}`
              : `Inverse H&S forming — watch for neckline break at ${_round(neckline)}`,
          };
        }
      }
    }
    return null;
  }

  static _doubleTop(highs, candles) {
    const recent = PivotDetector.getRecent(highs, 8).reverse();
    if (recent.length < 2) return null;

    const h1 = recent[recent.length - 2];
    const h2 = recent[recent.length - 1];

    if (!_within(h1.price, h2.price, 0.025) || h2.index <= h1.index) return null;

    const between = candles.slice(h1.index, h2.index);
    if (between.length < 5) return null;
    const trough   = Math.min(...between.map(c => c.low));
    const target   = trough - (h1.price - trough);
    const current  = candles[candles.length - 1].close;
    const broken   = current < trough;

    return {
      type:      'DOUBLE_TOP',
      direction: 'SHORT',
      confidence: broken ? 85 : 65,
      top1:      _round(h1.price),
      top2:      _round(h2.price),
      neckline:  _round(trough),
      target:    _round(target),
      broken,
      note: broken
        ? `Double Top confirmed — below ${_round(trough)}, target ${_round(target)}`
        : `Double Top forming — watch ${_round(trough)} for breakdown`,
    };
  }

  static _doubleBottom(lows, candles) {
    const recent = PivotDetector.getRecent(lows, 8).reverse();
    if (recent.length < 2) return null;

    const l1 = recent[recent.length - 2];
    const l2 = recent[recent.length - 1];

    if (!_within(l1.price, l2.price, 0.025) || l2.index <= l1.index) return null;

    const between  = candles.slice(l1.index, l2.index);
    if (between.length < 5) return null;
    const peak     = Math.max(...between.map(c => c.high));
    const target   = peak + (peak - l1.price);
    const current  = candles[candles.length - 1].close;
    const broken   = current > peak;

    return {
      type:      'DOUBLE_BOTTOM',
      direction: 'LONG',
      confidence: broken ? 85 : 65,
      bottom1:   _round(l1.price),
      bottom2:   _round(l2.price),
      neckline:  _round(peak),
      target:    _round(target),
      broken,
      note: broken
        ? `Double Bottom confirmed — above ${_round(peak)}, target ${_round(target)}`
        : `Double Bottom forming — watch ${_round(peak)} for breakout`,
    };
  }

  static _triangles(highs, lows, candles) {
    const patterns = [];
    const recH     = PivotDetector.getRecent(highs, 6).reverse();
    const recL     = PivotDetector.getRecent(lows, 6).reverse();

    if (recH.length < 2 || recL.length < 2) return patterns;

    const highSlope = (recH[recH.length-1].price - recH[0].price) / (recH.length - 1);
    const lowSlope  = (recL[recL.length-1].price - recL[0].price) / (recL.length - 1);
    const current   = candles[candles.length - 1].close;

    if (Math.abs(highSlope) < recH[0].price * 0.001 && lowSlope > 0) {
      const resistance = _avg(recH.map(h => h.price));
      const target     = resistance + (resistance - recL[0].price);
      patterns.push({
        type: 'ASCENDING_TRIANGLE', direction: 'LONG', confidence: 75,
        resistance: _round(resistance), target: _round(target),
        note: `Ascending Triangle — flat resistance at ${_round(resistance)}, target ${_round(target)}`,
      });
    }

    if (highSlope < 0 && Math.abs(lowSlope) < recL[0].price * 0.001) {
      const support = _avg(recL.map(l => l.price));
      const target  = support - (recH[0].price - support);
      patterns.push({
        type: 'DESCENDING_TRIANGLE', direction: 'SHORT', confidence: 75,
        support: _round(support), target: _round(target),
        note: `Descending Triangle — flat support at ${_round(support)}, target ${_round(target)}`,
      });
    }

    if (highSlope < 0 && lowSlope > 0) {
      const apex   = recH[0].price + (recH[recH.length-1].price - recH[0].price) / 2;
      const bias   = current > apex ? 'LONG' : 'SHORT';
      patterns.push({
        type: 'SYMMETRICAL_TRIANGLE', direction: bias, confidence: 60,
        apex: _round(apex),
        note: `Symmetrical Triangle — breakout direction TBD, current bias ${bias}`,
      });
    }

    return patterns;
  }

  static _flags(candles, highs, lows) {
    const patterns = [];
    if (candles.length < 20) return patterns;

    const pre    = candles.slice(-25, -10);
    const flag   = candles.slice(-10);

    if (!pre.length || !flag.length) return patterns;

    const poleHigh = Math.max(...pre.map(c => c.high));
    const poleLow  = Math.min(...pre.map(c => c.low));
    const poleSize = Math.abs(poleHigh - poleLow) / poleLow;

    if (poleSize < 0.03) return patterns; // Pole must be >3%

    const poleUp   = pre[pre.length - 1].close > pre[0].close;
    const flagHigh = Math.max(...flag.map(c => c.high));
    const flagLow  = Math.min(...flag.map(c => c.low));
    const flagSize = Math.abs(flagHigh - flagLow) / flagLow;

    if (flagSize > poleSize * 0.5) return patterns;

    if (poleUp) {
      const target = poleHigh + (poleHigh - poleLow);
      patterns.push({
        type: 'BULL_FLAG', direction: 'LONG', confidence: 72,
        poleHigh: _round(poleHigh), poleLow: _round(poleLow),
        target: _round(target),
        note: `Bull Flag — pole ${_round(poleSize*100,1)}% move, flag consolidating, target ${_round(target)}`,
      });
    } else {
      const target = poleLow - (poleHigh - poleLow);
      patterns.push({
        type: 'BEAR_FLAG', direction: 'SHORT', confidence: 72,
        poleHigh: _round(poleHigh), poleLow: _round(poleLow),
        target: _round(target),
        note: `Bear Flag — pole ${_round(poleSize*100,1)}% drop, flag consolidating, target ${_round(target)}`,
      });
    }

    return patterns;
  }

  static _wedges(highs, lows, candles) {
    const patterns = [];
    const recH = PivotDetector.getRecent(highs, 5).reverse();
    const recL  = PivotDetector.getRecent(lows, 5).reverse();

    if (recH.length < 3 || recL.length < 3) return patterns;

    const highSlope = (recH[recH.length-1].price - recH[0].price) / recH[0].price;
    const lowSlope  = (recL[recL.length-1].price - recL[0].price) / recL[0].price;

    if (highSlope > 0 && lowSlope > 0 && lowSlope > highSlope) {
      const current = candles[candles.length-1].close;
      patterns.push({
        type: 'RISING_WEDGE', direction: 'SHORT', confidence: 70,
        note: `Rising Wedge — converging upward channels, typically bearish breakdown`,
        currentPrice: _round(current),
      });
    }

    if (highSlope < 0 && lowSlope < 0 && highSlope < lowSlope) {
      const current = candles[candles.length-1].close;
      patterns.push({
        type: 'FALLING_WEDGE', direction: 'LONG', confidence: 70,
        note: `Falling Wedge — converging downward channels, typically bullish breakout`,
        currentPrice: _round(current),
      });
    }

    return patterns;
  }

  static _cupAndHandle(candles, lows) {
    if (candles.length < 50) return null;

    const cup  = candles.slice(-50, -10);
    const handle = candles.slice(-10);

    const cupHigh  = Math.max(...cup.map(c => c.high));
    const cupLow   = Math.min(...cup.map(c => c.low));
    const handleH  = Math.max(...handle.map(c => c.high));
    const handleL  = Math.min(...handle.map(c => c.low));

    const leftHigh  = Math.max(...cup.slice(0, Math.floor(cup.length/3)).map(c => c.high));
    const rightHigh = Math.max(...cup.slice(Math.floor(cup.length*2/3)).map(c => c.high));
    const midLow    = Math.min(...cup.slice(Math.floor(cup.length/3), Math.floor(cup.length*2/3)).map(c => c.low));

    const isCupShaped = _within(leftHigh, rightHigh, 0.03) && midLow < leftHigh * 0.95;
    const isHandle    = handleL > midLow && (handleH - handleL) < (cupHigh - cupLow) * 0.5;

    if (isCupShaped && isHandle) {
      const target = cupHigh + (cupHigh - cupLow);
      return {
        type: 'CUP_AND_HANDLE', direction: 'LONG', confidence: 78,
        cupHigh: _round(cupHigh), cupLow: _round(cupLow),
        target:  _round(target),
        note: `Cup & Handle — breakout above ${_round(cupHigh)} targets ${_round(target)}`,
      };
    }

    return null;
  }
}

class HarmonicDetector {
  static detect(candles) {
    const { highs, lows } = PivotDetector.detect(candles, 3);
    const pivots = [...highs.map(p => ({ ...p, type: 'HIGH' })),
                    ...lows.map(p => ({ ...p, type: 'LOW' })) ]
                   .sort((a, b) => a.index - b.index)
                   .slice(-20);

    const patterns = [];

    if (pivots.length < 5) return patterns;

    for (let i = 0; i <= pivots.length - 5; i++) {
      const [X, A, B, C, D] = pivots.slice(i, i + 5);

      // XABCD must alternate high/low
      if (X.type === A.type || A.type === B.type || B.type === C.type || C.type === D.type) continue;

      const XA = Math.abs(A.price - X.price);
      const AB = Math.abs(B.price - A.price);
      const BC = Math.abs(C.price - B.price);
      const CD = Math.abs(D.price - C.price);
      if (XA === 0 || AB === 0 || BC === 0) continue;

      const ratioAB = AB / XA;
      const ratioBC = BC / AB;
      const ratioCD = CD / BC;
      const ratioXD = Math.abs(D.price - X.price) / XA;

      const detected = [
        HarmonicDetector._checkGartley(X, A, B, C, D, ratioAB, ratioBC, ratioCD, ratioXD),
        HarmonicDetector._checkBat(X, A, B, C, D, ratioAB, ratioBC, ratioCD, ratioXD),
        HarmonicDetector._checkButterfly(X, A, B, C, D, ratioAB, ratioBC, ratioCD, ratioXD),
        HarmonicDetector._checkCrab(X, A, B, C, D, ratioAB, ratioBC, ratioCD, ratioXD),
        HarmonicDetector._checkABCD(A, B, C, D, ratioBC, ratioCD),
      ].filter(Boolean);

      patterns.push(...detected);
    }

    return patterns;
  }

  static _checkGartley(X, A, B, C, D, rAB, rBC, rCD, rXD) {
    if (!(_within(rAB, FIBO['0.618'], HARMONIC_TOL))) return null;
    if (rBC < 0.382 - HARMONIC_TOL || rBC > 0.886 + HARMONIC_TOL) return null;
    if (!(_within(rXD, FIBO['0.786'], HARMONIC_TOL))) return null;

    const isLong = A.price < X.price;
    return {
      type: 'GARTLEY', direction: isLong ? 'LONG' : 'SHORT',
      confidence: 78,
      PRZ: _round(D.price),
      X: X.price, A: A.price, B: B.price, C: C.price, D: D.price,
      ratios: { AB: _round(rAB,3), BC: _round(rBC,3), CD: _round(rCD,3), XD: _round(rXD,3) },
      note: `Gartley Pattern — PRZ at ${_round(D.price)}, ${isLong?'bullish reversal':'bearish reversal'}`,
    };
  }

  static _checkBat(X, A, B, C, D, rAB, rBC, rCD, rXD) {
    if (rAB < 0.382 - HARMONIC_TOL || rAB > 0.500 + HARMONIC_TOL) return null;
    if (rBC < 0.382 - HARMONIC_TOL || rBC > 0.886 + HARMONIC_TOL) return null;
    if (!(_within(rXD, FIBO['0.886'], HARMONIC_TOL))) return null;

    const isLong = A.price < X.price;
    return {
      type: 'BAT', direction: isLong ? 'LONG' : 'SHORT',
      confidence: 80,
      PRZ: _round(D.price),
      X: X.price, A: A.price, B: B.price, C: C.price, D: D.price,
      ratios: { AB: _round(rAB,3), BC: _round(rBC,3), CD: _round(rCD,3), XD: _round(rXD,3) },
      note: `Bat Pattern — PRZ at ${_round(D.price)}, ${isLong?'bullish':'bearish'} — high accuracy`,
    };
  }

  static _checkButterfly(X, A, B, C, D, rAB, rBC, rCD, rXD) {
    if (!(_within(rAB, FIBO['0.786'], HARMONIC_TOL))) return null;
    if (rBC < 0.382 - HARMONIC_TOL || rBC > 0.886 + HARMONIC_TOL) return null;
    if (rXD < 1.27 - HARMONIC_TOL || rXD > 1.618 + HARMONIC_TOL) return null;

    const isLong = A.price < X.price;
    return {
      type: 'BUTTERFLY', direction: isLong ? 'LONG' : 'SHORT',
      confidence: 75,
      PRZ: _round(D.price),
      X: X.price, A: A.price, B: B.price, C: C.price, D: D.price,
      ratios: { AB: _round(rAB,3), BC: _round(rBC,3), CD: _round(rCD,3), XD: _round(rXD,3) },
      note: `Butterfly Pattern — extended PRZ at ${_round(D.price)} (${_round(rXD,2)}x of XA)`,
    };
  }

  static _checkCrab(X, A, B, C, D, rAB, rBC, rCD, rXD) {
    if (rAB < 0.382 - HARMONIC_TOL || rAB > 0.618 + HARMONIC_TOL) return null;
    if (rBC < 0.382 - HARMONIC_TOL || rBC > 0.886 + HARMONIC_TOL) return null;
    if (!(_within(rXD, FIBO['1.618'], HARMONIC_TOL * 2))) return null;

    const isLong = A.price < X.price;
    return {
      type: 'CRAB', direction: isLong ? 'LONG' : 'SHORT',
      confidence: 82,
      PRZ: _round(D.price),
      X: X.price, A: A.price, B: B.price, C: C.price, D: D.price,
      ratios: { AB: _round(rAB,3), BC: _round(rBC,3), CD: _round(rCD,3), XD: _round(rXD,3) },
      note: `Crab Pattern — deep 1.618 extension at ${_round(D.price)} — high accuracy reversal zone`,
    };
  }

  static _checkABCD(A, B, C, D, rBC, rCD) {
    const equal = _within(rBC, 1.0, 0.10) && _within(rCD, 1.0, 0.10);
    const fib   = (_within(rBC, FIBO['0.618'], HARMONIC_TOL) && _within(rCD, FIBO['1.618'], HARMONIC_TOL)) ||
                  (_within(rBC, FIBO['0.786'], HARMONIC_TOL) && _within(rCD, FIBO['1.272'], HARMONIC_TOL));

    if (!equal && !fib) return null;

    const isLong = B.price < A.price;
    return {
      type: 'ABCD', direction: isLong ? 'LONG' : 'SHORT',
      confidence: 70,
      PRZ: _round(D.price),
      A: A.price, B: B.price, C: C.price, D: D.price,
      ratios: { BC: _round(rBC,3), CD: _round(rCD,3) },
      pattern: equal ? 'EQUAL_LEGS' : 'FIBONACCI',
      note: `ABCD Pattern (${equal?'equal legs':'fibonacci'}) — reversal at ${_round(D.price)}`,
    };
  }
}

class VolumeDivergenceDetector {
  static detect(candles) {
    if (!candles || candles.length < 20) return null;

    const recent   = candles.slice(-20);
    const closes   = recent.map(c => c.close);
    const volumes  = recent.map(c => c.volume || 1);

    const obv = [0];
    for (let i = 1; i < recent.length; i++) {
      const prev    = obv[obv.length - 1];
      const volDir  = recent[i].close > recent[i-1].close ? 1
                    : recent[i].close < recent[i-1].close ? -1
                    : 0;
      obv.push(prev + volumes[i] * volDir);
    }

    const priceUp  = closes[closes.length-1] > closes[0];
    const obvUp    = obv[obv.length-1] > obv[0];

    const bullDiv  = !priceUp && obvUp;
    const bearDiv  = priceUp && !obvUp;

    let cmfSum = 0, volSum = 0;
    for (const c of recent) {
      const hl    = c.high - c.low;
      const mfm   = hl > 0 ? ((c.close - c.low) - (c.high - c.close)) / hl : 0;
      cmfSum     += mfm * (c.volume || 1);
      volSum     += (c.volume || 1);
    }
    const cmf = volSum > 0 ? _round(cmfSum / volSum, 4) : 0;

    return {
      bullishOBV:  bullDiv,
      bearishOBV:  bearDiv,
      cmf,
      cmfBullish:  cmf > 0.05,
      cmfBearish:  cmf < -0.05,
      obvCurrent:  _round(obv[obv.length-1], 2),
      obvChange:   _round(obv[obv.length-1] - obv[0], 2),
      note: bullDiv ? 'Bullish OBV divergence — accumulation on price weakness'
          : bearDiv ? 'Bearish OBV divergence — distribution on price strength'
          : 'No volume divergence',
    };
  }
}

class PatternAgent extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbol        = config.symbol        || 'UNKNOWN';
    this.timeframe     = config.timeframe     || 'H1';
    this.minScore      = config.minScore      || 45;
    this.pivotStrength = config.pivotStrength || 3;

    this._lastVote = null;
    this._stats    = { analyzed: 0, patternsFound: 0, longVotes: 0, shortVotes: 0 };
  }

  async analyze(candles) {
    if (!Array.isArray(candles) || candles.length < 50) {
      return this._buildVote('WAIT', 0, ['Insufficient candles for pattern analysis'], {});
    }

    const wyckoff   = WyckoffAnalyzer.analyze(candles);
    const patterns  = ChartPatternDetector.detect(candles);
    const harmonics = HarmonicDetector.detect(candles);
    const volDiv    = VolumeDivergenceDetector.detect(candles);

    const analysis = { wyckoff, chartPatterns: patterns, harmonics, volumeDivergence: volDiv };

    let bullPts = 0, bearPts = 0;
    const reasons = [];

    if (wyckoff && wyckoff.direction !== 'NEUTRAL') {
      const wScore = wyckoff.score / 100 * 3;
      if (wyckoff.direction === 'LONG')  { bullPts += wScore; reasons.push(...wyckoff.reasons.slice(0, 2)); }
      if (wyckoff.direction === 'SHORT') { bearPts += wScore; reasons.push(...wyckoff.reasons.slice(0, 2)); }
    }

    const currentPrice = candles[candles.length - 1].close;
    for (const p of patterns) {
      const near = p.PRZ ? Math.abs(currentPrice - p.PRZ) / currentPrice < 0.02 : true;
      const pts  = (p.confidence / 100) * 2 * (near ? 1.5 : 1);
      if (p.direction === 'LONG')  { bullPts += pts; reasons.push(p.note); }
      if (p.direction === 'SHORT') { bearPts += pts; reasons.push(p.note); }
    }

    for (const h of harmonics) {
      const nearPRZ  = h.PRZ && Math.abs(currentPrice - h.PRZ) / currentPrice < 0.015;
      const pts      = nearPRZ ? 3 : 1;
      if (h.direction === 'LONG')  { bullPts += pts; reasons.push(h.note); }
      if (h.direction === 'SHORT') { bearPts += pts; reasons.push(h.note); }
    }

    if (volDiv?.bullishOBV) { bullPts += 1.5; reasons.push(volDiv.note); }
    if (volDiv?.bearishOBV) { bearPts += 1.5; reasons.push(volDiv.note); }
    if (volDiv?.cmfBullish) { bullPts += 1; reasons.push(`CMF positive (${volDiv.cmf}) — money flowing in`); }
    if (volDiv?.cmfBearish) { bearPts += 1; reasons.push(`CMF negative (${volDiv.cmf}) — money flowing out`); }

    const direction = bullPts > bearPts + 0.5 ? 'LONG'
                    : bearPts > bullPts + 0.5 ? 'SHORT'
                    : 'WAIT';

    const maxPts  = Math.max(bullPts + bearPts, 1);
    const rawScore = Math.min(100, Math.round(Math.abs(bullPts - bearPts) / maxPts * 100));
    const score   = rawScore >= this.minScore ? rawScore : 0;
    const finalDir = score >= this.minScore ? direction : 'WAIT';

    this._stats.analyzed++;
    this._stats.patternsFound += patterns.length + harmonics.length;
    if (finalDir === 'LONG')  this._stats.longVotes++;
    if (finalDir === 'SHORT') this._stats.shortVotes++;

    const vote = this._buildVote(finalDir, score, reasons.slice(0, 6), analysis);
    this._lastVote = vote;
    this.emit('vote', vote);
    return vote;
  }

  _buildVote(direction, score, reasons, analysis) {
    return {
      direction, score, reasons,
      grade:   score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D',
      analysis,
      symbol:    this.symbol,
      timeframe: this.timeframe,
      timestamp: Date.now(),
    };
  }

  getLastVote() { return this._lastVote; }
  getStats()    { return { ...this._stats }; }
}

module.exports = {
  PatternAgent,
  WyckoffAnalyzer,
  ChartPatternDetector,
  HarmonicDetector,
  VolumeDivergenceDetector,
  PivotDetector,
  FIBO,
};