'use strict';

require('dotenv').config();

const { MongoClient } = require('mongodb');

const DB_NAME = process.env.MONGODB_DB || 'omnicee_db';
const MONGODB_URI = process.env.MONGODB_URI || '';
const ENABLE_DB = Boolean(MONGODB_URI);

let client = null;
let dbConnection = null;
let indexPromise = null;

function compactSignal(signal = {}) {
  return {
    id: signal.id,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    action: signal.action,
    timestamp: signal.timestamp || Date.now(),
    currentPrice: signal.currentPrice,
    score: signal.score,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    targets: signal.targets,
    regime: signal.regime ? {
      regime: signal.regime.regime,
      trend: signal.regime.trend,
      structure: signal.regime.structure,
      volatility: signal.regime.volatility,
      tradeability: signal.regime.tradeability,
      confidence: signal.regime.confidence,
    } : null,
    gate: signal.gate ? {
      status: signal.gate.status,
      confidence: signal.gate.confidence,
      failures: signal.gate.failures || [],
      warnings: signal.gate.warnings || [],
      checklist: signal.gate.checklist || {},
    } : null,
    risk: signal.riskEvaluation ? {
      approved: signal.riskEvaluation.approved,
      effectiveRisk: signal.riskEvaluation.effectiveRisk,
      maxLoss: signal.riskEvaluation.maxLoss,
      note: signal.riskEvaluation.note,
    } : null,
    agents: (signal.agentBreakdown || []).map(a => ({
      agent: a.agent,
      score: a.score,
      direction: a.direction,
      status: a.status,
    })),
    reasons: (signal.allReasons || []).slice(0, 8),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * Number(process.env.MONGODB_SIGNAL_TTL_DAYS || 14)),
  };
}

function compactTelemetry(event = {}) {
  return {
    type: event.type || 'event',
    symbol: event.symbol || null,
    timeframe: event.timeframe || null,
    gate: event.gate ? {
      status: event.gate.status,
      confidence: event.gate.confidence,
      failures: event.gate.failures || [],
      warnings: event.gate.warnings || [],
    } : null,
    regime: event.regime ? {
      regime: event.regime.regime,
      tradeability: event.regime.tradeability,
      confidence: event.regime.confidence,
    } : null,
    payload: event.payload || null,
    timestamp: event.timestamp || Date.now(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * Number(process.env.MONGODB_TELEMETRY_TTL_DAYS || 3)),
  };
}

async function getDB() {
  if (!ENABLE_DB) return null;
  if (dbConnection) return dbConnection;

  client = new MongoClient(MONGODB_URI, {
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL || 3),
    minPoolSize: 0,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    socketTimeoutMS: 25000,
    retryWrites: true,
    retryReads: true,
    compressors: ['zstd', 'snappy'],
  });

  await client.connect();
  dbConnection = client.db(DB_NAME);
  indexPromise = ensureIndexes(dbConnection).catch(err => {
    console.warn('[MongoDB] index setup warning:', err.message);
  });
  console.log(`[MongoDB] Connected to ${DB_NAME}`);
  return dbConnection;
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('signals').createIndexes([
      { key: { id: 1 }, unique: true, sparse: true, name: 'uniq_signal_id' },
      { key: { symbol: 1, timeframe: 1, timestamp: -1 }, name: 'signal_lookup' },
      { key: { 'score.final': -1, timestamp: -1 }, name: 'score_recent' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'signal_ttl' },
    ]),
    db.collection('telemetry').createIndexes([
      { key: { type: 1, timestamp: -1 }, name: 'telemetry_type_recent' },
      { key: { symbol: 1, timestamp: -1 }, name: 'telemetry_symbol_recent' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'telemetry_ttl' },
    ]),
    db.collection('users').createIndexes([
      { key: { telegramId: 1 }, unique: true, name: 'uniq_telegram_user' },
      { key: { lastSeenAt: -1 }, name: 'users_recent' },
    ]),
    db.collection('market_snapshots').createIndexes([
      { key: { symbol: 1, timestamp: -1 }, name: 'market_symbol_recent' },
      { key: { createdAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 3, name: 'market_ttl_3d' },
    ]),
    db.collection('trade_outcomes').createIndexes([
      { key: { signalId: 1 }, unique: true, sparse: true, name: 'uniq_outcome_signal' },
      { key: { patternKey: 1, closedAt: -1 }, name: 'outcome_pattern_recent' },
      { key: { symbol: 1, timeframe: 1, closedAt: -1 }, name: 'outcome_symbol_recent' },
    ]),
  ]);
}

