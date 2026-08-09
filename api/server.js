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
const { FMPFeed } = require('../feeds/fmp-feed');
const { FearGreedFeed } = require('../feeds/fear-greed-feed');
const { CoinGeckoFeed } = require('../feeds/coingecko-feed');
const { AdaptiveLearningEngine } = require('../signal-pipeline/adaptive-learning-engine');
const { MarketOutlookBuilder } = require('../signal-pipeline/market-outlook');
const { recordOutcomeEverywhere } = require('../signal-pipeline/outcome-recorder');
const { MarketHeatMap } = require('../automation/market-heatmap');
const fs = require('fs');

const API_PORT = Number(process.env.PORT || process.env.WS_PORT || 3001);
// FIX: was 'webapp' (the vanilla-JS single-file frontend) — that file has been retired in favor of webapp-react (see its README: "A Bloomberg- terminal-style replacement for the vanilla-JS webapp/...
const STATIC_ROOT = path.join(__dirname, '..', 'webapp-react', 'dist');
if (!fs.existsSync(path.join(STATIC_ROOT, 'index.html'))) {
  console.warn(`[API] ${STATIC_ROOT} has no index.html — did the webapp-react build step run? (npm run build --prefix webapp-react)`);
}
const finnhub = new FinnhubFeed();
const yahooNews = new YahooNewsFeed();
const ffCalendar = new ForexFactoryCalendar();
const fmpFeed = new FMPFeed();
const fearGreed = new FearGreedFeed();
const coinGecko = new CoinGeckoFeed();
const learningEngine = new AdaptiveLearningEngine({ store: db });

// FIX comment on that listener for why this cache exists at all.
const RECENT_SIGNALS_CACHE = [];
const RECENT_SIGNALS_CACHE_LIMIT = 200;
const MARKET_SNAPSHOT_CACHE = new Map();

let serverState = null;

