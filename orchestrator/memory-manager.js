/**
 * ============================================================
 *  MEMORY MANAGER — Agent Context + Signal History + Vector DB
 *  AI Trading Assistant · Layer 2 · Orchestrator
 * ============================================================
 *
 *  Storage layers:
 *    L1 — In-memory LRU cache (hot data, sub-ms access)
 *    L2 — Redis (warm data, session-level, TTL-based)
 *    L3 — PostgreSQL (cold data, permanent trade history)
 *    L4 — Pinecone Vector DB (semantic agent memory + RAG)
 *
 *  What gets stored:
 *    - Every signal fired (full payload + outcome)
 *    - Agent vote history per symbol/timeframe
 *    - Indicator state snapshots
 *    - Trade outcomes (win/loss/breakeven, R multiple)
 *    - Pattern performance statistics
 *    - Symbol-level context (regime, recent structure)
 *    - Session-level analytics
 *    - User preferences + settings
 *    - System events + errors
 *
 *  Vector memory (Pinecone):
 *    - Embeds signal context as vector
 *    - Retrieves similar past setups on new signals
 *    - Surfaces "last time this pattern appeared = result"
 *    - Feeds into conflict-resolver for better arbitration
 *
 *  Events emitted:
 *    'signal_saved'    → signal persisted to all layers
 *    'memory_hit'      → retrieved from cache
 *    'similar_found'   → vector similarity match found
 *    'stats_updated'   → performance stats recalculated
 *    'error'           → storage operation failed
 * ============================================================
 */

'use strict';

const EventEmitter = require('events');
const https        = require('https');

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────

const LRU_MAX_SIZE         = 2000;
const LRU_DEFAULT_TTL      = 5 * 60 * 1000;      // 5 min
const REDIS_SIGNAL_TTL     = 60 * 60 * 24 * 7;   // 7 days (seconds)
const REDIS_CONTEXT_TTL    = 60 * 60 * 24;        // 24 hours
const REDIS_STATS_TTL      = 60 * 60 * 24 * 30;  // 30 days
const VECTOR_DIMENSION     = 128;                  // embedding size
const VECTOR_TOP_K         = 5;                    // similar results to fetch
const SIGNAL_HISTORY_MAX   = 5000;                 // in-memory cap
const STATS_RECALC_INTERVAL = 60 * 1000;          // recalc every 60s

