import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import {
  LayoutDashboard, Radio, Globe2, Activity, Flame, FlaskConical,
  ScrollText, ShieldAlert, ChevronRight, ChevronDown,
  TrendingUp, CheckCircle2, XCircle,
  Circle, Clock, Zap, Database, Cpu, ArrowUpRight,
  ArrowDownRight, Terminal, Newspaper, Gauge as GaugeIcon,
  Layers, Target, DollarSign,
} from 'lucide-react';

/* ────────────────────────────────────────────────────────────────────────
   OMNICEE // INSTITUTIONAL SIGNAL TERMINAL
   A self-contained live-simulated preview of the OMNICEE trading dashboard.
   Mirrors the real API surface (GET /api/signals, /api/outlook, /api/heatmap,
   /api/audit-trail, /api/health, /api/stats, /api/journal, /api/news) and
   socket.io channels (signal, market, risk, stats, regime, telemetry, intel)
   so it can be wired to the live backend with a data-layer swap only.
   ──────────────────────────────────────────────────────────────────────── */

const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSDT', 'ETHUSDT'];
const TIMEFRAMES = ['M15', 'H1', 'H4', 'D1'];
const AGENTS = ['SMC', 'MTF', 'Momentum', 'VolumeOI', 'Sentiment', 'Pattern', 'Fractal', 'Microstructure'];

const BASE_PRICE = {
  EURUSD: 1.0842, GBPUSD: 1.2694, USDJPY: 156.32,
  XAUUSD: 2418.30, BTCUSDT: 67420.5, ETHUSDT: 3512.8,
};
const DECIMALS = { EURUSD: 4, GBPUSD: 4, USDJPY: 3, XAUUSD: 2, BTCUSDT: 1, ETHUSDT: 2 };
const PIP = { EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01, XAUUSD: 0.1, BTCUSDT: 10, ETHUSDT: 1 };

// FIX: the Agent Breakdown panel renders `{s.agreeCount}/8 aligned`, but
// agreeCount was only ever computed by the demo signal generator further
// down — api/server.js's db.compactSignal() (the shape both /api/signals
// and the 'signal' socket event actually deliver) never included it, so
// every real signal showed "undefined/8 aligned" the moment live data
// started flowing instead of demo data. Applied once, here, to both the
// REST-polled list and each socket-pushed signal, rather than at render
// time, so every consumer of `signals` state sees a consistently-shaped
// object regardless of which transport it arrived by.
function normalizeSignal(s) {
  if (s.agreeCount != null) return s;
  const dir = s.action || s.direction;
  const agreeCount = Array.isArray(s.agents) ? s.agents.filter(a => a.direction === dir).length : 0;
  return { ...s, agreeCount };
}

const FEEDS = [
  { name: 'Binance',      kind: 'crypto ws',  status: 'live' },
  { name: 'Bybit',        kind: 'crypto ws',  status: 'live' },
  { name: 'TwelveData',   kind: 'fx/commod',  status: 'live' },
  { name: 'Finnhub',      kind: 'news',       status: 'live' },
  { name: 'Alpha Vantage',kind: 'macro sent', status: 'degraded' },
  { name: 'FMP',          kind: 'fundamentals',status: 'live' },
  { name: 'CFTC COT',     kind: 'positioning',status: 'live' },
  { name: 'Myfxbook',     kind: 'calendar',   status: 'live' },
  { name: 'OpenInsider',  kind: 'SEC Form 4', status: 'inert', note: 'needs paid Parse.bot key' },
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function fmtPrice(symbol, v) {
  const d = DECIMALS[symbol] ?? 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(v, digits = 2) { return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`; }
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
function gradeFor(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 75) return 'B+';
  if (score >= 65) return 'B';
  return 'C';
}

/* Diverging color for heatmaps: v in [-1,1] -> coral..slate..emerald */
function heatColor(v) {
  const t = clamp(v, -1, 1);
  if (t >= 0) {
    const g = Math.round(20 + t * 100);
    return `rgba(31,227,168,${0.12 + t * 0.55})`;
  }
  const a = Math.abs(t);
  return `rgba(255,84,112,${0.12 + a * 0.55})`;
}

/* ── Theme: single embedded stylesheet, CSS custom properties carry the
   exact brand palette (Tailwind's default palette doesn't have it), while
   layout/spacing throughout the component tree uses plain Tailwind utilities. */
function ThemeStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&family=Orbitron:wght@600;800&display=swap');
      .omni-root {
        --void: #05070a; --panel: #0b0f14; --panel2: #10151c;
        --border: #1c232d; --borderBright: #2a3340;
        --emerald: #1fe3a8; --emeraldDim: #0f7a58;
        --gold: #f0b429; --coral: #ff5470; --blue: #5ea8ff;
        --cyan: #22d3ee; --violet: #a78bfa;
        --text: #eef2f7; --textDim: #8b9bb0; --textFaint: #526078;
        background: var(--void); color: var(--text);
        font-family: 'Inter', system-ui, sans-serif;
      }
      .omni-root .font-display { font-family: 'Orbitron', sans-serif; }
      .omni-root .font-mono { font-family: 'JetBrains Mono', monospace; }
      .omni-panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
      .omni-panel2 { background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; }
      .omni-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
      .omni-scroll::-webkit-scrollbar-thumb { background: var(--borderBright); border-radius: 3px; }
      .omni-scroll::-webkit-scrollbar-track { background: transparent; }
      @keyframes omni-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      .omni-marquee { animation: omni-marquee 38s linear infinite; }
      .omni-marquee:hover { animation-play-state: paused; }
      @keyframes omni-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      .omni-pulse { animation: omni-pulse 1.8s ease-in-out infinite; }
      @keyframes omni-flash-up { 0% { background: rgba(31,227,168,0.35); } 100% { background: transparent; } }
      @keyframes omni-flash-down { 0% { background: rgba(255,84,112,0.35); } 100% { background: transparent; } }
      .omni-flash-up { animation: omni-flash-up 0.7s ease-out; }
      .omni-flash-down { animation: omni-flash-down 0.7s ease-out; }
      .omni-tab-active { box-shadow: inset 3px 0 0 var(--emerald); background: var(--panel2); }
      .omni-cmd::placeholder { color: var(--textFaint); }
      .omni-row:hover { background: rgba(255,255,255,0.02); }
    `}</style>
  );
}

/* ── Small shared atoms ─────────────────────────────────────────────── */
function Pill({ children, tone = 'neutral' }) {
  const map = {
    neutral: { color: 'var(--textDim)', bg: 'rgba(139,155,176,0.12)' },
    up: { color: 'var(--emerald)', bg: 'rgba(31,227,168,0.12)' },
    down: { color: 'var(--coral)', bg: 'rgba(255,84,112,0.12)' },
    warn: { color: 'var(--gold)', bg: 'rgba(240,180,41,0.12)' },
    info: { color: 'var(--blue)', bg: 'rgba(94,168,255,0.12)' },
  };
  const s = map[tone] || map.neutral;
  return (
    <span className="font-mono text-[10px] px-2 py-0.5 rounded uppercase tracking-wider"
      style={{ color: s.color, background: s.bg }}>
      {children}
    </span>
  );
}

function SectionHeader({ icon: Icon, title, sub }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={15} style={{ color: 'var(--gold)' }} />
      <h2 className="font-display text-[13px] tracking-widest uppercase" style={{ color: 'var(--text)' }}>{title}</h2>
      {sub && <span className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>{sub}</span>}
    </div>
  );
}

function StatCard({ label, value, delta, icon: Icon, accent = 'var(--emerald)' }) {
  return (
    <div className="omni-panel p-3 flex-1 min-w-[130px]">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--textFaint)' }}>{label}</span>
        {Icon && <Icon size={13} style={{ color: accent }} />}
      </div>
      <div className="font-mono text-xl font-semibold" style={{ color: 'var(--text)' }}>{value}</div>
      {delta != null && (
        <div className="font-mono text-[11px] mt-1" style={{ color: delta >= 0 ? 'var(--emerald)' : 'var(--coral)' }}>
          {fmtPct(delta)}
        </div>
      )}
    </div>
  );
}

