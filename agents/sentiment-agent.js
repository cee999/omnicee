
'use strict';

const EventEmitter = require('events');
const https        = require('https');

const BULLISH_KEYWORDS = {
  'breakout':         3, 'surge':            3, 'rally':            3,
  'soar':             3, 'skyrocket':        3, 'moon':             3,
  'explosion':        3, 'parabolic':        3, 'ath':              3,
  'all-time high':    3, 'record high':      3, 'institutional buy': 3,
  'etf approval':     3, 'sec approved':     3, 'adoption':         3,
  'accumulation':     3, 'whale buy':        3, 'bitcoin reserve':  3,
  'rate cut':         3, 'pivot':            3, 'stimulus':         3,

  'bullish':          2, 'buy':              2, 'long':             2,
  'uptrend':          2, 'recovery':         2, 'rebound':          2,
  'bounce':           2, 'support':          2, 'demand':           2,
  'upgrade':          2, 'outperform':       2, 'overweight':       2,
  'positive':         2, 'growth':           2, 'gains':            2,
  'inflow':           2, 'investment':       2, 'partnership':      2,
  'integration':      2, 'launch':           2, 'approval':         2,
  'higher':           2, 'increase':         2, 'rise':             2,

  'optimistic':       1, 'confident':        1, 'stable':           1,
  'steady':           1, 'potential':        1, 'opportunity':      1,
  'interest':         1, 'consideration':    1, 'exploring':        1,
};

const BEARISH_KEYWORDS = {
  'crash':            3, 'collapse':         3, 'plunge':           3,
  'dump':             3, 'tank':             3, 'sell-off':         3,
  'selloff':          3, 'liquidation':      3, 'bankruptcy':       3,
  'hack':             3, 'exploit':          3, 'rug pull':         3,
  'ban':              3, 'crackdown':        3, 'sanction':         3,
  'sec lawsuit':      3, 'fraud':            3, 'ponzi':            3,
  'rate hike':        3, 'tightening':       3, 'recession':        3,
  'contagion':        3, 'insolvency':       3, 'default':          3,

  'bearish':          2, 'sell':             2, 'short':            2,
  'downtrend':        2, 'decline':          2, 'fall':             2,
  'drop':             2, 'loss':             2, 'risk':             2,
  'warning':          2, 'concern':          2, 'uncertainty':      2,
  'regulation':       2, 'investigation':    2, 'probe':            2,
  'outflow':          2, 'withdrawal':       2, 'redemption':       2,
  'downgrade':        2, 'underperform':     2, 'underweight':      2,
  'lower':            2, 'decrease':         2, 'weak':             2,

  'cautious':         1, 'worried':          1, 'volatile':         1,
  'pressure':         1, 'headwind':         1, 'challenge':        1,
  'delay':            1, 'rejected':         1, 'disappointing':    1,
};

const NEGATION_WORDS = ['not', 'no', 'never', 'neither', 'nor', 'barely',
                        "don't", "doesn't", "didn't", "won't", "wouldn't",
                        "can't", "cannot", "isn't", "aren't", "wasn't"];

const INTENSIFIERS = {
  'extremely':   1.5, 'massively':  1.5, 'hugely':      1.5,
  'incredibly':  1.5, 'strongly':   1.3, 'significantly': 1.3,
  'heavily':     1.3, 'sharply':    1.3, 'dramatically': 1.3,
  'slightly':    0.5, 'somewhat':   0.6, 'mildly':       0.6,
  'modestly':    0.7, 'gradually':  0.7, 'partially':    0.7,
};

const MARKET_ENTITIES = {
  BULLISH_ENTITIES: [
    'fed pivot', 'rate cut', 'quantitative easing', 'qe', 'stimulus',
    'bitcoin etf', 'spot etf', 'institutional adoption', 'sec approved',
    'bitcoin reserve', 'strategic reserve', 'blackrock', 'fidelity',
    'grayscale approved', 'coinbase institutional', 'microstrategy',
    'el salvador', 'legal tender', 'central bank buy',
  ],
  BEARISH_ENTITIES: [
    'sec lawsuit', 'doj investigation', 'cftc action', 'bank ban',
    'china ban', 'india ban', 'crypto ban', 'defi ban',
    'exchange hack', 'bridge exploit', 'rug pull', 'ftx',
    'three arrows', 'celsius', 'terra luna', 'contagion',
    'quantitative tightening', 'qt', 'rate hike', 'inflation surge',
  ],
};

