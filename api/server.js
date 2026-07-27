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
const { telegramAuthMiddleware, validateTelegramInitData, validateAppToken } = require('./telegram-auth');
const { FinnhubFeed } = require('../feeds/finnhub-feed');
const { AdaptiveLearningEngine } = require('../signal-pipeline/adaptive-learning-engine');
const { MarketOutlookBuilder } = require('../signal-pipeline/market-outlook');
const { recordOutcomeEverywhere } = require('../signal-pipeline/outcome-recorder');
const { MarketHeatMap } = require('../automation/market-heatmap');

const fs = require('fs');
const API_PORT = Number(process.env.PORT || process.env.WS_PORT || 3001);
// FIX: was 'webapp' (the vanilla-JS single-file frontend) — that file has
// been retired in favor of webapp-react (see its README: "A Bloomberg-
// terminal-style replacement for the vanilla-JS webapp/ frontend"). Points
// at the Vite build output; render.yaml's buildCommand runs `npm run build`
// inside webapp-react/ before this ever starts, so dist/ exists in
// production. Locally, run `npm run build --prefix webapp-react` once (or
// `npm run dev` inside webapp-react/ for hot-reload against this backend).
// No fallback to webapp/ — its index.html was removed in the same change
// that retired it, so falling back there would just serve a folder with no
// index.html (an ENOENT on every route) instead of a clear signal that the
// build step didn't run.
const STATIC_ROOT = path.join(__dirname, '..', 'webapp-react', 'dist');
if (!fs.existsSync(path.join(STATIC_ROOT, 'index.html'))) {
  console.warn(`[API] ${STATIC_ROOT} has no index.html — did the webapp-react build step run? (npm run build --prefix webapp-react)`);
}
const finnhub = new FinnhubFeed();
const learningEngine = new AdaptiveLearningEngine({ store: db });