/* Semi-circular arc gauge, 0..100, colored by threshold zones */
function Gauge({ value, label, zones = [[0, 40, '#ff5470'], [40, 70, '#f0b429'], [70, 101, '#1fe3a8']] }) {
  const v = clamp(value, 0, 100);
  const r = 46, cx = 60, cy = 58;
  const angleFor = (pct) => Math.PI - (pct / 100) * Math.PI;
  const point = (pct) => {
    const a = angleFor(pct);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const [nx, ny] = point(v);
  const color = (zones.find(z => v >= z[0] && v < z[1]) || zones[zones.length - 1])[2];
  return (
    <div className="flex flex-col items-center">
      <svg width="120" height="70" viewBox="0 0 120 70">
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="var(--border)" strokeWidth="8" strokeLinecap="round" />
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${nx} ${ny}`} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="3" fill={color} />
      </svg>
      <div className="font-mono text-lg font-bold -mt-3" style={{ color }}>{v.toFixed(0)}</div>
      <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: 'var(--textFaint)' }}>{label}</div>
    </div>
  );
}

/* ── Mock signal generator — mirrors the real compactSignal() shape from
   the OMNICEE backend (id/symbol/timeframe/action/score/entry/stopLoss/
   targets/regime/gate/risk/agents/reasons). ────────────────────────────── */
let _sigSeq = 1000;
function generateSignal(symbol, price) {
  const dir = pick(['BUY', 'SELL']);
  const score = Math.round(rand(58, 97));
  const pip = PIP[symbol];
  const entry = price;
  const stopLoss = dir === 'BUY' ? entry - pip * rand(8, 22) : entry + pip * rand(8, 22);
  const risk = Math.abs(entry - stopLoss);
  const targets = dir === 'BUY'
    ? [entry + risk * 1.5, entry + risk * 2.6]
    : [entry - risk * 1.5, entry - risk * 2.6];
  const agents = AGENTS.map(a => {
    const bullish = Math.random() > 0.35;
    const conf = Math.round(rand(45, 96));
    return { agent: a, score: conf, direction: (Math.random() > 0.22 ? dir : (dir === 'BUY' ? 'SELL' : 'BUY')), status: conf > 60 ? 'active' : 'weak' };
  });
  const agreeCount = agents.filter(a => a.direction === dir).length;
  const gateChecklist = {
    trap: Math.random() > 0.12,
    compression: Math.random() > 0.15,
    abnormalMarket: Math.random() > 0.08,
    regimeFit: Math.random() > 0.2,
    strategyFit: Math.random() > 0.18,
  };
  const failures = Object.entries(gateChecklist).filter(([, ok]) => !ok).map(([k]) => k);
  const status = score >= 75 && failures.length === 0 ? 'approved' : (failures.length > 1 ? 'rejected' : 'gated');
  const mcWinProb = +rand(45, 88).toFixed(1);
  const bayesPosterior = +rand(0.38, 0.87).toFixed(2);
  const statPassed = Math.round(rand(4, 10));
  const wfe = +rand(0.25, 0.92).toFixed(2);
  const validation = {
    monteCarlo: { approved: mcWinProb >= 55, winProbability: mcWinProb, expectedR: +rand(-0.3, 1.9).toFixed(2), simulations: 5000 },
    bayesian: { approved: bayesPosterior >= 0.52, posterior: bayesPosterior },
    statistical: { approved: statPassed >= 6, passed: statPassed, total: 10 },
    walkForward: { sufficient: Math.random() > 0.3, wfe, robust: wfe >= 0.5 },
  };
  const reasons = [
    `${agreeCount}/8 agents aligned ${dir}`,
    `Regime: ${pick(['trending', 'ranging', 'transitional'])} structure on ${pick(TIMEFRAMES)}`,
    failures.length ? `Flagged: ${failures.join(', ')}` : 'All institutional gates cleared',
    `Volatility ${pick(['compressed', 'expanding', 'normal'])}, tradeability ${pick(['high', 'medium', 'low'])}`,
  ];
  return {
    id: `sig_${_sigSeq++}`,
    symbol, timeframe: pick(TIMEFRAMES), action: dir,
    timestamp: Date.now(), currentPrice: price,
    score, entry, stopLoss, targets,
    regime: {
      regime: pick(['trend-up', 'trend-down', 'range', 'transition']),
      trend: pick(['bullish', 'bearish', 'neutral']),
      structure: pick(['HH-HL', 'LH-LL', 'consolidation']),
      volatility: pick(['low', 'normal', 'elevated']),
      tradeability: pick(['high', 'medium', 'low']),
      confidence: Math.round(rand(55, 95)),
    },
    gate: { status, confidence: Math.round(rand(50, 95)), failures, warnings: [], checklist: gateChecklist },
    risk: { approved: status === 'approved', effectiveRisk: +rand(0.5, 1.0).toFixed(2), maxLoss: Math.round(rand(40, 120)), note: status === 'approved' ? 'within daily loss budget' : 'held back by gate' },
    validation,
    agents, reasons, agreeCount,
  };
}

function generateAuditEntry(symbol) {
  const fired = Math.random() > 0.55;
  const reasons = fired
    ? ['score above threshold', 'gates cleared', 'regime fit confirmed']
    : pick([['score below 75 threshold'], ['compression detected — held'], ['regime mismatch for strategy'], ['abnormal market — spread spike'], ['trap pattern suspected']]);
  return { id: `aud_${Math.random().toString(36).slice(2, 9)}`, symbol, timeframe: pick(TIMEFRAMES), fired, reasons, timestamp: Date.now() };
}

const NEWS_SEED = [
  'Fed officials signal patience on next rate move',
  'Gold holds near highs as real yields soften',
  'BTC funding rates cool after weekend liquidation cascade',
  'ECB commentary keeps EUR crosses rangebound',
  'DXY steadies as traders await CPI print',
  'CFTC data shows large specs trimming USD longs',
  'Risk sentiment firms on softer inflation expectations',
  'Asia session liquidity thin ahead of London open',
];

/* ── Live-data seam ─────────────────────────────────────────────────────
   Point API_BASE at a deployed OMNICEE backend (e.g. your Render URL) and
   APP_TOKEN at its APP_ACCESS_TOKEN to pull real data — CORS_ORIGIN
   defaults to '*' server-side (api/server.js), so a same-origin blank
   API_BASE or a cross-origin absolute URL both work. Left as-is, requests
   go nowhere, the one-time /health probe below fails, and the UI falls
   back to a clearly-labeled on-screen simulation instead of a blank page.
   This uses plain fetch()/polling rather than socket.io-client so the
   exact same file works unmodified in this sandboxed preview (which can't
   load unlisted npm packages) and in the real Vite build; src/lib/api.js
   in the companion project adds true real-time push via socket.io-client
   on top of this once you're running it for real. */
const API_BASE = '';
const APP_TOKEN = '';

// FIX: api/telegram-auth.js's telegramAuthMiddleware checks for an
// `x-telegram-init-data` header (or `initData` on sockets) and, in
// production, 401s every /api/* route without it or a valid x-app-token —
// but nothing in this file ever read window.Telegram.WebApp.initData or
// sent it anywhere. Opened for real as a Telegram Mini App (this project's
// actual primary frontend — see README), every authenticated call would
// have silently 401'd forever, "live" mode notwithstanding. Safe to call
// outside Telegram too: window.Telegram is simply undefined there.
function getTelegramInitData() {
  try { return window.Telegram?.WebApp?.initData || ''; } catch (_) { return ''; }
}

function authHeaders() {
  const h = {};
  if (APP_TOKEN) h['x-app-token'] = APP_TOKEN;
  const initData = getTelegramInitData();
  if (initData) h['x-telegram-init-data'] = initData;
  return h;
}

async function omniFetch(path, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      headers: authHeaders(),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Live-feed hook — probes the real API once; on success it polls the
   documented REST routes, on failure it falls back to the original
   self-contained simulator so the dashboard is never just a blank
   loading screen. ──────────────────────────────────────────────────── */
function useLiveFeed() {
  const [mode, setMode] = useState('checking'); // 'checking' | 'live' | 'demo'
  const [now, setNow] = useState(Date.now());
  const [prices, setPrices] = useState(() => ({ ...BASE_PRICE }));
  const [changes, setChanges] = useState(() => Object.fromEntries(SYMBOLS.map(s => [s, 0])));
  const [flash, setFlash] = useState({});
  const [signals, setSignals] = useState(() => {
    const seed = [];
    for (let i = 0; i < 14; i++) seed.push(generateSignal(pick(SYMBOLS), BASE_PRICE[pick(SYMBOLS)]));
    return seed.sort((a, b) => b.timestamp - a.timestamp);
  });
  const [auditLog, setAuditLog] = useState(() => {
    const seed = [];
    for (let i = 0; i < 18; i++) seed.push(generateAuditEntry(pick(SYMBOLS)));
    return seed;
  });
  const [equityCurve, setEquityCurve] = useState(() => {
    let eq = 10000;
    const pts = [];
    for (let i = 60; i >= 0; i--) {
      eq += rand(-60, 90);
      pts.push({ t: i, equity: Math.round(eq) });
    }
    return pts;
  });
  const [stats, setStats] = useState(null);
  const [outlook, setOutlook] = useState(null);
  const [heatmapTiles, setHeatmapTiles] = useState(null);
  const [feedHealth, setFeedHealth] = useState(null);
  const [uptimeSec, setUptimeSec] = useState(null);
  // FIX (Known gap #3 in webapp-react/README.md): "DASH/RISK account-
  // balance figures aren't yet pulled from /api/stats's accountBalance
  // field — still the demo-seeded number." null until a real EA-reported
  // balance (POST /api/ea/balance) arrives via poll or the 'balance' socket
  // channel; DashTab/RiskTab fall back to the demo default while it's null.
  const [accountBalance, setAccountBalance] = useState(null);
  const [equityCurveLive, setEquityCurveLive] = useState(false);
  // FIX (Known gap #1): "Prices tick from signals, not a true feed." True,
  // whenever the socket below actually connects — this just tracks that so
  // the UI can show whether it's on tick-by-tick push or 5s-poll fallback.
  const [socketLive, setSocketLive] = useState(false);
  const [news, setNews] = useState(null);
  const [journalStats, setJournalStats] = useState(null);
  const [learningProfiles, setLearningProfiles] = useState(null);
  const [relativeStrength, setRelativeStrength] = useState(null);
  const priceRef = useRef(prices);
  priceRef.current = prices;

  /* Reachability probe against the unauthenticated /health route. Render's
     free tier can take 30-60s+ to wake a cold instance, so a single
     2.5s-timeout attempt was permanently latching mode='demo' for the rest
     of the session even when the backend was fine — just asleep. Now: show
     demo immediately (never a blank/stuck "Connecting" screen) but keep
     retrying every 4s in the background, and flip to live the instant the
     backend answers — no manual refresh required. */
  const [wakingBackend, setWakingBackend] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const tryProbe = () => {
      omniFetch('/health', 4000)
        .then(() => { if (!cancelled) { setMode('live'); setWakingBackend(false); } })
        .catch(() => {
          if (cancelled) return;
          setMode(m => (m === 'live' ? m : 'demo'));
          setWakingBackend(true);
          timer = setTimeout(tryProbe, 4000);
        });
    };
    tryProbe();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  /* Clock runs regardless of mode. */
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  /* Telegram Mini App shell init + PWA service-worker registration — both
     ran unconditionally in the retired webapp/index.html (see its final
     <script> block) but had no equivalent here. tg.ready()/tg.expand() are
     no-ops (window.Telegram undefined) when this loads in a plain browser,
     so this is safe outside Telegram too. */
  useEffect(() => {
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg) { tg.ready(); tg.expand(); }
    } catch (_) { /* not inside Telegram, or SDK not loaded yet — fine */ }
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  /* Demo simulation — unchanged behaviour from the original preview,
     just gated so it only runs once the live probe has failed. */
  useEffect(() => {
    if (mode !== 'demo') return;
    const tick = setInterval(() => {
      setPrices(prev => {
        const next = { ...prev };
        const flashNext = {};
        SYMBOLS.forEach(sym => {
          const drift = prev[sym] * rand(-0.0006, 0.0006);
          next[sym] = +(prev[sym] + drift).toFixed(DECIMALS[sym] + 1);
          flashNext[sym] = drift >= 0 ? 'up' : 'down';
        });
        setFlash(flashNext);
        setChanges(c => {
          const nc = { ...c };
          SYMBOLS.forEach(sym => { nc[sym] = ((next[sym] - BASE_PRICE[sym]) / BASE_PRICE[sym]) * 100; });
          return nc;
        });
        return next;
      });
    }, 1600);
    const signalTimer = setInterval(() => {
      const sym = pick(SYMBOLS);
      setSignals(prev => [generateSignal(sym, priceRef.current[sym]), ...prev].slice(0, 40));
    }, 9000);
    const auditTimer = setInterval(() => {
      setAuditLog(prev => [generateAuditEntry(pick(SYMBOLS)), ...prev].slice(0, 30));
    }, 3500);
    const eqTimer = setInterval(() => {
      setEquityCurve(prev => {
        const last = prev[prev.length - 1]?.equity ?? 10000;
        const next = Math.round(last + rand(-60, 90));
        return [...prev.slice(1), { t: prev[prev.length - 1].t + 1, equity: next }];
      });
    }, 4000);
    return () => { clearInterval(tick); clearInterval(signalTimer); clearInterval(auditTimer); clearInterval(eqTimer); };
  }, [mode]);

  /* Live polling — real backend. Fast loop covers signals/stats (the
     things worth refreshing every few seconds); slow loop covers
     outlook/heatmap/audit-trail/feed-health (heavier, computed routes
     that 503 until the trading engine finishes booting, so failures here
     are expected right after a cold start and just retry next tick). */
  useEffect(() => {
    if (mode !== 'live') return;
    let cancelled = false;

    const pullFast = async () => {
      try {
        const r = await omniFetch(`/api/signals?limit=40`);
        if (!cancelled && r.ok) {
          setSignals(r.signals.map(normalizeSignal));
          setPrices(prev => {
            const next = { ...prev };
            r.signals.forEach(s => { if (s.symbol && s.currentPrice) next[s.symbol] = s.currentPrice; });
            return next;
          });
        }
      } catch (_) { /* keep last-known signals on a transient failure */ }
      try {
        const r = await omniFetch('/api/stats');
        if (!cancelled && r.ok) {
          setStats(r.stats);
          // FIX (Known gap #3): real balance, once an MT5 EA has reported
          // one via POST /api/ea/balance. Stays null (→ demo fallback in
          // DashTab/RiskTab) until then, e.g. before any EA is connected.
          if (r.accountBalance != null) setAccountBalance(Number(r.accountBalance));
        }
      } catch (_) { /* stats optional */ }
    };
    const pullSlow = async () => {
      try { const r = await omniFetch('/api/outlook'); if (!cancelled && r.ok) setOutlook(r.outlook); } catch (_) {}
      try { const r = await omniFetch('/api/heatmap'); if (!cancelled && r.ok) setHeatmapTiles(r.tiles); } catch (_) {}
      try { const r = await omniFetch('/api/audit-trail?limit=30'); if (!cancelled && r.ok) setAuditLog(r.entries); } catch (_) {}
      try { const r = await omniFetch('/api/health'); if (!cancelled && r.ok) setFeedHealth(r.feeds); } catch (_) {}
      try { const r = await omniFetch('/health'); if (!cancelled && r.ok) setUptimeSec(r.uptime); } catch (_) {}
      // FIX (Known gap #2): "Equity curve stays illustrative even in live
      // mode ... worth adding a db.getEquityCurve() + route." Realized-trade
      // curve, ~20s refresh (same cadence as the other heavier routes here)
      // — a brand-new deployment with zero closed trades yet returns an
      // empty curve, so keep the demo-seeded one on screen until real
      // points exist rather than blanking the chart.
      try {
        const r = await omniFetch('/api/equity-curve?limit=300');
        if (!cancelled && r.ok && Array.isArray(r.curve) && r.curve.length > 1) {
          setEquityCurve(r.curve.map((pt, i) => ({ t: i, equity: pt.balance, timestamp: pt.timestamp, symbol: pt.symbol, result: pt.result })));
          setEquityCurveLive(true);
        }
      } catch (_) {}
      try { const r = await omniFetch('/api/news'); if (!cancelled && r.ok) setNews(Array.isArray(r.news) ? r.news : []); } catch (_) {}
      try { const r = await omniFetch('/api/journal'); if (!cancelled && r.ok) setJournalStats(r.stats); } catch (_) {}
      try { const r = await omniFetch('/api/learning?limit=20'); if (!cancelled && r.ok) setLearningProfiles(r.profiles); } catch (_) {}
      try { const r = await omniFetch('/api/watchlist'); if (!cancelled && r.ok) setRelativeStrength(r.relativeStrength); } catch (_) {}
    };

    pullFast(); pullSlow();
    const fastTimer = setInterval(pullFast, 5000);
    const slowTimer = setInterval(pullSlow, 20000);
    return () => { cancelled = true; clearInterval(fastTimer); clearInterval(slowTimer); };
  }, [mode]);

  /* FIX (Known gap #1): "Prices tick from signals, not a true feed ...
     connectOmniceeSocket()'s market handler is the fix if you switch to
     sockets." index.js emits market_update (→ io.emit('market', ...), see
     api/server.js's forward('market_update', 'market', ...)) on every raw
     price tick, throttled to ~1/sec/symbol — a real feed, unlike the REST
     poll above which only moves a price when a fresh signal references it.
     Dynamically imported rather than a static top-level `import { io } from
     'socket.io-client'` — this file is also used as a standalone preview
     outside the real Vite build (see the comment on API_BASE above, and
     webapp-react/README.md), where that package isn't resolvable. A failed
     dynamic import is caught and simply leaves the REST-polling price
     updates above as the only source, so this only adds capability and
     never breaks the existing fallback chain (probe → live/demo, and now
     within live: socket → poll). */
  useEffect(() => {
    if (mode !== 'live') return;
    let socket = null;
    let cancelled = false;

    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      socket = io(API_BASE || undefined, {
        path: '/socket.io',
        auth: { appToken: APP_TOKEN || undefined, initData: getTelegramInitData() || undefined },
        transports: ['websocket', 'polling'],
      });

      socket.on('connect', () => { if (!cancelled) setSocketLive(true); });
      socket.on('disconnect', () => { if (!cancelled) setSocketLive(false); });

      socket.on('market', payload => {
        if (cancelled || !payload?.symbol || payload.price == null || !(payload.symbol in BASE_PRICE)) return;
        const sym = payload.symbol;
        const prevPrice = priceRef.current[sym];
        setFlash(f => ({ ...f, [sym]: payload.price >= prevPrice ? 'up' : 'down' }));
        setPrices(prev => ({ ...prev, [sym]: payload.price }));
        if (payload.change != null) {
          setChanges(c => ({ ...c, [sym]: payload.change }));
        } else {
          // Fallback only if the backend ever omits it — real % change vs a
          // frozen 2024 demo constant is nonsense, so anchor to the last
          // known live price instead of BASE_PRICE.
          setChanges(c => ({ ...c, [sym]: prevPrice ? ((payload.price - prevPrice) / prevPrice) * 100 : (c[sym] ?? 0) }));
        }
      });

      // FIX: the actual point of "connect the agents/pipeline to the
      // frontend live data" — new signals previously only reached the UI
      // via the 5s /api/signals poll above. index.js's agents already emit
      // a 'signal' event on the shared bus the instant one fires; this
      // just subscribes to it, so a signal appears on screen within
      // milliseconds of the pipeline generating it, not up to 5s later.
      // dedupe by id since the next poll will also pick this signal up
      // once Mongo (or the server's memory cache) has it.
      socket.on('signal', payload => {
        if (cancelled || !payload?.id) return;
        setSignals(prev => prev.some(s => s.id === payload.id) ? prev : [normalizeSignal(payload), ...prev].slice(0, 200));
      });

      // Complements the /api/stats poll above with push updates the
      // instant a new EA balance report lands, instead of waiting up to 5s.
      socket.on('balance', payload => {
        if (!cancelled && payload?.balance != null) setAccountBalance(Number(payload.balance));
      });
    }).catch(() => {
      /* socket.io-client not resolvable in this environment — REST polling
         above already covers prices/stats, so the dashboard runs slightly
         less real-time, not broken. */
    });

    return () => {
      cancelled = true;
      if (socket) socket.disconnect();
      setSocketLive(false);
    };
  }, [mode]);

  return {
    now, prices, changes, flash, signals, auditLog, equityCurve, equityCurveLive,
    stats, outlook, heatmapTiles, feedHealth, uptimeSec, accountBalance, socketLive,
    news, journalStats, learningProfiles, relativeStrength,
    mode, connected: mode === 'live', wakingBackend,
  };
}

/* ── Navigation model ───────────────────────────────────────────────── */
const TABS = [
  { key: 'DASH', label: 'Dashboard', fkey: 'F1', icon: LayoutDashboard },
  { key: 'SIGNALS', label: 'Signals', fkey: 'F2', icon: Radio },
  { key: 'INTEL', label: 'Intel', fkey: 'F3', icon: Globe2 },
  { key: 'NEWS', label: 'News', fkey: 'F4', icon: Newspaper },
  { key: 'MONITOR', label: 'Monitor', fkey: 'F5', icon: Activity },
  { key: 'HEAT', label: 'Heat', fkey: 'F6', icon: Flame },
  { key: 'VALID', label: 'Valid', fkey: 'F7', icon: FlaskConical },
  { key: 'TAPE', label: 'Tape', fkey: 'F8', icon: ScrollText },
  { key: 'RISK', label: 'Risk', fkey: 'F9', icon: ShieldAlert },
];

function TopBar({ now, mode, socketLive, wakingBackend, onCommand }) {
  const [cmd, setCmd] = useState('');
  const time = new Date(now).toISOString().slice(11, 19);
  const date = new Date(now).toISOString().slice(0, 10);
  const status = {
    checking: { label: 'Connecting', color: 'var(--gold)', pulse: true },
    live: { label: 'Live', color: 'var(--emerald)', pulse: true },
    demo: wakingBackend
      ? { label: 'Demo · Waking Backend', color: 'var(--gold)', pulse: true }
      : { label: 'Demo Data', color: 'var(--textDim)', pulse: false },
  }[mode] || { label: 'Offline', color: 'var(--coral)', pulse: false };
  return (
    <div className="flex items-center gap-4 px-4 py-2.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded flex items-center justify-center font-display text-[11px] font-bold"
          style={{ background: 'var(--emerald)', color: '#05070a' }}>Ω</div>
        <span className="font-display text-sm tracking-[0.15em]" style={{ color: 'var(--text)' }}>OMNICEE</span>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-widest hidden sm:inline" style={{ color: 'var(--textFaint)' }}>
        Institutional Signal Terminal
      </span>
      <div className="flex-1 flex items-center gap-2 max-w-md">
        <Terminal size={13} style={{ color: 'var(--gold)' }} />
        <input
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && cmd.trim()) { onCommand(cmd.trim()); setCmd(''); } }}
          placeholder="TAB OR SYMBOL, THEN ⏎"
          className="omni-cmd font-mono text-[11px] w-full bg-transparent outline-none tracking-wider uppercase"
          style={{ color: 'var(--gold)', borderBottom: '1px solid var(--border)' }}
        />
      </div>
      <div className="flex items-center gap-3 ml-auto">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase" style={{ color: status.color }}>
          <Circle size={7} fill="currentColor" className={status.pulse ? 'omni-pulse' : ''} />
          {status.label}
        </span>
        {mode === 'live' && (
          <span
            className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded hidden sm:inline"
            style={{ color: socketLive ? 'var(--emerald)' : 'var(--textFaint)', border: `1px solid ${socketLive ? 'var(--emerald)' : 'var(--border)'}` }}
            title={socketLive ? 'Tick-by-tick prices over Socket.IO' : 'Falling back to 5s REST polling'}
          >
            {socketLive ? 'push' : 'poll'}
          </span>
        )}
        <span className="font-mono text-[11px] hidden md:inline" style={{ color: 'var(--textDim)' }}>{date}</span>
        <span className="font-mono text-[12px] font-semibold" style={{ color: 'var(--text)' }}>{time} UTC</span>
      </div>
    </div>
  );
}

function TickerTape({ prices, changes, flash }) {
  const row = SYMBOLS.map(sym => (
    <span key={sym} className={`inline-flex items-center gap-1.5 px-4 font-mono text-[11px] ${flash[sym] === 'up' ? 'omni-flash-up' : flash[sym] === 'down' ? 'omni-flash-down' : ''}`}>
      <span style={{ color: 'var(--textDim)' }}>{sym}</span>
      <span style={{ color: 'var(--text)' }}>{fmtPrice(sym, prices[sym])}</span>
      <span style={{ color: (changes[sym] ?? 0) >= 0 ? 'var(--emerald)' : 'var(--coral)' }}>{fmtPct(changes[sym] ?? 0)}</span>
    </span>
  ));
  return (
    <div className="overflow-hidden border-b py-1.5" style={{ borderColor: 'var(--border)', background: '#080a0d' }}>
      <div className="flex omni-marquee whitespace-nowrap w-max">
        <div className="flex">{row}</div>
        <div className="flex">{row}</div>
      </div>
    </div>
  );
}

function NavBar({ active, onSelect }) {
  return (
    <div className="flex border-t shrink-0 overflow-x-auto omni-scroll" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      {TABS.map(t => (
        <button
          key={t.key}
          onClick={() => onSelect(t.key)}
          className="flex-1 min-w-[52px] flex flex-col items-center gap-0.5 py-2 transition-colors"
          style={{
            color: active === t.key ? 'var(--emerald)' : 'var(--textDim)',
            background: active === t.key ? 'var(--panel2)' : 'transparent',
            borderTop: active === t.key ? '2px solid var(--emerald)' : '2px solid transparent',
          }}
        >
          <t.icon size={16} />
          <span className="font-mono text-[8px] uppercase tracking-wider">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ── DASH ───────────────────────────────────────────────────────────── */
function DashTab({ signals, equityCurve, equityCurveLive, accountBalance, prices, changes, mode }) {
  const approved = signals.filter(s => s.gate.status === 'approved');
  const winRate = 61 + Math.round((signals.reduce((a, s) => a + (s.score > 75 ? 1 : -1), 0)) % 8);
  const avgScore = signals.length ? Math.round(signals.reduce((a, s) => a + s.score, 0) / signals.length) : 0;
  const consensus = AGENTS.map(agent => {
    const votes = signals.slice(0, 12).flatMap(s => s.agents.filter(a => a.agent === agent));
    const bull = votes.filter(v => v.direction === 'BUY').length;
    const total = votes.length || 1;
    return { agent, bullPct: Math.round((bull / total) * 100) };
  });
  // FIX (Known gap #3): prefer the real EA-reported balance over the
  // equity curve's last point, which is itself now real once trades have
  // closed (Known gap #2) but stays at the demo-seeded 10000 before that.
  const displayBalance = accountBalance ?? equityCurve[equityCurve.length - 1]?.equity ?? 10000;
  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap gap-3">
        <StatCard label="Active Signals" value={approved.length} icon={Radio} />
        <StatCard label="Win Rate (30d)" value={`${winRate}%`} icon={Target} accent="var(--gold)" />
        <StatCard label="Avg Score" value={avgScore} icon={GaugeIcon} accent="var(--blue)" />
        <StatCard label="Signals Today" value={signals.length} icon={Zap} accent="var(--violet)" />
        <StatCard label="Account Bal." value={`$${displayBalance.toLocaleString()}`} icon={DollarSign} accent="var(--emerald)" />
        <StatCard label="Max DD Limit" value="10.0%" icon={ShieldAlert} accent="var(--coral)" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="omni-panel p-4 lg:col-span-2">
          <SectionHeader icon={LayoutDashboard} title="Equity Curve" sub={equityCurveLive ? 'live · realized trades' : mode === 'live' ? 'live · awaiting closed trades' : 'simulated · 60-cycle window'} />
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={equityCurve}>
              <defs>
                <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#1fe3a8" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#1fe3a8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1c232d" vertical={false} />
              <XAxis dataKey="t" hide />
              <YAxis domain={['dataMin - 100', 'dataMax + 100']} tick={{ fill: '#526078', fontSize: 10 }} width={50} />
              <Tooltip contentStyle={{ background: '#10151c', border: '1px solid #1c232d', borderRadius: 8, fontSize: 11 }} labelFormatter={() => ''} />
              <Area type="monotone" dataKey="equity" stroke="#1fe3a8" fill="url(#eqGrad)" strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="omni-panel p-4">
          <SectionHeader icon={Layers} title="Agent Consensus" sub="last 12 signals" />
          <div className="space-y-2.5">
            {consensus.map(c => (
              <div key={c.agent}>
                <div className="flex justify-between font-mono text-[10px] mb-1" style={{ color: 'var(--textDim)' }}>
                  <span>{c.agent}</span><span>{c.bullPct}% bull</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                  <div className="h-full rounded-full" style={{ width: `${c.bullPct}%`, background: c.bullPct >= 50 ? 'var(--emerald)' : 'var(--coral)' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={Radio} title="Recent Signal Feed" />
        <div className="space-y-1 max-h-64 overflow-y-auto omni-scroll">
          {signals.slice(0, 8).map(s => (
            <div key={s.id} className="omni-row flex items-center gap-3 px-2 py-1.5 rounded font-mono text-[11px]">
              <span style={{ color: 'var(--textFaint)' }} className="w-10">{timeAgo(s.timestamp)}</span>
              <span style={{ color: 'var(--text)' }} className="w-16">{s.symbol}</span>
              <span className="w-10" style={{ color: s.action === 'BUY' ? 'var(--emerald)' : 'var(--coral)' }}>{s.action}</span>
              <span className="w-10" style={{ color: 'var(--gold)' }}>{gradeFor(s.score)}</span>
              <span className="flex-1" style={{ color: 'var(--textDim)' }}>{s.regime.regime}</span>
              <Pill tone={s.gate.status === 'approved' ? 'up' : s.gate.status === 'gated' ? 'warn' : 'down'}>{s.gate.status}</Pill>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── SIGNALS ────────────────────────────────────────────────────────── */
function SignalsTab({ signals }) {
  const [expanded, setExpanded] = useState(null);
  const [symFilter, setSymFilter] = useState('ALL');
  const filtered = symFilter === 'ALL' ? signals : signals.filter(s => s.symbol === symFilter);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <SectionHeader icon={Radio} title="Live Signals" sub={`${filtered.length} shown`} />
        <div className="ml-auto flex gap-1 flex-wrap">
          {['ALL', ...SYMBOLS].map(s => (
            <button key={s} onClick={() => setSymFilter(s)}
              className="font-mono text-[10px] px-2 py-1 rounded uppercase"
              style={{ background: symFilter === s ? 'var(--emerald)' : 'var(--panel2)', color: symFilter === s ? '#05070a' : 'var(--textDim)' }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="omni-panel overflow-hidden">
        <div className="grid grid-cols-[70px_46px_44px_44px_1fr_1fr_1fr_70px_50px] gap-2 px-3 py-2 font-mono text-[9px] uppercase tracking-wider border-b" style={{ color: 'var(--textFaint)', borderColor: 'var(--border)' }}>
          <span>Symbol</span><span>TF</span><span>Dir</span><span>Grade</span><span>Entry</span><span>Stop</span><span>Targets</span><span>Gate</span><span>Age</span>
        </div>
        <div className="max-h-[520px] overflow-y-auto omni-scroll">
          {filtered.map(s => (
            <div key={s.id}>
              <div onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                className="omni-row grid grid-cols-[70px_46px_44px_44px_1fr_1fr_1fr_70px_50px] gap-2 px-3 py-2 font-mono text-[11px] cursor-pointer border-b items-center"
                style={{ borderColor: 'var(--border)' }}>
                <span style={{ color: 'var(--text)' }}>{s.symbol}</span>
                <span style={{ color: 'var(--textDim)' }}>{s.timeframe}</span>
                <span style={{ color: s.action === 'BUY' ? 'var(--emerald)' : 'var(--coral)' }}>{s.action}</span>
                <span style={{ color: 'var(--gold)' }}>{gradeFor(s.score)}</span>
                <span style={{ color: 'var(--textDim)' }}>{fmtPrice(s.symbol, s.entry)}</span>
                <span style={{ color: 'var(--coral)' }}>{fmtPrice(s.symbol, s.stopLoss)}</span>
                <span style={{ color: 'var(--emerald)' }}>{fmtPrice(s.symbol, s.targets[0])} / {fmtPrice(s.symbol, s.targets[1])}</span>
                <Pill tone={s.gate.status === 'approved' ? 'up' : s.gate.status === 'gated' ? 'warn' : 'down'}>{s.gate.status}</Pill>
                <span className="flex items-center gap-1" style={{ color: 'var(--textFaint)' }}>
                  {timeAgo(s.timestamp)}<ChevronDown size={11} style={{ transform: expanded === s.id ? 'rotate(180deg)' : 'none' }} />
                </span>
              </div>
              {expanded === s.id && (
                <div className="px-4 py-3 border-b grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4" style={{ borderColor: 'var(--border)', background: '#080a0d' }}>
                  <div>
                    <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>Agent Breakdown ({s.agreeCount}/8 aligned)</div>
                    <div className="space-y-1">
                      {s.agents.map(a => (
                        <div key={a.agent} className="flex items-center gap-2 font-mono text-[10px]">
                          <span className="w-24" style={{ color: 'var(--textDim)' }}>{a.agent}</span>
                          <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                            <div className="h-full" style={{ width: `${a.score}%`, background: a.direction === s.action ? 'var(--emerald)' : 'var(--coral)' }} />
                          </div>
                          <span style={{ color: a.direction === s.action ? 'var(--emerald)' : 'var(--coral)' }}>{a.direction}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>Institutional Gates</div>
                    <div className="space-y-1.5">
                      {Object.entries(s.gate.checklist).map(([k, ok]) => (
                        <div key={k} className="flex items-center gap-2 font-mono text-[10px]" style={{ color: ok ? 'var(--textDim)' : 'var(--coral)' }}>
                          {ok ? <CheckCircle2 size={12} style={{ color: 'var(--emerald)' }} /> : <XCircle size={12} style={{ color: 'var(--coral)' }} />}
                          {k}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 font-mono text-[10px]" style={{ color: 'var(--textDim)' }}>
                      Risk: {s.risk.effectiveRisk}% · max loss ${s.risk.maxLoss} · {s.risk.note}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>Validation Engines</div>
                    {s.validation ? (
                      <div className="space-y-1.5 font-mono text-[10px]">
                        <div className="flex items-center justify-between">
                          <span style={{ color: 'var(--textDim)' }}>Monte Carlo</span>
                          <Pill tone={s.validation.monteCarlo?.approved ? 'up' : 'down'}>{s.validation.monteCarlo?.winProbability ?? '—'}% win</Pill>
                        </div>
                        <div className="flex items-center justify-between">
                          <span style={{ color: 'var(--textDim)' }}>Bayesian posterior</span>
                          <Pill tone={s.validation.bayesian?.approved ? 'up' : 'down'}>{s.validation.bayesian?.posterior ?? '—'}</Pill>
                        </div>
                        <div className="flex items-center justify-between">
                          <span style={{ color: 'var(--textDim)' }}>Statistical tests</span>
                          <Pill tone={s.validation.statistical?.approved ? 'up' : 'down'}>{s.validation.statistical?.passed ?? '—'}/{s.validation.statistical?.total ?? '—'}</Pill>
                        </div>
                        <div className="flex items-center justify-between">
                          <span style={{ color: 'var(--textDim)' }}>Walk-forward</span>
                          <Pill tone={s.validation.walkForward?.robust ? 'up' : 'warn'}>wfe {s.validation.walkForward?.wfe ?? '—'}</Pill>
                        </div>
                      </div>
                    ) : (
                      <div className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>No validation data on this signal.</div>
                    )}
                  </div>
                  <div>
                    <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>Signal Explainer</div>
                    <ul className="space-y-1">
                      {s.reasons.map((r, i) => (
                        <li key={i} className="font-mono text-[10px] flex gap-1.5" style={{ color: 'var(--textDim)' }}>
                          <ChevronRight size={11} style={{ color: 'var(--violet)', flexShrink: 0, marginTop: 1 }} />{r}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── INTEL ──────────────────────────────────────────────────────────── */
function IntelTab({ now, outlook, mode }) {
  const live = mode === 'live' && outlook;

  /* Demo-mode fallback content — unchanged from the original preview. */
  const mockSentiment = useMemo(() => SYMBOLS.map(s => ({ symbol: s, score: Math.round(rand(-80, 80)) })), []);
  const mockCot = useMemo(() => ['EUR', 'GBP', 'JPY', 'XAU'].map(c => ({ currency: c, nonComm: Math.round(rand(-60000, 60000)) })), []);
  const mockCalendar = useMemo(() => ([
    { event: 'US CPI y/y', impact: 'high', mins: 42 },
    { event: 'ECB Rate Decision', impact: 'high', mins: 185 },
    { event: 'US Initial Jobless Claims', impact: 'medium', mins: 340 },
    { event: 'UK Retail Sales m/m', impact: 'low', mins: 610 },
  ]), []);
  const mockNarrative = useMemo(() => pick([
    'Majors are consolidating inside prior-week ranges; institutional positioning shows specs trimming dollar longs while gold holds a bid on softer real yields. Crypto remains correlated to macro liquidity signals rather than trading on-chain fundamentals this session.',
    'Trend structure favors continuation on XAUUSD and BTCUSDT while EURUSD chops inside a well-defined range ahead of the ECB. Session filters currently favor the London/NY overlap for entries.',
    'Volatility is compressing across forex majors — the pipeline is flagging this as a pre-breakout regime and tightening entry criteria accordingly until a directional resolution confirms.',
  ]), [Math.floor(now / 45000)]);

  /* Real MarketOutlookBuilder payload (signal-pipeline/market-outlook.js),
     as returned by GET /api/outlook. */
  const narrative = live ? (outlook.narrative || 'No narrative generated yet.') : mockNarrative;
  const regimeRows = live ? (outlook.symbols || []).map(s => ({ symbol: s.symbol, regime: s.regime || '—', tradeability: s.tradeability || '—' })) : null;
  const cotRows = live
    ? (outlook.symbols || []).filter(s => s.institutionalPositioning).map(s => ({ currency: s.symbol, nonComm: s.institutionalPositioning.largeSpecNet ?? 0, signal: s.institutionalPositioning.signal }))
    : mockCot;
  const calendarRows = live
    ? [...(outlook.today?.tier1Events || []), ...(outlook.week?.tier1Events || [])].slice(0, 6).map(e => ({ event: `${e.name} (${e.currency})`, impact: 'high', mins: Math.max(0, Math.round((e.hoursAway || 0) * 60)) }))
    : mockCalendar;
  const newsRows = live ? (outlook.news || []).slice(0, 6).map(n => n.headline) : NEWS_SEED.slice(0, 6);

  return (
    <div className="p-4 space-y-4">
      <div className="omni-panel p-4">
        <SectionHeader icon={Globe2} title="Market Outlook" sub={live ? 'live · signal-pipeline/market-outlook' : 'demo · signal-explainer'} />
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--textDim)' }}>{narrative}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel p-4">
          {live ? (
            <>
              <SectionHeader icon={Activity} title="Regime & Tradeability" sub="per symbol" />
              <div className="space-y-2">
                {regimeRows.length === 0 && <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No symbol data yet.</div>}
                {regimeRows.map(r => (
                  <div key={r.symbol} className="flex items-center justify-between font-mono text-[11px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                    <span style={{ color: 'var(--text)' }}>{r.symbol}</span>
                    <span style={{ color: 'var(--textDim)' }}>{r.regime}</span>
                    <Pill tone={r.tradeability === 'high' ? 'up' : r.tradeability === 'low' ? 'down' : 'neutral'}>{r.tradeability}</Pill>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <SectionHeader icon={Activity} title="Macro Sentiment" sub="Alpha Vantage · demo" />
              <div className="space-y-2">
                {mockSentiment.map(s => (
                  <div key={s.symbol} className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="w-16" style={{ color: 'var(--textDim)' }}>{s.symbol}</span>
                    <div className="flex-1 h-2 rounded-full relative" style={{ background: 'var(--border)' }}>
                      <div className="absolute top-0 bottom-0 left-1/2" style={{ width: 1, background: 'var(--borderBright)' }} />
                      <div className="absolute top-0 bottom-0 rounded-full" style={{
                        left: s.score >= 0 ? '50%' : `${50 + s.score / 2}%`,
                        width: `${Math.abs(s.score) / 2}%`,
                        background: s.score >= 0 ? 'var(--emerald)' : 'var(--coral)',
                      }} />
                    </div>
                    <span className="w-10 text-right" style={{ color: s.score >= 0 ? 'var(--emerald)' : 'var(--coral)' }}>{s.score}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="omni-panel p-4">
          <SectionHeader icon={ShieldAlert} title="CFTC COT Positioning" sub={live ? 'large-spec net, per symbol' : 'non-comm, demo'} />
          <div className="space-y-3">
            {cotRows.length === 0 && <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No COT data available for tracked symbols.</div>}
            {cotRows.map(c => (
              <div key={c.currency} className="font-mono text-[11px]">
                <div className="flex justify-between mb-1">
                  <span style={{ color: 'var(--text)' }}>{c.currency}</span>
                  {c.signal && <span style={{ color: 'var(--textFaint)' }}>{c.signal}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-16" style={{ color: 'var(--textFaint)' }}>Large spec</span>
                  <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--border)' }}>
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.abs(c.nonComm) / 600)}%`, background: c.nonComm >= 0 ? 'var(--emerald)' : 'var(--coral)' }} />
                  </div>
                  <span className="w-14 text-right" style={{ color: 'var(--textDim)' }}>{c.nonComm.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={Clock} title="Economic Calendar" sub={live ? 'Myfxbook · tier-1' : 'Myfxbook · demo'} />
          <div className="space-y-1.5">
            {calendarRows.length === 0 && <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No tier-1 events on the horizon.</div>}
            {calendarRows.map((e, i) => (
              <div key={i} className="flex items-center gap-2 font-mono text-[11px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                <Pill tone={e.impact === 'high' ? 'down' : e.impact === 'medium' ? 'warn' : 'neutral'}>{e.impact}</Pill>
                <span className="flex-1" style={{ color: 'var(--textDim)' }}>{e.event}</span>
                <span style={{ color: 'var(--textFaint)' }}>in {Math.floor(e.mins / 60)}h{e.mins % 60}m</span>
              </div>
            ))}
          </div>
        </div>
        <div className="omni-panel p-4">
          <SectionHeader icon={Newspaper} title="Headlines" sub={live ? 'Finnhub' : 'Finnhub · demo'} />
          <div className="space-y-1.5">
            {newsRows.length === 0 && <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No headlines returned.</div>}
            {newsRows.map((n, i) => (
              <div key={i} className="font-mono text-[11px] py-1 border-b" style={{ color: 'var(--textDim)', borderColor: 'var(--border)' }}>{n}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── NEWS ───────────────────────────────────────────────────────────── */
function NewsTab({ news, mode }) {
  const [symFilter, setSymFilter] = useState('ALL');
  const live = mode === 'live' && Array.isArray(news);

  const demoNews = useMemo(() => NEWS_SEED.map((headline, i) => ({
    headline, source: pick(['Reuters', 'Bloomberg', 'DailyFX', 'ForexLive', 'CoinDesk']),
    url: null, datetime: Date.now() - i * rand(400000, 3200000),
    symbol: pick(SYMBOLS),
  })), []);

  const items = live ? news : demoNews;
  const filtered = symFilter === 'ALL' ? items : items.filter(n => n.symbol === symFilter);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <SectionHeader icon={Newspaper} title="Headlines" sub={live ? 'live · Finnhub' : 'demo · Finnhub'} />
        <div className="ml-auto flex gap-1 flex-wrap">
          {['ALL', ...SYMBOLS].map(s => (
            <button key={s} onClick={() => setSymFilter(s)}
              className="font-mono text-[10px] px-2 py-1 rounded uppercase"
              style={{ background: symFilter === s ? 'var(--emerald)' : 'var(--panel2)', color: symFilter === s ? '#05070a' : 'var(--textDim)' }}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="omni-panel p-4">
        {filtered.length === 0 ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No headlines for this filter yet.</div>
        ) : (
          <div className="space-y-0.5 max-h-[560px] overflow-y-auto omni-scroll">
            {filtered.map((n, i) => (
              <a key={i} href={n.url || undefined} target={n.url ? '_blank' : undefined} rel="noreferrer"
                className="omni-row flex items-start gap-3 px-2 py-2 rounded border-b" style={{ borderColor: 'var(--border)', textDecoration: 'none', cursor: n.url ? 'pointer' : 'default' }}>
                <Clock size={12} style={{ color: 'var(--textFaint)', marginTop: 2, flexShrink: 0 }} />
                <div className="flex-1">
                  <div className="text-[12px]" style={{ color: 'var(--text)' }}>{n.headline}</div>
                  <div className="font-mono text-[9px] uppercase mt-0.5" style={{ color: 'var(--textFaint)' }}>
                    {n.source || 'Unknown'} · {timeAgo(n.datetime)} ago{n.symbol ? ` · ${n.symbol}` : ''}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── MONITOR ────────────────────────────────────────────────────────── */
function MonitorTab({ auditLog, feedHealth, uptimeSec, mode }) {
  // In live mode, layer the real DataIntegrityMonitor report (name/connected
  // from /api/health) over the known feed list; feeds it doesn't mention
  // (e.g. OpenInsider, which is inert without a paid key) keep their static
  // description rather than disappearing.
  const liveByName = new Map((feedHealth || []).map(f => [f.name, f]));
  const feeds = FEEDS.map(f => {
    const live = liveByName.get(f.name);
    if (mode !== 'live' || !live) return f;
    return { ...f, status: live.connected ? 'live' : 'down' };
  });
  const uptimeLabel = mode === 'live' && uptimeSec != null
    ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
    : `${Math.floor(rand(4, 72))}h ${Math.floor(rand(0, 59))}m`;

  return (
    <div className="p-4 space-y-4">
      <div className="omni-panel p-4">
        <SectionHeader icon={Database} title="Feed Health" sub={`${feeds.filter(f => f.status === 'live').length}/${feeds.length} live${mode === 'live' ? '' : ' · demo'}`} />
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {feeds.map(f => (
            <div key={f.name} className="omni-panel2 p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[11px]" style={{ color: 'var(--text)' }}>{f.name}</span>
                <Circle size={8} fill="currentColor" style={{
                  color: f.status === 'live' ? 'var(--emerald)' : f.status === 'degraded' ? 'var(--gold)' : f.status === 'down' ? 'var(--coral)' : 'var(--textFaint)',
                }} className={f.status === 'live' ? 'omni-pulse' : ''} />
              </div>
              <div className="font-mono text-[9px] uppercase" style={{ color: 'var(--textFaint)' }}>{f.kind}</div>
              {f.note && <div className="font-mono text-[9px] mt-1" style={{ color: 'var(--gold)' }}>{f.note}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={ScrollText} title="Audit Trail" sub="every cycle, fired or not" />
          <div className="space-y-1 max-h-72 overflow-y-auto omni-scroll">
            {auditLog.map(e => (
              <div key={e.id} className="flex items-start gap-2 font-mono text-[10px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                <span style={{ color: 'var(--textFaint)' }} className="w-10 shrink-0">{timeAgo(e.timestamp)}</span>
                <span style={{ color: 'var(--text)' }} className="w-16 shrink-0">{e.symbol}</span>
                {e.fired
                  ? <CheckCircle2 size={11} style={{ color: 'var(--emerald)', marginTop: 1, flexShrink: 0 }} />
                  : <XCircle size={11} style={{ color: 'var(--textFaint)', marginTop: 1, flexShrink: 0 }} />}
                <span style={{ color: 'var(--textDim)' }}>{e.reasons.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="omni-panel p-4">
          <SectionHeader icon={Cpu} title="Orchestrator" sub="conflict resolution · cache" />
          <div className="space-y-3">
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span style={{ color: 'var(--textDim)' }}>Agent conflicts resolved (1h)</span>
              <span style={{ color: 'var(--text)' }}>{Math.round(rand(4, 22))}</span>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span style={{ color: 'var(--textDim)' }}>Market-hours gate</span>
              <Pill tone="up">open</Pill>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span style={{ color: 'var(--textDim)' }}>Symbol blacklist</span>
              <span style={{ color: 'var(--textFaint)' }}>none active</span>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span style={{ color: 'var(--textDim)' }}>Redis cache</span>
              <Pill tone="neutral">not configured (free tier)</Pill>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span style={{ color: 'var(--textDim)' }}>Pinecone memory</span>
              <Pill tone="neutral">not configured (free tier)</Pill>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span style={{ color: 'var(--textDim)' }}>MongoDB Atlas (M0)</span>
              <Pill tone="up">connected</Pill>
            </div>
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span style={{ color: 'var(--textDim)' }}>Process uptime</span>
              <span style={{ color: 'var(--text)' }}>{uptimeLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── HEAT ───────────────────────────────────────────────────────────── */
function tileBiasSign(bias) {
  if (bias === 'BUY' || bias === 'LONG_LEANING') return 1;
  if (bias === 'SELL' || bias === 'SHORT_LEANING') return -1;
  return 0;
}

function HeatTab({ heatmapTiles, mode }) {
  const live = mode === 'live' && Array.isArray(heatmapTiles);

  /* Demo-mode fallback — unchanged from the original preview. Note: the
     real GET /api/heatmap (automation/market-heatmap.js) returns a flat,
     ranked list of per-symbol heat tiles (score/bucket/bias/opportunity/
     relative-strength), not a symbol×symbol correlation matrix — so the
     live view below is shaped differently from this demo grid on purpose,
     not as a simplification of it. */
  const corr = useMemo(() => {
    const m = {};
    SYMBOLS.forEach(a => { m[a] = {}; SYMBOLS.forEach(b => { m[a][b] = a === b ? 1 : +rand(-1, 1).toFixed(2); }); });
    return m;
  }, []);
  const rs = useMemo(() => SYMBOLS.map(s => ({
    symbol: s, ...Object.fromEntries(TIMEFRAMES.map(tf => [tf, +rand(-1, 1).toFixed(2)])),
  })), []);

  if (live) {
    return (
      <div className="p-4 space-y-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={Flame} title="Market Heat Map" sub="live · opportunity + relative-strength blend, ranked" />
          {heatmapTiles.length === 0 ? (
            <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No tiles yet — waiting on the opportunity ranker to warm up.</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
              {heatmapTiles.map(t => {
                const sign = tileBiasSign(t.bias);
                return (
                  <div key={t.symbol} className="omni-panel2 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[11px]" style={{ color: 'var(--text)' }}>{t.symbol}</span>
                      <span className="font-mono text-[9px]" style={{ color: 'var(--textFaint)' }}>#{t.overallRank}</span>
                    </div>
                    <div className="rounded px-2 py-2 mb-2 flex items-center justify-between" style={{ background: heatColor(sign * (t.heatScore / 100)) }}>
                      <span className="font-mono text-lg font-bold" style={{ color: 'var(--text)' }}>{Math.round(t.heatScore)}</span>
                      <span className="font-mono text-[9px] uppercase" style={{ color: 'var(--textDim)' }}>{t.bucket}</span>
                    </div>
                    <div className="font-mono text-[10px] flex items-center justify-between" style={{ color: 'var(--textDim)' }}>
                      <span>{t.bias}</span>
                      {t.opportunity && <Pill tone={t.opportunity.fired ? 'up' : 'neutral'}>{t.opportunity.grade || '—'}</Pill>}
                    </div>
                    {t.relativeStrength && (
                      <div className="font-mono text-[9px] mt-1" style={{ color: 'var(--textFaint)' }}>
                        RS rank #{t.relativeStrength.rank} · {fmtPct(t.relativeStrength.changePct)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="omni-panel p-4 overflow-x-auto omni-scroll">
        <SectionHeader icon={Flame} title="Correlation Matrix" sub="rolling 50-bar, H1 · demo" />
        <div className="inline-block min-w-full">
          <div className="grid" style={{ gridTemplateColumns: `90px repeat(${SYMBOLS.length}, 68px)` }}>
            <div />
            {SYMBOLS.map(s => <div key={s} className="font-mono text-[9px] text-center py-1" style={{ color: 'var(--textFaint)' }}>{s}</div>)}
            {SYMBOLS.map(rowSym => (
              <Fragment key={rowSym}>
                <div className="font-mono text-[10px] py-1 pr-2" style={{ color: 'var(--textDim)' }}>{rowSym}</div>
                {SYMBOLS.map(colSym => (
                  <div key={rowSym + colSym} className="font-mono text-[10px] text-center py-2 m-0.5 rounded"
                    style={{ background: heatColor(corr[rowSym][colSym]), color: 'var(--text)' }}>
                    {corr[rowSym][colSym].toFixed(2)}
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      <div className="omni-panel p-4 overflow-x-auto omni-scroll">
        <SectionHeader icon={TrendingUp} title="Relative Strength Heat" sub="momentum by timeframe · demo" />
        <div className="inline-block min-w-full">
          <div className="grid" style={{ gridTemplateColumns: `90px repeat(${TIMEFRAMES.length}, 90px)` }}>
            <div />
            {TIMEFRAMES.map(tf => <div key={tf} className="font-mono text-[9px] text-center py-1" style={{ color: 'var(--textFaint)' }}>{tf}</div>)}
            {rs.map(row => (
              <Fragment key={row.symbol}>
                <div className="font-mono text-[10px] py-1 pr-2" style={{ color: 'var(--textDim)' }}>{row.symbol}</div>
                {TIMEFRAMES.map(tf => (
                  <div key={row.symbol + tf} className="font-mono text-[10px] text-center py-2 m-0.5 rounded flex items-center justify-center gap-1"
                    style={{ background: heatColor(row[tf]), color: 'var(--text)' }}>
                    {row[tf] >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}{Math.abs(row[tf]).toFixed(2)}
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── VALID ──────────────────────────────────────────────────────────── */
function ValidTab({ signals, journalStats, learningProfiles, mode }) {
  const live = mode === 'live';

  /* Demo-mode fallback — unchanged from the original preview. */
  const demoMonteCarlo = useMemo(() => {
    const buckets = [];
    for (let i = -10; i <= 10; i++) {
      const h = Math.round(60 * Math.exp(-(i * i) / 18) + rand(-3, 3));
      buckets.push({ r: i, count: Math.max(0, h) });
    }
    return buckets;
  }, []);
  const demoBacktest = { winRate: 58.4, profitFactor: 1.74, maxDD: 8.9, sharpe: 1.32, expectancy: 0.31, trades: 1284 };

  if (!live) {
    return (
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="omni-panel p-3 flex flex-col items-center"><Gauge value={68} label="Walk-Forward Eff. · demo" /></div>
          <div className="omni-panel p-3 flex flex-col items-center"><Gauge value={74} label="Bayesian Confidence · demo" /></div>
          <div className="omni-panel p-3 flex flex-col items-center"><Gauge value={demoBacktest.winRate} label="Backtest Win Rate · demo" /></div>
          <div className="omni-panel p-3 flex flex-col items-center justify-center">
            <span className="font-mono text-2xl font-bold" style={{ color: 'var(--gold)' }}>2.3%</span>
            <span className="font-mono text-[9px] uppercase tracking-wider mt-1" style={{ color: 'var(--textFaint)' }}>Kelly Suggested Size · demo</span>
          </div>
        </div>
        <div className="omni-panel p-4">
          <SectionHeader icon={FlaskConical} title="Monte Carlo Return Distribution" sub="10,000 paths · R-multiple · demo" />
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={demoMonteCarlo}>
              <CartesianGrid stroke="#1c232d" vertical={false} />
              <XAxis dataKey="r" tick={{ fill: '#526078', fontSize: 10 }} />
              <YAxis tick={{ fill: '#526078', fontSize: 10 }} width={30} />
              <Tooltip contentStyle={{ background: '#10151c', border: '1px solid #1c232d', borderRadius: 8, fontSize: 11 }} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {demoMonteCarlo.map((b, i) => <Cell key={i} fill={b.r >= 0 ? '#1fe3a8' : '#ff5470'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="omni-panel p-4">
          <SectionHeader icon={CheckCircle2} title="Backtest Summary" sub={`${demoBacktest.trades.toLocaleString()} trades · demo`} />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Win Rate" value={`${demoBacktest.winRate}%`} />
            <StatCard label="Profit Factor" value={demoBacktest.profitFactor} accent="var(--gold)" />
            <StatCard label="Max Drawdown" value={`${demoBacktest.maxDD}%`} accent="var(--coral)" />
            <StatCard label="Sharpe" value={demoBacktest.sharpe} accent="var(--blue)" />
            <StatCard label="Expectancy (R)" value={demoBacktest.expectancy} accent="var(--violet)" />
          </div>
        </div>
      </div>
    );
  }

  /* Live mode — everything below is derived from real data: the
     validation sub-object db.js now persists per signal (Monte Carlo /
     Bayesian / Statistical / Walk-Forward, computed live in index.js),
     GET /api/journal (SignalJournal.getStats — real closed-trade
     outcomes), and GET /api/learning (per-pattern adaptive-learning
     profiles from actual trade_outcomes). No invented numbers. */
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const validated = (signals || []).filter(s => s.validation);
  const mcWinProbs = validated.map(s => s.validation.monteCarlo?.winProbability).filter(v => v != null);
  const bayesPosteriors = validated.map(s => s.validation.bayesian?.posterior).filter(v => v != null);
  const wfeVals = validated.map(s => s.validation.walkForward?.wfe).filter(v => v != null);
  const statRates = validated.map(s => s.validation.statistical ? (s.validation.statistical.passed / s.validation.statistical.total) * 100 : null).filter(v => v != null);
  const avgMc = avg(mcWinProbs), avgBayes = avg(bayesPosteriors), avgWfe = avg(wfeVals), avgStat = avg(statRates);

  const hasJournal = journalStats && journalStats.total > 0;
  const kellyPct = hasJournal && journalStats.avgLoss > 0 && journalStats.avgWin > 0
    ? clamp((journalStats.winRate / 100) - ((1 - journalStats.winRate / 100) / (journalStats.avgWin / journalStats.avgLoss)), 0, 1) * 100
    : null;

  const mcChartData = validated.slice(0, 20).reverse().map((s, i) => ({ label: `${s.symbol}#${i + 1}`, prob: s.validation.monteCarlo?.winProbability ?? 0 }));

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="omni-panel p-3 flex flex-col items-center justify-center">
          {avgWfe != null ? <Gauge value={avgWfe * 100} label="Avg Walk-Forward Eff." /> : <span className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>Walk-forward: no data yet</span>}
        </div>
        <div className="omni-panel p-3 flex flex-col items-center justify-center">
          {avgBayes != null ? <Gauge value={avgBayes * 100} label="Avg Bayesian Posterior" /> : <span className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>Bayesian: no data yet</span>}
        </div>
        <div className="omni-panel p-3 flex flex-col items-center justify-center">
          {avgMc != null ? <Gauge value={avgMc} label="Avg Monte Carlo Win %" /> : <span className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>Monte Carlo: no data yet</span>}
        </div>
        <div className="omni-panel p-3 flex flex-col items-center justify-center">
          {kellyPct != null ? (
            <>
              <span className="font-mono text-2xl font-bold" style={{ color: 'var(--gold)' }}>{kellyPct.toFixed(1)}%</span>
              <span className="font-mono text-[9px] uppercase tracking-wider mt-1" style={{ color: 'var(--textFaint)' }}>Kelly Size (from journal)</span>
            </>
          ) : <span className="font-mono text-[10px] text-center" style={{ color: 'var(--textFaint)' }}>Kelly: needs completed trades</span>}
        </div>
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={FlaskConical} title="Monte Carlo Win Probability" sub="live · per recent validated signal" />
        {mcChartData.length === 0 ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No signals with validation data yet — this fills in as new signals are scored.</div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={mcChartData}>
              <CartesianGrid stroke="#1c232d" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#526078', fontSize: 9 }} interval={0} angle={-30} textAnchor="end" height={50} />
              <YAxis tick={{ fill: '#526078', fontSize: 10 }} width={30} domain={[0, 100]} />
              <Tooltip contentStyle={{ background: '#10151c', border: '1px solid #1c232d', borderRadius: 8, fontSize: 11 }} />
              <Bar dataKey="prob" radius={[2, 2, 0, 0]}>
                {mcChartData.map((b, i) => <Cell key={i} fill={b.prob >= 55 ? '#1fe3a8' : '#ff5470'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={CheckCircle2} title="Backtest Summary" sub={hasJournal ? `${journalStats.total} completed trades` : 'trading journal'} />
        {hasJournal ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Win Rate" value={`${journalStats.winRate}%`} />
            <StatCard label="Profit Factor" value={journalStats.pf} accent="var(--gold)" />
            <StatCard label="Total P/L (R)" value={journalStats.totalPnlR} accent={journalStats.totalPnlR >= 0 ? 'var(--emerald)' : 'var(--coral)'} />
            <StatCard label="Avg Win / Loss (R)" value={`${journalStats.avgWin} / -${journalStats.avgLoss}`} accent="var(--blue)" />
            <StatCard label="Expectancy (R)" value={journalStats.expectancy} accent="var(--violet)" />
          </div>
        ) : (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>{journalStats?.message || 'No completed trades recorded yet — this fills in once positions close via the MT5 EA bridge.'}</div>
        )}
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={Layers} title="Learned Setups" sub="adaptive-learning-engine · per pattern, from real outcomes" />
        {!learningProfiles || learningProfiles.length === 0 ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No learned patterns yet — needs closed trades to build a profile.</div>
        ) : (
          <div className="max-h-64 overflow-y-auto omni-scroll space-y-1">
            {learningProfiles.map(p => (
              <div key={p.patternKey} className="omni-row flex items-center gap-3 px-2 py-1.5 rounded font-mono text-[10px]">
                <span className="flex-1 truncate" style={{ color: 'var(--textDim)' }}>{p.patternKey}</span>
                <span style={{ color: 'var(--textFaint)' }}>{p.samples} samples</span>
                <span style={{ color: p.winRate >= 0.5 ? 'var(--emerald)' : 'var(--coral)' }}>{Math.round(p.winRate * 100)}% win</span>
                <span style={{ color: p.expectancyR >= 0 ? 'var(--emerald)' : 'var(--coral)' }}>{p.expectancyR?.toFixed(2)}R exp</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── TAPE ───────────────────────────────────────────────────────────── */
function TapeTab({ signals, prices }) {
  const executions = useMemo(() => signals.filter(s => s.gate.status === 'approved').slice(0, 20).map(s => {
    const closed = Math.random() > 0.4;
    const pnlR = closed ? +rand(-1.2, 2.8).toFixed(2) : null;
    return { ...s, fillPrice: s.entry * (1 + rand(-0.0003, 0.0003)), closed, pnlR };
  }), [signals]);
  const runningPnL = executions.filter(e => e.closed).reduce((a, e) => a + e.pnlR, 0);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-4">
        <StatCard label="Open Positions" value={executions.filter(e => !e.closed).length} icon={Activity} />
        <StatCard label="Closed Today" value={executions.filter(e => e.closed).length} icon={CheckCircle2} accent="var(--blue)" />
        <StatCard label="Running P/L (R)" value={runningPnL.toFixed(2)} delta={runningPnL} icon={DollarSign} accent={runningPnL >= 0 ? 'var(--emerald)' : 'var(--coral)'} />
      </div>
      <div className="omni-panel overflow-hidden">
        <SectionHeader icon={ScrollText} title="Execution Tape" sub="via MT5 EA bridge (OmniceeEA.mq5)" />
        <div className="grid grid-cols-[70px_46px_44px_1fr_1fr_60px_60px] gap-2 px-3 py-2 font-mono text-[9px] uppercase tracking-wider border-b border-t" style={{ color: 'var(--textFaint)', borderColor: 'var(--border)' }}>
          <span>Symbol</span><span>TF</span><span>Dir</span><span>Fill</span><span>Signal</span><span>P/L (R)</span><span>Status</span>
        </div>
        <div className="max-h-96 overflow-y-auto omni-scroll">
          {executions.map(e => (
            <div key={e.id} className="omni-row grid grid-cols-[70px_46px_44px_1fr_1fr_60px_60px] gap-2 px-3 py-2 font-mono text-[11px] border-b items-center" style={{ borderColor: 'var(--border)' }}>
              <span style={{ color: 'var(--text)' }}>{e.symbol}</span>
              <span style={{ color: 'var(--textDim)' }}>{e.timeframe}</span>
              <span style={{ color: e.action === 'BUY' ? 'var(--emerald)' : 'var(--coral)' }}>{e.action}</span>
              <span style={{ color: 'var(--textDim)' }}>{fmtPrice(e.symbol, e.fillPrice)}</span>
              <span style={{ color: 'var(--textFaint)' }}>{e.id}</span>
              <span style={{ color: e.pnlR == null ? 'var(--textFaint)' : e.pnlR >= 0 ? 'var(--emerald)' : 'var(--coral)' }}>{e.pnlR == null ? '—' : e.pnlR}</span>
              <Pill tone={e.closed ? (e.pnlR >= 0 ? 'up' : 'down') : 'info'}>{e.closed ? 'closed' : 'open'}</Pill>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── RISK ───────────────────────────────────────────────────────────── */
function RiskTab({ prices, changes, accountBalance, relativeStrength, mode }) {
  const [balance, setBalance] = useState(10000);
  const [riskPct, setRiskPct] = useState(1.0);
  const [stopPips, setStopPips] = useState(20);
  const [symbol, setSymbol] = useState('EURUSD');
  // FIX (Known gap #3): "DASH/RISK account-balance figures aren't yet
  // pulled from /api/stats's accountBalance field." Applied once, on the
  // first real value — this field is also a live what-if calculator input,
  // so it stays user-editable afterward rather than snapping back on every
  // 5s poll.
  const appliedRealBalance = useRef(false);
  useEffect(() => {
    if (accountBalance != null && !appliedRealBalance.current) {
      appliedRealBalance.current = true;
      setBalance(accountBalance);
    }
  }, [accountBalance]);

  const riskAmount = balance * (riskPct / 100);
  const pipValue = PIP[symbol];
  const units = stopPips > 0 ? Math.round(riskAmount / (stopPips * pipValue)) : 0;
  const lots = (units / 100000).toFixed(2);

  const drawdown = 4.2;
  const sessions = [
    { name: 'Asia', start: 0, end: 8 }, { name: 'London', start: 8, end: 16 }, { name: 'New York', start: 13, end: 21 },
  ];
  const hour = new Date().getUTCHours();
  const exposures = SYMBOLS.map(s => ({ symbol: s, exposure: +rand(-3, 3).toFixed(1) }));
  const liveRanked = mode === 'live' && relativeStrength?.all?.length ? relativeStrength.all.map(r => r.symbol) : null;
  const ranked = liveRanked || [...SYMBOLS].sort((a, b) => (changes[b] ?? 0) - (changes[a] ?? 0));

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={GaugeIcon} title="Position Size Calculator" />
          <div className="grid grid-cols-2 gap-3 mb-3">
            <label className="text-[10px] font-mono uppercase" style={{ color: 'var(--textFaint)' }}>
              Account Balance ($)
              <input type="number" value={balance} onChange={e => setBalance(+e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded font-mono text-[12px] outline-none"
                style={{ background: 'var(--panel2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
            </label>
            <label className="text-[10px] font-mono uppercase" style={{ color: 'var(--textFaint)' }}>
              Risk Per Trade (%)
              <input type="number" step="0.1" value={riskPct} onChange={e => setRiskPct(+e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded font-mono text-[12px] outline-none"
                style={{ background: 'var(--panel2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
            </label>
            <label className="text-[10px] font-mono uppercase" style={{ color: 'var(--textFaint)' }}>
              Symbol
              <select value={symbol} onChange={e => setSymbol(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded font-mono text-[12px] outline-none"
                style={{ background: 'var(--panel2)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-[10px] font-mono uppercase" style={{ color: 'var(--textFaint)' }}>
              Stop Distance (pips)
              <input type="number" value={stopPips} onChange={e => setStopPips(+e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded font-mono text-[12px] outline-none"
                style={{ background: 'var(--panel2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
            </label>
          </div>
          <div className="omni-panel2 p-3 flex justify-around text-center">
            <div><div className="font-mono text-lg font-bold" style={{ color: 'var(--emerald)' }}>{lots}</div><div className="font-mono text-[9px] uppercase" style={{ color: 'var(--textFaint)' }}>Lots</div></div>
            <div><div className="font-mono text-lg font-bold" style={{ color: 'var(--gold)' }}>{units.toLocaleString()}</div><div className="font-mono text-[9px] uppercase" style={{ color: 'var(--textFaint)' }}>Units</div></div>
            <div><div className="font-mono text-lg font-bold" style={{ color: 'var(--coral)' }}>${riskAmount.toFixed(0)}</div><div className="font-mono text-[9px] uppercase" style={{ color: 'var(--textFaint)' }}>Max Loss</div></div>
          </div>
        </div>

        <div className="omni-panel p-4">
          <SectionHeader icon={ShieldAlert} title="Drawdown Circuit Breaker" />
          <div className="flex justify-center"><Gauge value={(drawdown / 10) * 100} label={`${drawdown}% of 10% limit`} zones={[[0, 50, '#1fe3a8'], [50, 80, '#f0b429'], [80, 101, '#ff5470']]} /></div>
          <div className="font-mono text-[11px] text-center mt-2" style={{ color: 'var(--textDim)' }}>
            Daily loss budget: <span style={{ color: 'var(--text)' }}>3.0%</span> · Used today: <span style={{ color: 'var(--gold)' }}>1.1%</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={Layers} title="Portfolio Exposure" />
          <div className="space-y-2">
            {exposures.map(e => (
              <div key={e.symbol} className="flex items-center gap-2 font-mono text-[11px]">
                <span className="w-16" style={{ color: 'var(--textDim)' }}>{e.symbol}</span>
                <div className="flex-1 h-2 rounded-full relative" style={{ background: 'var(--border)' }}>
                  <div className="absolute top-0 bottom-0 left-1/2" style={{ width: 1, background: 'var(--borderBright)' }} />
                  <div className="absolute top-0 bottom-0 rounded-full" style={{ left: e.exposure >= 0 ? '50%' : `${50 + e.exposure * 12}%`, width: `${Math.abs(e.exposure) * 12}%`, background: e.exposure >= 0 ? 'var(--emerald)' : 'var(--coral)' }} />
                </div>
                <span className="w-12 text-right" style={{ color: 'var(--textDim)' }}>{e.exposure}%</span>
              </div>
            ))}
          </div>
        </div>

        <div className="omni-panel p-4">
          <SectionHeader icon={Clock} title="Session / Blackout Windows" sub={`current hour ${hour}:00 UTC`} />
          <div className="space-y-2 mb-3">
            {sessions.map(s => {
              const active = hour >= s.start && hour < s.end;
              return (
                <div key={s.name} className="flex items-center justify-between font-mono text-[11px]">
                  <span style={{ color: active ? 'var(--emerald)' : 'var(--textDim)' }}>{s.name}</span>
                  <span style={{ color: 'var(--textFaint)' }}>{s.start}:00–{s.end}:00 UTC</span>
                  {active && <Pill tone="up">active</Pill>}
                </div>
              );
            })}
          </div>
          <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>Relative Strength Ranking{liveRanked ? ' · risk-engine, live' : ' · demo'}</div>
          <div className="flex flex-wrap gap-1.5">
            {ranked.map((s, i) => (
              <span key={s} className="font-mono text-[10px] px-2 py-1 rounded" style={{ background: 'var(--panel2)', color: i < 2 ? 'var(--emerald)' : i >= ranked.length - 2 ? 'var(--coral)' : 'var(--textDim)' }}>{s}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── App shell ──────────────────────────────────────────────────────── */
export default function OmniceeDashboard() {
  const [activeTab, setActiveTab] = useState('DASH');
  const feed = useLiveFeed();

  const handleCommand = useCallback((raw) => {
    const val = raw.toUpperCase();
    const tab = TABS.find(t => t.key === val || t.label.toUpperCase() === val);
    if (tab) { setActiveTab(tab.key); return; }
    if (SYMBOLS.includes(val)) { setActiveTab('SIGNALS'); return; }
  }, []);

  return (
    <div className="omni-root flex flex-col h-full min-h-[640px] w-full text-sm">
      <ThemeStyle />
      <TopBar now={feed.now} mode={feed.mode} socketLive={feed.socketLive} wakingBackend={feed.wakingBackend} onCommand={handleCommand} />
      <TickerTape prices={feed.prices} changes={feed.changes} flash={feed.flash} />
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto omni-scroll">
          {activeTab === 'DASH' && <DashTab signals={feed.signals} equityCurve={feed.equityCurve} equityCurveLive={feed.equityCurveLive} accountBalance={feed.accountBalance} prices={feed.prices} changes={feed.changes} stats={feed.stats} mode={feed.mode} />}
          {activeTab === 'SIGNALS' && <SignalsTab signals={feed.signals} />}
          {activeTab === 'INTEL' && <IntelTab now={feed.now} outlook={feed.outlook} mode={feed.mode} />}
          {activeTab === 'NEWS' && <NewsTab news={feed.news} mode={feed.mode} />}
          {activeTab === 'MONITOR' && <MonitorTab auditLog={feed.auditLog} feedHealth={feed.feedHealth} uptimeSec={feed.uptimeSec} mode={feed.mode} />}
          {activeTab === 'HEAT' && <HeatTab heatmapTiles={feed.heatmapTiles} mode={feed.mode} />}
          {activeTab === 'VALID' && <ValidTab signals={feed.signals} journalStats={feed.journalStats} learningProfiles={feed.learningProfiles} mode={feed.mode} />}
          {activeTab === 'TAPE' && <TapeTab signals={feed.signals} prices={feed.prices} />}
          {activeTab === 'RISK' && <RiskTab prices={feed.prices} changes={feed.changes} stats={feed.stats} accountBalance={feed.accountBalance} relativeStrength={feed.relativeStrength} mode={feed.mode} />}
        </div>
        <div className="flex items-center justify-center gap-2 py-1 border-t font-mono text-[8px] uppercase tracking-wider" style={{ borderColor: 'var(--border)', color: 'var(--textFaint)' }}>
          <span>OMNICEE</span><span>·</span><span>Developed by James Yelbert</span>
        </div>
        <NavBar active={activeTab} onSelect={setActiveTab} />
      </div>
    </div>
  );
}
