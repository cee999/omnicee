/**
 * ============================================================
 *  SIGNAL EXPLAINER — Explainable AI (Free, No LLM)
 *  AI Trading Assistant · Layer 6 · Explainability
 * ============================================================
 *
 *  Doc item #3: "Every signal comes with a breakdown of the key
 *  factors that increased or decreased confidence."
 *
 *  This is deliberately NOT the AI Advisor (ai-advisor.js). It costs
 *  nothing, needs no API key, has zero network dependency, and never
 *  fails or times out — it's pure template-driven natural-language
 *  generation over data the pipeline has already computed. If you
 *  can't or don't want to pay for the LLM-based advisor, this is the
 *  free layer that actually answers "why did I get this signal, and
 *  what should I be paying attention to."
 *
 *  It reads the same context every other layer already produced —
 *  agent breakdown, regime, strategy fit, candle quality, trap /
 *  compression / abnormal-market flags, time-of-day bias — and turns
 *  it into:
 *
 *    - a short plain-English summary paragraph
 *    - a list of factors that SUPPORTED the signal
 *    - a list of factors that ADD CAUTION (even on a signal that still
 *      fired — e.g. "confirmed by 4/6 agents, but the candle itself is
 *      low-conviction and volatility is compressed")
 *    - an overall confidence label derived from how one-sided that
 *      split is (not a new number pulled from nowhere — literally a
 *      count of how many of the checks above lean each way)
 *
 *  Usage:
 *    const { SignalExplainer } = require('./signal-explainer');
 *    const explainer = new SignalExplainer();
 *    const explanation = explainer.explain({ signal, regime, strategyContext, ... });
 * ============================================================
 */

'use strict';

function round(n, d = 1) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : n;
}

