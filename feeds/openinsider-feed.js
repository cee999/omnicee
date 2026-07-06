/**
 * ============================================================
 *  OPENINSIDER FEED — SEC Form 4 Insider Trading Data
 *  AI Trading Assistant · Layer 10 · External数据 Feed Module
 *  File: feeds/openinsider-feed.js
 * ============================================================
 *
 *  Integrates insider trading data from OpenInsider.com via:
 *  1. Parse.bot API - Official API wrapper for OpenInsider data
 *  2. Cluster buy detection - Multiple insiders buying same stock
 *  3. Insider sentiment analysis - Aggregate buy/sell ratios
 *  4. CEO/CFO specific tracking - Key executive moves
 *
 *  Insider trading data provides valuable signals:
 *  - Cluster buys = Strong bullish signal
 *  - CEO/CFO buying = High conviction signal
 *  - Extreme selling = Potential warning sign
 * ============================================================
 */

'use strict';

const https = require('https');
const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const PARSE_API_BASE = 'https://api.parse.bot/v1';
const POLL_INTERVAL_MS = 10 * 60000; // 10 minutes
const CLUSTER_WINDOW_DAYS = 5; // Cluster buys within this window
const MIN_CLUSTER_SIZE = 3; // Minimum insiders for cluster

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
//  CLUSTER BUY DETECTOR
// ─────────────────────────────────────────────

class ClusterBuyDetector {
  constructor() {
    this.insiderActivity = new Map(); // ticker → [{ insider, date, type, value }]
  }

  addTrade(trade) {
    const ticker = trade.ticker.toUpperCase();
    if (!this.insiderActivity.has(ticker)) {
      this.insiderActivity.set(ticker, []);
    }
    
    const trades = this.insiderActivity.get(ticker);
    trades.push({
      insider: trade.insiderName,
      title: trade.title,
      date: new Date(trade.tradeDate),
      type: trade.tradeType,
      value: parseFloat(trade.value) || 0,
      shares: parseFloat(trade.qty) || 0,
    });

    // Keep only recent trades (last 30 days)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    this.insiderActivity.set(ticker, trades.filter(t => t.date >= cutoff));
  }

  detectCluster(ticker, windowDays = CLUSTER_WINDOW_DAYS) {
    const trades = this.insiderActivity.get(ticker.toUpperCase());
    if (!trades || trades.length === 0) return null;

    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const recentTrades = trades.filter(t => t.date >= cutoff && t.type === 'Purchase');

    if (recentTrades.length < MIN_CLUSTER_SIZE) return null;

    // Count unique insiders
    const uniqueInsiders = new Set(recentTrades.map(t => t.insider));
    
    if (uniqueInsiders.size < MIN_CLUSTER_SIZE) return null;

    const totalValue = recentTrades.reduce((sum, t) => sum + t.value, 0);
    const totalShares = recentTrades.reduce((sum, t) => sum + t.shares, 0);

    return {
      ticker,
      insiderCount: uniqueInsiders.size,
      tradeCount: recentTrades.length,
      totalValue: round(totalValue),
      totalShares: round(totalShares),
      windowDays,
      signal: 'STRONG_BULLISH',
      confidence: clamp(uniqueInsiders.size * 10 + (totalValue / 100000), 0, 100),
      insiders: [...uniqueInsiders],
      trades: recentTrades,
      timestamp: Date.now(),
    };
  }

  getAllClusters(windowDays = CLUSTER_WINDOW_DAYS) {
    const clusters = [];
    for (const ticker of this.insiderActivity.keys()) {
      const cluster = this.detectCluster(ticker, windowDays);
      if (cluster) clusters.push(cluster);
    }
    return clusters.sort((a, b) => b.confidence - a.confidence);
  }
}

// ─────────────────────────────────────────────
//  INSIDER SENTIMENT ANALYZER
// ─────────────────────────────────────────────

class InsiderSentimentAnalyzer {
  constructor() {
    this.dailyData = new Map(); // date (YYYY-MM-DD) → { buyCount, sellCount, buyValue, sellValue }
  }

  addTrade(trade) {
    const date = trade.tradeDate ? trade.tradeDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const value = parseFloat(trade.value) || 0;
    const type = trade.tradeType;

    if (!this.dailyData.has(date)) {
      this.dailyData.set(date, { buyCount: 0, sellCount: 0, buyValue: 0, sellValue: 0 });
    }

    const dayData = this.dailyData.get(date);
    
    if (type === 'Purchase' || type === 'P - Purchase') {
      dayData.buyCount++;
      dayData.buyValue += value;
    } else if (type === 'Sale' || type === 'S - Sale') {
      dayData.sellCount++;
      dayData.sellValue += value;
    }
  }