function _now()          { return Date.now(); }
function _round(n, d=4)  { return parseFloat((+n).toFixed(d)); }
function _uuid()         {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─────────────────────────────────────────────
//  L1 — LRU CACHE
// ─────────────────────────────────────────────

class LRUCache {
  /**
   * Fast in-memory LRU cache with TTL support.
   * O(1) get/set using Map (insertion-order preserved).
   */
  constructor(maxSize = LRU_MAX_SIZE, defaultTTL = LRU_DEFAULT_TTL) {
    this._max     = maxSize;
    this._ttl     = defaultTTL;
    this._cache   = new Map();
    this._hits    = 0;
    this._misses  = 0;
    this._evicted = 0;
  }

  get(key) {
    const entry = this._cache.get(key);
    if (!entry) { this._misses++; return null; }
    if (_now() > entry.expiresAt) {
      this._cache.delete(key);
      this._misses++;
      return null;
    }
    // Move to end (most recently used)
    this._cache.delete(key);
    this._cache.set(key, entry);
    this._hits++;
    return entry.value;
  }

  set(key, value, ttl) {
    if (this._cache.has(key)) this._cache.delete(key);
    else if (this._cache.size >= this._max) {
      // Evict least recently used (first entry)
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
      this._evicted++;
    }
    this._cache.set(key, {
      value,
      expiresAt:  _now() + (ttl || this._ttl),
      createdAt:  _now(),
    });
  }

  delete(key)    { return this._cache.delete(key); }
  has(key)       { return this._cache.has(key) && _now() <= this._cache.get(key)?.expiresAt; }
  clear()        { this._cache.clear(); }
  get size()     { return this._cache.size; }

  // Scan keys matching a prefix
  scan(prefix) {
    const results = [];
    for (const [k, v] of this._cache) {
      if (k.startsWith(prefix) && _now() <= v.expiresAt) {
        results.push({ key: k, value: v.value });
      }
    }
    return results;
  }

  getStats() {
    const hitRate = this._hits + this._misses > 0
      ? _round(this._hits / (this._hits + this._misses) * 100, 2)
      : 0;
    return {
      size: this._cache.size, max: this._max,
      hits: this._hits, misses: this._misses,
      evicted: this._evicted, hitRate,
    };
  }
}

// ─────────────────────────────────────────────
//  SIGNAL EMBEDDER (lightweight, no external ML)
// ─────────────────────────────────────────────

class SignalEmbedder {
  /**
   * Converts a signal into a fixed-dimension float vector.
   * Uses hand-crafted features — no external ML dependency.
   * Suitable for cosine similarity matching of "similar setups".
   *
   * Feature groups (total 128 dims):
   *   [0-9]   Price action features
   *   [10-29] Indicator scores (RSI, MACD, EMA, Ichi, etc.)
   *   [30-49] SMC features (OB, FVG, sweep, CHoCH)
   *   [50-59] MTF alignment features
   *   [60-79] Market regime features (ATR, volume, OI)
   *   [80-99] Temporal features (session, day of week, hour)
   *   [100-119] Agent vote features
   *   [120-127] Outcome features (filled after trade closes)
   */
  static embed(signal) {
    const vec = new Float32Array(VECTOR_DIMENSION);
    const s   = signal;

    // ── Price action [0-9] ──
    vec[0]  = s.action === 'LONG' ? 1 : -1;
    vec[1]  = s.score?.final ? s.score.final / 100 : 0;
    vec[2]  = s.stopLoss?.riskPct ? s.stopLoss.riskPct / 5 : 0;
    vec[3]  = s.targets?.tp1?.rr  ? Math.min(s.targets.tp1.rr / 5, 1) : 0;
    vec[4]  = s.targets?.tp2?.rr  ? Math.min(s.targets.tp2.rr / 8, 1) : 0;
    vec[5]  = s.risk?.atrPct ? Math.min(s.risk.atrPct / 3, 1) : 0;
    vec[6]  = s.risk?.atrTrend === 'EXPANDING' ? 1 : s.risk?.atrTrend === 'CONTRACTING' ? -1 : 0;
    vec[7]  = SignalEmbedder._tfToFloat(s.timeframe);
    vec[8]  = s.htfBias?.direction === 'LONG' ? 1 : s.htfBias?.direction === 'SHORT' ? -1 : 0;
    vec[9]  = s.htfBias?.strength ? s.htfBias.strength / 100 : 0;

    // ── Indicator scores [10-29] ──
    const mom = s.agentVotes?.momentum?.analysis || {};
    vec[10] = mom.rsi?.value         ? (mom.rsi.value - 50) / 50 : 0;
    vec[11] = mom.macd?.aboveZero    ? 1 : -1;
    vec[12] = mom.macd?.histTrend === 'BULLISH_ACCELERATING' ? 1 : mom.macd?.histTrend === 'BEARISH_ACCELERATING' ? -1 : 0;
    vec[13] = mom.emaStack?.bullStack ? 1 : mom.emaStack?.bearStack ? -1 : 0;
    vec[14] = mom.ichimoku?.aboveCloud ? 1 : mom.ichimoku?.belowCloud ? -1 : 0;
    vec[15] = mom.vwap?.aboveVWAP    ? 1 : -1;
    vec[16] = mom.bollinger?.squeeze  ? 1 : 0;
    vec[17] = mom.bollinger?.pctB     ? mom.bollinger.pctB * 2 - 1 : 0;
    vec[18] = mom.stochRsi?.k         ? (mom.stochRsi.k - 50) / 50 : 0;
    vec[19] = mom.adx?.adx            ? Math.min(mom.adx.adx / 60, 1) : 0;
    vec[20] = mom.rsi?.divergence?.bullish ? 1 : mom.rsi?.divergence?.bearish ? -1 : 0;
    vec[21] = mom.macd?.bullCross     ? 1 : mom.macd?.bearCross ? -1 : 0;
    vec[22] = (s.agentVotes?.momentum?.score || 0) / 100;
    vec[23] = mom.cci?.value          ? Math.max(-1, Math.min(1, (mom.cci.value || 0) / 200)) : 0;
    vec[24] = mom.williamsR?.value    ? ((mom.williamsR.value + 100) / 100) * 2 - 1 : 0;
    vec[25] = mom.roc?.value          ? Math.max(-1, Math.min(1, (mom.roc.value || 0) / 10)) : 0;
    vec[26] = mom.adx?.bullTrend      ? 1 : mom.adx?.bearTrend ? -1 : 0;
    vec[27] = mom.ichimoku?.tkBull    ? 1 : mom.ichimoku?.tkBear ? -1 : 0;
    vec[28] = mom.ichimoku?.cloudBull ? 1 : mom.ichimoku?.cloudBear ? -1 : 0;
    vec[29] = (s.agentVotes?.momentum?.score || 0) > 70 ? 1 : 0;

    // ── SMC features [30-49] ──
    const smc = s.agentVotes?.smc?.analysis || {};
    vec[30] = smc.orderBlocks?.bullish?.length ? Math.min(smc.orderBlocks.bullish.length / 3, 1) : 0;
    vec[31] = smc.orderBlocks?.bearish?.length ? Math.min(smc.orderBlocks.bearish.length / 3, 1) : 0;
    vec[32] = smc.fvgs?.bullish?.length  ? Math.min(smc.fvgs.bullish.length / 5, 1) : 0;
    vec[33] = smc.fvgs?.bearish?.length  ? Math.min(smc.fvgs.bearish.length / 5, 1) : 0;
    vec[34] = smc.sweeps?.bullishSweep   ? 1 : 0;
    vec[35] = smc.sweeps?.bearishSweep   ? 1 : 0;
    vec[36] = smc.choch?.bullish         ? 1 : smc.choch?.bearish ? -1 : 0;
    vec[37] = smc.bos?.bullish           ? 1 : smc.bos?.bearish ? -1 : 0;
    vec[38] = smc.marketStructure?.trend === 'BULLISH' ? 1 : smc.marketStructure?.trend === 'BEARISH' ? -1 : 0;
    vec[39] = smc.premiumDiscount        ? (smc.premiumDiscount === 'DISCOUNT' ? 1 : smc.premiumDiscount === 'PREMIUM' ? -1 : 0) : 0;
    vec[40] = (s.agentVotes?.smc?.score || 0) / 100;
    vec[41] = smc.orderBlocks?.bullish?.[0]?.strength === 'STRONG' ? 1 : 0;
    vec[42] = smc.orderBlocks?.bearish?.[0]?.strength === 'STRONG' ? 1 : 0;
    vec[43] = smc.equalLevels?.eqh?.length ? Math.min(smc.equalLevels.eqh.length / 3, 1) : 0;
    vec[44] = smc.equalLevels?.eql?.length ? Math.min(smc.equalLevels.eql.length / 3, 1) : 0;
    vec[45] = smc.internalStructure?.choch ? 1 : 0;
    vec[46] = (s.agentVotes?.smc?.score || 0) > 70 ? 1 : 0;
    vec[47] = smc.fvgs?.bullish?.[0]?.age ? Math.max(0, 1 - smc.fvgs.bullish[0].age / 50) : 0;
    vec[48] = smc.fvgs?.bearish?.[0]?.age ? Math.max(0, 1 - smc.fvgs.bearish[0].age / 50) : 0;
    vec[49] = s.confluence?.smcGrade === 'A' ? 1 : s.confluence?.smcGrade === 'B' ? 0.6 : 0.3;

    // ── MTF features [50-59] ──
    const mtf = s.agentVotes?.mtf || {};
    vec[50] = mtf.direction === 'LONG' ? 1 : mtf.direction === 'SHORT' ? -1 : 0;
    vec[51] = (mtf.score || 0) / 100;
    vec[52] = mtf.analysis?.alignedTimeframes ? Math.min(mtf.analysis.alignedTimeframes / 4, 1) : 0;
    vec[53] = mtf.analysis?.htf?.trend === 'BULLISH' ? 1 : mtf.analysis?.htf?.trend === 'BEARISH' ? -1 : 0;
    vec[54] = mtf.analysis?.mtf?.trend === 'BULLISH' ? 1 : mtf.analysis?.mtf?.trend === 'BEARISH' ? -1 : 0;
    vec[55] = mtf.analysis?.ltf?.trend === 'BULLISH' ? 1 : mtf.analysis?.ltf?.trend === 'BEARISH' ? -1 : 0;
    vec[56] = (mtf.score || 0) > 70 ? 1 : 0;
    vec[57] = mtf.analysis?.confluenceScore ? mtf.analysis.confluenceScore / 100 : 0;
    vec[58] = mtf.analysis?.divergence ? -0.5 : 0;
    vec[59] = mtf.analysis?.allAligned  ? 1 : 0;

    // ── Market regime [60-79] ──
    vec[60] = s.risk?.atrPct ? Math.min(s.risk.atrPct / 2, 1) : 0;
    vec[61] = s.marketContext?.volatilityLabel === 'HIGH' ? 1 : s.marketContext?.volatilityLabel === 'LOW' ? -1 : 0;
    vec[62] = s.agentVotes?.volumeOI?.direction === 'LONG' ? 1 : s.agentVotes?.volumeOI?.direction === 'SHORT' ? -1 : 0;
    vec[63] = (s.agentVotes?.volumeOI?.score || 0) / 100;
    vec[64] = s.fundingRate?.rate ? Math.max(-1, Math.min(1, s.fundingRate.rate * 1000)) : 0;
    vec[65] = s.openInterest?.signal?.includes('BULLISH') ? 1 : s.openInterest?.signal?.includes('BEARISH') ? -1 : 0;
    vec[66] = s.session?.quality === 'PRIME' ? 1 : s.session?.quality === 'POOR' ? -1 : 0;
    vec[67] = s.session?.current === 'OVERLAP' ? 1 : s.session?.current === 'ASIA' ? -0.5 : 0;
    vec[68] = s.score?.grade === 'A' ? 1 : s.score?.grade === 'B' ? 0.6 : s.score?.grade === 'C' ? 0.3 : 0;
    vec[69] = s.agentBreakdown?.filter(a => a.status === 'CONFIRMS').length / Math.max(s.agentBreakdown?.length || 1, 1);
    vec[70] = s.marketContext?.liquidityPools?.length ? Math.min(s.marketContext.liquidityPools.length / 5, 1) : 0;
    vec[71] = s.risk?.dollarRisk ? Math.min(s.risk.dollarRisk / 200, 1) : 0;
    vec[72] = s.agentVotes?.macroSent?.direction === 'LONG' ? 1 : s.agentVotes?.macroSent?.direction === 'SHORT' ? -1 : 0;
    vec[73] = (s.agentVotes?.macroSent?.score || 50) / 100;
    vec[74] = s.marketContext?.smcLiquidityTarget ? 1 : 0;

    // ── Temporal [80-99] ──
    const ts = new Date(s.timestamp || _now());
    vec[80] = ts.getUTCHours() / 24;
    vec[81] = ts.getUTCDay() / 7;
    vec[82] = ts.getUTCMonth() / 12;
    vec[83] = SignalEmbedder._tfToFloat(s.timeframe);
    vec[84] = s.session?.current === 'LONDON'   ? 1 : 0;
    vec[85] = s.session?.current === 'NEW_YORK' ? 1 : 0;
    vec[86] = s.session?.current === 'ASIA'     ? 1 : 0;
    vec[87] = s.session?.current === 'OVERLAP'  ? 1 : 0;
    vec[88] = ts.getUTCDay() === 1 ? 1 : ts.getUTCDay() === 5 ? -0.5 : 0; // Monday vs Friday
    vec[89] = ts.getUTCHours() >= 8 && ts.getUTCHours() <= 16 ? 1 : 0;  // peak hours

    // ── Agent votes [100-119] ──
    const agents = ['smc','mtf','momentum','volumeOI','macroSent'];
    agents.forEach((a, i) => {
      const v = s.agentVotes?.[a] || {};
      vec[100 + i*4]     = v.direction === 'LONG' ? 1 : v.direction === 'SHORT' ? -1 : 0;
      vec[100 + i*4 + 1] = (v.score || 0) / 100;
      vec[100 + i*4 + 2] = (v.score || 0) > 70 ? 1 : 0;
      vec[100 + i*4 + 3] = v.reasons?.length ? Math.min(v.reasons.length / 10, 1) : 0;
    });

    // ── Outcome (filled post-trade) [120-127] ──
    // Initially zero, updated when trade closes
    vec[120] = s.outcome?.pnlR     ? Math.max(-1, Math.min(1, s.outcome.pnlR / 5)) : 0;
    vec[121] = s.outcome?.won      ? 1 : s.outcome?.lost ? -1 : 0;
    vec[122] = s.outcome?.tpHit    ? s.outcome.tpHit / 3 : 0;
    vec[123] = s.outcome?.holdTime ? Math.min(s.outcome.holdTime / (24 * 60), 1) : 0;

    return Array.from(vec);
  }

  static _tfToFloat(tf) {
    const map = { 'M1': 0.02, 'M5': 0.05, 'M15': 0.1, 'M30': 0.15,
                  'H1': 0.25, 'H4': 0.5,  'D1': 0.75, 'W1': 1.0 };
    return map[tf] || 0.25;
  }

  // Cosine similarity between two vectors
  static cosineSim(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot   += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : _round(dot / denom, 4);
  }
}

// ─────────────────────────────────────────────
//  L2 — REDIS ADAPTER
// ─────────────────────────────────────────────

class RedisAdapter {
  /**
   * Thin wrapper around Redis client (ioredis or node-redis compatible).
   * Falls back gracefully if Redis is not connected.
   */
  constructor(client) {
    this._client    = client || null;
    this._connected = false;
    this._ops       = 0;
    this._errors    = 0;

    if (this._client) {
      this._client.on?.('connect', () => { this._connected = true; });
      this._client.on?.('error',   () => { this._connected = false; });
      this._client.on?.('ready',   () => { this._connected = true; });
    }
  }

  async get(key) {
    if (!this._client || !this._connected) return null;
    try {
      this._ops++;
      const val = await this._client.get(key);
      return val ? JSON.parse(val) : null;
    } catch (e) {
      this._errors++;
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    if (!this._client || !this._connected) return false;
    try {
      this._ops++;
      const str = JSON.stringify(value);
      if (ttlSeconds) {
        await this._client.setex(key, ttlSeconds, str);
      } else {
        await this._client.set(key, str);
      }
      return true;
    } catch (e) {
      this._errors++;
      return false;
    }
  }

  async del(key) {
    if (!this._client) return false;
    try { await this._client.del(key); return true; } catch { return false; }
  }

  async lpush(key, value, maxLen) {
    if (!this._client || !this._connected) return false;
    try {
      this._ops++;
      await this._client.lpush(key, JSON.stringify(value));
      if (maxLen) await this._client.ltrim(key, 0, maxLen - 1);
      return true;
    } catch (e) {
      this._errors++;
      return false;
    }
  }

  async lrange(key, start, stop) {
    if (!this._client || !this._connected) return [];
    try {
      const items = await this._client.lrange(key, start, stop);
      return items.map(i => { try { return JSON.parse(i); } catch { return i; } });
    } catch { return []; }
  }

  async hset(hash, field, value) {
    if (!this._client || !this._connected) return false;
    try { await this._client.hset(hash, field, JSON.stringify(value)); return true; } catch { return false; }
  }

  async hget(hash, field) {
    if (!this._client || !this._connected) return null;
    try {
      const val = await this._client.hget(hash, field);
      return val ? JSON.parse(val) : null;
    } catch { return null; }
  }

  async hgetall(hash) {
    if (!this._client || !this._connected) return {};
    try {
      const result = await this._client.hgetall(hash) || {};
      const parsed = {};
      for (const [k, v] of Object.entries(result)) {
        try { parsed[k] = JSON.parse(v); } catch { parsed[k] = v; }
      }
      return parsed;
    } catch { return {}; }
  }

  async publish(channel, data) {
    if (!this._client || !this._connected) return false;
    try { await this._client.publish(channel, JSON.stringify(data)); return true; } catch { return false; }
  }

  async incr(key) {
    if (!this._client || !this._connected) return 0;
    try { return await this._client.incr(key); } catch { return 0; }
  }

  async expire(key, ttl) {
    if (!this._client || !this._connected) return false;
    try { await this._client.expire(key, ttl); return true; } catch { return false; }
  }

  isConnected() { return this._connected; }

  getStats() {
    return { connected: this._connected, ops: this._ops, errors: this._errors };
  }
}

// ─────────────────────────────────────────────
//  L4 — PINECONE ADAPTER
// ─────────────────────────────────────────────

class PineconeAdapter {
  /**
   * Wraps Pinecone REST API for vector storage + similarity search.
   * Used to surface "similar past setups" for conflict resolution.
   *
   * @param {Object} config
   * @param {string} config.apiKey    - Pinecone API key
   * @param {string} config.indexUrl  - Pinecone index URL
   * @param {string} config.namespace - Namespace for isolation
   */
  constructor(config = {}) {
    this._apiKey    = config.apiKey    || null;
    this._indexUrl  = config.indexUrl  || null;
    this._namespace = config.namespace || 'trading';
    this._enabled   = !!(this._apiKey && this._indexUrl);
    this._upserts   = 0;
    this._queries   = 0;
    this._errors    = 0;
  }

  /**
   * Upsert a signal vector into Pinecone.
   */
  async upsert(id, vector, metadata = {}) {
    if (!this._enabled) return false;

    const body = {
      vectors: [{
        id:       String(id),
        values:   vector,
        metadata: {
          symbol:    metadata.symbol    || '',
          timeframe: metadata.timeframe || '',
          direction: metadata.direction || '',
          grade:     metadata.grade     || '',
          score:     metadata.score     || 0,
          timestamp: metadata.timestamp || _now(),
          pnlR:      metadata.pnlR      || 0,
          won:       metadata.won       || false,
        },
      }],
      namespace: this._namespace,
    };

    try {
      this._upserts++;
      await this._request('POST', '/vectors/upsert', body);
      return true;
    } catch (e) {
      this._errors++;
      return false;
    }
  }

  /**
   * Query Pinecone for top-K similar signals.
   * Returns array of { id, score, metadata }
   */
  async query(vector, topK = VECTOR_TOP_K, filter = {}) {
    if (!this._enabled) return [];

    const body = {
      vector:          vector,
      topK:            topK,
      includeMetadata: true,
      namespace:       this._namespace,
      filter:          Object.keys(filter).length > 0 ? filter : undefined,
    };

    try {
      this._queries++;
      const result = await this._request('POST', '/query', body);
      return (result.matches || []).map(m => ({
        id:       m.id,
        score:    _round(m.score, 4),
        metadata: m.metadata,
      }));
    } catch (e) {
      this._errors++;
      return [];
    }
  }

  /**
   * Update metadata for an existing vector (e.g. after trade closes).
   */
  async updateMetadata(id, metadata) {
    if (!this._enabled) return false;

    const body = {
      id,
      setMetadata: metadata,
      namespace:   this._namespace,
    };

    try {
      await this._request('POST', '/vectors/update', body);
      return true;
    } catch (e) {
      this._errors++;
      return false;
    }
  }

  async _request(method, path, body) {
    if (!this._indexUrl) throw new Error('Pinecone index URL not set');

    const url  = new URL(this._indexUrl + path);
    const data = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const opts = {
        hostname: url.hostname,
        path:     url.pathname,
        method,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Api-Key':        this._apiKey,
        },
      };

      const req = https.request(opts, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) reject(new Error(`Pinecone ${res.statusCode}: ${raw}`));
            else resolve(parsed);
          } catch (e) { reject(e); }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Pinecone timeout')); });
      req.write(data);
      req.end();
    });
  }

  getStats() {
    return { enabled: this._enabled, upserts: this._upserts, queries: this._queries, errors: this._errors };
  }
}

