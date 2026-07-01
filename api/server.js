'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { bus } = require('./realtime');
const db = require('../db');
const { telegramAuthMiddleware, validateTelegramInitData } = require('./telegram-auth');
const { FinnhubFeed } = require('../feeds/finnhub-feed');
const { AdaptiveLearningEngine } = require('../signal-pipeline/adaptive-learning-engine');

const API_PORT = Number(process.env.PORT || process.env.WS_PORT || 3001);
const STATIC_ROOT = path.join(__dirname, '..', 'webapp');
const finnhub = new FinnhubFeed();
const learningEngine = new AdaptiveLearningEngine({ store: db });

let serverState = null;

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: true,
  }));
  app.use(compression());
  app.use(express.json({ limit: '512kb' }));
  app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.API_RATE_LIMIT_PER_MIN || 120),
    standardHeaders: true,
    legacyHeaders: false,
  }));

  app.get('/health', async (_req, res) => {
    let mongo = { ok: false };
    try { mongo = await db.health(); } catch (err) { mongo = { ok: false, error: err.message }; }
    res.json({
      ok: true,
      service: 'omnicee-api',
      uptime: process.uptime(),
      mongo,
      finnhub: finnhub.enabled(),
    });
  });

  app.post('/api/auth/telegram', async (req, res) => {
    const validation = validateTelegramInitData(req.body?.initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!validation.ok) return res.status(401).json({ ok: false, error: validation.reason });
    try { await db.upsertTelegramUser(validation.user); } catch (_) {}
    res.json({ ok: true, user: validation.user });
  });

  app.get('/api/signals', telegramAuthMiddleware, async (req, res) => {
    const signals = await db.getRecentSignals({
      symbol: req.query.symbol,
      limit: req.query.limit || 50,
    }).catch(err => {
      res.status(503).json({ ok: false, error: err.message });
      return null;
    });
    if (signals) res.json({ ok: true, signals });
  });

  app.get('/api/telemetry', telegramAuthMiddleware, async (req, res) => {
    const telemetry = await db.getTelemetry({ limit: req.query.limit || 100 }).catch(err => {
      res.status(503).json({ ok: false, error: err.message });
      return null;
    });
    if (telemetry) res.json({ ok: true, telemetry });
  });

  app.get('/api/stats', telegramAuthMiddleware, async (_req, res) => {
    const stats = await db.getStats().catch(err => ({ db: 'error', error: err.message }));
    res.json({ ok: true, stats });
  });

  app.get('/api/news', telegramAuthMiddleware, async (req, res) => {
    const symbol = req.query.symbol;
    const news = symbol
      ? await finnhub.companyNews(symbol).catch(err => ({ error: err.message }))
      : await finnhub.marketNews(req.query.category || 'general').catch(err => ({ error: err.message }));
    res.json({ ok: !news.error, news });
  });

  app.get('/api/learning', telegramAuthMiddleware, async (req, res) => {
    const profiles = await db.getLearningProfiles({ limit: req.query.limit || 50 }).catch(err => {
      res.status(503).json({ ok: false, error: err.message });
      return null;
    });
    if (profiles) res.json({ ok: true, profiles });
  });

  app.post('/api/outcomes', telegramAuthMiddleware, async (req, res) => {
    const { signalId, outcome } = req.body || {};
    if (!signalId || !outcome) return res.status(400).json({ ok: false, error: 'signalId and outcome are required' });

    const [signal] = await db.getRecentSignals({ limit: 200 }).then(list => list.filter(s => s.id === signalId)).catch(() => []);
    if (!signal) return res.status(404).json({ ok: false, error: 'Signal not found in MongoDB history' });

    const saved = await learningEngine.recordOutcome({ signalId, signal, outcome }).catch(err => {
      res.status(503).json({ ok: false, error: err.message });
      return null;
    });
    if (!saved) return;

    bus.emit('telemetry_update', {
      type: 'outcome_recorded',
      symbol: saved.symbol,
      timeframe: saved.timeframe,
      payload: { result: saved.result, pnlR: saved.pnlR, patternKey: saved.patternKey },
      timestamp: Date.now(),
    });
    res.json({ ok: true, outcome: saved });
  });

  app.use(express.static(STATIC_ROOT, {
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '5m' : 0,
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    return res.sendFile(path.join(STATIC_ROOT, 'index.html'));
  });

  return app;
}

function startServer(config = {}) {
  if (serverState) return serverState;
  const app = createApp();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true },
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket, next) => {
    const initData = socket.handshake.auth?.initData || socket.handshake.query?.initData;
    if (!initData && process.env.NODE_ENV !== 'production') return next();
    const validation = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!validation.ok) return next(new Error(validation.reason));
    socket.telegramUser = validation.user;
    try { await db.upsertTelegramUser(validation.user); } catch (_) {}
    return next();
  });

  io.on('connection', socket => {
    socket.emit('connected', { serverTime: Date.now(), transport: 'socket.io' });
    socket.on('setting', payload => bus.emit('setting_change', { socketId: socket.id, ...payload }));
    socket.on('get_history', async payload => {
      const signals = await db.getRecentSignals({ symbol: payload?.symbol, limit: payload?.limit || 50 }).catch(() => []);
      socket.emit('history', { signals });
    });
    socket.on('record_outcome', async payload => {
      const [signal] = await db.getRecentSignals({ limit: 200 }).then(list => list.filter(s => s.id === payload?.signalId)).catch(() => []);
      if (!signal) return socket.emit('outcome_error', { error: 'Signal not found' });
      const outcome = await learningEngine.recordOutcome({ signalId: payload.signalId, signal, outcome: payload.outcome }).catch(err => ({ error: err.message }));
      if (outcome.error) return socket.emit('outcome_error', outcome);
      socket.emit('outcome_saved', outcome);
      bus.emit('telemetry_update', {
        type: 'outcome_recorded',
        symbol: outcome.symbol,
        timeframe: outcome.timeframe,
        payload: { result: outcome.result, pnlR: outcome.pnlR, patternKey: outcome.patternKey },
        timestamp: Date.now(),
      });
    });
  });

  const forward = (event, channel, persist) => {
    bus.on(event, async payload => {
      io.emit(channel, payload);
      if (persist) persist(payload).catch(err => console.warn(`[API] persist ${event}:`, err.message));
    });
  };

  forward('signal', 'signal', db.saveSignal);
  forward('market_update', 'market', db.saveMarketSnapshot);
  forward('risk_update', 'risk');
  forward('stats_update', 'stats');
  forward('regime_update', 'regime', payload => db.saveTelemetry({ type: 'regime_update', ...payload }));
  forward('telemetry_update', 'telemetry', db.saveTelemetry);

  const port = Number(config.port || API_PORT);
  httpServer.listen(port, () => {
    console.log(`[API] OMNICEE REST + Socket.IO listening on http://localhost:${port}`);
  });

  serverState = {
    app,
    io,
    httpServer,
    port,
    close(cb) {
      io.close();
      httpServer.close(cb);
    },
  };
  return serverState;
}

if (require.main === module) startServer();

module.exports = { createApp, startServer, bus };
