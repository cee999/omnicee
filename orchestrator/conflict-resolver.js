'use strict';

// FIX: Add safe rounding with NaN/Infinity checks
const r     = (n, d = 4) => {
  if (!Number.isFinite(n)) return 0;
  return parseFloat((n ?? 0).toFixed(d));
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

class ConflictResolver {
  // note }
  resolve(votes, context = {}) {
    return ConflictResolver.resolve(votes, context);
  }

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
      const microDir = votes.microstructure?.direction ? String(votes.microstructure.direction).toUpperCase() : null;
      const fractalDir = votes.fractal?.direction ? String(votes.fractal.direction).toUpperCase() : null;
      const patternDir = votes.pattern?.direction ? String(votes.pattern.direction).toUpperCase() : null;

      if (context.liquidationAlert?.isCascade) {
        resolution = 'WAIT';
        const totalUSDT = context.liquidationAlert.totalUSDT || 0;
        note = `Liquidation cascade in progress ($${(totalUSDT / 1000000).toFixed(2)}M) — standing by`;
        conflicts.push({ type: 'LIQUIDATION_CASCADE', severity: 'CRITICAL', note });
      }

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

      const dirs = [smcDir, mtfDir, momDir, volDir, macroDir, microDir, fractalDir, patternDir].filter(Boolean);
      const longCount  = dirs.filter(d => d === 'LONG').length || 0;
      const shortCount = dirs.filter(d => d === 'SHORT').length || 0;
      const waitCount  = dirs.filter(d => d === 'WAIT').length || 0;
      const n = dirs.length || 1;

      if (resolution === 'PROCEED') {
        if (longCount >= 4) { resolution = 'LONG';  note = `${longCount}/${n} agents bullish`; }
        else if (shortCount >= 4) { resolution = 'SHORT'; note = `${shortCount}/${n} agents bearish`; }
        else if (waitCount >= 5) { resolution = 'WAIT';  note = `${waitCount}/${n} agents say wait`; }
      }

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

      if (smcDir && microDir && smcDir !== 'WAIT' && microDir !== 'WAIT' && smcDir !== microDir) {
        conflicts.push({
          // FIX: was severity 'HIGH', same tier as the two conflicts above
          // that explicitly set resolution = 'WAIT' to intentionally block
          // the signal. This block never sets resolution — its own intent,
          // right there in the note and the 30%-penalty three lines below,
          // is "dock the score and continue," matching MOMENTUM_OPPOSES_SMC
          // right above it (tagged MEDIUM). But `resolved` below filters on
          // severity === 'HIGH' alone, with no resolution check — so this
          // hard-blocked the signal anyway, unconditionally, every time
          // order flow disagreed with SMC. The penalty this block computes
          // a few lines down (score * 0.70) could never take effect: the
          // signal never reached the scorer to use it. Retagged to match
          // its actual, already-coded intent — a penalty, not a block.
          type:     'MICROSTRUCTURE_OPPOSES_SMC',
          severity: 'MEDIUM',
          note:     `Order flow (${microDir}) opposes SMC (${smcDir}) — adverse selection risk`,
        });
        if (resVotes.smc && votes.smc) {
          const currentScore = votes.smc.score || 0;
          if (Number.isFinite(currentScore)) {
            resVotes.smc = {
              ...resVotes.smc,
              score:   Math.round(currentScore * 0.70),
              reasons: [...(votes.smc.reasons || []), '⚠️ 30% penalty: microstructure opposes SMC'],
            };
          }
        }
      }

      if (smcDir && volDir && smcDir !== 'WAIT' && volDir !== 'WAIT' && smcDir !== volDir) {
        conflicts.push({
          type:     'VOLUME_OPPOSES_SMC',
          severity: 'LOW',
          note:     `Volume/OI (${volDir}) opposes SMC (${smcDir})`,
        });
      }

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