// ─────────────────────────────────────────────
//  PERFORMANCE STATS ENGINE
// ─────────────────────────────────────────────

class PerformanceStats {
  constructor() {
    this._signals  = [];   // all signals with outcomes
    this._lastCalc = 0;
    this._cache    = null;
  }

  add(signal) {
    this._signals.push(signal);
    if (this._signals.length > SIGNAL_HISTORY_MAX) this._signals.shift();
    this._cache = null; // invalidate
  }

  update(signalId, outcome) {
    const s = this._signals.find(s => s.id === signalId);
    if (s) { Object.assign(s, { outcome }); this._cache = null; }
  }

  calculate(filter = {}) {
    const cacheKey = JSON.stringify(filter);
    if (this._cache?.key === cacheKey && _now() - this._lastCalc < STATS_RECALC_INTERVAL) {
      return this._cache.data;
    }

    let signals = this._signals.filter(s => s.outcome);

    if (filter.symbol)    signals = signals.filter(s => s.symbol    === filter.symbol);
    if (filter.timeframe) signals = signals.filter(s => s.timeframe === filter.timeframe);
    if (filter.direction) signals = signals.filter(s => s.action    === filter.direction);
    if (filter.grade)     signals = signals.filter(s => s.score?.grade === filter.grade);
    if (filter.since)     signals = signals.filter(s => s.timestamp >= filter.since);

    const total   = signals.length;
    if (total === 0) return this._empty();

    const wins    = signals.filter(s => s.outcome.won).length;
    const losses  = total - wins;
    const winRate = _round(wins / total * 100, 2);

    const pnlValues = signals.map(s => s.outcome.pnlR || 0);
    const totalPnl  = _round(pnlValues.reduce((a, b) => a + b, 0), 4);
    const avgPnl    = _round(totalPnl / total, 4);

    const winPnl    = signals.filter(s => s.outcome.won).map(s => s.outcome.pnlR || 0);
    const lossPnl   = signals.filter(s => !s.outcome.won).map(s => Math.abs(s.outcome.pnlR || 0));
    const avgWin    = winPnl.length  ? _round(winPnl.reduce((a, b) => a + b, 0) / winPnl.length, 4) : 0;
    const avgLoss   = lossPnl.length ? _round(lossPnl.reduce((a, b) => a + b, 0) / lossPnl.length, 4) : 0;
    const pf        = avgLoss > 0 ? _round((avgWin * wins) / (avgLoss * losses), 3) : Infinity;

    // Max drawdown on equity curve
    let peak = 0, maxDD = 0, running = 0;
    for (const r of pnlValues) {
      running += r;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    }

    // By grade
    const byGrade = {};
    for (const g of ['A', 'B', 'C', 'D']) {
      const gs = signals.filter(s => s.score?.grade === g);
      byGrade[g] = {
        total: gs.length,
        wins:  gs.filter(s => s.outcome.won).length,
        winRate: gs.length ? _round(gs.filter(s => s.outcome.won).length / gs.length * 100, 2) : 0,
      };
    }

    // By symbol
    const bySymbol = {};
    const symbols  = [...new Set(signals.map(s => s.symbol))];
    for (const sym of symbols) {
      const ss = signals.filter(s => s.symbol === sym);
      const sw = ss.filter(s => s.outcome.won).length;
      bySymbol[sym] = {
        total: ss.length, wins: sw, losses: ss.length - sw,
        winRate: _round(sw / ss.length * 100, 2),
        pnl: _round(ss.reduce((a, s) => a + (s.outcome.pnlR || 0), 0), 3),
      };
    }

    // By session
    const bySess = {};
    for (const sess of ['LONDON', 'NEW_YORK', 'OVERLAP', 'ASIA', 'DEAD']) {
      const ss = signals.filter(s => s.session?.current === sess);
      if (ss.length === 0) continue;
      const sw = ss.filter(s => s.outcome.won).length;
      bySess[sess] = {
        total: ss.length, wins: sw,
        winRate: _round(sw / ss.length * 100, 2),
        avgPnl: _round(ss.reduce((a, s) => a + (s.outcome.pnlR || 0), 0) / ss.length, 3),
      };
    }

    // Consecutive stats
    let maxConsecWins = 0, maxConsecLoss = 0, curW = 0, curL = 0;
    for (const s of signals) {
      if (s.outcome.won) { curW++; curL = 0; maxConsecWins = Math.max(maxConsecWins, curW); }
      else               { curL++; curW = 0; maxConsecLoss = Math.max(maxConsecLoss, curL); }
    }

    // Kelly criterion
    const kellyF = avgLoss > 0
      ? Math.max(0, (winRate / 100 - (1 - winRate / 100) / (avgWin / avgLoss)))
      : 0;

    const stats = {
      total, wins, losses, winRate,
      totalPnl, avgPnl, avgWin, avgLoss,
      profitFactor: pf === Infinity ? 999 : pf,
      maxDrawdownR: _round(maxDD, 3),
      maxConsecWins, maxConsecLoss,
      byGrade, bySymbol, sessions: bySess,
      kelly: _round(kellyF * 100, 3),
      expectancy: _round(winRate / 100 * avgWin - (1 - winRate / 100) * avgLoss, 4),
      fired:  this._signals.length,
      period: filter.since ? `Since ${new Date(filter.since).toUTCString()}` : 'All time',
    };

    this._cache    = { key: cacheKey, data: stats };
    this._lastCalc = _now();
    return stats;
  }

