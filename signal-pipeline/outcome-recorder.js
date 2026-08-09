'use strict';

// FIX: this exact sequence — adaptiveLearning.recordOutcome() then feeding bayesianEng / walkForward / institutionalGates / sessionFilter / drawdownGuard / institutionalRiskManager — used to live...
async function recordOutcomeEverywhere({ signalId, signal, outcome, mongoStore, engines = {}, fallbackLearningEngine = null }) {
  // FIX: every secondary engine-feed call below used to swallow failures completely — `catch (_) {}`, zero logging.
  const logEngineFailure = (name, err) =>
    console.warn(`[OutcomeRecorder] ${name}.recordOutcome-style update failed for signal ${signalId} — that engine's internal state may now be out of sync with this trade's real outcome: ${err.message}`);

  if (!signalId || !outcome) return { ok: false, error: 'signalId and outcome are required', status: 400 };
  if (!signal) return { ok: false, error: 'Signal not found', status: 404 };

  const existing = await mongoStore?.getTradeOutcome?.(signalId).catch(() => null);
  if (existing) return { ok: false, error: 'Outcome already recorded for this signal', outcome: existing, status: 409 };

  const activeLearningEngine = engines.adaptiveLearning || fallbackLearningEngine;
  if (!activeLearningEngine) return { ok: false, error: 'No learning engine available', status: 503 };

  const saved = await activeLearningEngine.recordOutcome({ signalId, signal, outcome }).catch(err => ({ __error: err.message }));
  if (!saved || saved.__error) return { ok: false, error: saved?.__error || 'recordOutcome failed', status: 503 };

  const isWin = (saved.pnlR || 0) > 0;
  try { engines.bayesianEng?.recordOutcome({ signal, outcome, regime: signal?.regime, session: signal?.session }); } catch (e) { logEngineFailure('bayesianEng', e); }
  try { engines.walkForward?.recordOutcome({ signal, outcome }); } catch (e) { logEngineFailure('walkForward', e); }
  try { engines.institutionalGates?.recordSymbolOutcome(saved.symbol, isWin); } catch (e) { logEngineFailure('institutionalGates', e); }
  try { engines.sessionFilter?.recordOutcome({ symbol: saved.symbol, result: isWin ? 'WIN' : 'LOSS', pnlPct: saved.pnlPct, timestamp: saved.closedAt || Date.now() }); } catch (e) { logEngineFailure('sessionFilter', e); }
  try {
    engines.drawdownGuard?.record({
      pnlPct: Number(saved.pnlPct || 0),
      won: isWin,
      symbol: saved.symbol,
      signalId: saved.signalId,
      grade: signal?.score?.grade,
      pnlR: saved.pnlR,
    });
  } catch (e) { logEngineFailure('drawdownGuard', e); }
  // FIX: executePosition() (index.js) tracks a position in InstitutionalRiskManager's portfolio model when a signal fires, but nothing ever called closePosition() — tracked exposure would only ever...
  try { engines.institutionalRiskManager?.closePosition(saved.symbol); } catch (e) { logEngineFailure('institutionalRiskManager.closePosition', e); }
  try { engines.institutionalRiskManager?.recordTradeResult(saved.symbol, saved.pnlR, saved.closedAt); } catch (e) { logEngineFailure('institutionalRiskManager.recordTradeResult', e); }
  // FIX: RiskEngine.recordTrade() (risk-engine/position-sizer.js) feeds the performance stats (win rate, avg win, avg loss) that its own internal Kelly Criterion overlay requires 10+ real trades of...
  try { engines.riskEngine?.recordTrade({ pnlR: saved.pnlR }); } catch (e) { logEngineFailure('riskEngine.recordTrade', e); }

  return { ok: true, saved, isWin };
}

module.exports = { recordOutcomeEverywhere };
