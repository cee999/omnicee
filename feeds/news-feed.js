/**
 * ============================================================
 *  NEWS FEED — Sentiment, NLP & Macro Intelligence Engine
 *  AI Trading Assistant · Layer 10 · Data Feed Module
 *  File: feeds/news-feed.js
 * ============================================================
 *
 *  This feed has no single "exchange" source — it aggregates and
 *  interprets text/data that moves markets but isn't price data.
 *
 *  Modules inside this file:
 *
 *  1. NewsIngestionEngine
 *     - Polls configurable news source endpoints (RSS/JSON APIs)
 *     - Deduplicates headlines across sources
 *     - Tags each headline with affected currencies/assets
 *
 *  2. SentimentLexicon
 *     - Hand-built financial sentiment dictionary (hawkish/dovish,
 *       bullish/bearish, risk-on/risk-off vocabulary) — works
 *       without an external NLP API as a fast first-pass filter
 *     - Scores headlines -100 to +100
 *
 *  3. ClaudeNLPAnalyzer
 *     - Optional deeper analysis via Claude API for headlines that
 *       pass the lexicon's "significant" threshold — full reasoning
 *       on hawkish/dovish tone, market impact forecast
 *     - Pure interface here; actual API call wired by the caller
 *       (keeps this file dependency-free / testable standalone)
 *
 *  4. CentralBankToneTracker
 *     - Tracks Fed/ECB/BOE/BOJ statement language over time
 *     - Detects hawkish→dovish (or reverse) tone shifts between
 *       consecutive statements — often a bigger signal than the
 *       headline rate decision itself
 *
 *  5. COTReportParser
 *     - Parses CFTC Commitment of Traders report data
 *     - Computes commercial/large-spec/small-spec net positioning
 *     - Flags extreme positioning (historically high reversal odds)
 *     - Week-over-week positioning change (momentum in positioning)
 *
 *  6. FearGreedEngine
 *     - Composite fear/greed index from available inputs:
 *       volatility regime, funding rates (if fed from feeds),
 *       safe-haven flows, news sentiment aggregate
 *
 *  7. SocialSentimentProxy
 *     - Lightweight interface for crypto-twitter / forum sentiment
 *       feeds — pluggable, since most require paid APIs
 *
 *  8. NewsFeed (main class)
 *     - EventEmitter API: 'headline', 'sentiment_shift', 'cot_update',
 *       'central_bank_tone_shift', 'extreme_positioning'
 * ============================================================
 */

'use strict';

const https        = require('https');
const EventEmitter = require('events');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const MAX_HEADLINE_HISTORY = 500;
const DEDUP_WINDOW_MS = 30 * 60000; // headlines within 30min with similar text = duplicate
const SIGNIFICANT_SENTIMENT_THRESHOLD = 40; // |score| above this triggers deeper analysis
const COT_EXTREME_PERCENTILE = 90; // positioning above this percentile (of trailing 3yr) = extreme

function round(n, d = 2) { return parseFloat((n ?? 0).toFixed(d)); }
function avg(arr) { return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length; }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

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
//  2. SENTIMENT LEXICON
// ─────────────────────────────────────────────

const LEXICON = {
  // Central bank tone
  HAWKISH: ['rate hike','tightening','restrictive','inflation concern','overheating','raise rates','hawkish','aggressive tightening','higher for longer','combat inflation'],
  DOVISH:  ['rate cut','easing','accommodative','stimulus','rate pause','dovish','support growth','lower rates','soft landing concern','pivot'],

  // Macro sentiment
  BULLISH_ECONOMY: ['beat expectations','strong growth','robust','better than forecast','expansion','resilient economy','outperform','upside surprise'],
  BEARISH_ECONOMY: ['miss expectations','weak growth','recession','contraction','downturn','worse than forecast','slowdown','below forecast'],

  // Risk sentiment
  RISK_ON:  ['risk appetite','rally','optimism','record high','bull market','investor confidence','risk-on'],
  RISK_OFF: ['risk aversion','sell-off','panic','flight to safety','bear market','uncertainty','risk-off','contagion','crisis'],

  // Crypto-specific
  CRYPTO_BULLISH: ['institutional adoption','etf approval','accumulation','breakout','all-time high','bullish momentum','inflow'],
  CRYPTO_BEARISH: ['regulatory crackdown','ban','hack','exploit','liquidation cascade','outflow','bearish momentum','sec lawsuit'],

  // Geopolitical
  GEOPOLITICAL_NEGATIVE: ['war','conflict','sanctions','invasion','military action','escalation','tension'],
  GEOPOLITICAL_POSITIVE: ['ceasefire','peace talks','de-escalation','agreement reached','trade deal'],
};