const MACRO_EVENTS = {
  'FOMC':          { impact: 'HIGH',   bullBias: -0.2 },
  'CPI':           { impact: 'HIGH',   bullBias: -0.1 },
  'NFP':           { impact: 'HIGH',   bullBias:  0.0 },
  'GDP':           { impact: 'MEDIUM', bullBias:  0.1 },
  'PCE':           { impact: 'HIGH',   bullBias: -0.1 },
  'PPI':           { impact: 'MEDIUM', bullBias: -0.1 },
  'RETAIL_SALES':  { impact: 'MEDIUM', bullBias:  0.1 },
  'UNEMPLOYMENT':  { impact: 'MEDIUM', bullBias:  0.0 },
  'ISM':           { impact: 'MEDIUM', bullBias:  0.0 },
  'BOJ':           { impact: 'MEDIUM', bullBias:  0.1 },
  'ECB':           { impact: 'MEDIUM', bullBias:  0.0 },
  'HALVING':       { impact: 'HIGH',   bullBias:  0.8 },
  'ETF_DECISION':  { impact: 'HIGH',   bullBias:  0.5 },
};

const SOURCE_WEIGHTS = {
  'reuters':          1.0,
  'bloomberg':        1.0,
  'wsj':              1.0,
  'ft':               1.0,
  'coindesk':         0.85,
  'cointelegraph':    0.80,
  'decrypt':          0.80,
  'theblock':         0.85,
  'cryptoslate':      0.75,
  'twitter':          0.50,
  'reddit':           0.40,
  'telegram':         0.35,
  'unknown':          0.50,
};

function _round(n, d = 4) { return parseFloat((+n).toFixed(d)); }
function _clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function _now() { return Date.now(); }