  getSentiment(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const relevantDays = [...this.dailyData.entries()]
      .filter(([date]) => new Date(date) >= cutoff);

    if (relevantDays.length === 0) {
      return { sentiment: 'NEUTRAL', confidence: 0, data: null };
    }

    const totals = relevantDays.reduce((acc, [, data]) => ({
      buyCount: acc.buyCount + data.buyCount,
      sellCount: acc.sellCount + data.sellCount,
      buyValue: acc.buyValue + data.buyValue,
      sellValue: acc.sellValue + data.sellValue,
    }), { buyCount: 0, sellCount: 0, buyValue: 0, sellValue: 0 });

    const totalTrades = totals.buyCount + totals.sellCount;
    const buyRatio = totalTrades > 0 ? totals.buyCount / totalTrades : 0;
    const valueRatio = (totals.buyValue + totals.sellValue) > 0 
      ? totals.buyValue / (totals.buyValue + totals.sellValue) 
      : 0;

    // Weight value ratio more heavily (large trades matter more)
    const weightedBullishness = (buyRatio * 0.3) + (valueRatio * 0.7);

    let sentiment = 'NEUTRAL';
    if (weightedBullishness >= 0.7) sentiment = 'STRONGLY_BULLISH';
    else if (weightedBullishness >= 0.55) sentiment = 'BULLISH';
    else if (weightedBullishness <= 0.3) sentiment = 'STRONGLY_BEARISH';
    else if (weightedBullishness <= 0.45) sentiment = 'BEARISH';

    return {
      sentiment,
      confidence: clamp(totalTrades * 2, 0, 100),
      buyRatio: round(buyRatio * 100, 1),
      sellRatio: round((1 - buyRatio) * 100, 1),
      buyValue: round(totals.buyValue),
      sellValue: round(totals.sellValue),
      totalTrades,
      daysAnalyzed: relevantDays.length,
      weightedBullishness: round(weightedBullishness * 100, 1),
    };
  }

  getTickerSentiment(ticker, days = 30) {
    // This would require ticker-specific data storage
    // For now, return overall sentiment
    return this.getSentiment(days);
  }
}

// ─────────────────────────────────────────────
//  KEY EXECUTIVE TRACKER
// ─────────────────────────────────────────────

class KeyExecutiveTracker {
  constructor() {
    this.executiveTrades = new Map(); // ticker → [{ insider, title, type, value, date }]
  }

  addTrade(trade) {
    const ticker = trade.ticker.toUpperCase();
    const title = (trade.title || '').toLowerCase();
    
    // Track CEO, CFO, and other key executives
    const isKeyExecutive = title.includes('ceo') || 
                          title.includes('chief executive officer') ||
                          title.includes('cfo') || 
                          title.includes('chief financial officer') ||
                          title.includes('president') ||
                          title.includes('director') ||
                          title.includes('officer');

    if (!isKeyExecutive) return;

    if (!this.executiveTrades.has(ticker)) {
      this.executiveTrades.set(ticker, []);
    }

    this.executiveTrades.get(ticker).push({
      insider: trade.insiderName,
      title: trade.title,
      type: trade.tradeType,
      value: parseFloat(trade.value) || 0,
      date: new Date(trade.tradeDate),
    });

    // Keep last 90 days
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    this.executiveTrades.set(ticker, 
      this.executiveTrades.get(ticker).filter(t => t.date >= cutoff)
    );
  }

  getExecutiveActivity(ticker) {
    const trades = this.executiveTrades.get(ticker.toUpperCase());
    if (!trades || trades.length === 0) return null;

    const recentTrades = trades.filter(t => 
      (Date.now() - t.date.getTime()) < 30 * 24 * 60 * 60 * 1000
    );

    if (recentTrades.length === 0) return null;

    const buys = recentTrades.filter(t => t.type === 'Purchase');
    const sells = recentTrades.filter(t => t.type === 'Sale');

    return {
      ticker,
      totalTrades: recentTrades.length,
      buyCount: buys.length,
      sellCount: sells.length,
      totalBuyValue: round(buys.reduce((sum, t) => sum + t.value, 0)),
      totalSellValue: round(sells.reduce((sum, t) => sum + t.value, 0)),
      recentActivity: recentTrades.slice(-10),
      signal: buys.length > sells.length * 2 ? 'BULLISH' 
             : sells.length > buys.length * 2 ? 'BEARISH' 
             : 'NEUTRAL',
      timestamp: Date.now(),
    };
  }

  getAllExecutiveActivity() {
    const activity = [];
    for (const ticker of this.executiveTrades.keys()) {
      const data = this.getExecutiveActivity(ticker);
      if (data) activity.push(data);
    }
    return activity;
  }
}

// ─────────────────────────────────────────────
//  MAIN OPENINSIDER FEED CLASS
// ─────────────────────────────────────────────

