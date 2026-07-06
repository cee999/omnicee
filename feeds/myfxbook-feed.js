/**
 * ============================================================
 *  MYFXBOOK FEED — Economic Calendar, Social Signals, Community Data
 *  AI Trading Assistant · Layer 10 · External数据 Feed Module
 *  File: feeds/myfxbook-feed.js
 * ============================================================
 *
 *  Integrates Myfxbook.com data sources:
 *  1. Economic Calendar - High-impact events with forecasts vs actuals
 *  2. Community Sentiment - Retail positioning data
 *  3. Top Traders - Track successful trader positions
 *  4. Economic Indicators - Interest rates, inflation, employment
 *
 *  This feed provides institutional-grade macro intelligence
 *  and contrarian signals from retail positioning extremes.
 * ============================================================
 */

'use strict';

const https = require('https');
const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const BASE_URL = 'https://www.myfxbook.com';
const API_BASE = `${BASE_URL}/api`;
const POLL_INTERVAL_MS = 5 * 60000; // 5 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function round(n, d = 2) { return parseFloat((n ?? 0).toFixed(d)); }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// ─────────────────────────────────────────────
//  HTTP CLIENT
// ─────────────────────────────────────────────

function httpGetJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse: ${data.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────
//  SESSION MANAGER
// ─────────────────────────────────────────────

class SessionManager {
  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.session = null;
    this.sessionExpiry = null;
  }

  async login() {
    if (this.session && this.sessionExpiry && Date.now() < this.sessionExpiry) {
      return this.session;
    }

    const url = `${API_BASE}/login.json?email=${encodeURIComponent(this.email)}&password=${encodeURIComponent(this.password)}`;
    try {
      const response = await httpGetJSON(url);
      if (response.error) {
        throw new Error(`Login failed: ${response.message}`);
      }
      this.session = response.session;
      this.sessionExpiry = Date.now() + SESSION_TTL_MS;
      console.log('[Myfxbook] Login successful');
      return this.session;
    } catch (err) {
      console.error('[Myfxbook] Login error:', err.message);
      throw err;
    }
  }

  async logout() {
    if (!this.session) return;
    try {
      await httpGetJSON(`${API_BASE}/logout.json?session=${this.session}`);
      this.session = null;
      this.sessionExpiry = null;
      console.log('[Myfxbook] Logged out');
    } catch (err) {
      console.error('[Myfxbook] Logout error:', err.message);
    }
  }

  getSession() { return this.session; }
}

// ─────────────────────────────────────────────
//  ECONOMIC CALENDAR PARSER
// ─────────────────────────────────────────────

class EconomicCalendarParser {
  /**
   * Parses economic calendar events and identifies:
   * - High-impact events
   * - Forecast vs actual deviations (surprises)
   * - Currency-affected events
   */
  static parse(events) {
    const highImpact = events.filter(e => 
      e.impact === 'high' || e.impact === 'High' || e.importance === '3'
    );

    const surprises = highImpact
      .filter(e => e.actual && e.forecast && e.actual !== 'N/A' && e.forecast !== 'N/A')
      .map(e => {
        const actual = parseFloat(e.actual);
        const forecast = parseFloat(e.forecast);
        const deviation = forecast !== 0 ? ((actual - forecast) / Math.abs(forecast)) * 100 : 0;
        
        return {
          ...e,
          deviation: round(deviation, 2),
          surprise: Math.abs(deviation) > 10 ? 'HIGH' : Math.abs(deviation) > 5 ? 'MEDIUM' : 'LOW',
          direction: actual > forecast ? 'BETTER_THAN_EXPECTED' : actual < forecast ? 'WORSE_THAN_EXPECTED' : 'IN_LINE',
        };
      })
      .filter(e => Math.abs(e.deviation) > 2); // Only meaningful deviations

    return {
      totalEvents: events.length,
      highImpactCount: highImpact.length,
      surprises,
      upcomingHighImpact: highImpact.filter(e => new Date(e.date) > new Date()).slice(0, 5),
    };
  }

  static getAffectedCurrencies(event) {
    const text = `${event.currency} ${event.name} ${event.country}`.toLowerCase();
    const currencies = [];
    
    const map = {
      USD: ['usd', 'dollar', 'united states', 'fomc', 'federal reserve', 'nfp', 'non-farm'],
      EUR: ['eur', 'euro', 'eurozone', 'ecb', 'european union'],
      GBP: ['gbp', 'pound', 'uk', 'united kingdom', 'boe', 'bank of england'],
      JPY: ['jpy', 'yen', 'japan', 'boj', 'bank of japan'],
      AUD: ['aud', 'australia', 'rba'],
      CAD: ['cad', 'canada', 'boc'],
      CHF: ['chf', 'swiss', 'snb'],
      NZD: ['nzd', 'new zealand', 'rbnz'],
    };

    for (const [curr, keywords] of Object.entries(map)) {
      if (keywords.some(k => text.includes(k))) currencies.push(curr);
    }

    return currencies;
  }
}

