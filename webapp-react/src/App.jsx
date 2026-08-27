import React, { useState, useEffect, useMemo, useRef, useCallback, Component } from 'react';
import {
  LayoutDashboard, Radio, Globe2, Activity,
  ScrollText, ChevronRight, ChevronDown,
  TrendingUp, CheckCircle2, XCircle,
  Circle, Zap, Database,
  Terminal, Newspaper,
  Layers, Target,
  Volume2, VolumeX, Sun, Moon, Maximize2, Download,
} from 'lucide-react';

const SYMBOLS = ['XAUUSD', 'BTCUSDT', 'ETHUSDT', 'EURUSD', 'GBPUSD', 'USDJPY', 'USOIL', 'UUP'];
const SYMBOL_LABEL = { UUP: 'DXY', XAUUSD: 'GOLD', USOIL: 'OIL', BTCUSDT: 'BTC', ETHUSDT: 'ETH' };
function symLabel(s) { return SYMBOL_LABEL[s] || s; }

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
const THEME_KEY = 'omnicee_theme';
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
function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch (_) {}
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  } catch (_) {}
  return 'dark';
}
function saveTheme(t) {
  try { localStorage.setItem(THEME_KEY, t === 'light' ? 'light' : 'dark'); } catch (_) {}
}
function sourceLabel(src) {
  if (src === 'mt5_ea') return 'MT5';
  if (src === 'tradingview') return 'TV';
  if (src === 'deriv') return 'DERIV';
  if (src === 'finnhub') return 'FH';
  if (src === 'binance') return 'BN';
  return src || '—';
}
function isFireAction(action) {
  const a = String(action || '').toUpperCase();
  return a === 'BUY' || a === 'SELL' || a === 'LONG' || a === 'SHORT';
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


function copySignalExport(s) {
  const lines = [
    `OMNICEE ${s.symbol} ${s.action}`,
    `TF: ${s.timeframe || 'H1'} · Score: ${s.score ?? '—'}`,
    `Entry: ${s.entry ?? '—'} · SL: ${s.stopLoss ?? '—'} · TP1: ${s.targets?.[0] ?? '—'}`,
    s.targets?.[1] != null ? `TP2: ${s.targets[1]}` : null,
    `ID: ${s.id || '—'}`,
  ].filter(Boolean).join('\n');
  try {
    navigator.clipboard?.writeText(lines);
    return true;
  } catch (_) {
    return false;
  }
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
    status: (action === 'BUY' || action === 'SELL') ? 'FIRE' : 'WAIT',
  };
}

const FEEDS = [
  { name: 'MT5',          kind: 'Exness broker', status: 'unknown', note: 'attach OmniceeEA' },
  { name: 'TradingView',  kind: 'OANDA / Binance quotes', status: 'unknown' },
  { name: 'Deriv',        kind: 'live ticks+OHLC', status: 'unknown' },
];

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

