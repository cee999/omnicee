'use strict';

/**
 * Single, shared "a trade outcome just happened" pipeline.
 *
 * FIX: this exact sequence — adaptiveLearning.recordOutcome() then feeding
 * bayesianEng / walkForward / institutionalGates / sessionFilter /
 * drawdownGuard / institutionalRiskManager — used to live inline, duplicated,
 * in two places in api/server.js (POST /api/outcomes and the record_outcome
 * socket event). A third real entry point exists (the Telegram /win, /loss,
 * /be commands) that was NEVER wired to any of this — it called a
 * `dispatcher.scorer.recordTradeOutcome()` where `dispatcher.scorer` is never
 * assigned anywhere in the codebase, so it silently did nothing beyond
 * sending a confirmation message. Factored out so all three entry points
 * share one implementation instead of drifting out of sync.
 *
 * @param {Object} params
 * @param {string} params.signalId
 * @param {Object} params.signal        - the original signal object
 * @param {Object} params.outcome       - { pnlR } or { pnlPct } or { result }
 * @param {Object} params.mongoStore    - db module (getTradeOutcome/saveTradeOutcome live inside adaptiveLearning.store)
 * @param {Object} params.engines       - { adaptiveLearning, bayesianEng, walkForward, institutionalGates, sessionFilter, drawdownGuard, institutionalRiskManager }
 * @param {Object} [params.fallbackLearningEngine] - used only if engines.adaptiveLearning is unavailable
 * @returns {Promise<{ok: boolean, saved?: Object, error?: string, status?: number}>}
 */
async function recordOutcomeEverywhere({ signalId, signal, outcome, mongoStore, engines = {}, fallbackLearningEngine = null }) {
  if (!signalId || !outcome) return { ok: false, error: 'signalId and outcome are required', status: 400 };
  if (!signal) return { ok: false, error: 'Signal not found', status: 404 };

  const existing = await mongoStore?.getTradeOutcome?.(signalId).catch(() => null);
  if (existing) return { ok: false, error: 'Outcome already recorded for this signal', outcome: existing, status: 409 };

  const activeLearningEngine = engines.adaptiveLearning || fallbackLearningEngine;
  if (!activeLearningEngine) return { ok: false, error: 'No learning engine available', status: 503 };

  const saved = await activeLearningEngine.recordOutcome({ signalId, signal, outcome }).catch(err => ({ __error: err.message }));
  if (!saved || saved.__error) return { ok: false, error: saved?.__error || 'recordOutcome failed', status: 503 };

  const isWin = (saved.pnlR || 0) > 0;
  try { engines.bayesianEng?.recordOutcome({ signal, outcome, regime: signal?.regime, session: signal?.session }); } catch (_) {}
  try { engines.walkForward?.recordOutcome({ signal, outcome }); } catch (_) {}
  try { engines.institutionalGates?.recordSymbolOutcome(saved.symbol, isWin); } catch (_) {}
  try { engines.sessionFilter?.recordOutcome({ symbol: saved.symbol, result: isWin ? 'WIN' : 'LOSS', pnlPct: saved.pnlPct, timestamp: saved.closedAt || Date.now() }); } catch (_) {}
  try {
    engines.drawdownGuard?.record({
      pnlPct: Number(saved.pnlPct || 0),
      won: isWin,
      symbol: saved.symbol,
      signalId: saved.signalId,
      grade: signal?.score?.grade,
      pnlR: saved.pnlR,
    });
  } catch (_) {}
  // FIX: executePosition() (index.js) tracks a position in
  // InstitutionalRiskManager's portfolio model when a signal fires, but
  // nothing ever called closePosition() — tracked exposure would only ever
  // accumulate, making its correlation/portfolio-exposure checks
  // increasingly wrong over time (eventually blocking everything as
  // "over-exposed" on positions that were actually closed long ago).
  try { engines.institutionalRiskManager?.closePosition(saved.symbol); } catch (_) {}
  try { engines.institutionalRiskManager?.recordTradeResult(saved.symbol, saved.pnlR, saved.closedAt); } catch (_) {}
  // FIX: RiskEngine.recordTrade() (risk-engine/position-sizer.js) feeds the
  // performance stats (win rate, avg win, avg loss) that its own internal
  // Kelly Criterion overlay requires 10+ real trades of before it will ever
  // activate — this method existed with zero call sites anywhere, so even
  // with useKelly:true configured, the overlay could never turn on.
  try { engines.riskEngine?.recordTrade({ pnlR: saved.pnlR }); } catch (_) {}

  return { ok: true, saved, isWin };
}

module.exports = { recordOutcomeEverywhere };
