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
const { createEmailAuthRouter, emailSessionMiddleware, requireEmailAuth, ensureAuthIndexes } = require('./email-auth');
const { FinnhubFeed } = require('../feeds/finnhub-feed');
const { YahooNewsFeed } = require('../feeds/yahoo-news-feed');
const { ForexFactoryCalendar } = require('../feeds/forex-factory-calendar');
const { FearGreedFeed } = require('../feeds/fear-greed-feed');
const { CoinGeckoFeed } = require('../feeds/coingecko-feed');
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
const yahooNews = new YahooNewsFeed();
const ffCalendar = new ForexFactoryCalendar();
const fearGreed = new FearGreedFeed();
const coinGecko = new CoinGeckoFeed();
const learningEngine = new AdaptiveLearningEngine({ store: db });

// In-memory ring buffer of recent signals, fed by the live 'signal' bus
// event inside startServer() below. Module-level (not inside either
// createApp() or startServer()) because /api/signals lives in createApp()
// while the bus listener that populates this needs `io` from startServer()
// — see the FIX comment on that listener for why this cache exists at all.
const RECENT_SIGNALS_CACHE = [];
const RECENT_SIGNALS_CACHE_LIMIT = 200;
const MARKET_SNAPSHOT_CACHE = new Map();

let serverState = null;

function dashboardReadAuth(req, res, next) {
  // Email session (OTP login) — preferred when present
  if (req.emailSession?.email) {
    req.authMethod = 'email';
    req.telegramUser = { id: req.emailSession.email, username: req.emailSession.email };
    return next();
  }
  // When EMAIL_AUTH_REQUIRED is on, block public read (friends must log in)
  if (process.env.EMAIL_AUTH_REQUIRED === 'true') {
    return res.status(401).json({ ok: false, error: 'Login required', code: 'AUTH_REQUIRED' });
  }
  if (req.method === 'GET' && process.env.PUBLIC_DASHBOARD_READ !== 'false') {
    req.telegramUser = { id: 'public-dashboard', username: 'public-dashboard' };
    req.authMethod = 'public-dashboard-read';
    return next();
  }
  return telegramAuthMiddleware(req, res, next);
}

