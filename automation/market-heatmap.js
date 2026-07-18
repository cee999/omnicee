/**
 * ============================================================
 *  MARKET HEAT MAP
 *  AI Trading Assistant · Layer 6 · Professional Dashboard
 * ============================================================
 *
 *  Doc item #56: "Visualizes strength and weakness across tracked
 *  markets."
 *
 *  Not a new data source — a compositing layer. You already have two
 *  independent scoreboards:
 *
 *    - OpportunityRanker: "how good is the setup on this symbol right
 *      now" (score, grade, whether it actually fired or got blocked)
 *    - RelativeStrengthEngine: "how is this symbol actually moving
 *      relative to its own typical noise, and relative to everything
 *      else you track"
 *
 *  A symbol can score high on one and be unremarkable on the other —
 *  e.g. a clean A-grade setup on a symbol that's barely moved (patient,
 *  well-formed reversal) vs. a symbol ripping hard with no qualifying
 *  setup yet (momentum building, nothing to act on yet). Collapsing
 *  those into one number would hide that distinction; this keeps both
 *  visible per symbol and buckets them for a grid-style UI.
 *
 *  Usage:
 *    const { MarketHeatMap } = require('./market-heatmap');
 *    const heatmap = new MarketHeatMap();
 *    const grid = heatmap.build({ opportunityRanker, relativeStrength, candleStores, symbols, timeframe });
 * ============================================================
 */

'use strict';

function round(n, d = 1) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : 0;
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

const GRADE_WEIGHT = {
  'A+': 100, A: 92, 'A-': 86, 'B+': 78, B: 70, 'B-': 62, 'C+': 55, C: 45, 'C-': 35, D: 20, F: 5,
};

function bucketOf(score) {
  if (score >= 80) return 'HOT';
  if (score >= 60) return 'WARM';
  if (score >= 40) return 'NEUTRAL';
  if (score >= 20) return 'COOL';
  return 'COLD';
}

class MarketHeatMap {
  constructor(config = {}) {
    // Blend weight between "setup quality right now" (opportunity) and
    // "how the symbol is actually moving" (relative strength). Opportunity
    // gets more weight by default since it's directly actionable; relative
    // strength is more of an early-warning/context signal.
    this.opportunityWeight = config.opportunityWeight ?? 0.65;
    this.relativeStrengthWeight = config.relativeStrengthWeight ?? 0.35;
  }

  /**
   * Normalize a RelativeStrengthEngine volAdjScore (unbounded, roughly
   * -3..+3 in practice for a volatility-adjusted z-like score) onto a
   * 0-100 scale so it can be blended with the opportunity score.
   */
  _normalizeRelStrength(volAdjScore) {
    if (!Number.isFinite(volAdjScore)) return 50;
    // squashes to 0-100, centered at 50, saturating around +/-3
    return round(clamp(50 + (volAdjScore / 3) * 50, 0, 100));
  }

  /**
   * @param {Object} params
   * @param {Object} params.opportunityRanker    - instance with getRanked()
   * @param {Object} [params.relativeStrength]   - instance with rank()
   * @param {Object} [params.candleStores]       - required if relativeStrength is supplied
   * @param {Array}  [params.symbols]            - required if relativeStrength is supplied
   * @param {string} [params.timeframe='H1']
   * @returns {{ tiles: Array, generatedAt: number }}
   */
  build({ opportunityRanker, relativeStrength, candleStores, symbols, timeframe = 'H1' } = {}) {
    if (!opportunityRanker) {
      return { tiles: [], generatedAt: Date.now(), reason: 'no_opportunity_ranker' };
    }

    const opportunities = opportunityRanker.getRanked({ includeStale: true });
    const oppBySymbol = new Map(opportunities.map(o => [o.symbol, o]));

    let relRanked = [];
    if (relativeStrength && candleStores && symbols) {
      try {
        relRanked = relativeStrength.rank(candleStores, symbols, timeframe);
      } catch (_) { /* relative strength optional — degrade gracefully */ }
    }
    const relBySymbol = new Map(relRanked.map(r => [r.symbol, r]));

    // Union of every symbol either engine knows about.
    const allSymbols = new Set([...oppBySymbol.keys(), ...relBySymbol.keys()]);

    const tiles = [];
    for (const symbol of allSymbols) {
      const opp = oppBySymbol.get(symbol);
      const rel = relBySymbol.get(symbol);

      const opportunityScore = opp
        ? round(Math.max(opp.score || 0, GRADE_WEIGHT[opp.grade] ?? 0))
        : null;
      const relStrengthNormalized = rel ? this._normalizeRelStrength(rel.volAdjScore) : null;

      // Blend whatever's available; if only one engine has this symbol,
      // use that one alone rather than penalizing it for missing data.
      let heatScore;
      if (opportunityScore != null && relStrengthNormalized != null) {
        heatScore = round(opportunityScore * this.opportunityWeight + relStrengthNormalized * this.relativeStrengthWeight);
      } else if (opportunityScore != null) {
        heatScore = opportunityScore;
      } else if (relStrengthNormalized != null) {
        heatScore = relStrengthNormalized;
      } else {
        heatScore = 0;
      }

      tiles.push({
        symbol,
        heatScore,
        bucket: bucketOf(heatScore),
        bias: opp?.action || (rel && rel.changePct > 0 ? 'LONG_LEANING' : rel ? 'SHORT_LEANING' : 'UNKNOWN'),
        opportunity: opp ? {
          score: round(opp.score),
          grade: opp.grade,
          fired: opp.fired,
          blockedReason: opp.blockedReason,
          ageMinutes: round(opp.timestamp ? (Date.now() - opp.timestamp) / 60000 : null),
        } : null,
        relativeStrength: rel ? {
          rank: rel.rank,
          changePct: round(rel.changePct, 3),
          volAdjScore: round(rel.volAdjScore, 2),
        } : null,
      });
    }

    tiles.sort((a, b) => b.heatScore - a.heatScore);
    tiles.forEach((t, i) => { t.overallRank = i + 1; });

    return { tiles, generatedAt: Date.now() };
  }
}

module.exports = { MarketHeatMap };
