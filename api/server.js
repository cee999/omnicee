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

// Load persisted market snapshot cache (fast startup fallback for cold boot)
try {
  const persist = require('../lib/persist');
  const rows = persist.loadMarket();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && r.symbol) MARKET_SNAPSHOT_CACHE.set(String(r.symbol).toUpperCase(), r);
    }
    console.info('[API] loaded persisted market snapshot cache:', MARKET_SNAPSHOT_CACHE.size, 'rows');
  }
} catch (e) { /* best-effort */ }

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
    '/api/heatmap', '/api/stats', '/api/levels', '/api/watchlist', '/api/desk-brief',
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
    const bid = tick.bid != null && Number.isFinite(Number(tick.bid)) ? Number(tick.bid) : null;
    const ask = tick.ask != null && Number.isFinite(Number(tick.ask)) ? Number(tick.ask) : null;
    const mid = (bid != null && ask != null) ? (bid + ask) / 2 : tick.price;
    rowsBySymbol.set(symbol, {
      symbol,
      price: mid,
      bid,
      ask,
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

  // Cache status endpoint: reports persisted market and candle cache info.
  app.get('/api/cache/status', async (req, res) => {
    try {
      const persist = require('../lib/persist');
      const market = persist.loadMarket();
      const candles = persist.loadCandles();
      return res.json({ ok: true, market: market ? { ts: market.ts, rows: (market.rows||[]).length } : null, candles: candles ? { ts: candles.ts || null, symbols: Object.keys(candles.candleStores || {}).length } : null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
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
    // FIX: this is render.yaml's healthCheckPath — Render's own platform-
    // level gate for "is this deploy ready to receive traffic" during
    // every cold start, and it's also what the frontend's wake-probe and
    // the self-ping both hit. It was awaiting db.health() (a real Mongo
    // Atlas round-trip) with no timeout, unbounded — if Mongo was slow or
    // briefly unreachable for any reason, this endpoint got slow or hung
    // right along with it, which doesn't just slow one API call: it
    // directly extends how long Render keeps the deploy "not ready" and
    // how long the frontend's cold-start probe keeps failing. Capped at
    // 2s so a Mongo hiccup can't block this past a bounded delay.
    //
    // FIX #2, found right after shipping #1: Promise.race doesn't cancel
    // the losing promise. If db.health() takes longer than 2s and then
    // eventually rejects, that rejection arrives after the race has
    // already settled via the timeout branch — nothing is attached to
    // catch it at that point, since the `await Promise.race(...)`
    // expression itself already resolved. That's an unhandled promise
    // rejection, and on Node 15+ those are fatal by default: they crash
    // the whole process, not just this one request. Every single hit to
    // this endpoint — Render's own readiness check, the frontend's wake-
    // probe, the self-ping — was a chance to crash the server outright
    // whenever Mongo was slow-then-failing, which is exactly the kind of
    // thing that happens more, not less, right after a cold start. The
    // fix that actually needed to ship with #1: attach .catch() to
    // db.health() immediately, so any eventual rejection is always
    // handled somewhere regardless of whether it wins or loses the race.
    const dbHealthSettled = db.health().catch(err => ({ ok: false, error: err.message }));
    let mongo;
    try {
      mongo = await Promise.race([
        dbHealthSettled,
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), 2000)),
      ]);
    } catch (err) { mongo = { ok: false, error: err.message }; }
    let cache = null;
    try { cache = getEngines().memory?.getFullStats?.() || null; } catch (_) { }
    res.json({
      ok: true,
      service: 'omnicee-api',
      uptime: process.uptime(),
      mongo,
      finnhub: finnhub.enabled(),
      cache,
      eaAuthFailures,
      eaAuthLastFailureAt,
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
    let mongo = await db.getRecentSignals({ symbol, limit }).catch(err => {
      console.warn('[API] getRecentSignals (Mongo) failed, falling back to in-memory cache:', err.message);
      return null;
    });
    const mem = RECENT_SIGNALS_CACHE.filter(s => !symbol || s.symbol === symbol);
    // Merge: memory first (freshest live scores including WAIT), then mongo FIRE history
    const seen = new Set();
    const signals = [];
    for (const s of [...mem, ...(Array.isArray(mongo) ? mongo : [])]) {
      const id = s.id || s.signalId || `${s.symbol}-${s.timestamp || s.ts || ''}-${s.action}`;
      if (seen.has(id)) continue;
      seen.add(id);
      signals.push(s);
      if (signals.length >= limit) break;
    }
    res.json({ ok: true, signals, source: mem.length ? 'memory+mongo' : (mongo?.length ? 'mongo' : 'empty') });
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
    const limit = Math.min(Math.max(Number(req.query.limit) || 400, 10), 600);
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

  // Vibe-style multi-agent desk brief (rule-based, no external LLM required).
  // Teams: Session · Regime · Signals · Macro · Risk — grounded in live engine data.
  app.get('/api/desk-brief', dashboardReadAuth, async (_req, res) => {
    const live = getEngines() || {};
    const now = Date.now();
    const session = (typeof MarketOutlookBuilder?.sessionInfo === 'function')
      ? MarketOutlookBuilder.sessionInfo(now)
      : { name: 'Unknown', note: '', label: '' };

    let outlook = null;
    try {
      if (live.regimeEngine && live.candleStores && MarketOutlookBuilder?.build) {
        outlook = MarketOutlookBuilder.build({
          symbols: live.symbols || [],
          candleStores: live.candleStores,
          regimeEngine: live.regimeEngine,
          sessionFilter: live.sessionFilter,
          cotParser: live.cotParser,
          timeframe: 'H1',
        });
      }
    } catch (err) {
      console.warn('[API] desk-brief outlook:', err.message);
    }

    // Recent signals from memory/cache if available
    let signals = [];
    try {
      if (typeof live.getRecentSignals === 'function') {
        signals = live.getRecentSignals(20) || [];
      } else if (Array.isArray(live.recentSignals)) {
        signals = live.recentSignals.slice(0, 20);
      }
    } catch (_) {}

    const fired = (signals || []).filter(s => {
      const a = String(s.action || s.direction || '').toUpperCase();
      return a === 'BUY' || a === 'SELL';
    });
    const waits = (signals || []).filter(s => String(s.action || '').toUpperCase() === 'WAIT');

    const regimes = (outlook?.perSymbol || outlook?.symbols || []).slice(0, 12).map(e => ({
      symbol: e.symbol,
      regime: e.regime || '—',
      tradeability: e.tradeability ?? null,
      note: (e.reasons && e.reasons[0]) || e.dataNote || null,
    }));

    const topTradeable = regimes
      .filter(r => r.tradeability != null)
      .slice()
      .sort((a, b) => (Number(b.tradeability) || 0) - (Number(a.tradeability) || 0))
      .slice(0, 5);

    // Macro: next high-impact calendar if engine or global cache has it
    let macroEvents = [];
    try {
      const cal = global.__omniCalendarCache?.events || [];
      macroEvents = cal
        .filter(e => Number.isFinite(e.time) && e.time >= now - 3600000)
        .slice(0, 8)
        .map(e => ({
          name: e.name,
          currency: e.currency,
          time: e.time,
          impact: e.impact,
          hoursAway: Math.round((e.time - now) / 3600000 * 10) / 10,
        }));
    } catch (_) {}

    let journal = null;
    try {
      journal = live.journal?.getStats?.() || live.signalJournal?.getStats?.() || null;
    } catch (_) {}

    const teams = [
      {
        id: 'session',
        title: 'Session desk',
        summary: session.label || session.name || 'Session',
        bullets: [session.note || 'Session context unavailable'].filter(Boolean),
      },
      {
        id: 'regime',
        title: 'Regime / quant',
        summary: topTradeable.length
          ? `Top tradeable: ${topTradeable.map(r => r.symbol).join(', ')}`
          : 'Waiting for OHLC depth (≥40 bars) to classify regimes',
        bullets: topTradeable.map(r => `${r.symbol}: ${r.regime}${r.tradeability != null ? ` · tradeability ${Math.round(Number(r.tradeability))}` : ''}`),
      },
      {
        id: 'signals',
        title: 'Signal team',
        summary: fired.length
          ? `${fired.length} live BUY/SELL in recent window`
          : (waits.length ? `${waits.length} WAIT scores — no FIRE yet` : 'No recent pipeline scores'),
        bullets: fired.slice(0, 5).map(s => {
          const a = String(s.action || s.direction || '').toUpperCase();
          const sc = s.score?.final ?? s.score ?? '—';
          return `${s.symbol} ${a} · score ${sc} · ${s.timeframe || 'H1'}`;
        }),
      },
      {
        id: 'macro',
        title: 'Macro / risk calendar',
        summary: macroEvents.length
          ? `${macroEvents.length} upcoming events in view`
          : 'Calendar thin — check NEWS / calendar feeds',
        bullets: macroEvents.slice(0, 5).map(e => {
          const imp = e.impact ? ` [${e.impact}]` : '';
          return `${e.currency || ''} ${e.name}${imp} · ${e.hoursAway}h`;
        }),
      },
      {
        id: 'risk',
        title: 'Risk / journal',
        summary: journal && journal.total
          ? `Journal ${journal.total} trades · WR ${journal.winRate ?? '—'}% · PF ${journal.pf ?? '—'}`
          : 'No closed outcomes yet — Shadow journal will fill as trades resolve',
        bullets: journal && journal.total
          ? [
              `Expectancy (R): ${journal.expectancy ?? '—'}`,
              `Avg win/loss (R): ${journal.avgWin ?? '—'} / ${journal.avgLoss ?? '—'}`,
            ]
          : ['Record outcomes on Valid tab to unlock Shadow diagnostics'],
      },
    ];

    res.json({
      ok: true,
      generatedAt: now,
      session,
      teams,
      regimes,
      signalCounts: { fired: fired.length, wait: waits.length, total: (signals || []).length },
      style: 'multi-agent-desk-brief',
    });
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
      const y = await yahooNews.getNews({ limit: 60 });
      if (Array.isArray(y)) news.push(...y.map(n => normalize(n, 'Yahoo Finance')));
    } catch (err) {
      console.warn('[API] Yahoo news failed:', err.message);
    }

    try {
      // FIX: default fallback here was 'general' — Finnhub's broad
      // business-news category — and the frontend's news fetch never
      // passes a ?category, so this ran on every single default page
      // load. The forex/crypto loop right below already covers both of
      // the categories actually wanted here; this initial call just
      // needs to not default to the one category that isn't either.
      let fh = symbol
        ? await finnhub.companyNews(symbol)
        : await finnhub.marketNews(req.query.category || 'crypto');
      if (!symbol && finnhub.enabled()) {
        // FIX: was pulling Finnhub's 'general' category alongside forex/
        // crypto — 'general' is broad business/markets news (earnings,
        // IPOs, macro, whatever Finnhub considers newsworthy that day),
        // not crypto/forex-specific. It fed into the same RELEVANT regex
        // below, which — unlike feeds/yahoo-news-feed.js's own scoring,
        // which explicitly penalizes pure-equity terms unless FX/crypto
        // is also present — just needed one keyword match to pass. That
        // let plain stock-market stories through as long as they
        // mentioned, say, "the Fed" in passing. Dropped 'general' at the
        // source instead of trying to out-filter it downstream.
        for (const cat of ['forex', 'crypto', 'general', 'merger']) {
          try {
            const extra = await finnhub.marketNews(cat);
            if (Array.isArray(extra)) fh = [...(Array.isArray(fh) ? fh : []), ...extra];
          } catch (_) {}
        }
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

    // FIX: RELEVANT below was "one keyword match, anywhere, passes" with
    // no penalty for pure-equity content and no specificity floor — a
    // story built entirely around Nasdaq/S&P earnings still got through
    // as long as it mentioned "the Fed" once in passing, since fed\b was
    // in the same flat alternation as bitcoin/forex/etc. That's the
    // actual dilution behind "I want this very much crypto and forex" —
    // not a missing filter, a too-loose one. Rewritten to match the
    // stricter standard feeds/yahoo-news-feed.js already uses for its own
    // scoring: crypto/forex/commodity terms are the core; macro (Fed/CPI/
    // NFP/central-bank) genuinely moves both markets so it stays, but
    // pure-equity terms (Nasdaq/S&P/earnings/IPO/ETF) with no crypto,
    // forex, commodity, or macro tie-in are now excluded outright instead
    // of being one regex-alternation away from passing.
    const CRYPTO = /bitcoin|btc|ethereum|eth\b|crypto|defi|stablecoin|binance|coinbase|solana/i;
    const FOREX = /forex|\bfx\b|eurusd|gbpusd|usdjpy|currency pair|\bdxy\b|dollar index|euro|sterling|yen|cable/i;
    const MACRO = /\bfed\b|fomc|\becb\b|\bboj\b|\bboe\b|\bcpi\b|\bnfp\b|inflation|interest rate|treasury yield|central bank|nonfarm|payroll/i;
    const COMMODITY = /gold|\bxau\b|\boil\b|\bwti\b|brent|opec|silver|copper/i;
    const STOCKS = /\b(nasdaq|s&p|s&p 500|dow jones|stock market|equities|earnings|ipo|etf|shares|wall street|nyse|tech stocks|megacap)\b/i;
    const NOISE = /celebrity|sports|football|nba|movie|netflix|recipe|horoscope|gossip|weather forecast/i;
    const seen = new Set();
    news = news.filter(n => {
      const k = String(n.headline || '').toLowerCase().slice(0, 60);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      const text = `${n.headline || ''} ${n.summary || ''} ${n.category || ''}`;
      if (NOISE.test(text)) return false;
      // Keep forex, crypto, commodities, macro, AND stocks (user request)
      if (!(CRYPTO.test(text) || FOREX.test(text) || COMMODITY.test(text) || MACRO.test(text) || STOCKS.test(text))) return false;
      return true;
    }).map(n => {
      const text = `${n.headline || ''} ${n.summary || ''} ${n.category || ''}`;
      let rank = 0;
      if (FOREX.test(text)) rank += 12;
      if (STOCKS.test(text)) rank += 11;
      if (CRYPTO.test(text)) rank += 10;
      if (COMMODITY.test(text)) rank += 4;
      if (MACRO.test(text)) rank += 3;
      n._rank = rank;
      return n;
    }).sort((a, b) => ((b.datetime || 0) - (a.datetime || 0)) || (b._rank - a._rank))
      .map(({ _rank, ...rest }) => rest)
      .slice(0, 60);

    res.json({ ok: true, news, sources: ['yahoo', finnhub.enabled() ? 'finnhub' : null].filter(Boolean) });
  });

  // Hurst analysis layer — path-dependence regime board (not a trade signal)
  app.get('/api/hurst', dashboardReadAuth, async (_req, res) => {
    try {
      const live = getEngines() || {};
      let board = [];
      if (live.hurstAnalysis?.getLastBoard) {
        const last = live.hurstAnalysis.getLastBoard();
        board = last.board || [];
      }
      if ((!board || !board.length) && live.hurstAnalysis?.buildBoard && live.candleStores) {
        const symbols = Object.keys(live.candleStores || {});
        board = live.hurstAnalysis.buildBoard(live.candleStores, symbols);
      }
      // On-demand from fractal agent stores if still empty
      if ((!board || !board.length) && live.candleStores) {
        try {
          const { buildHurstBoard } = require('../signal-pipeline/hurst-analysis');
          board = buildHurstBoard(live.candleStores, Object.keys(live.candleStores), ['H1', 'H4']);
        } catch (_) {}
      }
      res.json({ ok: true, layer: 'hurst_analysis', board: board || [], note: 'Analysis only — does not fire trades' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Standalone advanced analysis (Hurst + DFA + FRAMA + Lyapunov) — not wired to signals
  app.get('/api/analysis', dashboardReadAuth, async (req, res) => {
    try {
      const live = getEngines() || {};
      const { buildAdvancedBoard, analyzeSeries } = require('../signal-pipeline/advanced-analysis');
      const tfParam = String(req.query.timeframes || 'H1,H4');
      const timeframes = tfParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const symbolQ = String(req.query.symbol || '').toUpperCase().trim();

      if (symbolQ && live.candleStores?.[symbolQ]) {
        const byTf = live.candleStores[symbolQ];
        const tfs = {};
        for (const tf of timeframes) {
          if (byTf[tf]?.length) tfs[tf] = analyzeSeries(byTf[tf], { symbol: symbolQ, timeframe: tf });
        }
        const primary = tfs[timeframes[0]] || Object.values(tfs)[0] || null;
        return res.json({
          ok: true,
          layer: 'advanced_analysis',
          standalone: true,
          symbol: symbolQ,
          result: primary,
          multi: tfs,
          note: 'Standalone advanced analysis — independent of signal pipeline',
        });
      }

      let symbols = Object.keys(live.candleStores || {});
      if (req.query.symbols) {
        symbols = String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      }
      const board = live.candleStores
        ? buildAdvancedBoard(live.candleStores, symbols, timeframes.length ? timeframes : ['H1', 'H4'])
        : [];
      res.json({
        ok: true,
        layer: 'advanced_analysis',
        standalone: true,
        board,
        note: 'Standalone advanced analysis — independent of signal pipeline / Hurst engine',
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
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

  const EA_SECRET = String(process.env.EA_SECRET || '').trim();
  const EA_SECRET_REQUIRED = process.env.NODE_ENV === 'production';
  // FIX: an auth failure here was completely silent server-side — just a
  // 401 JSON response nobody's watching, since the EA runs unattended in
  // a MT5 terminal in the background. That's a real trap after the
  // "harden EA auth" security fix: it rightly stripped the hardcoded
  // secret that used to ship as OmniceeEA.mq5's default InpEASecret value
  // (it was exposed in git history) — but .mq5 changes don't auto-deploy
  // the way this web app does. Anyone still running the EA they already
  // had compiled and attached in MT5 is silently sending the OLD secret
  // on every single price tick, getting 401'd, and has no way to know —
  // the chart just quietly stays on Deriv forever, looking like a chart
  // bug rather than what it actually is: an auth mismatch that needs the
  // EA recompiled and its InpEASecret input re-entered to match whatever
  // EA_SECRET is actually set on this deployment. Tracked here so /health
  // (which the frontend already polls) can surface it as a real banner
  // instead of a silent, indistinguishable-from-normal-Deriv-usage state.
  let eaAuthFailures = 0;
  let eaAuthLastFailureAt = null;
  let eaAuthLastFailureLoggedAt = 0;
  function eaAuth(req, res, next) {
    if (!EA_SECRET) {
      if (EA_SECRET_REQUIRED) {
        return res.status(503).json({ ok: false, error: 'EA authentication is not configured' });
      }
      return next();
    }
    const token = String(req.headers['x-ea-secret'] || '').trim();
    const crypto = require('crypto');
    const expected = Buffer.from(EA_SECRET);
    const supplied = Buffer.from(token);
    if (supplied.length === expected.length && supplied.length > 0 && crypto.timingSafeEqual(supplied, expected)) {
      return next();
    }
    eaAuthFailures++;
    eaAuthLastFailureAt = Date.now();
    // Log at most once a minute — the EA retries this every ~1s, and a
    // 401-per-second log spam would itself become the thing burying the
    // signal that something needs fixing.
    if (Date.now() - eaAuthLastFailureLoggedAt > 60000) {
      eaAuthLastFailureLoggedAt = Date.now();
      console.warn(`[API] EA auth rejected on ${req.path} (${eaAuthFailures} failures since boot) — if this is your own MT5 EA, its InpEASecret input doesn't match this deployment's EA_SECRET. Recompile mt5/OmniceeEA.mq5 and re-enter the secret in the EA's Inputs tab in MT5; the old hardcoded default was removed for security and won't auto-update in a terminal that's already running it.`);
    }
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

  const indexHtml = path.join(STATIC_ROOT, 'index.html');
  const hasFrontend = fs.existsSync(indexHtml);

  function sendIndex(req, res, next) {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    if (!hasFrontend) {
      res.status(503).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OMNICEE — build missing</title></head>
<body style="margin:0;background:#05070a;color:#eef2f7;font-family:ui-monospace,monospace;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:420px;padding:24px;border:1px solid #1c232d;border-radius:12px;background:#0b0f14">
<div style="color:#f0b429;font-weight:700;margin-bottom:8px">Frontend build missing</div>
<div style="color:#8b9bb0;font-size:12px;line-height:1.5;margin-bottom:12px">
webapp-react/dist/index.html was not produced on this deploy. Check Render build logs for
<code>npm --prefix webapp-react run build</code> (vite must install with --include=dev).
API is up — only the UI shell is missing.
</div>
<div style="font-size:11px;color:#526078">GET /health still works for status checks.</div>
</div></body></html>`);
      return;
    }
    res.sendFile(indexHtml, (err) => { if (err) next(); });
  }

  // Hashed /assets can cache hard; HTML must never stick after a deploy.
  app.get(['/', '/index.html'], sendIndex);
  app.use(express.static(STATIC_ROOT, {
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    return sendIndex(req, res, next);
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
    // Keep mobile / Render free-tier clients alive through sleep + cold starts
    pingInterval: 15000,
    pingTimeout: 20000,
    connectTimeout: 20000,
    allowUpgrades: true,
    perMessageDeflate: false,
    maxHttpBufferSize: 1e6,
  });

  io.use(async (socket, next) => {
    try {
      const appToken = socket.handshake.auth?.appToken || socket.handshake.query?.appToken;
      if (appToken) {
        const appValidation = validateAppToken(appToken);
        if (appValidation.ok) {
          socket.telegramUser = appValidation.user;
          socket.authMethod = 'app-token';
          return next();
        }
      }

      // Email OTP session (desk login) — same token as REST Authorization Bearer
      const sessionToken = String(
        socket.handshake.auth?.sessionToken
        || socket.handshake.headers?.['x-session-token']
        || ''
      ).trim();
      if (sessionToken && db?.getDB) {
        try {
          const mongo = await db.getDB();
          const session = await mongo.collection('sessions').findOne({ token: sessionToken });
          if (session && (!session.expiresAt || new Date(session.expiresAt).getTime() > Date.now())) {
            socket.emailUser = { email: session.email };
            socket.authMethod = 'email-session';
            return next();
          }
        } catch (err) {
          console.warn('[API] socket session auth:', err.message);
        }
      }

      const initData = socket.handshake.auth?.initData || socket.handshake.query?.initData;
      // Allow unauthenticated socket for public market ticks when dashboard is public
      const publicRead = process.env.PUBLIC_DASHBOARD_READ === 'true' || process.env.EMAIL_AUTH_REQUIRED === 'false';
      if (!initData && !appToken && !sessionToken && (process.env.NODE_ENV !== 'production' || publicRead)) {
        socket.authMethod = 'public';
        return next();
      }
      if (!initData) {
        // Still allow connection for price/signal push; REST remains gated
        socket.authMethod = 'anonymous';
        return next();
      }
      const validation = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
      if (!validation.ok) return next(new Error(validation.reason));
      socket.telegramUser = validation.user;
      socket.authMethod = 'telegram';
      try { await db.upsertTelegramUser(validation.user); } catch (err) { console.warn('[API] upsertTelegramUser failed (socket auth):', err.message); }
      return next();
    } catch (err) {
      return next(err);
    }
  });

  io.on('connection', socket => {
    console.log(`[API] socket connected ${socket.id} auth=${socket.authMethod || 'n/a'}`);
    socket.emit('connected', {
      serverTime: Date.now(),
      transport: 'socket.io',
      authMethod: socket.authMethod || null,
    });
    // Snapshot helps clients that just reconnected after sleep
    try {
      const prices = {};
      for (const [sym, snap] of MARKET_SNAPSHOT_CACHE.entries()) {
        prices[sym] = snap;
      }
      socket.emit('market_snapshot', { prices, at: Date.now() });
      if (RECENT_SIGNALS_CACHE.length) {
        socket.emit('history', { signals: RECENT_SIGNALS_CACHE.slice(0, 40) });
      }
    } catch (_) {}

    socket.on('subscribe', () => {
      // Channels are broadcast globally today; ack so client knows subscription is live
      socket.emit('subscribed', { ok: true, channels: ['market', 'signal', 'balance', 'heartbeat'] });
    });
    socket.on('heartbeat', (payload) => {
      socket.emit('heartbeat_ack', {
        t: Date.now(),
        echo: payload && payload.t != null ? payload.t : null,
        authMethod: socket.authMethod || null,
      });
    });
    socket.on('setting', payload => bus.emit('setting_change', { socketId: socket.id, ...payload }));
    socket.on('get_history', async payload => {
      let signals = RECENT_SIGNALS_CACHE.slice(0, payload?.limit || 50);
      if (!signals.length) {
        signals = await db.getRecentSignals({ symbol: payload?.symbol, limit: payload?.limit || 50 }).catch(() => []);
      }
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
    const compact = db.compactSignal({
      ...payload,
      currentPrice: payload.currentPrice ?? payload.entry ?? payload.price,
      id: payload.id || `${payload.symbol}-${payload.timeframe}-${payload.timestamp || Date.now()}`,
    });
    io.emit('signal', compact);
    RECENT_SIGNALS_CACHE.unshift(compact);
    // Dedupe WAIT per symbol+tf — keep newest only
    if (String(compact.action).toUpperCase() === 'WAIT') {
      const key = `${compact.symbol}:${compact.timeframe}`;
      const seen = new Set([key]);
      const filtered = [compact];
      for (const s of RECENT_SIGNALS_CACHE.slice(1)) {
        const k = `${s.symbol}:${s.timeframe}`;
        if (String(s.action).toUpperCase() === 'WAIT' && seen.has(k)) continue;
        if (String(s.action).toUpperCase() === 'WAIT') seen.add(k);
        filtered.push(s);
      }
      RECENT_SIGNALS_CACHE.length = 0;
      RECENT_SIGNALS_CACHE.push(...filtered.slice(0, RECENT_SIGNALS_CACHE_LIMIT));
    } else if (RECENT_SIGNALS_CACHE.length > RECENT_SIGNALS_CACHE_LIMIT) {
      RECENT_SIGNALS_CACHE.length = RECENT_SIGNALS_CACHE_LIMIT;
    }
    // Only persist real FIRE signals to Mongo (WAIT is desk telemetry only)
    if (String(compact.action).toUpperCase() !== 'WAIT') {
      db.saveSignal(payload).catch(err => console.warn('[API] persist signal:', err.message));
    }
  });
  // FIX: this blindly overwrote MARKET_SNAPSHOT_CACHE with whatever
  // market_update arrived last, with zero source-priority resolution —
  // index.js's onMT5Tick/onLivePrice apply hold-timer logic before
  // deciding whether to EMIT an update, but multiple sources (MT5, Deriv,
  // Finnhub, TradingView, StockData...) can all legitimately emit for the
  // same symbol, and once an event reached this handler there was no
  // check for which one should actually win. A lower-priority update
  // landing here a moment after a fresher MT5 tick would silently
  // overwrite it, and /api/market (what the dashboard actually reads)
  // would serve the lower-priority value with no way to know.
  //
  // Also folds in what used to be a separate forward('market_update',
  // 'market', ...) call below — that pushed every RAW update to sockets
  // unconditionally, bypassing this resolution entirely, so the socket
  // path still needed client-side re-ranking even after fixing the REST
  // cache. Now both /api/market and the socket 'market' push serve the
  // exact same backend-resolved value — the frontend can trust either
  // transport directly with no ranking of its own.
  const SRC_RANK = { mt5_ea: 100, tradingview: 92, deriv: 70, finnhub: 60, binance: 58, exchangerate: 48, stockdata: 45, aletheia: 44, candle: 40, fred: 30, treasury: 20, unknown: 0 };
  const PRICE_HOLD_MS = 10000; // higher-rank source blocks a lower-rank one for this long after its last update
  bus.on('market_update', payload => {
    if (!payload?.symbol || payload.price == null) return;
    const price = Number(payload.price);
    if (!Number.isFinite(price)) return;
    const symbolKey = String(payload.symbol).toUpperCase();
    const source = payload.source || 'unknown';
    const rank = SRC_RANK[source] ?? 0;
    const prev = MARKET_SNAPSHOT_CACHE.get(symbolKey);
    if (prev && (SRC_RANK[prev.source] ?? 0) > rank && (Date.now() - (prev.timestamp || 0)) < PRICE_HOLD_MS) {
      return; // a higher-priority source updated recently enough — this one doesn't win yet
    }
    const bid = payload.bid != null ? Number(payload.bid) : null;
    const ask = payload.ask != null ? Number(payload.ask) : null;
    const mid = (Number.isFinite(bid) && Number.isFinite(ask)) ? (bid + ask) / 2 : price;
    const resolved = {
      symbol: symbolKey,
      price: mid,
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      change: payload.change ?? null,
      bias: payload.bias ?? null,
      source,
      timestamp: payload.timestamp || Date.now(),
    };
    MARKET_SNAPSHOT_CACHE.set(symbolKey, resolved);
    io.emit('market', resolved);
    db.saveMarketSnapshot(resolved).catch(err => console.warn('[API] persist market snapshot:', err.message));
  });
  forward('risk_update', 'risk');
  forward('stats_update', 'stats');
  forward('regime_update', 'regime', payload => db.saveTelemetry({ type: 'regime_update', ...payload }));
  forward('hurst_update', 'hurst', payload => db.saveTelemetry({ type: 'hurst_update', ...(payload || {}) }));
  forward('telemetry_update', 'telemetry', db.saveTelemetry);
  // FIX: myfxbook/openinsider events previously only reached Telegram — now relayed to the live dashboard as well (see index.js wsBus.emit('intel', ...)).
  forward('intel', 'intel', payload => db.saveTelemetry({ type: 'intel_' + payload.kind, ...payload }));
  forward('watchlist_update', 'watchlist');
  // Data Integrity Monitor — feed/staleness health, so the dashboard shows a warning banner instead of the trader only finding out a feed died when signals quietly stop arriving.
  forward('feed_health', 'feed_health');
  forward('engine_ready', 'engine_ready');
  // Persist market snapshot cache periodically to disk so cold boots have data
  try {
    const persist = require('../lib/persist');
    setInterval(() => {
      try {
        const rows = [...MARKET_SNAPSHOT_CACHE.values()].slice(0, 200);
        persist.saveMarket(rows);
      } catch (_) {}
    }, 15 * 1000);
  } catch (_) {}
  forward('abnormal_market', 'abnormal_market', payload => db.saveTelemetry({ type: 'abnormal_market', ...payload }));
  forward('crypto_volatility_alert', 'crypto_volatility_alert', payload => db.saveTelemetry({ type: 'crypto_volatility_alert', ...payload }));
  // FIX: BybitFeed emits liquidation_cascade (real risk event — large forced liquidations in a short window) and index.js relays it onto wsBus, but it was never added to this forward() whitelist — it...
  forward('liquidation_cascade', 'liquidation_cascade', payload => db.saveTelemetry({ type: 'liquidation_cascade', ...payload }));
  // FIX: balance_update was emitted (real data — /api/ea/balance receives the MT5 EA's actual account balance/equity/margin) but had no forward() entry, so it silently never reached any connected browser.
  forward('balance_update', 'balance');

  // Bridge engine ticks → REST market cache (socket may be quiet; REST must still work)
  function syncPricesFromEngine() {
    try {
      const live = getEngines();
      const map = live?.lastPriceBySymbol || {};
      for (const [symbol, tick] of Object.entries(map)) {
        if (!tick || !Number.isFinite(tick.price)) continue;
        MARKET_SNAPSHOT_CACHE.set(String(symbol).toUpperCase(), {
          symbol: String(symbol).toUpperCase(),
          price: tick.price,
          bid: tick.bid ?? null,
          ask: tick.ask ?? null,
          change: null,
          bias: null,
          source: tick.source || 'engine',
          timestamp: tick.ts || Date.now(),
        });
      }
    } catch (_) {}
  }
  setInterval(syncPricesFromEngine, 2000);
  setTimeout(syncPricesFromEngine, 500);


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