const LEXICON_WEIGHTS = {
  HAWKISH: -1, DOVISH: 1, // for risk assets; inverted for USD strength context separately
  BULLISH_ECONOMY: 1, BEARISH_ECONOMY: -1,
  RISK_ON: 1, RISK_OFF: -1,
  CRYPTO_BULLISH: 1, CRYPTO_BEARISH: -1,
  GEOPOLITICAL_NEGATIVE: -1, GEOPOLITICAL_POSITIVE: 1,
};

class SentimentLexicon {
  /**
   * Scores a headline -100 to +100 using keyword matching.
   * Fast, dependency-free first-pass filter before optional deeper
   * Claude NLP analysis on "significant" headlines.
   */
  static score(text) {
    const lower = text.toLowerCase();
    const matches = [];
    let rawScore = 0;

    for (const [category, phrases] of Object.entries(LEXICON)) {
      for (const phrase of phrases) {
        if (lower.includes(phrase)) {
          const weight = LEXICON_WEIGHTS[category];
          rawScore += weight;
          matches.push({ category, phrase, weight });
        }
      }
    }

    // Scale to -100..100 with diminishing returns for many matches
    const scaled = clamp(Math.sign(rawScore) * Math.min(Math.abs(rawScore) * 15, 100), -100, 100);

    return {
      score: round(scaled, 1),
      rawMatchCount: matches.length,
      matches,
      classification: scaled > 30 ? 'BULLISH' : scaled < -30 ? 'BEARISH' : 'NEUTRAL',
      significant: Math.abs(scaled) >= SIGNIFICANT_SENTIMENT_THRESHOLD,
    };
  }

  /**
   * Detects which currencies/assets a headline likely affects based
   * on simple keyword presence — used to route sentiment into the
   * right symbol's analysis pipeline.
   */
  static detectAffectedAssets(text) {
    const lower = text.toLowerCase();
    const affected = [];

    const map = {
      USD: ['fed','federal reserve','fomc','powell','us economy','dollar','treasury'],
      EUR: ['ecb','lagarde','eurozone','euro','european central bank'],
      GBP: ['boe','bank of england','bailey','uk economy','pound sterling'],
      JPY: ['boj','bank of japan','ueda','japan economy','yen'],
      AUD: ['rba','australia economy','aussie'],
      CAD: ['boc','bank of canada','canada economy'],
      XAU: ['gold','safe haven','precious metal'],
      BTC: ['bitcoin','crypto','digital asset'],
      ETH: ['ethereum'],
      OIL: ['opec','crude oil','oil price','wti','brent'],
    };

    for (const [asset, keywords] of Object.entries(map)) {
      if (keywords.some(k => lower.includes(k))) affected.push(asset);
    }

    return affected;
  }
}

// ─────────────────────────────────────────────
//  3. CLAUDE NLP ANALYZER (interface)
// ─────────────────────────────────────────────