class NLPAnalyzer {
  static analyze(text, source = 'unknown') {
    if (!text || typeof text !== 'string') return { score: 0, confidence: 0, signals: [] };

    const lower   = text.toLowerCase();
    const words   = lower.split(/\s+/);
    const signals = [];

    let bullScore = 0;
    let bearScore = 0;
    let wordCount = 0;

    for (const entity of MARKET_ENTITIES.BULLISH_ENTITIES) {
      if (lower.includes(entity)) {
        const weight = entity.split(' ').length > 1 ? 4 : 3;
        bullScore += weight;
        signals.push({ type: 'ENTITY_BULL', text: entity, weight });
      }
    }
    for (const entity of MARKET_ENTITIES.BEARISH_ENTITIES) {
      if (lower.includes(entity)) {
        const weight = entity.split(' ').length > 1 ? 4 : 3;
        bearScore += weight;
        signals.push({ type: 'ENTITY_BEAR', text: entity, weight });
      }
    }

    for (let i = 0; i < words.length; i++) {
      const word = words[i].replace(/[^a-z'-]/g, '');
      wordCount++;

      const phrase2 = i < words.length - 1 ? `${word} ${words[i+1].replace(/[^a-z'-]/g, '')}` : '';
      const phrase3 = i < words.length - 2 ? `${word} ${words[i+1].replace(/[^a-z'-]/g, '')} ${words[i+2].replace(/[^a-z'-]/g, '')}` : '';

      const negated = words.slice(Math.max(0, i-2), i).some(w => NEGATION_WORDS.includes(w));

      const intensifier = Object.entries(INTENSIFIERS).find(([k]) =>
        words.slice(Math.max(0, i-2), i).includes(k)
      );
      const intensity = intensifier ? intensifier[1] : 1.0;

      const candidates = [phrase3, phrase2, word].filter(Boolean);
      for (const candidate of candidates) {
        if (BULLISH_KEYWORDS[candidate]) {
          const baseWeight = BULLISH_KEYWORDS[candidate];
          const adjusted   = baseWeight * intensity;
          if (negated) {
            bearScore += adjusted * 0.7;
            signals.push({ type: 'NEG_BULL', text: candidate, weight: -adjusted });
          } else {
            bullScore += adjusted;
            signals.push({ type: 'BULL', text: candidate, weight: adjusted });
          }
          break;
        }
        if (BEARISH_KEYWORDS[candidate]) {
          const baseWeight = BEARISH_KEYWORDS[candidate];
          const adjusted   = baseWeight * intensity;
          if (negated) {
            bullScore += adjusted * 0.7;
            signals.push({ type: 'NEG_BEAR', text: candidate, weight: adjusted });
          } else {
            bearScore += adjusted;
            signals.push({ type: 'BEAR', text: candidate, weight: -adjusted });
          }
          break;
        }
      }
    }

    const credibility = SOURCE_WEIGHTS[source] || SOURCE_WEIGHTS['unknown'];
    bullScore *= credibility;
    bearScore *= credibility;

    const total = bullScore + bearScore;
    const rawScore = total > 0 ? ((bullScore - bearScore) / total) * 100 : 0;
    const score    = _round(_clamp(rawScore, -100, 100), 2);

    const density    = Math.min(signals.length / Math.max(wordCount / 20, 1), 1);
    const strength   = Math.abs(score) / 100;
    const confidence = _round((density * 0.4 + strength * 0.6) * 100, 1);

    return { score, confidence, signals: signals.slice(0, 10), bullScore: _round(bullScore, 2), bearScore: _round(bearScore, 2) };
  }

  static aggregateArticles(articles) {
    if (!articles || articles.length === 0) return { score: 0, confidence: 0, count: 0 };

    const now      = _now();
    const maxAge   = 24 * 60 * 60 * 1000;

    let weightedSum = 0;
    let totalWeight = 0;
    let validCount  = 0;
    const scoreList = [];

    for (const article of articles) {
      // FIX: article.publishedAt arrives as an ISO string (from NewsAPI.org and from the synthetic fallback), but `now - article.publishedAt` is a numeric subtraction — it silently produced NaN for every...
      const publishedAtMs = typeof article.publishedAt === 'number'
        ? article.publishedAt
        : (Date.parse(article.publishedAt) || now);
      const age       = now - publishedAtMs;
      if (age > maxAge) continue;

      const recency   = Math.max(0, 1 - age / maxAge);
      const analysis  = NLPAnalyzer.analyze(
        `${article.title || ''} ${article.description || ''} ${article.content || ''}`,
        article.source?.name?.toLowerCase() || 'unknown'
      );

      const credibility = SOURCE_WEIGHTS[article.source?.name?.toLowerCase()] || 0.5;
      const weight      = recency * credibility * (analysis.confidence / 100);

      weightedSum  += analysis.score * weight;
      totalWeight  += weight;
      validCount++;
      scoreList.push({ score: analysis.score, weight, source: article.source?.name, title: article.title?.slice(0, 80) });
    }

    if (totalWeight === 0) return { score: 0, confidence: 0, count: 0 };

    const aggregatedScore = _round(weightedSum / totalWeight, 2);
    const variance = scoreList.reduce((s, a) => s + Math.pow(a.score - aggregatedScore, 2) * a.weight, 0) / totalWeight;
    const stdDev   = Math.sqrt(variance);
    const confidence = _round(Math.max(0, 100 - stdDev) * (validCount / Math.max(validCount + 2, 5)), 1);

    return {
      score:      aggregatedScore,
      confidence,
      count:      validCount,
      stdDev:     _round(stdDev, 2),
      articles:   scoreList.slice(0, 5),
    };
  }
}

class COTAnalyzer {
  static analyze(cotData) {
    if (!cotData) return null;

    const { commercials, largeSpec, smallSpec, openInterest } = cotData;

    const commNet    = (commercials?.long || 0) - (commercials?.short || 0);
    const largeNet   = (largeSpec?.long || 0)   - (largeSpec?.short || 0);
    const smallNet   = (smallSpec?.long || 0)   - (smallSpec?.short || 0);

    const commPct    = openInterest > 0 ? _round((commNet / openInterest) * 100, 2) : 0;
    const largePct   = openInterest > 0 ? _round((largeNet / openInterest) * 100, 2) : 0;
    const smallPct   = openInterest > 0 ? _round((smallNet / openInterest) * 100, 2) : 0;

    const commExtremeBull = commPct > 20;
    const commExtremeBear = commPct < -20;

    const largeSPecExtBull = largePct > 25;
    const largeSpecExtBear = largePct < -25;

    const retailExtremeBull = smallPct > 15;
    const retailExtremeBear = smallPct < -15;

    let bullPts = 0, bearPts = 0;
    const signals = [];

    if (commExtremeBull)    { bullPts += 3; signals.push('Commercial net LONG extreme — smart money bullish'); }
    if (commExtremeBear)    { bearPts += 3; signals.push('Commercial net SHORT extreme — smart money bearish'); }
    if (!largeSPecExtBull)  { bullPts += 1; signals.push('Large specs not over-crowded long — room to run'); }
    if (!largeSpecExtBear)  { bearPts += 1; }
    if (largeSPecExtBull)   { bearPts += 2; signals.push('Large specs crowded long — contrarian bearish'); }
    if (largeSpecExtBear)   { bullPts += 2; signals.push('Large specs crowded short — short squeeze potential'); }
    if (retailExtremeBull)  { bearPts += 1; signals.push('Retail extreme long — contrarian warning'); }
    if (retailExtremeBear)  { bullPts += 1; signals.push('Retail extreme short — potential squeeze'); }

    const direction = bullPts > bearPts + 1 ? 'LONG'
                    : bearPts > bullPts + 1 ? 'SHORT'
                    : 'NEUTRAL';
    const score     = _round(Math.abs(bullPts - bearPts) / 7 * 100, 1);

    return {
      direction, score, signals,
      commercials: { net: commNet, pct: commPct, extreme: commExtremeBull || commExtremeBear },
      largeSpec:   { net: largeNet, pct: largePct, crowded: largeSPecExtBull || largeSpecExtBear },
      smallSpec:   { net: smallNet, pct: smallPct },
      openInterest,
    };
  }

  static cotIndex(historicalNet, currentNet, period = 52) {
    if (!historicalNet || historicalNet.length < 10) return 50;
    const window  = historicalNet.slice(-period);
    const min     = Math.min(...window);
    const max     = Math.max(...window);
    if (max === min) return 50;
    return _round(((currentNet - min) / (max - min)) * 100, 1);
  }
}

class FearGreedAnalyzer {
  static analyze(value, previousValue = null) {
    if (value == null) return null;

    const zone = value <= 25  ? 'EXTREME_FEAR'
               : value <= 45  ? 'FEAR'
               : value <= 55  ? 'NEUTRAL'
               : value <= 75  ? 'GREED'
               : 'EXTREME_GREED';

    let direction = 'NEUTRAL';
    let score     = 50;
    const signals = [];

    if (value <= 15) {
      direction = 'LONG';
      score     = 90;
      signals.push(`Extreme Fear (${value}) — historically excellent buy zone`);
    } else if (value <= 25) {
      direction = 'LONG';
      score     = 75;
      signals.push(`Fear (${value}) — market oversold sentiment`);
    } else if (value <= 40) {
      direction = 'LONG';
      score     = 60;
      signals.push(`Fear zone (${value}) — cautious bullish`);
    } else if (value >= 85) {
      direction = 'SHORT';
      score     = 90;
      signals.push(`Extreme Greed (${value}) — historically dangerous long zone`);
    } else if (value >= 75) {
      direction = 'SHORT';
      score     = 75;
      signals.push(`Greed (${value}) — market overheated sentiment`);
    } else if (value >= 60) {
      direction = 'SHORT';
      score     = 60;
      signals.push(`Greed zone (${value}) — cautious bearish`);
    } else {
      score = 40;
      signals.push(`Neutral zone (${value}) — no strong sentiment signal`);
    }

    let momentum = 'STABLE';
    if (previousValue != null) {
      const delta = value - previousValue;
      if (delta > 10)       { momentum = 'RISING_FAST';  }
      else if (delta > 5)   { momentum = 'RISING'; }
      else if (delta < -10) { momentum = 'FALLING_FAST'; }
      else if (delta < -5)  { momentum = 'FALLING'; }

      if (value <= 25 && delta > 5) {
        signals.push(`Fear rising — despair increasing, stronger buy signal`);
        score = Math.min(100, score + 10);
      }
      if (value >= 75 && delta < -5) {
        signals.push(`Greed falling — euphoria waning, stronger sell signal`);
        score = Math.min(100, score + 10);
      }
    }

    return { value, zone, direction, score, signals, momentum, previous: previousValue };
  }
}

class LongShortRatioAnalyzer {
  static analyze(ratio, symbol = '') {
    if (!ratio) return null;

    const longPct  = _round(ratio / (1 + ratio) * 100, 1);
    const shortPct = _round(100 - longPct, 1);

    let direction = 'NEUTRAL';
    let score     = 0;
    const signals = [];

    if (ratio >= 2.0) {
      direction = 'SHORT';
      score     = 80;
      signals.push(`${longPct}% longs — extreme crowding → contrarian SHORT`);
    } else if (ratio >= 1.5) {
      direction = 'SHORT';
      score     = 60;
      signals.push(`${longPct}% longs — crowded long → mild contrarian bear`);
    }
    else if (ratio <= 0.5) {
      direction = 'LONG';
      score     = 80;
      signals.push(`${shortPct}% shorts — extreme crowding → contrarian LONG / squeeze setup`);
    } else if (ratio <= 0.7) {
      direction = 'LONG';
      score     = 60;
      signals.push(`${shortPct}% shorts — crowded short → potential squeeze`);
    }
    else {
      score = 30;
      signals.push(`Balanced long/short ratio (${ratio}) — no extreme positioning`);
    }

    return {
      ratio: _round(ratio, 3),
      longPct, shortPct,
      direction, score, signals,
      crowded: ratio >= 1.5 || ratio <= 0.7,
    };
  }
}

class MacroCalendarAnalyzer {
  static analyze(upcomingEvents = [], recentEvents = []) {
    const signals   = [];
    let riskScore   = 0;
    let bullBias    = 0;
    let hasCritical = false;

    const now = _now();

    for (const event of upcomingEvents) {
      const hoursUntil = (event.timestamp - now) / (60 * 60 * 1000);
      const eventInfo  = MACRO_EVENTS[event.type] || { impact: 'LOW', bullBias: 0 };

      if (hoursUntil <= 4 && eventInfo.impact === 'HIGH') {
        hasCritical = true;
        riskScore   = Math.max(riskScore, 90);
        signals.push(`⚠️ HIGH IMPACT: ${event.name} in ${_round(hoursUntil, 1)}h — avoid new entries`);
      } else if (hoursUntil <= 12 && eventInfo.impact === 'HIGH') {
        riskScore = Math.max(riskScore, 60);
        signals.push(`📅 ${event.name} in ${_round(hoursUntil, 0)}h — reduce position size`);
      } else if (hoursUntil <= 24 && eventInfo.impact === 'MEDIUM') {
        riskScore = Math.max(riskScore, 30);
        signals.push(`📅 ${event.name} in ${_round(hoursUntil, 0)}h — awareness only`);
      }

      bullBias += eventInfo.bullBias;
    }

    for (const event of recentEvents) {
      const hoursAgo  = (now - event.timestamp) / (60 * 60 * 1000);
      if (hoursAgo > 6) continue;

      if (event.result === 'HAWKISH') {
        bullBias -= 0.3;
        signals.push(`Recent hawkish ${event.name} — bearish macro backdrop`);
      } else if (event.result === 'DOVISH') {
        bullBias += 0.3;
        signals.push(`Recent dovish ${event.name} — bullish macro backdrop`);
      } else if (event.result === 'BEAT') {
        bullBias += 0.2;
        signals.push(`${event.name} beat estimates — positive sentiment`);
      } else if (event.result === 'MISS') {
        bullBias -= 0.2;
        signals.push(`${event.name} missed estimates — negative sentiment`);
      }
    }

    const direction = hasCritical ? 'WAIT'
                    : bullBias > 0.3  ? 'LONG'
                    : bullBias < -0.3 ? 'SHORT'
                    : 'NEUTRAL';

    return {
      direction,
      riskScore:   Math.round(riskScore),
      bullBias:    _round(bullBias, 3),
      hasCritical,
      signals,
      upcomingCount: upcomingEvents.length,
      recentCount:   recentEvents.length,
    };
  }

  static isBlackoutWindow(events = []) {
    const now          = _now();
    const blackoutMs   = 30 * 60 * 1000;

    for (const event of events) {
      const eventInfo = MACRO_EVENTS[event.type] || {};
      if (eventInfo.impact !== 'HIGH') continue;

      const timeToEvent = event.timestamp - now;
      const timeSince   = now - event.timestamp;

      if (timeToEvent >= 0 && timeToEvent <= blackoutMs) return { active: true, event, phase: 'BEFORE' };
      if (timeSince >= 0   && timeSince <= blackoutMs)   return { active: true, event, phase: 'AFTER' };
    }

    return { active: false };
  }
}

class SocialSentimentProxy {
  static analyze(data) {
    if (!data) return null;

    let bullPts = 0, bearPts = 0;
    const signals = [];

    if (data.twitterMentions && data.twitterMentionsAvg) {
      const ratio = data.twitterMentions / data.twitterMentionsAvg;
      if (ratio >= 3.0) {
        signals.push(`Twitter mentions ${ratio.toFixed(1)}x above average — viral attention`);
        bullPts += 0.5; bearPts += 0.5;
      } else if (ratio >= 1.5) {
        signals.push(`Twitter mentions ${ratio.toFixed(1)}x avg — elevated attention`);
      }
    }

    if (data.twitterSentimentPct != null) {
      const s = data.twitterSentimentPct;
      if (s >= 70) {
        bullPts += 2;
        signals.push(`Twitter ${s}% positive mentions — strong social bull sentiment`);
      } else if (s >= 55) {
        bullPts += 1;
        signals.push(`Twitter ${s}% positive — mildly bullish sentiment`);
      } else if (s <= 30) {
        bearPts += 2;
        signals.push(`Twitter ${s}% positive (${100-s}% negative) — strong social bear`);
      } else if (s <= 45) {
        bearPts += 1;
        signals.push(`Twitter ${s}% positive — mildly bearish sentiment`);
      }
    }

    if (data.redditPosts && data.redditPostsAvg) {
      const ratio = data.redditPosts / data.redditPostsAvg;
      if (ratio >= 2.5 && data.twitterSentimentPct >= 60) {
        bullPts += 1.5;
        signals.push(`Reddit ${ratio.toFixed(1)}x above avg posts + positive sentiment — community FOMO`);
      } else if (ratio >= 2.5 && data.twitterSentimentPct <= 40) {
        bearPts += 1;
        signals.push(`High Reddit activity but negative sentiment — panic/FUD spreading`);
      }
    }

    if (data.googleTrends != null && data.googleTrendsAvg != null) {
      const gtRatio = data.googleTrends / Math.max(data.googleTrendsAvg, 1);
      if (gtRatio >= 2.5) {
        signals.push(`Google Trends ${data.googleTrends} (${gtRatio.toFixed(1)}x avg) — mainstream attention spike`);
        bearPts += 1;
        signals.push(`Mainstream search spike historically marks local tops — cautious`);
      } else if (gtRatio <= 0.5) {
        signals.push(`Google Trends low (${data.googleTrends}) — accumulation/disinterest phase`);
        bullPts += 0.5;
      }
    }

    const direction = bullPts > bearPts + 0.5 ? 'LONG'
                    : bearPts > bullPts + 0.5 ? 'SHORT'
                    : 'NEUTRAL';
    const score     = _round(Math.min(100, Math.abs(bullPts - bearPts) / 5 * 100), 1);

    return { direction, score, signals, bullPts: _round(bullPts, 2), bearPts: _round(bearPts, 2) };
  }
}

class SentimentScorer {
  static score(components, direction) {
    const { news, cot, fearGreed, lsRatio, macro, social, insider } = components;
    const isLong = direction === 'LONG';
    let score    = 0;
    const reasons = [];

    if (news) {
      const aligned = isLong ? news.score > 0 : news.score < 0;
      const strength = Math.abs(news.score);
      if (aligned) {
        if (strength >= 60) { score += 25; reasons.push(`Strong ${isLong?'bullish':'bearish'} news sentiment (${news.score})`); }
        else if (strength >= 30) { score += 15; reasons.push(`Moderate news sentiment aligned with ${direction}`); }
        else if (strength >= 10) { score += 8; reasons.push(`Mild news sentiment supporting ${direction}`); }
      } else if (strength >= 40) {
        score -= 5; reasons.push(`News sentiment OPPOSES ${direction} — caution`);
      }
    }

    if (cot) {
      const cotAligned = cot.direction === direction || cot.direction === 'NEUTRAL';
      if (cot.direction === direction && cot.score >= 70) {
        score += 25; reasons.push(`COT: ${cot.signals[0] || 'Smart money aligned'}`);
      } else if (cot.direction === direction) {
        score += 15; reasons.push(`COT positioned ${direction} — institutional backing`);
      } else if (cot.direction !== 'NEUTRAL' && cot.direction !== direction) {
        score -= 8; reasons.push(`COT opposing ${direction} — smart money against signal`);
      }
    }

    if (fearGreed) {
      const fgAligned = fearGreed.direction === direction;
      if (fgAligned && fearGreed.score >= 70) {
        score += 20; reasons.push(`Fear & Greed: ${fearGreed.signals[0]}`);
      } else if (fgAligned && fearGreed.score >= 50) {
        score += 12; reasons.push(`Fear & Greed supports ${direction} (zone: ${fearGreed.zone})`);
      } else if (!fgAligned && fearGreed.score >= 70) {
        score -= 5; reasons.push(`Fear & Greed opposes ${direction}`);
      }
    }

    if (lsRatio) {
      if (lsRatio.direction === direction && lsRatio.score >= 70) {
        score += 15; reasons.push(`L/S Ratio: ${lsRatio.signals[0]}`);
      } else if (lsRatio.direction === direction) {
        score += 8; reasons.push(`Long/short positioning supports ${direction}`);
      } else if (lsRatio.direction !== 'NEUTRAL' && lsRatio.direction !== direction) {
        score -= 4; reasons.push(`L/S ratio against ${direction}`);
      }
    }

    if (macro) {
      if (macro.hasCritical) {
        score  = 0;
        return { score: 0, reasons: ['High-impact macro event imminent — sentiment score zeroed'], grade: 'D' };
      }
      if (macro.direction === direction && macro.bullBias > 0.2) {
        score += 10; reasons.push(`Macro backdrop supports ${direction}`);
      } else if (macro.direction !== direction && Math.abs(macro.bullBias) > 0.2) {
        score -= 5;
      }
    }

    if (social) {
      if (social.direction === direction && social.score >= 50) {
        score += 5; reasons.push(`Social: ${social.signals[0]}`);
      }
    }

    if (insider) {
      const insDir = insider.direction;
      const insScore = Number(insider.score) || 0;
      if (insDir === direction && insScore >= 70) {
        score += 15;
        reasons.push(`Insider: ${insider.note || 'cluster/executive flow aligned'}`);
      } else if (insDir === direction && insScore >= 50) {
        score += 10;
        reasons.push(`Insider flow supports ${direction}`);
      } else if (insDir !== 'NEUTRAL' && insDir !== direction && insScore >= 65) {
        score -= 8;
        reasons.push(`Insider flow opposes ${direction} — smart money caution`);
      }
    }

    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    return {
      score:   clamped,
      reasons,
      grade:   clamped >= 80 ? 'A' : clamped >= 60 ? 'B' : clamped >= 40 ? 'C' : 'D',
    };
  }
}

class NewsFetcher {
  constructor(config = {}) {
    this._apiKey  = config.newsApiKey || null;
    this._baseUrl = 'newsapi.org';
    this._cache   = new Map();
    this._cacheTTL = 15 * 60 * 1000;
  }

  async fetchForSymbol(symbol, maxArticles = 20) {
    const cacheKey = `news_${symbol}`;
    const cached   = this._cache.get(cacheKey);
    if (cached && (_now() - cached.fetchedAt < this._cacheTTL)) {
      return cached.articles;
    }

    if (!this._apiKey) {
      return this._generateSyntheticNews(symbol);
    }

    const query = this._buildQuery(symbol);

    try {
      const articles = await this._fetch(`/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=${maxArticles}&language=en&apiKey=${this._apiKey}`);
      this._cache.set(cacheKey, { articles: articles.articles || [], fetchedAt: _now() });
      return articles.articles || [];
    } catch (e) {
      console.warn(`[SentimentAgent] News fetch failed: ${e.message}`);
      return this._generateSyntheticNews(symbol);
    }
  }

  _buildQuery(symbol) {
    const base = symbol.replace('USDT', '').replace('USD', '');
    if (base === 'BTC' || symbol.includes('BITCOIN')) return 'bitcoin OR BTC crypto';
    if (base === 'ETH') return 'ethereum OR ETH crypto';
    if (base === 'SOL') return 'solana OR SOL crypto';
    if (symbol.includes('EUR')) return 'euro EURUSD forex Fed ECB';
    if (symbol.includes('XAU')) return 'gold XAUUSD inflation Fed';
    return `${base} cryptocurrency`;
  }

  _generateSyntheticNews(symbol) {
    return [{
      title: `${symbol} market analysis`,
      description: 'Technical analysis shows mixed signals',
      source: { name: 'synthetic' },
      publishedAt: new Date().toISOString(),
    }];
  }

  async _fetch(path) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: this._baseUrl, path, method: 'GET' }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('News timeout')); });
      req.end();
    });
  }
}