function dashboardReadAuth(req, res, next) {
  if (req.emailSession?.email) {
    req.authMethod = 'email';
    req.telegramUser = { id: req.emailSession.email, username: req.emailSession.email };
    return next();
  }
  // Price / health endpoints must stay readable when the laptop is off.
  const path = (req.path || req.url || '').split('?')[0];
  const publicPricePaths = new Set([
    '/api/market', '/api/candles', '/api/health', '/health',
    '/api/calendar', '/api/news',
    '/api/signals', '/api/audit-trail', '/api/outlook',
    '/api/heatmap', '/api/stats', '/api/levels', '/api/watchlist',
  ]);
  if (req.method === 'GET' && publicPricePaths.has(path)) {
    req.telegramUser = { id: 'public-prices', username: 'public-prices' };
    req.authMethod = 'public-prices';
    return next();
  }
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
  // FIX: publicLimiter below deliberately skips everything under /api/auth/ (see its `skip` function) — that's correct, a dashboard-read budget is the wrong shape for login endpoints — but nothing ever...
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.AUTH_RATE_LIMIT_PER_MIN || 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many auth requests — wait a minute and try again' },
  });
  app.use('/api/auth/email', authLimiter, createEmailAuthRouter(express, db));
  ensureAuthIndexes(db).catch(err => console.warn('[AUTH] indexes:', err.message));
  // EA price ticks are 1/sec and must not share this budget or broker prices never land and Yahoo wins.
  const publicLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.API_RATE_LIMIT_PER_MIN || 120),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      const p = (req.path || req.url || '').split('?')[0];
      if (p.startsWith('/api/ea/') || p.startsWith('/api/webhooks/') || p.startsWith('/api/auth/')) return true;
      // Static shell must never be rate-limited or Chrome cannot install the desktop app
      if (p === '/sw.js' || p === '/manifest.json' || p === '/manifest.webmanifest') return true;
      if (p.startsWith('/icons/') || p.startsWith('/assets/')) return true;
      if (p === '/' || p === '/index.html') return true;
      return false;
    },
  });
  app.use(publicLimiter);
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
    // Same fix as /api/health above (MemoryManager.getFullStats() had zero callers anywhere) — this endpoint is what the frontend's About panel actually fetches, which that fix didn't reach since it only...
    let cache = null;
    try { cache = getEngines().memory?.getFullStats?.() || null; } catch (_) { }
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
    // FIX: was `catch (_) {}` — a DB hiccup here was invisible; you'd see the user "authenticate" successfully while the upsert silently failed.
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

  // never shows something the signal pipeline itself didn't actually see. candleStores[symbol][tf] already includes the still-forming (unclosed) current bar — both onMT5Tick() and the exchange WS feeds...
  app.get('/api/candles', dashboardReadAuth, async (req, res) => {
    const live = getEngines();
    if (!live.candleStores) {
      return res.status(503).json({ ok: false, error: 'Candle store not yet initialized' });
    }
    const symbol = String(req.query.symbol || '').toUpperCase().trim();
    const timeframe = String(req.query.timeframe || 'H1').toUpperCase().trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 10), 500);
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
    let candles = live.candleStores[symbol]?.[timeframe];
    if (!candles?.length) {
      const fallbacks = { H4: ['H1', 'D1'], M30: ['M15', 'H1'], M1: ['M5', 'M15'] };
      for (const fb of (fallbacks[timeframe] || [])) {
        if (live.candleStores[symbol]?.[fb]?.length) {
          candles = live.candleStores[symbol][fb];
          break;
        }
      }
    }
    if (!candles || !candles.length) {
      return res.json({ ok: true, symbol, timeframe, candles: [], note: 'No candle history yet — wait for Deriv/MT5.' });
    }
    // FIX: prefer bid-based OHLC (bidOpen/bidHigh/bidLow/bidClose, only
    // present on mt5_ea-sourced bars — see onMT5Tick in index.js) over
    // the mid-based open/high/low/close every candle already carries.
    // Mid is what the agents/signal pipeline correctly use and this does
    // not change that — a chart built from mid can never visually match
    // the bid/ask the ticker shows above it, on every symbol, always, by
    // definition of what "mid" means. Falls back to mid for non-EA
    // sources (Deriv/crypto) which don't carry a separate bid/ask.
    const out = candles.slice(-limit).map(c => {
      const raw = Number(c.timestamp ?? c.time);
      if (!Number.isFinite(raw)) return null;
      const time = Math.floor(raw > 1e12 ? raw / 1000 : raw);
      const open = Number(c.bidOpen ?? c.open), high = Number(c.bidHigh ?? c.high),
            low = Number(c.bidLow ?? c.low), close = Number(c.bidClose ?? c.close);
      if (![time, open, high, low, close].every(Number.isFinite)) return null;
      if (time < 1e8) return null;
      return { time, open, high, low, close, volume: Number(c.volume) || 0 };
    }).filter(Boolean);
    out.sort((a, b) => a.time - b.time);
    const dedup = [];
    for (const bar of out) {
      if (dedup.length && dedup[dedup.length - 1].time === bar.time) dedup[dedup.length - 1] = bar;
      else dedup.push(bar);
    }
    res.json({ ok: true, symbol, timeframe, candles: dedup });
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

      app.get('/api/calendar', dashboardReadAuth, async (_req, res) => {
    const now = Date.now();
    let events = [];
    let sources = [];
    let feedError = null;

    const pushFf = async () => {
      try {
        const ff = await ffCalendar.economicCalendar();
        if (Array.isArray(ff) && ff.length) {
          events.push(...ff);
          sources.push('forex-factory');
        }
      } catch (err) {
        feedError = err.message;
        console.warn('[API] FF calendar:', err.message);
      }
    };

    const pushFinnhub = async () => {
      try {
        if (!finnhub.enabled()) return;
        const from = new Date(now - 24 * 3600000).toISOString().slice(0, 10);
        const to = new Date(now + 8 * 86400000).toISOString().slice(0, 10);
        const fh = await finnhub.economicCalendar(from, to);
        if (!Array.isArray(fh) || !fh.length) {
          console.warn('[API] Finnhub calendar empty', from, to);
          return;
        }
        const impactMap = (v) => {
          if (v == null) return null;
          if (typeof v === 'string') return v;
          const n = Number(v);
          if (n >= 3) return 'High';
          if (n === 2) return 'Medium';
          if (n === 1) return 'Low';
          return String(v);
        };
        for (const e of fh) {
          const rawTime = e.time || e.date || e.datetime;
          let time = NaN;
          if (typeof rawTime === 'number') time = rawTime < 1e12 ? rawTime * 1000 : rawTime;
          else if (rawTime) time = new Date(rawTime).getTime();
          if (!Number.isFinite(time)) continue;
          events.push({
            name: e.event || e.name || e.title || 'Economic Event',
            currency: e.currency || e.country || 'USD',
            time,
            impact: impactMap(e.impact ?? e.importance),
            forecast: e.estimate ?? e.forecast ?? null,
            previous: e.prev ?? e.previous ?? null,
            source: 'finnhub',
          });
        }
        sources.push('finnhub');
      } catch (err) {
        console.warn('[API] Finnhub calendar:', err.message);
        if (!feedError) feedError = err.message;
      }
    };

    await pushFf();
    if (events.length < 5) await pushFinnhub();

    if (events.length < 5) {
      try {
        if (fmpFeed.enabled()) {
          const from = new Date(now - 24 * 3600000).toISOString().slice(0, 10);
          const to = new Date(now + 8 * 86400000).toISOString().slice(0, 10);
          const rows = await fmpFeed.economicCalendar(from, to);
          if (Array.isArray(rows) && rows.length) {
            for (const e of rows) {
              const time = e.date ? new Date(e.date).getTime() : NaN;
              if (!Number.isFinite(time)) continue;
              events.push({
                name: e.event || e.title || 'Economic Event',
                currency: e.currency || e.country || 'USD',
                time,
                impact: e.impact || null,
                forecast: e.estimate ?? e.forecast ?? null,
                previous: e.previous ?? e.prev ?? null,
                source: 'fmp',
              });
            }
            sources.push('fmp');
          }
        }
      } catch (err) {
        console.warn('[API] FMP calendar:', err.message);
      }
    }

    // Persist last good week in memory on the process (survives 429 for a while)
    if (!global.__omniCalendarCache) global.__omniCalendarCache = { events: [], ts: 0 };
    if (events.length) {
      global.__omniCalendarCache = { events: [...events], ts: now };
    } else if (global.__omniCalendarCache.events.length && now - global.__omniCalendarCache.ts < 7 * 86400000) {
      events = global.__omniCalendarCache.events;
      sources.push('memory-cache');
    }

    const seen = new Set();
    const unique = [];
    for (const e of events) {
      if (!Number.isFinite(e.time)) continue;
      const day = new Date(e.time).toISOString().slice(0, 10);
      const k = `${String(e.name || '').toLowerCase()}|${e.currency}|${day}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(e);
    }

    let upcoming = unique.filter(e => e.time >= now - 12 * 3600000);
    if (!upcoming.length && unique.length) {
      upcoming = [...unique].sort((a, b) => a.time - b.time).slice(0, 50);
    }

    const rank = (imp) => {
      const i = String(imp || '').toLowerCase();
      if (i === 'high' || i === '3') return 0;
      if (i === 'medium' || i === '2') return 1;
      return 2;
    };
    upcoming.sort((a, b) => rank(a.impact) - rank(b.impact) || a.time - b.time);

    const mapped = upcoming.slice(0, 100).map(e => ({
      name: e.name,
      currency: e.currency,
      time: e.time,
      impact: e.impact,
      forecast: e.forecast,
      previous: e.previous,
      source: e.source || 'calendar',
      hoursAway: Math.round((e.time - now) / 3600000 * 10) / 10,
    }));

    res.json({
      ok: true,
      events: mapped,
      count: mapped.length,
      rawCount: unique.length,
      sources,
      feedError,
    });
  });

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

  app.get('/api/health', dashboardReadAuth, async (req, res) => {
    const live = getEngines();
    if (!live.dataIntegrityMonitor || !live.candleStores) {
      return res.status(503).json({ ok: false, error: 'Health monitor unavailable — trading engine not yet initialized' });
    }
    const report = live.dataIntegrityMonitor.check(live.candleStores);
    // FIX: MemoryManager's RedisAdapter/PineconeAdapter already tracked an internal error counter on every failed cache write, but nothing anywhere ever read it — a failing Redis/Pinecone connection was...
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
    // Frontend has no display for it yet either — see the matching webapp/index.html fix.
    const dispatcher = getDispatcher();
    const accountBalance = dispatcher?.accountBalance ?? null;
    res.json({ ok: true, stats, accountBalance });
  });

  // ── Equity Curve (doc gap: webapp-react/README.md's "Known gaps" note — "no dedicated equity-history endpoint ...
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
    try {
      const y = await yahooNews.getNews({ limit: 40 });
      if (Array.isArray(y)) news.push(...y.map(n => normalize(n, 'Yahoo Finance')));
    } catch (err) {
      console.warn('[API] Yahoo news failed:', err.message);
    }

    try {
      let fh = symbol
        ? await finnhub.companyNews(symbol)
        : await finnhub.marketNews(req.query.category || 'general');
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

    // Strict market wire: crypto / FX / macro / commodities that move risk assets
    const RELEVANT = /bitcoin|btc|ethereum|eth|crypto|defi|stablecoin|binance|coinbase|forex|fx\b|eurusd|gbpusd|usdjpy|currency|dollar|dxy|fed\b|fomc|ecb|boj|boe|cpi|nfp|inflation|interest rate|treasury|yield|gold|xau|oil|wti|brent|opec|nasdaq|s&p|central bank|payroll|etf|sec\b/i;
    const NOISE = /celebrity|sports|football|nba|movie|netflix|recipe|horoscope|gossip|weather forecast/i;
    const seen = new Set();
    news = news.filter(n => {
      const k = String(n.headline || '').toLowerCase().slice(0, 60);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      const text = `${n.headline || ''} ${n.summary || ''} ${n.category || ''}`;
      if (NOISE.test(text)) return false;
      return RELEVANT.test(text);
    }).sort((a, b) => (b.datetime || 0) - (a.datetime || 0)).slice(0, 50);

    res.json({ ok: true, news, sources: ['yahoo', finnhub.enabled() ? 'finnhub' : null].filter(Boolean) });
  });

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
    // FIX: learningEngine (AdaptiveLearningEngine) was instantiated at the top of this file but never called anywhere in the API layer — its Q-table size, blacklist size, and cache state were invisible...
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

  const EA_SECRET = process.env.EA_SECRET || '';
  // FIX: EA_SECRET was undocumented in .env.example and, when unset, silently left /api/ea/signals — the endpoint that hands out live trading signals to the MT5 EA — open to anyone who finds the URL,...
  if (!EA_SECRET) {
    console.warn('[API] EA_SECRET not set — /api/ea/signals is open access (no auth required)');
  }
  function eaAuth(req, res, next) {
    const token = req.headers['x-ea-secret'] || req.query.secret;
    if (!EA_SECRET) return next();
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
      // Falls back to the env var only if a signal predates this fix or riskEvaluation is unavailable.
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
    // FIX: was only updating the dispatcher's (cosmetic, display-only) balance copy — the actual RiskEngine used for live position-size math never saw real-time balance updates.
    try {
      getEngines().riskEngine?.setBalance(balance);
    } catch (err) {
      console.warn(`[API] Failed to update RiskEngine balance to ${balance} — position sizing may be using a stale balance: ${err.message}`);
    }
    bus.emit('balance_update', { balance, equity, margin, freeMargin, updatedAt: Date.now() });
    res.json({ ok: true, balance });
  });

  // FIX: this used to compute a flattened mid-price and hand it straight to onLivePrice() — the ticker/position-monitoring layer only.
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

  const TV_WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || process.env.EA_SECRET || '';
  function tvAuth(req, res, next) {
    if (!TV_WEBHOOK_SECRET) return next();
    const token = req.headers['x-webhook-secret'] || req.query.secret || req.body?.secret;
    if (token === TV_WEBHOOK_SECRET) return next();
    return res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
  }

  app.post('/api/webhooks/tradingview', tvAuth, (req, res) => {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = { raw: body }; }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'JSON body required' });
    }

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

    // Service worker must never be cached by the browser for 24h —
  // otherwise installed PWAs keep an old SW and never auto-update.
  app.get('/sw.js', (req, res, next) => {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Service-Worker-Allowed': '/',
      'Content-Type': 'application/javascript; charset=utf-8',
    });
    res.sendFile(path.join(STATIC_ROOT, 'sw.js'), (err) => { if (err) next(); });
  });

  // Web App Manifest — correct MIME helps Chrome/Edge install eligibility
  app.get(['/manifest.json', '/manifest.webmanifest'], (req, res, next) => {
    const file = req.path.endsWith('.webmanifest')
      ? path.join(STATIC_ROOT, 'manifest.webmanifest')
      : path.join(STATIC_ROOT, 'manifest.json');
    res.type('application/manifest+json');
    res.sendFile(file, (err) => { if (err) next(); });
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
    // FIX: same silent-swallow pattern as the REST /api/auth/telegram route above — a DB failure here was invisible.
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

  // FIX: GET /api/signals — the route the dashboard's Signals tab, Dashboard cards, and Tape all actually poll — only ever read from Mongo, with no fallback.
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
  // FIX: myfxbook/openinsider events previously only reached Telegram — now relayed to the live dashboard as well (see index.js wsBus.emit('intel', ...)).
  forward('intel', 'intel', payload => db.saveTelemetry({ type: 'intel_' + payload.kind, ...payload }));
  forward('watchlist_update', 'watchlist');
  // Data Integrity Monitor — feed/staleness health, so the dashboard shows a warning banner instead of the trader only finding out a feed died when signals quietly stop arriving.
  forward('feed_health', 'feed_health');
  forward('abnormal_market', 'abnormal_market', payload => db.saveTelemetry({ type: 'abnormal_market', ...payload }));
  forward('crypto_volatility_alert', 'crypto_volatility_alert', payload => db.saveTelemetry({ type: 'crypto_volatility_alert', ...payload }));
  // FIX: BybitFeed emits liquidation_cascade (real risk event — large forced liquidations in a short window) and index.js relays it onto wsBus, but it was never added to this forward() whitelist — it...
  forward('liquidation_cascade', 'liquidation_cascade', payload => db.saveTelemetry({ type: 'liquidation_cascade', ...payload }));
  // FIX: balance_update was emitted (real data — /api/ea/balance receives the MT5 EA's actual account balance/equity/margin) but had no forward() entry, so it silently never reached any connected browser.
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
