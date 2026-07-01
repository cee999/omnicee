/**
 * ============================================================
 *  SESSION FILTER — Maximum-Depth Time & Liquidity Risk Engine
 *  AI Trading Assistant · Layer 6 · Risk Engine Module
 *  File: risk-engine/session-filter.js
 * ============================================================
 *
 *  Modules inside this file:
 *
 *  1. LiquidityCurveEngine
 *     - Hour-by-hour (UTC) relative liquidity curves PER ASSET CLASS
 *     - Liquidity-weighted spread estimator
 *     - Volume-weighted session quality
 *
 *  2. DynamicKillzoneScorer
 *     - Rolling realized-volatility feed per symbol
 *     - Recomputes "today's" killzone quality using live ATR data
 *     - Detects abnormal quiet/loud sessions vs historical baseline
 *
 *  3. EconomicCalendarTierSystem
 *     - Tiered impact matrix TIER_1 to TIER_4
 *     - Per-currency AND per-asset-class blackout windows
 *     - Pre-event positioning window vs post-event full blackout
 *     - Speech/testimony calendar support
 *
 *  4. RolloverAvoidanceEngine
 *     - Forex broker swap/rollover spread-widening avoidance
 *     - Triple-swap Wednesday detection
 *     - Crypto funding settlement windows
 *
 *  5. InstitutionalRebalancingCalendar
 *     - Month-end / quarter-end rebalancing flow windows
 *     - Quad witching days
 *
 *  6. SessionBacktester
 *     - Empirical hourly performance from live trade outcomes
 *     - Compares model liquidity curve against actual results
 *
 *  7. SessionFilter (main class)
 *     - .check(symbol, timestamp) → allowed/blocked + full breakdown
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const DEFAULTS = {
  BLOCK_DEAD_ZONE:          true,
  BLOCK_WEEKEND:            true,
  BLOCK_HOLIDAYS:           true,
  BLOCK_ROLLOVER:           true,
  REQUIRE_KILLZONE:         false,
  MIN_QUALITY_MULTIPLIER:   0.30,
  MAX_QUALITY_MULTIPLIER:   1.20,
  VOL_BASELINE_WINDOW:      30,
  VOL_ABNORMAL_THRESHOLD:   1.8,
  PRE_EVENT_WINDOW_MIN:     60,
  POST_EVENT_BLACKOUT_MIN:  30,
  ROLLOVER_WINDOW:          { start: 20.75, end: 21.25 },
};

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ─────────────────────────────────────────────
//  1. LIQUIDITY CURVE ENGINE
// ─────────────────────────────────────────────

const LIQUIDITY_CURVES = {
  FOREX_MAJOR: [
    18,15,14,16,22,30,42,58,78,88,92,90,
    94,100,98,90,82,70,55,40,28,20,16,17,
  ],
  FOREX_EXOTIC: [
    10, 8, 7, 9,14,20,30,42,60,72,76,74,
    78, 82,78,68,56,44,32,22,14,11, 9,10,
  ],
  METALS: [
    20,16,14,15,20,28,40,55,72,84,90,92,
    98,100,96,88,80,68,52,36,24,20,18,19,
  ],
  CRYPTO_MAJOR: [
    60,58,56,55,56,58,62,66,70,74,78,82,
    88,94,98,100,96,90,84,78,72,68,64,62,
  ],
  CRYPTO_ALT: [
    45,42,40,40,42,45,50,55,60,65,70,75,
    82,90,95,98,94,86,78,70,62,56,50,46,
  ],
  INDICES_US: [
    5, 4, 4, 4, 5, 6, 8,10,14,20,28,40,
    65,95,100,98,90,30,12, 6, 5, 5, 5, 5,
  ],
  INDICES_EU: [
    8, 6, 5, 6,10,18,35,60,85,95,100,96,
    88,75,55,35,18,10, 7, 6, 6, 7, 8, 9,
  ],
  OIL_ENERGY: [
    15,12,11,12,16,22,32,45,62,76,84,86,
    92,98,100,94,84,68,50,32,20,16,14,14,
  ],
};

class LiquidityCurveEngine {
  static getLiquidity(assetClass, utcHour) {
    const curve = LIQUIDITY_CURVES[assetClass] || LIQUIDITY_CURVES.FOREX_MAJOR;
    const h0 = Math.floor(utcHour) % 24;
    const h1 = (h0 + 1) % 24;
    const frac = utcHour - Math.floor(utcHour);
    return r(curve[h0] * (1 - frac) + curve[h1] * frac, 1);
  }

  static estimateSpreadMultiplier(liquidity) {
    const clamped = clamp(liquidity, 5, 100);
    return r(1 + (100 - clamped) / 100 * 2.2, 2);
  }

  static getProfile(assetClass, utcHour) {
    const liquidity = this.getLiquidity(assetClass, utcHour);
    const spreadMult = this.estimateSpreadMultiplier(liquidity);

    return {
      assetClass,
      utcHour: r(utcHour, 2),
      liquidity,
      spreadMultiplier: spreadMult,
      tier: liquidity >= 85 ? 'PRIME' : liquidity >= 60 ? 'GOOD' : liquidity >= 35 ? 'FAIR' : liquidity >= 15 ? 'POOR' : 'ILLIQUID',
      tradeable: liquidity >= 15,
    };
  }

  static get24HourCurve(assetClass) {
    const curve = LIQUIDITY_CURVES[assetClass] || LIQUIDITY_CURVES.FOREX_MAJOR;
    return curve.map((liq, hour) => ({
      hour,
      liquidity: liq,
      spreadMultiplier: this.estimateSpreadMultiplier(liq),
    }));
  }

  static getBestHours(assetClass, n = 5) {
    const curve = LIQUIDITY_CURVES[assetClass] || LIQUIDITY_CURVES.FOREX_MAJOR;
    return curve
      .map((liq, hour) => ({ hour, liquidity: liq }))
      .sort((a, b) => b.liquidity - a.liquidity)
      .slice(0, n);
  }
}

// ─────────────────────────────────────────────
//  2. DYNAMIC KILLZONE SCORER
// ─────────────────────────────────────────────

class DynamicKillzoneScorer {
  constructor(config = {}) {
    this.baselineWindow   = config.baselineWindow   ?? DEFAULTS.VOL_BASELINE_WINDOW;
    this.abnormalThreshold = config.abnormalThreshold ?? DEFAULTS.VOL_ABNORMAL_THRESHOLD;
    this._volHistory = new Map();
  }

  recordVolatility(symbol, candle, atrPct) {
    if (!this._volHistory.has(symbol)) this._volHistory.set(symbol, []);
    const hist = this._volHistory.get(symbol);

    hist.push({
      timestamp: candle.timestamp || Date.now(),
      atrPct:    atrPct ?? 0,
      volume:    candle.volume ?? 0,
      utcHour:   getUTCHour(candle.timestamp),
    });

    if (hist.length > this.baselineWindow * 4) hist.shift();
  }

  getDynamicAdjustment(symbol, utcHour) {
    const hist = this._volHistory.get(symbol);
    if (!hist || hist.length < this.baselineWindow) {
      return { multiplier: 1.0, abnormal: false, confidence: 'INSUFFICIENT_DATA', sample: hist?.length ?? 0 };
    }

    const sameHourWindow = 1.5;
    const sameHourEntries = hist.filter(h => Math.abs(h.utcHour - utcHour) <= sameHourWindow || Math.abs(h.utcHour - utcHour) >= 24 - sameHourWindow);
    const recentEntries   = hist.slice(-this.baselineWindow);

    if (sameHourEntries.length < 5) {
      return { multiplier: 1.0, abnormal: false, confidence: 'INSUFFICIENT_HOUR_DATA', sample: sameHourEntries.length };
    }

    const baselineATR = avg(sameHourEntries.map(h => h.atrPct));
    const currentATR  = recentEntries.length > 0 ? recentEntries[recentEntries.length - 1].atrPct : baselineATR;

    if (baselineATR === 0) {
      return { multiplier: 1.0, abnormal: false, confidence: 'NO_BASELINE', sample: sameHourEntries.length };
    }

    const ratio = currentATR / baselineATR;
    const abnormal = ratio >= this.abnormalThreshold || ratio <= (1 / this.abnormalThreshold);

    let multiplier;
    if (ratio < 0.5)       multiplier = 0.70;
    else if (ratio < 0.8)  multiplier = 0.90;
    else if (ratio <= 1.3) multiplier = 1.00;
    else if (ratio <= 2.0) multiplier = 1.10;
    else                    multiplier = 0.85;

    return {
      multiplier: r(multiplier, 3),
      abnormal,
      ratio: r(ratio, 3),
      baselineATR: r(baselineATR, 4),
      currentATR:  r(currentATR, 4),
      confidence: sameHourEntries.length >= 15 ? 'HIGH' : sameHourEntries.length >= 8 ? 'MEDIUM' : 'LOW',
      note: abnormal
        ? `Volatility ${ratio > 1 ? 'spike' : 'collapse'} detected: ${r(ratio,2)}x baseline for this hour`
        : `Volatility normal: ${r(ratio,2)}x baseline`,
    };
  }

  getStats(symbol) {
    const hist = this._volHistory.get(symbol) || [];
    return {
      symbol,
      sampleSize: hist.length,
      avgATR: hist.length > 0 ? r(avg(hist.map(h => h.atrPct)), 4) : null,
    };
  }
}

// ─────────────────────────────────────────────
//  3. ECONOMIC CALENDAR TIER SYSTEM
// ─────────────────────────────────────────────

const EVENT_TIERS = {
  TIER_1: { blackoutPre: 60, blackoutPost: 30, label: 'Tier 1 — Market Moving',     examples: ['NFP','FOMC Rate Decision','CPI','ECB Rate Decision'] },
  TIER_2: { blackoutPre: 30, blackoutPost: 20, label: 'Tier 2 — High Impact',        examples: ['GDP','PMI Flash','Retail Sales','Unemployment Rate'] },
  TIER_3: { blackoutPre: 15, blackoutPost: 10, label: 'Tier 3 — Medium Impact',      examples: ['Building Permits','Consumer Confidence','Trade Balance'] },
  TIER_4: { blackoutPre: 5,  blackoutPost: 5,  label: 'Tier 4 — Low Impact / Minor', examples: ['Minor regional indices','secondary data revisions'] },
};

const CURRENCY_ASSET_IMPACT = {
  USD: ['FOREX_MAJOR','FOREX_EXOTIC','METALS','INDICES_US','CRYPTO_MAJOR'],
  EUR: ['FOREX_MAJOR','FOREX_EXOTIC','INDICES_EU'],
  GBP: ['FOREX_MAJOR','FOREX_EXOTIC','INDICES_EU'],
  JPY: ['FOREX_MAJOR','FOREX_EXOTIC'],
  AUD: ['FOREX_MAJOR'],
  NZD: ['FOREX_MAJOR'],
  CAD: ['FOREX_MAJOR','OIL_ENERGY'],
  CHF: ['FOREX_MAJOR'],
};

const SPEECH_EVENTS_TEMPLATE = [
  { name: 'Fed Chair Press Conference', currency: 'USD', tier: 'TIER_1' },
  { name: 'ECB President Press Conference', currency: 'EUR', tier: 'TIER_1' },
  { name: 'BOE Governor Testimony', currency: 'GBP', tier: 'TIER_2' },
  { name: 'FOMC Member Speech', currency: 'USD', tier: 'TIER_3' },
];

class EconomicCalendarTierSystem {
  constructor() {
    this._events = [];
  }

  addEvent(event) {
    const tier = EVENT_TIERS[event.tier] ? event.tier : this._inferTier(event.name);
    this._events.push({ ...event, tier, addedAt: Date.now() });
    this._cleanup();
  }

  addEvents(events) {
    events.forEach(e => this.addEvent(e));
  }

  _inferTier(name) {
    const lower = name.toLowerCase();
    if (/nfp|non.?farm|fomc|cpi|rate decision|interest rate/.test(lower)) return 'TIER_1';
    if (/gdp|pmi|retail sales|unemployment/.test(lower)) return 'TIER_2';
    if (/building permit|confidence|trade balance/.test(lower)) return 'TIER_3';
    return 'TIER_4';
  }

  _cleanup() {
    const cutoff = Date.now() - 6 * 3600000;
    this._events = this._events.filter(e => e.time > cutoff);
  }

  check(symbol, assetClass, now) {
    const currencies = this._symbolCurrencies(symbol);
    const affecting = this._events.filter(e => {
      if (e.tier === 'TIER_4') return false;
      const currencyMatch = currencies.includes(e.currency);
      const classAffected = (CURRENCY_ASSET_IMPACT[e.currency] || []).includes(assetClass);
      return currencyMatch || classAffected;
    });

    if (affecting.length === 0) return { status: 'CLEAR', events: [], sizeMultiplier: 1.0 };

    for (const e of affecting) {
      const tierConfig = EVENT_TIERS[e.tier];
      const msToEvent = e.time - now;

      if (msToEvent <= 0 && Math.abs(msToEvent) <= tierConfig.blackoutPost * 60000) {
        return {
          status: 'BLACKOUT', events: [e], sizeMultiplier: 0,
          reason: `${tierConfig.label}: ${e.name} (${e.currency}) — post-event blackout window`,
        };
      }

      const preBlockWindow = Math.min(tierConfig.blackoutPre, 15) * 60000;
      if (msToEvent > 0 && msToEvent <= preBlockWindow) {
        return {
          status: 'BLACKOUT', events: [e], sizeMultiplier: 0,
          reason: `${tierConfig.label}: ${e.name} (${e.currency}) — imminent, blocked`,
        };
      }

      if (msToEvent > 0 && msToEvent <= tierConfig.blackoutPre * 60000) {
        return {
          status: 'PRE_EVENT', events: [e],
          sizeMultiplier: e.tier === 'TIER_1' ? 0.5 : 0.75,
          reason: `${tierConfig.label}: ${e.name} (${e.currency}) in ${Math.round(msToEvent/60000)}min — reduced size`,
        };
      }
    }

    return { status: 'CLEAR', events: [], sizeMultiplier: 1.0 };
  }

  _symbolCurrencies(symbol) {
    const known = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
    const found = known.filter(c => symbol.includes(c));
    if (symbol.includes('XAU') || symbol.includes('XAG')) found.push('USD');
    if (['SPX','NAS','US30'].some(i => symbol.includes(i))) found.push('USD');
    if (symbol.includes('BTC') || symbol.includes('ETH')) found.push('USD');
    return found;
  }

  addSpeechEvent(name, currency, timestamp, tierOverride = null) {
    const template = SPEECH_EVENTS_TEMPLATE.find(s => s.name === name);
    this.addEvent({
      name, currency, time: timestamp,
      tier: tierOverride || template?.tier || 'TIER_2',
      isSpeech: true,
    });
  }

  getUpcoming(hours = 24, tierFilter = null) {
    const now = Date.now();
    const window = hours * 3600000;
    return this._events
      .filter(e => e.time > now && e.time < now + window)
      .filter(e => !tierFilter || e.tier === tierFilter)
      .sort((a, b) => a.time - b.time)
      .map(e => ({ ...e, hoursAway: r((e.time - now) / 3600000, 2), tierLabel: EVENT_TIERS[e.tier].label }));
  }

  getTodayTier1() {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = startOfDay.getTime() + 86400000;
    return this._events.filter(e => e.time >= startOfDay.getTime() && e.time < endOfDay && e.tier === 'TIER_1');
  }
}

// ─────────────────────────────────────────────
//  4. ROLLOVER AVOIDANCE ENGINE
// ─────────────────────────────────────────────

class RolloverAvoidanceEngine {
  static checkForex(timestamp) {
    const utcHour = getUTCHour(timestamp);
    const utcDay  = getUTCDay(timestamp);
    const { start, end } = DEFAULTS.ROLLOVER_WINDOW;

    const inRolloverWindow = utcHour >= start && utcHour < end;
    const isTripleSwapDay  = utcDay === 3;

    return {
      inRolloverWindow,
      isTripleSwapDay: inRolloverWindow && isTripleSwapDay,
      note: inRolloverWindow
        ? `Broker rollover window (${start}:00-${end.toFixed(2)} UTC)${isTripleSwapDay ? ' — TRIPLE SWAP Wednesday' : ''} — spreads typically widen`
        : null,
    };
  }

  static checkCrypto(timestamp) {
    const utcHour = getUTCHour(timestamp);
    const settlementHours = [0, 8, 16];
    const nearSettlement = settlementHours.some(h => Math.abs(utcHour - h) <= 0.17 || Math.abs(utcHour - h) >= 23.83);

    return {
      nearFundingSettlement: nearSettlement,
      note: nearSettlement
        ? 'Near perpetual futures funding settlement (00:00/08:00/16:00 UTC) — brief volatility spike possible'
        : null,
    };
  }

  static check(symbol, timestamp) {
    const isCrypto = ['BTC','ETH','BNB','SOL','XRP','ADA','DOGE'].some(t => symbol.includes(t));
    if (isCrypto) {
      const c = this.checkCrypto(timestamp);
      return { blocked: false, sizeMultiplier: c.nearFundingSettlement ? 0.85 : 1.0, ...c };
    }
    const f = this.checkForex(timestamp);
    return {
      blocked: f.inRolloverWindow,
      sizeMultiplier: f.inRolloverWindow ? 0 : 1.0,
      ...f,
    };
  }
}

// ─────────────────────────────────────────────
//  5. INSTITUTIONAL REBALANCING CALENDAR
// ─────────────────────────────────────────────

class InstitutionalRebalancingCalendar {
  static isMonthEnd(timestamp, lookbackDays = 2) {
    const d = new Date(timestamp || Date.now());
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const daysFromEnd = lastDay - d.getUTCDate();

    return {
      isMonthEnd: daysFromEnd <= lookbackDays,
      daysFromEnd,
      note: daysFromEnd <= lookbackDays
        ? `${daysFromEnd} day(s) from month-end — index rebalancing flows possible`
        : null,
    };
  }

  static isQuarterEnd(timestamp) {
    const d = new Date(timestamp || Date.now());
    const month = d.getUTCMonth();
    const isQuarterMonth = [2, 5, 8, 11].includes(month);
    const monthEndCheck = this.isMonthEnd(timestamp, 3);

    return {
      isQuarterEnd: isQuarterMonth && monthEndCheck.isMonthEnd,
      note: isQuarterMonth && monthEndCheck.isMonthEnd
        ? 'Quarter-end window — larger institutional rebalancing flows than typical month-end'
        : null,
    };
  }

  static isQuadWitching(timestamp) {
    const d = new Date(timestamp || Date.now());
    const month = d.getUTCMonth();
    const isQuadMonth = [2, 5, 8, 11].includes(month);
    if (!isQuadMonth) return { isQuadWitching: false, note: null };

    const day = d.getUTCDate();
    const dayOfWeek = d.getUTCDay();
    const isFriday = dayOfWeek === 5;
    const weekOfMonth = Math.ceil(day / 7);
    const isThirdFriday = isFriday && weekOfMonth === 3;

    return {
      isQuadWitching: isThirdFriday,
      note: isThirdFriday
        ? 'Quad witching day — index/options/futures expiry, expect elevated volume and erratic moves especially near close'
        : null,
    };
  }

  static assess(timestamp, assetClass) {
    const monthEnd   = this.isMonthEnd(timestamp);
    const quarterEnd = this.isQuarterEnd(timestamp);
    const quadWitch  = this.isQuadWitching(timestamp);

    const relevant = ['INDICES_US', 'INDICES_EU'].includes(assetClass) || !assetClass;
    if (!relevant) {
      return { hasRebalancingRisk: false, multiplier: 1.0, notes: [] };
    }

    const notes = [monthEnd.note, quarterEnd.note, quadWitch.note].filter(Boolean);
    let multiplier = 1.0;

    if (quadWitch.isQuadWitching) multiplier = 0.75;
    else if (quarterEnd.isQuarterEnd) multiplier = 0.85;
    else if (monthEnd.isMonthEnd) multiplier = 0.92;

    return {
      hasRebalancingRisk: notes.length > 0,
      multiplier: r(multiplier, 2),
      monthEnd, quarterEnd, quadWitch,
      notes,
    };
  }
}

// ─────────────────────────────────────────────
//  6. SESSION BACKTESTER
// ─────────────────────────────────────────────

class SessionBacktester {
  constructor() {
    this._records = [];
  }

  record(entry) {
    this._records.push({
      timestamp:  entry.timestamp || Date.now(),
      utcHour:    getUTCHour(entry.timestamp),
      result:     entry.result,
      pnlPct:     entry.pnlPct ?? 0,
      symbol:     entry.symbol,
      assetClass: entry.assetClass,
    });
    if (this._records.length > 2000) this._records.shift();
  }

  hourlyBuckets(assetClass = null, bucketSizeHours = 2) {
    const filtered = assetClass ? this._records.filter(r => r.assetClass === assetClass) : this._records;
    const buckets = {};

    for (let h = 0; h < 24; h += bucketSizeHours) {
      buckets[h] = { trades: 0, wins: 0, totalPnl: 0, range: `${h}:00-${(h+bucketSizeHours)%24}:00` };
    }

    for (const rec of filtered) {
      const bucketStart = Math.floor(rec.utcHour / bucketSizeHours) * bucketSizeHours;
      if (!buckets[bucketStart]) continue;
      buckets[bucketStart].trades++;
      if (rec.result === 'WIN') buckets[bucketStart].wins++;
      buckets[bucketStart].totalPnl += rec.pnlPct;
    }

    const result = {};
    for (const [hour, data] of Object.entries(buckets)) {
      result[hour] = {
        ...data,
        winRate: data.trades > 0 ? r(data.wins / data.trades * 100, 1) : null,
        avgPnl:  data.trades > 0 ? r(data.totalPnl / data.trades, 3) : null,
      };
    }
    return result;
  }

  compareToLiquidityCurve(assetClass) {
    const buckets = this.hourlyBuckets(assetClass, 2);
    const mismatches = [];

    for (const [hourStr, data] of Object.entries(buckets)) {
      if (data.trades < 8) continue;

      const hour = parseInt(hourStr, 10);
      const expectedLiquidity = LiquidityCurveEngine.getLiquidity(assetClass, hour + 1);
      const expectedGood = expectedLiquidity >= 60;
      const actualGood   = data.winRate >= 50;

      if (expectedGood !== actualGood) {
        mismatches.push({
          hourRange: data.range,
          expectedLiquidity,
          actualWinRate: data.winRate,
          trades: data.trades,
          note: expectedGood && !actualGood
            ? `${data.range}: model expects high liquidity/quality but live win rate is only ${data.winRate}% (${data.trades} trades)`
            : `${data.range}: model expects low liquidity but live win rate is strong at ${data.winRate}% (${data.trades} trades)`,
        });
      }
    }

    return mismatches;
  }

  getBestWorstHours(assetClass, minTrades = 8) {
    const buckets = this.hourlyBuckets(assetClass, 2);
    const valid = Object.entries(buckets).filter(([, d]) => d.trades >= minTrades);
    if (valid.length === 0) return { best: null, worst: null, note: 'Insufficient sample size' };

    valid.sort((a, b) => b[1].avgPnl - a[1].avgPnl);

    return {
      best:  { hour: valid[0][0], ...valid[0][1] },
      worst: { hour: valid[valid.length - 1][0], ...valid[valid.length - 1][1] },
    };
  }

  getStats() {
    return {
      totalRecords: this._records.length,
      assetClasses: [...new Set(this._records.map(r => r.assetClass))],
    };
  }
}

// ─────────────────────────────────────────────
//  ASSET CLASS / INSTRUMENT MAPPING
// ─────────────────────────────────────────────

const SYMBOL_TO_ASSET_CLASS = (symbol) => {
  if (symbol.includes('XAU') || symbol.includes('XAG')) return 'METALS';
  if (['BTC','ETH'].some(t => symbol.includes(t))) return 'CRYPTO_MAJOR';
  if (['BNB','SOL','ADA','XRP','DOGE','AVAX','DOT'].some(t => symbol.includes(t))) return 'CRYPTO_ALT';
  if (['SPX','NAS','US30','US2000'].some(t => symbol.includes(t))) return 'INDICES_US';
  if (['GER40','UK100','FRA40','EU50'].some(t => symbol.includes(t))) return 'INDICES_EU';
  if (['USOIL','UKOIL','CRUDE','NATGAS'].some(t => symbol.includes(t))) return 'OIL_ENERGY';

  const majors = ['EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD'];
  if (majors.includes(symbol)) return 'FOREX_MAJOR';

  return 'FOREX_EXOTIC';
};

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────

function r(n, d = 2) { return parseFloat((n ?? 0).toFixed(d)); }
function avg(arr) { return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length; }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function getUTCHour(timestamp) {
  const d = new Date(timestamp || Date.now());
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}
function getUTCDay(timestamp) {
  return new Date(timestamp || Date.now()).getUTCDay();
}
function getMonthDay(timestamp) {
  const d = new Date(timestamp || Date.now());
  return `${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────
//  HOLIDAY CALENDAR
// ─────────────────────────────────────────────

const FIXED_HOLIDAYS = [
  { date: '01-01', name: "New Year's Day",      affects: ['ALL'] },
  { date: '12-25', name: 'Christmas Day',       affects: ['ALL'] },
  { date: '12-26', name: 'Boxing Day',          affects: ['GBP','EUR'] },
  { date: '07-04', name: 'US Independence Day', affects: ['USD'] },
  { date: '05-01', name: 'Labour Day (EU)',     affects: ['EUR'] },
  { date: '01-26', name: 'Australia Day',       affects: ['AUD'] },
  { date: '07-01', name: 'Canada Day',          affects: ['CAD'] },
  { date: '02-11', name: 'Japan Foundation Day',affects: ['JPY'] },
];

const HALF_DAY_BEFORE = [
  { date: '12-24', name: 'Christmas Eve',  affects: ['ALL'] },
  { date: '12-31', name: "New Year's Eve", affects: ['ALL'] },
  { date: '07-03', name: 'July 4th Eve',   affects: ['USD'] },
];

class HolidayCalendar {
  constructor() { this._customHolidays = []; }

  addHoliday(holiday) { this._customHolidays.push(holiday); }
  addHolidays(holidays) { holidays.forEach(h => this.addHoliday(h)); }

  isHoliday(symbol, timestamp) {
    const monthDay = getMonthDay(timestamp);
    const fullDate  = new Date(timestamp || Date.now()).toISOString().slice(0, 10);
    const currencies = this._symbolCurrencies(symbol);

    for (const h of FIXED_HOLIDAYS) {
      if (h.date === monthDay && this._affects(h.affects, currencies)) {
        return { isHoliday: true, name: h.name, type: 'FIXED', affects: h.affects };
      }
    }
    for (const h of this._customHolidays) {
      if (h.date === fullDate && this._affects(h.affects, currencies)) {
        return { isHoliday: true, name: h.name, type: 'FLOATING', affects: h.affects };
      }
    }
    return { isHoliday: false };
  }

  isHalfDay(symbol, timestamp) {
    const monthDay = getMonthDay(timestamp);
    const currencies = this._symbolCurrencies(symbol);
    for (const h of HALF_DAY_BEFORE) {
      if (h.date === monthDay && this._affects(h.affects, currencies)) {
        return { isHalfDay: true, name: h.name };
      }
    }
    return { isHalfDay: false };
  }

  _symbolCurrencies(symbol) {
    const known = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD','XAU','XAG'];
    return known.filter(c => symbol.includes(c));
  }

  _affects(affects, currencies) {
    return affects.includes('ALL') || affects.some(a => currencies.includes(a));
  }

  getUpcoming(days = 30) {
    const now = Date.now();
    const upcoming = [];
    for (let i = 0; i < days; i++) {
      const ts = now + i * 86400000;
      const md = getMonthDay(ts);
      for (const h of FIXED_HOLIDAYS) {
        if (h.date === md) upcoming.push({ ...h, date: new Date(ts).toISOString().slice(0,10), daysAway: i });
      }
    }
    return upcoming;
  }
}

// ─────────────────────────────────────────────
//  7. MAIN SESSION FILTER CLASS
// ─────────────────────────────────────────────

class SessionFilter {
  constructor(config = {}) {
    this.requireKillzone = config.requireKillzone ?? DEFAULTS.REQUIRE_KILLZONE;
    this.blockDeadZone   = config.blockDeadZone   ?? DEFAULTS.BLOCK_DEAD_ZONE;
    this.blockWeekend    = config.blockWeekend    ?? DEFAULTS.BLOCK_WEEKEND;
    this.blockHolidays   = config.blockHolidays   ?? DEFAULTS.BLOCK_HOLIDAYS;
    this.blockRollover   = config.blockRollover   ?? DEFAULTS.BLOCK_ROLLOVER;

    this.calendar      = new EconomicCalendarTierSystem();
    this.holidays      = new HolidayCalendar();
    this.dynamicScorer = new DynamicKillzoneScorer(config.dynamicScoring || {});
    this.backtester     = new SessionBacktester();
  }

  check(symbol, timestamp) {
    const now = timestamp || Date.now();
    const utcDay = getUTCDay(now);
    const utcHour = getUTCHour(now);
    const assetClass = SYMBOL_TO_ASSET_CLASS(symbol);
    const isCrypto = assetClass.startsWith('CRYPTO');

    const breakdown = { assetClass, utcHour: r(utcHour, 2) };

    // ── 1. Weekend gate ──
    if (this.blockWeekend && !isCrypto) {
      const isFridayClose = utcDay === 5 && utcHour >= 21;
      const isSaturdayAll = utcDay === 6;
      const isSundayPre   = utcDay === 0 && utcHour < 21;
      if (isFridayClose || isSaturdayAll || isSundayPre) {
        return {
          allowed: false,
          reason: `Weekend — ${isFridayClose ? 'Friday close' : isSaturdayAll ? 'Saturday' : 'Sunday pre-open'}`,
          multiplier: 0, breakdown,
        };
      }
    }

    // ── 2. Holiday gate ──
    if (this.blockHolidays && !isCrypto) {
      const holiday = this.holidays.isHoliday(symbol, now);
      if (holiday.isHoliday) {
        return {
          allowed: false,
          reason: `Holiday: ${holiday.name} (${holiday.affects.join(', ')})`,
          multiplier: 0, breakdown,
        };
      }
    }

    // ── 3. Liquidity profile ──
    const liquidityProfile = LiquidityCurveEngine.getProfile(assetClass, utcHour);
    breakdown.liquidity = liquidityProfile;

    if (!liquidityProfile.tradeable) {
      return {
        allowed: false,
        reason: `${assetClass} liquidity too low (${liquidityProfile.liquidity}/100) at ${r(utcHour,1)}:00 UTC — illiquid`,
        multiplier: 0, breakdown,
      };
    }

    if (this.blockDeadZone && liquidityProfile.tier === 'POOR' && !isCrypto) {
      return {
        allowed: false,
        reason: `${assetClass} poor liquidity (${liquidityProfile.liquidity}/100) — dead zone for this instrument`,
        multiplier: 0, breakdown,
      };
    }

    // ── 4. Dynamic killzone adjustment ──
    const dynamicAdj = this.dynamicScorer.getDynamicAdjustment(symbol, utcHour);
    breakdown.dynamicVolatility = dynamicAdj;

    // ── 5. Killzone requirement ──
    if (this.requireKillzone && liquidityProfile.tier !== 'PRIME' && !isCrypto) {
      return {
        allowed: false,
        reason: `Killzone required — current tier is ${liquidityProfile.tier} (${liquidityProfile.liquidity}/100)`,
        multiplier: 0, breakdown,
      };
    }

    // ── 6. Rollover avoidance ──
    if (this.blockRollover) {
      const rollover = RolloverAvoidanceEngine.check(symbol, now);
      breakdown.rollover = rollover;
      if (rollover.blocked) {
        return {
          allowed: false,
          reason: rollover.note,
          multiplier: 0, breakdown,
        };
      }
    }

    // ── 7. Half-day check ──
    const halfDay = this.holidays.isHalfDay(symbol, now);
    breakdown.halfDay = halfDay;

    // ── 8. Economic calendar tier check ──
    const calendarCheck = this.calendar.check(symbol, assetClass, now);
    breakdown.calendar = calendarCheck;

    if (calendarCheck.status === 'BLACKOUT') {
      return {
        allowed: false,
        reason: calendarCheck.reason,
        multiplier: 0, breakdown,
        events: calendarCheck.events,
      };
    }

    // ── 9. Institutional rebalancing windows ──
    const rebalancing = InstitutionalRebalancingCalendar.assess(now, assetClass);
    breakdown.rebalancing = rebalancing;

    // ── Combine all multipliers ──
    let multiplier = liquidityProfile.liquidity / 100;
    multiplier *= dynamicAdj.multiplier;
    multiplier *= calendarCheck.sizeMultiplier;
    multiplier *= rebalancing.multiplier;
    if (halfDay.isHalfDay) multiplier *= 0.7;

    if (breakdown.rollover && !isCrypto) {
      multiplier *= breakdown.rollover.sizeMultiplier ?? 1.0;
    }
    if (isCrypto && breakdown.rollover?.nearFundingSettlement) {
      multiplier *= breakdown.rollover.sizeMultiplier ?? 1.0;
    }

    multiplier = clamp(r(multiplier, 3), DEFAULTS.MIN_QUALITY_MULTIPLIER, DEFAULTS.MAX_QUALITY_MULTIPLIER);

    return {
      allowed: true,
      reason: null,
      multiplier,
      assetClass,
      liquidityTier: liquidityProfile.tier,
      spreadMultiplier: liquidityProfile.spreadMultiplier,
      isPreEvent: calendarCheck.status === 'PRE_EVENT',
      breakdown,
      upcomingHighImpact: this.calendar.getUpcoming(4, 'TIER_1').slice(0, 3),
    };
  }

  // ── Pass-through / data feed methods ──

  addNewsEvent(event)  { this.calendar.addEvent(event); }
  addNewsEvents(events) { this.calendar.addEvents(events); }
  addSpeechEvent(name, currency, timestamp, tier) { this.calendar.addSpeechEvent(name, currency, timestamp, tier); }
  addHoliday(holiday)  { this.holidays.addHoliday(holiday); }
  addHolidays(holidays) { this.holidays.addHolidays(holidays); }

  recordVolatility(symbol, candle, atrPct) {
    this.dynamicScorer.recordVolatility(symbol, candle, atrPct);
  }

  recordOutcome(entry) {
    const assetClass = SYMBOL_TO_ASSET_CLASS(entry.symbol);
    this.backtester.record({ ...entry, assetClass });
  }

  getUpcomingNews(hours = 24, tier = null) { return this.calendar.getUpcoming(hours, tier); }
  getTodayTier1News() { return this.calendar.getTodayTier1(); }
  getUpcomingHolidays(days = 30) { return this.holidays.getUpcoming(days); }

  getLiquidityCurve(assetClass) { return LiquidityCurveEngine.get24HourCurve(assetClass); }
  getBestHours(assetClass, n = 5) { return LiquidityCurveEngine.getBestHours(assetClass, n); }

  getBacktestComparison(assetClass) { return this.backtester.compareToLiquidityCurve(assetClass); }
  getBacktestBestWorst(assetClass) { return this.backtester.getBestWorstHours(assetClass); }

  describeInstrument(symbol) {
    const assetClass = SYMBOL_TO_ASSET_CLASS(symbol);
    const bestHours = LiquidityCurveEngine.getBestHours(assetClass, 3);
    return {
      symbol, assetClass,
      bestHoursUTC: bestHours.map(h => `${h.hour}:00`),
      note: `${symbol} (${assetClass}) — best liquidity around ${bestHours.map(h => h.hour + ':00').join(', ')} UTC`,
    };
  }

  getStats() {
    return {
      config: {
        requireKillzone: this.requireKillzone,
        blockDeadZone:   this.blockDeadZone,
        blockWeekend:    this.blockWeekend,
        blockHolidays:   this.blockHolidays,
        blockRollover:   this.blockRollover,
      },
      upcomingNews:     this.getUpcomingNews(24),
      todayTier1:       this.getTodayTier1News(),
      upcomingHolidays: this.getUpcomingHolidays(14),
      backtester:       this.backtester.getStats(),
      liquidityCurves:  Object.keys(LIQUIDITY_CURVES).reduce((acc, cls) => {
        acc[cls] = LiquidityCurveEngine.getBestHours(cls, 3);
        return acc;
      }, {}),
    };
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  SessionFilter,
  LiquidityCurveEngine,
  DynamicKillzoneScorer,
  EconomicCalendarTierSystem,
  RolloverAvoidanceEngine,
  InstitutionalRebalancingCalendar,
  SessionBacktester,
  HolidayCalendar,
  SYMBOL_TO_ASSET_CLASS,
  LIQUIDITY_CURVES,
  EVENT_TIERS,
  CURRENCY_ASSET_IMPACT,
  FIXED_HOLIDAYS,
  HALF_DAY_BEFORE,
  DEFAULTS,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { SessionFilter } = require('./risk-engine/session-filter');
 *
 *  const sessionFilter = new SessionFilter({
 *    requireKillzone: false,
 *    blockDeadZone:   true,
 *    blockWeekend:    true,
 *    blockHolidays:   true,
 *    blockRollover:   true,
 *  });
 *
 *  sessionFilter.addNewsEvent({
 *    time: new Date('2026-06-20T12:30:00Z').getTime(),
 *    name: 'US NFP', currency: 'USD', tier: 'TIER_1',
 *  });
 *  sessionFilter.addSpeechEvent('Fed Chair Press Conference', 'USD',
 *    new Date('2026-06-20T18:00:00Z').getTime());
 *
 *  sessionFilter.recordVolatility('XAUUSD', candle, atrPct);
 *
 *  const check = sessionFilter.check('XAUUSD');
 *  if (!check.allowed) {
 *    console.log('Blocked:', check.reason);
 *  } else {
 *    console.log('Size multiplier:', check.multiplier);
 *    console.log('Liquidity tier:', check.liquidityTier);
 *  }
 *
 *  sessionFilter.recordOutcome({ symbol: 'XAUUSD', result: 'WIN', pnlPct: 1.5, timestamp: Date.now() });
 *
 *  console.log(sessionFilter.getBacktestComparison('METALS'));
 *  console.log(sessionFilter.getStats());
 * ─────────────────────────────────────────────
 */