class ClaudeNLPAnalyzer {
  /**
   * This class defines the INTERFACE for deeper NLP analysis but does
   * not make the API call itself — that's wired by the caller (e.g.
   * task-planner.js or a dedicated worker) using whatever Claude API
   * client the project already has configured. Keeping this file
   * dependency-free means it can be tested without API credentials.
   *
   * Usage pattern:
   *   const prompt = ClaudeNLPAnalyzer.buildPrompt(headline);
   *   const response = await yourClaudeClient.complete(prompt);
   *   const parsed = ClaudeNLPAnalyzer.parseResponse(response);
   */
  static buildPrompt(headline, context = {}) {
    return [
      'Analyze this financial news headline for trading-relevant sentiment.',
      '',
      `Headline: "${headline.text}"`,
      headline.source ? `Source: ${headline.source}` : '',
      context.affectedAssets ? `Likely affects: ${context.affectedAssets.join(', ')}` : '',
      '',
      'Respond with ONLY a JSON object (no other text):',
      '{',
      '  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",',
      '  "confidence": 0-100,',
      '  "tone": "hawkish" | "dovish" | "neutral" (if central-bank related, else null),',
      '  "marketImpact": "HIGH" | "MEDIUM" | "LOW",',
      '  "affectedAssets": ["USD", "XAU", ...],',
      '  "reasoning": "one sentence explanation"',
      '}',
    ].filter(Boolean).join('\n');
  }

  static parseResponse(rawResponse) {
    try {
      const cleaned = rawResponse.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        sentiment:    parsed.sentiment ?? 'NEUTRAL',
        confidence:   clamp(parsed.confidence ?? 50, 0, 100),
        tone:         parsed.tone ?? null,
        marketImpact: parsed.marketImpact ?? 'LOW',
        affectedAssets: parsed.affectedAssets ?? [],
        reasoning:    parsed.reasoning ?? '',
        source: 'CLAUDE_NLP',
      };
    } catch (e) {
      return { sentiment: 'NEUTRAL', confidence: 0, error: 'Failed to parse Claude response', source: 'CLAUDE_NLP' };
    }
  }
}

// ─────────────────────────────────────────────
//  4. CENTRAL BANK TONE TRACKER
// ─────────────────────────────────────────────

class CentralBankToneTracker {
  /**
   * Tracks consecutive statements from each central bank and detects
   * tone SHIFTS — a bank going from hawkish to neutral often moves
   * markets more than the headline rate decision itself.
   */
  constructor() {
    this._history = new Map(); // bank → [{ timestamp, tone, score, statement }]
  }

  record(bank, statementText, score) {
    if (!this._history.has(bank)) this._history.set(bank, []);
    const hist = this._history.get(bank);

    const tone = score > 20 ? 'HAWKISH' : score < -20 ? 'DOVISH' : 'NEUTRAL';
    hist.push({ timestamp: Date.now(), tone, score, statement: statementText.slice(0, 200) });
    if (hist.length > 20) hist.shift();

    return this._detectShift(bank);
  }

  _detectShift(bank) {
    const hist = this._history.get(bank);
    if (!hist || hist.length < 2) return null;

    const prev = hist[hist.length - 2];
    const curr = hist[hist.length - 1];

    if (prev.tone !== curr.tone) {
      return {
        bank, shift: `${prev.tone} → ${curr.tone}`,
        previousScore: prev.score, currentScore: curr.score,
        magnitude: round(Math.abs(curr.score - prev.score), 1),
        note: `${bank} tone shifted from ${prev.tone} to ${curr.tone} — significant policy signal`,
      };
    }
    return null;
  }

  getLatest(bank) {
    const hist = this._history.get(bank);
    return hist?.[hist.length - 1] || null;
  }

  getTrend(bank, n = 5) {
    const hist = this._history.get(bank) || [];
    const recent = hist.slice(-n);
    if (recent.length === 0) return { trend: 'NO_DATA' };

    const avgScore = avg(recent.map(h => h.score));
    return {
      trend: avgScore > 15 ? 'HAWKISH_BIAS' : avgScore < -15 ? 'DOVISH_BIAS' : 'NEUTRAL_BIAS',
      avgScore: round(avgScore, 1),
      sampleSize: recent.length,
      recentStatements: recent,
    };
  }

  getAllBanks() { return [...this._history.keys()]; }
}

// ─────────────────────────────────────────────
//  5. COT REPORT PARSER
// ─────────────────────────────────────────────

