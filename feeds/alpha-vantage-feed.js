/**
 * ============================================================
 *  ALPHA VANTAGE FEED — Macro News Sentiment
 *  File: feeds/alpha-vantage-feed.js
 * ============================================================
 *  Polls Alpha Vantage's NEWS_SENTIMENT endpoint for broad
 *  financial-market and macroeconomic news, and emits an
 *  aggregate sentiment score plus the most relevant headline.
 *  Optional — if ALPHA_VANTAGE_API_KEY is unset, this feed
 *  never starts polling and index.js simply skips it (same
 *  graceful-degradation convention as every other feed here).
 * ============================================================
 */

'use strict';

const https = require('https');
const EventEmitter = require('events');

const BASE_URL = 'https://www.alphavantage.co/query';
const DEFAULT_POLL_MS = 15 * 60000; // Alpha Vantage free tier: 25 req/day — poll conservatively
const DEFAULT_TOPICS = 'financial_markets,economy_macro,economy_monetary';

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse Alpha Vantage response: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function round(n, d = 3) { return Math.round((n ?? 0) * 10 ** d) / 10 ** d; }

// Alpha Vantage's own bucket thresholds, from their docs.
function labelFor(score) {
  if (score <= -0.35) return 'Bearish';
  if (score <= -0.15) return 'Somewhat-Bearish';
  if (score < 0.15) return 'Neutral';
  if (score < 0.35) return 'Somewhat-Bullish';
  return 'Bullish';
}

class AlphaVantageFeed extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.ALPHA_VANTAGE_API_KEY || '';
    this.topics = config.topics || DEFAULT_TOPICS;
    this.pollIntervalMs = Number(config.pollIntervalMs || process.env.ALPHA_VANTAGE_POLL_MS || DEFAULT_POLL_MS);
    this._lastLabel = null;
    this._pollTimer = null;

    if (this.enabled()) {
      // Fire once immediately, then on the interval — same convention as
      // MyfxbookFeed/OpenInsiderFeed (feeds/*.js), not an unbounded loop.
      this._poll();
      this._pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
    }
  }

  enabled() {
    return Boolean(this.apiKey);
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  async _poll() {
    try {
      const url = `${BASE_URL}?function=NEWS_SENTIMENT&topics=${encodeURIComponent(this.topics)}&sort=LATEST&limit=50&apikey=${this.apiKey}`;
      const result = await httpGetJSON(url);

      // Alpha Vantage returns a 200 with a plain-text `Note`/`Information`
      // field instead of an error status when the daily quota is hit — a
      // classic silent-failure shape if not checked explicitly.
      if (result?.Note || result?.Information) {
        throw new Error(result.Note || result.Information);
      }

      const feed = Array.isArray(result?.feed) ? result.feed : [];
      if (feed.length === 0) return;

      const avgScore = feed.reduce((sum, a) => sum + (Number(a.overall_sentiment_score) || 0), 0) / feed.length;
      const label = labelFor(avgScore);
      const top = feed.reduce((best, a) =>
        Math.abs(a.overall_sentiment_score) > Math.abs(best.overall_sentiment_score || 0) ? a : best, feed[0]);

      const payload = {
        score: round(avgScore),
        label,
        articleCount: feed.length,
        topHeadline: top?.title || null,
        topUrl: top?.url || null,
        topSource: top?.source || null,
      };

      // Only emit when the bucket actually changes, not every single poll —
      // avoids spamming the intel feed/Telegram with "still Neutral" noise.
      if (label !== this._lastLabel) {
        this._lastLabel = label;
        this.emit('sentiment_shift', payload);
      }
      this.emit('sentiment_update', payload);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

module.exports = { AlphaVantageFeed };