  _empty() {
    return { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, fired: 0, byGrade: {}, bySymbol: {}, sessions: {} };
  }

  getRecent(n = 20) {
    return this._signals.slice(-n).reverse();
  }

  getSignal(id) {
    return this._signals.find(s => s.id === id) || null;
  }
}

// ─────────────────────────────────────────────
//  SYMBOL CONTEXT STORE
// ─────────────────────────────────────────────

class SymbolContext {
  /**
   * Stores per-symbol market context:
   * - Recent signals + outcomes
   * - Current HTF regime
   * - Key structure levels
   * - Agent vote history
   * - Performance stats
   */
  constructor() {
    this._contexts = new Map(); // symbol → context
  }

  update(symbol, data) {
    const existing = this._contexts.get(symbol) || this._default(symbol);
    const updated  = { ...existing, ...data, lastUpdated: _now() };
    this._contexts.set(symbol, updated);
  }

  get(symbol) {
    return this._contexts.get(symbol) || null;
  }

  addSignal(symbol, signal) {
    const ctx = this._contexts.get(symbol) || this._default(symbol);
    ctx.recentSignals.push({
      id:        signal.id,
      action:    signal.action,
      score:     signal.score?.final,
      grade:     signal.score?.grade,
      timeframe: signal.timeframe,
      timestamp: signal.timestamp,
    });
    if (ctx.recentSignals.length > 50) ctx.recentSignals.shift();
    this._contexts.set(symbol, ctx);
  }