class COTReportParser {
  /**
   * Parses CFTC Commitment of Traders report data (legacy futures-only
   * format). CFTC publishes weekly (Fridays, for Tuesday's data).
   *
   * Categories:
   *   - Commercial (hedgers / "smart money") — net position often
   *     contrarian to retail at extremes
   *   - Non-commercial (large speculators / "smart money momentum")
   *   - Non-reportable (small speculators / "dumb money", often wrong
   *     at extremes)
   */
  constructor() {
    this._reports = new Map(); // symbol → [{ date, commercial, largeSpec, smallSpec }]
  }

  /**
   * Ingest a raw COT report row (format matches CFTC's standard CSV/API fields)
   */
  ingest(symbol, reportData) {
    const parsed = {
      date: reportData.report_date || reportData.date,
      commercialLong:  parseFloat(reportData.comm_positions_long_all ?? reportData.commercialLong ?? 0),
      commercialShort: parseFloat(reportData.comm_positions_short_all ?? reportData.commercialShort ?? 0),
      largeSpecLong:   parseFloat(reportData.noncomm_positions_long_all ?? reportData.largeSpecLong ?? 0),
      largeSpecShort:  parseFloat(reportData.noncomm_positions_short_all ?? reportData.largeSpecShort ?? 0),
      smallSpecLong:   parseFloat(reportData.nonrept_positions_long_all ?? reportData.smallSpecLong ?? 0),
      smallSpecShort:  parseFloat(reportData.nonrept_positions_short_all ?? reportData.smallSpecShort ?? 0),
      openInterest:    parseFloat(reportData.open_interest_all ?? reportData.openInterest ?? 0),
    };

    parsed.commercialNet = parsed.commercialLong - parsed.commercialShort;
    parsed.largeSpecNet  = parsed.largeSpecLong - parsed.largeSpecShort;
    parsed.smallSpecNet  = parsed.smallSpecLong - parsed.smallSpecShort;

    if (!this._reports.has(symbol)) this._reports.set(symbol, []);
    const hist = this._reports.get(symbol);
    hist.push(parsed);
    if (hist.length > 156) hist.shift(); // ~3 years of weekly data

    return this.analyze(symbol);
  }

  /**
   * Full analysis: current positioning, week-over-week change,
   * percentile extremity, and trading signal.
   */
  analyze(symbol) {
    const hist = this._reports.get(symbol);
    if (!hist || hist.length === 0) return null;

    const latest = hist[hist.length - 1];
    const previous = hist[hist.length - 2];

    const wowChange = previous ? {
      commercial: round(latest.commercialNet - previous.commercialNet, 0),
      largeSpec:  round(latest.largeSpecNet - previous.largeSpecNet, 0),
      smallSpec:  round(latest.smallSpecNet - previous.smallSpecNet, 0),
    } : null;

    // Percentile of current large-spec net position vs trailing history
    const largeSpecHistory = hist.map(h => h.largeSpecNet);
    const percentile = this._percentileRank(largeSpecHistory, latest.largeSpecNet);

    const isExtreme = percentile >= COT_EXTREME_PERCENTILE || percentile <= (100 - COT_EXTREME_PERCENTILE);

    // Signal logic: extreme large-spec positioning historically precedes reversals.
    // Commercial net is often the contrarian "smart money" signal.
    let signal = 'NEUTRAL';
    if (isExtreme && percentile >= COT_EXTREME_PERCENTILE) {
      signal = 'EXTREME_LONG_SPEC_REVERSAL_RISK'; // large specs maximally long → contrarian bearish
    } else if (isExtreme && percentile <= (100 - COT_EXTREME_PERCENTILE)) {
      signal = 'EXTREME_SHORT_SPEC_REVERSAL_RISK'; // large specs maximally short → contrarian bullish
    }

    return {
      symbol, date: latest.date,
      commercial: { net: latest.commercialNet, long: latest.commercialLong, short: latest.commercialShort },
      largeSpec:  { net: latest.largeSpecNet, long: latest.largeSpecLong, short: latest.largeSpecShort },
      smallSpec:  { net: latest.smallSpecNet, long: latest.smallSpecLong, short: latest.smallSpecShort },
      openInterest: latest.openInterest,
      weekOverWeekChange: wowChange,
      largeSpecPercentile: round(percentile, 1),
      isExtreme,
      signal,
      note: isExtreme
        ? `Large speculators at ${round(percentile,0)}th percentile of 3yr positioning — ${signal}`
        : 'Positioning within normal historical range',
    };
  }