// In-memory ring buffer of recent signals, fed by the live 'signal' bus
// event inside startServer() below. Module-level (not inside either
// createApp() or startServer()) because /api/signals lives in createApp()
// while the bus listener that populates this needs `io` from startServer()
// — see the FIX comment on that listener for why this cache exists at all.
const RECENT_SIGNALS_CACHE = [];
const RECENT_SIGNALS_CACHE_LIMIT = 200;

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
    // Same fix as /api/health above (MemoryManager.getFullStats() had zero
    // callers anywhere) — this endpoint is what the frontend's About panel
    // actually fetches, which that fix didn't reach since it only extended
    // /api/health. Same `cache` field name for consistency.
    let cache = null;
    try { cache = getEngines().memory?.getFullStats?.() || null; } catch (_) { /* engines not ready yet at boot */ }
    res.json({
      ok: true,
      service: 'omnicee-api',
      uptime: process.uptime(),
      mongo,
      finnhub: finnhub.enabled(),
      cache,
    });
  });

  app.post('/api/auth/telegram', async (req, res) => {
    const validation = validateTelegramInitData(req.body?.initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!validation.ok) return res.status(401).json({ ok: false, error: validation.reason });
    // FIX: was `catch (_) {}` — a DB hiccup here was invisible; you'd see the
    // user "authenticate" successfully while the upsert silently failed.
    try { await db.upsertTelegramUser(validation.user); } catch (err) { console.warn('[API] upsertTelegramUser failed (POST /api/auth/telegram):', err.message); }
    res.json({ ok: true, user: validation.user });
  });

  app.get('/api/signals', telegramAuthMiddleware, async (req, res) => {
    const symbol = req.query.symbol;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    let signals = await db.getRecentSignals({ symbol, limit }).catch(err => {
      console.warn('[API] getRecentSignals (Mongo) failed, falling back to in-memory cache:', err.message);
      return null;
    });
    let source = 'mongo';
    if (!signals || signals.length === 0) {
      signals = RECENT_SIGNALS_CACHE.filter(s => !symbol || s.symbol === symbol).slice(0, limit);
      source = 'memory';
    }
    res.json({ ok: true, signals, source });
  });

  app.get('/api/outlook', telegramAuthMiddleware, async (req, res) => {
    const live = getEngines();
    if (!live.regimeEngine || !live.candleStores) {
      return res.status(503).json({ ok: false, error: 'Outlook unavailable — trading engine not yet initialized' });
    }
    let outlook;
    try {
      outlook = MarketOutlookBuilder.build({
        symbols: live.symbols || [],
        candleStores: live.candleStores,
        regimeEngine: live.regimeEngine,
        sessionFilter: live.sessionFilter,
        cotParser: live.cotParser,
        timeframe: 'H1',
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    // Recent market news headlines (real, from Finnhub) — the user-facing
    // "accurate news" component of the outlook.
    let news = [];
    if (finnhub.enabled()) {
      news = await finnhub.marketNews('general').catch(() => []);
      news = Array.isArray(news) ? news.slice(0, 8).map(n => ({
        headline: n.headline, source: n.source, url: n.url, datetime: n.datetime * 1000,
      })) : [];
    }
    res.json({ ok: true, outlook: { ...outlook, news } });
  });

  // ── Watchlist / Opportunity Ranking (doc items: Market Scanner, Watchlist
  // AI, Opportunity Ranking, Relative Strength Engine) ────────────────────
  // ── Trading Journal / Setup Analytics (doc items: AI Trading Journal,
  // Setup Analytics — 'which of my strategies is actually making money')
  // ─────────────────────────────────────────────────────────────────────
  app.get('/api/journal', telegramAuthMiddleware, async (req, res) => {
    const live = getEngines();
    if (!live.executionEngine) {
      return res.status(503).json({ ok: false, error: 'Journal unavailable — execution engine not yet initialized' });
    }
    const filter = {};
    if (req.query.symbol)    filter.symbol    = req.query.symbol;
    if (req.query.direction) filter.direction = req.query.direction;
    if (req.query.grade)     filter.grade     = req.query.grade;
    if (req.query.session)   filter.session   = req.query.session;
    if (req.query.setup)     filter.setup     = req.query.setup;
    if (req.query.since)     filter.since     = Number(req.query.since);

    const stats = live.executionEngine.getJournalStats(filter);
    res.json({ ok: true, stats });
  });

  app.get('/api/watchlist', telegramAuthMiddleware, async (req, res) => {
    const live = getEngines();
    if (!live.opportunityRanker) {
      return res.status(503).json({ ok: false, error: 'Watchlist unavailable — trading engine not yet initialized' });
    }
    const opportunities = live.opportunityRanker.getRanked({
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });

    let relativeStrength = { leaders: [], laggards: [], all: [] };
    if (live.relativeStrength && live.candleStores && live.symbols) {
      try {
        relativeStrength = live.relativeStrength.leadersAndLaggards(
          live.candleStores, live.symbols, req.query.timeframe || 'H1', 3,
        );
      } catch (err) {
        console.warn(`[API] RelativeStrength ranking error: ${err.message}`);
      }
    }

    res.json({ ok: true, opportunities, relativeStrength });
  });

  // ── Market Heat Map (doc item #56) ──────────────────────────────────
  // Composites the same OpportunityRanker + RelativeStrengthEngine data
  // above into per-symbol heat buckets for a grid-style dashboard view.
  app.get('/api/heatmap', telegramAuthMiddleware, async (req, res) => {
    const live = getEngines();
    if (!live.opportunityRanker) {
      return res.status(503).json({ ok: false, error: 'Heat map unavailable — trading engine not yet initialized' });
    }
    try {
      const heatmap = new MarketHeatMap();
      const grid = heatmap.build({
        opportunityRanker: live.opportunityRanker,
        relativeStrength: live.relativeStrength,
        candleStores: live.candleStores,
        symbols: live.symbols,
        timeframe: req.query.timeframe || 'H1',
      });
      res.json({ ok: true, ...grid });
    } catch (err) {
      console.warn(`[API] MarketHeatMap build error: ${err.message}`);
      res.status(500).json({ ok: false, error: 'Heat map build failed' });
    }
  });

  // ── Audit Trail (extracted from orphaned task-planner.js) ───────────
  // Every analysis cycle result, fired or not — "what did the pipeline
  // decide about symbol X in the last hour" without grepping logs.
  app.get('/api/audit-trail', telegramAuthMiddleware, async (req, res) => {
    const live = getEngines();
    if (!live.auditTrail) {
      return res.status(503).json({ ok: false, error: 'Audit trail unavailable — trading engine not yet initialized' });
    }
    const entries = req.query.symbol
      ? live.auditTrail.getBySymbol(req.query.symbol, req.query.limit ? Number(req.query.limit) : 10)
      : live.auditTrail.getRecent(req.query.limit ? Number(req.query.limit) : 20);
    res.json({ ok: true, entries, total: live.auditTrail.size() });
  });

  // ── Data Integrity / Feed Health (doc item: Connection & Data Integrity
  // Monitor) ────────────────────────────────────────────────────────────
  app.get('/api/health', telegramAuthMiddleware, async (req, res) => {
    const live = getEngines();
    if (!live.dataIntegrityMonitor || !live.candleStores) {
      return res.status(503).json({ ok: false, error: 'Health monitor unavailable — trading engine not yet initialized' });
    }
    const report = live.dataIntegrityMonitor.check(live.candleStores);
    // FIX: MemoryManager's RedisAdapter/PineconeAdapter already tracked an
    // internal error counter on every failed cache write, but nothing
    // anywhere ever read it — a failing Redis/Pinecone connection was
    // completely invisible (every write silently .catch(() => {})'d).
    // getFullStats() was itself dead code with zero callers until now.
    const cache = live.memory?.getFullStats?.() || null;
    res.json({ ok: true, ...report, cache });
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
    // FIX: dispatcher.accountBalance is set from real MT5 EA reports
    // (/api/ea/balance) but was never exposed anywhere for initial-load —
    // only the balance_update live-socket relay (just added above) covers
    // it, which means a fresh page load showed nothing until the next EA
    // report arrived. Frontend has no display for it yet either — see the
    // matching webapp/index.html fix.
    const dispatcher = getDispatcher();
    const accountBalance = dispatcher?.accountBalance ?? null;
    res.json({ ok: true, stats, accountBalance });
  });

  // ── Equity Curve (doc gap: webapp-react/README.md's "Known gaps" note —
  // "no dedicated equity-history endpoint ... only point-in-time
  // /api/stats. Worth adding a db.getEquityCurve() + route"). Realized-only
  // (compounds each closed trade_outcomes.pnlPct onto a starting balance),
  // not a tick-by-tick feed — see the comment on db.getEquityCurve().
  app.get('/api/equity-curve', telegramAuthMiddleware, async (req, res) => {
    const dispatcher = getDispatcher();
    const startBalance = dispatcher?.accountBalance || Number(process.env.ACCOUNT_BALANCE) || 10000;
    const curve = await db.getEquityCurve({
      startBalance,
      limit: req.query.limit ? Number(req.query.limit) : 500,
    }).catch(err => {
      res.status(503).json({ ok: false, error: err.message });
      return null;
    });
    if (curve) res.json({ ok: true, curve, startBalance });
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
    // FIX: learningEngine (AdaptiveLearningEngine) was instantiated at the
    // top of this file but never called anywhere in the API layer — its
    // Q-table size, blacklist size, and cache state were invisible outside
    // a log line. Cheap to expose alongside the per-pattern profiles.
    if (profiles) res.json({ ok: true, profiles, engine: learningEngine.getStats() });
  });

  app.post('/api/outcomes', telegramAuthMiddleware, async (req, res) => {
    const { signalId, outcome } = req.body || {};
    if (!signalId || !outcome) return res.status(400).json({ ok: false, error: 'signalId and outcome are required' });

    const [signal] = await db.getRecentSignals({ limit: 200 }).then(list => list.filter(s => s.id === signalId)).catch(() => []);

    const result = await recordOutcomeEverywhere({
      signalId, signal, outcome, mongoStore: db,
      engines: getEngines(), fallbackLearningEngine: learningEngine,
    });
    if (!result.ok) return res.status(result.status || 500).json({ ok: false, error: result.error, outcome: result.outcome });

    const saved = result.saved;
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
  // FIX: EA_SECRET was undocumented in .env.example and, when unset, silently
  // left /api/ea/signals — the endpoint that hands out live trading signals
  // to the MT5 EA — open to anyone who finds the URL, with no warning logged
  // anywhere. Same "warn at startup" pattern index.js already uses for
  // TELEGRAM_BOT_TOKEN etc., so this doesn't fail as quietly.
  if (!EA_SECRET) {
    console.warn('[API] EA_SECRET not set — /api/ea/signals is open access (no auth required)');
  }
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
      // FIX: was a static env-var value regardless of the signal — ignored
      // RiskEngine's own correlation/session adjustment (effectiveRisk) and
      // the session-quality/drawdown-guard sizing factor computed in
      // index.js (finalRiskPct), so every server-side risk-reduction
      // safeguard had zero effect on what the automated MT5 EA actually
      // risked per trade. Falls back to the env var only if a signal
      // predates this fix or riskEvaluation is unavailable.
      riskPct: Number(
        sig.riskEvaluation?.finalRiskPct ??
        sig.riskEvaluation?.effectiveRisk ??
        process.env.RISK_PCT_PER_TRADE ?? 1
      ),
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
    try {
      getEngines().riskEngine?.setBalance(balance);
    } catch (err) {
      console.warn(`[API] Failed to update RiskEngine balance to ${balance} — position sizing may be using a stale balance: ${err.message}`);
    }
    bus.emit('balance_update', { balance, equity, margin, freeMargin, updatedAt: Date.now() });
    res.json({ ok: true, balance });
  });

  // FIX: crypto has a genuinely real-time price ticker (Binance WS) but
  // forex only had TwelveData's rate-limited polling (8/min free tier) plus
  // whatever Finnhub's WS stream adds (see finnhub-feed.js's
  // connectPriceStream — a second independent source, added this session).
  // The MT5 EA (mt5/OmniceeEA.mq5) already sits on James's own broker's
  // live tick feed for free, for signal execution and balance sync — this
  // is a third independent source, using data he already has, feeding the
  // identical market_update event both of the above use. Same eaAuth as
  // every other /api/ea/* route; same {bid, ask} shape the EA already reads
  // via SymbolInfoDouble() for its own position-sizing math.
  app.post('/api/ea/prices', eaAuth, (req, res) => {
    const { prices } = req.body || {};
    if (!Array.isArray(prices) || !prices.length) {
      return res.status(400).json({ ok: false, error: 'prices array required' });
    }
    const onLivePrice = getEngines().onLivePrice;
    let accepted = 0;
    for (const p of prices) {
      if (!p?.symbol || p.bid == null) continue;
      const mid = p.ask != null ? (Number(p.bid) + Number(p.ask)) / 2 : Number(p.bid);
      if (!Number.isFinite(mid)) continue;
      if (onLivePrice) {
        onLivePrice(p.symbol, mid, { source: 'mt5_ea' });
      } else {
        // Trading engine not booted yet (e.g. Mongo/feed init still in
        // progress) — degrade to a direct emit so the ticker still moves;
        // executionEngine.onPrice() just isn't reachable yet either way.
        bus.emit('market_update', { symbol: p.symbol, price: mid, change: null, bias: null, source: 'mt5_ea' });
      }
      accepted++;
    }
    res.json({ ok: true, accepted });
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
    // Same app-token-first, fall-through-to-Telegram pattern as
    // telegramAuthMiddleware in api/telegram-auth.js — kept in sync so a
    // browser session logged in with the app token doesn't lose live
    // updates just because it's not inside Telegram.
    const appToken = socket.handshake.auth?.appToken || socket.handshake.query?.appToken;
    if (appToken) {
      const appValidation = validateAppToken(appToken);
      if (appValidation.ok) {
        socket.telegramUser = appValidation.user;
        socket.authMethod = 'app-token';
        return next();
      }
    }

    const initData = socket.handshake.auth?.initData || socket.handshake.query?.initData;
    if (!initData && !appToken && process.env.NODE_ENV !== 'production') return next();
    const validation = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!validation.ok) return next(new Error(validation.reason));
    socket.telegramUser = validation.user;
    socket.authMethod = 'telegram';
    // FIX: same silent-swallow pattern as the REST /api/auth/telegram route
    // above — a DB failure here was invisible. Doesn't block the connection
    // (auth already succeeded, this is just bookkeeping) but now at least logs.
    try { await db.upsertTelegramUser(validation.user); } catch (err) { console.warn('[API] upsertTelegramUser failed (socket auth):', err.message); }
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

      const result = await recordOutcomeEverywhere({
        signalId: payload?.signalId, signal, outcome: payload?.outcome, mongoStore: db,
        engines: getEngines(), fallbackLearningEngine: learningEngine,
      });
      if (!result.ok) return socket.emit('outcome_error', { error: result.error, outcome: result.outcome });

      const saved = result.saved;
      socket.emit('outcome_saved', saved);
      bus.emit('telemetry_update', {
        type: 'outcome_recorded',
        symbol: saved.symbol,
        timeframe: saved.timeframe,
        payload: { result: saved.result, pnlR: saved.pnlR, patternKey: saved.patternKey },
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

  // FIX: GET /api/signals — the route the dashboard's Signals tab, Dashboard
  // cards, and Tape all actually poll — only ever read from Mongo, with no
  // fallback. The live agent pipeline emits a real 'signal' event on this
  // bus every time it fires, regardless of Mongo's connection status
  // (MONGODB_URI is still an unverified/possibly-disconnected piece of
  // infra), and that event already reached Socket.IO clients in real time —
  // but the REST route the frontend depends on for its initial load and its
  // 5s poll returned an empty array forever whenever Mongo wasn't reachable,
  // even while the pipeline was generating real signals correctly. This
  // buffer is memory-only (lost on restart; fine, since there's only one
  // live pipeline and Mongo is the durable copy when it's up) and always
  // available — /api/signals below prefers Mongo (it has cross-restart
  // history) but falls back to this whenever Mongo has nothing.
  //
  // Also compacts to the same shape db.saveSignal() persists (via
  // db.compactSignal) BEFORE emitting to socket clients or caching —
  // previously the socket 'signal' event sent the raw pipeline object
  // (dozens of internal-only fields: intermarketCheck, entryOptimization,
  // compressionContext, executionPlan, aiAdvisor reasoning, management,
  // ensemble, etc.), which didn't match what Mongo-backed /api/signals
  // returns. A client consuming both transports would have seen two
  // different shapes for the same signal depending on whether it arrived
  // by poll or by push.
  bus.on('signal', payload => {
    const compact = db.compactSignal(payload);
    io.emit('signal', compact);
    RECENT_SIGNALS_CACHE.unshift(compact);
    if (RECENT_SIGNALS_CACHE.length > RECENT_SIGNALS_CACHE_LIMIT) RECENT_SIGNALS_CACHE.length = RECENT_SIGNALS_CACHE_LIMIT;
    db.saveSignal(payload).catch(err => console.warn('[API] persist signal:', err.message));
  });
  forward('market_update', 'market', db.saveMarketSnapshot);
  forward('risk_update', 'risk');
  forward('stats_update', 'stats');
  forward('regime_update', 'regime', payload => db.saveTelemetry({ type: 'regime_update', ...payload }));
  forward('telemetry_update', 'telemetry', db.saveTelemetry);
  // FIX: myfxbook/openinsider events previously only reached Telegram —
  // now relayed to the live dashboard as well (see index.js wsBus.emit('intel', ...)).
  forward('intel', 'intel', payload => db.saveTelemetry({ type: 'intel_' + payload.kind, ...payload }));
  // Opportunity Ranker scoreboard — pushed every cycle so the Mini App's
  // watchlist view updates live instead of only on poll of /api/watchlist.
  forward('watchlist_update', 'watchlist');
  // Data Integrity Monitor — feed/staleness health, so the dashboard shows a
  // warning banner instead of the trader only finding out a feed died when
  // signals quietly stop arriving.
  forward('feed_health', 'feed_health');
  // Abnormal Market Detector — flash-crash wicks, frozen feeds, liquidity
  // vacuums. Pushed live so the dashboard can show a banner the moment a
  // symbol gets flagged, not just when it shows up in server logs.
  forward('abnormal_market', 'abnormal_market', payload => db.saveTelemetry({ type: 'abnormal_market', ...payload }));
  // FIX: BybitFeed emits liquidation_cascade (real risk event — large forced
  // liquidations in a short window) and index.js relays it onto wsBus, but
  // it was never added to this forward() whitelist — it reached nowhere
  // past a server-side log.warn(). A liquidation cascade is exactly the
  // kind of event a trader wants to see live, not discover after the fact.
  forward('liquidation_cascade', 'liquidation_cascade', payload => db.saveTelemetry({ type: 'liquidation_cascade', ...payload }));
  // FIX: balance_update was emitted (real data — /api/ea/balance receives the
  // MT5 EA's actual account balance/equity/margin) but had no forward()
  // entry, so it silently never reached any connected browser. The frontend
  // has no display for it either yet (see webapp/index.html's matching fix).
  forward('balance_update', 'balance');

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