class SignalExplainer {
  /**
   * @param {Object} params - the same context object every other advisory
   *   layer in the pipeline consumes (all fields optional — the explainer
   *   degrades gracefully and just explains what it's given).
   * @param {Object} params.signal              - scored signal (symbol, action, score, agentBreakdown, directionAnalysis)
   * @param {Object} [params.regime]
   * @param {Object} [params.strategyContext]
   * @param {Object} [params.candleContext]
   * @param {Object} [params.compressionContext]
   * @param {Object} [params.abnormalMarket]
   * @param {Object} [params.trapContext]
   * @param {Object} [params.timeCycleContext]
   * @returns {{summary: string, supports: Array, cautions: Array, confidenceLabel: string}}
   */
  explain({ signal, regime, strategyContext, candleContext, compressionContext, abnormalMarket, trapContext, timeCycleContext } = {}) {
    const supports = [];
    const cautions = [];

    // ── Agent consensus ──
    if (signal?.directionAnalysis) {
      const confirmed = signal.directionAnalysis.confirmedBy?.length ?? 0;
      const total = signal.directionAnalysis.agentVotes?.length ?? 0;
      if (total > 0) {
        const ratio = confirmed / total;
        if (ratio >= 0.66) {
          supports.push(`${confirmed} of ${total} analysis agents agree on ${signal.action} — strong cross-confirmation.`);
        } else if (ratio <= 0.4) {
          cautions.push(`Only ${confirmed} of ${total} agents actually agree on ${signal.action} — the setup fired mainly on a smaller subset carrying enough weight.`);
        }
      }
    }

    // ── Top individual agent reasons (highest-weight agent that agrees) ──
    if (Array.isArray(signal?.agentBreakdown) && signal.agentBreakdown.length) {
      const agreeing = signal.agentBreakdown
        .filter(a => a.direction === signal.action)
        .sort((a, b) => (b.weight || 0) - (a.weight || 0));
      const disagreeing = signal.agentBreakdown.filter(a => a.direction && a.direction !== signal.action && a.direction !== 'WAIT');

      if (agreeing[0]?.topReasons?.length) {
        supports.push(`${agreeing[0].agent}: ${agreeing[0].topReasons[0]}`);
      }
      if (disagreeing.length) {
        const strongestDissent = disagreeing.sort((a, b) => (b.weight || 0) - (a.weight || 0))[0];
        cautions.push(`${strongestDissent.agent} actually reads ${strongestDissent.direction}${strongestDissent.topReasons?.[0] ? ` (${strongestDissent.topReasons[0]})` : ''} — a real dissent, not just a neutral vote.`);
      }
    }

    // ── Regime / strategy fit ──
    if (regime && strategyContext) {
      if (strategyContext.confidenceMultiplier > 1.02) {
        supports.push(`Fits the current ${regime.structure} regime well (${strategyContext.profile}) — ${strategyContext.note}`);
      } else if (strategyContext.confidenceMultiplier < 0.95) {
        cautions.push(`Current regime is ${regime.structure}/${regime.volatility} — ${strategyContext.note}`);
      }
    }

    // ── Candle quality ──
    if (candleContext) {
      if (candleContext.qualityScore >= 70) {
        supports.push(`Latest candle is a well-formed ${candleContext.type} (quality ${round(candleContext.qualityScore)}/100) — ${candleContext.note}`);
      } else if (candleContext.qualityScore < 40) {
        cautions.push(`Latest candle itself is low-conviction (${candleContext.type}, quality ${round(candleContext.qualityScore)}/100) — the signal is firing on structure/indicators more than on the immediate price action.`);
      }
    }

    // ── Compression / volatility ──
    if (compressionContext?.isCompressed) {
      cautions.push(`Volatility is compressed (score ${round(compressionContext.compressionScore)}/100) — expansion risk is elevated and the eventual move could go either direction.`);
    }

    // ── Trap risk ──
    if (trapContext?.dampen) {
      cautions.push(`Trap risk flagged at a nearby level — ${trapContext.reason}`);
    }

    // ── Abnormal market ──
    if (abnormalMarket?.abnormal) {
      cautions.push(`Abnormal market conditions detected (severity: ${abnormalMarket.severity}) — ${(abnormalMarket.reasons || []).join('; ') || 'unusual price/volume behavior vs recent history'}.`);
    }

    // ── Time-of-day / day-of-week bias ──
    if (timeCycleContext && timeCycleContext.bias && timeCycleContext.bias !== 'UNKNOWN') {
      const aligns = (timeCycleContext.bias === 'FAVORABLE_LONG' && signal?.action === 'LONG') ||
                     (timeCycleContext.bias === 'FAVORABLE_SHORT' && signal?.action === 'SHORT');
      if (aligns) {
        supports.push(`This symbol has historically favored ${signal.action} moves around this time (${round(timeCycleContext.avgWinRate * 100)}% win rate over ${timeCycleContext.basis?.reduce((s, r) => s + r.sampleSize, 0) || 'a sample of'} past observations).`);
      } else if (timeCycleContext.bias !== 'NEUTRAL') {
        cautions.push(`This symbol's historical time-of-day pattern actually leans the other way from this signal — worth noting, though it's descriptive history, not a hard rule.`);
      }
    }

    // ── Confidence label: purely a tally of the above, not a new invented number ──
    const supportCount = supports.length;
    const cautionCount = cautions.length;
    let confidenceLabel;
    if (supportCount === 0 && cautionCount === 0) confidenceLabel = 'STANDARD';
    else if (cautionCount === 0) confidenceLabel = 'WELL_SUPPORTED';
    else if (supportCount >= cautionCount * 2) confidenceLabel = 'SUPPORTED_WITH_MINOR_CAUTION';
    else if (supportCount > cautionCount) confidenceLabel = 'MIXED_LEANING_SUPPORTIVE';
    else confidenceLabel = 'MIXED_LEANING_CAUTIOUS';

    // ── Summary paragraph ──
    const scoreLine = signal?.score?.final != null
      ? `${signal.symbol} ${signal.action} scored ${round(signal.score.final)}/100 (grade ${signal.score.grade || 'n/a'}).`
      : `${signal?.symbol || 'This symbol'} ${signal?.action || ''} signal.`;

    let summary = scoreLine;
    if (supports.length) {
      const s = supports[0].trim();
      summary += ` ${s}${/[.!?]$/.test(s) ? '' : '.'}`;
    }
    if (cautions.length) {
      const c = cautions[0].trim();
      summary += ` However: ${c}${/[.!?]$/.test(c) ? '' : '.'}`;
    }
    if (cautions.length > 1) summary += ` (${cautions.length - 1} more caution${cautions.length - 1 === 1 ? '' : 's'} below.)`;

    return {
      summary,
      supports,
      cautions,
      confidenceLabel,
    };
  }
}

module.exports = { SignalExplainer };
