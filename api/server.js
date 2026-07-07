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
const { bus, getDispatcher, getEngines } = require('./realtime');
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

    // FIX: use the live singleton instances from index.js when running together
    // (npm run start:all / pm2), so real outcomes update the SAME objects the
    // signal-scoring pipeline actually consults, not a disconnected local copy.
    const liveEngines = getEngines();
    const activeLearningEngine = liveEngines.adaptiveLearning || learningEngine;

    const saved = await activeLearningEngine.recordOutcome({ signalId, signal, outcome }).catch(err => {
      res.status(503).json({ ok: false, error: err.message });
      return null;
    });
    if (!saved) return;

    // FIX: bayesianEngine, walkForwardOptimizer, institutionalGates, and
    // drawdownGuard were never fed real trade outcomes ANYWHERE in the
    // codebase — their .recordOutcome()/.recordSymbolOutcome()/.record()
    // methods existed but had zero call sites. That meant: Bayesian's
    // symbol/regime/session models stayed at the cold 50/50 prior forever;
    // walk-forward's out-of-sample history could never accumulate (analyze()
    // always returned sufficient:false); the per-symbol consecutive-loss
    // circuit breaker in institutional-gates.js could never trip; and
    // drawdownGuard's real daily/weekly PnL and consecutive-loss tracking
    // never updated even though evaluate() now gates on it. Wired all four in.
    const isWin = (saved.pnlR || 0) > 0;
    try { liveEngines.bayesianEng?.recordOutcome({ signal, outcome, regime: signal?.regime, session: signal?.session }); } catch (_) {}
    try { liveEngines.walkForward?.recordOutcome({ signal, outcome }); } catch (_) {}
    try { liveEngines.institutionalGates?.recordSymbolOutcome(saved.symbol, isWin); } catch (_) {}
    try { liveEngines.sessionFilter?.recordOutcome({ symbol: saved.symbol, result: isWin ? 'WIN' : 'LOSS', pnlPct: saved.pnlPct, timestamp: saved.closedAt || Date.now() }); } catch (_) {}
    try {
      liveEngines.drawdownGuard?.record({
        pnlPct: Number(saved.pnlPct || 0),
        won: isWin,
        symbol: saved.symbol,
        signalId: saved.signalId,
        grade: signal?.score?.grade,
        pnlR: saved.pnlR,
      });
    } catch (_) {}

    bus.emit('telemetry_update', {
      type: 'outcome_recorded',
      symbol: saved.symbol,
      timeframe: saved.timeframe,
      payload: { result: saved.result, pnlR: saved.pnlR, patternKey: saved.patternKey },
      timestamp: Date.now(),
    });
    res.json({ ok: true, outcome: saved });
  });

  // ── EA (MetaTrader 5) API endpoints ──

  const EA_SECRET = process.env.EA_SECRET || '';
  function eaAuth(req, res, next) {
    const token = req.headers['x-ea-secret'] || req.query.secret;
    if (!EA_SECRET) return next(); // no secret configured = open access
    if (token === EA_SECRET) return next();
    return res.status(401).json({ ok: false, error: 'Invalid EA secret' });
  }

  app.get('/api/ea/signals', eaAuth, (_req, res) => {
    const dispatcher = getDispatcher();
    if (!dispatcher) return res.json({ ok: true, signals: [] });
    const approved = dispatcher.getApprovedSignals();
    const mapped = approved.map(sig => ({
      id: sig.id,
      symbol: sig.symbol,
      action: sig.action,
      timeframe: sig.timeframe,
      currentPrice: sig.currentPrice,
      entry: sig.entry,
      stopLoss: sig.stopLoss,
      targets: sig.targets,
      score: sig.score,
      riskPct: Number(process.env.RISK_PCT_PER_TRADE || 1),
      approvedAt: sig.approvedAt,
    }));
    res.json({ ok: true, signals: mapped });
  });

  app.post('/api/ea/executed', eaAuth, (req, res) => {
    const { signalId, lotSize, entryPrice, sl, tp, ticket } = req.body || {};
    if (!signalId) return res.status(400).json({ ok: false, error: 'signalId required' });
    const dispatcher = getDispatcher();
    if (!dispatcher) return res.status(503).json({ ok: false, error: 'Dispatcher not ready' });
    const marked = dispatcher.markSignalExecuted(signalId, { lotSize, entryPrice, sl, tp, ticket });
    if (!marked) return res.status(404).json({ ok: false, error: 'Signal not found or already executed' });
    res.json({ ok: true });
  });

  app.post('/api/ea/balance', eaAuth, (req, res) => {
    const { balance, equity, margin, freeMargin } = req.body || {};
    if (balance == null) return res.status(400).json({ ok: false, error: 'balance required' });
    const dispatcher = getDispatcher();
    if (dispatcher) {
      dispatcher.accountBalance = Number(balance);
    }
    // FIX: was only updating the dispatcher's (cosmetic, display-only) balance
    // copy — the actual RiskEngine used for live position-size math never saw
    // real-time balance updates. See the note on RiskEngine.setBalance().
    try { getEngines().riskEngine?.setBalance(balance); } catch (_) {}
    bus.emit('balance_update', { balance, equity, margin, freeMargin, updatedAt: Date.now() });
    res.json({ ok: true, balance });
  });

  app.get('/api/ea/config', eaAuth, (_req, res) => {
    res.json({
      ok: true,
      riskPct: Number(process.env.RISK_PCT_PER_TRADE || 1),
      maxDailyLoss: Number(process.env.MAX_DAILY_LOSS_PCT || 3),
      maxDrawdown: Number(process.env.MAX_DRAWDOWN_PCT || 10),
      symbols: (process.env.SYMBOLS || '').split(',').filter(Boolean),
      timeframes: (process.env.TIMEFRAMES || 'H1,H4').split(','),
    });
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
      const liveEngines = getEngines();
      const activeLearningEngine = liveEngines.adaptiveLearning || learningEngine;
      const outcome = await activeLearningEngine.recordOutcome({ signalId: payload.signalId, signal, outcome: payload.outcome }).catch(err => ({ error: err.message }));
      if (outcome.error) return socket.emit('outcome_error', outcome);
      // FIX: same missing wiring as /api/outcomes — see the detailed note there.
      const isWin = (outcome.pnlR || 0) > 0;
      try { liveEngines.bayesianEng?.recordOutcome({ signal, outcome: payload.outcome, regime: signal?.regime, session: signal?.session }); } catch (_) {}
      try { liveEngines.walkForward?.recordOutcome({ signal, outcome: payload.outcome }); } catch (_) {}
      try { liveEngines.institutionalGates?.recordSymbolOutcome(outcome.symbol, isWin); } catch (_) {}
      try { liveEngines.sessionFilter?.recordOutcome({ symbol: outcome.symbol, result: isWin ? 'WIN' : 'LOSS', pnlPct: outcome.pnlPct, timestamp: outcome.closedAt || Date.now() }); } catch (_) {}
      try {
        liveEngines.drawdownGuard?.record({
          pnlPct: Number(outcome.pnlPct || 0),
          won: isWin,
          symbol: outcome.symbol,
          signalId: payload.signalId,
          grade: signal?.score?.grade,
          pnlR: outcome.pnlR,
        });
      } catch (_) {}
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
