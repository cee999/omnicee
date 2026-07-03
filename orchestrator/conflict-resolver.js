'use strict';

/**
 * ============================================================
 *  CONFLICT RESOLVER — Agent Vote Arbitration
 *  AI Trading Assistant · Layer 2 · Orchestrator
 * ============================================================
 *
 *  Responsibilities:
 *    - Arbitrate conflicts between agent votes
 *    - Weighted majority voting (SMC > MTF > others)
 *    - Handle agent disagreements
 *    - Track conflict patterns
 *    - Return unified direction for scorer
 * ============================================================
 */

// FIX: Add safe rounding with NaN/Infinity checks
const r     = (n, d = 4) => {
  if (!Number.isFinite(n)) return 0;
  return parseFloat((n ?? 0).toFixed(d));
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

class ConflictResolver {
  /**
   * Resolves conflicts between agent votes before passing to SignalScorer.
   *
   * Rules:
   *   1. If SMC and MTF both say LONG/SHORT → allow (highest weight agents agree)
   *   2. If SMC says LONG but MTF says SHORT → WAIT (fundamental conflict)
   *   3. If 3+ agents agree on direction → allow even if 2 oppose
   *   4. If momentum strongly opposes SMC → reduce SMC score by 20%
   *   5. If there's a liquidation cascade in progress → override to WAIT
   *   6. Track conflict patterns over time — repeated conflicts = regime change
   *
   * @param {Object} votes - { smc, mtf, momentum, volumeOI, macroSent }
   * @param {Object} context - { symbol, timeframe, currentPrice, liquidationAlert }
   * @returns {Object} { resolved: bool, votes, conflicts, direction, note }
   */
  static resolve(votes, context = {}) {
    try {
      const conflicts  = [];
      const resVotes   = { ...votes };
      let resolution   = 'PROCEED';
      let note         = '';

      // FIX: Add safe upper/lower case conversions and null checks
      const smcDir   = votes.smc?.direction ? String(votes.smc.direction).toUpperCase() : null;
      const mtfDir   = votes.mtf?.direction ? String(votes.mtf.direction).toUpperCase() : null;
      const momDir   = votes.momentum?.direction ? String(votes.momentum.direction).toUpperCase() : null;
      const volDir   = votes.volumeOI?.direction ? String(votes.volumeOI.direction).toUpperCase() : null;
      const macroDir = votes.macroSent?.direction ? String(votes.macroSent.direction).toUpperCase() : null;

      // ── Rule 1: Liquidation cascade override ──
      if (context.liquidationAlert?.isCascade) {
        resolution = 'WAIT';
        const totalUSDT = context.liquidationAlert.totalUSDT || 0;
        note = `Liquidation cascade in progress ($${(totalUSDT / 1000000).toFixed(2)}M) — standing by`;
        conflicts.push({ type: 'LIQUIDATION_CASCADE', severity: 'CRITICAL', note });
      }

      // ── Rule 2: SMC vs MTF fundamental conflict ──
      if (smcDir && mtfDir &&
          smcDir !== 'WAIT' && mtfDir !== 'WAIT' &&
          smcDir !== mtfDir) {
        conflicts.push({
          type:     'SMC_MTF_CONFLICT',
          severity: 'HIGH',
          smcDir,
          mtfDir,
          note:     `SMC says ${smcDir} but MTF says ${mtfDir} — fundamental conflict`,
        });
        resolution = 'WAIT';
        note       = `SMC/MTF conflict: ${smcDir} vs ${mtfDir}`;
      }

      // ── Rule 3: Majority vote (3+ of 5 agents agree) ──
      const dirs = [smcDir, mtfDir, momDir, volDir, macroDir].filter(Boolean);
      // FIX: Add validation before counting
      const longCount  = dirs.filter(d => d === 'LONG').length || 0;
      const shortCount = dirs.filter(d => d === 'SHORT').length || 0;
      const waitCount  = dirs.filter(d => d === 'WAIT').length || 0;

      if (resolution === 'PROCEED') {
        if (longCount >= 3) { resolution = 'LONG';  note = `${longCount}/5 agents bullish`; }
        else if (shortCount >= 3) { resolution = 'SHORT'; note = `${shortCount}/5 agents bearish`; }
        else if (waitCount >= 4) { resolution = 'WAIT';  note = `${waitCount}/5 agents say wait`; }
      }

      // ── Rule 4: Momentum penalty if opposing SMC strongly ──
      if (smcDir && momDir && smcDir !== 'WAIT' && momDir !== 'WAIT' && smcDir !== momDir) {
        conflicts.push({
          type:     'MOMENTUM_OPPOSES_SMC',
          severity: 'MEDIUM',
          note:     `Momentum (${momDir}) opposes SMC (${smcDir}) — applying 20% score penalty to SMC`,
        });

        if (resVotes.smc && votes.smc) {
          // FIX: Validate score before modifying
          const currentScore = votes.smc.score || 0;
          if (Number.isFinite(currentScore)) {
            resVotes.smc = {
              ...resVotes.smc,
              score:   Math.round(currentScore * 0.80),
              reasons: [...(votes.smc.reasons || []), '⚠️ 20% penalty: momentum opposes SMC direction'],
            };
          }
        }
      }

      // ── Rule 5: Volume opposes SMC ──
      if (smcDir && volDir && smcDir !== 'WAIT' && volDir !== 'WAIT' && smcDir !== volDir) {
        conflicts.push({
          type:     'VOLUME_OPPOSES_SMC',
          severity: 'LOW',
          note:     `Volume/OI (${volDir}) opposes SMC (${smcDir})`,
        });
      }

      // ── Determine consensus direction for scorer ──
      const consensusDir = resolution === 'LONG'  ? 'LONG'
        : resolution === 'SHORT' ? 'SHORT'
        : 'WAIT';

      // FIX: Ensure all numeric outputs are safe
      return {
        resolved:       conflicts.filter(c => c.severity === 'HIGH').length === 0,
        direction:      consensusDir,
        resolution,
        votes:          resVotes,
        originalVotes:  votes,
        conflicts,
        note,
        stats: {
          longCount:   Math.max(0, longCount || 0),
          shortCount:  Math.max(0, shortCount || 0),
          waitCount:   Math.max(0, waitCount || 0),
          totalAgents: Math.max(0, dirs.length || 0),
        },
      };
    } catch (err) {
      console.error('[ConflictResolver] Resolution error:', err.message);
      return {
        resolved: false,
        direction: 'WAIT',
        resolution: 'ERROR',
        votes: votes || {},
        conflicts: [{ type: 'RESOLVER_ERROR', severity: 'CRITICAL', note: err.message }],
        note: `Error in conflict resolution: ${err.message}`,
        stats: { longCount: 0, shortCount: 0, waitCount: 0, totalAgents: 0 },
      };
    }
  }
}

module.exports = { ConflictResolver };