// ─────────────────────────────────────────────
//  COMMUNITY SENTIMENT ANALYZER
// ─────────────────────────────────────────────

class CommunitySentimentAnalyzer {
  /**
   * Analyzes retail positioning for contrarian signals.
   * Extreme retail positioning often precedes reversals.
   */
  static analyze(sentimentData) {
    if (!sentimentData || !sentimentData.longPercentage) {
      return null;
    }

    const longPct = parseFloat(sentimentData.longPercentage);
    const shortPct = 100 - longPct;
    
    // Contrarian logic: extreme retail long = bearish signal, extreme retail short = bullish signal
    let signal = 'NEUTRAL';
    let contrarianReason = null;

    if (longPct >= 75) {
      signal = 'BEARISH_CONTRARIAN';
      contrarianReason = `Retail extremely long (${longPct}%) - potential reversal risk`;
    } else if (longPct <= 25) {
      signal = 'BULLISH_CONTRARIAN';
      contrarianReason = `Retail extremely short (${shortPct}%) - potential bounce opportunity`;
    } else if (longPct >= 60) {
      signal = 'SLIGHTLY_BEARISH_CONTRARIAN';
      contrarianReason = `Retail biased long (${longPct}%) - monitor for reversal`;
    } else if (longPct <= 40) {
      signal = 'SLIGHTLY_BULLISH_CONTRARIAN';
      contrarianReason = `Retail biased short (${shortPct}%) - monitor for bounce`;
    }

    return {
      longPercentage: longPct,
      shortPercentage: shortPct,
      signal,
      contrarianReason,
      extreme: longPct >= 75 || longPct <= 25,
      timestamp: Date.now(),
    };
  }
}

// ─────────────────────────────────────────────
//  TOP TRADERS TRACKER
// ─────────────────────────────────────────────

class TopTradersTracker {
  constructor() {
    this.traders = new Map(); // traderId → { positions, performance, lastUpdate }
  }

  updateTrader(traderId, data) {
    this.traders.set(traderId, {
      ...data,
      lastUpdate: Date.now(),
    });
  }

  getConsensus(symbol) {
    const relevantTraders = [...this.traders.values()]
      .filter(t => t.positions && t.positions.some(p => p.symbol === symbol));

    if (relevantTraders.length === 0) return null;

    const positions = relevantTraders
      .flatMap(t => t.positions.filter(p => p.symbol === symbol));

    const longCount = positions.filter(p => p.type === 'long' || p.type === 'buy').length;
    const shortCount = positions.filter(p => p.type === 'short' || p.type === 'sell').length;
    const total = longCount + shortCount;

    if (total === 0) return null;

    const longPct = (longCount / total) * 100;
    
    return {
      symbol,
      longCount,
      shortCount,
      longPercentage: round(longPct, 1),
      shortPercentage: round(100 - longPct, 1),
      sampleSize: relevantTraders.length,
      consensus: longPct >= 60 ? 'BULLISH' : longPct <= 40 ? 'BEARISH' : 'NEUTRAL',
      timestamp: Date.now(),
    };
  }

  getTopPerformers(n = 10) {
    return [...this.traders.values()]
      .sort((a, b) => (b.gain || 0) - (a.gain || 0))
      .slice(0, n);
  }
}

// ─────────────────────────────────────────────
//  MAIN MYFXBOOK FEED CLASS
// ─────────────────────────────────────────────

class MyfxbookFeed extends EventEmitter {
  constructor(config = {}) {
    super();

    this.email = config.email;
    this.password = config.password;
    this.sessionManager = new SessionManager(this.email, this.password);
    
    this.topTradersTracker = new TopTradersTracker();
    this.calendarData = [];
    this.sentimentData = new Map(); // symbol → sentiment
    
    this.pollIntervalMs = config.pollIntervalMs || POLL_INTERVAL_MS;
    this._pollTimer = null;
    this._connected = false;

    this._stats = {
      calendarEventsProcessed: 0,
      sentimentUpdates: 0,
      traderUpdates: 0,
      errors: 0,
      startTime: null,
    };
  }

  async connect() {
    console.log('[Myfxbook] Connecting...');
    this._stats.startTime = Date.now();

    try {
      await this.sessionManager.login();
      this._connected = true;
      
      // Initial data fetch
      await this._fetchEconomicCalendar();
      await this._fetchCommunitySentiment();
      // FIX: _fetchTopTraders() was fully implemented but never called
      // anywhere — topTradersTracker stayed permanently empty, so
      // getTraderConsensus()/getTopPerformers() always returned null.
      await this._fetchTopTraders();
      
      // Start polling
      this._pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
      
      this.emit('ready', { sources: ['economic_calendar', 'community_sentiment', 'top_traders'] });
      console.log('[Myfxbook] Connected successfully');
    } catch (err) {
      console.error('[Myfxbook] Connection failed:', err.message);
      this._stats.errors++;
      this.emit('error', { source: 'connection', error: err });
    }
  }

