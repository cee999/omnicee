import React, { useState, useEffect, useMemo, useRef, useCallback, Component } from 'react';
import {
  BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers,
  CrosshairMode, LineStyle,
} from 'lightweight-charts';
import {
  LayoutDashboard, Radio, Globe2, Activity, Flame, FlaskConical,
  ScrollText, ShieldAlert, ChevronRight, ChevronDown,
  TrendingUp, CheckCircle2, XCircle,
  Circle, Clock, Zap, Database,
  Terminal, Newspaper, Gauge as GaugeIcon,
  Layers, Target, DollarSign, SlidersHorizontal, Maximize2, Minimize2,
  Download, Share2, Volume2, VolumeX,
} from 'lucide-react';

const SYMBOLS = ['XAUUSD', 'BTCUSDT', 'ETHUSDT', 'EURUSD', 'GBPUSD', 'USDJPY', 'USOIL', 'UUP'];
const SYMBOL_LABEL = { UUP: 'DXY', XAUUSD: 'GOLD', USOIL: 'OIL', BTCUSDT: 'BTC', ETHUSDT: 'ETH' };
function symLabel(s) { return SYMBOL_LABEL[s] || s; }

const TIMEFRAMES = ['M15', 'H1', 'H4', 'D1'];
const AGENTS = ['SMC', 'MTF', 'Momentum', 'VolumeOI', 'Sentiment', 'Pattern', 'Fractal', 'Microstructure'];

const BASE_PRICE = {
  EURUSD: 1.0842, GBPUSD: 1.2694, USDJPY: 156.32,
  XAUUSD: 2418.30,
  USOIL: 70,
  UUP: 28, BTCUSDT: 67420.5, ETHUSDT: 3512.8,
};
const DECIMALS = { EURUSD: 4, GBPUSD: 4, USDJPY: 3, XAUUSD: 2, USOIL: 2, UUP: 3, BTCUSDT: 1, ETHUSDT: 2 };
const PIP = { EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01, XAUUSD: 0.1, BTCUSDT: 10, ETHUSDT: 1 };

/* ── Audio feedback (fixes "dead silent" UX on mobile / Mini App) ─────────
 * Short Web-Audio chimes for new high-quality signals. No external assets.
 * Preference persisted in localStorage. Respects system mute and user toggle.
 */
const SOUND_PREF_KEY = 'omnicee_sound_enabled';
function loadSoundPref() {
  try {
    const v = localStorage.getItem(SOUND_PREF_KEY);
    if (v === null) return true; // default ON so the system is not silent
    return v === '1' || v === 'true';
  } catch (_) { return true; }
}
function saveSoundPref(on) {
  try { localStorage.setItem(SOUND_PREF_KEY, on ? '1' : '0'); } catch (_) {}
}

let _audioCtx = null;
function getAudioCtx() {
  if (typeof window === 'undefined') return null;
  if (!_audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) _audioCtx = new AC();
  }
  return _audioCtx;
}

/** Play a short directional chime. direction: 'BUY' | 'SELL' | 'neutral' */
function playSignalChime(direction = 'neutral') {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    // Distinct tones: higher for BUY, lower for SELL
    const base = direction === 'BUY' ? 880 : direction === 'SELL' ? 440 : 660;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.exponentialRampToValueAtTime(base * 1.25, now + 0.08);
    osc.frequency.exponentialRampToValueAtTime(base * 0.9, now + 0.18);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch (_) { /* audio optional */ }
}

// FIX: the Agent Breakdown panel renders `{s.agreeCount}/8 aligned`, but agreeCount was only ever computed by the demo signal generator further down — api/server.js's db.compactSignal() (the shape both...
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
  { name: 'MT5',          kind: 'Exness broker', status: 'unknown', note: 'attach OmniceeEA' },
  { name: 'Deriv',        kind: 'live ticks+OHLC', status: 'unknown' },
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmtPrice(symbol, v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  const d = DECIMALS[symbol] ?? 2;
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}
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

function heatColor(v) {
  const t = clamp(v, -1, 1);
  if (t >= 0) {
    const g = Math.round(20 + t * 100);
    return `rgba(31,227,168,${0.12 + t * 0.55})`;
  }
  const a = Math.abs(t);
  return `rgba(255,84,112,${0.12 + a * 0.55})`;
}

function ThemeStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&family=Orbitron:wght@600;800&display=swap');
      /* ui-ux-pro-max + omnicee-system: OLED dense terminal (density 9, motion 3) */
      .omni-root {
        --void: #020617; --panel: #0b0f14; --panel2: #0e1223;
        --border: #1e293b; --borderBright: #334155;
        --emerald: #22c55e; --emeraldDim: #15803d;
        --gold: #f0b429; --coral: #ef4444; --blue: #5ea8ff;
        --cyan: #22d3ee; --violet: #a78bfa;
        --text: #f8fafc; --textDim: #94a3b8; --textFaint: #64748b;
        --ring: #22c55e;
        --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
        background: var(--void); color: var(--text);
        font-family: 'Inter', system-ui, sans-serif;
        font-size: 16px;
        line-height: 1.45;
        width: 100%;
        max-width: 100vw;
        min-height: 100%;
        min-height: 100dvh;
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow-x: hidden;
        overflow-y: hidden;
        box-sizing: border-box;
        padding-left: env(safe-area-inset-left, 0px);
        padding-right: env(safe-area-inset-right, 0px);
        padding-top: env(safe-area-inset-top, 0px);
        color-scheme: dark;
      }
      .omni-root .font-display { font-family: 'Orbitron', sans-serif; letter-spacing: 0.06em; }
      .omni-root .font-mono { font-family: 'JetBrains Mono', monospace; }
      .omni-panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 10px;
        max-width: 100%;
        transition: border-color 180ms ease, box-shadow 180ms ease;
      }
      .omni-panel:hover { border-color: var(--borderBright); }
      .omni-panel2 {
        background: var(--panel2);
        border: 1px solid var(--border);
        border-radius: 8px;
        max-width: 100%;
      }
      .omni-badge {
        display: inline-flex; align-items: center; gap: 4px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
        padding: 2px 8px; border-radius: 999px;
        border: 1px solid var(--border); background: var(--panel2);
      }
      .omni-badge-buy { color: var(--emerald); border-color: rgba(34,197,94,0.35); background: rgba(34,197,94,0.08); }
      .omni-badge-sell { color: var(--coral); border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.08); }
      .omni-badge-wait { color: var(--textDim); }
      .omni-main { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; }
      .omni-scroll { -webkit-overflow-scrolling: touch; }
      .omni-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
      .omni-scroll::-webkit-scrollbar-thumb { background: var(--borderBright); border-radius: 3px; }
      .omni-scroll::-webkit-scrollbar-track { background: transparent; }
      @keyframes omni-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      .omni-pulse { animation: omni-pulse 1.8s ease-in-out infinite; }
      @keyframes omni-flash-up { 0% { background: rgba(31,227,168,0.35); } 100% { background: transparent; } }
      @keyframes omni-flash-down { 0% { background: rgba(255,84,112,0.35); } 100% { background: transparent; } }
      .omni-flash-up { animation: omni-flash-up 0.7s ease-out; }
      .omni-flash-down { animation: omni-flash-down 0.7s ease-out; }
      .omni-tab-active { box-shadow: inset 0 2px 0 var(--emerald); background: var(--panel2); }
      .omni-ticker-wrap { height: 30px; max-width: 100%; overflow: hidden; flex-shrink: 0; }
      .omni-ticker-track { animation: omni-ticker 28s linear infinite; width: max-content; }
      .omni-ticker-wrap:hover .omni-ticker-track,
      .omni-ticker-wrap:active .omni-ticker-track { animation-play-state: paused; }
      @keyframes omni-ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      .omni-cmd::placeholder { color: var(--textFaint); }
      .omni-row:hover { background: rgba(255,255,255,0.02); }
      .omni-nav {
        flex-shrink: 0;
        display: flex;
        width: 100%;
        border-top: 1px solid var(--border);
        background: var(--panel);
        padding-bottom: env(safe-area-inset-bottom, 0px);
        /* App-like bottom bar: tall enough for thumbs */
        min-height: 56px;
      }
      .omni-nav button {
        flex: 1 1 0;
        min-width: 0;
        min-height: 52px;
        padding: 6px 2px 8px;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      .omni-nav button:active {
        background: var(--panel2) !important;
      }
      /* Press feedback for rows / chips (mobile has no hover) */
      .omni-row:active,
      .omni-chip:active {
        background: rgba(255,255,255,0.06) !important;
      }
      .omni-chip {
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
        user-select: none;
      }
      /* Fluid chart: fills parent, scales with viewport */
      .omni-chart-shell {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-width: 0;
        min-height: 0;
      }
      .omni-chart-canvas-wrap {
        position: relative;
        width: 100%;
        min-width: 0;
        flex: 1 1 auto;
        min-height: clamp(180px, 36vh, 480px);
        height: clamp(180px, 36vh, 480px);
      }
      /* Dense desktop grids → horizontal scroll on narrow viewports so nothing is clipped */
      .omni-table-scroll {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior-x: contain;
      }
      .omni-table-scroll > .omni-table-grid {
        min-width: 640px; /* keeps columns readable; parent scrolls */
      }
      @media (max-width: 480px) {
        .omni-hide-xs { display: none !important; }
        .omni-panel { border-radius: 8px; }
        /* Prefer slightly larger interactive type on phones */
        .omni-nav span { font-size: 10px !important; letter-spacing: 0.04em; }
        .omni-chip { font-size: 11px !important; padding: 8px 12px !important; min-height: 44px; gap: 8px; }
        /* Mobile-first: chart must be tall enough to read — was too short (32vh) */
        .omni-chart-canvas-wrap {
          min-height: clamp(240px, 48vh, 520px);
          height: clamp(240px, 48vh, 520px);
        }
        /* Larger row hit targets on phone */
        .omni-row { min-height: 44px; }
        /* Signal cards alternative (used when we switch layout) */
        .omni-signal-card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 12px;
          border-bottom: 1px solid var(--border);
        }
      }
      @media (max-width: 380px) {
        .omni-nav span { font-size: 9px !important; }
      }
      /* Prefer reduced motion when user requests it (ui-ux-pro-max) */
      @media (prefers-reduced-motion: reduce) {
        .omni-pulse, .omni-ticker-track, .omni-flash-up, .omni-flash-down {
          animation: none !important;
        }
      }
      /* Focus + pointer affordances — never remove focus rings */
      .omni-root button:focus-visible,
      .omni-root a:focus-visible,
      .omni-root input:focus-visible,
      .omni-root [tabindex]:focus-visible {
        outline: 2px solid var(--emerald);
        outline-offset: 2px;
      }
      .omni-root button:not(:disabled),
      .omni-root a,
      .omni-root .omni-chip,
      .omni-root .omni-row {
        cursor: pointer;
      }
      .omni-root button:disabled { cursor: not-allowed; }
      /* Stable skeleton for loading panels — avoids blank/freeze perception */
      @keyframes omni-skeleton {
        0% { background-position: 100% 0; }
        100% { background-position: -100% 0; }
      }
      .omni-skeleton {
        background: linear-gradient(90deg, var(--panel2) 25%, var(--border) 50%, var(--panel2) 75%);
        background-size: 200% 100%;
        animation: omni-skeleton 1.4s ease-in-out infinite;
        border-radius: 6px;
      }
      @media (prefers-reduced-motion: reduce) {
        .omni-skeleton { animation: none; background: var(--panel2); }
      }
      /* When full chart is open, hide ticker + top bar so symbols/TF are not covered */
      body.omni-chart-expanded .omni-topbar,
      body.omni-chart-expanded .omni-ticker-wrap,
      body.omni-chart-expanded .omni-nav {
        display: none !important;
      }
      .omni-chart-shell.is-expanded {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        max-height: 100dvh;
        z-index: 9999 !important;
      }
      .omni-chart-shell.is-expanded .omni-chart-canvas-wrap {
        flex: 1 1 auto;
        min-height: 0;
        height: auto;
      }
      .omni-chart-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      .omni-home-grid {
        display: grid;
        width: 100%;
        gap: 0.5rem;
        grid-template-columns: 1fr;
      }
      @media (min-width: 900px) {
        .omni-home-grid {
          grid-template-columns: minmax(0, 1fr) minmax(200px, 28%);
          align-items: stretch;
        }
        .omni-chart-canvas-wrap {
          min-height: clamp(260px, 48vh, 560px);
          height: clamp(260px, 48vh, 560px);
        }
      }
      @media (min-width: 1200px) {
        .omni-chart-canvas-wrap {
          min-height: clamp(300px, 52vh, 640px);
          height: clamp(300px, 52vh, 640px);
        }
      }
    `}</style>
  );
}

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
function WaitingForBackend({ height = 140, label = 'Loading live data…' }) {
  const h = height === 'auto' ? 140 : Number(height) || 140;
  return (
    <div
      className="flex flex-col justify-center gap-3 px-3 py-3 font-mono text-[11px]"
      role="status"
      aria-busy="true"
      aria-live="polite"
      style={{ minHeight: h, height: height === 'auto' ? undefined : h, color: 'var(--textDim)', background: 'var(--panel2)', borderRadius: 8, border: '1px dashed var(--border)' }}
    >
      <div className="flex items-center gap-2" style={{ color: 'var(--emerald)' }}>
        <Circle size={7} fill="currentColor" className="omni-pulse" />
        <span className="uppercase tracking-wider text-[10px]">OMNICEE</span>
        <span style={{ color: 'var(--text)' }}>{label}</span>
      </div>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <div className="omni-skeleton" style={{ height: 10, width: '88%' }} />
        <div className="omni-skeleton" style={{ height: 10, width: '64%' }} />
        <div className="omni-skeleton" style={{ height: 10, width: '76%' }} />
      </div>
      <div className="text-[10px]" style={{ color: 'var(--textFaint)' }}>Desk stays open — data fills in as feeds connect</div>
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

const SESSION_KEY = 'omnicee_session_v1';
const OMNI_CACHE_KEY = 'omnicee_desk_cache_v1';
function loadDeskCache() {
  try {
    const raw = localStorage.getItem(OMNI_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || typeof c !== 'object') return null;
    return c;
  } catch (_) { return null; }
}
function saveDeskCache(partial) {
  try {
    const prev = loadDeskCache() || {};
    const next = { ...prev, ...partial, savedAt: Date.now() };
    localStorage.setItem(OMNI_CACHE_KEY, JSON.stringify(next));
  } catch (_) {}
}


function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.token || !s?.email) return null;
    if (s.expiresAt && Date.parse(s.expiresAt) < Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch (_) { return null; }
}

function setSession(s) {
  if (!s) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (APP_TOKEN) h['x-app-token'] = APP_TOKEN;
  const initData = getTelegramInitData();
  if (initData) h['x-telegram-init-data'] = initData;
  const session = getSession();
  if (session?.token) {
    h['Authorization'] = `Bearer ${session.token}`;
    h['x-session-token'] = session.token;
  }
  return h;
}


/** Browser fetch for Forex Factory — Render's IP is often rate-limited (429). */
async function fetchCalendarFromBrowser() {
  const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`FF HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    const now = Date.now();
    const COUNTRY = {
      USD: 'USD', US: 'USD', EUR: 'EUR', EU: 'EUR', GBP: 'GBP', UK: 'GBP',
      JPY: 'JPY', JP: 'JPY', AUD: 'AUD', CAD: 'CAD', NZD: 'NZD', CHF: 'CHF', CNY: 'CNY',
    };
    return rows.map((e) => {
      const time = e.date ? new Date(e.date).getTime() : NaN;
      const country = e.country || '';
      return {
        name: e.title || 'Event',
        currency: COUNTRY[country] || COUNTRY[String(country).toUpperCase()] || (country.length === 3 ? country : 'USD'),
        time,
        impact: e.impact || null,
        forecast: e.forecast || null,
        previous: e.previous || null,
        source: 'forex-factory-browser',
        hoursAway: Number.isFinite(time) ? Math.round((time - now) / 3600000 * 10) / 10 : null,
      };
    }).filter((e) => e.name && Number.isFinite(e.time) && e.time >= now - 12 * 3600000)
      .sort((a, b) => {
        const rank = (i) => {
          const x = String(i || '').toLowerCase();
          if (x === 'high') return 0;
          if (x === 'medium') return 1;
          return 2;
        };
        return rank(a.impact) - rank(b.impact) || a.time - b.time;
      })
      .slice(0, 80);
  } finally {
    clearTimeout(timer);
  }
}