class SentimentAgent extends EventEmitter {
  constructor(config = {}) {
    super();
    this.symbol         = config.symbol    || 'BTCUSDT';
    this.timeframe      = config.timeframe || 'H1';
    this.minScore       = config.minScore  || 40;

    this._fetcher       = new NewsFetcher({ newsApiKey: config.newsApiKey });
    this._externalData  = config.externalData || null;

    this._lastVote      = null;
    this._lastAnalysis  = null;
    this._stats         = { analyzed: 0, avgScore: 0, longVotes: 0, shortVotes: 0, waitVotes: 0 };
  }

  async analyze(externalData = null) {
    const data = externalData || this._externalData || {};

    let newsResult = null;
    try {
      const articles = data.articles || await this._fetcher.fetchForSymbol(this.symbol);
      newsResult     = NLPAnalyzer.aggregateArticles(articles);
    } catch (e) {
      newsResult = { score: 0, confidence: 0, count: 0 };
    }

    const cotResult = data.cot ? COTAnalyzer.analyze(data.cot) : null;

    const fgResult = data.fearGreed
      ? FearGreedAnalyzer.analyze(data.fearGreed.value, data.fearGreed.previousValue)
      : null;

    const lsResult = data.lsRatio
      ? LongShortRatioAnalyzer.analyze(data.lsRatio, this.symbol)
      : null;

    const macroResult = MacroCalendarAnalyzer.analyze(
      data.upcomingEvents || [],
      data.recentEvents   || []
    );

    const blackout = MacroCalendarAnalyzer.isBlackoutWindow(data.upcomingEvents || []);
    if (blackout.active) {
      const vote = this._buildVote('WAIT', 0,
        [`News blackout: ${blackout.event?.name} ${blackout.phase} — no trading`],
        { newsResult, macroResult }
      );
      this._lastVote = vote;
      this.emit('vote', vote);
      return vote;
    }

    const socialResult = data.social
      ? SocialSentimentProxy.analyze(data.social)
      : null;

    let insiderResult = null;
    if (data.insider) {
      insiderResult = {
        direction: data.insider.direction || 'NEUTRAL',
        score: Number(data.insider.score) || 0,
        note: data.insider.note || data.insider.reason || '',
        clusters: data.insider.clusters || 0,
        executiveBias: data.insider.executiveBias || null,
      };
    }

    const components = {
      news:      newsResult,
      cot:       cotResult,
      fearGreed: fgResult,
      lsRatio:   lsResult,
      macro:     macroResult,
      social:    socialResult,
      insider:   insiderResult,
    };

    const direction = this._resolveDirection(components);

    let scoreResult = { score: 0, reasons: ['No directional sentiment signal'], grade: 'D' };
    if (direction !== 'WAIT' && direction !== 'NEUTRAL') {
      scoreResult = SentimentScorer.score(components, direction);
    }

    const finalDir = scoreResult.score >= this.minScore ? direction : 'WAIT';

    this._stats.analyzed++;
    if (finalDir === 'LONG')  this._stats.longVotes++;
    if (finalDir === 'SHORT') this._stats.shortVotes++;
    if (finalDir === 'WAIT')  this._stats.waitVotes++;
    this._stats.avgScore = _round(
      (this._stats.avgScore * (this._stats.analyzed - 1) + scoreResult.score) / this._stats.analyzed, 2
    );

    const vote = this._buildVote(finalDir, scoreResult.score, scoreResult.reasons, components);
    this._lastVote    = vote;
    this._lastAnalysis = components;

    this.emit('vote', vote);
    return vote;
  }

