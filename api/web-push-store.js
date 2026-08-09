'use strict';

const { MongoClient } = require('mongodb');
const { isConfigured, send, validateSubscription } = require('./web-push');

const DB_NAME = String(process.env.MONGODB_DB || 'omnicee_db').trim();
const URI = String(process.env.MONGODB_URI || '').trim();
let client = null;
let database = null;
let indexesReady = false;

async function getDb() {
  if (!URI) throw new Error('MONGODB_URI is required for Web Push subscriptions');
  if (!client) client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  if (!database) {
    await client.connect();
    database = client.db(DB_NAME);
  }
  if (!indexesReady) {
    const c = database.collection('web_push_subscriptions');
    await c.createIndex({ userId: 1, endpoint: 1 }, { unique: true });
    await c.createIndex({ userId: 1, updatedAt: -1 });
    indexesReady = true;
  }
  return database;
}

function normalizeUserId(userId) {
  const value = String(userId || '').trim().toLowerCase();
  if (!value || value.length > 320) throw new Error('Invalid user identity');
  return value;
}

async function save(userId, subscription) {
  const uid = normalizeUserId(userId);
  if (!validateSubscription(subscription)) throw new Error('Invalid Web Push subscription');
  const db = await getDb();
  const now = new Date();
  await db.collection('web_push_subscriptions').updateOne(
    { userId: uid, endpoint: subscription.endpoint },
    { $set: { userId: uid, endpoint: subscription.endpoint, subscription, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  return { ok: true };
}

async function remove(userId, endpoint) {
  const uid = normalizeUserId(userId);
  const ep = String(endpoint || '').trim();
  if (!/^https:\/\//i.test(ep)) throw new Error('Invalid endpoint');
  const db = await getDb();
  await db.collection('web_push_subscriptions').deleteOne({ userId: uid, endpoint: ep });
  return { ok: true };
}

async function notifyUser(userId, payload) {
  if (!isConfigured()) return { sent: 0, skipped: true, reason: 'WEB_PUSH_NOT_CONFIGURED' };
  const uid = normalizeUserId(userId);
  const db = await getDb();
  const collection = db.collection('web_push_subscriptions');
  const docs = await collection.find({ userId: uid }).limit(20).toArray();
  let sent = 0;
  for (const doc of docs) {
    try {
      await send(doc.subscription, payload);
      sent += 1;
    } catch (err) {
      const status = Number(err.statusCode || 0);
      if (status === 404 || status === 410) await collection.deleteOne({ _id: doc._id });
      else console.warn('[WEB PUSH] delivery failed:', err.message);
    }
  }
  return { sent, skipped: false };
}

async function notifyAll(payload) {
  if (!isConfigured()) return { sent: 0, skipped: true, reason: 'WEB_PUSH_NOT_CONFIGURED' };
  const db = await getDb();
  const collection = db.collection('web_push_subscriptions');
  const docs = await collection.find({}).limit(500).toArray();
  let sent = 0;
  for (const doc of docs) {
    try {
      await send(doc.subscription, payload);
      sent += 1;
    } catch (err) {
      const status = Number(err.statusCode || 0);
      if (status === 404 || status === 410) await collection.deleteOne({ _id: doc._id });
      else console.warn('[WEB PUSH] delivery failed:', err.message);
    }
  }
  return { sent, skipped: false };
}

module.exports = { save, remove, notifyUser, notifyAll };