class OpenInsiderFeed extends EventEmitter {
  constructor(config = {}) {
    super();

    this.apiKey = config.apiKey;
    this.useParseAPI = config.useParseAPI !== false; // Default to Parse API
    
    this.clusterDetector = new ClusterBuyDetector();
    this.sentimentAnalyzer = new InsiderSentimentAnalyzer();
    this.executiveTracker = new KeyExecutiveTracker();
    
    this.pollIntervalMs = config.pollIntervalMs || POLL_INTERVAL_MS;
    this._pollTimer = null;
    this._connected = false;

    this._stats = {
      tradesProcessed: 0,
      clustersDetected: 0,
      executiveTrades: 0,
      errors: 0,
      startTime: null,
    };
    // FIX: cluster novelty was tracked by array length/position, but
    // getAllClusters() re-sorts by confidence every call — so a previously
    // emitted cluster could shift position and get re-emitted as "new"
    // while an actually-new cluster could be skipped. Track by ticker instead.
    this._emittedClusters = new Set();
  }

  async connect() {
    console.log('[OpenInsider] Connecting...');
    this._stats.startTime = Date.now();

    if (!this.apiKey && this.useParseAPI) {
      console.warn('[OpenInsider] No API key provided - using mock mode');
      this._connected = true;
      this.emit('ready', { mode: 'mock' });
      return;
    }

    try {
      await this._fetchLatestInsiderTrades();
      this._connected = true;
      
      this._pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
      
      this.emit('ready', { sources: ['insider_trading', 'cluster_buys', 'executive_activity'] });
      console.log('[OpenInsider] Connected successfully');
    } catch (err) {
      console.error('[OpenInsider] Connection failed:', err.message);
      this._stats.errors++;
      this.emit('error', { source: 'connection', error: err });
    }
  }

  async _poll() {
    if (!this._connected) return;

    try {
      await this._fetchLatestInsiderTrades();
    } catch (err) {
      this._stats.errors++;
      this.emit('error', { source: 'poll', error: err });
    }
  }

  async _fetchLatestInsiderTrades() {
    if (!this.useParseAPI || !this.apiKey) {
      // Mock mode for testing
      return;
    }

    try {
      const url = `${PARSE_API_BASE}/open-insider-scraper/run?token=${this.apiKey}`;
      const response = await httpGetJSON(url);

      if (response.error) {
        throw new Error(response.message);
      }

      const trades = response.data || response.items || [];
      
      for (const trade of trades) {
        this._processTrade(trade);
        this._stats.tradesProcessed++;
      }

      // Check for new clusters
      const clusters = this.clusterDetector.getAllClusters();
      const currentTickers = new Set(clusters.map(c => c.ticker));
      const newClusters = clusters.filter(c => !this._emittedClusters.has(c.ticker));
      this._stats.clustersDetected = clusters.length;

      for (const cluster of newClusters) {
        this._emittedClusters.add(cluster.ticker);
        this.emit('cluster_buy', cluster);
      }
      // Prune tickers whose cluster has dissolved so a future re-formed
      // cluster on the same ticker is treated as new again.
      for (const ticker of this._emittedClusters) {
        if (!currentTickers.has(ticker)) this._emittedClusters.delete(ticker);
      }

      // Check executive activity
      const execActivity = this.executiveTracker.getAllExecutiveActivity();
      for (const activity of execActivity) {
        if (activity.signal !== 'NEUTRAL') {
          this.emit('executive_activity', activity);
        }
      }

    } catch (err) {
      console.error('[OpenInsider] Failed to fetch trades:', err.message);
      throw err;
    }
  }

  _processTrade(trade) {
    // Add to cluster detector
    this.clusterDetector.addTrade(trade);
    
    // Add to sentiment analyzer
    this.sentimentAnalyzer.addTrade(trade);
    
    // Add to executive tracker
    this.executiveTracker.addTrade(trade);
  }

  // ── Public Query API ──

  getClusterBuy(ticker) {
    return this.clusterDetector.detectCluster(ticker);
  }

  getAllClusters() {
    return this.clusterDetector.getAllClusters();
  }

  getSentiment(days = 30) {
    return this.sentimentAnalyzer.getSentiment(days);
  }

  getTickerSentiment(ticker, days = 30) {
    return this.sentimentAnalyzer.getTickerSentiment(ticker, days);
  }

  getExecutiveActivity(ticker) {
    return this.executiveTracker.getExecutiveActivity(ticker);
  }

  getAllExecutiveActivity() {
    return this.executiveTracker.getAllExecutiveActivity();
  }

  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return {
      ...this._stats,
      uptime,
      connected: this._connected,
      tickersTracked: this.clusterDetector.insiderActivity.size,
      clustersActive: this.clusterDetector.getAllClusters().length,
    };
  }

  disconnect() {
    console.log('[OpenInsider] Disconnecting...');
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._connected = false;
    this.emit('closed');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  OpenInsiderFeed,
  ClusterBuyDetector,
  InsiderSentimentAnalyzer,
  KeyExecutiveTracker,
};