  _resolveDirection(c) {
    let bull = 0, bear = 0;
    const { news, cot, fearGreed, lsRatio, macro, social } = c;

    if (news) {
      if (news.score > 20) bull += 2;
      else if (news.score < -20) bear += 2;
    }
    if (cot?.direction === 'LONG')  bull += 3;
    if (cot?.direction === 'SHORT') bear += 3;
    if (fearGreed?.direction === 'LONG')  bull += 2;
    if (fearGreed?.direction === 'SHORT') bear += 2;
    if (lsRatio?.direction === 'LONG')  bull += 2;
    if (lsRatio?.direction === 'SHORT') bear += 2;
    if (macro?.direction === 'LONG')  bull++;
    if (macro?.direction === 'SHORT') bear++;
    if (social?.direction === 'LONG')  bull++;
    if (social?.direction === 'SHORT') bear++;

    if (bull > bear + 1) return 'LONG';
    if (bear > bull + 1) return 'SHORT';
    return 'NEUTRAL';
  }

  _buildVote(direction, score, reasons, analysis) {
    return {
      direction, score, reasons,
      grade:   score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D',
      analysis: {
        news:      analysis.news     || null,
        cot:       analysis.cot      || null,
        fearGreed: analysis.fearGreed || null,
        lsRatio:   analysis.lsRatio  || null,
        macro:     analysis.macro    || null,
        social:    analysis.social   || null,
      },
      symbol:    this.symbol,
      timeframe: this.timeframe,
      timestamp: _now(),
    };
  }

  updateExternalData(data) {
    this._externalData = { ...this._externalData, ...data };
  }

  getLastVote()    { return this._lastVote; }
  getLastAnalysis(){ return this._lastAnalysis; }
  getStats()       { return { ...this._stats }; }
}

module.exports = {
  SentimentAgent,
  NLPAnalyzer,
  COTAnalyzer,
  FearGreedAnalyzer,
  LongShortRatioAnalyzer,
  MacroCalendarAnalyzer,
  SocialSentimentProxy,
  SentimentScorer,
  NewsFetcher,
  BULLISH_KEYWORDS,
  BEARISH_KEYWORDS,
  MACRO_EVENTS,
};