function ThemeStyle() {
  return (
    <style>{`
      /* fonts loaded from index.html — avoid double-fetch */
      /* Lighter institutional dark — readable slate, not pure black */
      .omni-root {
        --void: #0b1220; --panel: #1e293b; --panel2: #243044;
        --border: #334155; --borderBright: #475569;
        --emerald: #34d399; --emeraldDim: #059669;
        --gold: #fbbf24; --coral: #f87171; --blue: #60a5fa;
        --cyan: #22d3ee; --violet: #a78bfa;
        --text: #f1f5f9; --textDim: #cbd5e1; --textFaint: #94a3b8;
        --ring: #34d399;
        --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
        --glass: rgba(30, 41, 59, 0.72);
        --glass2: rgba(36, 48, 68, 0.65);
        --glassBorder: rgba(148, 163, 184, 0.18);
        --inkOnAccent: #0b1220;
        background: radial-gradient(1200px 600px at 10% -10%, rgba(52,211,153,0.08), transparent 50%),
          radial-gradient(900px 500px at 100% 0%, rgba(96,165,250,0.07), transparent 45%),
          var(--void); color: var(--text);
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
      .omni-root[data-theme="light"] {
        --void: #eef2f7; --panel: #ffffff; --panel2: #f8fafc;
        --border: #d8e0ea; --borderBright: #94a3b8;
        --emerald: #059669; --emeraldDim: #047857;
        --gold: #d97706; --coral: #dc2626; --blue: #2563eb;
        --cyan: #0891b2; --violet: #7c3aed;
        --text: #0f172a; --textDim: #334155; --textFaint: #64748b;
        --ring: #059669;
        --glass: rgba(255, 255, 255, 0.82);
        --glass2: rgba(248, 250, 252, 0.9);
        --glassBorder: rgba(15, 23, 42, 0.08);
        --inkOnAccent: #ffffff;
        background: radial-gradient(1200px 600px at 10% -10%, rgba(5,150,105,0.08), transparent 50%),
          radial-gradient(900px 500px at 100% 0%, rgba(37,99,235,0.07), transparent 45%),
          var(--void);
        color-scheme: light;
      }
      .omni-root .font-display { font-family: 'Orbitron', sans-serif; letter-spacing: 0.06em; }
      .omni-root .font-mono { font-family: 'JetBrains Mono', monospace; }
      /* ui-ux-pro-max: accessible focus + reduced motion + mobile resilience */
      .omni-root button:focus-visible,
      .omni-root a:focus-visible,
      .omni-root input:focus-visible,
      .omni-root [tabindex]:focus-visible {
        outline: 2px solid var(--ring);
        outline-offset: 2px;
      }
      @media (prefers-reduced-motion: reduce) {
        .omni-root, .omni-root * {
          animation-duration: 0.01ms !important;
          transition-duration: 0.01ms !important;
        }
      }
      .omni-root input, .omni-root button, .omni-root select {
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
      }
      /* Prevent iOS zoom on focus — 16px minimum */
      @media (max-width: 640px) {
        .omni-root input, .omni-root select, .omni-root textarea { font-size: 16px !important; }
      }
      .omni-panel {
        background: var(--glass);
        border: 1px solid var(--glassBorder);
        border-radius: 14px;
        max-width: 100%;
        backdrop-filter: blur(16px) saturate(1.2);
        -webkit-backdrop-filter: blur(16px) saturate(1.2);
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255,255,255,0.06);
        transition: border-color 180ms ease, box-shadow 180ms ease;
      }
      .omni-panel:hover {
        border-color: color-mix(in srgb, var(--emerald) 40%, var(--glassBorder));
      }
      .omni-panel2 {
        background: var(--glass2);
        border: 1px solid var(--glassBorder);
        border-radius: 12px;
        max-width: 100%;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }
      .omni-topbar {
        background: var(--glass);
        border-color: var(--glassBorder);
        backdrop-filter: blur(16px) saturate(1.2);
        -webkit-backdrop-filter: blur(16px) saturate(1.2);
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
        border-top: 1px solid var(--glassBorder);
        background: var(--glass);
        backdrop-filter: blur(20px) saturate(1.3);
        -webkit-backdrop-filter: blur(20px) saturate(1.3);
        padding-bottom: env(safe-area-inset-bottom, 0px);
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
        gap: 0.75rem;
        grid-template-columns: 1fr;
      }
      @media (min-width: 720px) {
        .omni-home-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (min-width: 1100px) {
        .omni-home-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
      }
      .omni-charts-grid {
        display: grid;
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr auto;
        gap: 8px;
        height: 100%;
        min-height: calc(100dvh - 148px);
        padding: 8px;
        box-sizing: border-box;
        width: 100%;
        max-width: 100vw;
      }
      @media (min-width: 900px) {
        .omni-charts-grid {
          grid-template-columns: minmax(0, 1fr) minmax(240px, 300px);
          grid-template-rows: auto 1fr;
        }
        .omni-charts-toolbar { grid-column: 1 / -1; }
        .omni-charts-stage { grid-column: 1; grid-row: 2; }
        .omni-charts-rail { grid-column: 2; grid-row: 2; }
      }
      @media (max-width: 899px) {
        .omni-charts-rail { max-height: 38vh; }
      }
      .omni-charts-toolbar { flex: 0 0 auto; }
      .omni-charts-stage {
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        padding: 0 !important;
      }
      .omni-charts-rail {
        min-height: 0;
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }
      .omni-tv-host {
        flex: 1 1 auto;
        width: 100%;
        height: 100%;
        min-height: 240px;
        position: relative;
        border-radius: 14px;
        overflow: hidden;
      }
      .omni-tv-host iframe,
      .omni-tv-host > div {
        width: 100% !important;
        height: 100% !important;
      }
      .omni-root.is-charts .omni-main {
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .omni-charts-stage {
        position: relative;
        background: var(--glass);
        border: 1px solid var(--glassBorder);
      }
      .omni-chart-hud {
        position: absolute;
        left: 10px;
        bottom: 10px;
        z-index: 6;
        max-width: min(340px, calc(100% - 20px));
        pointer-events: auto;
        background: var(--glass);
        border: 1px solid var(--glassBorder);
        backdrop-filter: blur(14px) saturate(1.2);
        -webkit-backdrop-filter: blur(14px) saturate(1.2);
        border-radius: 12px;
        padding: 10px 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      }
      .omni-signals-list {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }
      @media (min-width: 900px) {
        .omni-signals-list {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .omni-analysis-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }
      @media (min-width: 720px) {
        .omni-analysis-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (min-width: 1100px) {
        .omni-analysis-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      }
      .omni-heat-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      @media (min-width: 720px) {
        .omni-heat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      }
      .omni-sr-only {
        position: absolute;
        width: 1px; height: 1px;
        padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0,0,0,0);
        white-space: nowrap; border: 0;
      }
      .omni-root[data-theme="light"] .omni-row:hover { background: rgba(15, 23, 42, 0.04); }
      .omni-root[data-theme="light"] .omni-row:active,
      .omni-root[data-theme="light"] .omni-chip:active { background: rgba(15, 23, 42, 0.08) !important; }
      .omni-root[data-theme="light"] .omni-panel {
        box-shadow: 0 4px 20px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255,255,255,0.8);
      }
      .omni-quote-card {
        text-align: left;
        width: 100%;
        min-height: 44px;
      }
      .omni-quote-card:focus-visible {
        outline: 2px solid var(--ring);
        outline-offset: 2px;
      }
      @media (min-width: 900px) {
        .omni-charts-grid {
          min-height: calc(100dvh - 140px);
        }
        .omni-tv-host { min-height: 420px; }
      }
      @media (max-width: 899px) {
        .omni-charts-grid {
          min-height: calc(100dvh - 132px);
          grid-template-rows: auto minmax(240px, 1fr) minmax(140px, 32vh);
        }
        .omni-tv-host { min-height: 220px; }
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

function LoginGate({ onAuthed, theme, onToggleTheme }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('email');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [passwordRequired, setPasswordRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(API_BASE + '/api/auth/email/config', { cache: 'no-store' })
      .then(r => r.json().catch(() => ({})))
      .then(d => { if (!cancelled && d?.passwordRequired) setPasswordRequired(true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const requestCode = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const body = { email: email.trim() };
      if (passwordRequired || password) body.password = password;
      const r = await fetch(API_BASE + '/api/auth/email/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        const raw = data.error || `Could not send code (HTTP ${r.status})`;
        if (/Email not configured/i.test(raw)) {
          throw new Error(
            'Email provider rejected this address. Verify EMAIL_FROM as a sender in Brevo, or enable ALLOW_DEV_OTP for on-screen codes.'
          );
        }
        if (/OTP_PEPPER|Email not configured/i.test(raw)) {
          throw new Error('Server email auth is misconfigured (OTP_PEPPER / BREVO_API_KEY). Check Render env vars.');
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

  // Theme tokens (ui-ux-pro-max) — follow data-theme on .omni-root
  const bg = 'var(--void)';
  const panel = 'var(--panel)';
  const panel2 = 'var(--panel2)';
  const border = 'var(--border)';
  const text = 'var(--text)';
  const dim = 'var(--textDim)';
  const faint = 'var(--textFaint)';
  const green = 'var(--emerald)';
  const red = 'var(--coral)';

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
      colorScheme: theme === 'light' ? 'light' : 'dark',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        background: panel,
        border: `1px solid ${border}`,
        borderRadius: 14,
        padding: 28,
        boxShadow: '0 16px 48px rgba(0,0,0,0.18), 0 0 0 1px var(--glassBorder)',
        position: 'relative',
      }}>
        {onToggleTheme && (
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'light' ? 'Dark mode' : 'Light mode'}
            className="omni-chip"
            style={{
              position: 'absolute', top: 16, right: 16,
              width: 40, height: 40, borderRadius: 10,
              border: `1px solid ${border}`, background: panel2, color: text,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: green, color: 'var(--inkOnAccent)',
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
            enterKeyHint="next"
            aria-required="true"
            style={{
              display: 'block', width: '100%', marginTop: 6,
              padding: '14px 14px', borderRadius: 10,
              border: `1px solid ${border}`, background: panel2, color: text,
              fontSize: 16, outline: 'none', boxSizing: 'border-box',
              minHeight: 48,
            }}
          />
        </label>

        {step === 'email' && (passwordRequired || true) && (
          <label style={{ display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: faint, marginBottom: 12 }}>
            Desk password {passwordRequired ? '' : '(optional if not required by server)'}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={passwordRequired ? 'Required' : 'Leave blank if not set'}
              autoComplete="current-password"
              enterKeyHint="go"
              aria-required={passwordRequired ? 'true' : 'false'}
              style={{
                display: 'block', width: '100%', marginTop: 6,
                padding: '14px 14px', borderRadius: 10,
                border: `1px solid ${border}`, background: panel2, color: text,
                fontSize: 16, outline: 'none', boxSizing: 'border-box',
                minHeight: 48,
              }}
            />
          </label>
        )}

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
              autoComplete="one-time-code"
              enterKeyHint="done"
              aria-label="Six digit verification code"
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
              disabled={busy || !email.includes('@') || (passwordRequired && !password)}
              onClick={requestCode}
              aria-busy={busy ? 'true' : 'false'}
              style={{
                flex: 1, padding: '12px 14px', borderRadius: 8, border: 'none',
                background: green, color: bg, fontWeight: 700, fontSize: 13,
                cursor: busy ? 'wait' : 'pointer', opacity: (busy || !email.includes('@') || (passwordRequired && !password)) ? 0.55 : 1,
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
  const [signalToast, setSignalToast] = useState(null);
  const [auditLog, setAuditLog] = useState([]);
  const [equityCurve, setEquityCurve] = useState([]);
  const [stats, setStats] = useState(null);
  const [outlook, setOutlook] = useState(null);
  const [deskBrief, setDeskBrief] = useState(null);
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
  const SRC_RANK = { mt5_ea: 100, tradingview: 92, deriv: 70, finnhub: 60, binance: 58, candle: 40, unknown: 0 };

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

  useEffect(() => {
    if (!signalToast) return undefined;
    const tmr = setTimeout(() => setSignalToast(null), 8000);
    return () => clearTimeout(tmr);
  }, [signalToast]);

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
      // Ask early so phone/desktop alerts work when first signal fires
      setTimeout(() => { try { Notification.requestPermission(); } catch (_) {} }, 1200);
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
              // Prefer broker MT5; shorter hold so Deriv can fill when EA offline
              if (prevSrc && prevSrc.rank > rank && (Date.now() - prevSrc.ts) < 8000) return;
              priceSourceRef.current[m.symbol] = { source: src, rank, ts: Date.now() };
              const bid = m.bid != null ? Number(m.bid) : null;
              const ask = m.ask != null ? Number(m.ask) : null;
              const mid = (Number.isFinite(bid) && Number.isFinite(ask)) ? (bid + ask) / 2 : Number(m.price);
              next[m.symbol] = mid;
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
              {
                const bid = m.bid != null ? Number(m.bid) : prev[m.symbol]?.bid ?? null;
                const ask = m.ask != null ? Number(m.ask) : prev[m.symbol]?.ask ?? null;
                const mid = (Number.isFinite(bid) && Number.isFinite(ask)) ? (bid + ask) / 2 : Number(m.price);
                next[m.symbol] = {
                  price: mid,
                  bid: Number.isFinite(bid) ? bid : null,
                  ask: Number.isFinite(ask) ? ask : null,
                  source: src,
                  ts: Date.now(),
                };
              }
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
      try { const r = await recordFetch('desk-brief', omniFetch('/api/desk-brief')); if (!cancelled && r.ok) setDeskBrief(r); } catch (_) {}
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
      const session = getSession();
      socket = io(API_BASE || undefined, {
        path: '/socket.io',
        auth: {
          appToken: APP_TOKEN || undefined,
          initData: getTelegramInitData() || undefined,
          sessionToken: session?.token || undefined,
        },
        // Prefer websocket; polling is fallback (Render / proxies)
        transports: ['websocket', 'polling'],
        upgrade: true,
        // --- Reconnection (desk must survive cold starts + mobile sleep) ---
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 800,           // first retry
        reconnectionDelayMax: 12000,      // cap backoff
        randomizationFactor: 0.35,        // jitter to avoid thundering herd
        timeout: 15000,                   // connect timeout
        autoConnect: true,
        forceNew: false,
        withCredentials: false,
      });

      const markLive = () => { if (!cancelled) setSocketLive(true); };
      const markDown = () => { if (!cancelled) setSocketLive(false); };

      socket.on('connect', () => {
        markLive();
        if (!cancelled) setWakingBackend(false);
        // Re-subscribe / request snapshot after every (re)connect
        try {
          socket.emit('subscribe', { channels: ['market', 'signal', 'balance'] });
          socket.emit('get_history', { limit: 40 });
        } catch (_) {}
      });
      socket.on('disconnect', (reason) => {
        markDown();
        // Server-initiated or transport close → client will auto-reconnect
        // 'io client disconnect' means we called disconnect() on purpose
        if (reason === 'io server disconnect') {
          try { socket.connect(); } catch (_) {}
        }
      });
      socket.on('connect_error', () => markDown());
      socket.on('reconnect_attempt', () => markDown());
      socket.on('reconnect', () => {
        markLive();
        try {
          // Refresh auth payload in case session rotated while offline
          const s = getSession();
          if (s?.token) socket.auth = { ...(socket.auth || {}), sessionToken: s.token };
          socket.emit('subscribe', { channels: ['market', 'signal', 'balance'] });
          socket.emit('get_history', { limit: 40 });
        } catch (_) {}
      });
      socket.on('reconnect_error', () => markDown());
      socket.on('reconnect_failed', () => markDown());
      socket.on('engine_ready', () => { if (!cancelled) setWakingBackend(false); });
      socket.on('connected', () => markLive());

      // Browser went offline/online — force reconnect path
      const onOffline = () => markDown();
      const onOnline = () => {
        try {
          if (socket && !socket.connected) socket.connect();
        } catch (_) {}
      };
      // Mobile: tab backgrounded for a long time → socket often dead on resume
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        try {
          if (socket && !socket.connected) socket.connect();
          else if (socket?.connected) {
            socket.emit('subscribe', { channels: ['market', 'signal', 'balance'] });
          }
        } catch (_) {}
      };
      window.addEventListener('offline', onOffline);
      window.addEventListener('online', onOnline);
      document.addEventListener('visibilitychange', onVisible);
      socket._omniNetHandlers = { onOffline, onOnline, onVisible };

      // Application-level heartbeat — keeps Render/proxies from dropping idle sockets
      let hbTimer = null;
      const sendHeartbeat = () => {
        try {
          if (socket?.connected) socket.emit('heartbeat', { t: Date.now() });
        } catch (_) {}
      };
      hbTimer = setInterval(sendHeartbeat, 12000);
      socket.on('heartbeat_ack', () => { if (!cancelled) setSocketLive(true); });
      socket._omniHbTimer = hbTimer;

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
        if (cancelled || !payload) return;
        const norm = normalizeSignal(payload);
        if (!norm.id) norm.id = `live-${norm.symbol}-${norm.timeframe}-${norm.timestamp || Date.now()}`;
        const action = String(norm.action || '').toUpperCase();
        const isFire = action === 'BUY' || action === 'SELL';
        const sc = signalScore(norm);

        // Instant tray update (ws) — poll remains as backup
        setSignals(prev => {
          if (prev.some(s => s.id === norm.id)) return prev;
          let next = prev;
          if (!isFire) {
            next = prev.filter(s => !(
              String(s.action).toUpperCase() === 'WAIT'
              && s.symbol === norm.symbol
              && s.timeframe === norm.timeframe
            ));
          }
          return [norm, ...next].slice(0, 200);
        });

        // FIRE only for toast/chime/notify — match pipeline floor (50)
        if (!isFire) return;
        if (sc < 50) return;
        // Prefer real approvals; still allow high-score FIRE without gate object
        if (norm.gate?.status && ['wait', 'near_miss', 'blocked', 'gated'].includes(String(norm.gate.status).toLowerCase())) return;

        try {
          if (loadSoundPref()) playSignalChime(normalizeDirection(action));
        } catch (_) {}
        setSignalToast({ id: norm.id, symbol: norm.symbol, action, score: norm.score, timeframe: norm.timeframe, at: Date.now() });
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const title = `OMNICEE ${norm.symbol} ${action}`;
            const body = `Score ${sc} · ${norm.timeframe || ''} · entry ${norm.entry ?? '—'}`;
            try {
              new Notification(title, { body, icon: '/icons/icon-192.png', tag: `fire-${norm.symbol}-${action}`, renotify: true });
            } catch (_) {}
            navigator.serviceWorker?.getRegistration?.().then(reg => {
              if (reg?.showNotification) {
                reg.showNotification(title, { body, icon: '/icons/icon-192.png', tag: `fire-${norm.symbol}-${action}`, data: { url: '/' } });
              }
            }).catch(() => {});
          }
        } catch (_) { /* optional */ }
      });

      // Complements the /api/stats poll above with push updates the
      // instant a new EA balance report lands, instead of waiting up to 5s.
      socket.on('balance', payload => {
        if (!cancelled && payload?.balance != null) setAccountBalance(Number(payload.balance));
      });

      // After reconnect: full price map from server cache
      socket.on('market_snapshot', payload => {
        if (cancelled || !payload?.prices) return;
        const nextPrices = {};
        const nextQuotes = {};
        for (const [sym, snap] of Object.entries(payload.prices)) {
          const price = Number(snap?.price ?? snap?.mid);
          if (!Number.isFinite(price)) continue;
          nextPrices[sym] = price;
          nextQuotes[sym] = {
            price,
            bid: snap.bid != null ? Number(snap.bid) : null,
            ask: snap.ask != null ? Number(snap.ask) : null,
            source: snap.source || 'snapshot',
            ts: payload.at || Date.now(),
          };
        }
        if (Object.keys(nextPrices).length) {
          setPrices(prev => ({ ...prev, ...nextPrices }));
          setQuotes(prev => ({ ...prev, ...nextQuotes }));
        }
      });

      socket.on('history', payload => {
        if (cancelled || !Array.isArray(payload?.signals)) return;
        const incoming = payload.signals.map(normalizeSignal).filter(s => s?.id);
        if (!incoming.length) return;
        setSignals(prev => {
          const seen = new Set(prev.map(s => s.id));
          const merged = [...prev];
          for (const s of incoming) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            merged.push(s);
          }
          return merged
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 200);
        });
      });

      socket.on('subscribed', () => { /* ack — connection is fully live */ });

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
        // Only notify on high/severe — low severity was spamming the phone
        const sev = String(payload.severity || '').toLowerCase();
        if (sev !== 'high' && sev !== 'severe') return;
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(`OMNICEE VOL ${payload.symbol}`, {
              body: payload.message || `${payload.absPct}% in ${payload.window}`,
              tag: `vol-${payload.symbol}`,
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
      try {
        if (socket?._omniNetHandlers) {
          const { onOffline, onOnline, onVisible } = socket._omniNetHandlers;
          window.removeEventListener('offline', onOffline);
          window.removeEventListener('online', onOnline);
          document.removeEventListener('visibilitychange', onVisible);
        }
      } catch (_) {}
      try { socket?.removeAllListeners?.(); } catch (_) {}
      try { if (socket?._omniHbTimer) clearInterval(socket._omniHbTimer); } catch (_) {}
      try { socket?.disconnect(); } catch (_) {}
      setSocketLive(false);
    };
  }, [mode]);

  return {
    now, prices, quotes, changes, flash, signals, calendar, levels, auditLog, equityCurve, equityCurveLive,
    stats, outlook, heatmapTiles, feedHealth, uptimeSec, accountBalance, socketLive, analysisLive, cryptoVolAlerts,
    news, sentiment, journalStats, learningProfiles, relativeStrength, hurstBoard, deskBrief, fetchErrors,
    mode, connected: mode === 'live', wakingBackend, wakeAttempts, eaAuthIssue,
    signalToast, dismissSignalToast: () => setSignalToast(null),
  };
}

/* ── Navigation model ───────────────────────────────────────────────── */
const TABS = [
  { key: 'DASH', label: 'Home', fkey: 'F1', icon: LayoutDashboard },
  { key: 'CHARTS', label: 'Charts', fkey: 'F2', icon: TrendingUp },
  { key: 'SIGNALS', label: 'Signals', fkey: 'F3', icon: Radio },
  { key: 'NEWS', label: 'News', fkey: 'F4', icon: Newspaper },
  { key: 'ANALYSIS', label: 'Analysis', fkey: 'F5', icon: Layers },
  { key: 'MONITOR', label: 'System', fkey: 'F6', icon: Activity },
];

function TopBar({ now, mode, socketLive, analysisLive, wakingBackend, onCommand, soundOn, onToggleSound, userEmail, onLogout, theme, onToggleTheme }) {
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
    <div className="omni-topbar flex items-center gap-2 sm:gap-4 px-2 sm:px-4 py-2.5 border-b shrink-0">
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 rounded flex items-center justify-center font-display text-[12px] font-bold"
          style={{ background: 'var(--emerald)', color: 'var(--inkOnAccent)' }}>Ω</div>
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
          onClick={onToggleTheme}
          className="omni-chip flex items-center justify-center rounded p-1.5 min-w-[40px] min-h-[40px]"
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          aria-label={theme === 'light' ? 'Dark mode' : 'Light mode'}
          style={{ color: 'var(--text)', background: 'var(--panel2)' }}
        >
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
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
              {(q?.source === 'mt5_ea' || q?.source === 'deriv' || q?.source === 'tradingview') && (
                <span style={{ color: 'var(--gold)', fontSize: 9 }}>
                  {sourceLabel(q?.source)}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function NavBar({ active, onSelect }) {
  return (
    <nav className="omni-nav" role="navigation" aria-label="Main desk sections">
      {TABS.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          aria-label={t.label}
          aria-current={active === t.key ? 'page' : undefined}
          className="flex flex-col items-center justify-center gap-0.5 transition-colors"
          style={{
            color: active === t.key ? 'var(--emerald)' : 'var(--textDim)',
            background: active === t.key ? 'var(--panel2)' : 'transparent',
            borderTop: active === t.key ? '2px solid var(--emerald)' : '2px solid transparent',
            minHeight: 52,
            minWidth: 44,
          }}
        >
          <t.icon size={20} strokeWidth={active === t.key ? 2.25 : 1.75} aria-hidden="true" />
          <span className="font-mono text-[9px] uppercase tracking-wider leading-none">{t.label}</span>
        </button>
      ))}
    </nav>
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


/** Vibe-style multi-agent desk brief — Session / Regime / Signals / Macro / Risk */
function DeskBriefPanel({ brief, mode }) {
  const live = mode === 'live' && brief?.ok && Array.isArray(brief.teams);
  if (!live) {
    return (
      <div className="omni-panel p-3">
        <SectionHeader icon={Layers} title="Desk Brief" sub="multi-agent research layer" />
        <WaitingForBackend height={88} label="Building session · regime · signal · macro brief…" />
      </div>
    );
  }
  return (
    <div className="omni-panel p-3 space-y-2">
      <SectionHeader
        icon={Layers}
        title="Desk Brief"
        sub={`${brief.session?.label || 'Session'} · ${new Date(brief.generatedAt || Date.now()).toUTCString().slice(17, 25)} UTC`}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        {brief.teams.map((team) => (
          <div key={team.id} className="omni-panel2 p-2.5 space-y-1.5">
            <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--gold)' }}>{team.title}</div>
            <div className="text-[12px] leading-snug" style={{ color: 'var(--text)' }}>{team.summary}</div>
            {(team.bullets || []).slice(0, 4).map((b, i) => (
              <div key={i} className="font-mono text-[10px] leading-snug" style={{ color: 'var(--textDim)' }}>· {b}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── DASH ───────────────────────────────────────────────────────────── */


/** TradingView advanced chart (real-time when TV data available) */
const TV_SYMBOL = {
  XAUUSD: 'OANDA:XAUUSD',
  EURUSD: 'OANDA:EURUSD',
  GBPUSD: 'OANDA:GBPUSD',
  USDJPY: 'OANDA:USDJPY',
  BTCUSDT: 'BINANCE:BTCUSDT',
  ETHUSDT: 'BINANCE:ETHUSDT',
  USOIL: 'TVC:USOIL',
  UUP: 'AMEX:UUP',
};

function TradingViewChart({ symbol, className = '', theme = 'dark' }) {
  const hostRef = useRef(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let cancelled = false;
    const id = `tv_${symbol}_${Math.random().toString(36).slice(2, 8)}`;
    const tvTheme = theme === 'light' ? 'light' : 'dark';

    const boot = () => {
      if (cancelled || !window.TradingView || !hostRef.current) return;
      hostRef.current.innerHTML = '';
      const box = document.createElement('div');
      box.id = id;
      box.style.width = '100%';
      box.style.height = '100%';
      hostRef.current.appendChild(box);
      try {
        // eslint-disable-next-line no-new
        new window.TradingView.widget({
          autosize: true,
          symbol: TV_SYMBOL[symbol] || symbol,
          interval: '15',
          timezone: 'Etc/UTC',
          theme: tvTheme,
          style: '1',
          locale: 'en',
          toolbar_bg: tvTheme === 'light' ? '#eef2f7' : '#0b1220',
          enable_publishing: false,
          hide_top_toolbar: false,
          hide_legend: false,
          hide_side_toolbar: typeof window !== 'undefined' && window.innerWidth < 768,
          allow_symbol_change: false,
          withdateranges: true,
          details: false,
          hotlist: false,
          calendar: false,
          studies: ['STD;EMA'],
          container_id: id,
        });
      } catch (e) {
        console.warn('[TV]', e.message);
      }
    };

    const loadScript = () => new Promise((resolve) => {
      if (window.TradingView) { resolve(); return; }
      const existing = document.querySelector('script[data-omni-tv]');
      if (existing) {
        if (window.TradingView) resolve();
        else existing.addEventListener('load', () => resolve(), { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://s3.tradingview.com/tv.js';
      s.async = true;
      s.dataset.omniTv = '1';
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });

    loadScript().then(boot);
    return () => {
      cancelled = true;
      try { if (hostRef.current) hostRef.current.innerHTML = ''; } catch (_) {}
    };
  }, [symbol, theme]);

  return <div ref={hostRef} className={`omni-tv-host ${className}`.trim()} />;
}

/** Full-screen TradingView desk + live signal rail (only chart in the app) */
function ChartsTab({ quotes, mode, signals, theme, chartSymbol, onSymbolChange }) {
  const [localSymbol, setLocalSymbol] = useState(chartSymbol || 'XAUUSD');
  useEffect(() => {
    if (chartSymbol) setLocalSymbol(chartSymbol);
  }, [chartSymbol]);
  const active = chartSymbol || localSymbol;
  const setActive = (sym) => {
    setLocalSymbol(sym);
    onSymbolChange?.(sym);
  };
  const q = quotes?.[active];
  const liveSignals = useMemo(
    () => (signals || [])
      .filter(s => s.symbol === active && isFireAction(s.action))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 12),
    [signals, active],
  );
  const latest = liveSignals[0];
  return (
    <div className="omni-charts-grid">
      <div className="omni-panel omni-charts-toolbar px-3 py-2 flex flex-wrap gap-1.5 items-center">
        <span className="font-mono text-[10px] uppercase tracking-wider mr-1" style={{ color: 'var(--textFaint)' }}>Symbol</span>
        {SYMBOLS.map(sym => (
          <button
            key={sym}
            type="button"
            onClick={() => setActive(sym)}
            className="omni-chip font-mono text-[11px] px-2.5 py-1.5 rounded-full min-h-[40px]"
            aria-pressed={active === sym}
            style={{
              color: active === sym ? 'var(--inkOnAccent)' : 'var(--textDim)',
              background: active === sym ? 'var(--emerald)' : 'var(--panel2)',
              border: '1px solid var(--glassBorder)',
              fontWeight: active === sym ? 700 : 500,
            }}
          >
            {symLabel(sym)}
          </button>
        ))}
        <span className="ml-auto font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
          {sourceLabel(q?.source) || (mode === 'live' ? 'feed' : '—')}
          {q?.bid != null && q?.ask != null && (
            <> · <span style={{ color: 'var(--coral)' }}>{fmtPrice(active, q.bid)}</span>
            {' / '}
            <span style={{ color: 'var(--emerald)' }}>{fmtPrice(active, q.ask)}</span></>
          )}
        </span>
      </div>
      <div className="omni-panel omni-charts-stage">
        <ErrorBoundary key={'tv-' + active + (theme || 'dark')} label="TradingView">
          <TradingViewChart symbol={active} theme={theme} />
        </ErrorBoundary>
        {latest && (
          <div className="omni-chart-hud" role="status" aria-live="polite">
            <div className="flex items-center gap-2 font-mono text-[12px]">
              <span style={{ color: latest.action === 'BUY' || latest.action === 'LONG' ? 'var(--emerald)' : 'var(--coral)', fontWeight: 700 }}>
                {latest.action}
              </span>
              <span style={{ color: 'var(--text)' }}>{symLabel(latest.symbol)}</span>
              <span style={{ color: 'var(--textDim)' }}>{latest.timeframe}</span>
              <span className="ml-auto" style={{ color: 'var(--gold)' }}>{gradeFor(signalScore(latest))} {signalScore(latest)}</span>
            </div>
            <div className="font-mono text-[10px] mt-1" style={{ color: 'var(--textDim)' }}>
              Entry {fmtPrice(latest.symbol, latest.entry)} · SL {fmtPrice(latest.symbol, latest.stopLoss)} · TP {fmtPrice(latest.symbol, latest.targets?.[0])}
            </div>
            <div className="font-mono text-[9px] mt-0.5" style={{ color: 'var(--textFaint)' }}>
              Live FIRE · {timeAgo(latest.timestamp)} · {latest.gate?.status || 'pending'}
            </div>
          </div>
        )}
      </div>
      <div className="omni-panel omni-charts-rail p-3 flex flex-col min-h-0">
        <div className="font-mono text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--textFaint)' }}>
          Signals on chart · {symLabel(active)}
        </div>
        <div className="flex-1 overflow-y-auto omni-scroll space-y-2 min-h-0">
          {liveSignals.length === 0 ? (
            <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
              No FIRE yet for this symbol. When agents agree, BUY/SELL overlays the chart in real time.
            </div>
          ) : liveSignals.map(s => (
            <div key={s.id} className="omni-panel2 p-2.5">
              <div className="flex items-center gap-2 font-mono text-[12px]">
                <span style={{ color: s.action === 'BUY' || s.action === 'LONG' ? 'var(--emerald)' : 'var(--coral)', fontWeight: 700 }}>{s.action}</span>
                <span style={{ color: 'var(--textDim)' }}>{s.timeframe}</span>
                <span className="ml-auto" style={{ color: 'var(--gold)' }}>{signalScore(s)}</span>
              </div>
              <div className="font-mono text-[10px] mt-1" style={{ color: 'var(--textDim)' }}>
                {fmtPrice(s.symbol, s.entry)} · SL {fmtPrice(s.symbol, s.stopLoss)} · TP {fmtPrice(s.symbol, s.targets?.[0])}
              </div>
              <div className="font-mono text-[9px] mt-1" style={{ color: 'var(--textFaint)' }}>{timeAgo(s.timestamp)} · {s.gate?.status || 'pending'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DashTab({ signals, accountBalance, journalStats, prices, quotes, changes, mode, outlook, now, levels, analysisLive, socketLive, cryptoVolAlerts, calendar, deskBrief, onOpenChart, chartSymbol, onSymbolChange, theme }) {
  const list = Array.isArray(signals) ? signals : [];
  const approved = list.filter(s => s.gate?.status === 'approved' || s.gate?.status === 'APPROVED');
  const recent = [...list].sort((a, b) => {
    const rank = (s) => (s.action === 'BUY' || s.action === 'SELL' ? 0 : 1);
    return rank(a) - rank(b) || (b.timestamp || 0) - (a.timestamp || 0);
  }).slice(0, 16);

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
      <DeskBriefPanel brief={deskBrief} mode={mode} />
      <WhatToExpect outlook={outlook} calendar={calendar} now={now || Date.now()} mode={mode} />
      {/* FIX: TradingViewChart only ever existed full-page inside ChartsTab
          — DASH had no chart at all, just quote cards that navigate away
          to it. That's the "doesn't fit into the system when not
          expanded" gap: there was no not-expanded state to speak of.
          Compact embedded version here, bound to the same top-level
          chartSymbol state ChartsTab already uses, with an explicit
          expand action into the real full-page view — not a second,
          divergent chart implementation. */}
      <div className="omni-panel p-2 sm:p-3">
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <div className="flex gap-1 flex-wrap">
            {SYMBOLS.map(sym => (
              <button
                key={sym}
                type="button"
                onClick={() => onSymbolChange?.(sym)}
                className="omni-chip font-mono text-[10px] px-2 py-1 rounded-full"
                aria-pressed={chartSymbol === sym}
                style={{
                  color: chartSymbol === sym ? 'var(--inkOnAccent)' : 'var(--textDim)',
                  background: chartSymbol === sym ? 'var(--emerald)' : 'var(--panel2)',
                  border: '1px solid var(--glassBorder)',
                  fontWeight: chartSymbol === sym ? 700 : 500,
                }}
              >
                {symLabel(sym)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onOpenChart?.(chartSymbol)}
            className="font-mono text-[10px] px-2 py-1 rounded flex items-center gap-1 flex-shrink-0"
            style={{ color: 'var(--textDim)', border: '1px solid var(--glassBorder)', background: 'var(--panel2)' }}
            aria-label="Expand chart to full screen"
          >
            <Maximize2 size={11} /> Expand
          </button>
        </div>
        <div className="h-[240px] sm:h-[320px]">
          <ErrorBoundary key={'dash-tv-' + chartSymbol} label="TradingView">
            <TradingViewChart symbol={chartSymbol} theme={theme} />
          </ErrorBoundary>
        </div>
      </div>
      <div className="omni-home-grid">
            {SYMBOLS.map(sym => {
              const qq = quotes?.[sym];
              const ch = changes?.[sym];
              const up = ch == null ? null : ch >= 0;
              const bid = qq?.bid ?? qq?.price ?? prices?.[sym];
              const ask = qq?.ask ?? qq?.price ?? prices?.[sym];
              const src = qq?.source;
              const lv = levels?.[sym];
              return (
                <button
                  type="button"
                  key={sym}
                  className="omni-panel omni-quote-card p-3 font-mono"
                  onClick={() => onOpenChart?.(sym)}
                  aria-label={`Open ${symLabel(sym)} chart`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text)' }}>
                      {symLabel(sym)}
                    </span>
                    <span className="text-[9px] uppercase" style={{ color: 'var(--gold)' }}>
                      {sourceLabel(src)}
                    </span>
                  </div>
                  {ch != null && (
                    <div className="text-[11px] tabular-nums mb-2" style={{ color: up ? 'var(--emerald)' : 'var(--coral)' }}>
                      {fmtPct(ch)}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded px-2 py-1.5 min-w-0" style={{ background: 'color-mix(in srgb, var(--coral) 12%, transparent)' }}>
                      <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--textFaint)' }}>Bid</div>
                      <div className="text-[13px] tabular-nums font-semibold truncate" style={{ color: 'var(--coral)' }}>
                        {fmtPrice(sym, bid)}
                      </div>
                    </div>
                    <div className="rounded px-2 py-1.5 min-w-0" style={{ background: 'color-mix(in srgb, var(--emerald) 12%, transparent)' }}>
                      <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--textFaint)' }}>Ask</div>
                      <div className="text-[13px] tabular-nums font-semibold truncate" style={{ color: 'var(--emerald)' }}>
                        {fmtPrice(sym, ask)}
                      </div>
                    </div>
                  </div>
                  {lv?.support != null && lv?.resistance != null && (
                    <div className="font-mono text-[9px] mt-2 flex justify-between" style={{ color: 'var(--textFaint)' }}>
                      <span>S {fmtPrice(sym, lv.support)}</span>
                      <span>R {fmtPrice(sym, lv.resistance)}</span>
                    </div>
                  )}
                </button>
              );
            })}
      </div>

      {/* Market voice includes S/R — below ticks */}
      <MarketVoice now={now || Date.now()} signals={list} quotes={quotes} outlook={outlook} mode={mode} />

      <div className="omni-panel overflow-hidden">
        <SectionHeader icon={Radio} title="Recent signals" sub={`${recent.length} latest · approved ${approved.length} · all saved to MongoDB`} />
        {recent.length === 0 ? (
          <div className="p-3 font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
            No signals yet. Live prices keep running — signals fire only when score, agents, and gates clear.
          </div>
        ) : (
          <div className="divide-y max-h-[240px] overflow-y-auto omni-scroll" style={{ borderColor: 'var(--border)' }}>
            {recent.map(s => {
              const act = String(s.action || '').toUpperCase();
              const isWait = act === 'WAIT';
              const actColor = act === 'BUY' || act === 'LONG' ? 'var(--emerald)' : act === 'SELL' || act === 'SHORT' ? 'var(--coral)' : 'var(--textFaint)';
              return (
              <div key={s.id} className="px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]" style={{ opacity: isWait ? 0.72 : 1 }}>
                <span className="font-semibold" style={{ color: 'var(--text)' }}>{symLabel(s.symbol)}</span>
                <span style={{ color: 'var(--textDim)' }}>{s.timeframe}</span>
                <span style={{ color: actColor }}>{act}</span>
                <span style={{ color: 'var(--gold)' }}>{typeof s.score === 'object' ? s.score?.final ?? '—' : s.score}</span>
                {!isWait && <span style={{ color: 'var(--textDim)' }}>@ {fmtPrice(s.symbol, s.entry)}</span>}
                <Pill tone={s.gate?.status === 'approved' || s.gate?.status === 'APPROVED' ? 'up' : isWait ? 'warn' : 'warn'}>{s.gate?.status || (isWait ? 'scan' : '—')}</Pill>
                {!isWait && (
                <button
                  type="button"
                  className="omni-chip font-mono text-[9px] px-2 py-1 rounded min-h-[28px]"
                  style={{ color: 'var(--blue)', border: '1px solid var(--border)', background: 'var(--panel2)' }}
                  title="Copy MT5-style export"
                  onClick={() => copySignalExport(s)}
                >COPY</button>
                )}
                <span className="ml-auto text-[10px]" style={{ color: 'var(--textFaint)' }}>{timeAgo(s.timestamp)}</span>
              </div>
            );})}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard label="Signals" value={list.length} icon={Zap} accent="var(--violet)" />
        <StatCard label="Approved" value={approved.length} icon={CheckCircle2} />
        <StatCard label="Balance" value={accountBalance != null ? `$${Number(accountBalance).toLocaleString()}` : '—'} icon={Target} accent="var(--gold)" />
        <StatCard label="Win rate" value={journalStats?.winRate != null ? `${journalStats.winRate}%` : '—'} icon={Activity} accent="var(--blue)" />
      </div>
    </div>
  );
}

function SignalsTab({ signals, prices, quotes, analysisLive, socketLive, onOpenChart }) {
  const [expanded, setExpanded] = useState(null);
  const [desk, setDesk] = useState('ALL');
  const [onlyFire, setOnlyFire] = useState(true);
  const DESKS = {
    ALL: SYMBOLS,
    GOLD: ['XAUUSD'],
    OIL: ['USOIL'],
    DXY: ['UUP'],
    CRYPTO: ['BTCUSDT', 'ETHUSDT'],
    FX: ['EURUSD', 'GBPUSD', 'USDJPY'],
  };
  const deskSymbols = DESKS[desk] || SYMBOLS;
  const filtered = useMemo(() => {
    const allow = DESKS[desk] || SYMBOLS;
    const list = (signals || []).filter(s => {
      if (!allow.includes(s.symbol)) return false;
      if (onlyFire && !isFireAction(s.action)) return false;
      return true;
    });
    return list.slice().sort((a, b) => {
      const fa = isFireAction(a.action) ? 0 : 1;
      const fb = isFireAction(b.action) ? 0 : 1;
      return fa - fb || signalScore(b) - signalScore(a) || (b.timestamp || 0) - (a.timestamp || 0);
    });
  }, [signals, desk, onlyFire]);
  const fireCount = (signals || []).filter(s => isFireAction(s.action)).length;

  return (
    <div className="p-2 sm:p-3 space-y-2 sm:space-y-3 w-full max-w-[100vw]">
      <div className="omni-sr-only" aria-live="polite">{fireCount} live fire signals</div>
      <div className="flex items-center gap-2 flex-wrap">
        <SectionHeader
          icon={Radio}
          title="Live signals"
          sub={`${filtered.length} · ${socketLive ? 'push' : 'poll'} · ${analysisLive ? `scan ${analysisLive.symbol || ''} ${analysisLive.timeframe || ''}`.trim() : 'idle'}`}
        />
        <div className="ml-auto flex gap-1 flex-wrap">
          <button type="button" onClick={() => setOnlyFire(v => !v)}
            className="omni-chip font-mono text-[10px] px-2.5 py-1 rounded uppercase min-h-[40px]"
            aria-pressed={onlyFire}
            style={{ background: onlyFire ? 'var(--emerald)' : 'var(--panel2)', color: onlyFire ? 'var(--inkOnAccent)' : 'var(--textDim)' }}>
            {onlyFire ? 'FIRE only' : 'Include WAIT'}
          </button>
          {Object.keys(DESKS).map(d => (
            <button key={d} type="button" onClick={() => setDesk(d)}
              className="omni-chip font-mono text-[10px] px-2.5 py-1 rounded uppercase min-h-[40px]"
              aria-pressed={desk === d}
              style={{ background: desk === d ? 'var(--emerald)' : 'var(--panel2)', color: desk === d ? 'var(--inkOnAccent)' : 'var(--textDim)' }}>
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {deskSymbols.map(sym => {
          const q = quotes?.[sym];
          const mid = q?.price ?? prices?.[sym];
          const n = (signals || []).filter(s => s.symbol === sym && isFireAction(s.action)).length;
          return (
            <button
              key={sym}
              type="button"
              className="omni-panel2 omni-quote-card px-2.5 py-2 font-mono text-[10px]"
              onClick={() => onOpenChart?.(sym)}
              aria-label={`Open ${symLabel(sym)} chart`}
            >
              <div className="flex justify-between mb-1">
                <span style={{ color: 'var(--text)' }}>{symLabel(sym)}</span>
                <span style={{ color: q?.source === 'mt5_ea' || q?.source === 'tradingview' ? 'var(--gold)' : 'var(--textFaint)' }}>
                  {sourceLabel(q?.source)}
                </span>
              </div>
              {q?.bid != null && q?.ask != null ? (
                <div className="flex gap-2">
                  <span style={{ color: 'var(--coral)' }}>{fmtPrice(sym, q.bid)}</span>
                  <span style={{ color: 'var(--emerald)' }}>{fmtPrice(sym, q.ask)}</span>
                </div>
              ) : (
                <div style={{ color: 'var(--textDim)' }}>{fmtPrice(sym, mid)}</div>
              )}
              <div className="mt-1" style={{ color: 'var(--textFaint)' }}>{n} FIRE</div>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="omni-panel p-6 font-mono text-[12px] text-center" style={{ color: 'var(--textFaint)' }}>
          {socketLive
            ? 'Live feed is connected. No FIRE on this desk yet — the engine only speaks when score, agents, and gates clear.'
            : 'Reconnecting to live feed… last-known signals will appear here.'}
        </div>
      ) : (
        <div className="omni-signals-list">
          {filtered.map(s => {
            const open = expanded === s.id;
            const fire = isFireAction(s.action);
            const actColor = s.action === 'BUY' || s.action === 'LONG' ? 'var(--emerald)' : s.action === 'SELL' || s.action === 'SHORT' ? 'var(--coral)' : 'var(--textFaint)';
            const agents = Array.isArray(s.agents) ? s.agents : [];
            const reasons = Array.isArray(s.reasons) ? s.reasons : [];
            const checklist = s.gate?.checklist && typeof s.gate.checklist === 'object' ? s.gate.checklist : {};
            return (
              <article key={s.id} className="omni-panel overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : s.id)}
                  className="omni-row w-full text-left px-3 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]"
                  aria-expanded={open}
                >
                  <span className="font-semibold" style={{ color: 'var(--text)' }}>{symLabel(s.symbol)}</span>
                  <span style={{ color: 'var(--textDim)' }}>{s.timeframe || 'H1'}</span>
                  <span style={{ color: actColor, fontWeight: 700 }}>{s.action}</span>
                  <span style={{ color: 'var(--gold)' }}>{gradeFor(signalScore(s))} · {signalScore(s)}</span>
                  {fire && <span style={{ color: 'var(--textDim)' }}>@ {fmtPrice(s.symbol, s.entry)}</span>}
                  <Pill tone={s.gate?.status === 'approved' || s.gate?.status === 'APPROVED' ? 'up' : fire ? 'warn' : 'neutral'}>
                    {s.gate?.status || (fire ? 'FIRE' : 'WAIT')}
                  </Pill>
                  <span className="ml-auto text-[10px] flex items-center gap-1" style={{ color: 'var(--textFaint)' }}>
                    {timeAgo(s.timestamp)}
                    <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : 'none' }} aria-hidden="true" />
                  </span>
                </button>
                {open && (
                  <div className="px-3 pb-3 border-t space-y-3" style={{ borderColor: 'var(--border)', background: 'var(--panel2)' }}>
                    <div className="pt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
                      <span style={{ color: 'var(--textDim)' }}>Entry <b style={{ color: 'var(--text)' }}>{fmtPrice(s.symbol, s.entry)}</b></span>
                      <span style={{ color: 'var(--textDim)' }}>SL <b style={{ color: 'var(--coral)' }}>{fmtPrice(s.symbol, s.stopLoss)}</b></span>
                      <span style={{ color: 'var(--textDim)' }}>TP1 <b style={{ color: 'var(--emerald)' }}>{fmtPrice(s.symbol, s.targets?.[0])}</b></span>
                      <span style={{ color: 'var(--textDim)' }}>TP2 <b style={{ color: 'var(--emerald)' }}>{fmtPrice(s.symbol, s.targets?.[1])}</b></span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="omni-chip font-mono text-[10px] px-3 py-2 rounded min-h-[40px]"
                        style={{ color: 'var(--inkOnAccent)', background: 'var(--emerald)' }}
                        onClick={() => onOpenChart?.(s.symbol)}
                      >
                        View on chart
                      </button>
                      <button
                        type="button"
                        className="omni-chip font-mono text-[10px] px-3 py-2 rounded min-h-[40px]"
                        style={{ color: 'var(--blue)', border: '1px solid var(--border)', background: 'var(--panel)' }}
                        onClick={() => copySignalExport(s)}
                      >
                        Copy
                      </button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                      <div>
                        <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>
                          Agents ({s.agreeCount ?? agents.filter(a => a.direction === s.action).length}/{agents.length || 8} aligned)
                        </div>
                        <div className="space-y-1">
                          {agents.length === 0 ? (
                            <div className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>No agent breakdown on this signal.</div>
                          ) : agents.map(a => (
                            <div key={a.agent} className="flex items-center gap-2 font-mono text-[10px]">
                              <span className="w-24 truncate" style={{ color: 'var(--textDim)' }}>{a.agent}</span>
                              <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                                <div className="h-full" style={{ width: `${Math.max(0, Math.min(100, Number(a.score) || 0))}%`, background: a.direction === s.action ? 'var(--emerald)' : 'var(--coral)' }} />
                              </div>
                              <span style={{ color: a.direction === s.action ? 'var(--emerald)' : 'var(--coral)' }}>{a.direction}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>Institutional gates</div>
                        <div className="space-y-1.5">
                          {Object.keys(checklist).length === 0 ? (
                            <div className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>Awaiting gate evaluation.</div>
                          ) : Object.entries(checklist).map(([k, ok]) => (
                            <div key={k} className="flex items-center gap-2 font-mono text-[10px]" style={{ color: ok ? 'var(--textDim)' : 'var(--coral)' }}>
                              {ok ? <CheckCircle2 size={12} style={{ color: 'var(--emerald)' }} /> : <XCircle size={12} style={{ color: 'var(--coral)' }} />}
                              {k}
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 font-mono text-[10px]" style={{ color: 'var(--textDim)' }}>
                          Risk: {s.risk?.effectiveRisk ?? '—'}% · max loss ${s.risk?.maxLoss ?? '—'} · {s.risk?.note || '—'}
                        </div>
                      </div>
                      <div>
                        <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>Validation</div>
                        {s.validation ? (
                          <div className="space-y-1.5 font-mono text-[10px]">
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--textDim)' }}>Monte Carlo</span>
                              <Pill tone={s.validation.monteCarlo?.approved ? 'up' : 'down'}>{s.validation.monteCarlo?.winProbability ?? '—'}% win</Pill>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--textDim)' }}>Bayesian</span>
                              <Pill tone={s.validation.bayesian?.approved ? 'up' : 'down'}>{s.validation.bayesian?.posterior ?? '—'}</Pill>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--textDim)' }}>Statistical</span>
                              <Pill tone={s.validation.statistical?.approved ? 'up' : 'down'}>{s.validation.statistical?.passed ?? '—'}/{s.validation.statistical?.total ?? '—'}</Pill>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--textDim)' }}>Walk-forward</span>
                              <Pill tone={s.validation.walkForward?.robust ? 'up' : 'warn'}>wfe {s.validation.walkForward?.wfe ?? '—'}</Pill>
                            </div>
                          </div>
                        ) : (
                          <div className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>No validation payload on this signal.</div>
                        )}
                      </div>
                      <div>
                        <div className="font-mono text-[9px] uppercase mb-2" style={{ color: 'var(--textFaint)' }}>Why it fired</div>
                        <ul className="space-y-1">
                          {reasons.length === 0 ? (
                            <li className="font-mono text-[10px]" style={{ color: 'var(--textFaint)' }}>No explainer lines.</li>
                          ) : reasons.map((r, i) => (
                            <li key={i} className="font-mono text-[10px] flex gap-1.5" style={{ color: 'var(--textDim)' }}>
                              <ChevronRight size={11} style={{ color: 'var(--violet)', flexShrink: 0, marginTop: 1 }} aria-hidden="true" />{r}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
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
    { id: 'stocks', label: 'Stocks' },
    { id: 'forex', label: 'Forex' },
    { id: 'crypto', label: 'Crypto' },
    { id: 'macro', label: 'Macro / Fed' },
    { id: 'gold', label: 'Gold' },
    { id: 'oil', label: 'Oil' },
  ];
  const MARKET_RE = /bitcoin|btc|ethereum|eth|crypto|defi|stablecoin|solana|sec\b|etf|binance|coinbase|forex|fx\b|eurusd|gbpusd|usdjpy|currency|dollar|dxy|fed\b|fomc|ecb|boj|boe|cpi|nfp|inflation|interest rate|treasury|yield|gold|xau|oil|wti|brent|opec|nasdaq|s&p|dow jones|stock market|equities|earnings|shares|wall street|nyse|liquidity|central bank|risk.?on|risk.?off|payroll/i;
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
      if (cat === 'stocks') return /nasdaq|s&p|dow|stock|equit|earning|shares|wall street|nyse|etf/.test(t);
      if (cat === 'crypto') return c === 'crypto' || CRYPTO_RE.test(t);
      if (cat === 'forex') return c === 'forex' || FOREX_RE.test(t) || /eur|gbp|jpy|dollar/.test(t);
      if (cat === 'macro') return /fed\b|fomc|ecb|boj|boe|cpi|nfp|inflation|interest rate|treasury|yield|central bank|payroll/.test(t);
      if (cat === 'gold') return c === 'gold' || /gold|xau|bullion/.test(t);
      if (cat === 'oil') return c === 'oil' || /oil|opec|wti|brent|crude/.test(t);
      return true;
    })
    .slice()
    .sort((a, b) => ((b.datetime || 0) - (a.datetime || 0)) || (rankItem(b) - rankItem(a)));

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
              loading="lazy"
              decoding="async"
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
                color: readable ? 'var(--textDim)' : 'var(--inkOnAccent)',
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
            style={{ background: cat === c.id ? 'var(--emerald)' : 'var(--panel2)', color: cat === c.id ? 'var(--inkOnAccent)' : 'var(--textDim)' }}>{c.label}</button>
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
            Feed status not loaded yet. Log in, wait a few seconds, or open System again after the server finishes booting.
          </div>
        ) : null}
        <div className="font-mono text-[11px] mb-3 flex flex-wrap gap-3" style={{ color: 'var(--textDim)' }}>
          <span style={{ color: socketLive ? 'var(--emerald)' : 'var(--textFaint)' }}>{socketLive ? '● socket + heartbeat' : '○ socket reconnecting'}</span>
          {analysisLive ? <span style={{ color: 'var(--gold)' }}>scan {analysisLive.symbol} {analysisLive.timeframe}</span> : null}
        </div>
        {activeErrors.length > 0 && (
          <div className="font-mono text-[10px] mb-3" style={{ color: 'var(--coral)' }}>
            {activeErrors.slice(0, 4).map(([k, v]) => <div key={k}>{k}: {String(v).slice(0, 80)}</div>)}
          </div>
        )}
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
      {Array.isArray(auditLog) && auditLog.length > 0 && (
        <div className="omni-panel p-4">
          <SectionHeader icon={ScrollText} title="Recent events" sub={`${auditLog.length} · near-miss + trail`} />
          <div className="max-h-56 overflow-y-auto omni-scroll space-y-1">
            {auditLog.slice(0, 24).map((e, i) => (
              <div key={e.id || i} className="font-mono text-[10px] flex flex-wrap gap-2 py-1 border-b" style={{ borderColor: 'var(--border)', color: 'var(--textDim)' }}>
                <span style={{ color: 'var(--textFaint)' }}>{e.timestamp ? timeAgo(e.timestamp) : ''}</span>
                <span style={{ color: 'var(--text)' }}>{e.symbol || e.type || 'event'}</span>
                <span className="truncate">{e.reason || e.message || e.status || e.action || JSON.stringify(e).slice(0, 80)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
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

function AnalysisTab({ mode, heatmapTiles, relativeStrength, hurstBoard }) {
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

  const rows = board.length ? board : (Array.isArray(hurstBoard) ? hurstBoard : []);

  return (
    <div className="p-2 sm:p-3 space-y-3 w-full max-w-[100vw]">
      <div className="omni-panel p-4">
        <SectionHeader icon={Activity} title="Market heat" sub="opportunity × relative strength" />
        {!Array.isArray(heatmapTiles) || heatmapTiles.length === 0 ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
            Heatmap fills once the ranker has enough candles. Waiting on live data — not a dead panel.
          </div>
        ) : (
          <div className="omni-heat-grid">
            {heatmapTiles.slice(0, 8).map((t) => {
              const score = Number(t.heatScore) || 0;
              const tone = score >= 70 ? 'var(--emerald)' : score >= 45 ? 'var(--gold)' : 'var(--textDim)';
              return (
                <div key={t.symbol} className="omni-panel2 p-2.5">
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span style={{ color: 'var(--text)' }}>{symLabel(t.symbol)}</span>
                    <span style={{ color: tone }}>{score.toFixed(0)}</span>
                  </div>
                  <div className="font-mono text-[9px] mt-1 uppercase" style={{ color: 'var(--textFaint)' }}>
                    {String(t.bucket || t.bias || '—').replace(/_/g, ' ')}
                  </div>
                  {t.relativeStrength?.changePct != null && (
                    <div className="font-mono text-[10px] mt-1" style={{ color: t.relativeStrength.changePct >= 0 ? 'var(--emerald)' : 'var(--coral)' }}>
                      {fmtPct(t.relativeStrength.changePct)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {relativeStrength && (relativeStrength.leaders || relativeStrength.laggards) ? (
        <div className="omni-panel p-4">
          <SectionHeader icon={TrendingUp} title="Relative strength" sub="leaders · laggards" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="font-mono text-[9px] uppercase mb-1.5" style={{ color: 'var(--emerald)' }}>Leaders</div>
              {(relativeStrength.leaders || []).slice(0, 6).map((r, i) => (
                <div key={r.symbol || i} className="flex justify-between font-mono text-[11px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                  <span style={{ color: 'var(--text)' }}>{symLabel(r.symbol)}</span>
                  <span style={{ color: 'var(--emerald)' }}>{r.changePct != null ? fmtPct(r.changePct) : (r.volAdjScore ?? '—')}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="font-mono text-[9px] uppercase mb-1.5" style={{ color: 'var(--coral)' }}>Laggards</div>
              {(relativeStrength.laggards || []).slice(0, 6).map((r, i) => (
                <div key={r.symbol || i} className="flex justify-between font-mono text-[11px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                  <span style={{ color: 'var(--text)' }}>{symLabel(r.symbol)}</span>
                  <span style={{ color: 'var(--coral)' }}>{r.changePct != null ? fmtPct(r.changePct) : (r.volAdjScore ?? '—')}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

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
        {rows.length === 0 && !loading ? (
          <div className="font-mono text-[11px]" style={{ color: 'var(--textFaint)' }}>
            No analysis yet — need enough H1/H4 candles per symbol.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => {
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
        <SectionHeader icon={Layers} title="About this layer" sub="fully decoupled from signal pipeline" />
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
        Manual trading mode: size and exposure live in your broker. This queue is gate-approved FIRE only.
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
          style={{ background: 'var(--emerald)', color: 'var(--inkOnAccent)' }}
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
            style={{ background: 'var(--emerald)', color: 'var(--inkOnAccent)' }}
            onClick={finishForever}
          >
            I installed it — hide this
          </button>
        </div>
      )}
    </div>
  );
}


class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try { console.error('[OMNICEE]', this.props.label || 'UI', error, info); } catch (_) {}
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error?.message || String(this.state.error);
      return (
        <div className="omni-panel p-4 m-2" role="alert">
          <div className="font-mono text-[12px]" style={{ color: 'var(--gold)' }}>{this.props.label || 'Panel'} failed to render</div>
          <div className="font-mono text-[11px] mt-1" style={{ color: 'var(--textDim)' }}>{msg}</div>
          <button
            type="button"
            className="omni-chip mt-3 px-3 py-2 font-mono text-[11px] rounded min-h-[40px]"
            style={{ background: 'var(--emerald)', color: 'var(--inkOnAccent)' }}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
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
function SignalToast({ toast, onDismiss }) {
  if (!toast) return null;
  const buy = toast.action === 'BUY';
  return (
    <div role="alert" className="fixed z-[10000] left-1/2 -translate-x-1/2 top-3 max-w-[min(420px,94vw)] w-full px-3">
      <div className="omni-panel px-4 py-3 flex items-start gap-3" style={{ borderColor: buy ? 'rgba(52,211,153,0.55)' : 'rgba(248,113,113,0.55)', boxShadow: '0 12px 40px rgba(0,0,0,0.45)' }}>
        <div className="font-mono text-[11px] uppercase tracking-wider mt-0.5" style={{ color: buy ? 'var(--emerald)' : 'var(--coral)' }}>{toast.action}</div>
        <div className="flex-1 min-w-0">
          <div className="font-display text-[13px] tracking-wider" style={{ color: 'var(--text)' }}>{toast.symbol} · {toast.timeframe || 'H1'}</div>
          <div className="font-mono text-[11px] mt-0.5" style={{ color: 'var(--textDim)' }}>Score {toast.score != null ? Math.round(Number(toast.score)) : '—'} · live signal</div>
        </div>
        <button type="button" onClick={onDismiss} className="font-mono text-[10px] px-2 py-1 rounded" style={{ color: 'var(--textFaint)', border: '1px solid var(--border)' }}>DISMISS</button>
      </div>
    </div>
  );
}

export default function OmniceeDashboard() {
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const tab = new URLSearchParams(window.location.search).get('tab');
      if (tab && ['DASH', 'CHARTS', 'SIGNALS', 'ANALYSIS', 'NEWS', 'MONITOR'].includes(tab)) return tab;
    } catch (_) {}
    return 'DASH';
  });
  const [installEvt, setInstallEvt] = useState(null);
  const [user, setUser] = useState(() => getSession());
  const [soundOn, setSoundOn] = useState(() => loadSoundPref());
  const [theme, setTheme] = useState(() => loadTheme());
  const [chartSymbol, setChartSymbol] = useState('XAUUSD');
  const toggleSound = useCallback(() => {
    setSoundOn(prev => {
      const next = !prev;
      saveSoundPref(next);
      return next;
    });
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'light' ? 'dark' : 'light';
      saveTheme(next);
      return next;
    });
  }, []);
  const openChart = useCallback((sym) => {
    if (sym && SYMBOLS.includes(sym)) setChartSymbol(sym);
    setActiveTab('CHARTS');
  }, []);
  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.colorScheme = theme;
      document.body.style.background = theme === 'light' ? '#eef2f7' : '#0b1220';
      document.body.style.color = theme === 'light' ? '#0f172a' : '#f1f5f9';
    } catch (_) {}
  }, [theme]);
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
    if (SYMBOLS.includes(val)) { openChart(val); return; }
  }, [openChart]);

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
        <div className="omni-root" data-theme={theme} style={{ minHeight: '100dvh' }}>
          <LoginGate onAuthed={(u) => setUser(u)} theme={theme} onToggleTheme={toggleTheme} />
        </div>
      </>
    );
  }

  const priceCount = Object.values(feed.quotes || {}).filter((q) => Number.isFinite(q?.price) || Number.isFinite(q?.bid)).length
    + Object.values(feed.prices || {}).filter((p) => Number.isFinite(p)).length;
  const pricesDead = !feed.wakingBackend && feed.mode === 'live' && priceCount === 0;

  return (
    <AppErrorBoundary>
    <div className={`omni-root text-sm${activeTab === 'CHARTS' ? ' is-charts' : ''}`} data-theme={theme} style={{ minHeight: '100dvh', background: 'var(--void)', color: 'var(--text)' }}>
      <ThemeStyle />
      {feed.signalToast ? <SignalToast toast={feed.signalToast} onDismiss={feed.dismissSignalToast} /> : null}
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
        theme={theme}
        onToggleTheme={toggleTheme}
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
          No live prices. TradingView quotes load after the server wakes. Attach OmniceeEA in MT5 for broker-true gold/FX.
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
            {activeTab === 'DASH' && <DashTab signals={feed.signals} accountBalance={feed.accountBalance} journalStats={feed.journalStats} prices={feed.prices} quotes={feed.quotes} changes={feed.changes} mode={feed.mode} outlook={feed.outlook} now={feed.now} levels={feed.levels} analysisLive={feed.analysisLive} socketLive={feed.socketLive} cryptoVolAlerts={feed.cryptoVolAlerts} calendar={feed.calendar} deskBrief={feed.deskBrief} onOpenChart={openChart} chartSymbol={chartSymbol} onSymbolChange={setChartSymbol} theme={theme} />}
            {activeTab === 'CHARTS' && <ChartsTab quotes={feed.quotes} mode={feed.mode} signals={feed.signals} theme={theme} chartSymbol={chartSymbol} onSymbolChange={setChartSymbol} />}
            {activeTab === 'SIGNALS' && (
              <SignalsTab signals={feed.signals} prices={feed.prices} quotes={feed.quotes} analysisLive={feed.analysisLive} socketLive={feed.socketLive} onOpenChart={openChart} />
            )}
            {activeTab === 'NEWS' && <NewsTab news={feed.news} mode={feed.mode} />}
            {activeTab === 'ANALYSIS' && (
              <AnalysisTab mode={feed.mode} heatmapTiles={feed.heatmapTiles} relativeStrength={feed.relativeStrength} hurstBoard={feed.hurstBoard} />
            )}
            {activeTab === 'MONITOR' && (
              <div className="space-y-2">
                <MonitorTab auditLog={feed.auditLog} feedHealth={feed.feedHealth} uptimeSec={feed.uptimeSec} mode={feed.mode} fetchErrors={feed.fetchErrors} analysisLive={feed.analysisLive} socketLive={feed.socketLive} />
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