  updateRegime(symbol, regime) {
    const ctx = this._contexts.get(symbol) || this._default(symbol);
    ctx.regime = { ...regime, timestamp: _now() };
    this._contexts.set(symbol, ctx);
  }

  addStructureLevel(symbol, level) {
    const ctx = this._contexts.get(symbol) || this._default(symbol);
    ctx.keyLevels.push({ ...level, timestamp: _now() });
    if (ctx.keyLevels.length > 20) ctx.keyLevels.shift();
    this._contexts.set(symbol, ctx);
  }

  getAll() {
    const result = {};
    for (const [sym, ctx] of this._contexts) result[sym] = ctx;
    return result;
  }

  _default(symbol) {
    return {
      symbol,
      regime:        null,
      keyLevels:     [],
      recentSignals: [],
      signalStats:   { total: 0, wins: 0, losses: 0 },
      lastUpdated:   _now(),
    };
  }
}

// ─────────────────────────────────────────────
//  MAIN MEMORY MANAGER
// ─────────────────────────────────────────────

class MemoryManager extends EventEmitter {
  /**
   * @param {Object} config
   * @param {Object}  [config.redis]      - Redis client (ioredis / node-redis)
   * @param {Object}  [config.postgres]   - PostgreSQL pool (pg)
   * @param {Object}  [config.pinecone]   - { apiKey, indexUrl, namespace }
   * @param {boolean} [config.vectorize]  - Enable Pinecone embeddings (default false)
   * @param {number}  [config.lruSize]    - L1 cache max size (default 2000)
   */
  constructor(config = {}) {
    super();

    // Storage layers
    this._lru     = new LRUCache(config.lruSize || LRU_MAX_SIZE);
    this._redis   = new RedisAdapter(config.redis || null);
    this._pg      = config.postgres || null;
    this._pinecone = config.pinecone
      ? new PineconeAdapter(config.pinecone)
      : new PineconeAdapter({});

    this._vectorize = config.vectorize || false;

    // Domain objects
    this._perf    = new PerformanceStats();
    this._symCtx  = new SymbolContext();
    this._embedder = SignalEmbedder;

    // Settings store (user preferences)
    this._settings = new Map();

    // System event log
    this._eventLog = [];

    // Stats
    this._ops = { saves: 0, reads: 0, updates: 0, errors: 0 };

    this._log('MemoryManager initialized', {
      redis:    this._redis.isConnected(),
      postgres: !!this._pg,
      pinecone: this._pinecone._enabled,
    });

    // Periodic persistence
    this._startPeriodicFlush();
  }