  _percentileRank(arr, value) {
    if (arr.length < 2) return 50;
    const sorted = [...arr].sort((a, b) => a - b);
    const below = sorted.filter(v => v < value).length;
    return (below / sorted.length) * 100;
  }

  getHistory(symbol, n = 12) {
    const hist = this._reports.get(symbol) || [];
    return hist.slice(-n);
  }
}

// ─────────────────────────────────────────────
//  6. FEAR/GREED ENGINE
// ─────────────────────────────────────────────

class FearGreedEngine {
  /**
   * Composite 0-100 fear/greed index built from whatever inputs are
   * available. Designed to accept partial data gracefully — missing
   * inputs are excluded from the weighted average rather than zeroed.
   */
  constructor() {
    this._inputs = {
      volatilityRegime: null,  // 'LOW'|'NORMAL'|'HIGH'|'EXTREME'
      fundingBias:      null,  // -100 (shorts paying / fear) to +100 (longs paying / greed)
      safeHavenFlow:    null,  // -100 (outflow from gold/bonds = greed) to +100 (inflow = fear)
      newsSentimentAvg: null,  // -100 to +100 from recent headline aggregate
      momentum:         null,  // -100 to +100 from recent price momentum
    };
  }

  update(input, value) {
    if (input in this._inputs) this._inputs[input] = value;
  }

  /**
   * Volatility regime maps inversely to greed (high vol = fear)
   */
  setVolatilityRegime(regime) {
    const map = { LOW: 70, NORMAL: 50, HIGH: 30, EXTREME: 10 };
    this._inputs.volatilityRegime = map[regime] ?? 50;
  }

  setFundingBias(fundingRate) {
    // Positive funding (longs paying) = greed; scale roughly
    this._inputs.fundingBias = clamp(50 + fundingRate * 10000, 0, 100);
  }

  setSafeHavenFlow(goldPctChange) {
    // Gold rallying = fear (inverse to greed)
    this._inputs.safeHavenFlow = clamp(50 - goldPctChange * 10, 0, 100);
  }

  setNewsSentiment(avgScore) {
    // -100..100 → 0..100
    this._inputs.newsSentimentAvg = clamp((avgScore + 100) / 2, 0, 100);
  }

  setMomentum(score) {
    this._inputs.momentum = clamp((score + 100) / 2, 0, 100);
  }

  compute() {
    const available = Object.entries(this._inputs).filter(([, v]) => v !== null);
    if (available.length === 0) {
      return { index: 50, label: 'NEUTRAL', confidence: 'NO_DATA', inputs: this._inputs };
    }

    const index = round(avg(available.map(([, v]) => v)), 1);
    const label = index >= 75 ? 'EXTREME_GREED' : index >= 60 ? 'GREED'
      : index >= 40 ? 'NEUTRAL' : index >= 25 ? 'FEAR' : 'EXTREME_FEAR';

    return {
      index, label,
      confidence: available.length >= 4 ? 'HIGH' : available.length >= 2 ? 'MEDIUM' : 'LOW',
      inputsUsed: available.length,
      inputs: { ...this._inputs },
      contrarianSignal: label === 'EXTREME_FEAR' ? 'POTENTIAL_BUY_ZONE'
        : label === 'EXTREME_GREED' ? 'POTENTIAL_CAUTION_ZONE' : null,
    };
  }
}

// ─────────────────────────────────────────────
//  7. SOCIAL SENTIMENT PROXY
// ─────────────────────────────────────────────