async function saveSignal(signal) {
  const db = await getDB();
  if (!db) return { skipped: true, reason: 'MONGODB_URI not configured' };
  await indexPromise;
  const doc = compactSignal(signal);
  await db.collection('signals').updateOne(
    { id: doc.id || `${doc.symbol}:${doc.timeframe}:${doc.timestamp}` },
    { $set: doc, $setOnInsert: { firstSeenAt: new Date() } },
    { upsert: true }
  );
  return { saved: true };
}

// Throttle telemetry to save free-tier storage (max 1 regime per symbol per min)
const _lastTelemetrySave = {};
async function saveTelemetry(event) {
  const key = `${event.type}:${event.symbol}`;
  const now = Date.now();
  if (event.type === 'regime_update' && _lastTelemetrySave[key] && now - _lastTelemetrySave[key] < 60 * 1000) {
    return { skipped: true, reason: 'throttled regime telemetry' };
  }
  _lastTelemetrySave[key] = now;
  const db = await getDB();
  if (!db) return { skipped: true, reason: 'MONGODB_URI not configured' };
  await indexPromise;
  await db.collection('telemetry').insertOne(compactTelemetry(event));
  return { saved: true };
}

// Throttle market snapshots to save free-tier storage (1 per symbol per 5 min)
const _lastMarketSave = {};
async function saveMarketSnapshot(snapshot) {
  const db = await getDB();
  if (!db) return { skipped: true, reason: 'MONGODB_URI not configured' };
  const key = snapshot.symbol || 'unknown';
  const now = Date.now();
  if (_lastMarketSave[key] && now - _lastMarketSave[key] < 5 * 60 * 1000) {
    return { skipped: true, reason: 'throttled (free tier optimization)' };
  }
  _lastMarketSave[key] = now;
  await db.collection('market_snapshots').insertOne({
    symbol: snapshot.symbol,
    price: snapshot.price,
    change: snapshot.change,
    timestamp: snapshot.timestamp || now,
    createdAt: new Date(),
  });
  return { saved: true };
}