  // ─────────────────────────────────────────────
  //  SIGNAL STORAGE
  // ─────────────────────────────────────────────

  /**
   * Persist a new signal across all storage layers.
   * L1 → immediate  |  L2 → async  |  L3 → async  |  L4 → async
   */
  async saveSignal(signal) {
    if (!signal?.id) return;
    this._ops.saves++;

    const key   = `signal:${signal.id}`;
    const light = this._lightSignal(signal); // compressed version

    // ── L1: In-memory ──
    this._lru.set(key, signal, 30 * 60 * 1000); // 30 min hot cache

    // ── Domain objects ──
    this._perf.add(signal);
    this._symCtx.addSignal(signal.symbol, signal);

    // ── L2: Redis (async, non-blocking) ──
    this._redis.set(key, light, REDIS_SIGNAL_TTL).catch(() => {});
    this._redis.lpush(`signals:history:${signal.symbol}`, light, 200).catch(() => {});
    this._redis.lpush('signals:all', light, 1000).catch(() => {});
    if (signal.score?.grade === 'A') {
      this._redis.lpush('signals:grade_a', light, 100).catch(() => {});
      this._redis.publish('signals:grade_a', signal).catch(() => {});
    }
    this._redis.publish('signals:all', signal).catch(() => {});

    // ── L3: PostgreSQL (async) ──
    this._pgSaveSignal(signal).catch(e => this._log('PG save error:', e.message));

    // ── L4: Pinecone embedding (async, optional) ──
    if (this._vectorize) {
      const vec = this._embedder.embed(signal);
      this._pinecone.upsert(signal.id, vec, {
        symbol:    signal.symbol,
        timeframe: signal.timeframe,
        direction: signal.action,
        grade:     signal.score?.grade,
        score:     signal.score?.final,
        timestamp: signal.timestamp,
      }).catch(() => {});
    }

    this.emit('signal_saved', { id: signal.id, symbol: signal.symbol });
  }

  /**
   * Retrieve a signal by ID.
   * L1 → L2 → L3 cascade.
   */
  async getSignal(signalId) {
    this._ops.reads++;
    const key = `signal:${signalId}`;

    // L1
    const l1 = this._lru.get(key);
    if (l1) { this.emit('memory_hit', { layer: 'L1', key }); return l1; }

    // L2
    const l2 = await this._redis.get(key);
    if (l2) {
      this._lru.set(key, l2);
      this.emit('memory_hit', { layer: 'L2', key });
      return l2;
    }

    // L3
    const l3 = await this._pgGetSignal(signalId);
    if (l3) {
      this._lru.set(key, l3);
      return l3;
    }

    return null;
  }

