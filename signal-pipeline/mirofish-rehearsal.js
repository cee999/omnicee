'use strict';

/**
 * MiroFish-inspired pre-FIRE rehearsal (lightweight, no external LLM required).
 *
 * Full MiroFish builds a multi-agent social simulation from seed materials.
 * Here we adapt the idea to trading signals:
 *  - Treat existing Omnicee agents as the swarm
 *  - Require consensus + score quality before a FIRE is considered "rehearsed"
 *  - Optional LLM boost only if ANTHROPIC_API_KEY / OPENAI_API_KEY present
 *    (never blocks the engine if LLM fails — fail open with lower confidence)
 */

function normalizeDir(d) {
  const a = String(d || '').toUpperCase();
  if (a === 'LONG') return 'BUY';
  if (a === 'SHORT') return 'SELL';
  return a;
}

/**
 * @param {Array} agents [{ agent, direction, score }]
 * @param {string} action BUY|SELL
 * @param {object} [opts]
 */
function rehearse(agents, action, opts = {}) {
  const minConsensus = opts.minConsensus ?? 0.6;
  const minAligned = opts.minAligned ?? 4;
  const minAvgScore = opts.minAvgScore ?? 55;
  const dir = normalizeDir(action);
  const list = Array.isArray(agents) ? agents : [];

  if (!list.length) {
    return {
      passed: false,
      confidence: 0,
      reason: 'No agent swarm available',
      aligned: 0,
      total: 0,
      consensus: 0,
    };
  }

  const alignedAgents = list.filter((a) => normalizeDir(a.direction || a.action) === dir);
  const opposed = list.length - alignedAgents.length;
  const consensus = alignedAgents.length / list.length;
  const avgScore = alignedAgents.length
    ? alignedAgents.reduce((s, a) => s + (Number(a.score) || 0), 0) / alignedAgents.length
    : 0;

  const checks = [];
  if (consensus < minConsensus) checks.push(`consensus ${Math.round(consensus * 100)}% < ${Math.round(minConsensus * 100)}%`);
  if (alignedAgents.length < minAligned) checks.push(`aligned ${alignedAgents.length} < ${minAligned}`);
  if (avgScore < minAvgScore) checks.push(`avg aligned score ${avgScore.toFixed(1)} < ${minAvgScore}`);

  const passed = checks.length === 0;
  const confidence = Math.round(
    Math.min(100, consensus * 50 + Math.min(alignedAgents.length / 8, 1) * 25 + Math.min(avgScore / 100, 1) * 25),
  );

  return {
    passed,
    confidence,
    reason: passed ? 'Swarm rehearsal passed' : checks.join('; '),
    aligned: alignedAgents.length,
    opposed,
    total: list.length,
    consensus: Math.round(consensus * 1000) / 1000,
    avgAlignedScore: Math.round(avgScore * 10) / 10,
    checks,
  };
}

/**
 * Attach rehearsal result onto signal metadata.
 */
function attachRehearsal(signal, result) {
  if (!signal || !result) return signal;
  return {
    ...signal,
    mirofish: {
      passed: result.passed,
      confidence: result.confidence,
      consensus: result.consensus,
      aligned: result.aligned,
      total: result.total,
      reason: result.reason,
    },
    riskFlags: {
      ...(signal.riskFlags || {}),
      swarmRehearsalFailed: !result.passed,
      swarmConfidence: result.confidence,
    },
  };
}

/**
 * Thin bull/bear debate (TradingAgents-inspired, no LLM).
 * Uses existing agent votes only — never invents narrative noise.
 * Soft gate near FIRE: strong opposition → fail (caller may WAIT).
 */
function bullBearDebate(agents, action, opts = {}) {
  const dir = normalizeDir(action);
  const list = Array.isArray(agents) ? agents : [];
  const opp = dir === 'BUY' ? 'SELL' : dir === 'SELL' ? 'BUY' : null;
  if (!opp || !list.length) {
    return { ok: true, lean: dir || 'NEUTRAL', bullScore: 0, bearScore: 0, reason: 'no_debate' };
  }

  let bull = 0;
  let bear = 0;
  let bullN = 0;
  let bearN = 0;
  for (const a of list) {
    const d = normalizeDir(a.direction || a.action);
    const sc = Number(a.score) || 0;
    if (d === 'BUY' || d === 'LONG') { bull += sc; bullN += 1; }
    if (d === 'SELL' || d === 'SHORT') { bear += sc; bearN += 1; }
  }
  const bullAvg = bullN ? bull / bullN : 0;
  const bearAvg = bearN ? bear / bearN : 0;
  const lean = bullAvg >= bearAvg ? 'BUY' : 'SELL';
  const gap = Math.abs(bullAvg - bearAvg);
  const minGap = opts.minGap ?? 8;
  // Conflict: majority lean opposes proposed FIRE with meaningful gap
  const conflicts = lean !== dir && gap >= minGap && (bullN + bearN) >= 3;
  return {
    ok: !conflicts,
    lean,
    bullScore: Math.round(bullAvg * 10) / 10,
    bearScore: Math.round(bearAvg * 10) / 10,
    gap: Math.round(gap * 10) / 10,
    reason: conflicts
      ? `debate conflict: agents lean ${lean} (bull ${bullAvg.toFixed(0)} vs bear ${bearAvg.toFixed(0)})`
      : `debate aligned lean=${lean}`,
  };
}

module.exports = {
  rehearse,
  attachRehearsal,
  bullBearDebate,
  normalizeDir,
};
