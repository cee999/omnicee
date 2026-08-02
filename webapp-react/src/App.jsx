import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import {
  LayoutDashboard, Radio, Globe2, Activity, Flame, FlaskConical,
  ScrollText, ShieldAlert, ChevronRight, ChevronDown,
  TrendingUp, CheckCircle2, XCircle,
  Circle, Clock, Zap, Database,
  Terminal, Newspaper, Gauge as GaugeIcon,
  Layers, Target, DollarSign,
} from 'lucide-react';

/* ────────────────────────────────────────────────────────────────────────
   OMNICEE // INSTITUTIONAL SIGNAL TERMINAL
   The real dashboard: every panel reads from the live backend (GET
   /api/signals, /api/outlook, /api/heatmap, /api/audit-trail, /api/health,
   /api/stats, /api/journal, /api/news, /api/watchlist, /api/equity-curve)
   plus a socket.io channel for tick-by-tick prices where available. No
   demo/simulated data — a panel with nothing real to show yet displays an
   honest "Waiting for backend" state instead of an invented number.
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
function signalScore(s) {
  const raw = typeof s.score === 'object' ? s.score?.final : s.score;
  return Number.isFinite(Number(raw)) ? Number(raw) : 0;
}

function normalizeDirection(action) {
  const a = String(action || 'WAIT').toUpperCase();
  if (a === 'LONG') return 'BUY';
  if (a === 'SHORT') return 'SELL';
  return a;
}

function priceFrom(value, fallback = null) {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return fallback;
  const candidates = [value.price, value.midpoint, value.midPoint, value.zoneLow, value.zoneHigh];
  const nums = candidates.map(Number).filter(Number.isFinite);
  if (nums.length >= 2 && value.zoneLow != null && value.zoneHigh != null) {
    return (Number(value.zoneLow) + Number(value.zoneHigh)) / 2;
  }
  return nums[0] ?? fallback;
}

function normalizeTargets(targets) {
  if (Array.isArray(targets)) return targets.map(t => priceFrom(t)).filter(v => v != null);
  if (!targets || typeof targets !== 'object') return [];
  return ['tp1', 'tp2', 'tp3'].map(k => priceFrom(targets[k])).filter(v => v != null);
}

function normalizeSignal(s) {
  const action = normalizeDirection(s.action || s.direction);
  const agents = Array.isArray(s.agents || s.agentBreakdown) ? (s.agents || s.agentBreakdown) : [];
  const normalizedAgents = agents.map(a => ({ ...a, direction: normalizeDirection(a.direction) }));
  const agreeCount = s.agreeCount != null
    ? s.agreeCount
    : normalizedAgents.filter(a => a.direction === action).length;
  const score = signalScore(s);
  const currentPrice = Number(s.currentPrice ?? s.price);
  return {
    ...s,
    id: s.id || `${s.symbol || 'signal'}-${s.timestamp || Date.now()}`,
    action,
    score,
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    entry: priceFrom(s.entry, Number.isFinite(currentPrice) ? currentPrice : null),
    stopLoss: priceFrom(s.stopLoss),
    targets: normalizeTargets(s.targets),
    gate: s.gate || { status: 'pending', checklist: {} },
    regime: s.regime || { regime: 'UNKNOWN' },
    risk: s.risk || { effectiveRisk: 0, maxLoss: 0, note: 'Awaiting risk evaluation' },
    agents: normalizedAgents,
    agreeCount,
  };
}

const FEEDS = [
  { name: 'Yahoo',        kind: 'free ticks', status: 'unknown' },
  { name: 'YahooOHLC',    kind: 'free candles', status: 'unknown' },
  { name: 'Binance',      kind: 'crypto ws',  status: 'unknown' },
  { name: 'Bybit',        kind: 'crypto ws',  status: 'unknown' },
  { name: 'TwelveData',   kind: 'fx/commod',  status: 'unknown' },
  { name: 'Finnhub',      kind: 'news',       status: 'unknown' },
  { name: 'Alpha Vantage',kind: 'macro sent', status: 'unknown' },
  { name: 'FMP',          kind: 'fundamentals',status: 'unknown' },
  { name: 'CFTC COT',     kind: 'positioning',status: 'unknown' },
  { name: 'Myfxbook',     kind: 'calendar',   status: 'unknown' },
  { name: 'OpenInsider',  kind: 'SEC Form 4', status: 'inert', note: 'needs paid Parse.bot key' },
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmtPrice(symbol, v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  const d = DECIMALS[symbol] ?? 2;
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
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
      .omni-marquee { animation: omni-marquee 16s linear infinite; }
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

/* Shown wherever a panel's real data hasn't arrived yet — replaces every
   demo/simulated fallback that used to sit here instead. */