  /**
   * Update signal with trade outcome (called when trade closes).
   */
  async updateOutcome(signalId, outcome) {
    this._ops.updates++;

    const signal = await this.getSignal(signalId);
    if (!signal) return false;

    signal.outcome = { ...outcome, closedAt: _now() };

    // Update all layers
    this._lru.set(`signal:${signalId}`, signal);
    this._perf.update(signalId, outcome);
    this._redis.set(`signal:${signalId}`, this._lightSignal(signal), REDIS_SIGNAL_TTL).catch(() => {});
    this._pgUpdateOutcome(signalId, outcome).catch(() => {});

    // Update Pinecone vector metadata
    if (this._vectorize) {
      this._pinecone.updateMetadata(signalId, {
        pnlR: outcome.pnlR,
        won:  outcome.won,
        tpHit: outcome.tpHit,
      }).catch(() => {});
    }

    this.emit('outcome_saved', { signalId, outcome });
    return true;
  }

  // ─────────────────────────────────────────────
  //  SIGNAL HISTORY + RETRIEVAL
  // ─────────────────────────────────────────────

  async getRecentSignals(n = 20, filter = {}) {
    this._ops.reads++;

    // Try Redis first for speed
    let signals = await this._redis.lrange('signals:all', 0, n * 2);

    if (!signals.length) {
      // Fallback to in-memory performance store
      signals = this._perf.getRecent(n);
    }

    // Apply filters
    if (filter.symbol)    signals = signals.filter(s => s.symbol    === filter.symbol);
    if (filter.direction) signals = signals.filter(s => s.action    === filter.direction);
    if (filter.grade)     signals = signals.filter(s => s.score?.grade === filter.grade);
    if (filter.minScore)  signals = signals.filter(s => (s.score?.final || 0) >= filter.minScore);

    return signals.slice(0, n);
  }

  async getSignalsBySymbol(symbol, n = 50) {
    const key   = `signal:${symbol}`;
    const l1    = this._lru.scan(`signal:${symbol}`);
    if (l1.length >= 5) return l1.map(e => e.value).slice(0, n);

    const l2 = await this._redis.lrange(`signals:history:${symbol}`, 0, n);
    return l2;
  }

  // ─────────────────────────────────────────────
  //  VECTOR SIMILARITY SEARCH
  // ─────────────────────────────────────────────

  /**
   * Find similar past setups for a new signal.
   * Falls back to in-memory brute-force if Pinecone unavailable.
   *
   * @param {Object} signal - new signal to match
   * @param {Object} opts   - { topK, minSimilarity, filter }
   * @returns {Array} similar signals with similarity score + outcome
   */
  async findSimilar(signal, opts = {}) {
    const topK          = opts.topK          || VECTOR_TOP_K;
    const minSimilarity = opts.minSimilarity || 0.75;
    const vec           = this._embedder.embed(signal);

    // ── Pinecone ──
    if (this._vectorize && this._pinecone._enabled) {
      const filter = opts.filter || {};
      if (signal.symbol)    filter.symbol    = { $eq: signal.symbol };
      if (signal.timeframe) filter.timeframe = { $eq: signal.timeframe };

      const matches = await this._pinecone.query(vec, topK, filter);
      const result  = matches.filter(m => m.score >= minSimilarity);

      if (result.length > 0) {
        this.emit('similar_found', { count: result.length, method: 'PINECONE', signalId: signal.id });
        return result;
      }
    }

    // ── In-memory brute force fallback ──
    const candidates = this._perf.getRecent(200).filter(s => s.id !== signal.id && s.outcome);
    const scored = candidates.map(s => ({
      id:         s.id,
      score:      this._embedder.cosineSim(vec, this._embedder.embed(s)),
      metadata:   {
        symbol: s.symbol, direction: s.action, grade: s.score?.grade,
        score: s.score?.final, timestamp: s.timestamp,
        pnlR: s.outcome?.pnlR, won: s.outcome?.won,
      },
    })).filter(s => s.score >= minSimilarity)
       .sort((a, b) => b.score - a.score)
       .slice(0, topK);

    if (scored.length > 0) {
      this.emit('similar_found', { count: scored.length, method: 'MEMORY', signalId: signal.id });
    }

    return scored;
  }

  // ─────────────────────────────────────────────
  //  PERFORMANCE STATS
  // ─────────────────────────────────────────────

  getStats(filter = {}) {
    return this._perf.calculate(filter);
  }

  getTodayStats() {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    return this._perf.calculate({ since: midnight.getTime() });
  }

  getSymbolStats(symbol) {
    return this._perf.calculate({ symbol });
  }

  getGradeStats(grade) {
    return this._perf.calculate({ grade });
  }

  // ─────────────────────────────────────────────
  //  SYMBOL CONTEXT
  // ─────────────────────────────────────────────

  updateSymbolContext(symbol, data) {
    this._symCtx.update(symbol, data);
    const key = `ctx:${symbol}`;
    this._lru.set(key, data, 60 * 60 * 1000); // 1 hour
    this._redis.set(key, data, REDIS_CONTEXT_TTL).catch(() => {});
  }

  getSymbolContext(symbol) {
    // L1 first
    const l1 = this._lru.get(`ctx:${symbol}`);
    if (l1) return l1;
    return this._symCtx.get(symbol);
  }

  updateHTFRegime(symbol, regime) {
    this._symCtx.updateRegime(symbol, regime);
    this._lru.set(`regime:${symbol}`, regime, 4 * 60 * 60 * 1000); // 4 hours
  }

  getHTFRegime(symbol) {
    return this._lru.get(`regime:${symbol}`) || this._symCtx.get(symbol)?.regime;
  }

  addKeyLevel(symbol, level) {
    this._symCtx.addStructureLevel(symbol, level);
  }

  // ─────────────────────────────────────────────
  //  SETTINGS / USER PREFERENCES
  // ─────────────────────────────────────────────