class SocialSentimentProxy {
  /**
   * Lightweight pluggable interface for social sentiment data.
   * Most real-time social sentiment APIs (LunarCrush, Santiment, etc.)
   * require paid keys — this class defines the shape so a provider
   * can be wired in later without touching callers.
   */
  constructor() {
    this._data = new Map(); // symbol → { score, volume, trend, timestamp }
  }

  /**
   * Manually feed sentiment data (from whatever provider you connect)
   */
  update(symbol, { score, mentionVolume, trend }) {
    const existing = this._data.get(symbol);
    this._data.set(symbol, {
      score: clamp(score, -100, 100),
      mentionVolume,
      trend: trend ?? (existing && score > existing.score ? 'RISING' : score < (existing?.score ?? 0) ? 'FALLING' : 'STABLE'),
      timestamp: Date.now(),
    });
  }

  get(symbol) { return this._data.get(symbol) || null; }

  /**
   * Detect unusual spikes in mention volume — often precedes volatility
   */
  detectVolumeSpike(symbol, currentVolume, historicalAvg) {
    if (!historicalAvg || historicalAvg === 0) return { spike: false };
    const ratio = currentVolume / historicalAvg;
    return {
      spike: ratio >= 3,
      ratio: round(ratio, 2),
      note: ratio >= 3 ? `Mention volume ${round(ratio,1)}x normal — unusual social activity` : null,
    };
  }
}

// ─────────────────────────────────────────────
//  1. NEWS INGESTION ENGINE
// ─────────────────────────────────────────────

class NewsIngestionEngine {
  /**
   * @param {Object[]} sources - [{ name, url, parser: (rawResponse) => headlines[] }]
   */
  constructor(sources = []) {
    this.sources = sources;
    this._seen = []; // recent headline fingerprints for dedup
  }

  addSource(source) { this.sources.push(source); }

  /**
   * Poll all configured sources and return new (non-duplicate) headlines.
   */
  async pollAll() {
    const allHeadlines = [];

    for (const source of this.sources) {
      try {
        const raw = await httpGetJSON(source.url, source.headers || {});
        const headlines = source.parser(raw);
        for (const h of headlines) {
          allHeadlines.push({ ...h, source: source.name, fetchedAt: Date.now() });
        }
      } catch (err) {
        console.error(`[NewsIngestionEngine] Failed to poll ${source.name}: ${err.message}`);
      }
    }

    return this._dedupe(allHeadlines);
  }

  _dedupe(headlines) {
    const fresh = [];
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    this._seen = this._seen.filter(s => s.timestamp > cutoff);

    for (const h of headlines) {
      const fingerprint = this._fingerprint(h.text);
      const isDup = this._seen.some(s => s.fingerprint === fingerprint);
      if (!isDup) {
        this._seen.push({ fingerprint, timestamp: Date.now() });
        fresh.push(h);
      }
    }

    return fresh;
  }

  _fingerprint(text) {
    // Simple normalized fingerprint — lowercase, strip punctuation, first 60 chars
    return text.toLowerCase().replace(/[^\w\s]/g, '').slice(0, 60);
  }
}

// ─────────────────────────────────────────────
//  8. MAIN NEWS FEED CLASS
// ─────────────────────────────────────────────

class NewsFeed extends EventEmitter {
  /**
   * @param {Object} config
   * @param {Object[]} config.sources       - news source definitions for NewsIngestionEngine
   * @param {number}   config.pollIntervalMs - how often to poll news sources (default 5min)
   * @param {Function} config.claudeClient  - optional async fn(prompt) => responseText for deep NLP
   * @param {boolean}  config.autoDeepAnalysis - run ClaudeNLPAnalyzer on significant headlines (default false, needs claudeClient)
   */
  constructor(config = {}) {
    super();

    this.ingestion   = new NewsIngestionEngine(config.sources || []);
    this.toneTracker = new CentralBankToneTracker();
    this.cotParser   = new COTReportParser();
    this.fearGreed   = new FearGreedEngine();
    this.social      = new SocialSentimentProxy();

    this.pollIntervalMs = config.pollIntervalMs || 5 * 60000;
    this.claudeClient   = config.claudeClient || null;
    this.autoDeepAnalysis = config.autoDeepAnalysis ?? false;

    this._headlineHistory = []; // recent scored headlines
    this._pollTimer = null;

    this._stats = { headlinesProcessed: 0, deepAnalysisCount: 0, errorsCount: 0, startTime: null };
  }