function WaitingForBackend({ height = 140, label = 'Waiting for live data… check feeds / API keys' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-wider"
      style={{ height, color: 'var(--textFaint)' }}>
      <Circle size={6} fill="currentColor" className="omni-pulse" />
      {label}
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

/* Demo/simulated data generation has been removed entirely, per explicit
   request — the app no longer fabricates signals, audit entries, prices,
   or any other numbers. When the backend isn't reachable, every panel
   shows a plain "waiting for backend" state instead. */

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
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const APP_TOKEN = (import.meta.env.VITE_APP_TOKEN || '').trim();

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
  const [mode, setMode] = useState('checking'); // 'checking' | 'live'
  const [now, setNow] = useState(Date.now());
  const [prices, setPrices] = useState(() => Object.fromEntries(SYMBOLS.map(s => [s, null])));
  const [changes, setChanges] = useState(() => Object.fromEntries(SYMBOLS.map(s => [s, null])));
  const [flash, setFlash] = useState({});
  const [signals, setSignals] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [equityCurve, setEquityCurve] = useState([]);
  const [stats, setStats] = useState(null);
  const [outlook, setOutlook] = useState(null);
  const [heatmapTiles, setHeatmapTiles] = useState(null);
  const [feedHealth, setFeedHealth] = useState(null);
  const [uptimeSec, setUptimeSec] = useState(null);
  // Null until a real EA-reported balance (POST /api/ea/balance) arrives via
  // poll or the 'balance' socket channel — DashTab/RiskTab show "—" until then.
  const [accountBalance, setAccountBalance] = useState(null);
  const [equityCurveLive, setEquityCurveLive] = useState(false);
  // FIX (Known gap #1): "Prices tick from signals, not a true feed." True,
  // whenever the socket below actually connects — this just tracks that so
  // the UI can show whether it's on tick-by-tick push or 5s-poll fallback.
  const [socketLive, setSocketLive] = useState(false);
  const [news, setNews] = useState(null);
  const [sentiment, setSentiment] = useState(null);
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
          setMode(m => (m === 'live' ? m : 'checking'));
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

  /* Live polling — real backend. Fast loop covers signals/stats (the
     things worth refreshing every few seconds); slow loop covers
     outlook/heatmap/audit-trail/feed-health (heavier, computed routes
     that 503 until the trading engine finishes booting, so failures here
     are expected right after a cold start and just retry next tick). */
  const [fetchErrors, setFetchErrors] = useState({});
  const recordFetch = (key, promise) => promise
    .then(r => { setFetchErrors(prev => (prev[key] ? { ...prev, [key]: null } : prev)); return r; })
    .catch(err => { setFetchErrors(prev => ({ ...prev, [key]: err.message })); throw err; });

  useEffect(() => {
    if (mode !== 'live') return;
    let cancelled = false;

    const pullFast = async () => {
      try {
        const r = await recordFetch('market', omniFetch(`/api/market?symbols=${SYMBOLS.join(',')}`));
        if (!cancelled && r.ok && Array.isArray(r.market)) {
          setPrices(prev => {
            const next = { ...prev };
            r.market.forEach(m => { if (m.symbol && m.price != null && m.symbol in next) next[m.symbol] = Number(m.price); });
            return next;
          });
          setChanges(prev => {
            const next = { ...prev };
            r.market.forEach(m => { if (m.symbol && m.change != null && m.symbol in next) next[m.symbol] = Number(m.change); });
            return next;
          });
        }
      } catch (_) { /* market snapshots are optional; socket ticks may be live */ }
      try {
        const r = await recordFetch('signals', omniFetch(`/api/signals?limit=40`));
        if (!cancelled && r.ok) {
          const normalized = r.signals.map(normalizeSignal);
          setSignals(normalized);
          setPrices(prev => {
            const next = { ...prev };
            normalized.forEach(s => { if (s.symbol && s.currentPrice) next[s.symbol] = s.currentPrice; });
            return next;
          });
        }
      } catch (_) { /* keep last-known signals on a transient failure */ }
      try {
        const r = await recordFetch('stats', omniFetch('/api/stats'));
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
      try { const r = await recordFetch('outlook', omniFetch('/api/outlook')); if (!cancelled && r.ok) setOutlook(r.outlook); } catch (_) {}
      try { const r = await recordFetch('heatmap', omniFetch('/api/heatmap')); if (!cancelled && r.ok) setHeatmapTiles(r.tiles); } catch (_) {}
      try { const r = await recordFetch('audit-trail', omniFetch('/api/audit-trail?limit=30')); if (!cancelled && r.ok) setAuditLog(r.entries); } catch (_) {}
      try { const r = await recordFetch('health', omniFetch('/api/health')); if (!cancelled && r.ok) setFeedHealth(r.feeds); } catch (_) {}
      try { const r = await omniFetch('/health'); if (!cancelled && r.ok) setUptimeSec(r.uptime); } catch (_) {}
      // FIX (Known gap #2): "Equity curve stays illustrative even in live
      // mode ... worth adding a db.getEquityCurve() + route." Realized-trade
      // curve, ~20s refresh (same cadence as the other heavier routes here)
      // — a brand-new deployment with zero closed trades yet returns an
      // empty curve, so keep the demo-seeded one on screen until real
      // points exist rather than blanking the chart.
      try {
        const r = await recordFetch('equity-curve', omniFetch('/api/equity-curve?limit=300'));
        if (!cancelled && r.ok && Array.isArray(r.curve) && r.curve.length > 1) {
          setEquityCurve(r.curve.map((pt, i) => ({ t: i, equity: pt.balance, timestamp: pt.timestamp, symbol: pt.symbol, result: pt.result })));
          setEquityCurveLive(true);
        }
      } catch (_) {}
      try { const r = await recordFetch('news', omniFetch('/api/news')); if (!cancelled && r.ok) setNews(Array.isArray(r.news) ? r.news : []); } catch (_) {}
      try { const r = await recordFetch('sentiment', omniFetch('/api/sentiment')); if (!cancelled && r.ok) setSentiment(r); } catch (_) {}
      try { const r = await recordFetch('journal', omniFetch('/api/journal')); if (!cancelled && r.ok) setJournalStats(r.stats); } catch (_) {}
      try { const r = await recordFetch('learning', omniFetch('/api/learning?limit=20')); if (!cancelled && r.ok) setLearningProfiles(r.profiles); } catch (_) {}
      try { const r = await recordFetch('watchlist', omniFetch('/api/watchlist')); if (!cancelled && r.ok) setRelativeStrength(r.relativeStrength); } catch (_) {}
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
        setPrices(prev => ({ ...prev, [sym]: Number(payload.price) }));
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
    news, sentiment, journalStats, learningProfiles, relativeStrength, fetchErrors,
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
    checking: wakingBackend
      ? { label: 'Connecting · Waking Backend', color: 'var(--gold)', pulse: true }
      : { label: 'Connecting', color: 'var(--gold)', pulse: true },
    live: { label: 'Live', color: 'var(--emerald)', pulse: true },
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
  // Unique symbols only (env can accidentally list the same pair twice)
  const syms = [...new Set(SYMBOLS)];
  const row = syms.map(sym => (
    <span key={sym} className={`inline-flex items-center gap-2 px-5 font-mono text-[12px] ${flash[sym] === 'up' ? 'omni-flash-up' : flash[sym] === 'down' ? 'omni-flash-down' : ''}`}>
      <span style={{ color: 'var(--textDim)' }}>{sym}</span>
      <span style={{ color: 'var(--text)' }}>{fmtPrice(sym, prices[sym])}</span>
      <span style={{ color: (changes[sym] ?? 0) >= 0 ? 'var(--emerald)' : 'var(--coral)' }}>{fmtPct(changes[sym] ?? 0)}</span>
    </span>
  ));
  return (
    <div className="overflow-hidden border-b py-1.5" style={{ borderColor: 'var(--border)', background: '#080a0d' }}>
      {/* Two copies = smooth loop; not a bug. Animation is faster (16s). */}
      <div className="flex omni-marquee whitespace-nowrap w-max">
        <div className="flex">{row}</div>
        <div className="flex" aria-hidden="true">{row}</div>
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
function DashTab({ signals, equityCurve, equityCurveLive, accountBalance, journalStats, prices, changes, mode }) {
  const approved = signals.filter(s => s.gate.status === 'approved');
  const hasJournal = journalStats && journalStats.total > 0;
  const avgScore = signals.length ? Math.round(signals.reduce((a, s) => a + s.score, 0) / signals.length) : 0;
  const consensus = AGENTS.map(agent => {
    const votes = signals.slice(0, 12).flatMap(s => s.agents.filter(a => a.agent === agent));
    const bull = votes.filter(v => v.direction === 'BUY').length;
    const total = votes.length || 1;
    return { agent, bullPct: Math.round((bull / total) * 100) };
  });
  // FIX: was `61 + (weird modulo of signal scores)` — a formula that looks
  // like a real percentage but isn't derived from any actual outcome, and
  // ran unconditionally regardless of mode. Now uses the real journal win
  // rate (SignalJournal.getStats(), the same source VALID uses) and is
  // honest about there being nothing to show until trades have closed.
  const displayBalance = accountBalance ?? (equityCurveLive ? equityCurve[equityCurve.length - 1]?.equity : null);

  // Live price chart: every real tick (socket 'market' in live mode)
  // already lands in `prices` — this just keeps a rolling client-side
  // window of it per symbol instead of discarding it, so there's an
  // actual chart instead of only a snapshot number. No new backend
  // endpoint needed; this is the same tick stream the ticker uses.
  const [chartSymbol, setChartSymbol] = useState('XAUUSD');
  const [priceHistory, setPriceHistory] = useState(() => Object.fromEntries(SYMBOLS.map(s => [s, []])));
  useEffect(() => {
    setPriceHistory(prev => {
      const next = { ...prev };
      let changed = false;
      SYMBOLS.forEach(sym => {
        if (prices[sym] == null) return;
        const arr = prev[sym] || [];
        if (arr.length && arr[arr.length - 1].price === prices[sym]) return;
        next[sym] = [...arr, { t: Date.now(), price: prices[sym] }].slice(-180);
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [prices]);
  const chartData = priceHistory[chartSymbol] || [];
  const chartUp = chartData.length > 1 ? chartData[chartData.length - 1].price >= chartData[0].price : true;

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap gap-3">
        <StatCard label="Active Signals" value={approved.length} icon={Radio} />
        <StatCard label={hasJournal ? 'Win Rate (Journal)' : 'Win Rate'} value={hasJournal ? `${journalStats.winRate}%` : '—'} icon={Target} accent="var(--gold)" />
        <StatCard label="Avg Score" value={avgScore} icon={GaugeIcon} accent="var(--blue)" />
        <StatCard label="Signals Today" value={signals.length} icon={Zap} accent="var(--violet)" />
        <StatCard label={accountBalance != null ? 'Account Bal. (live)' : 'Account Bal.'} value={displayBalance != null ? `$${displayBalance.toLocaleString()}` : '—'} icon={DollarSign} accent="var(--emerald)" />
        <StatCard label="Max DD Limit" value="10.0%" icon={ShieldAlert} accent="var(--coral)" />
      </div>

      <div className="omni-panel p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <SectionHeader icon={TrendingUp} title={`${chartSymbol} — Live`} sub={mode === 'live' ? 'real-time ticks' : 'demo simulator'} />
          <div className="flex gap-1">
            {SYMBOLS.map(sym => (
              <button key={sym} onClick={() => setChartSymbol(sym)}
                className="px-2 py-1 rounded font-mono text-[9px] uppercase tracking-wider transition-colors"
                style={{
                  color: chartSymbol === sym ? '#05070a' : 'var(--textDim)',
                  background: chartSymbol === sym ? 'var(--emerald)' : 'var(--panel2)',
                  border: '1px solid var(--border)',
                }}>{sym}</button>
            ))}
          </div>
        </div>
        {chartData.length < 2 ? (
          <div className="flex items-center justify-center font-mono text-[11px]" style={{ color: 'var(--textFaint)', height: 220 }}>
            Collecting ticks…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chartUp ? '#1fe3a8' : '#ff5470'} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={chartUp ? '#1fe3a8' : '#ff5470'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1c232d" vertical={false} />
              <XAxis dataKey="t" hide />
              <YAxis domain={['dataMin', 'dataMax']} tick={{ fill: '#526078', fontSize: 10 }} width={64}
                tickFormatter={(v) => fmtPrice(chartSymbol, v)} />
              <Tooltip contentStyle={{ background: '#10151c', border: '1px solid #1c232d', borderRadius: 8, fontSize: 11 }}
                labelFormatter={(t) => new Date(t).toLocaleTimeString()} formatter={(v) => [fmtPrice(chartSymbol, v), chartSymbol]} />
              <Area type="monotone" dataKey="price" stroke={chartUp ? '#1fe3a8' : '#ff5470'} fill="url(#priceGrad)" strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
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

  const narrative = live ? (outlook.narrative || 'No narrative generated yet.') : null;
  const regimeRows = live ? (outlook.symbols || []).map(s => ({
    symbol: s.symbol,
    regime: s.regime || '—',
    tradeability: s.tradeability,
    sessionStatus: s.sessionStatus,
    sessionReason: s.sessionReason || s.sessionStatus,
    dataNote: s.dataNote,
    candleCount: s.candleCount,
    regimeTimeframe: s.regimeTimeframe,
  })) : null;
  const cotRows = live
    ? (outlook.symbols || []).filter(s => s.institutionalPositioning).map(s => ({
        currency: s.symbol,
        nonComm: s.institutionalPositioning.largeSpecNet ?? 0,
        signal: s.institutionalPositioning.signal,
        note: s.institutionalPositioning.note,
      }))
    : null;
  // Prefer Tier-1, fall back to Tier-2 so the panel is not blank on quiet weeks
  const calendarRows = live
    ? (() => {
        const pool = [
          ...(outlook.today?.tier1Events || []),
          ...(outlook.week?.allEvents || []),
          ...(outlook.week?.tier1Events || []),
          ...(outlook.week?.tier2Events || []),
          ...(outlook.week?.tier3Events || []),
        ];
        // de-dupe by name+currency
        const seen = new Set();
        const unique = [];
        for (const e of pool) {
          const k = `${e.name}|${e.currency}|${e.hoursAway}`;
          if (seen.has(k)) continue;
          seen.add(k);
          unique.push(e);
        }
        return unique.slice(0, 10).map(e => ({
          event: `${e.name} (${e.currency})`,
          impact: e.tier === 'TIER_1' ? 'high' : e.tier === 'TIER_2' ? 'medium' : 'low',
          mins: Math.max(0, Math.round((e.hoursAway || 0) * 60)),
          tier: e.tier || 'TIER_3',
        }));
      })()
    : null;

  return (
    <div className="p-4 space-y-4">
      <div className="omni-panel p-4">
        <SectionHeader icon={Globe2} title="Market Outlook" sub={live ? 'live briefing · regime + session + calendar' : undefined} />
        {narrative ? (
          <ul className="space-y-1.5 list-none p-0 m-0">
            {String(narrative).split(/(?<=\.)\s+/).filter(Boolean).map((line, i) => (
              <li key={i} className="text-[12px] leading-relaxed flex gap-2" style={{ color: 'var(--textDim)' }}>
                <span style={{ color: 'var(--emerald)', flexShrink: 0 }}>▸</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : <WaitingForBackend height={60} />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={Activity} title="Regime & Tradeability" sub={live ? 'per symbol · needs OHLC candles' : undefined} />
          {regimeRows === null ? <WaitingForBackend /> : regimeRows.length === 0 ? (
            <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No symbol data yet.</div>
          ) : (
            <div className="space-y-2">
              {regimeRows.map(r => {
                const tb = r.tradeability;
                const tbNum = Number(tb);
                const tbLabel = Number.isFinite(tbNum) ? String(Math.round(tbNum))
                  : (tb === 'high' || tb === 'low' || tb === 'medium' ? tb : (r.regime === '—' ? '—' : '—'));
                const tone = Number.isFinite(tbNum)
                  ? (tbNum >= 65 ? 'up' : tbNum <= 35 ? 'down' : 'neutral')
                  : (tb === 'high' ? 'up' : tb === 'low' ? 'down' : 'neutral');
                return (
                  <div key={r.symbol} className="py-1.5 border-b" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex items-center justify-between font-mono text-[11px]">
                      <span style={{ color: 'var(--text)' }}>{r.symbol}</span>
                      <span style={{ color: 'var(--textDim)' }}>{r.regime}{r.regimeTimeframe ? ` · ${r.regimeTimeframe}` : ''}</span>
                      <Pill tone={tone}>{tbLabel}</Pill>
                    </div>
                    {r.regime === '—' && r.dataNote ? (
                      <div className="font-mono text-[9px] mt-0.5" style={{ color: 'var(--gold)' }}>{r.dataNote}</div>
                    ) : null}
                    {r.sessionStatus && r.sessionStatus !== 'CLEAR' ? (
                      <div className="font-mono text-[9px] mt-0.5" style={{ color: 'var(--textFaint)' }}>Session: {r.sessionReason || r.sessionStatus}</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="omni-panel p-4">
          <SectionHeader icon={ShieldAlert} title="CFTC COT Positioning" sub={live ? 'large-spec net · FX futures only' : undefined} />
          {cotRows === null ? <WaitingForBackend /> : cotRows.length === 0 ? (
            <div className="font-mono text-[11px] leading-relaxed" style={{ color: 'var(--textFaint)' }}>
              No COT rows for current symbols. COT covers CME FX/commodity futures (e.g. EUR, GBP, gold contracts) when the CFTC feed has ingested a weekly report — not crypto spot pairs.
            </div>
          ) : (
            <div className="space-y-2">
              {cotRows.map(c => (
                <div key={c.currency} className="flex items-center justify-between font-mono text-[11px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                  <span style={{ color: 'var(--text)' }}>{c.currency}</span>
                  <span style={{ color: 'var(--textDim)' }}>{c.nonComm}</span>
                  <Pill tone={String(c.signal || '').toLowerCase().includes('long') ? 'up' : String(c.signal || '').toLowerCase().includes('short') ? 'down' : 'neutral'}>{c.signal || '—'}</Pill>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={Clock} title="Economic Calendar" sub={live ? 'Tier-1 / Tier-2 · session filter' : undefined} />
        {calendarRows === null ? <WaitingForBackend /> : calendarRows.length === 0 ? (
          <div className="font-mono text-[11px] leading-relaxed" style={{ color: 'var(--textFaint)' }}>
            No upcoming Tier-1/2 events in the loaded calendar. Events appear after Finnhub/FMP/Myfxbook calendar poll succeeds (needs API keys where required).
          </div>
        ) : (
          <div className="space-y-1.5">
            {calendarRows.map((e, i) => (
              <div key={i} className="flex items-center gap-2 font-mono text-[11px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                <Pill tone={e.impact === 'high' ? 'down' : e.impact === 'medium' ? 'warn' : 'neutral'}>{e.impact}</Pill>
                <span className="flex-1" style={{ color: 'var(--textDim)' }}>{e.event}</span>
                <span style={{ color: 'var(--textFaint)' }}>in {Math.floor(e.mins / 60)}h{e.mins % 60}m</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── NEWS ───────────────────────────────────────────────────────────── */
function NewsTab({ news, mode }) {
  const live = mode === 'live' && Array.isArray(news);
  const items = live ? news : null;

  // Biggest / most recent story first as the main headline
  const major = items && items.length ? items[0] : null;
  const rest = items && items.length > 1 ? items.slice(1) : [];

  const when = (dt) => {
    if (!dt) return '';
    // support both seconds and milliseconds
    const ms = dt < 1e12 ? dt * 1000 : dt;
    return timeAgo(ms);
  };

  return (
    <div className="p-4 space-y-3">
      <SectionHeader icon={Newspaper} title="Headlines" sub={live ? 'Yahoo Finance + Finnhub · live' : undefined} />

      {items === null ? (
        <div className="omni-panel p-4"><WaitingForBackend height={200} /></div>
      ) : items.length === 0 ? (
        <div className="omni-panel p-4 font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No news yet — wait a few seconds for Yahoo to load.</div>
      ) : (
        <>
          {major && (
            <a href={major.url || undefined} target={major.url ? '_blank' : undefined} rel="noreferrer"
              className="omni-panel p-4 block" style={{ textDecoration: 'none', borderColor: 'var(--emerald)' }}>
              <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--emerald)' }}>Major story</div>
              <div className="flex gap-4 items-start">
                {major.image ? (
                  <img src={major.image} alt="" className="rounded object-cover flex-shrink-0"
                    style={{ width: 120, height: 80, background: 'var(--panel2)' }}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="text-[16px] font-semibold leading-snug" style={{ color: 'var(--text)' }}>{major.headline}</div>
                  {major.summary ? <div className="text-[12px] mt-2 line-clamp-3" style={{ color: 'var(--textDim)' }}>{major.summary}</div> : null}
                  <div className="font-mono text-[10px] mt-2 uppercase" style={{ color: 'var(--textFaint)' }}>
                    {major.source || 'News'} · {when(major.datetime)} ago
                  </div>
                </div>
              </div>
            </a>
          )}

          <div className="omni-panel p-4">
            <div className="space-y-0.5 max-h-[520px] overflow-y-auto omni-scroll">
              {rest.map((n, i) => (
                <a key={i} href={n.url || undefined} target={n.url ? '_blank' : undefined} rel="noreferrer"
                  className="omni-row flex items-start gap-3 px-2 py-2.5 rounded border-b" style={{ borderColor: 'var(--border)', textDecoration: 'none', cursor: n.url ? 'pointer' : 'default' }}>
                  {n.image ? (
                    <img src={n.image} alt="" loading="lazy" className="rounded object-cover flex-shrink-0"
                      style={{ width: 64, height: 48, background: 'var(--panel2)' }}
                      onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  ) : (
                    <div className="flex items-center justify-center rounded flex-shrink-0" style={{ width: 64, height: 48, background: 'var(--panel2)' }}>
                      <Newspaper size={16} style={{ color: 'var(--textFaint)' }} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] leading-snug" style={{ color: 'var(--text)' }}>{n.headline}</div>
                    <div className="font-mono text-[9px] uppercase mt-1" style={{ color: 'var(--textFaint)' }}>
                      {n.source || 'News'} · {when(n.datetime)} ago
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}


/* ── MONITOR ────────────────────────────────────────────────────────── */
function MonitorTab({ auditLog, feedHealth, uptimeSec, mode, fetchErrors }) {
  const liveByName = new Map();
  for (const f of (feedHealth || [])) {
    liveByName.set(f.name, f);
    const short = String(f.name || '').replace(/Feed$/i, '');
    if (short && short !== f.name) liveByName.set(short, f);
  }
  const feeds = FEEDS.map(f => {
    if (f.status === 'inert') return f;
    const live = liveByName.get(f.name);
    if (mode !== 'live' || !live) return f;
    const status = live.status === 'connected' ? 'live'
      : live.status === 'disconnected' ? 'down'
      : live.connected === true ? 'live'
      : live.connected === false ? 'down'
      : 'unknown';
    return { ...f, status };
  });
  const uptimeLabel = mode === 'live' && uptimeSec != null
    ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
    : null;
  const activeErrors = Object.entries(fetchErrors || {}).filter(([, v]) => v);
  const liveCount = feeds.filter(f => f.status === 'live').length;

  return (
    <div className="p-4 space-y-4">
      {activeErrors.length > 0 && (
        <div className="omni-panel p-4" style={{ borderColor: 'var(--coral)' }}>
          <SectionHeader icon={ShieldAlert} title="Problems" sub={`${activeErrors.length} API issue(s)`} />
          <div className="space-y-1.5">
            {activeErrors.map(([endpoint, message]) => (
              <div key={endpoint} className="flex items-center gap-2 font-mono text-[11px]">
                <span className="w-28 shrink-0" style={{ color: 'var(--text)' }}>/api/{endpoint}</span>
                <span style={{ color: 'var(--coral)' }}>{String(message)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="omni-panel p-4">
        <SectionHeader
          icon={Database}
          title="Live feeds"
          sub={`${liveCount}/${feeds.length} live${uptimeLabel ? ` · up ${uptimeLabel}` : ''}`}
        />
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
              <div className="font-mono text-[9px] mt-1 uppercase" style={{ color: 'var(--textDim)' }}>
                {f.status === 'live' ? 'connected' : f.status === 'down' ? 'down' : f.status === 'inert' ? 'off' : 'waiting'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={ScrollText} title="What the system checked" sub="each pass — signal or no signal" />
        {!Array.isArray(auditLog) || auditLog.length === 0 ? (
          <div className="font-mono text-[11px] leading-relaxed" style={{ color: 'var(--textFaint)' }}>
            No checks logged yet. This list fills when the system scores each pair (after candle data loads).
          </div>
        ) : (
          <div className="space-y-1 max-h-72 overflow-y-auto omni-scroll">
            {auditLog.map((e, idx) => {
              const reasons = Array.isArray(e.reasons) ? e.reasons
                : e.blockedReason ? [e.blockedReason]
                : e.action ? [String(e.action)]
                : ['checked'];
              return (
                <div key={e.id || idx} className="flex items-start gap-2 font-mono text-[10px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                  <span style={{ color: 'var(--textFaint)' }} className="w-10 shrink-0">{timeAgo(e.timestamp || Date.now())}</span>
                  <span style={{ color: 'var(--text)' }} className="w-16 shrink-0">{e.symbol || '—'}</span>
                  {e.fired || e.signalFired
                    ? <CheckCircle2 size={11} style={{ color: 'var(--emerald)', marginTop: 1, flexShrink: 0 }} />
                    : <XCircle size={11} style={{ color: 'var(--textFaint)', marginTop: 1, flexShrink: 0 }} />}
                  <span style={{ color: 'var(--textDim)' }} className="min-w-0 break-words">{reasons.join(', ')}</span>
                </div>
              );
            })}
          </div>
        )}
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

function biasPlain(bias) {
  if (bias === 'BUY' || bias === 'LONG' || bias === 'LONG_LEANING') return 'Buy lean';
  if (bias === 'SELL' || bias === 'SHORT' || bias === 'SHORT_LEANING') return 'Sell lean';
  return 'Wait';
}

function HeatTab({ heatmapTiles, mode, sentiment }) {
  const live = mode === 'live' && Array.isArray(heatmapTiles);
  const fg = sentiment?.fearGreed;

  if (live) {
    return (
      <div className="p-4 space-y-4">
        {fg && (
          <div className="omni-panel p-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <SectionHeader icon={Flame} title="Crypto mood" sub="Fear & Greed index · free data" />
              <p className="text-[12px] mt-1" style={{ color: 'var(--textDim)' }}>
                A low number means traders are scared. A high number means they are greedy.
              </p>
            </div>
            <div className="text-right">
              <div className="font-mono text-3xl font-bold" style={{ color: fg.value <= 40 ? 'var(--coral)' : fg.value >= 60 ? 'var(--emerald)' : 'var(--gold)' }}>
                {fg.value}
              </div>
              <div className="font-mono text-[11px] uppercase" style={{ color: 'var(--textFaint)' }}>{fg.label}</div>
            </div>
          </div>
        )}
        <div className="omni-panel p-4">
          <SectionHeader icon={Flame} title="Market heat" sub="Which pairs look hot or cold right now" />
          <p className="text-[11px] mb-3" style={{ color: 'var(--textFaint)' }}>
            Higher score = more interesting setup or stronger move. Needs live candles to fill in.
          </p>
          {heatmapTiles.length === 0 ? (
            <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
              Nothing to show yet. Heat fills in after the system has candle data and ranks each symbol.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
              {heatmapTiles.map(t => {
                const sign = tileBiasSign(t.bias);
                return (
                  <div key={t.symbol} className="omni-panel2 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[11px]" style={{ color: 'var(--text)' }}>{t.symbol}</span>
                      <span className="font-mono text-[9px]" style={{ color: 'var(--textFaint)' }}>rank #{t.overallRank}</span>
                    </div>
                    <div className="rounded px-2 py-2 mb-2 flex items-center justify-between" style={{ background: heatColor(sign * (t.heatScore / 100)) }}>
                      <span className="font-mono text-lg font-bold" style={{ color: 'var(--text)' }}>{Math.round(t.heatScore)}</span>
                      <span className="font-mono text-[9px] uppercase" style={{ color: 'var(--textDim)' }}>{t.bucket || '—'}</span>
                    </div>
                    <div className="font-mono text-[10px] flex items-center justify-between" style={{ color: 'var(--textDim)' }}>
                      <span>{biasPlain(t.bias)}</span>
                      {t.opportunity && <Pill tone={t.opportunity.fired ? 'up' : 'neutral'}>{t.opportunity.grade || '—'}</Pill>}
                    </div>
                    {t.relativeStrength && (
                      <div className="font-mono text-[9px] mt-1" style={{ color: 'var(--textFaint)' }}>
                        Strength #{t.relativeStrength.rank} · {fmtPct(t.relativeStrength.changePct)}
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
    <div className="p-4">
      <div className="omni-panel p-4">
        <SectionHeader icon={Flame} title="Market Heat Map" />
        <WaitingForBackend height={200} />
      </div>
    </div>
  );
}

/* ── VALID ──────────────────────────────────────────────────────────── */
function ValidTab({ signals, journalStats, learningProfiles, mode }) {
  const live = mode === 'live';

  if (!live) {
    return (
      <div className="p-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={FlaskConical} title="Validation" />
          <WaitingForBackend height={240} />
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


  const hasValidationData = validated.length > 0;
  const hasAnyValidContent = hasValidationData || hasJournal || (learningProfiles && learningProfiles.length > 0);

  const mcChartData = validated.slice(0, 20).reverse().map((s, i) => ({ label: `${s.symbol}#${i + 1}`, prob: s.validation.monteCarlo?.winProbability ?? 0 }));

  return (
    <div className="p-4 space-y-4">
      {!hasAnyValidContent && (
        <div className="omni-panel p-4">
          <SectionHeader icon={FlaskConical} title="Validation" sub="waits on live signals + closed outcomes" />
          <p className="text-[12px] leading-relaxed" style={{ color: 'var(--textDim)' }}>
            This tab is empty on purpose until the pipeline scores signals and you (or the journal) record outcomes.
            Walk-forward / Bayesian / Monte Carlo fill per scored signal; Kelly and Learned Setups need closed trades.
            They are not broken — there is simply nothing to validate yet. Focus on Signals + MT5 candles first.
          </p>
        </div>
      )}
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
function TapeTab({ signals, prices, mode }) {
  const approved = useMemo(() => signals.filter(s => s.gate.status === 'approved').slice(0, 20), [signals]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-4">
        <StatCard label="Approved Signals" value={approved.length} icon={Activity} />
        <StatCard label="Avg Score" value={approved.length ? Math.round(approved.reduce((a, s) => a + s.score, 0) / approved.length) : '—'} icon={GaugeIcon} accent="var(--blue)" />
      </div>
      <div className="omni-panel overflow-hidden">
        <SectionHeader icon={ScrollText} title="Signal Queue" sub="approved, awaiting/pending EA execution — no live fills endpoint yet" />
        {mode !== 'live' ? <WaitingForBackend height={200} /> : approved.length === 0 ? (
          <div className="p-4 font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No approved signals yet.</div>
        ) : (
          <>
            <div className="grid grid-cols-[70px_46px_44px_1fr_60px] gap-2 px-3 py-2 font-mono text-[9px] uppercase tracking-wider border-b border-t" style={{ color: 'var(--textFaint)', borderColor: 'var(--border)' }}>
              <span>Symbol</span><span>TF</span><span>Dir</span><span>Entry</span><span>Score</span>
            </div>
            <div className="max-h-96 overflow-y-auto omni-scroll">
              {approved.map(s => (
                <div key={s.id} className="omni-row grid grid-cols-[70px_46px_44px_1fr_60px] gap-2 px-3 py-2 font-mono text-[11px] border-b items-center" style={{ borderColor: 'var(--border)' }}>
                  <span style={{ color: 'var(--text)' }}>{s.symbol}</span>
                  <span style={{ color: 'var(--textDim)' }}>{s.timeframe}</span>
                  <span style={{ color: s.action === 'BUY' ? 'var(--emerald)' : 'var(--coral)' }}>{s.action}</span>
                  <span style={{ color: 'var(--textDim)' }}>{fmtPrice(s.symbol, s.entry)}</span>
                  <span style={{ color: 'var(--gold)' }}>{s.score}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── RISK ───────────────────────────────────────────────────────────── */
function RiskTab({ prices, changes, accountBalance, relativeStrength, mode }) {
  const [balance, setBalance] = useState(accountBalance ?? 10000);
  const [balanceTouched, setBalanceTouched] = useState(false);
  useEffect(() => {
    if (!balanceTouched && accountBalance != null) setBalance(accountBalance);
  }, [accountBalance, balanceTouched]);
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

  const sessions = [
    { name: 'Asia', start: 0, end: 8 }, { name: 'London', start: 8, end: 16 }, { name: 'New York', start: 13, end: 21 },
  ];
  const hour = new Date().getUTCHours();
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
              <input type="number" value={balance} onChange={e => { setBalance(+e.target.value); setBalanceTouched(true); }}
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
          <SectionHeader icon={ShieldAlert} title="Drawdown Circuit Breaker" sub="no live risk-manager endpoint yet" />
          <WaitingForBackend height={140} label="institutional-risk-manager.js tracks this internally — needs a REST/socket endpoint to reach the frontend" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={Layers} title="Portfolio Exposure" sub="no live fills endpoint yet" />
          <WaitingForBackend height={140} label="Needs the same EA position-fills endpoint noted on the Tape tab" />
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
          {activeTab === 'DASH' && <DashTab signals={feed.signals} equityCurve={feed.equityCurve} equityCurveLive={feed.equityCurveLive} accountBalance={feed.accountBalance} journalStats={feed.journalStats} prices={feed.prices} changes={feed.changes} stats={feed.stats} mode={feed.mode} />}
          {activeTab === 'SIGNALS' && <SignalsTab signals={feed.signals} />}
          {activeTab === 'INTEL' && <IntelTab now={feed.now} outlook={feed.outlook} mode={feed.mode} />}
          {activeTab === 'NEWS' && <NewsTab news={feed.news} mode={feed.mode} />}
          {activeTab === 'MONITOR' && <MonitorTab auditLog={feed.auditLog} feedHealth={feed.feedHealth} uptimeSec={feed.uptimeSec} mode={feed.mode} fetchErrors={feed.fetchErrors} />}
          {activeTab === 'HEAT' && <HeatTab heatmapTiles={feed.heatmapTiles} mode={feed.mode} sentiment={feed.sentiment} />}
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