  async setSetting(key, value) {
    this._settings.set(key, value);
    await this._redis.hset('settings', key, value);
    this._lru.set(`setting:${key}`, value, 24 * 60 * 60 * 1000);
  }

  async getSetting(key, defaultVal = null) {
    // L1
    const l1 = this._lru.get(`setting:${key}`);
    if (l1 !== null) return l1;

    // Memory
    if (this._settings.has(key)) return this._settings.get(key);

    // L2
    const l2 = await this._redis.hget('settings', key);
    if (l2 !== null) {
      this._settings.set(key, l2);
      this._lru.set(`setting:${key}`, l2, 24 * 60 * 60 * 1000);
      return l2;
    }

    return defaultVal;
  }

  async getAllSettings() {
    const l2 = await this._redis.hgetall('settings');
    for (const [k, v] of Object.entries(l2)) this._settings.set(k, v);
    return Object.fromEntries(this._settings);
  }

  // ─────────────────────────────────────────────
  //  SYSTEM EVENT LOG
  // ─────────────────────────────────────────────

  logEvent(type, data) {
    const entry = { type, data, timestamp: _now() };
    this._eventLog.push(entry);
    if (this._eventLog.length > 500) this._eventLog.shift();
    this._redis.lpush('events:system', entry, 200).catch(() => {});
  }

  getEventLog(n = 50, type = null) {
    let log = this._eventLog.slice(-n).reverse();
    if (type) log = log.filter(e => e.type === type);
    return log;
  }

  // ─────────────────────────────────────────────
  //  AGENT VOTE HISTORY
  // ─────────────────────────────────────────────

  async saveAgentVote(agentName, symbol, timeframe, vote) {
    const key = `votes:${agentName}:${symbol}:${timeframe}`;
    const entry = { ...vote, savedAt: _now() };

    this._lru.set(key, entry, 60 * 60 * 1000); // 1 hour
    await this._redis.lpush(key, entry, 50);
    await this._redis.expire(key, 24 * 60 * 60); // 24 hour TTL
  }

  async getAgentVoteHistory(agentName, symbol, timeframe, n = 20) {
    const key = `votes:${agentName}:${symbol}:${timeframe}`;
    return this._redis.lrange(key, 0, n - 1);
  }

  // ─────────────────────────────────────────────
  //  POSTGRES HELPERS
  // ─────────────────────────────────────────────

  async _pgSaveSignal(signal) {
    if (!this._pg) return;
    const q = `
      INSERT INTO signals (
        id, symbol, timeframe, action, score, grade,
        entry_zone_low, entry_zone_high, sl_price, sl_risk_pct,
        tp1_price, tp1_rr, tp2_price, tp2_rr, tp3_price, tp3_rr,
        session, htf_bias, agent_votes, all_reasons, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    const v = signal;
    await this._pg.query(q, [
      v.id, v.symbol, v.timeframe, v.action,
      v.score?.final, v.score?.grade,
      v.entry?.zoneLow, v.entry?.zoneHigh,
      v.stopLoss?.price, v.stopLoss?.riskPct,
      v.targets?.tp1?.price, v.targets?.tp1?.rr,
      v.targets?.tp2?.price, v.targets?.tp2?.rr,
      v.targets?.tp3?.price, v.targets?.tp3?.rr,
      v.session?.current, v.htfBias?.direction,
      JSON.stringify(v.agentVotes),
      JSON.stringify(v.allReasons),
    ]).catch(e => this._log('PG insert error:', e.message));
  }

  async _pgGetSignal(id) {
    if (!this._pg) return null;
    try {
      const res = await this._pg.query('SELECT * FROM signals WHERE id=$1', [id]);
      return res.rows[0] || null;
    } catch { return null; }
  }

  async _pgUpdateOutcome(signalId, outcome) {
    if (!this._pg) return;
    const q = `
      UPDATE signals SET
        pnl_r=$1, won=$2, tp_hit=$3, closed_at=NOW(), outcome=$4
      WHERE id=$5
    `;
    await this._pg.query(q, [
      outcome.pnlR, outcome.won, outcome.tpHit,
      JSON.stringify(outcome), signalId,
    ]).catch(e => this._log('PG update error:', e.message));
  }

  // ─────────────────────────────────────────────
  //  PERIODIC FLUSH
  // ─────────────────────────────────────────────

  _startPeriodicFlush() {
    // Persist settings to Redis every 5 min
    setInterval(async () => {
      for (const [k, v] of this._settings) {
        await this._redis.hset('settings', k, v).catch(() => {});
      }
    }, 5 * 60 * 1000);

    // Persist performance stats summary every 10 min
    setInterval(async () => {
      const stats = this._perf.calculate();
      await this._redis.set('stats:performance', stats, REDIS_STATS_TTL).catch(() => {});
      this.emit('stats_updated', stats);
    }, 10 * 60 * 1000);
  }

  // ─────────────────────────────────────────────
  //  UTILS
  // ─────────────────────────────────────────────

  // Compressed signal for Redis (drops heavy nested analysis)
  _lightSignal(signal) {
    const { agentVotes, ...rest } = signal;
    return {
      ...rest,
      agentSummary: {
        smc:       { direction: agentVotes?.smc?.direction,      score: agentVotes?.smc?.score },
        mtf:       { direction: agentVotes?.mtf?.direction,      score: agentVotes?.mtf?.score },
        momentum:  { direction: agentVotes?.momentum?.direction, score: agentVotes?.momentum?.score },
      },
    };
  }

  getFullStats() {
    return {
      lru:      this._lru.getStats(),
      redis:    this._redis.getStats(),
      pinecone: this._pinecone.getStats(),
      ops:      this._ops,
      signals:  this._perf.getRecent(5).map(s => ({ id: s.id, symbol: s.symbol, grade: s.score?.grade })),
    };
  }

  _log(msg, data) {
    data ? console.log(`[MemoryManager] ${msg}`, data) : console.log(`[MemoryManager] ${msg}`);
  }
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  MemoryManager,
  LRUCache,
  RedisAdapter,
  PineconeAdapter,
  SignalEmbedder,
  PerformanceStats,
  SymbolContext,
};