  async connect() {
    console.log(`[NewsFeed] Starting — ${this.ingestion.sources.length} source(s), polling every ${this.pollIntervalMs/60000}min`);
    this._stats.startTime = Date.now();

    await this._poll(); // initial poll immediately
    this._pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);

    this.emit('ready', { sources: this.ingestion.sources.map(s => s.name) });
  }

  async _poll() {
    try {
      const headlines = await this.ingestion.pollAll();
      for (const headline of headlines) {
        await this._processHeadline(headline);
      }
      if (headlines.length > 0) {
        console.log(`[NewsFeed] Processed ${headlines.length} new headline(s)`);
      }
    } catch (err) {
      this._stats.errorsCount++;
      this.emit('error', { source: 'poll', error: err });
    }
  }

  async _processHeadline(headline) {
    this._stats.headlinesProcessed++;

    // ── Fast lexicon scoring ──
    const lexiconResult = SentimentLexicon.score(headline.text);
    const affectedAssets = SentimentLexicon.detectAffectedAssets(headline.text);

    const scored = {
      ...headline,
      sentiment: lexiconResult,
      affectedAssets,
      timestamp: Date.now(),
    };

    this._headlineHistory.push(scored);
    if (this._headlineHistory.length > MAX_HEADLINE_HISTORY) this._headlineHistory.shift();

    this.emit('headline', scored);

    // ── Central bank tone tracking ──
    const bankMatch = this._matchCentralBank(headline.text);
    if (bankMatch) {
      const shift = this.toneTracker.record(bankMatch, headline.text, lexiconResult.score);
      if (shift) this.emit('central_bank_tone_shift', shift);
    }

    // ── Update fear/greed with this headline's contribution ──
    const recentScores = this._headlineHistory.slice(-20).map(h => h.sentiment.score);
    this.fearGreed.setNewsSentiment(avg(recentScores));

    // ── Optional deep Claude NLP analysis for significant headlines ──
    if (this.autoDeepAnalysis && this.claudeClient && lexiconResult.significant) {
      try {
        const prompt = ClaudeNLPAnalyzer.buildPrompt(headline, { affectedAssets });
        const response = await this.claudeClient(prompt);
        const deepResult = ClaudeNLPAnalyzer.parseResponse(response);
        this._stats.deepAnalysisCount++;

        this.emit('deep_analysis', { headline: scored, analysis: deepResult });
      } catch (err) {
        this._stats.errorsCount++;
      }
    }

    // ── Sentiment shift detection (aggregate trend change) ──
    if (this._headlineHistory.length >= 10) {
      const older = avg(this._headlineHistory.slice(-20, -10).map(h => h.sentiment.score));
      const recent = avg(this._headlineHistory.slice(-10).map(h => h.sentiment.score));
      if (Math.sign(older) !== Math.sign(recent) && Math.abs(recent - older) > 30) {
        this.emit('sentiment_shift', {
          from: older > 0 ? 'BULLISH' : 'BEARISH',
          to: recent > 0 ? 'BULLISH' : 'BEARISH',
          oldScore: round(older, 1), newScore: round(recent, 1),
        });
      }
    }
  }

  _matchCentralBank(text) {
    const lower = text.toLowerCase();
    if (lower.includes('fomc') || lower.includes('federal reserve') || lower.includes('powell')) return 'FED';
    if (lower.includes('ecb') || lower.includes('lagarde')) return 'ECB';
    if (lower.includes('boe') || lower.includes('bank of england')) return 'BOE';
    if (lower.includes('boj') || lower.includes('bank of japan')) return 'BOJ';
    if (lower.includes('rba')) return 'RBA';
    return null;
  }

  // ── COT report ingestion (called externally when weekly data is fetched) ──

  ingestCOTReport(symbol, reportData) {
    const analysis = this.cotParser.ingest(symbol, reportData);
    if (analysis?.isExtreme) {
      this.emit('extreme_positioning', analysis);
    }
    this.emit('cot_update', analysis);
    return analysis;
  }

  // ── Public query API ──

  getRecentHeadlines(n = 20, assetFilter = null) {
    let headlines = this._headlineHistory.slice(-n).reverse();
    if (assetFilter) headlines = headlines.filter(h => h.affectedAssets.includes(assetFilter));
    return headlines;
  }

  getAggregateSentiment(assetFilter = null, windowMs = 3600000) {
    const cutoff = Date.now() - windowMs;
    let relevant = this._headlineHistory.filter(h => h.timestamp > cutoff);
    if (assetFilter) relevant = relevant.filter(h => h.affectedAssets.includes(assetFilter));

    if (relevant.length === 0) return { score: 0, classification: 'NEUTRAL', sampleSize: 0 };

    const avgScore = avg(relevant.map(h => h.sentiment.score));
    return {
      score: round(avgScore, 1),
      classification: avgScore > 20 ? 'BULLISH' : avgScore < -20 ? 'BEARISH' : 'NEUTRAL',
      sampleSize: relevant.length,
      windowMs,
    };
  }

  getCentralBankTone(bank) { return this.toneTracker.getTrend(bank); }
  getCOTAnalysis(symbol) { return this.cotParser.analyze(symbol); }
  getFearGreedIndex() { return this.fearGreed.compute(); }
  getSocialSentiment(symbol) { return this.social.get(symbol); }

  updateSocialSentiment(symbol, data) { this.social.update(symbol, data); }
  updateFearGreedInput(input, value) { this.fearGreed.update(input, value); }

  getStats() {
    const uptime = this._stats.startTime ? Math.floor((Date.now() - this._stats.startTime) / 1000) : 0;
    return {
      ...this._stats, uptime,
      headlinesInMemory: this._headlineHistory.length,
      banksTracked: this.toneTracker.getAllBanks(),
      fearGreed: this.fearGreed.compute(),
    };
  }

  disconnect() {
    console.log('[NewsFeed] Disconnecting...');
    if (this._pollTimer) clearInterval(this._pollTimer);
    this.emit('closed');
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  NewsFeed, NewsIngestionEngine, SentimentLexicon, ClaudeNLPAnalyzer,
  CentralBankToneTracker, COTReportParser, FearGreedEngine, SocialSentimentProxy,
  LEXICON,
};

