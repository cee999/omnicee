'use strict';

const EventEmitter = require('events');
const { notifyAll } = require('../api/web-push-store');

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

class WebAlertDispatcher extends EventEmitter {
  constructor(config = {}) {
    super();
    this.accountBalance = Number(config.accountBalance || process.env.ACCOUNT_BALANCE || 1000);
    this.riskPct = Number(config.riskPct || process.env.RISK_PCT_PER_TRADE || 1);
    this.scorer = config.scorer || null;
    this.feed = config.feed || null;
    this.riskEngine = config.riskEngine || null;
    this._store = config.store || null;
    this._paused = false;
    this._pendingSignals = new Map();
    this._approvedSignals = new Map();
    this._recordedOutcomes = new Set();
    this._seen = new Map();
    this._lastSignal = null;
    this._stats = { signalsSent: 0, messagesSent: 0, errorsCount: 0, startTime: null };
  }

  async init() {
    this._stats.startTime = Date.now();
    this.emit('ready', { transport: 'web-push' });
    console.log('[WebAlertDispatcher] Ready — Telegram transport removed; using Web Push');
  }

  _isDuplicate(signal) {
    const key = `${signal.symbol}_${signal.action}_${signal.timeframe}`;
    const last = this._seen.get(key);
    if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
    this._seen.set(key, Date.now());
    return false;
  }

  _cleanupDedup() {
    const cutoff = Date.now() - DEDUP_WINDOW_MS * 2;
    for (const [key, timestamp] of this._seen) if (timestamp < cutoff) this._seen.delete(key);
  }

  async sendSignal(signal) {
    if (!signal || signal.action === 'WAIT' || this._paused) return { sent: 0, skipped: true };
    if (this._isDuplicate(signal)) return { sent: 0, skipped: true, reason: 'duplicate' };
    if (!signal.id) signal.id = `${signal.symbol}-${signal.action}-${Date.now()}`;

    this._pendingSignals.set(signal.id, signal);
    this._lastSignal = signal.id;
    this._stats.signalsSent += 1;

    const score = Number(signal.score?.final ?? signal.score ?? 0);
    const grade = signal.score?.grade || '';
    const title = `${signal.action === 'LONG' ? '🟢' : '🔴'} ${signal.action} ${signal.symbol}`;
    const body = `${signal.timeframe || ''} • Score ${score.toFixed ? score.toFixed(1) : score}${grade ? ` • Grade ${grade}` : ''}`;
    const payload = {
      title,
      body,
      tag: `omnicee-signal-${signal.id}`,
      url: `/signals/${encodeURIComponent(signal.id)}`,
      signalId: signal.id,
      timestamp: Date.now(),
    };

    try {
      const result = await notifyAll(payload);
      this._stats.messagesSent += result.sent || 0;
      this.emit('sent', { signalId: signal.id, result });
      return result;
    } catch (err) {
      this._stats.errorsCount += 1;
      this.emit('error', err);
      console.error('[WebAlertDispatcher] Notification failed:', err.message);
      return { sent: 0, error: err.message };
    } finally {
      this._cleanupDedup();
    }
  }

  approveSignal(signalId, approvedBy = 'web') {
    const signal = this._pendingSignals.get(signalId);
    if (!signal) return { ok: false, error: 'Signal not found' };
    this._approvedSignals.set(signalId, { signal, approvedAt: Date.now(), approvedBy });
    this.emit('approved', { signalId, approvedBy, signal });
    return { ok: true, signal };
  }

  markSignalExecuted(signalId, execution = {}) {
    const approved = this._approvedSignals.get(signalId);
    if (!approved) return { ok: false, error: 'Signal not approved or already consumed' };
    this._approvedSignals.delete(signalId);
    this._pendingSignals.delete(signalId);
    this.emit('executed', { signalId, signal: approved.signal, execution });
    return { ok: true };
  }

  getApprovedSignals() {
    return [...this._approvedSignals.entries()].map(([id, value]) => ({ id, ...value }));
  }

  getPendingSignals() {
    return [...this._pendingSignals.entries()].map(([id, signal]) => ({ id, signal }));
  }

  setRiskPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 10) throw new Error('Risk percentage must be > 0 and <= 10');
    this.riskPct = n;
    this.emit('risk_changed', { riskPct: n });
    return n;
  }

  pause() { this._paused = true; this.emit('paused'); return true; }
  resume() { this._paused = false; this.emit('resumed'); return true; }
  isPaused() { return this._paused; }

  getLastSignalId() { return this._lastSignal; }
  getRecent(n = 5) { return [...this._pendingSignals.entries()].slice(-n).reverse().map(([id, signal]) => ({ id, signal })); }
  getStatus() {
    return {
      transport: 'web-push', paused: this._paused,
      pending: this._pendingSignals.size,
      approved: this._approvedSignals.size,
      riskPct: this.riskPct,
      stats: { ...this._stats },
    };
  }

  async recordOutcome(signalId, outcome) {
    if (this._recordedOutcomes.has(signalId)) return { ok: false, error: 'Outcome already recorded' };
    this._recordedOutcomes.add(signalId);
    this.emit('outcome', { signalId, outcome });
    return { ok: true };
  }
}

module.exports = { AlertDispatcher: WebAlertDispatcher, WebAlertDispatcher };