function latestMarketRows(symbols = []) {
  const wanted = new Set(symbols);
  const rowsBySymbol = new Map(MARKET_SNAPSHOT_CACHE);
  const live = getEngines();

  // Prefer live broker (Exness/MT5) ticks when EA is connected
  const livePrices = live?.lastPriceBySymbol || {};
  for (const [symbol, tick] of Object.entries(livePrices)) {
    if (wanted.size && !wanted.has(symbol)) continue;
    if (!tick || !Number.isFinite(tick.price)) continue;
    rowsBySymbol.set(symbol, {
      symbol,
      price: tick.price,
      bid: tick.bid ?? null,
      ask: tick.ask ?? null,
      change: null,
      bias: null,
      source: tick.source || 'unknown',
      timestamp: tick.ts || Date.now(),
    });
  }

  if (live?.candleStores) {
    const sourceSymbols = wanted.size ? [...wanted] : (live.symbols || Object.keys(live.candleStores));
    for (const symbol of sourceSymbols) {
      if (rowsBySymbol.has(symbol)) continue;
      const byTf = live.candleStores[symbol];
      if (!byTf) continue;
      const preferredTf = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'].find(tf => byTf[tf]?.length);
      const candles = preferredTf ? byTf[preferredTf] : null;
      const last = candles?.[candles.length - 1];
      if (!last?.close) continue;
      rowsBySymbol.set(symbol, {
        symbol,
        price: Number(last.close),
        change: last.open ? ((Number(last.close) - Number(last.open)) / Number(last.open)) * 100 : null,
        bias: null,
        source: last.source || `candle:${preferredTf}`,
        timestamp: last.timestamp || Date.now(),
      });
    }
  }

  return [...rowsBySymbol.values()]
    .filter(row => wanted.size === 0 || wanted.has(row.symbol))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

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
  app.use(emailSessionMiddleware(db));
  // FIX: publicLimiter below deliberately skips everything under
  // /api/auth/ (see its `skip` function) — that's correct, a dashboard-read
  // budget is the wrong shape for login endpoints — but nothing ever
  // supplied a REPLACEMENT limit for that path. Net effect: /api/auth/
  // email/request and /verify had ZERO IP-based rate limiting; the only
  // defense was email-auth.js's own 30-second-per-email cooldown, which
  // does nothing against someone cycling through many different target
  // emails from one IP (mail-bombing a victim's inbox with OTP codes,
  // one email each) or scripting many parallel /verify guesses. This is
  // deliberately tighter than publicLimiter and scoped only to auth.
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.AUTH_RATE_LIMIT_PER_MIN || 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many auth requests — wait a minute and try again' },
  });
  app.use('/api/auth/email', authLimiter, createEmailAuthRouter(express, db));
  ensureAuthIndexes(db).catch(err => console.warn('[AUTH] indexes:', err.message));
  // Global limit for dashboard/public API. EA price ticks are 1/sec and must
  // not share this budget or broker prices never land and Yahoo wins.
  const publicLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.API_RATE_LIMIT_PER_MIN || 120),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      const p = req.path || '';
      return p.startsWith('/api/ea/') || p.startsWith('/api/webhooks/') || p.startsWith('/api/auth/');
    },
  });
  app.use(publicLimiter);
  // Separate generous cap for EA only (prices every 1s ≈ 60/min + poll/balance)
  const eaLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.EA_RATE_LIMIT_PER_MIN || 300),
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/ea', eaLimiter);

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

  app.get('/api/signals', dashboardReadAuth, async (req, res) => {
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

  app.get('/api/market', dashboardReadAuth, async (req, res) => {
    const requested = String(req.query.symbols || '')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    const rows = latestMarketRows(requested);
    res.json({ ok: true, market: rows, source: 'memory' });
  });

  // Historical + live-forming OHLC candles for the chart. Reads directly
  // from the same candleStores object the live agents run technical
  // analysis on (published via api/realtime.js's setEngines(), same
  // pattern /api/outlook already uses below) rather than maintaining a
  // separate history buffer, so the chart never shows something the
  // signal pipeline itself didn't actually see. candleStores[symbol][tf]
  // already includes the still-forming (unclosed) current bar — both
  // onMT5Tick() and the exchange WS feeds update it on every tick before
  // it closes — so this endpoint alone is enough for an initial paint;
  // the frontend then keeps that last bar live between polls using the
  // same 'market' tick stream it already consumes for the ticker.
  app.get('/api/candles', dashboardReadAuth, async (req, res) => {
    const live = getEngines();
    if (!live.candleStores) {
      return res.status(503).json({ ok: false, error: 'Candle store not yet initialized' });
    }
    const symbol = String(req.query.symbol || '').toUpperCase().trim();
    const timeframe = String(req.query.timeframe || 'H1').toUpperCase().trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 10), 500);
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
    const candles = live.candleStores[symbol]?.[timeframe];
    if (!candles || !candles.length) {
      return res.json({ ok: true, symbol, timeframe, candles: [], note: 'No candle history yet for this symbol/timeframe — attach MT5 EA or wait for TwelveData/Binance to populate it.' });
    }
    // timestamp is stored in ms (see feeds/binance-ws.js, onMT5Tick) —
    // convert to whole seconds here, once, server-side, since every
    // consumer (lightweight-charts) wants UNIX seconds, not ms.
    const out = candles.slice(-limit).map(c => ({
      time: Math.floor(c.timestamp / 1000),
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume || 0,
    }));
    res.json({ ok: true, symbol, timeframe, candles: out });
  });

  app.get('/api/outlook', dashboardReadAuth, async (req, res) => {
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
        headline: n.headline, source: n.source, url: n.url,
        image: n.image || n.imageUrl || null,
        datetime: (n.datetime ? n.datetime * 1000 : Date.now()),
      })) : [];
    }
    res.json({ ok: true, outlook: { ...outlook, news } });
  });


  // Live economic calendar (Forex Factory — no key). Frontend was only
  // seeing Tier-1 from outlook; this exposes the full week for Intel/Home.
  app.get('/api/calendar', dashboardReadAuth, async (_req, res) => {
    try {
      const events = await ffCalendar.economicCalendar();
      const now = Date.now();
      const upcoming = (events || [])
        .filter(e => Number.isFinite(e.time) && e.time >= now - 3600000)
        .sort((a, b) => a.time - b.time)
        .slice(0, 80)
        .map(e => ({
          name: e.name,
          currency: e.currency,
          time: e.time,
          impact: e.impact,
          forecast: e.forecast,
          previous: e.previous,
          source: e.source || 'forex-factory',
          hoursAway: Math.round((e.time - now) / 3600000 * 10) / 10,
        }));
      res.json({ ok: true, events: upcoming, count: upcoming.length });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message, events: [] });
    }
  });

  // Simple support / resistance from live H1 candles (swing highs/lows)
  app.get('/api/levels', dashboardReadAuth, (req, res) => {
    const live = getEngines();
    const symbols = live.symbols || [];
    const stores = live.candleStores || {};
    const out = {};
    for (const symbol of symbols) {
      const candles = stores[symbol]?.H1 || stores[symbol]?.H4 || [];
      if (!candles || candles.length < 20) {
        out[symbol] = { support: null, resistance: null, note: 'need more candles' };
        continue;
      }
      const slice = candles.slice(-48);
      const highs = slice.map(c => c.high).filter(Number.isFinite);
      const lows = slice.map(c => c.low).filter(Number.isFinite);
      const closes = slice.map(c => c.close).filter(Number.isFinite);
      if (!highs.length || !lows.length) {
        out[symbol] = { support: null, resistance: null, note: 'bad candles' };
        continue;
      }
      const resistance = Math.max(...highs);
      const support = Math.min(...lows);
      const mid = closes[closes.length - 1];
      out[symbol] = {
        support: Math.round(support * 1e5) / 1e5,
        resistance: Math.round(resistance * 1e5) / 1e5,
        last: mid,
        range: Math.round((resistance - support) * 1e5) / 1e5,
        note: 'H1 swing 48 bars',
      };
    }
    res.json({ ok: true, levels: out });
  });

  // ── Watchlist / Opportunity Ranking (doc items: Market Scanner, Watchlist
  // AI, Opportunity Ranking, Relative Strength Engine) ────────────────────
  // ── Trading Journal / Setup Analytics (doc items: AI Trading Journal,
  // Setup Analytics — 'which of my strategies is actually making money')
  // ─────────────────────────────────────────────────────────────────────
  app.get('/api/journal', dashboardReadAuth, async (req, res) => {
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

  app.get('/api/watchlist', dashboardReadAuth, async (req, res) => {
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
  app.get('/api/heatmap', dashboardReadAuth, async (req, res) => {
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
  app.get('/api/audit-trail', dashboardReadAuth, async (req, res) => {
    const live = getEngines();
    if (!live.auditTrail) {
      return res.status(503).json({ ok: false, error: 'Audit trail unavailable — trading engine not yet initialized' });
    }
    const raw = req.query.symbol
      ? live.auditTrail.getBySymbol(req.query.symbol, req.query.limit ? Number(req.query.limit) : 10)
      : live.auditTrail.getRecent(req.query.limit ? Number(req.query.limit) : 20);
    const entries = (raw || []).map((e, i) => ({
      id: e.id || `${e.symbol}-${e.recordedAt || i}`,
      symbol: e.symbol,
      timeframe: e.timeframe,
      timestamp: e.recordedAt || e.timestamp || Date.now(),
      fired: !!(e.signalFired || e.fired),
      signalFired: !!(e.signalFired || e.fired),
      action: e.action,
      score: e.score,
      nearMiss: !!e.nearMiss,
      gatesPassed: Array.isArray(e.gatesPassed) ? e.gatesPassed : [],
      gatesFailed: Array.isArray(e.gatesFailed) ? e.gatesFailed : [],
      reasons: Array.isArray(e.reasons) ? e.reasons
        : e.blockedReason ? [e.blockedReason]
        : e.action ? [`${e.action}${e.score != null ? ` score ${e.score}` : ''}`]
        : ['checked'],
    }));
    const nearMisses = entries.filter(e => e.nearMiss || (!e.fired && Number(e.score) >= 50)).slice(0, 15);
    res.json({ ok: true, entries, nearMisses, total: live.auditTrail.size() });
  });

  // ── Data Integrity / Feed Health (doc item: Connection & Data Integrity
  // Monitor) ────────────────────────────────────────────────────────────
  app.get('/api/health', dashboardReadAuth, async (req, res) => {
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

  app.get('/api/telemetry', dashboardReadAuth, async (req, res) => {
    const telemetry = await db.getTelemetry({ limit: req.query.limit || 100 }).catch(err => {
      res.status(503).json({ ok: false, error: err.message });
      return null;
    });
    if (telemetry) res.json({ ok: true, telemetry });
  });

  app.get('/api/stats', dashboardReadAuth, async (_req, res) => {
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
  app.get('/api/equity-curve', dashboardReadAuth, async (req, res) => {
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

  app.get('/api/news', dashboardReadAuth, async (req, res) => {
    const symbol = req.query.symbol;
    const normalize = (n, fallbackSource = 'Unknown') => ({
      headline: n.headline || n.title || '',
      summary: n.summary || n.description || '',
      source: n.source || fallbackSource,
      url: n.url || n.link || null,
      image: n.image || n.imageUrl || n.thumbnail || null,
      datetime: n.datetime
        ? (n.datetime < 1e12 ? n.datetime * 1000 : n.datetime)
        : (n.datetime || Date.now()),
      category: n.category || req.query.category || 'general',
      symbol: n.symbol || n.related || symbol || null,
    });

    let news = [];
    // Yahoo Finance news first (free, no key, images)
    try {
      const y = await yahooNews.getNews({ limit: 40 });
      if (Array.isArray(y)) news.push(...y.map(n => normalize(n, 'Yahoo Finance')));
    } catch (err) {
      console.warn('[API] Yahoo news failed:', err.message);
    }

    // Finnhub when key works (extra coverage)
    try {
      let fh = symbol
        ? await finnhub.companyNews(symbol)
        : await finnhub.marketNews(req.query.category || 'general');
      // Extra forex-focused pull when no symbol filter
      if (!symbol && finnhub.enabled()) {
        try {
          const extra = await finnhub.marketNews('forex');
          if (Array.isArray(extra)) fh = [...(Array.isArray(fh) ? fh : []), ...extra];
        } catch (_) {}
      }
      if (Array.isArray(fh)) {
        news.push(...fh.map(n => normalize({
          headline: n.headline || n.title,
          summary: n.summary,
          source: n.source || 'Finnhub',
          url: n.url,
          image: n.image,
          datetime: n.datetime,
          category: n.category,
          symbol: n.related || symbol,
        }, 'Finnhub')));
      }
    } catch (err) {
      console.warn('[API] Finnhub news failed:', err.message);
    }

    // De-dupe by headline prefix
    const seen = new Set();
    news = news.filter(n => {
      const k = String(n.headline || '').toLowerCase().slice(0, 60);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => (b.datetime || 0) - (a.datetime || 0)).slice(0, 40);

    res.json({ ok: true, news, sources: ['yahoo', finnhub.enabled() ? 'finnhub' : null].filter(Boolean) });
  });

  // Crypto mood + simple market snapshot (free)
  app.get('/api/sentiment', dashboardReadAuth, async (_req, res) => {
    const out = { ok: true, fearGreed: null, crypto: null };
    try { out.fearGreed = await fearGreed.getLatest(); } catch (e) { out.fearGreedError = e.message; }
    try { out.crypto = await coinGecko.getSnapshot(); } catch (e) { out.cryptoError = e.message; }
    res.json(out);
  });

  app.get('/api/learning', dashboardReadAuth, async (req, res) => {
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
  // FIX: this used to compute a flattened mid-price and hand it straight to
  // onLivePrice() — the ticker/position-monitoring layer only. That threw
  // away bid/ask (this file never even read p.ask except to average it) and
  // meant MT5's broker ticks — James's own live forex feed, more real-time
  // than any REST/WS API on a free tier — never actually built OHLC candles
  // for the agents to analyze; see onMT5Tick()'s own comment in index.js.
  // Now passes bid/ask through and prefers onMT5Tick (candles + ticker +
  // position monitoring, all three); falls back to onLivePrice (ticker +
  // position monitoring only) if the candle aggregator isn't published yet,
  // and to a bare emit if the engine hasn't booted at all — same tiered
  // degradation as before, just one more rung.
  app.post('/api/ea/prices', eaAuth, (req, res) => {
    const { prices } = req.body || {};
    if (!Array.isArray(prices) || !prices.length) {
      return res.status(400).json({ ok: false, error: 'prices array required' });
    }
    const engines = getEngines();
    let accepted = 0;
    for (const p of prices) {
      if (!p?.symbol || p.bid == null) continue;
      const bid = Number(p.bid);
      const ask = p.ask != null ? Number(p.ask) : null;
      const mid = ask != null ? (bid + ask) / 2 : bid;
      if (!Number.isFinite(mid)) continue;
      if (engines.onMT5Tick) {
        engines.onMT5Tick(p.symbol, mid, { bid, ask, timestamp: p.timestamp });
      } else if (engines.onLivePrice) {
        engines.onLivePrice(p.symbol, mid, { source: 'mt5_ea', bid, ask });
      } else {
        bus.emit('market_update', { symbol: p.symbol, price: mid, bid, ask, change: null, bias: null, source: 'mt5_ea' });
      }
      accepted++;
    }
    if (accepted > 0) {
      const now = Date.now();
      if (!global.__lastEaPriceLog || now - global.__lastEaPriceLog > 15000) {
        global.__lastEaPriceLog = now;
        const sample = prices.find(x => x && x.symbol === 'XAUUSD') || prices[0];
        console.log(`[EA prices] accepted=${accepted} sample=${sample?.symbol} bid=${sample?.bid} ask=${sample?.ask}`);
      }
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

  // ── TradingView webhook (alerts → signals / optional price ticks) ───────
  // Configure a TradingView alert Webhook URL to:
  //   POST https://omnicee.onrender.com/api/webhooks/tradingview?secret=YOUR_SECRET
  // Message body (JSON):
  //   {"symbol":"{{ticker}}","price":{{close}},"action":"{{strategy.order.action}}",
  //    "interval":"{{interval}}","strategy":"{{strategy.order.id}}"}
  // Or simpler price-only: {"symbol":"EURUSD","price":1.085,"source":"tradingview"}
  // SIGNAL_ONLY by default: creates a signal event for the dashboard/Telegram,
  // does NOT place broker orders (ExecutionEngine stays MANUAL).
  const TV_WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || process.env.EA_SECRET || '';
  function tvAuth(req, res, next) {
    if (!TV_WEBHOOK_SECRET) return next();
    const token = req.headers['x-webhook-secret'] || req.query.secret || req.body?.secret;
    if (token === TV_WEBHOOK_SECRET) return next();
    return res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
  }

  app.post('/api/webhooks/tradingview', tvAuth, (req, res) => {
    let body = req.body;
    // TradingView sometimes sends raw text — try to parse
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = { raw: body }; }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'JSON body required' });
    }

    // Normalize symbol (EURUSD, EURUSD=X, FX:EURUSD, BINANCE:BTCUSDT → clean)
    let symbol = String(body.symbol || body.ticker || body.pair || '')
      .toUpperCase()
      .replace(/^(FX:|FOREX:|OANDA:|TVC:|BINANCE:|BYBIT:|COINBASE:)/, '')
      .replace(/=X$/, '')
      .replace(/[^A-Z0-9]/g, '');
    if (symbol === 'XAUUSD' || symbol === 'GOLD') symbol = 'XAUUSD';
    if (symbol === 'BTCUSD' || symbol === 'BTCUSDT') symbol = symbol.includes('USDT') ? 'BTCUSDT' : 'BTCUSDT';
    if (symbol === 'ETHUSD' || symbol === 'ETHUSDT') symbol = 'ETHUSDT';

    const price = Number(body.price ?? body.close ?? body.bid);
    const actionRaw = String(body.action || body.side || body.order || body.strategy_action || 'WAIT').toUpperCase();
    let action = 'WAIT';
    if (['BUY', 'LONG', 'B'].includes(actionRaw)) action = 'LONG';
    if (['SELL', 'SHORT', 'S'].includes(actionRaw)) action = 'SHORT';

    const engines = getEngines();
    let priceAccepted = false;
    if (symbol && Number.isFinite(price) && price > 0) {
      if (engines.onLivePrice) {
        engines.onLivePrice(symbol, price, { source: 'tradingview' });
        priceAccepted = true;
      } else {
        bus.emit('market_update', { symbol, price, change: null, bias: null, source: 'tradingview' });
        priceAccepted = true;
      }
    }

    // Optional: treat as a signal alert (dashboard + telegram path via bus)
    const makeSignal = body.signal !== false && action !== 'WAIT' && symbol;
    let signalId = null;
    if (makeSignal) {
      signalId = `tv-${symbol}-${Date.now()}`;
      const payload = {
        id: signalId,
        symbol,
        action,
        timeframe: body.interval || body.timeframe || 'TV',
        currentPrice: Number.isFinite(price) ? price : null,
        score: { final: Number(body.score) || 80, grade: 'TV' },
        source: 'tradingview',
        strategy: body.strategy || body.strategy_id || 'TradingView Alert',
        timestamp: Date.now(),
        entry: Number.isFinite(price) ? price : null,
        stopLoss: body.sl != null ? Number(body.sl) : null,
        targets: body.tp != null ? [Number(body.tp)] : [],
        gate: { status: 'tv_alert', checklist: {} },
        agents: [{ name: 'TradingView', direction: action, confidence: 80 }],
        agreeCount: 1,
        note: body.message || body.comment || 'TradingView webhook alert',
      };
      bus.emit('signal', payload);
      // Also try dispatcher if present
      try {
        const dispatcher = getDispatcher();
        if (dispatcher?.ingestExternalSignal) dispatcher.ingestExternalSignal(payload);
      } catch (_) {}
    }

    res.json({
      ok: true,
      symbol: symbol || null,
      priceAccepted,
      signalId,
      action: makeSignal ? action : 'none',
      mode: 'signal_only',
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
  bus.on('market_update', payload => {
    if (!payload?.symbol || payload.price == null) return;
    const price = Number(payload.price);
    if (!Number.isFinite(price)) return;
    MARKET_SNAPSHOT_CACHE.set(String(payload.symbol).toUpperCase(), {
      symbol: String(payload.symbol).toUpperCase(),
      price,
      change: payload.change ?? null,
      bias: payload.bias ?? null,
      source: payload.source || 'unknown',
      timestamp: payload.timestamp || Date.now(),
    });
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