async function getRecentSignals({ symbol, limit = 50 } = {}) {
  const db = await getDB();
  if (!db) return [];
  const query = symbol ? { symbol } : {};
  return db.collection('signals')
    .find(query, { projection: { reasoning: 0, tradePlan: 0 } })
    .sort({ timestamp: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .toArray();
}

async function getTelemetry({ limit = 100 } = {}) {
  const db = await getDB();
  if (!db) return [];
  return db.collection('telemetry')
    .find({})
    .sort({ timestamp: -1 })
    .limit(Math.min(Number(limit) || 100, 300))
    .toArray();
}

async function saveTradeOutcome(outcome) {
  const db = await getDB();
  if (!db) return { skipped: true, reason: 'MONGODB_URI not configured' };
  await indexPromise;
  const doc = {
    ...outcome,
    closedAt: outcome.closedAt || Date.now(),
    createdAt: new Date(),
  };
  const filter = doc.signalId ? { signalId: doc.signalId } : { patternKey: doc.patternKey, closedAt: doc.closedAt };
  await db.collection('trade_outcomes').updateOne(
    filter,
    { $set: doc, $setOnInsert: { firstSeenAt: new Date() } },
    { upsert: true }
  );
  return { saved: true };
}

async function getLearningProfile(patternKey) {
  const db = await getDB();
  if (!db || !patternKey) return null;
  const [profile] = await db.collection('trade_outcomes').aggregate([
    { $match: { patternKey } },
    { $sort: { closedAt: -1 } },
    { $limit: 120 },
    {
      $group: {
        _id: '$patternKey',
        samples: { $sum: 1 },
        wins: { $sum: { $cond: [{ $gt: ['$pnlR', 0] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $lt: ['$pnlR', 0] }, 1, 0] } },
        breakevens: { $sum: { $cond: [{ $eq: ['$pnlR', 0] }, 1, 0] } },
        expectancyR: { $avg: '$pnlR' },
        avgWinR: { $avg: { $cond: [{ $gt: ['$pnlR', 0] }, '$pnlR', null] } },
        avgLossR: { $avg: { $cond: [{ $lt: ['$pnlR', 0] }, '$pnlR', null] } },
        lastClosedAt: { $max: '$closedAt' },
      },
    },
    {
      $addFields: {
        patternKey: '$_id',
        winRate: { $cond: [{ $gt: ['$samples', 0] }, { $divide: ['$wins', '$samples'] }, 0] },
      },
    },
  ]).toArray();
  return profile || null;
}

async function getLearningProfiles({ limit = 50 } = {}) {
  const db = await getDB();
  if (!db) return [];
  return db.collection('trade_outcomes').aggregate([
    { $sort: { closedAt: -1 } },
    {
      $group: {
        _id: '$patternKey',
        fingerprint: { $first: '$fingerprint' },
        samples: { $sum: 1 },
        wins: { $sum: { $cond: [{ $gt: ['$pnlR', 0] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $lt: ['$pnlR', 0] }, 1, 0] } },
        expectancyR: { $avg: '$pnlR' },
        lastClosedAt: { $max: '$closedAt' },
      },
    },
    { $addFields: { patternKey: '$_id', winRate: { $cond: [{ $gt: ['$samples', 0] }, { $divide: ['$wins', '$samples'] }, 0] } } },
    { $sort: { expectancyR: 1, samples: -1 } },
    { $limit: Math.min(Number(limit) || 50, 100) },
  ]).toArray();
}

async function upsertTelegramUser(user = {}) {
  const db = await getDB();
  if (!db || !user.id) return null;
  const telegramId = String(user.id);
  await db.collection('users').updateOne(
    { telegramId },
    {
      $set: {
        telegramId,
        username: user.username || null,
        firstName: user.first_name || user.firstName || null,
        lastName: user.last_name || user.lastName || null,
        languageCode: user.language_code || null,
        lastSeenAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  return db.collection('users').findOne({ telegramId });
}

async function getStats() {
  const db = await getDB();
  if (!db) return { db: 'disabled' };
  const [signals, telemetry, users] = await Promise.all([
    db.collection('signals').estimatedDocumentCount(),
    db.collection('telemetry').estimatedDocumentCount(),
    db.collection('users').estimatedDocumentCount(),
  ]);
  const outcomes = await db.collection('trade_outcomes').estimatedDocumentCount().catch(() => 0);
  return { db: 'connected', signals, telemetry, users, outcomes };
}

async function health() {
  if (!ENABLE_DB) return { ok: true, enabled: false };
  const db = await getDB();
  await db.command({ ping: 1 });
  return { ok: true, enabled: true, db: DB_NAME };
}

async function close() {
  if (client) await client.close();
  client = null;
  dbConnection = null;
}

module.exports = {
  getDB,
  ensureIndexes,
  saveSignal,
  saveTelemetry,
  saveMarketSnapshot,
  getRecentSignals,
  getTelemetry,
  saveTradeOutcome,
  getLearningProfile,
  getLearningProfiles,
  upsertTelegramUser,
  getStats,
  health,
  close,
};