/**
 * ─────────────────────────────────────────────
 *  USAGE EXAMPLE
 * ─────────────────────────────────────────────
 *
 *  const { NewsFeed } = require('./feeds/news-feed');
 *
 *  const newsFeed = new NewsFeed({
 *    sources: [
 *      {
 *        name: 'ExampleRSSProvider',
 *        url: 'https://example-news-api.com/headlines?apikey=KEY',
 *        parser: (raw) => raw.articles.map(a => ({ text: a.title, url: a.url })),
 *      },
 *    ],
 *    pollIntervalMs: 5 * 60000,
 *    claudeClient: async (prompt) => {
 *      // wire to your existing Claude API client
 *      const res = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
 *      return res.content[0].text;
 *    },
 *    autoDeepAnalysis: true,
 *  });
 *
 *  newsFeed.on('headline', (h) => console.log(h.sentiment.classification, h.text));
 *  newsFeed.on('central_bank_tone_shift', (shift) => console.log(shift.note));
 *  newsFeed.on('extreme_positioning', (cot) => console.log(cot.note));
 *
 *  await newsFeed.connect();
 *
 *  // Feed COT data weekly (e.g. fetched separately from CFTC public API)
 *  newsFeed.ingestCOTReport('XAUUSD', cftcReportRow);
 *
 *  // Query for session-filter.js / signal-scorer.js
 *  const sentiment = newsFeed.getAggregateSentiment('USD', 3600000);
 *  const fearGreed = newsFeed.getFearGreedIndex();
 * ─────────────────────────────────────────────
 */  