  async _poll() {
    if (!this._connected) return;

    try {
      await Promise.all([
        this._fetchEconomicCalendar(),
        this._fetchCommunitySentiment(),
        this._fetchTopTraders(),
      ]);
    } catch (err) {
      this._stats.errors++;
      this.emit('error', { source: 'poll', error: err });
    }
  }

  async _fetchEconomicCalendar() {
    if (!this.sessionManager.getSession()) return;

    try {
      const session = this.sessionManager.getSession();
      const url = `${API_BASE}/get-economic-calendar.json?session=${session}`;
      const response = await httpGetJSON(url);

      if (response.error) {
        throw new Error(response.message);
      }

      const parsed = EconomicCalendarParser.parse(response.economicCalendar || []);
      this.calendarData = parsed;
      this._stats.calendarEventsProcessed += parsed.totalEvents;

      // Emit high-impact surprises
      for (const surprise of parsed.surprises) {
        if (surprise.surprise === 'HIGH') {
          const affectedCurrencies = EconomicCalendarParser.getAffectedCurrencies(surprise);
          this.emit('economic_surprise', {
            event: surprise,
            affectedCurrencies,
            impact: surprise.direction === 'BETTER_THAN_EXPECTED' ? 'POSITIVE' : 'NEGATIVE',
          });
        }
      }

      // Emit upcoming high-impact events
      if (parsed.upcomingHighImpact.length > 0) {
        this.emit('upcoming_events', {
          events: parsed.upcomingHighImpact,
          count: parsed.upcomingHighImpact.length,
        });
      }
    } catch (err) {
      console.error('[Myfxbook] Failed to fetch economic calendar:', err.message);
      throw err;
    }
  }

  async _fetchCommunitySentiment() {
    if (!this.sessionManager.getSession()) return;

    try {
      const session = this.sessionManager.getSession();
      const url = `${API_BASE}/get-community-sentiment.json?session=${session}`;
      const response = await httpGetJSON(url);

      if (response.error) {
        throw new Error(response.message);
      }

      for (const [symbol, sentiment] of Object.entries(response.communitySentiment || {})) {
        const analyzed = CommunitySentimentAnalyzer.analyze(sentiment);
        if (analyzed) {
          this.sentimentData.set(symbol, analyzed);
          this._stats.sentimentUpdates++;

          if (analyzed.extreme) {
            this.emit('extreme_retail_positioning', {
              symbol,
              data: analyzed,
            });
          }
        }
      }
    } catch (err) {
      console.error('[Myfxbook] Failed to fetch community sentiment:', err.message);
      throw err;
    }
  }

  async _fetchTopTraders() {
    if (!this.sessionManager.getSession()) return;

    try {
      const session = this.sessionManager.getSession();
      const url = `${API_BASE}/get-top-traders.json?session=${session}`;
      const response = await httpGetJSON(url);

      if (response.error) {
        throw new Error(response.message);
      }

      for (const trader of response.topTraders || []) {
        this.topTradersTracker.updateTrader(trader.id, trader);
        this._stats.traderUpdates++;
      }
    } catch (err) {
      console.error('[Myfxbook] Failed to fetch top traders:', err.message);
      throw err;
    }
  }

  // ── Public Query API ──

  getEconomicCalendar() { return this.calendarData; }
  getCommunitySentiment(symbol) { return this.sentimentData.get(symbol) || null; }
  getTraderConsensus(symbol) { return this.topTradersTracker.getConsensus(symbol); }
  getTopPerformers(n) { return this.topTradersTracker.getTopPerformers(n); }

  getUpcomingEvents(currency = null, hours = 24) {
    const cutoff = new Date(Date.now() + hours * 60 * 60 * 1000);
    let events = this.calendarData.upcomingHighImpact || [];
    
    if (currency) {
      events = events.filter(e => {
        const affected = EconomicCalendarParser.getAffectedCurrencies(e);
        return affected.includes(currency);
      });
    }

    return events.filter(e => new Date(e.date) <= cutoff);
  }

  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return {
      ...this._stats,
      uptime,
      connected: this._connected,
      symbolsTracked: this.sentimentData.size,
      tradersTracked: this.topTradersTracker.traders.size,
    };
  }

  disconnect() {
    console.log('[Myfxbook] Disconnecting...');
    if (this._pollTimer) clearInterval(this._pollTimer);
    this.sessionManager.logout();
    this._connected = false;
    this.emit('closed');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  MyfxbookFeed,
  EconomicCalendarParser,
  CommunitySentimentAnalyzer,
  TopTradersTracker,
  SessionManager,
};