async function omniFetch(path, timeoutMs = 12000, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers: authHeaders(),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (res.status === 401) {
      // Expired/invalid session must not freeze the desk on "loading" forever.
      try { setSession(null); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('omnicee:auth-required')); } catch (_) {}
      const err = new Error('AUTH_REQUIRED');
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    if (res.status === 409 || res.status === 429) {
      const err = new Error(`HTTP ${res.status}`);
      err.soft = true;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Unauthenticated reachability probe — never attach session headers. */
async function probeBackend(timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + '/health', {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`health ${res.status}`);
    // Accept JSON or plain text — do not hang on parse errors
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return res.json().catch(() => ({ ok: true }));
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

function LoginGate({ onAuthed }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('email');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const requestCode = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await fetch(API_BASE + '/api/auth/email/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        const raw = data.error || `Could not send code (HTTP ${r.status})`;
        if (/only send testing|not authorized|domain|rejected this address/i.test(raw)) {
          throw new Error(
            'This Gmail cannot receive codes yet. Resend free tier only delivers to the account-owner inbox until a domain is verified. Use that email, enable ALLOW_DEV_OTP, or configure SMTP.'
          );
        }
        if (/OTP_PEPPER|Email not configured/i.test(raw)) {
          throw new Error('Server email auth is misconfigured (OTP_PEPPER / RESEND_API_KEY). Check Render env vars.');
        }
        throw new Error(raw);
      }
      setStep('code');
      setMsg(data.devCode ? `Dev code: ${data.devCode}` : 'Code sent — check inbox and spam.');
    } catch (e) {
      setErr(e.message || 'Failed to send code');
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(API_BASE + '/api/auth/email/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || 'Invalid code');
      const sess = { token: data.token, email: data.email, expiresAt: data.expiresAt };
      setSession(sess);
      onAuthed(sess);
    } catch (e) {
      setErr(e.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  // OLED institutional login (ui-ux-pro-max design system tokens)
  const bg = '#020617';
  const panel = '#0b0f14';
  const panel2 = '#0e1223';
  const border = '#1e293b';
  const text = '#f8fafc';
  const dim = '#94a3b8';
  const faint = '#64748b';
  const green = '#22c55e';
  const red = '#ef4444';

  return (
    <div style={{
      minHeight: '100vh',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
      background: bg,
      color: text,
      fontFamily: "Inter, system-ui, sans-serif",
      boxSizing: 'border-box',
      colorScheme: 'dark',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        background: panel,
        border: `1px solid ${border}`,
        borderRadius: 14,
        padding: 28,
        boxShadow: '0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(34,197,94,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: green, color: bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 16,
          }}>Ω</div>
          <div>
            <div style={{ fontSize: 16, letterSpacing: '0.18em', fontWeight: 700, color: text, fontFamily: "Orbitron, Inter, sans-serif" }}>OMNICEE</div>
            <div style={{ fontSize: 11, color: faint, marginTop: 3, letterSpacing: '0.04em' }}>Institutional signal terminal · secure login</div>
          </div>
        </div>

        <p style={{ fontSize: 13, lineHeight: 1.55, color: dim, margin: '0 0 18px' }}>
          Enter your email for a one-time code. Session stays on this device.
        </p>

        <label style={{ display: 'block', fontSize: 10, textTransform: 'uppercase', color: faint, marginBottom: 12 }}>
          Email
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@email.com"
            autoComplete="email"
            style={{
              display: 'block', width: '100%', marginTop: 6,
              padding: '12px 14px', borderRadius: 8,
              border: `1px solid ${border}`, background: panel2, color: text,
              fontSize: 14, outline: 'none', boxSizing: 'border-box',
            }}
          />
        </label>

        {step === 'code' && (
          <label style={{ display: 'block', fontSize: 10, textTransform: 'uppercase', color: faint, marginBottom: 12 }}>
            6-digit code
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              style={{
                display: 'block', width: '100%', marginTop: 6,
                padding: '12px 14px', borderRadius: 8,
                border: `1px solid ${border}`, background: panel2, color: text,
                fontSize: 20, letterSpacing: '0.35em', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </label>
        )}

        {msg ? <div role="status" style={{ fontSize: 12, color: green, marginBottom: 10 }}>{msg}</div> : null}
        {err ? <div role="alert" style={{ fontSize: 12, color: red, marginBottom: 10, lineHeight: 1.45 }}>{err}</div> : null}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {step === 'email' ? (
            <button
              type="button"
              disabled={busy || !email.includes('@')}
              onClick={requestCode}
              aria-busy={busy ? 'true' : 'false'}
              style={{
                flex: 1, padding: '12px 14px', borderRadius: 8, border: 'none',
                background: green, color: bg, fontWeight: 700, fontSize: 13,
                cursor: busy ? 'wait' : 'pointer', opacity: (busy || !email.includes('@')) ? 0.55 : 1,
                minHeight: 44,
              }}
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setStep('email'); setErr(''); setMsg(''); }}
                style={{
                  padding: '12px 14px', borderRadius: 8, border: `1px solid ${border}`,
                  background: panel2, color: dim, fontSize: 13, cursor: 'pointer',
                }}
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || code.length !== 6}
                onClick={verifyCode}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 8, border: 'none',
                  background: green, color: bg, fontWeight: 700, fontSize: 13,
                  cursor: busy ? 'wait' : 'pointer', opacity: (busy || code.length !== 6) ? 0.55 : 1,
                }}
              >
                {busy ? 'Checking…' : 'Log in'}
              </button>
            </>
          )}
        </div>

        <div style={{
          marginTop: 18, paddingTop: 14, borderTop: `1px solid ${border}`,
          fontSize: 11, lineHeight: 1.5, color: faint, textAlign: 'center',
        }}>
          <div style={{ marginBottom: 4 }}>Phone: Add to Home Screen · Desktop: install icon</div>
          <div style={{ color: dim }}>Developed by James Yelbert</div>
        </div>
      </div>
    </div>
  );
}

/* ── Live-feed hook — probes the real API once; on success it polls the
   documented REST routes, on failure it falls back to the original
   self-contained simulator so the dashboard is never just a blank
   loading screen. ──────────────────────────────────────────────────── */
function useLiveFeed() {
  const [mode, setMode] = useState('live'); // always show shell; never blank on checking
  const [now, setNow] = useState(Date.now());
  const [prices, setPrices] = useState(() => {
    const c = loadDeskCache();
    const base = Object.fromEntries(SYMBOLS.map(s => [s, null]));
    if (c?.prices) for (const s of SYMBOLS) if (c.prices[s] != null) base[s] = c.prices[s];
    return base;
  });
  const [quotes, setQuotes] = useState(() => {
    const c = loadDeskCache();
    const base = Object.fromEntries(SYMBOLS.map(s => [s, null]));
    if (c?.quotes) for (const s of SYMBOLS) if (c.quotes[s]) base[s] = c.quotes[s];
    return base;
  });
  const [calendar, setCalendar] = useState([]);
  const [levels, setLevels] = useState({});
  const [changes, setChanges] = useState(() => Object.fromEntries(SYMBOLS.map(s => [s, null])));
  const [flash, setFlash] = useState({});
  const [signals, setSignals] = useState(() => {
    const c = loadDeskCache();
    return Array.isArray(c?.signals) ? c.signals.slice(0, 40) : [];
  });
  const [auditLog, setAuditLog] = useState([]);
  const [equityCurve, setEquityCurve] = useState([]);
  const [stats, setStats] = useState(null);
  const [outlook, setOutlook] = useState(null);
  const [heatmapTiles, setHeatmapTiles] = useState(null);
  const [feedHealth, setFeedHealth] = useState(null);
  const [uptimeSec, setUptimeSec] = useState(null);
  const [eaAuthIssue, setEaAuthIssue] = useState(null);
  // Null until a real EA-reported balance (POST /api/ea/balance) arrives via
  // poll or the 'balance' socket channel — DashTab/RiskTab show "—" until then.
  const [accountBalance, setAccountBalance] = useState(null);
  const [equityCurveLive, setEquityCurveLive] = useState(false);
  // FIX (Known gap #1): "Prices tick from signals, not a true feed." True,
  // whenever the socket below actually connects — this just tracks that so
  // the UI can show whether it's on tick-by-tick push or 5s-poll fallback.
  const [socketLive, setSocketLive] = useState(false);
  const [analysisLive, setAnalysisLive] = useState(null); // { symbol, timeframe, ts }
  const [cryptoVolAlerts, setCryptoVolAlerts] = useState([]);
  const [news, setNews] = useState(null);
  const [sentiment, setSentiment] = useState(null);
  const [journalStats, setJournalStats] = useState(null);
  const [learningProfiles, setLearningProfiles] = useState(null);
  const [relativeStrength, setRelativeStrength] = useState(null);
  const [hurstBoard, setHurstBoard] = useState(null); // separate Hurst analysis layer
  const priceRef = useRef(prices);
  priceRef.current = prices;
  // Prefer broker (mt5_ea) ticks on the client so lower-rank sources cannot
  // paint over Exness prices while the EA is connected.
  const priceSourceRef = useRef({});
  const SRC_RANK = { mt5_ea: 100, tradingview: 90, deriv: 55, candle: 40 };

  /* Reachability probe against the unauthenticated /health route. Render's
     free tier can take 30-60s+ to wake a cold instance, so a single
     2.5s-timeout attempt was permanently latching mode='demo' for the rest
     of the session even when the backend was fine — just asleep. Now: show
     demo immediately (never a blank/stuck "Connecting" screen) but keep
     retrying every 4s in the background, and flip to live the instant the
     backend answers — no manual refresh required. */
  const [wakingBackend, setWakingBackend] = useState(false);
  const [wakeAttempts, setWakeAttempts] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let attempts = 0;
    // Always paint the desk shell. Never block on auth headers or JSON parse.
    setMode('live');
    const tryProbe = () => {
      if (cancelled) return;
      attempts += 1;
      setWakeAttempts(attempts);
      // Cap visible "waking" banner so the UI never looks stuck loading forever.
      // Keep retrying quietly in the background after that.
      if (attempts <= 24) setWakingBackend(true);
      else setWakingBackend(false);

      probeBackend(attempts < 6 ? 5000 : 8000)
        .then(() => {
          if (cancelled) return;
          setMode('live');
          setWakingBackend(false);
        })
        .catch(() => {
          if (cancelled) return;
          setMode('live');
          timer = setTimeout(tryProbe, attempts < 10 ? 2000 : 5000);
        });
    };
    tryProbe();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  /* Persist last desk snapshot so reopen is never blank */
  useEffect(() => {
    saveDeskCache({ prices, quotes, signals: (signals || []).slice(0, 40) });
  }, [prices, quotes, signals]);

  /* Clock runs regardless of mode. */

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  /* Telegram Mini App shell init — ran unconditionally in the retired
     webapp/index.html (see its final <script> block) but had no equivalent
     here. tg.ready()/tg.expand() are no-ops (window.Telegram undefined)
     when this loads in a plain browser, so this is safe outside Telegram
     too. PWA service-worker registration moved to main.jsx's
     registerServiceWorker() — it needs to run once at boot regardless of
     App's mount/remount cycles, and owns real update-detection (see that
     file's header comment) that a bare .register() call here didn't have. */
  useEffect(() => {
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg) {
        try { tg.ready(); } catch (_) {}
        try { tg.expand(); } catch (_) {}
        try { tg.disableVerticalSwipes?.(); } catch (_) {}
        try {
          // Prefer full viewport height inside Telegram Mini App
          if (typeof tg.requestFullscreen === 'function') tg.requestFullscreen();
        } catch (_) {}
        try {
          document.documentElement.style.setProperty('--tg-viewport-stable-height', `${tg.viewportStableHeight || window.innerHeight}px`);
        } catch (_) {}
      }
      if (tg) { tg.ready(); tg.expand(); }
    } catch (_) { /* not inside Telegram, or SDK not loaded yet — fine */ }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      setTimeout(() => { try { Notification.requestPermission(); } catch (_) {} }, 4000);
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
    .catch(err => {
      const msg = String(err?.message || err || '');
      // Silent for cold-start / rate-limit / abort — friends should not see a wall of API errors
      const silent = /409|429|Abort|timeout|AUTH_REQUIRED|Failed to fetch|NetworkError|503|502/i.test(msg);
      if (!silent) setFetchErrors(prev => ({ ...prev, [key]: msg }));
      else setFetchErrors(prev => (prev[key] ? { ...prev, [key]: null } : prev));
      throw err;
    });

  useEffect(() => {
    if (mode !== 'live') return;
    let cancelled = false;

    const pullFast = async () => {
      try {
        const r = await recordFetch('market', omniFetch(`/api/market?symbols=${SYMBOLS.join(',')}`));
        if (!cancelled && r.ok && Array.isArray(r.market)) {
          setPrices(prev => {
            const next = { ...prev };
            r.market.forEach(m => {
              if (!m.symbol || m.price == null || !(m.symbol in next)) return;
              const src = m.source || 'unknown';
              const rank = SRC_RANK[src] ?? 0;
              const prevSrc = priceSourceRef.current[m.symbol];
              if (prevSrc && prevSrc.rank > rank && (Date.now() - prevSrc.ts) < 15000) return;
              priceSourceRef.current[m.symbol] = { source: src, rank, ts: Date.now() };
              next[m.symbol] = Number(m.price);
            });
            return next;
          });
          setQuotes(prev => {
            const next = { ...prev };
            r.market.forEach(m => {
              if (!m.symbol || m.price == null) return;
              const src = m.source || 'unknown';
              const rank = SRC_RANK[src] ?? 0;
              const prevSrc = priceSourceRef.current[m.symbol];
              if (prevSrc && prevSrc.rank > rank && (Date.now() - prevSrc.ts) < 15000) return;
              next[m.symbol] = {
                price: Number(m.price),
                bid: m.bid != null ? Number(m.bid) : prev[m.symbol]?.bid ?? null,
                ask: m.ask != null ? Number(m.ask) : prev[m.symbol]?.ask ?? null,
                source: src,
                ts: Date.now(),
              };
            });
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
      try {
        let events = [];
        try {
          const r = await recordFetch('calendar', omniFetch('/api/calendar'));
          if (r && Array.isArray(r.events) && r.events.length) events = r.events;
        } catch (_) {}
        // If API empty (Render often 429 on Forex Factory), load from the browser IP
        if (!events.length) {
          try {
            events = await fetchCalendarFromBrowser();
          } catch (_) {}
        }
        if (!cancelled) setCalendar(events);
      } catch (_) {}
      try { const r = await recordFetch('levels', omniFetch('/api/levels')); if (!cancelled && r.ok && r.levels) setLevels(r.levels); } catch (_) {}
      try { const r = await recordFetch('heatmap', omniFetch('/api/heatmap')); if (!cancelled && r.ok) setHeatmapTiles(r.tiles); } catch (_) {}
      try { const r = await recordFetch('audit-trail', omniFetch('/api/audit-trail?limit=50')); if (!cancelled && r.ok) setAuditLog([...(r.nearMisses||[]), ...(r.entries||[])].slice(0, 50)); } catch (_) {}
      try { const r = await recordFetch('health', omniFetch('/api/health')); if (!cancelled && r.ok) setFeedHealth(r.feeds); } catch (_) {}
      try {
        const r = await omniFetch('/health');
        if (!cancelled && r.ok) {
          setUptimeSec(r.uptime);
          // FIX: EA auth failures were only visible in Render's server
          // logs, rate-limited to once/minute so they wouldn't get lost
          // in spam — but nobody looks at server logs while trading, and
          // the actual visible symptom (chart quietly staying on Deriv
          // forever) looks identical to a chart bug, not an auth problem.
          // Surface it in the UI instead. Only flag it "active" if a
          // failure happened recently (last 3 min) — EA_SECRET being
          // fixed should clear this within a poll cycle or two, not
          // require a redeploy to stop showing a stale warning.
          const recent = r.eaAuthLastFailureAt && (Date.now() - r.eaAuthLastFailureAt) < 180000;
          setEaAuthIssue(recent ? { failures: r.eaAuthFailures, lastAt: r.eaAuthLastFailureAt } : null);
        }
      } catch (_) {}
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
      try { const r = await recordFetch('hurst', omniFetch('/api/hurst')); if (!cancelled && r.ok) setHurstBoard(Array.isArray(r.board) ? r.board : []); } catch (_) {}
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
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMin: 500,
        reconnectionDelayMax: 5000,
        randomizationFactor: 0.2,
        timeout: 10000,
      });

      socket.on('connect', () => { if (!cancelled) setSocketLive(true); });
      socket.on('disconnect', () => { if (!cancelled) setSocketLive(false); });
      socket.on('connect_error', () => { if (!cancelled) setSocketLive(false); });
      socket.on('reconnect_attempt', () => { if (!cancelled) setSocketLive(false); });
      socket.on('engine_ready', () => { if (!cancelled) setWakingBackend(false); });
      socket.on('reconnect_error', () => { if (!cancelled) setSocketLive(false); });
      socket.on('reconnect_failed', () => { if (!cancelled) setSocketLive(false); });
      socket.on('reconnect_error', () => { if (!cancelled) setSocketLive(false); });
      socket.on('reconnect_failed', () => { if (!cancelled) setSocketLive(false); });

      socket.on('market', payload => {
        if (cancelled || !payload?.symbol || payload.price == null || !(payload.symbol in BASE_PRICE)) return;
        const sym = payload.symbol;
        const src = payload.source || 'unknown';
        const rank = SRC_RANK[src] ?? 0;
        const prevSrc = priceSourceRef.current[sym];
        if (prevSrc && prevSrc.rank > rank && (Date.now() - prevSrc.ts) < 12000) {
          return; // MT5 only blocks ~12s after last broker tick
        }
        priceSourceRef.current[sym] = { source: src, rank, ts: Date.now() };
        const prevPrice = priceRef.current[sym];
        setFlash(f => ({ ...f, [sym]: payload.price >= prevPrice ? 'up' : 'down' }));
        setPrices(prev => ({ ...prev, [sym]: Number(payload.price) }));
        setQuotes(prev => ({
          ...prev,
          [sym]: {
            price: Number(payload.price),
            bid: payload.bid != null ? Number(payload.bid) : prev[sym]?.bid ?? null,
            ask: payload.ask != null ? Number(payload.ask) : prev[sym]?.ask ?? null,
            source: src,
            ts: Date.now(),
          },
        }));
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
        const norm = normalizeSignal(payload);
        setSignals(prev => {
          if (prev.some(s => s.id === payload.id)) return prev;
          // Audio feedback — only for newly seen high-quality signals
          try {
            if (loadSoundPref() && signalScore(norm) >= 70) {
              playSignalChime(normalizeDirection(norm.action));
            }
          } catch (_) {}
          return [norm, ...prev].slice(0, 200);
        });
        // Browser push when a real signal arrives
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const title = `OMNICEE ${norm.symbol} ${norm.action}`;
            const body = `Score ${norm.score} · ${norm.timeframe || ''} · entry ${norm.entry ?? '—'}`;
            navigator.serviceWorker?.getRegistration?.().then(reg => {
              if (reg?.showNotification) reg.showNotification(title, { body, icon: '/icons/icon-192.png', tag: norm.id, data: { url: '/' } });
              else new Notification(title, { body, icon: '/icons/icon-192.png' });
            }).catch(() => new Notification(title, { body }));
          }
        } catch (_) { /* notification optional */ }
      });

      // Complements the /api/stats poll above with push updates the
      // instant a new EA balance report lands, instead of waiting up to 5s.
      socket.on('balance', payload => {
        if (!cancelled && payload?.balance != null) setAccountBalance(Number(payload.balance));
      });

      // Real-time analysis pulse (from scheduleLiveAnalysis / runAnalysisCycle)
      socket.on('telemetry', payload => {
        if (cancelled || !payload) return;
        if (payload.type === 'analysis_live' || payload.type === 'signal_approved') {
          setAnalysisLive({
            symbol: payload.symbol,
            timeframe: payload.timeframe,
            type: payload.type,
            ts: payload.timestamp || Date.now(),
          });
        }
        if (payload.type === 'crypto_volatility_alert' || payload.type === 'crypto_volatility' || payload.type === 'gold_volatility') {
          setCryptoVolAlerts(prev => [payload, ...prev].slice(0, 20));
        }
      });
      socket.on('crypto_volatility_alert', payload => {
        if (cancelled || !payload) return;
        setCryptoVolAlerts(prev => [payload, ...prev].slice(0, 20));
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(`OMNICEE ${payload.symbol} ${payload.direction}`, {
              body: payload.message || `${payload.absPct}% in ${payload.window}`,
            });
          }
        } catch (_) {}
      });
      socket.on('hurst', payload => {
        if (cancelled || !payload) return;
        if (Array.isArray(payload.board)) setHurstBoard(payload.board);
      });
      socket.on('regime', payload => {
        if (cancelled || !payload?.symbol) return;
        // light touch: fold into outlook-like local note via analysisLive
        setAnalysisLive(prev => ({
          ...(prev || {}),
          symbol: payload.symbol,
          timeframe: payload.timeframe,
          regime: payload.regime || payload.state,
          ts: Date.now(),
          type: 'regime',
        }));
      });
      socket.on('feed_health', payload => {
        if (!cancelled && payload) setFeedHealth(payload.feeds || payload);
      });
      socket.on('risk', payload => {
        if (!cancelled && payload) {
          /* risk push available for Desk/System; keep stats fresh */
        }
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
    now, prices, quotes, changes, flash, signals, calendar, levels, auditLog, equityCurve, equityCurveLive,
    stats, outlook, heatmapTiles, feedHealth, uptimeSec, accountBalance, socketLive, analysisLive, cryptoVolAlerts,
    news, sentiment, journalStats, learningProfiles, relativeStrength, hurstBoard, fetchErrors,
    mode, connected: mode === 'live', wakingBackend, wakeAttempts, eaAuthIssue,
  };
}

/* ── Navigation model ───────────────────────────────────────────────── */
const TABS = [
  { key: 'DASH', label: 'Home', fkey: 'F1', icon: LayoutDashboard },
  { key: 'SIGNALS', label: 'Signals', fkey: 'F2', icon: Radio },
  { key: 'ANALYSIS', label: 'Analysis', fkey: 'F3', icon: Layers },
  { key: 'NEWS', label: 'News', fkey: 'F4', icon: Newspaper },
  { key: 'VALID', label: 'Valid', fkey: 'F5', icon: FlaskConical },
  { key: 'MONITOR', label: 'System', fkey: 'F6', icon: Activity },
];

function TopBar({ now, mode, socketLive, analysisLive, wakingBackend, onCommand, soundOn, onToggleSound, userEmail, onLogout }) {
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
    <div className="omni-topbar flex items-center gap-2 sm:gap-4 px-2 sm:px-4 py-2.5 border-b shrink-0" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 rounded flex items-center justify-center font-display text-[12px] font-bold"
          style={{ background: 'var(--emerald)', color: '#05070a' }}>Ω</div>
        <span className="font-display text-sm tracking-[0.12em] hidden xs:inline sm:inline" style={{ color: 'var(--text)' }}>OMNICEE</span>
      </div>
      <div className="flex-1 flex items-center gap-2 min-w-0 max-w-full sm:max-w-md omni-hide-xs">
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
      <div className="flex items-center gap-2 sm:gap-3 ml-auto shrink-0">
        <button
          type="button"
          onClick={() => { onToggleSound?.(); if (!soundOn) { getAudioCtx()?.resume?.(); playSignalChime('neutral'); } }}
          className="omni-chip flex items-center justify-center rounded p-1.5 min-w-[36px] min-h-[36px]"
          title={soundOn ? 'Mute signal sounds' : 'Unmute signal sounds'}
          aria-label={soundOn ? 'Mute' : 'Unmute'}
          style={{ color: soundOn ? 'var(--emerald)' : 'var(--textFaint)', background: 'var(--panel2)' }}
        >
          {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
        <span className="flex items-center gap-1.5 font-mono text-[10px] sm:text-[11px] uppercase" style={{ color: status.color }}>
          <Circle size={7} fill="currentColor" className={status.pulse ? 'omni-pulse' : ''} />
          {status.label}
        </span>
        {mode === 'live' && (
          <>
            <span
              className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded hidden sm:inline"
              style={{ color: socketLive ? 'var(--emerald)' : 'var(--textFaint)', border: `1px solid ${socketLive ? 'var(--emerald)' : 'var(--border)'}` }}
              title={socketLive ? 'Tick-by-tick prices over Socket.IO' : 'Falling back to 5s REST polling'}
            >
              {socketLive ? 'push' : 'poll'}
            </span>
            <span className="font-mono text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider hidden xs:inline"
              style={{ color: analysisLive ? 'var(--gold)' : 'var(--textFaint)', border: `1px solid ${analysisLive ? 'var(--gold)' : 'var(--border)'}` }}
              title={analysisLive ? `Last scan ${analysisLive.symbol || ''} ${analysisLive.timeframe || ''}` : 'Waiting for live analysis'}>
              {analysisLive ? `scan ${analysisLive.symbol || ''}`.trim() : 'scan —'}
            </span>
          </>
        )}
        <span className="font-mono text-[11px] hidden md:inline" style={{ color: 'var(--textDim)' }}>{date}</span>
        <span className="font-mono text-[11px] sm:text-[12px] font-semibold" style={{ color: 'var(--text)' }}>{time}</span>
        {userEmail && (
          <span className="font-mono text-[10px] hidden lg:inline max-w-[140px] truncate" style={{ color: 'var(--textFaint)' }} title={userEmail}>
            {userEmail}
          </span>
        )}
        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded"
            style={{ color: 'var(--textDim)', border: '1px solid var(--border)', background: 'var(--panel2)' }}
            title="Sign out / switch account"
          >
            Logout
          </button>
        )}
      </div>
    </div>
  );
}

function TickerTape({ prices, changes, flash, quotes }) {
  // Smooth continuous strip — duplicate symbols for seamless marquee
  const syms = [...SYMBOLS, ...SYMBOLS];
  return (
    <div className="omni-ticker-wrap border-b overflow-hidden shrink-0" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <div className="omni-ticker-track flex items-center gap-6 px-3 py-1.5 font-mono text-[11px] whitespace-nowrap">
        {syms.map((sym, i) => {
          const q = quotes?.[sym];
          const mid = q?.price ?? prices?.[sym];
          const bid = q?.bid;
          const ask = q?.ask;
          const ch = changes?.[sym];
          const up = ch == null ? null : ch >= 0;
          const fl = flash[sym];
          return (
            <span key={`${sym}-${i}`} className="inline-flex items-center gap-2 shrink-0"
              style={{
                color: 'var(--text)',
                background: fl === 'up' ? 'rgba(31,227,168,0.12)' : fl === 'down' ? 'rgba(255,84,112,0.12)' : 'transparent',
                borderRadius: 4,
                padding: '1px 6px',
                transition: 'background 0.15s',
              }}>
              <span style={{ color: 'var(--textFaint)' }}>{typeof symLabel === 'function' ? symLabel(sym) : sym}</span>
              {bid != null && ask != null ? (
                <>
                  <span style={{ color: 'var(--coral)' }}>{fmtPrice(sym, bid)}</span>
                  <span style={{ color: 'var(--textFaint)' }}>/</span>
                  <span style={{ color: 'var(--emerald)' }}>{fmtPrice(sym, ask)}</span>
                </>
              ) : mid != null ? (
                <span style={{ color: 'var(--text)' }}>{fmtPrice(sym, mid)}</span>
              ) : (
                <span style={{ color: 'var(--textFaint)' }}>—</span>
              )}
              {ch != null && (
                <span style={{ color: up ? 'var(--emerald)' : 'var(--coral)' }}>{fmtPct(ch)}</span>
              )}
              {(q?.source === 'mt5_ea' || q?.source === 'deriv') && <span style={{ color: 'var(--gold)', fontSize: 9 }}>{q?.source === 'mt5_ea' ? 'MT5' : 'DERIV'}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function NavBar({ active, onSelect }) {
  return (
    <div className="omni-nav">
      {TABS.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          className="flex flex-col items-center justify-center gap-0.5 transition-colors"
          style={{
            color: active === t.key ? 'var(--emerald)' : 'var(--textDim)',
            background: active === t.key ? 'var(--panel2)' : 'transparent',
            borderTop: active === t.key ? '2px solid var(--emerald)' : '2px solid transparent',
          }}
        >
          <t.icon size={20} strokeWidth={active === t.key ? 2.25 : 1.75} />
          <span className="font-mono text-[9px] uppercase tracking-wider leading-none">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

function sessionNameUtc(hour) {
  if (hour >= 0 && hour < 8) return { name: 'Asia', note: 'Typically thinner liquidity — wait for clearer structure.' };
  if (hour >= 8 && hour < 13) return { name: 'London', note: 'Strong session for FX & gold — look for continuation after London open.' };
  if (hour >= 13 && hour < 16) return { name: 'London/NY overlap', note: 'Highest activity window — best liquidity for most pairs.' };
  if (hour >= 16 && hour < 21) return { name: 'New York', note: 'US session — watch USD drivers and gold reaction.' };
  return { name: 'Off-peak', note: 'Lower volume — fewer high-quality setups expected.' };
}

function MarketVoice({ now, signals, quotes, outlook, mode }) {
  const hour = new Date(now).getUTCHours();
  const sess = sessionNameUtc(hour);
  const recent = signals.slice(0, 8);
  const bull = recent.filter(s => s.action === 'BUY' || s.action === 'LONG').length;
  const bear = recent.filter(s => s.action === 'SELL' || s.action === 'SHORT').length;
  const liveCount = Object.values(quotes || {}).filter(q => q?.source === 'mt5_ea').length;
  const lines = [];
  lines.push(`${sess.name} session (UTC ${String(hour).padStart(2, '0')}:00). ${sess.note}`);
  if (liveCount > 0) lines.push(`Broker feed live on ${liveCount}/${SYMBOLS.length} symbols — prices are Exness/MT5 based.`);
  else lines.push('Waiting for MT5 EA ticks — attach OmniceeEA for broker-accurate prices.');
  if (recent.length === 0) lines.push('No signals fired yet this window. System is scanning; it only speaks when confluence clears the gate.');
  else lines.push(`Recent book: ${bull} bullish / ${bear} bearish of last ${recent.length} signals.`);
  if (outlook?.narrative) lines.push(String(outlook.narrative).slice(0, 220));
  const dayBias = bull > bear + 1 ? 'Day lean: buyers have been more active in recent signals.'
    : bear > bull + 1 ? 'Day lean: sellers have been more active in recent signals.'
    : 'Day lean: mixed — no strong one-sided pressure from recent signals.';
  lines.push(dayBias);

  return (
    <div className="omni-panel p-3 md:p-4">
      <SectionHeader icon={Globe2} title="Market voice" sub="session · day bias" />
      <ul className="space-y-2 mt-1">
        {lines.map((line, i) => (
          <li key={i} className="font-mono text-[11px] md:text-[12px] leading-relaxed flex gap-2" style={{ color: i === 0 ? 'var(--text)' : 'var(--textDim)' }}>
            <span style={{ color: 'var(--emerald)' }}>▸</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── LIVE CHART (candlestick, MT5/broker-style) ────────────────────────
 * lightweight-charts@5 does the actual rendering. Historical candles come
 * from GET /api/candles, which reads the exact same candleStores object
 * the live agents run technical analysis on (see api/server.js) — this
 * chart never shows a bar the signal pipeline itself didn't see. Between
 * polls, the still-forming bar is kept live by aggregating the same
 * 'market' tick stream the ticker tape already consumes, bucketed with
 * the identical Math.floor(now/durationMs)*durationMs logic index.js
 * uses server-side (TIMEFRAME_MS), so the client and server never
 * disagree about where one bar ends and the next begins.
 */
const TIMEFRAME_MS_CLIENT = { M15: 15 * 60e3, H1: 3600e3, H4: 4 * 3600e3, D1: 86400e3 };
const CHART_COLORS = {
  up: '#1fe3a8', down: '#ff5470', grid: '#1c232d', border: '#1c232d',
  text: '#526078', crosshair: '#8b9bb0', panel2: '#10151c',
  ema20: '#5ea8ff', ema50: '#a78bfa', band: '#526078',
};

const INDICATOR_DEFS = [
  { key: 'ema20', label: 'EMA 20', color: CHART_COLORS.ema20 },
  { key: 'ema50', label: 'EMA 50', color: CHART_COLORS.ema50 },
  { key: 'bb', label: 'Bollinger 20/2', color: CHART_COLORS.band },
  { key: 'vp', label: 'Volume Profile', color: '#22d3ee' },
  { key: 'vol', label: 'Volume bars', color: '#1fe3a8' },
];

// Standard EMA — first value is a plain SMA seed, everything after that
// is the recursive weighted average. Returns a sparse array (undefined
// until enough candles exist to seed it).
function computeEMA(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// Bollinger Bands — rolling mean ± (mult × rolling stddev). O(n·period),
// trivial for the ~300 candles this chart ever holds.
function computeBollinger(closes, period = 20, mult = 2) {
  const upper = [], lower = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, lower };
}

/**
 * Fixed-range Volume Profile from OHLCV candles.
 * Distributes each bar's volume across price buckets spanned by high–low
 * (uniform within the range — standard tick-proxy when true T&S is absent).
 * Returns bins + POC + Value Area (≈70% of total volume around POC).
 */
function computeVolumeProfile(candles, rows = 28) {
  if (!candles?.length || rows < 4) return null;
  let lo = Infinity, hi = -Infinity;
  let totalVol = 0;
  for (const c of candles) {
    if (!Number.isFinite(c.low) || !Number.isFinite(c.high)) continue;
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
    totalVol += Number(c.volume) || 0;
  }
  if (!(hi > lo) || totalVol <= 0) {
    // Fallback: synthetic volume from range so VP still draws when feed omits volume
    totalVol = 0;
    for (const c of candles) {
      const synthetic = Math.max(Math.abs((c.high ?? 0) - (c.low ?? 0)), 1e-12);
      totalVol += synthetic;
    }
    if (!(hi > lo) || totalVol <= 0) return null;
  }
  const step = (hi - lo) / rows;
  if (!(step > 0)) return null;
  const bins = Array.from({ length: rows }, (_, i) => ({
    priceLow: lo + i * step,
    priceHigh: lo + (i + 1) * step,
    priceMid: lo + (i + 0.5) * step,
    volume: 0,
  }));
  for (const c of candles) {
    const cLo = Number(c.low), cHi = Number(c.high);
    if (!Number.isFinite(cLo) || !Number.isFinite(cHi) || cHi < cLo) continue;
    let vol = Number(c.volume);
    if (!(vol > 0)) vol = Math.max(Math.abs(cHi - cLo), 1e-12);
    const i0 = Math.max(0, Math.min(rows - 1, Math.floor((cLo - lo) / step)));
    const i1 = Math.max(0, Math.min(rows - 1, Math.floor((cHi - lo) / step)));
    const span = i1 - i0 + 1;
    const share = vol / span;
    for (let i = i0; i <= i1; i++) bins[i].volume += share;
  }
  let pocIdx = 0;
  for (let i = 1; i < rows; i++) if (bins[i].volume > bins[pocIdx].volume) pocIdx = i;
  // Value Area: expand from POC until ~70% of volume is covered
  let vaLow = pocIdx, vaHigh = pocIdx, covered = bins[pocIdx].volume;
  const target = totalVol * 0.7;
  while (covered < target && (vaLow > 0 || vaHigh < rows - 1)) {
    const up = vaHigh < rows - 1 ? bins[vaHigh + 1].volume : -1;
    const dn = vaLow > 0 ? bins[vaLow - 1].volume : -1;
    if (up >= dn) { vaHigh += 1; covered += bins[vaHigh].volume; }
    else { vaLow -= 1; covered += bins[vaLow].volume; }
  }
  return {
    bins,
    maxVol: bins[pocIdx].volume,
    poc: bins[pocIdx].priceMid,
    vah: bins[vaHigh].priceHigh,
    val: bins[vaLow].priceLow,
    totalVol,
  };
}

/**
 * ErrorBoundary
 * ─────────────
 * FIX (root cause of "screen goes blank"): this app had NO error boundary
 * anywhere. React's default behavior on any uncaught render/effect
 * exception is to unmount the ENTIRE tree — so a bug in one panel (e.g.
 * the chart hitting a lightweight-charts edge case on a fast symbol
 * switch — see LiveChart's loadedKeyRef fix below for the specific race
 * that was actually doing this) took down the whole app, header and nav
 * included, leaving a blank page with no way back except a manual reload.
 *
 * Wrapped around each tab's content (see OmniceeDashboard's render below)
 * so a crash in one tab shows a contained "Something broke in this view"
 * message instead — the header/ticker/nav stay alive and the person can
 * just switch tabs or retry, which is what "the screen goes blank when I
 * switch [symbols]" should have been able to do all along.
 */
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', this.props.label || '', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="omni-panel p-4 m-2 flex flex-col items-center gap-2 text-center">
          <span className="font-mono text-[11px]" style={{ color: 'var(--coral)' }}>
            Something broke in {this.props.label || 'this view'} — the rest of the app is still fine.
          </span>
          <span className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>{String(this.state.error.message || this.state.error)}</span>
          <button
            onClick={() => this.setState({ error: null })}
            className="font-mono text-[10px] px-3 py-1 rounded mt-1"
            style={{ background: 'var(--panel2)', color: 'var(--emerald)', border: '1px solid var(--border)' }}
          >Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function LiveChart({ symbol, quote, signals, levels, onSymbolChange }) {
  const [timeframe, setTimeframe] = useState('H1');
  const [status, setStatus] = useState('loading'); // loading | ok | empty | error
  const [ohlcReadout, setOhlcReadout] = useState(null);
  const [indicators, setIndicators] = useState({ ema20: false, ema50: false, bb: false, vp: false, vol: true });
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const containerRef = useRef(null);
  const vpCanvasRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const markersRef = useRef(null);
  const priceLinesRef = useRef([]);
  const vpLinesRef = useRef([]);
  const srLinesRef = useRef([]);
  const ema20SeriesRef = useRef(null);
  const ema50SeriesRef = useRef(null);
  const bbUpperSeriesRef = useRef(null);
  const bbLowerSeriesRef = useRef(null);
  const candlesRef = useRef([]);
  const indicatorMenuRef = useRef(null);
  const lastBarRef = useRef(null);
  const lastVolRef = useRef(0);
  // FIX (root cause of the "screen goes blank when I switch [symbols]"
  // bug): on a symbol/timeframe switch, the historical reload below is
  // async — there's a real window where candleSeriesRef.current still
  // holds the OLD symbol's data while this effect's deps (quote, signals)
  // have already updated to the NEW symbol. The live-tick effect used to
  // fire in that window and call series.update() with a bar built from
  // the new symbol's price/timestamp against the old symbol's still-
  // loaded series — lightweight-charts requires updates to be time-
  // ordered relative to what's already in the series, and throws when
  // they aren't (e.g. the new symbol's bucketed tick time landing earlier
  // than the old symbol's last loaded bar). That threw INSIDE a useEffect
  // with no error boundary anywhere in the app (see the new ErrorBoundary
  // above) — React's default behavior on an uncaught render/effect error
  // is to unmount the whole tree, which is exactly "the screen goes
  // blank". loadedKeyRef gates every write to the chart series behind
  // "does this data actually belong to the symbol/timeframe on screen
  // right now" so that window can't produce a mismatched write anymore.
  const loadedKeyRef = useRef(null);

  // Recompute whichever overlays are currently toggled on from the full
  // candle set. Cheap even at 300 candles (worst case ~6k ops for
  // Bollinger), so no need to special-case the live-tick path — every
  // update just recomputes in full rather than maintaining incremental
  // running state that could drift from a page-load recompute.
  const applyIndicators = useCallback((candles) => {
    if (!candles?.length) return;
    const closes = candles.map(c => c.close);
    const times = candles.map(c => c.time);
    const toPoints = (arr) => times.map((t, i) => (arr[i] != null ? { time: t, value: arr[i] } : null)).filter(Boolean);

    if (indicators.ema20 && ema20SeriesRef.current) ema20SeriesRef.current.setData(toPoints(computeEMA(closes, 20)));
    if (indicators.ema50 && ema50SeriesRef.current) ema50SeriesRef.current.setData(toPoints(computeEMA(closes, 50)));
    if (indicators.bb && bbUpperSeriesRef.current) {
      const { upper, lower } = computeBollinger(closes, 20, 2);
      bbUpperSeriesRef.current.setData(toPoints(upper));
      bbLowerSeriesRef.current.setData(toPoints(lower));
    }
  }, [indicators]);

  // Mount the chart instance once. Symbol/timeframe switches below reuse
  // it via setData() rather than tearing it down — recreating a canvas
  // chart on every symbol click is the kind of thing that looks fine in
  // a demo and then jitters/flickers the moment it's live 24/7.
  useEffect(() => {
    if (!containerRef.current) return;
    let chart;
    try {
    chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: CHART_COLORS.text, fontFamily: 'JetBrains Mono, monospace', fontSize: 10 },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CHART_COLORS.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CHART_COLORS.panel2 },
        horzLine: { color: CHART_COLORS.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CHART_COLORS.panel2 },
      },
      rightPriceScale: { borderColor: CHART_COLORS.border },
      timeScale: { borderColor: CHART_COLORS.border, timeVisible: true, secondsVisible: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up, downColor: CHART_COLORS.down,
      borderUpColor: CHART_COLORS.up, borderDownColor: CHART_COLORS.down,
      wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down,
      priceLineVisible: false,
    });
    // Volume as a squashed overlay in the bottom 20% of the same pane —
    // the standard lightweight-charts pattern, avoids multi-pane sizing
    // quirks for a first cut.
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: CHART_COLORS.up,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    let markers = null;
    try { markers = createSeriesMarkers(candleSeries, []); } catch (e) { console.warn('markers', e); }

    // Overlay indicators — created hidden, toggled visible from the menu.
    // Kept as separate series (rather than baked into candle data) so
    // switching them on/off is a plain visibility flip, no refetch.
    const ema20Series = chart.addSeries(LineSeries, { color: CHART_COLORS.ema20, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false });
    const ema50Series = chart.addSeries(LineSeries, { color: CHART_COLORS.ema50, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false });
    const bbUpperSeries = chart.addSeries(LineSeries, { color: CHART_COLORS.band, lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, visible: false });
    const bbLowerSeries = chart.addSeries(LineSeries, { color: CHART_COLORS.band, lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, visible: false });

    const onCrosshairMove = (param) => {
      const bar = param.seriesData?.get(candleSeries);
      setOhlcReadout(bar ? { o: bar.open, h: bar.high, l: bar.low, c: bar.close } : null);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    markersRef.current = markers;
    ema20SeriesRef.current = ema20Series;
    ema50SeriesRef.current = ema50Series;
    bbUpperSeriesRef.current = bbUpperSeries;
    bbLowerSeriesRef.current = bbLowerSeries;
    // Force layout after mount — hidden/0-size parents blank the canvas
    requestAnimationFrame(() => {
      try {
        chart.applyOptions({ width: containerRef.current?.clientWidth || 600, height: containerRef.current?.clientHeight || 320 });
        chart.timeScale().fitContent();
      } catch (_) {}
    });
    } catch (err) {
      console.error('[OMNICEE] chart mount failed', err);
      return;
    }

    return () => {
      try {
        if (chart) {
          try { chart.unsubscribeCrosshairMove(onCrosshairMove); } catch (_) {}
          try { chart.remove(); } catch (_) {}
        }
      } catch (_) {}
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersRef.current = null;
      ema20SeriesRef.current = null;
      ema50SeriesRef.current = null;
      bbUpperSeriesRef.current = null;
      bbLowerSeriesRef.current = null;
    };
  }, []);

  // Load history on symbol/timeframe change (race-safe, clears old series)
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    let reqId = 0;
    lastBarRef.current = null;
    setStatus('loading');
    setOhlcReadout(null);
    try {
      candleSeriesRef.current?.setData([]);
      volumeSeriesRef.current?.setData([]);
      if (markersRef.current?.setMarkers) markersRef.current.setMarkers([]);
    } catch (_) {}
    loadedKeyRef.current = null; // block live-tick writes until THIS combo's history actually lands
    const key = `${symbol}:${timeframe}`;

    async function load() {
      const myId = ++reqId;
      try {
        const data = await omniFetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=300`);
        if (cancelled || myId !== reqId || !candleSeriesRef.current) return;
        const candles = (data?.candles || []).filter(c =>
          Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high)
          && Number.isFinite(c.low) && Number.isFinite(c.close) && c.time > 1e8
        );
        if (!candles.length) {
          try { candleSeriesRef.current.setData([]); volumeSeriesRef.current?.setData([]); } catch (_) {}
          setStatus('empty');
          loadedKeyRef.current = key; // this combo has resolved (to empty) — live ticks may now seed a fresh bar
          return;
        }
        candleSeriesRef.current.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
        volumeSeriesRef.current?.setData(candles.map(c => ({
          time: c.time,
          value: c.volume || 0,
          color: c.close >= c.open ? 'rgba(31,227,168,0.35)' : 'rgba(255,84,112,0.35)',
        })));
        // Keep volume on the ref so Volume Profile can distribute by price
        candlesRef.current = candles.map(({ time, open, high, low, close, volume }) => ({
          time, open, high, low, close, volume: volume || 0,
        }));
        applyIndicators(candlesRef.current);
        const last = candles[candles.length - 1];
        lastBarRef.current = { time: last.time, open: last.open, high: last.high, low: last.low, close: last.close };
        lastVolRef.current = last.volume || 0;
        setOhlcReadout({ o: last.open, h: last.high, l: last.low, c: last.close });
        try { chartRef.current?.timeScale()?.fitContent?.(); } catch (_) {}
        loadedKeyRef.current = key; // only NOW is it safe for the live-tick effect to write into this series
        setStatus('ok');
      } catch (e) {
        if (!cancelled && myId === reqId) setStatus('error');
        // deliberately NOT setting loadedKeyRef here — an errored load means
        // we don't actually know the series is in a good state for this
        // symbol/timeframe, so live ticks stay gated off until the next
        // successful poll rather than risk writing over unknown contents.
      }
    }
    load();
    const poll = setInterval(load, 45000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [symbol, timeframe]);

  // Keep the current bar live between polls using the same tick stream
  // the header bid/ask readout already uses. Bucketing mirrors index.js's
  // TIMEFRAME_MS math exactly so this bar and the server's eventual
  // closed bar for the same window never disagree on boundaries.
  // FIX: was using quote.price (mid) here while historical bars now come
  // bid-based from /api/candles — would've put a visibly different-
  // looking bar right at the point where the eye compares it to the
  // ticker most. Use bid (matching the ticker/header's own coral figure)
  // whenever it exists, same fallback order the ticker itself uses.
  useEffect(() => {
    const tickPrice = Number(quote?.bid ?? quote?.price);
    if (!candleSeriesRef.current || !Number.isFinite(tickPrice)) return;
    // FIX (screen-blanks-on-switch, see ErrorBoundary/loadedKeyRef comments
    // above): don't write into the series until the history for THIS
    // symbol:timeframe has actually landed — otherwise a live tick can hit
    // a series that's still showing the PREVIOUS symbol's data, and
    // lightweight-charts throws (uncaught, with no boundary = blank app)
    // if the computed bucket time lands before that stale series' last bar.
    if (loadedKeyRef.current !== `${symbol}:${timeframe}`) return;
    const durationMs = TIMEFRAME_MS_CLIENT[timeframe];
    const bucketTime = Math.floor((quote.ts || Date.now()) / durationMs) * (durationMs / 1000);
    const prev = lastBarRef.current;
    const bar = (!prev || prev.time !== bucketTime)
      ? { time: bucketTime, open: prev ? prev.close : tickPrice, high: tickPrice, low: tickPrice, close: tickPrice }
      : { ...prev, high: Math.max(prev.high, tickPrice), low: Math.min(prev.low, tickPrice), close: tickPrice };
    // Belt-and-suspenders: even with loadedKeyRef gating the common case,
    // still never let a chart-library assertion (e.g. an out-of-order
    // time from a delayed/reordered tick) throw uncaught here — that's
    // exactly the class of error that used to blank the whole screen.
    try {
      candleSeriesRef.current.update(bar);
      volumeSeriesRef.current?.update({ time: bar.time, value: lastVolRef.current, color: bar.close >= bar.open ? 'rgba(31,227,168,0.35)' : 'rgba(255,84,112,0.35)' });
      lastBarRef.current = bar;
      const cs = candlesRef.current;
      if (cs.length && cs[cs.length - 1].time === bar.time) cs[cs.length - 1] = bar;
      else cs.push(bar);
      applyIndicators(cs);
    } catch (err) {
      console.warn('[LiveChart] skipped an out-of-order tick update:', err.message);
    }
  }, [quote?.bid, quote?.price, quote?.ts, timeframe, symbol]);

  // Signal overlay: arrows for every signal on this symbol, entry/SL/TP1
  // price lines for only the most recent one (all of them would just be
  // clutter on a live-forever chart).
  useEffect(() => {
    if (!markersRef.current || !candleSeriesRef.current) return;
    if (loadedKeyRef.current !== `${symbol}:${timeframe}`) return; // same guard — don't draw against a series mid-transition
    try {
      const durationMs = TIMEFRAME_MS_CLIENT[timeframe];
      const list = (signals || []).filter(s => s.action === 'BUY' || s.action === 'SELL');

      markersRef.current.setMarkers(list.map(s => ({
        time: Math.floor((s.timestamp || Date.now()) / durationMs) * (durationMs / 1000),
        position: s.action === 'BUY' ? 'belowBar' : 'aboveBar',
        color: s.action === 'BUY' ? CHART_COLORS.up : CHART_COLORS.down,
        shape: s.action === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: s.score != null ? String(Math.round(s.score)) : s.action,
      })));

      priceLinesRef.current.forEach(l => { try { candleSeriesRef.current.removePriceLine(l); } catch (_) {} });
      priceLinesRef.current = [];
      const latest = list[0];
      if (latest) {
        const lines = [];
        if (Number.isFinite(latest.entry)) lines.push({ price: latest.entry, color: CHART_COLORS.text, lineStyle: LineStyle.Solid, title: 'entry' });
        if (Number.isFinite(latest.stopLoss)) lines.push({ price: latest.stopLoss, color: CHART_COLORS.down, lineStyle: LineStyle.Dashed, title: 'SL' });
        if (Number.isFinite(latest.targets?.[0])) lines.push({ price: latest.targets[0], color: CHART_COLORS.up, lineStyle: LineStyle.Dashed, title: 'TP1' });
        priceLinesRef.current = lines.map(opts => candleSeriesRef.current.createPriceLine({ ...opts, lineWidth: 1, axisLabelVisible: true }));
      }
    } catch (err) {
      console.warn('[LiveChart] skipped a marker/price-line update:', err.message);
    }
  }, [signals, timeframe, symbol]);

  // Support/resistance drawn straight on the price axis (H1 swing high/low
  // from /api/levels) so it moves with the chart instead of living in a
  // separate text panel.
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    srLinesRef.current.forEach(l => { try { candleSeriesRef.current.removePriceLine(l); } catch (_) {} });
    srLinesRef.current = [];
    const lv = levels?.[symbol];
    if (!lv) return;
    const lines = [];
    if (Number.isFinite(lv.resistance)) lines.push({ price: lv.resistance, color: CHART_COLORS.up, lineStyle: LineStyle.Dotted, title: 'R' });
    if (Number.isFinite(lv.support)) lines.push({ price: lv.support, color: CHART_COLORS.down, lineStyle: LineStyle.Dotted, title: 'S' });
    srLinesRef.current = lines.map(opts => candleSeriesRef.current.createPriceLine({ ...opts, lineWidth: 1, axisLabelVisible: true }));
  }, [levels, symbol]);

  // Flip visibility + recompute whenever the indicator toggles change.
  useEffect(() => {
    ema20SeriesRef.current?.applyOptions({ visible: indicators.ema20 });
    ema50SeriesRef.current?.applyOptions({ visible: indicators.ema50 });
    bbUpperSeriesRef.current?.applyOptions({ visible: indicators.bb });
    bbLowerSeriesRef.current?.applyOptions({ visible: indicators.bb });
    volumeSeriesRef.current?.applyOptions({ visible: indicators.vol !== false });
    applyIndicators(candlesRef.current);
  }, [indicators, applyIndicators]);

  // Volume Profile overlay — canvas bars on the left + POC / VAH / VAL price lines
  useEffect(() => {
    const canvas = vpCanvasRef.current;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!canvas || !chart || !series) return undefined;

    // Clear any previous VP price lines (separate from signal entry/SL lines)
    const clearVpLines = () => {
      (vpLinesRef.current || []).forEach((l) => {
        try { series.removePriceLine(l); } catch (_) {}
      });
      vpLinesRef.current = [];
    };

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const wrap = canvas.parentElement;
      const w = wrap?.clientWidth || 0;
      const h = wrap?.clientHeight || 0;
      if (w < 8 || h < 8) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (!indicators.vp) {
        clearVpLines();
        return;
      }

      const profile = computeVolumeProfile(candlesRef.current, 28);
      if (!profile) {
        clearVpLines();
        return;
      }

      const maxBarW = Math.min(120, Math.floor(w * 0.28));
      const { bins, maxVol, poc, vah, val } = profile;

      for (const bin of bins) {
        const y1 = series.priceToCoordinate(bin.priceHigh);
        const y2 = series.priceToCoordinate(bin.priceLow);
        if (y1 == null || y2 == null) continue;
        const top = Math.min(y1, y2);
        const bot = Math.max(y1, y2);
        const bh = Math.max(1, bot - top - 0.5);
        const bw = maxVol > 0 ? (bin.volume / maxVol) * maxBarW : 0;
        if (bw < 0.5) continue;
        const inVA = bin.priceMid >= val && bin.priceMid <= vah;
        const isPoc = Math.abs(bin.priceMid - poc) < (bins[0].priceHigh - bins[0].priceLow) * 0.6;
        ctx.fillStyle = isPoc
          ? 'rgba(240, 180, 41, 0.55)'
          : inVA
            ? 'rgba(34, 211, 238, 0.28)'
            : 'rgba(94, 168, 255, 0.14)';
        ctx.fillRect(0, top, bw, bh);
      }

      // POC / VAH / VAL as dashed price lines (recreate when profile changes)
      clearVpLines();
      try {
        vpLinesRef.current = [
          series.createPriceLine({
            price: poc,
            color: '#f0b429',
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: 'POC',
          }),
          series.createPriceLine({
            price: vah,
            color: '#22d3ee',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'VAH',
          }),
          series.createPriceLine({
            price: val,
            color: '#22d3ee',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'VAL',
          }),
        ];
      } catch (_) { /* series may be mid-swap */ }
    };

    draw();
    // Redraw when user pans/zooms so bars stay locked to price levels
    const onRange = () => { requestAnimationFrame(draw); };
    try { chart.timeScale().subscribeVisibleLogicalRangeChange(onRange); } catch (_) {}
    try { chart.subscribeCrosshairMove(onRange); } catch (_) {}
    window.addEventListener('resize', onRange);
    const ro = typeof ResizeObserver !== 'undefined' && canvas.parentElement
      ? new ResizeObserver(() => requestAnimationFrame(draw))
      : null;
    if (ro && canvas.parentElement) ro.observe(canvas.parentElement);

    return () => {
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch (_) {}
      window.removeEventListener('resize', onRange);
      if (ro) ro.disconnect();
      clearVpLines();
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const w = canvas.parentElement?.clientWidth || 0;
        const h = canvas.parentElement?.clientHeight || 0;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }, [indicators.vp, symbol, timeframe, status, expanded]);

  // Close the indicator picker on an outside click.
  useEffect(() => {
    if (!showIndicatorMenu) return;
    const onClick = (e) => { if (indicatorMenuRef.current && !indicatorMenuRef.current.contains(e.target)) setShowIndicatorMenu(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showIndicatorMenu]);

  // Esc exits full-screen; hide ticker/topbar via body class; lock scroll.
  useEffect(() => {
    if (expanded) {
      document.body.classList.add('omni-chart-expanded');
      document.body.style.overflow = 'hidden';
    } else {
      document.body.classList.remove('omni-chart-expanded');
      document.body.style.overflow = '';
    }
    const onKey = (e) => { if (e.key === 'Escape') setExpanded(false); };
    if (expanded) window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('omni-chart-expanded');
      document.body.style.overflow = '';
    };
  }, [expanded]);

  // Keep lightweight-charts sized to the fluid container on every layout change
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const fit = () => {
      try {
        if (!chartRef.current) return;
        const w = el.clientWidth || 1;
        const h = el.clientHeight || 1;
        if (w < 2 || h < 2) return;
        chartRef.current.applyOptions({ width: w, height: h });
      } catch (_) {}
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      requestAnimationFrame(fit);
    }) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    const t = setTimeout(fit, 50);
    const t2 = setTimeout(fit, 300);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', fit);
      window.removeEventListener('orientationchange', fit);
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [expanded, symbol, timeframe]);

  // Force chart to re-measure after expand/collapse. On mobile (Telegram /
  // PWA) the fixed full-screen shell often mounts at 0×0 for a frame; without
  // staggered refits the canvas stays blank until a manual orientation change.
  useEffect(() => {
    const fit = () => {
      try {
        if (!chartRef.current || !containerRef.current) return;
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        if (w < 8 || h < 8) return;
        chartRef.current.applyOptions({ width: w, height: h });
        chartRef.current.timeScale().fitContent();
      } catch (_) {}
    };
    fit();
    const t1 = setTimeout(fit, 50);
    const t2 = setTimeout(fit, 200);
    const t3 = setTimeout(fit, 500);
    window.addEventListener('resize', fit);
    try { window.visualViewport?.addEventListener('resize', fit); } catch (_) {}
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      window.removeEventListener('resize', fit);
      try { window.visualViewport?.removeEventListener('resize', fit); } catch (_) {}
    };
  }, [expanded, symbol, timeframe]);

  return (
    <div
      className={`omni-chart-shell ${expanded ? 'is-expanded fixed inset-0 z-[9999] p-2 sm:p-3 flex flex-col' : 'w-full'}`}
      style={expanded ? {
        background: 'var(--void)',
        // Extra top pad so symbol/TF row clears Telegram header + old ticker space
        paddingTop: 'max(12px, calc(env(safe-area-inset-top, 0px) + 8px))',
        paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
      } : undefined}
    >
      {/* Symbols + timeframes always visible (preview AND full). Indicators + VP in both. */}
      <div
        className={`shrink-0 space-y-1.5 ${expanded ? 'pb-2 mb-1 border-b' : 'mb-1.5'}`}
        style={expanded ? { borderColor: 'var(--border)' } : undefined}
      >
        {/* Symbol chips — horizontal scroll on phones */}
        <div className="flex gap-1.5 items-center overflow-x-auto omni-scroll" style={{ WebkitOverflowScrolling: 'touch' }}>
          {typeof onSymbolChange === 'function' && SYMBOLS.map(sym => (
            <button
              key={sym}
              type="button"
              onClick={() => onSymbolChange(sym)}
              className={`omni-chip font-mono rounded transition-colors shrink-0 ${expanded ? 'text-[13px] px-3 py-2.5 min-h-[44px]' : 'text-[11px] px-2.5 py-1.5 min-h-[34px]'}`}
              style={{
                background: symbol === sym ? 'var(--emerald)' : 'var(--panel2)',
                color: symbol === sym ? '#05070a' : 'var(--textDim)',
              }}
            >
              {symLabel(sym)}
            </button>
          ))}
        </div>
        {/* Timeframes + VP + Indicators + Full/Close */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`omni-chip font-mono rounded ${expanded ? 'text-[13px] px-3 py-2.5 min-h-[44px]' : 'text-[11px] px-2.5 py-1.5 min-h-[34px]'}`}
              style={{
                background: timeframe === tf ? 'var(--panel2)' : 'transparent',
                color: timeframe === tf ? 'var(--emerald)' : 'var(--textFaint)',
                border: '1px solid var(--border)',
              }}
            >
              {tf}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setIndicators(s => ({ ...s, vp: !s.vp }))}
            className={`omni-chip font-mono rounded ${expanded ? 'text-[13px] px-3 py-2.5 min-h-[44px]' : 'text-[11px] px-2.5 py-1.5 min-h-[34px]'}`}
            style={{
              background: indicators.vp ? 'rgba(34,211,238,0.18)' : 'transparent',
              color: indicators.vp ? '#22d3ee' : 'var(--textFaint)',
              border: `1px solid ${indicators.vp ? '#22d3ee' : 'var(--border)'}`,
            }}
            title="Volume Profile"
          >
            VP
          </button>
          <div className="relative" ref={indicatorMenuRef}>
            <button
              type="button"
              onClick={() => setShowIndicatorMenu(v => !v)}
              className={`omni-chip font-mono rounded flex items-center gap-1 ${expanded ? 'text-[13px] px-3 py-2.5 min-h-[44px]' : 'text-[11px] px-2.5 py-1.5 min-h-[34px]'}`}
              style={{
                background: showIndicatorMenu ? 'var(--panel2)' : 'transparent',
                color: showIndicatorMenu ? 'var(--emerald)' : 'var(--textFaint)',
                border: '1px solid var(--border)',
              }}
            >
              <SlidersHorizontal size={expanded ? 16 : 14} />
              {expanded ? 'Indicators' : 'Ind'}
            </button>
            {showIndicatorMenu && (
              <div
                className="absolute z-30 mt-1 left-0 rounded-lg p-3 space-y-2 shadow-lg"
                style={{ background: 'var(--panel2)', border: '1px solid var(--border)', minWidth: 200 }}
              >
                {INDICATOR_DEFS.map(ind => (
                  <label
                    key={ind.key}
                    className="flex items-center gap-2.5 font-mono text-[13px] cursor-pointer whitespace-nowrap min-h-[40px]"
                    style={{ color: 'var(--textDim)' }}
                  >
                    <input
                      type="checkbox"
                      className="w-4 h-4"
                      checked={!!indicators[ind.key]}
                      onChange={() => setIndicators(s => ({ ...s, [ind.key]: !s[ind.key] }))}
                    />
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: ind.color }} />
                    {ind.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1" />
          {ohlcReadout && expanded && (
            <div className="font-mono text-[11px] flex gap-2 shrink-0 hidden sm:flex" style={{ color: 'var(--textDim)' }}>
              <span>O <span style={{ color: 'var(--text)' }}>{fmtPrice(symbol, ohlcReadout.o)}</span></span>
              <span>H <span style={{ color: 'var(--emerald)' }}>{fmtPrice(symbol, ohlcReadout.h)}</span></span>
              <span>L <span style={{ color: 'var(--coral)' }}>{fmtPrice(symbol, ohlcReadout.l)}</span></span>
              <span>C <span style={{ color: 'var(--text)' }}>{fmtPrice(symbol, ohlcReadout.c)}</span></span>
            </div>
          )}
          {expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              title="Close full chart"
              className="font-mono px-3 py-2.5 rounded flex items-center gap-1.5 min-h-[44px] min-w-[44px] text-[12px] shrink-0"
              style={{ color: 'var(--text)', border: '1px solid var(--border)', background: 'var(--panel2)' }}
            >
              <Minimize2 size={18} /> Close
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="font-mono rounded flex items-center gap-1.5 text-[12px] px-3 py-2 min-h-[40px] min-w-[40px] shrink-0"
              style={{ color: '#05070a', background: 'var(--emerald)', border: 'none', fontWeight: 700, boxShadow: '0 0 0 1px rgba(31,227,168,0.35)' }}
              title="Expand chart full screen"
            >
              <Maximize2 size={18} strokeWidth={2.5} /> Full
            </button>
          )}
        </div>
      </div>
      <div className="omni-chart-canvas-wrap flex-1 min-h-0">
        {status === 'empty' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <WaitingForBackend height={120} label="No chart data yet — try H1 or wait a minute" />
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <WaitingForBackend height={120} label="Chart temporarily unavailable — retrying…" />
          </div>
        )}
        {status === 'loading' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <WaitingForBackend height={120} label="Loading candles…" />
          </div>
        )}
        <div ref={containerRef} className="omni-chart-canvas" style={{ opacity: status === 'ok' ? 1 : 0.2 }} />
        {/* Volume Profile overlay — left-side histogram locked to price scale */}
        <canvas
          ref={vpCanvasRef}
          className="pointer-events-none absolute inset-0 z-[5]"
          style={{ display: indicators.vp ? 'block' : 'none' }}
          aria-hidden
        />
      </div>
    </div>
  );
}

/* ── WHAT TO EXPECT (session / today / this week) ──────────────────────
 * Session context, regime, and COT-extreme data were already computed by
 * MarketOutlookBuilder and existed — buried as a single 220-char
 * truncated line inside MarketVoice's ticker. This surfaces the same
 * data as three clearly labeled sections instead of prose someone has
 * to read past the ellipsis to get anything from. "This Week" pulls
 * from the calendar prop (the actual /api/calendar data — outlook
 * deliberately doesn't carry calendar; see market-outlook.js's note
 * field) since that's the correct source, not a new one.
 */
function WhatToExpect({ outlook, calendar, now, mode }) {
  const live = mode === 'live' && outlook;
  if (!live) return null;

  // FIX: adopted MarketOutlookBuilder.sessionInfo()'s canonical shape
  // ({name, note, utcHour, label}) after a concurrent session built the
  // same session-context idea independently, with better session
  // boundaries (splits London/NY overlap from plain NY) and a genuinely
  // useful human-readable .note instead of a bare liquidity adjective.
  const session = outlook.session || { name: 'Off-hours', utcHour: new Date(now).getUTCHours(), note: '', label: 'Off-hours' };

  const symbols = outlook.symbols || [];
  const withRegime = symbols.filter(s => s.regime && s.regime !== 'UNKNOWN');
  const ranked = [...withRegime].sort((a, b) => (Number(b.tradeability) || 0) - (Number(a.tradeability) || 0));
  const best = ranked[0];
  const gated = symbols.filter(s => s.sessionStatus && s.sessionStatus !== 'CLEAR');
  const extremes = symbols.filter(s => s.institutionalPositioning?.isExtreme);

  const weekEvents = (calendar || [])
    .filter(e => Number.isFinite(e.time) && e.time > now && e.time < now + 7 * 86400000)
    .filter(e => String(e.impact || '').toLowerCase() !== 'low')
    .sort((a, b) => a.time - b.time)
    .slice(0, 5);

  const fmtCountdown = (ms) => {
    const h = ms / 3600000;
    if (h < 1) return `${Math.round(ms / 60000)}m`;
    if (h < 24) return `${h.toFixed(1)}h`;
    return `${Math.round(h / 24)}d`;
  };

  return (
    <div className="omni-panel p-3">
      <SectionHeader icon={Globe2} title="What to Expect" sub="session · today · this week" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-1">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--textFaint)' }}>This Session</div>
          <div className="text-[13px] font-medium mb-1" style={{ color: 'var(--text)' }}>{session.name}</div>
          <div className="font-mono text-[10px]" style={{ color: 'var(--textDim)' }}>
            {String(session.utcHour).padStart(2, '0')}:00 UTC{session.note ? ` — ${session.note}` : ''}
          </div>
        </div>

        <div>
          <div className="font-mono text-[9px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--textFaint)' }}>Today</div>
          {best ? (
            <>
              <div className="text-[13px] font-medium mb-1" style={{ color: 'var(--text)' }}>
                Focus: {best.symbol} <span style={{ color: 'var(--textDim)', fontWeight: 400 }}>({best.regime})</span>
              </div>
              <div className="font-mono text-[10px]" style={{ color: 'var(--textDim)' }}>
                {gated.length > 0 ? `${gated.length} symbol${gated.length > 1 ? 's' : ''} session-gated` : 'No session gates active'}
                {extremes.length > 0 && ` · ${extremes.length} COT extreme`}
              </div>
            </>
          ) : (
            <div className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>No regime scores yet — waiting on OHLC candles.</div>
          )}
        </div>

        <div>
          <div className="font-mono text-[9px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--textFaint)' }}>This Week</div>
          {weekEvents.length > 0 ? (
            <div className="space-y-1">
              {weekEvents.map((e, i) => (
                <div key={i} className="font-mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--textDim)' }}>
                  <span style={{ color: String(e.impact).toLowerCase() === 'high' ? 'var(--coral)' : 'var(--gold)' }}>●</span>
                  <span className="truncate" style={{ color: 'var(--text)' }}>{e.name}</span>
                  <span style={{ color: 'var(--textFaint)', flexShrink: 0 }}>in {fmtCountdown(e.time - now)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>No high/medium-impact events in the next 7 days.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── DASH ───────────────────────────────────────────────────────────── */
function DashTab({ signals, accountBalance, journalStats, prices, quotes, changes, mode, outlook, now, levels, analysisLive, socketLive, cryptoVolAlerts, calendar }) {
  const approved = signals.filter(s => s.gate?.status === 'approved' || s.gate?.status === 'APPROVED');
  const recent = signals.slice(0, 12);
  const [chartSymbol, setChartSymbol] = useState('XAUUSD');
  const q = quotes?.[chartSymbol];
  const chartSignals = useMemo(() => signals.filter(s => s.symbol === chartSymbol), [signals, chartSymbol]);

  return (
    <div className="p-2 sm:p-3 space-y-2 w-full">
      {/* Real-time status — compact on phone */}
      <div className="omni-panel px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] sm:text-[11px]" style={{ color: 'var(--textDim)' }}>
        <span style={{ color: socketLive ? 'var(--emerald)' : 'var(--textFaint)' }}>{socketLive ? '● PUSH' : '○ POLL'}</span>
        <span style={{ color: analysisLive ? 'var(--gold)' : 'var(--textFaint)' }}>
          {analysisLive
            ? `● SCAN ${analysisLive.symbol || ''} ${analysisLive.timeframe || ''}${analysisLive.regime ? ' · ' + analysisLive.regime : ''}`
            : '○ SCAN —'}
        </span>
        <span className="hidden sm:inline" style={{ color: 'var(--textFaint)' }}>MT5 + Deriv · always on</span>
      </div>
      {Array.isArray(cryptoVolAlerts) && cryptoVolAlerts.length > 0 && (
        <div className="omni-panel px-3 py-2 space-y-1">
          <div className="font-mono text-[10px] uppercase" style={{ color: 'var(--gold)' }}>Volatility alerts · gold + crypto</div>
          {cryptoVolAlerts.slice(0, 5).map((a, i) => (
            <div key={i} className="font-mono text-[11px] flex flex-wrap gap-2" style={{ color: a.direction === 'UP' ? 'var(--emerald)' : 'var(--coral)' }}>
              <span>{a.symbol}</span>
              <span>{a.assetClass === 'gold' ? 'GOLD' : 'CRYPTO'}</span>
              <span>{a.direction}</span>
              <span>{a.absPct}% / {a.window}</span>
              <span style={{ color: 'var(--textFaint)' }}>{a.severity}</span>
            </div>
          ))}
        </div>
      )}
      <WhatToExpect outlook={outlook} calendar={calendar} now={now || Date.now()} mode={mode} />
      {/* LIVE TICKS FIRST — no scroll required */}
      <div className="omni-home-grid">
        {/* Chart first — symbol/TF controls only inside Full chart (no duplicate chips here) */}
        <div className="omni-panel p-2 md:p-3 order-1 lg:order-1">
          <div className="flex items-center justify-between gap-2 mb-1 font-mono text-[11px]" style={{ color: 'var(--textDim)' }}>
            <span>
              Chart · <span style={{ color: 'var(--text)' }}>{symLabel(chartSymbol)}</span>
              {q?.bid != null && q?.ask != null && (
                <>
                  {' '}
                  <span style={{ color: 'var(--coral)' }}>{fmtPrice(chartSymbol, q.bid)}</span>
                  {' / '}
                  <span style={{ color: 'var(--emerald)' }}>{fmtPrice(chartSymbol, q.ask)}</span>
                </>
              )}
            </span>
            {q?.source === 'mt5_ea' && <Pill tone="up">MT5</Pill>}
          </div>
          <ErrorBoundary key={chartSymbol} label="the chart">
            <LiveChart symbol={chartSymbol} quote={q} signals={chartSignals} levels={levels} onSymbolChange={setChartSymbol} />
          </ErrorBoundary>
        </div>

        <div className="omni-panel overflow-hidden order-2 xl:order-2 flex flex-col max-h-[min(55vh,480px)] sm:max-h-[min(50vh,520px)] xl:max-h-[min(60vh,720px)] min-h-[280px]">
          <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
            <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--textFaint)' }}>Market Watch · live</span>
          </div>
          <div className="overflow-y-auto omni-scroll flex-1 min-w-0">
            {SYMBOLS.map(sym => {
              const qq = quotes?.[sym];
              const ch = changes?.[sym];
              const up = ch == null ? null : ch >= 0;
              const bid = qq?.bid ?? qq?.price ?? prices?.[sym];
              const ask = qq?.ask ?? qq?.price ?? prices?.[sym];
              return (
                <button
                  key={sym}
                  type="button"
                  onClick={() => setChartSymbol(sym)}
                  className="omni-row w-full px-3 py-2.5 font-mono text-left border-b min-w-0"
                  style={{
                    borderColor: 'var(--border)',
                    background: chartSymbol === sym ? 'var(--panel2)' : 'transparent',
                    minHeight: 52,
                  }}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text)' }}>
                      {symLabel(sym)}
                      {qq?.source === 'mt5_ea' && <span className="ml-1 text-[9px] font-normal" style={{ color: 'var(--gold)' }}>MT5</span>}
                    </span>
                    {ch != null && (
                      <span className="text-[11px] shrink-0 tabular-nums" style={{ color: up ? 'var(--emerald)' : 'var(--coral)' }}>
                        {fmtPct(ch)}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded px-2 py-1.5 min-w-0" style={{ background: 'rgba(255,84,112,0.08)' }}>
                      <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--textFaint)' }}>Buy · Bid</div>
                      <div className="text-[12px] sm:text-[13px] tabular-nums font-semibold truncate" style={{ color: 'var(--coral)' }}>
                        {fmtPrice(sym, bid)}
                      </div>
                    </div>
                    <div className="rounded px-2 py-1.5 min-w-0" style={{ background: 'rgba(31,227,168,0.08)' }}>
                      <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--textFaint)' }}>Sell · Ask</div>
                      <div className="text-[12px] sm:text-[13px] tabular-nums font-semibold truncate" style={{ color: 'var(--emerald)' }}>
                        {fmtPrice(sym, ask)}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Market voice includes S/R — below ticks */}
      <MarketVoice now={now || Date.now()} signals={signals} quotes={quotes} outlook={outlook} mode={mode} />

      <div className="omni-panel overflow-hidden">
        <SectionHeader icon={Radio} title="Recent signals" sub={`${recent.length} latest · approved ${approved.length} · all saved to MongoDB`} />
        {recent.length === 0 ? (
          <div className="p-3 font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
            No signals yet. Live prices keep running — signals fire only when score, agents, and gates clear.
          </div>
        ) : (
          <div className="divide-y max-h-[240px] overflow-y-auto omni-scroll" style={{ borderColor: 'var(--border)' }}>
            {recent.map(s => (
              <div key={s.id} className="px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]">
                <span className="font-semibold" style={{ color: 'var(--text)' }}>{symLabel(s.symbol)}</span>
                <span style={{ color: 'var(--textDim)' }}>{s.timeframe}</span>
                <span style={{ color: (s.action === 'BUY' || s.action === 'LONG') ? 'var(--emerald)' : 'var(--coral)' }}>{s.action}</span>
                <span style={{ color: 'var(--gold)' }}>{s.score}</span>
                <span style={{ color: 'var(--textDim)' }}>@ {fmtPrice(s.symbol, s.entry)}</span>
                <Pill tone={s.gate?.status === 'approved' || s.gate?.status === 'APPROVED' ? 'up' : 'warn'}>{s.gate?.status || '—'}</Pill>
                <span className="ml-auto text-[10px]" style={{ color: 'var(--textFaint)' }}>{timeAgo(s.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard label="Signals" value={signals.length} icon={Zap} accent="var(--violet)" />
        <StatCard label="Approved" value={approved.length} icon={CheckCircle2} />
        <StatCard label="Balance" value={accountBalance != null ? `$${Number(accountBalance).toLocaleString()}` : '—'} icon={Target} accent="var(--gold)" />
        <StatCard label="Win rate" value={journalStats?.winRate != null ? `${journalStats.winRate}%` : '—'} icon={Activity} accent="var(--blue)" />
      </div>
    </div>
  );
}

function SignalsTab({ signals, prices, quotes, auditLog, analysisLive }) {
  const [expanded, setExpanded] = useState(null);
  const [desk, setDesk] = useState('ALL');
  const DESKS = {
    ALL: SYMBOLS,
    GOLD: ['XAUUSD'],
    OIL: ['USOIL'],
    DXY: ['UUP'],
    CRYPTO: ['BTCUSDT', 'ETHUSDT'],
    FX: ['EURUSD', 'GBPUSD', 'USDJPY'],
  };
  const deskSymbols = DESKS[desk] || SYMBOLS;
  const filtered = signals.filter(s => deskSymbols.includes(s.symbol));
  const checks = (Array.isArray(auditLog) ? auditLog : [])
    .filter(e => deskSymbols.includes(e.symbol) || desk === 'ALL')
    .slice(0, 25);
  const nearMiss = checks.filter(e => !e.fired && (e.nearMiss || Number(e.score) >= 50));
  const fired = checks.filter(e => e.fired);

  return (
    <div className="p-2 sm:p-3 space-y-2 sm:space-y-3 w-full max-w-[100vw]">
<div className="flex items-center gap-2 flex-wrap">
        <SectionHeader icon={Radio} title="Signal Desks" sub={`${filtered.length} signal(s) · MT5 or Deriv prices`} />
        <div className="ml-auto flex gap-1 flex-wrap">
          {Object.keys(DESKS).map(d => (
            <button key={d} onClick={() => setDesk(d)}
              className="font-mono text-[10px] px-2.5 py-1 rounded uppercase"
              style={{ background: desk === d ? 'var(--emerald)' : 'var(--panel2)', color: desk === d ? '#05070a' : 'var(--textDim)' }}>
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Per-symbol quote strip for this desk */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {deskSymbols.map(sym => {
          const q = quotes?.[sym];
          const mid = q?.price ?? prices?.[sym];
          const n = signals.filter(s => s.symbol === sym).length;
          return (
            <div key={sym} className="omni-panel2 px-2.5 py-2 font-mono text-[10px]">
              <div className="flex justify-between mb-1">
                <span style={{ color: 'var(--text)' }}>{sym}</span>
                <span style={{ color: q?.source === 'mt5_ea' ? 'var(--gold)' : 'var(--textFaint)' }}>{q?.source === 'mt5_ea' ? 'MT5' : q?.source === 'deriv' ? 'Deriv' : (q?.source || '—')}</span>
              </div>
              {q?.bid != null && q?.ask != null ? (
                <div className="flex gap-2">
                  <span style={{ color: 'var(--coral)' }}>{fmtPrice(sym, q.bid)}</span>
                  <span style={{ color: 'var(--emerald)' }}>{fmtPrice(sym, q.ask)}</span>
                </div>
              ) : (
                <div style={{ color: 'var(--textDim)' }}>{fmtPrice(sym, mid)}</div>
              )}
              <div className="mt-1" style={{ color: 'var(--textFaint)' }}>{n} signal{n === 1 ? '' : 's'}</div>
            </div>
          );
        })}
      </div>

      <div className="omni-panel overflow-hidden">
        <div className="omni-table-scroll">
          <div className="omni-table-grid">
            <div className="grid grid-cols-[70px_46px_44px_44px_1fr_1fr_1fr_70px_50px] gap-2 px-3 py-2 font-mono text-[9px] uppercase tracking-wider border-b" style={{ color: 'var(--textFaint)', borderColor: 'var(--border)' }}>
              <span>Symbol</span><span>TF</span><span>Dir</span><span>Grade</span><span>Entry</span><span>Stop</span><span>Targets</span><span>Gate</span><span>Age</span>
            </div>
            <div className="max-h-[min(520px,55vh)] overflow-y-auto omni-scroll">
              {filtered.length === 0 ? (
                <div className="p-6 font-mono text-[11px] text-center" style={{ color: 'var(--textFaint)' }}>
                  No signals for this desk yet. The engine only fires when score ≥ min, agents agree, and risk gates pass — not on every tick.
                </div>
              ) : filtered.map(s => (
                <div key={s.id}>
                  <div onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                    className="omni-row grid grid-cols-[70px_46px_44px_44px_1fr_1fr_1fr_70px_50px] gap-2 px-3 py-2.5 font-mono text-[11px] cursor-pointer border-b items-center"
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
                <div className="border-b" style={{ borderColor: 'var(--border)', background: '#080a0d' }}>
                  {/* Identity strip always visible on expand — fixes mobile where table columns scroll away */}
                  <div className="px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--panel2)' }}>
                    <span className="font-mono text-[13px] font-semibold tracking-wide" style={{ color: 'var(--text)' }}>{s.symbol}</span>
                    <span className="font-mono text-[11px] px-1.5 py-0.5 rounded" style={{ color: 'var(--textDim)', background: 'var(--panel)' }}>{s.timeframe}</span>
                    <span className="font-mono text-[12px] font-semibold" style={{ color: (s.action === 'BUY' || s.action === 'LONG') ? 'var(--emerald)' : 'var(--coral)' }}>{s.action}</span>
                    <span className="font-mono text-[12px]" style={{ color: 'var(--gold)' }}>{gradeFor(s.score)} · {signalScore(s)}</span>
                    <Pill tone={s.gate?.status === 'approved' ? 'up' : s.gate?.status === 'gated' ? 'warn' : 'down'}>{s.gate?.status || '—'}</Pill>
                    <span className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>{timeAgo(s.timestamp)}</span>
                    <div className="w-full flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px]">
                      <span style={{ color: 'var(--textDim)' }}>Entry <b style={{ color: 'var(--text)' }}>{fmtPrice(s.symbol, s.entry)}</b></span>
                      <span style={{ color: 'var(--textDim)' }}>SL <b style={{ color: 'var(--coral)' }}>{fmtPrice(s.symbol, s.stopLoss)}</b></span>
                      <span style={{ color: 'var(--textDim)' }}>TP1 <b style={{ color: 'var(--emerald)' }}>{fmtPrice(s.symbol, s.targets?.[0])}</b></span>
                      <span style={{ color: 'var(--textDim)' }}>TP2 <b style={{ color: 'var(--emerald)' }}>{fmtPrice(s.symbol, s.targets?.[1])}</b></span>
                    </div>
                  </div>
                  <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
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
                </div>
              )}
            </div>
          ))}
            </div>
          </div>
        </div>
      </div>

      <div className="omni-panel p-3">
        <SectionHeader icon={ScrollText} title="Gate checks" sub={`${nearMiss.length} near miss · ${fired.length} fired recently`} />
        {checks.length === 0 ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
            No checks logged yet. Wait for analysis (needs candles from Deriv or MT5).
          </div>
        ) : (
          <div className="space-y-1 max-h-56 overflow-y-auto omni-scroll">
            {checks.map((e, i) => (
              <div key={e.id || i} className="flex flex-wrap items-start gap-2 font-mono text-[10px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                <span style={{ color: 'var(--textFaint)' }} className="w-10 shrink-0">{timeAgo(e.timestamp || Date.now())}</span>
                <span style={{ color: 'var(--text)' }} className="w-16 shrink-0">{e.symbol}</span>
                {e.fired
                  ? <span style={{ color: 'var(--emerald)' }}>FIRED</span>
                  : <span style={{ color: e.nearMiss || Number(e.score) >= 50 ? 'var(--gold)' : 'var(--textFaint)' }}>{e.nearMiss || Number(e.score) >= 50 ? 'NEAR' : 'block'}</span>}
                {e.score != null && <span style={{ color: 'var(--textDim)' }}>score {e.score}</span>}
                <span style={{ color: 'var(--textDim)' }} className="min-w-0 break-words flex-1">
                  {(Array.isArray(e.gatesFailed) && e.gatesFailed.length) ? `failed: ${e.gatesFailed.join(', ')}` : ''}
                  {(Array.isArray(e.gatesPassed) && e.gatesPassed.length) ? ` · passed: ${e.gatesPassed.join(', ')}` : ''}
                  {' · '}{(Array.isArray(e.reasons) ? e.reasons : []).join(', ') || 'checked'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      
    </div>
  );
}

function IntelTab({ now, outlook, mode, calendar, levels }) {
  const live = mode === 'live' && outlook;

  const session = live ? (outlook.session || null) : null;
  const narrativeLines = live
    ? (Array.isArray(outlook.narrativeLines) && outlook.narrativeLines.length
        ? outlook.narrativeLines
        : String(outlook.narrative || '').split(/(?<=\.)\s+/).filter(Boolean))
    : null;

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
  const calendarRows = Array.isArray(calendar) && calendar.length
    ? calendar.slice(0, 60).map(e => ({
        name: e.name,
        currency: e.currency,
        impact: e.impact || '—',
        hoursAway: e.hoursAway,
      }))
    : [];

  const highSoon = calendarRows.filter(e =>
    String(e.impact).toLowerCase() === 'high' && e.hoursAway != null && e.hoursAway >= 0 && e.hoursAway <= 48
  ).slice(0, 6);

  return (
    <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
      <div className="omni-panel p-4">
        <SectionHeader icon={Globe2} title="What to expect" sub={session ? session.label : (live ? 'live' : undefined)} />
        {!live ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>Waiting for outlook…</div>
        ) : (
          <div className="space-y-3">
            {session && (
              <div className="font-mono text-[12px] leading-relaxed" style={{ color: 'var(--text)' }}>
                <span style={{ color: 'var(--emerald)' }}>{session.name}</span>
                <span style={{ color: 'var(--textFaint)' }}> · {String(session.utcHour).padStart(2, '0')}:00 UTC — </span>
                <span style={{ color: 'var(--textDim)' }}>{session.note}</span>
              </div>
            )}
            {narrativeLines && narrativeLines.length > 0 ? (
              <ul className="space-y-1.5 list-none p-0 m-0">
                {narrativeLines.map((line, i) => (
                  <li key={i} className="text-[12px] leading-relaxed flex gap-2" style={{ color: i === 0 ? 'var(--text)' : 'var(--textDim)' }}>
                    <span style={{ color: 'var(--emerald)', flexShrink: 0 }}>▸</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No briefing yet.</div>
            )}
            {highSoon.length > 0 && (
              <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <div className="font-mono text-[9px] uppercase mb-1.5" style={{ color: 'var(--textFaint)' }}>High impact within 48h</div>
                {highSoon.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 font-mono text-[11px] py-0.5">
                    <Pill tone="down">high</Pill>
                    <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--textDim)' }}>{e.name}</span>
                    <span style={{ color: 'var(--textFaint)' }}>{e.currency}</span>
                    <span style={{ color: 'var(--textFaint)' }}>{e.hoursAway}h</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={Activity} title="Regime / Tradeability" sub="per symbol" />
        {!regimeRows ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>Waiting…</div>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto omni-scroll">
            {regimeRows.map(s => (
              <div key={s.symbol} className="flex items-center gap-2 font-mono text-[11px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                <span className="w-16" style={{ color: 'var(--text)' }}>{s.symbol}</span>
                <span className="flex-1" style={{ color: 'var(--textDim)' }}>{s.regime}</span>
                <span style={{ color: 'var(--textFaint)' }}>{s.tradeability != null ? Math.round(Number(s.tradeability)) : '—'}</span>
                <Pill tone={s.sessionStatus === 'CLEAR' ? 'up' : s.sessionStatus ? 'warn' : 'neutral'}>{s.sessionStatus || '—'}</Pill>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={Target} title="COT / Positioning" sub="when available" />
        {!cotRows ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>Waiting…</div>
        ) : cotRows.length === 0 ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No COT rows yet.</div>
        ) : (
          <div className="space-y-1">
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

      <div className="omni-panel p-4">
        <SectionHeader icon={Clock} title="Economic Calendar" sub="Forex Factory · this week · High first" />
        {calendarRows.length > 0 ? (
          <div className="space-y-1.5 max-h-80 overflow-y-auto omni-scroll">
            {calendarRows.map((e, i) => (
              <div key={`${e.name}-${i}`} className="flex items-center gap-2 font-mono text-[11px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                <Pill tone={String(e.impact).toLowerCase() === 'high' ? 'down' : String(e.impact).toLowerCase() === 'medium' ? 'warn' : 'neutral'}>{e.impact || '—'}</Pill>
                <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--textDim)' }}>{e.name}</span>
                <span style={{ color: 'var(--textFaint)' }}>{e.currency}</span>
                <span className="shrink-0" style={{ color: 'var(--textFaint)' }}>
                  {e.hoursAway != null ? (e.hoursAway < 0 ? `${Math.abs(e.hoursAway)}h ago` : `in ${e.hoursAway}h`) : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="font-mono text-[11px] leading-relaxed space-y-1" style={{ color: 'var(--textFaint)' }}>
            <div>No calendar rows yet.</div>
            <div>Source: Forex Factory via /api/calendar after deploy.</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── NEWS ───────────────────────────────────────────────────────────── */
function NewsTab({ news, mode }) {
  const live = mode === 'live' && Array.isArray(news);
  const [cat, setCat] = useState('all');
  const [selected, setSelected] = useState(null);
  const CATS = [
    { id: 'all', label: 'All markets' },
    { id: 'crypto', label: 'Crypto' },
    { id: 'forex', label: 'Forex' },
    { id: 'macro', label: 'Macro / Fed' },
    { id: 'gold', label: 'Gold' },
    { id: 'oil', label: 'Oil' },
  ];
  const MARKET_RE = /bitcoin|btc|ethereum|eth|crypto|defi|stablecoin|solana|sec\b|etf|binance|coinbase|forex|fx\b|eurusd|gbpusd|usdjpy|currency|dollar|dxy|fed\b|fomc|ecb|boj|boe|cpi|nfp|inflation|interest rate|treasury|yield|gold|xau|oil|wti|brent|opec|nasdaq|s&p|liquidity|central bank|risk.?on|risk.?off|payroll/i;
  const NOISE_RE = /celebrity|sports|football|nba|movie|netflix|recipe|horoscope|weather forecast|gossip/i;
  const CRYPTO_RE = /bitcoin|btc|ethereum|eth|crypto|defi|stablecoin|solana|binance|coinbase|sec\b.*crypto|crypto.*etf/i;
  const FOREX_RE = /forex|fx\b|eurusd|gbpusd|usdjpy|currency|dxy|dollar index|ecb|boj|boe/i;

  const rankItem = (n) => {
    const h = `${n.headline || ''} ${n.summary || ''} ${n.category || ''}`;
    let r = 0;
    if (CRYPTO_RE.test(h)) r += 10;
    if (FOREX_RE.test(h)) r += 10;
    if (/fed\b|fomc|cpi|nfp|inflation/i.test(h)) r += 4;
    if (/gold|xau|oil|wti/i.test(h)) r += 2;
    return r;
  };

  const filtered = !live || !Array.isArray(news) ? null : news
    .filter(n => {
      const h = `${n.headline || ''} ${n.summary || ''} ${n.category || ''}`;
      if (NOISE_RE.test(h)) return false;
      if (!MARKET_RE.test(h)) return false;
      if (cat === 'all') return true;
      const c = (n.category || '').toLowerCase();
      const t = h.toLowerCase();
      if (cat === 'crypto') return c === 'crypto' || CRYPTO_RE.test(t);
      if (cat === 'forex') return c === 'forex' || FOREX_RE.test(t) || /eur|gbp|jpy|dollar/.test(t);
      if (cat === 'macro') return /fed\b|fomc|ecb|boj|boe|cpi|nfp|inflation|interest rate|treasury|yield|central bank|payroll/.test(t);
      if (cat === 'gold') return c === 'gold' || /gold|xau|bullion/.test(t);
      if (cat === 'oil') return c === 'oil' || /oil|opec|wti|brent|crude/.test(t);
      return true;
    })
    .slice()
    .sort((a, b) => rankItem(b) - rankItem(a) || ((b.datetime || 0) - (a.datetime || 0)));

  const items = filtered;
  const hasBody = (n) => {
    const s = String(n?.summary || '').trim();
    return s.length >= 40;
  };

  const when = (dt) => {
    if (!dt) return '';
    const ms = dt < 1e12 ? dt * 1000 : dt;
    return timeAgo(ms);
  };

  const openExternal = (url) => {
    if (!url) return;
    try {
      if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (_) {
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (__) {}
    }
  };

  if (selected) {
    const readable = hasBody(selected);
    return (
      <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="omni-chip font-mono text-[12px] px-3 py-2 rounded min-h-[40px]"
          style={{ color: 'var(--emerald)', border: '1px solid var(--border)', background: 'var(--panel2)' }}
        >
          ← Back to news
        </button>
        <div className="omni-panel p-4 space-y-3">
          {selected.image ? (
            <img
              src={selected.image}
              alt=""
              className="w-full rounded object-cover max-h-48"
              style={{ background: 'var(--panel2)' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : null}
          <div className="font-mono text-[10px] uppercase" style={{ color: 'var(--textFaint)' }}>
            {selected.source || 'Market wire'} · {when(selected.datetime)} ago
            {selected.category ? ` · ${selected.category}` : ''}
          </div>
          <h2 className="text-[18px] font-semibold leading-snug" style={{ color: 'var(--text)' }}>
            {selected.headline}
          </h2>
          <div className="text-[14px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--textDim)' }}>
            {readable
              ? selected.summary
              : 'Only a headline is available from this wire — open the source for the full article.'}
          </div>
          {selected.url ? (
            <button
              type="button"
              onClick={() => openExternal(selected.url)}
              className="omni-chip font-mono text-[12px] px-4 py-2.5 rounded min-h-[44px] w-full sm:w-auto"
              style={{
                color: readable ? 'var(--textDim)' : '#05070a',
                background: readable ? 'var(--panel)' : 'var(--emerald)',
                border: '1px solid var(--border)',
                fontWeight: readable ? 500 : 700,
              }}
            >
              {readable ? 'Open full article on source' : 'Read full article on source →'}
            </button>
          ) : (
            <div className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>
              No external link provided for this item.
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-3 space-y-2 sm:space-y-3 w-full max-w-[100vw]">
      <SectionHeader icon={Newspaper} title="Market news" sub="Crypto & Forex first · in-app, source link if needed" />
      <div className="flex gap-1 flex-wrap">
        {CATS.map(c => (
          <button key={c.id} type="button" onClick={() => setCat(c.id)}
            className="font-mono text-[10px] px-2.5 py-1.5 rounded uppercase min-h-[32px]"
            style={{ background: cat === c.id ? 'var(--emerald)' : 'var(--panel2)', color: cat === c.id ? '#05070a' : 'var(--textDim)' }}>{c.label}</button>
        ))}
      </div>

      {items === null ? (
        <div className="omni-panel p-4"><WaitingForBackend height={200} /></div>
      ) : items.length === 0 ? (
        <div className="omni-panel p-4 font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
          No market-relevant headlines yet for this filter.
        </div>
      ) : (
        <div className="omni-panel overflow-hidden">
          <div className="space-y-0 max-h-[min(70vh,640px)] overflow-y-auto omni-scroll">
            {items.map((n, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelected(n)}
                className="omni-row w-full flex items-start gap-3 px-3 py-3 text-left border-b"
                style={{ borderColor: 'var(--border)' }}
              >
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
                  <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                    {CRYPTO_RE.test(`${n.headline} ${n.category}`) && (
                      <span className="font-mono text-[9px] px-1.5 py-0.5 rounded" style={{ color: '#f0b429', background: 'rgba(240,180,41,0.12)' }}>CRYPTO</span>
                    )}
                    {FOREX_RE.test(`${n.headline} ${n.category}`) && (
                      <span className="font-mono text-[9px] px-1.5 py-0.5 rounded" style={{ color: '#5ea8ff', background: 'rgba(94,168,255,0.12)' }}>FOREX</span>
                    )}
                  </div>
                  <div className="text-[13px] leading-snug" style={{ color: 'var(--text)' }}>{n.headline}</div>
                  {n.summary ? (
                    <div className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--textDim)' }}>{n.summary}</div>
                  ) : (
                    <div className="text-[10px] mt-1 font-mono" style={{ color: 'var(--textFaint)' }}>Headline only — open source for full story</div>
                  )}
                  <div className="font-mono text-[9px] uppercase mt-1" style={{ color: 'var(--textFaint)' }}>
                    {n.source || 'Wire'} · {when(n.datetime)} ago{n.category ? ` · ${n.category}` : ''}
                  </div>
                </div>
                <ChevronRight size={16} className="shrink-0 mt-1" style={{ color: 'var(--textFaint)' }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── MONITOR ────────────────────────────────────────────────────────── */
function MonitorTab({ auditLog, feedHealth, uptimeSec, mode, fetchErrors, analysisLive, socketLive }) {
  const liveByName = new Map();
  for (const f of (feedHealth || [])) {
    liveByName.set(f.name, f);
    const short = String(f.name || '').replace(/Feed$/i, '');
    if (short && short !== f.name) liveByName.set(short, f);
  }
  const feeds = FEEDS.map(f => {
    if (f.status === 'inert') return f;
    const live = liveByName.get(f.name);
    if (mode !== 'live') return f;
    // No health payload yet (login/cold start) → keep waiting
    if (!feedHealth || !feedHealth.length) return { ...f, status: 'unknown' };
    if (!live) {
      // Listed in UI but not registered on server this boot (no key / skipped)
      return { ...f, status: 'down', note: f.note || 'not started this boot' };
    }
    // Backend: connected | disconnected | unknown (unknown = REST feed with no isConnected)
    // Treat "unknown" as live when the feed is registered — it is running.
    const status = live.status === 'connected' || live.connected === true ? 'live'
      : live.status === 'disconnected' || live.connected === false ? 'down'
      : live.status === 'unknown' ? 'live'
      : 'live';
    return { ...f, status };
  });
  const uptimeLabel = mode === 'live' && uptimeSec != null
    ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
    : null;
  const activeErrors = Object.entries(fetchErrors || {}).filter(([, v]) => v);
  const liveCount = feeds.filter(f => f.status === 'live').length;

  return (
    <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
      <div className="omni-panel p-4">
        <SectionHeader
          icon={Database}
          title="Live feeds"
          sub={`${liveCount}/${feeds.length} live${uptimeLabel ? ` · up ${uptimeLabel}` : ''}`}
        />
        {(!feedHealth || !feedHealth.length) && mode === 'live' ? (
          <div className="font-mono text-[11px] mb-3" style={{ color: 'var(--gold)' }}>
            Feed status not loaded yet. Log in, wait a few seconds, or open Monitor again after the server finishes booting.
          </div>
        ) : null}
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
      <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
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
          {!heatmapTiles || heatmapTiles.length === 0 ? (
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
    <div className="p-2 sm:p-3 w-full max-w-[100vw]">
      <div className="omni-panel p-4">
        <SectionHeader icon={Flame} title="Market Heat Map" />
        <WaitingForBackend height={200} />
      </div>
    </div>
  );
}

/* ── ANALYSIS (standalone advanced fractal layer) ───────────────────── */
function StructureCard({ label, accent, value, valueColor, sub, pill, pillTone, note }) {
  return (
    <div className="rounded-lg border p-2.5 space-y-1.5" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: accent }} />
        <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color: 'var(--textFaint)' }}>{label}</span>
      </div>
      <div className="text-[15px] font-semibold font-mono" style={{ color: valueColor || 'var(--text)' }}>{value}</div>
      {sub && <div className="font-mono text-[9px]" style={{ color: 'var(--textFaint)' }}>{sub}</div>}
      {pill && <Pill tone={pillTone}>{pill}</Pill>}
      {note && (
        <div className="font-mono text-[9px] pt-1.5 mt-1 border-t leading-relaxed" style={{ color: 'var(--textFaint)', borderColor: 'var(--border)' }}>
          {note}
        </div>
      )}
    </div>
  );
}

function AnalysisTab({ mode }) {
  const live = mode === 'live';
  const [board, setBoard] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [ts, setTs] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    if (!live) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await omniFetch('/api/analysis?timeframes=H1,H4');
      if (!r?.ok) throw new Error(r?.error || 'analysis failed');
      setBoard(Array.isArray(r.board) ? r.board : []);
      setTs(Date.now());
    } catch (e) {
      setErr(e.message || 'fetch error');
    } finally {
      setLoading(false);
    }
  }, [live]);

  useEffect(() => {
    load();
    if (!live) return undefined;
    const id = setInterval(load, 45000);
    return () => clearInterval(id);
  }, [load, live]);

  if (!live) {
    return (
      <div className="p-2 sm:p-3 w-full max-w-[100vw]">
        <div className="omni-panel p-4">
          <SectionHeader icon={Layers} title="Advanced Analysis" />
          <WaitingForBackend height={240} label="Standalone analysis needs a live backend + candle history" />
        </div>
      </div>
    );
  }

  const playTone = (pb) => {
    if (pb === 'TREND_FOLLOW') return 'up';
    if (pb === 'MEAN_REVERT') return 'warn';
    return 'neutral';
  };
  const alphaTone = (a) => {
    if (a == null) return 'neutral';
    if (a >= 0.58) return 'up';
    if (a <= 0.42) return 'warn';
    return 'neutral';
  };

  return (
    <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
      <div className="omni-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <SectionHeader
            icon={Layers}
            title="Advanced Analysis"
            sub="standalone · Hurst · DFA · FRAMA · Lyapunov — not wired to signals"
          />
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="omni-chip font-mono text-[11px] px-3 py-1.5 rounded"
            style={{ background: 'var(--panel2)', color: loading ? 'var(--textFaint)' : 'var(--gold)', border: '1px solid var(--border)' }}
          >
            {loading ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
        <div className="font-mono text-[10px] mb-3" style={{ color: 'var(--textFaint)' }}>
          Independent path-dependence engine. Does not score signals or size risk.
          {ts ? ` · last update ${new Date(ts).toISOString().slice(11, 19)} UTC` : ''}
        </div>
        {err && (
          <div className="font-mono text-[11px] mb-2" style={{ color: 'var(--coral)' }}>Error: {err}</div>
        )}
        {board.length === 0 && !loading ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
            No analysis yet — need enough H1/H4 candles per symbol.
          </div>
        ) : (
          <div className="space-y-2">
            {board.map((row) => {
              const H = row.hurst?.H;
              const dfa = row.dfa;
              const frama = row.frama;
              const lyap = row.lyapunov;
              const open = selected === row.symbol;
              return (
                <div
                  key={row.symbol}
                  className="omni-row rounded-lg border"
                  style={{ borderColor: 'var(--border)', background: 'var(--panel2)' }}
                >
                  <button
                    type="button"
                    className="w-full text-left p-3 flex flex-wrap items-center gap-2"
                    onClick={() => setSelected(open ? null : row.symbol)}
                  >
                    <span className="font-display text-sm font-semibold tracking-wide" style={{ color: 'var(--text)' }}>
                      {symLabel(row.symbol)}
                    </span>
                    <span className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>
                      {row.timeframe} · {row.bars ?? '—'} bars
                    </span>
                    <Pill tone={playTone(row.playbook)}>{(row.playbook || 'STAND_ASIDE').replace(/_/g, ' ')}</Pill>
                    {row.bias && row.bias !== 'NONE' && (
                      <Pill tone={row.bias === 'DIRECTIONAL' ? 'up' : 'warn'}>{row.bias}</Pill>
                    )}
                    <span className="ml-auto font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>
                      {open ? '▲' : '▼'}
                    </span>
                  </button>
                  <div className="px-3 pb-3 grid grid-cols-2 lg:grid-cols-4 gap-2">
                    <StructureCard
                      label="Hurst R/S"
                      accent="var(--gold)"
                      value={H != null ? Number(H).toFixed(3) : '—'}
                      valueColor="var(--gold)"
                      sub={`conf ${row.hurst?.confidence != null ? `${Number(row.hurst.confidence).toFixed(0)}%` : '—'}`}
                      pill={row.hurst?.regime || 'R/S —'}
                      pillTone="neutral"
                      note={open ? row.hurst?.note : null}
                    />
                    <StructureCard
                      label="DFA"
                      accent="var(--emerald)"
                      value={dfa?.alpha != null ? Number(dfa.alpha).toFixed(3) : '—'}
                      valueColor={dfa ? 'var(--emerald)' : 'var(--textFaint)'}
                      sub={dfa ? `R² ${Number(dfa.rSquared ?? 0).toFixed(2)} · conf ${Number(dfa.confidence).toFixed(0)}%` : '—'}
                      pill={dfa?.regime ? String(dfa.regime).replace(/_/g, ' ') : 'DFA —'}
                      pillTone={alphaTone(dfa?.alpha)}
                      note={open ? dfa?.note : null}
                    />
                    <StructureCard
                      label="FRAMA"
                      accent="#22d3ee"
                      value={frama?.fractalDimension != null ? Number(frama.fractalDimension).toFixed(3) : '—'}
                      sub={frama?.speed || '—'}
                      note={open ? frama?.note : null}
                    />
                    <StructureCard
                      label="Lyapunov"
                      accent={lyap?.chaotic ? 'var(--coral)' : 'var(--text)'}
                      value={lyap?.exponent != null ? Number(lyap.exponent).toFixed(4) : '—'}
                      valueColor={lyap?.chaotic ? 'var(--coral)' : 'var(--text)'}
                      pill={lyap?.chaotic ? 'CHAOTIC' : 'stable'}
                      pillTone={lyap?.chaotic ? 'warn' : 'neutral'}
                      note={open ? lyap?.note : null}
                    />
                  </div>
                  {open && (
                    <div className="px-3 pb-3 space-y-2 border-t" style={{ borderColor: 'var(--border)' }}>
                      <div className="font-mono text-[10px] pt-2" style={{ color: 'var(--textFaint)' }}>
                        {row.detail || row.label}
                      </div>
                      {row.multi && Object.keys(row.multi).length > 1 && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {Object.entries(row.multi).map(([tf, m]) => (
                            <span
                              key={tf}
                              className="font-mono text-[10px] px-2 py-1 rounded"
                              style={{ background: 'var(--panel)', color: 'var(--textFaint)', border: '1px solid var(--border)' }}
                            >
                              {tf}: H={m.hurst?.H != null ? Number(m.hurst.H).toFixed(2) : '—'}
                              {m.dfa?.alpha != null ? ` · α=${Number(m.dfa.alpha).toFixed(2)}` : ''}
                              {' · '}{(m.playbook || '').replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="omni-panel p-4">
        <SectionHeader icon={FlaskConical} title="About this layer" sub="fully decoupled from signal pipeline" />
        <ul className="font-mono text-[10px] space-y-1" style={{ color: 'var(--textFaint)' }}>
          <li>• Own endpoint <span style={{ color: 'var(--gold)' }}>/api/analysis</span> + module <span style={{ color: 'var(--gold)' }}>advanced-analysis.js</span></li>
          <li>• R/S Hurst, hardened DFA (α + R²), FRAMA dimension/speed, Lyapunov λ</li>
          <li>• Does not write to journals, risk engine, or signal scorer</li>
          <li>• Refresh pulls a fresh board from candle stores only</li>
        </ul>
      </div>
    </div>
  );
}

/* ── VALID ──────────────────────────────────────────────────────────── */
function ValidTab({ signals, journalStats, learningProfiles, mode, hurstBoard }) {
  const live = mode === 'live';

  if (!live) {
    return (
      <div className="p-2 sm:p-3 w-full max-w-[100vw]">
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

  const hurstTone = (pb) => {
    if (pb === 'TREND_FOLLOW') return 'up';
    if (pb === 'MEAN_REVERT') return 'warn';
    return 'neutral';
  };

  return (
    <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
      {/* Dedicated Hurst analysis layer — not a trade signal */}
      <div className="omni-panel p-3 sm:p-4">
        <SectionHeader
          icon={Activity}
          title="Hurst analysis"
          sub="regime playbook · separate from signal votes"
        />
        <p className="font-mono text-[10px] mb-3 leading-relaxed" style={{ color: 'var(--textFaint)' }}>
          Path-dependence only. H&gt;0.55 trend-follow · H&lt;0.45 mean-revert (range fades) · ~0.5 stand aside.
          Does not fire trades — use with structure at range edges or trend pullbacks.
        </p>
        {!Array.isArray(hurstBoard) || hurstBoard.length === 0 ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
            Waiting for candle history… Hurst board fills after H1/H4 bars load.
          </div>
        ) : (
          <div className="space-y-2">
            {hurstBoard.map((row) => (
              <div
                key={row.symbol}
                className="omni-panel2 p-3 flex flex-col gap-1.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                    {typeof symLabel === 'function' ? symLabel(row.symbol) : row.symbol}
                  </span>
                  <span className="font-mono text-[10px]" style={{ color: 'var(--textDim)' }}>{row.timeframe || 'H1'}</span>
                  <Pill tone={hurstTone(row.playbook)}>{row.playbook?.replace('_', ' ') || '—'}</Pill>
                  {row.bias && row.bias !== 'NONE' && (
                    <span className="font-mono text-[11px] font-semibold" style={{ color: row.bias === 'LONG' ? 'var(--emerald)' : 'var(--coral)' }}>
                      {row.bias}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[12px]" style={{ color: 'var(--gold)' }}>
                    H={row.H != null ? Number(row.H).toFixed(3) : '—'}
                  </span>
                  {row.confidenceTier && (
                    <span className="font-mono text-[9px] px-1.5 py-0.5 rounded uppercase"
                      style={{
                        color: row.confidenceTier === 'HIGH' ? 'var(--emerald)' : row.confidenceTier === 'MEDIUM' ? 'var(--gold)' : 'var(--textFaint)',
                        border: '1px solid var(--border)',
                      }}
                    >{row.confidenceTier}</span>
                  )}
                </div>
                <div className="font-mono text-[11px]" style={{ color: 'var(--textDim)' }}>
                  {row.label || row.regime || '—'}
                  {row.confidence != null ? ` · conf ${Math.round(row.confidence)}%` : ''}
                </div>
                <div className="text-[11px] leading-relaxed" style={{ color: 'var(--textFaint)' }}>
                  {row.detail || row.note || ''}
                </div>
                {row.multi && (row.multi.H4 || row.multi.H1) && (
                  <div className="flex flex-wrap gap-2 mt-0.5 font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>
                    {['H1', 'H4'].map((tf) => row.multi[tf] && (
                      <span key={tf}>
                        {tf}: H={row.multi[tf].H != null ? Number(row.multi[tf].H).toFixed(2) : '—'} ({row.multi[tf].playbook || '—'})
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

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
    <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
      <div className="flex items-center gap-4">
        <StatCard label="Approved Signals" value={approved.length} icon={Activity} />
        <StatCard label="Avg Score" value={approved.length ? Math.round(approved.reduce((a, s) => a + s.score, 0) / approved.length) : '—'} icon={GaugeIcon} accent="var(--blue)" />
      </div>
      <div className="omni-panel overflow-hidden">
        <SectionHeader icon={ScrollText} title="Signal Queue" sub="approved, awaiting/pending EA execution — no live fills endpoint yet" />
        {mode !== 'live' ? <WaitingForBackend height={200} /> : approved.length === 0 ? (
          <div className="p-4 font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>No approved signals yet.</div>
        ) : (
          <div className="omni-table-scroll">
            <div className="omni-table-grid" style={{ minWidth: 360 }}>
              <div className="grid grid-cols-[70px_46px_44px_1fr_60px] gap-2 px-3 py-2 font-mono text-[9px] uppercase tracking-wider border-b border-t" style={{ color: 'var(--textFaint)', borderColor: 'var(--border)' }}>
                <span>Symbol</span><span>TF</span><span>Dir</span><span>Entry</span><span>Score</span>
              </div>
              <div className="max-h-96 overflow-y-auto omni-scroll">
                {approved.map(s => (
                  <div key={s.id} className="omni-row grid grid-cols-[70px_46px_44px_1fr_60px] gap-2 px-3 py-2.5 font-mono text-[11px] border-b items-center" style={{ borderColor: 'var(--border)' }}>
                    <span style={{ color: 'var(--text)' }}>{s.symbol}</span>
                    <span style={{ color: 'var(--textDim)' }}>{s.timeframe}</span>
                    <span style={{ color: s.action === 'BUY' ? 'var(--emerald)' : 'var(--coral)' }}>{s.action}</span>
                    <span style={{ color: 'var(--textDim)' }}>{fmtPrice(s.symbol, s.entry)}</span>
                    <span style={{ color: 'var(--gold)' }}>{s.score}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── DESK (Tape + Risk combined) ───────────────────────────────────── */
function DeskTab({ signals, prices, quotes, changes, accountBalance, relativeStrength, mode, stats }) {
  const approved = useMemo(() => signals.filter(s => s.gate?.status === 'approved' || s.gate?.status === 'APPROVED').slice(0, 30), [signals]);
  const bySymbol = useMemo(() => {
    const m = {};
    SYMBOLS.forEach(s => { m[s] = signals.filter(x => x.symbol === s); });
    return m;
  }, [signals]);

  return (
    <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Approved Queue" value={approved.length} icon={Activity} />
        <StatCard label="All Signals" value={signals.length} icon={Radio} />
        <StatCard label="Account" value={accountBalance != null ? `$${Number(accountBalance).toLocaleString()}` : '—'} icon={Target} accent="var(--gold)" />
        <StatCard label="Broker Quotes" value={Object.values(quotes || {}).filter(q => q?.source === 'mt5_ea').length + '/' + SYMBOLS.length} icon={Zap} accent="var(--emerald)" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel overflow-hidden">
          <SectionHeader icon={ScrollText} title="Approved queue" sub="only gate-approved · subset of Recent signals on Home · stored in MongoDB for learning" />
          {approved.length === 0 ? (
            <div className="p-4 font-mono text-[11px] space-y-2" style={{ color: 'var(--textFaint)' }}>
              <div><b style={{ color: 'var(--text)' }}>Queue ≠ Recent.</b> Home “Recent signals” = all fired setups. This queue = only approved ones.</div>
              <div>All signals (approved or blocked) are saved to MongoDB so adaptive learning can avoid repeat bad setups.</div>
              <div>Empty queue means nothing cleared the gate yet — not a dead system.</div>
            </div>
          ) : (
            <div className="omni-table-scroll">
              <div className="omni-table-grid" style={{ minWidth: 340 }}>
                <div className="max-h-72 overflow-y-auto omni-scroll">
                  {approved.map(s => (
                    <div key={s.id} className="omni-row grid grid-cols-[70px_40px_40px_1fr_1fr] gap-2 px-3 py-2.5 font-mono text-[11px] border-b" style={{ borderColor: 'var(--border)' }}>
                      <span>{s.symbol}</span>
                      <span style={{ color: 'var(--textDim)' }}>{s.timeframe}</span>
                      <span style={{ color: s.action === 'BUY' || s.action === 'LONG' ? 'var(--emerald)' : 'var(--coral)' }}>{s.action}</span>
                      <span style={{ color: 'var(--textDim)' }}>{fmtPrice(s.symbol, s.entry)}</span>
                      <span style={{ color: 'var(--gold)' }}>{s.score}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="omni-panel p-4">
          <SectionHeader icon={Layers} title="By Symbol" sub="signal count per desk" />
          <div className="space-y-2">
            {SYMBOLS.map(sym => {
              const q = quotes?.[sym];
              const list = bySymbol[sym] || [];
              return (
                <div key={sym} className="flex items-center gap-3 font-mono text-[11px] omni-panel2 px-2 py-1.5 rounded">
                  <span className="w-16" style={{ color: 'var(--text)' }}>{sym}</span>
                  {q?.bid != null ? (
                    <span className="flex-1"><span style={{ color: 'var(--coral)' }}>{fmtPrice(sym, q.bid)}</span>
                      <span style={{ color: 'var(--textFaint)' }}> / </span>
                      <span style={{ color: 'var(--emerald)' }}>{fmtPrice(sym, q.ask)}</span></span>
                  ) : (
                    <span className="flex-1" style={{ color: 'var(--textDim)' }}>{fmtPrice(sym, prices?.[sym])}</span>
                  )}
                  <span style={{ color: 'var(--textFaint)' }}>{list.length} sig</span>
                  <span style={{ color: q?.source === 'mt5_ea' ? 'var(--gold)' : 'var(--textFaint)', fontSize: 9 }}>{q?.source === 'mt5_ea' ? 'MT5' : (q?.source || '—')}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="omni-panel p-3 font-mono text-[11px]" style={{ color: 'var(--textDim)' }}>
        Manual trading mode: position-size calculator and portfolio exposure removed from Desk — use your broker for size. Validation tab still shows quality checks if you want them.
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
    <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
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
          <WaitingForBackend height={140} label="Risk live data not connected yet" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="omni-panel p-4">
          <SectionHeader icon={Layers} title="Portfolio Exposure" sub="no live fills endpoint yet" />
          <WaitingForBackend height={140} label="Position data not available yet" />
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



const PWA_DONE_KEY = 'omnicee_pwa_done';
const PWA_DISMISS_KEY = 'omnicee_pwa_dismissed';

function isStandalonePwa() {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    if (window.navigator.standalone === true) return true; // iOS Safari
  } catch (_) {}
  return false;
}

function markPwaDone() {
  try { localStorage.setItem(PWA_DONE_KEY, '1'); } catch (_) {}
}

function markPwaDismissed() {
  try { localStorage.setItem(PWA_DISMISS_KEY, String(Date.now())); } catch (_) {}
}

function isPwaFinished() {
  try {
    // After user deletes the installed app they open the site in the browser again —
    // clear stale "done" so Install can work once more.
    if (!isStandalonePwa()) {
      try { localStorage.removeItem(PWA_DONE_KEY); } catch (_) {}
    } else {
      return true;
    }
    // Only hide after explicit "Later" for this browser session period (7 days)
    const dismissedAt = Number(localStorage.getItem(PWA_DISMISS_KEY) || 0);
    if (dismissedAt && Date.now() - dismissedAt < 7 * 86400000) return true;
  } catch (_) {}
  return false;
}

function isMobileDevice() {
  try {
    if (navigator.userAgentData?.mobile) return true;
  } catch (_) {}
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isIosSafari() {
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const notOther = !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return iOS && webkit && notOther;
}

/**
 * PC Chrome/Edge: do not steal beforeinstallprompt — address-bar install icon stays.
 * Phone after login: one-shot banner; after install or dismiss it never returns.
 */
function InstallBanner({ installEvt, onInstalled, loggedIn }) {
  const [iosHelp, setIosHelp] = useState(false);
  const [hidden, setHidden] = useState(() => isStandalonePwa() || isPwaFinished());

  useEffect(() => {
    if (isStandalonePwa()) {
      markPwaDone();
      setHidden(true);
    }
  }, []);

  if (!loggedIn) return null;
  if (hidden || isStandalonePwa() || isPwaFinished()) return null;

  const finishForever = () => {
    markPwaDone();
    setHidden(true);
    onInstalled?.();
  };

  const dismissForever = () => {
    markPwaDismissed();
    setHidden(true);
  };

  const onInstallClick = async () => {
    if (installEvt?.prompt) {
      try {
        await installEvt.prompt();
        const choice = await installEvt.userChoice;
        // Accepted or dismissed browser UI — never nag again
        if (choice?.outcome === 'accepted') finishForever();
        else dismissForever();
      } catch (_) {
        dismissForever();
      }
      return;
    }
    setIosHelp(true);
  };

  return (
    <div className="px-2 pt-2">
      <div className="omni-panel px-3 py-2 flex flex-wrap items-center gap-2" style={{ borderColor: 'var(--emerald)' }}>
        <Download size={14} style={{ color: 'var(--emerald)' }} />
        <div className="flex-1 min-w-[140px] font-mono text-[11px]" style={{ color: 'var(--text)' }}>
          Install OMNICEE on this device
          <div className="text-[10px]" style={{ color: 'var(--textFaint)' }}>
            {installEvt
              ? 'Tap Install — works offline shell + home screen icon'
              : isIosSafari()
                ? 'iPhone: Share → Add to Home Screen'
                : 'Chrome/Edge: Install button, or address-bar install icon, or menu → Install app'}
          </div>
        </div>
        <button
          type="button"
          onClick={onInstallClick}
          className="font-mono text-[10px] uppercase px-3 py-1.5 rounded font-semibold"
          style={{ background: 'var(--emerald)', color: '#05070a' }}
        >
          {installEvt ? 'Install' : isIosSafari() ? 'How to add' : 'Install'}
        </button>
        <button
          type="button"
          onClick={dismissForever}
          className="font-mono text-[10px] px-2 py-1 rounded"
          style={{ color: 'var(--textFaint)', border: '1px solid var(--border)' }}
        >
          Done / Later
        </button>
      </div>
      {iosHelp && (
        <div className="omni-panel2 mt-1 px-3 py-2 font-mono text-[10px] space-y-1" style={{ color: 'var(--textDim)' }}>
          <div style={{ color: 'var(--text)' }}>Desktop Chrome / Edge</div>
          <div>1. Open the site in <b>Chrome</b> or <b>Edge</b> (not a private window)</div>
          <div>2. Look for the <b>install icon</b> on the right side of the address bar</div>
          <div>3. Or menu (⋮) → <b>Install OMNICEE</b> / <b>Apps → Install this site as an app</b></div>
          <div>4. Stay on the page ~20 seconds after login, then try again</div>
          <div className="pt-2" style={{ color: 'var(--text)' }}>Phone</div>
          <div>iPhone Safari: Share → Add to Home Screen</div>
          <div>Android Chrome: menu → Install app</div>
          <button
            type="button"
            className="mt-2 font-mono text-[10px] px-2 py-1 rounded"
            style={{ background: 'var(--emerald)', color: '#05070a' }}
            onClick={finishForever}
          >
            I installed it — hide this
          </button>
        </div>
      )}
    </div>
  );
}


class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try { console.error('[OMNICEE] UI crash after login:', error, info); } catch (_) {}
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error?.message || String(this.state.error);
      return (
        <div style={{ minHeight: '100vh', background: '#05070a', color: '#eef2f7', padding: 24, fontFamily: 'monospace' }}>
          <div style={{ maxWidth: 520, margin: '40px auto', border: '1px solid #1c232d', borderRadius: 12, padding: 20, background: '#0b0f14' }}>
            <div style={{ color: '#f0b429', marginBottom: 8, fontWeight: 700 }}>OMNICEE hit a display error</div>
            <div style={{ color: '#8b9bb0', fontSize: 12, marginBottom: 12 }}>{msg}</div>
            <button
              type="button"
              onClick={() => { this.setState({ error: null }); try { window.location.reload(); } catch (_) {} }}
              style={{ background: '#1fe3a8', color: '#05070a', border: 0, padding: '8px 14px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}
            >
              Reload dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── App shell ──────────────────────────────────────────────────────── */
export default function OmniceeDashboard() {
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const tab = new URLSearchParams(window.location.search).get('tab');
      if (tab && ['DASH', 'SIGNALS', 'ANALYSIS', 'NEWS', 'VALID', 'MONITOR'].includes(tab)) return tab;
    } catch (_) {}
    return 'DASH';
  });
  const [installEvt, setInstallEvt] = useState(null);
  const [user, setUser] = useState(() => getSession());
  const [soundOn, setSoundOn] = useState(() => loadSoundPref());
  const toggleSound = useCallback(() => {
    setSoundOn(prev => {
      const next = !prev;
      saveSoundPref(next);
      return next;
    });
  }, []);
  // Session wiped by omniFetch 401 → drop to LoginGate instead of infinite loading
  useEffect(() => {
    const onAuthRequired = () => setUser(null);
    window.addEventListener('omnicee:auth-required', onAuthRequired);
    return () => window.removeEventListener('omnicee:auth-required', onAuthRequired);
  }, []);
  useEffect(() => {
    // If already running as installed app, never show install UI again
    if (isStandalonePwa()) markPwaDone();

    const onPrompt = (e) => {
      // Capture so our Install button works after user deleted the app.
      // Chrome still shows address-bar icon in many versions even with preventDefault.
      e.preventDefault();
      if (!isPwaFinished()) setInstallEvt(e);
    };
    const onInstalled = () => {
      markPwaDone();
      setInstallEvt(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const feed = useLiveFeed();

  // MUST stay above any conditional return — React crashes (blank screen after login)
  // if hook count changes between "logged out" and "logged in" renders.
  const handleCommand = useCallback((raw) => {
    const val = raw.toUpperCase();
    const tab = TABS.find(t => t.key === val || t.label.toUpperCase() === val);
    if (tab) { setActiveTab(tab.key); return; }
    if (SYMBOLS.includes(val)) { setActiveTab('SIGNALS'); return; }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await fetch(API_BASE + '/api/auth/email/logout', {
        method: 'POST',
        headers: authHeaders(),
      });
    } catch (_) { /* local clear is enough */ }
    setSession(null);
    setUser(null);
  }, []);

  if (!user) {
    return (
      <>
        <ThemeStyle />
        <LoginGate onAuthed={(u) => setUser(u)} />
      </>
    );
  }

  const priceCount = Object.values(feed.quotes || {}).filter((q) => Number.isFinite(q?.price) || Number.isFinite(q?.bid)).length
    + Object.values(feed.prices || {}).filter((p) => Number.isFinite(p)).length;
  const pricesDead = !feed.wakingBackend && feed.mode === 'live' && priceCount === 0;

  return (
    <AppErrorBoundary>
    <div className="omni-root text-sm" style={{ minHeight: '100vh', minHeight: '100dvh', background: 'var(--void, #05070a)', color: 'var(--text, #eef2f7)' }}>
      <ThemeStyle />
      <TopBar
        now={feed.now || Date.now()}
        mode={feed.mode || 'live'}
        socketLive={!!feed.socketLive}
        analysisLive={feed.analysisLive}
        wakingBackend={!!feed.wakingBackend}
        onCommand={handleCommand}
        soundOn={soundOn}
        onToggleSound={toggleSound}
        userEmail={user?.email}
        onLogout={handleLogout}
      />
      <InstallBanner installEvt={installEvt} loggedIn={!!user} onInstalled={() => setInstallEvt(null)} />
      {feed.wakingBackend && (
        <div className="px-4 py-2 font-mono text-[11px] border-b" style={{ borderColor: 'var(--border)', color: 'var(--gold)', background: 'var(--panel2)' }}>
          {feed.wakeAttempts > 10
            ? `Still waking the server up (attempt ${feed.wakeAttempts}) — free hosting can take a couple minutes after being idle. Not stuck, still retrying.`
            : 'Connecting to server… prices and signals appear when the backend is awake (can take up to a minute on free hosting).'}
        </div>
      )}
      {pricesDead && (
        <div className="px-4 py-2 font-mono text-[11px] border-b" style={{ borderColor: 'var(--coral)', color: 'var(--coral)', background: 'rgba(255,84,112,0.08)' }}>
          No live prices. Attach OmniceeEA in MT5 and/or ensure Deriv is enabled (DISABLE_DERIV≠1). Open System tab for feed health. Charts and signals stay empty until ticks arrive.
        </div>
      )}
      {feed.eaAuthIssue && (
        <div className="px-4 py-2 font-mono text-[11px] border-b" style={{ borderColor: 'var(--border)', color: 'var(--coral)', background: 'var(--panel2)' }}>
          MT5 EA is being rejected by the server ({feed.eaAuthIssue.failures} failed attempts) — chart and prices are running on Deriv only.
          Your EA's secret likely doesn't match this deployment's EA_SECRET. Recompile mt5/OmniceeEA.mq5 and re-enter the secret in the EA's Inputs tab in MT5.
        </div>
      )}
      <TickerTape prices={feed.prices || {}} changes={feed.changes || {}} flash={feed.flash || {}} quotes={feed.quotes || {}} />
      <div className="flex flex-col flex-1 min-h-0" style={{ minHeight: 0 }}>
        <div className="omni-main omni-scroll">
          <ErrorBoundary key={activeTab} label={activeTab}>
            {activeTab === 'DASH' && <DashTab signals={feed.signals} accountBalance={feed.accountBalance} journalStats={feed.journalStats} prices={feed.prices} quotes={feed.quotes} changes={feed.changes} mode={feed.mode} outlook={feed.outlook} now={feed.now} levels={feed.levels} analysisLive={feed.analysisLive} socketLive={feed.socketLive} cryptoVolAlerts={feed.cryptoVolAlerts} calendar={feed.calendar} />}
            {activeTab === 'SIGNALS' && (
              <SignalsTab signals={feed.signals} prices={feed.prices} quotes={feed.quotes} auditLog={feed.auditLog} analysisLive={feed.analysisLive} />
            )}
            {activeTab === 'NEWS' && <NewsTab news={feed.news} mode={feed.mode} />}
            {activeTab === 'VALID' && (
              <ValidTab signals={feed.signals} journalStats={feed.journalStats} learningProfiles={feed.learningProfiles} mode={feed.mode} hurstBoard={feed.hurstBoard} />
            )}
            {activeTab === 'ANALYSIS' && (
              <AnalysisTab mode={feed.mode} />
            )}
            {activeTab === 'MONITOR' && (
              <div className="space-y-2">
                <MonitorTab auditLog={feed.auditLog} feedHealth={feed.feedHealth} uptimeSec={feed.uptimeSec} mode={feed.mode} fetchErrors={feed.fetchErrors} analysisLive={feed.analysisLive} socketLive={feed.socketLive} />
                <IntelTab now={feed.now} outlook={feed.outlook} mode={feed.mode} calendar={feed.calendar} />
                <DeskTab signals={feed.signals} prices={feed.prices} quotes={feed.quotes} changes={feed.changes} stats={feed.stats} accountBalance={feed.accountBalance} relativeStrength={feed.relativeStrength} mode={feed.mode} />
              </div>
            )}
          </ErrorBoundary>
        </div>
        <div className="omni-hide-xs flex items-center justify-center gap-2 py-0.5 border-t font-mono text-[8px] uppercase tracking-wider" style={{ borderColor: 'var(--border)', color: 'var(--textFaint)' }}>
          <span>OMNICEE</span><span>·</span><span>Developed by James Yelbert</span>
        </div>
        <NavBar active={activeTab} onSelect={setActiveTab} />
      </div>
    </div>
    </AppErrorBoundary>
  );
}
