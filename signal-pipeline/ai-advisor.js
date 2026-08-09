// An LLM outage should never be able to silently block or corrupt a trading decision.

'use strict';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_TIMEOUT_MS = 9000;
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function round(n, d = 2) {
  return Number.isFinite(+n) ? parseFloat((+n).toFixed(d)) : n;
}

function safeGet(v, fallback = null) {
  return v === undefined ? fallback : v;
}

class AIAdvisor {
  constructor(config = {}) {
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.model = config.model ?? process.env.ANTHROPIC_ADVISOR_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = config.maxTokens ?? 500;
    this.enabled = Boolean(this.apiKey);
    this._callCount = 0;
    this._errorCount = 0;
    this._lastError = null;
  }

  _buildPrompt({ signal, regime, strategyContext, candleContext, compressionContext, abnormalMarket, timeCycleContext, trapContext }) {
    const lines = [];
    lines.push(`Symbol: ${signal.symbol}  Timeframe: ${signal.timeframe}  Direction: ${signal.action}  Current price: ${signal.currentPrice}`);
    lines.push(`Pipeline score: ${safeGet(signal.score?.final)}/100 (grade ${safeGet(signal.score?.grade)})`);
    if (signal.directionAnalysis) {
      lines.push(`Agent consensus: ${safeGet(signal.directionAnalysis.confirmedBy?.length)}/${safeGet(signal.directionAnalysis.agentVotes?.length)} agents agree`);
    }
    if (regime) {
      lines.push(`Regime: ${regime.regime} (trend=${regime.trend}, structure=${regime.structure}, volatility=${regime.volatility}, tradeability=${round(regime.tradeability)}/100)`);
    }
    if (strategyContext) {
      lines.push(`Strategy fit: ${strategyContext.profile}, confidence multiplier applied=${strategyContext.confidenceMultiplier}x — ${strategyContext.note}`);
    }
    if (candleContext) {
      lines.push(`Latest candle: ${candleContext.type}, quality=${round(candleContext.qualityScore)}/100 — ${candleContext.note}`);
    }
    if (compressionContext) {
      lines.push(`Volatility compression: ${compressionContext.isCompressed ? 'YES' : 'no'} (score=${round(compressionContext.compressionScore)}/100, bias=${compressionContext.biasHint})`);
    }
    if (trapContext?.dampen) {
      lines.push(`Trap risk flagged: ${trapContext.reason}`);
    }
    if (abnormalMarket?.abnormal) {
      lines.push(`Abnormal market flag: severity=${abnormalMarket.severity} — ${(abnormalMarket.reasons || []).join('; ')}`);
    }
    if (timeCycleContext && timeCycleContext.bias !== 'UNKNOWN') {
      lines.push(`Historical time-of-day bias for this symbol: ${timeCycleContext.bias} (win rate ${round(timeCycleContext.avgWinRate * 100)}% on ${timeCycleContext.basis?.length || 0} data points)`);
    }

    return lines.join('\n');
  }

  async evaluate(context) {
    const fallback = (reasoning, error) => ({
      recommendation: 'TAKE',
      confidence: null,
      reasoning,
      source: 'fallback',
      ...(error ? { error } : {}),
    });

    if (!this.enabled) {
      return fallback('AI Advisor disabled (no ANTHROPIC_API_KEY set) — deterministic pipeline result stands.');
    }

    const dataSummary = this._buildPrompt(context);
    const systemPrompt =
      'You are a senior discretionary trading analyst reviewing a setup that has already passed a quantitative ' +
      'trading system\'s automated filters. You are NOT deciding whether to place the trade yourself — you are ' +
      'giving a second, qualitative opinion the trader will weigh alongside the system\'s own scoring. Be honest ' +
      'and specific: if the setup genuinely looks clean, say TAKE. If something in the data summary reads as ' +
      'contradictory, overextended, or low-conviction despite passing the filters, say SKIP or REDUCE_SIZE and ' +
      'explain exactly which piece of data drove that call. Do not hedge for the sake of hedging, and do not ' +
      'invent information not present in the summary. Respond with ONLY a JSON object, no other text, no markdown ' +
      'fences, in exactly this shape: ' +
      '{"recommendation": "TAKE" | "SKIP" | "REDUCE_SIZE", "confidence": <integer 0-100>, "reasoning": "<2-3 sentences, plain English>"}';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      this._callCount++;
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: dataSummary }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`Anthropic API ${response.status}: ${bodyText.slice(0, 300)}`);
      }

      const data = await response.json();
      const text = (data.content || [])
        .map(block => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();

      const cleaned = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(cleaned);

      if (!['TAKE', 'SKIP', 'REDUCE_SIZE'].includes(parsed.recommendation)) {
        throw new Error(`Unexpected recommendation value: ${parsed.recommendation}`);
      }

      return {
        recommendation: parsed.recommendation,
        confidence: Number.isFinite(+parsed.confidence) ? Math.max(0, Math.min(100, +parsed.confidence)) : null,
        reasoning: String(parsed.reasoning || '').slice(0, 800),
        source: 'ai',
      };
    } catch (err) {
      this._errorCount++;
      this._lastError = err.message;
      const isTimeout = err.name === 'AbortError';
      return fallback(
        `AI Advisor unavailable (${isTimeout ? 'timed out' : 'error'}) — deterministic pipeline result stands.`,
        err.message,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  stats() {
    return {
      enabled: this.enabled,
      model: this.model,
      callCount: this._callCount,
      errorCount: this._errorCount,
      lastError: this._lastError,
    };
  }
}

module.exports = { AIAdvisor };
