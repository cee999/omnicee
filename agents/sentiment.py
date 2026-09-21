"""SentimentAgent — external sentiment fusion vote.

Port of Node `agents/sentiment-agent.js`. Fuses a keyword-lexicon NLP score
over headlines, COT positioning, Fear&Greed, long/short ratio, macro calendar
blackout logic, and social proxies into one contrarian-aware vote. External
inputs arrive via the snapshot's `external` dict (injected by the engine);
absent components are skipped — never zero-filled.
"""

from __future__ import annotations

import re
from typing import Any

from contracts.signals import AgentVote, Direction

from .base import Agent, AgentContext

BULL_LEX = {"rally": 2, "surge": 2, "breakout": 2, "record high": 3, "beat": 1, "upgrade": 2,
            "inflow": 2, "accumulation": 2, "bullish": 2, "dovish": 2, "stimulus": 2,
            "recovery": 2, "all-time high": 3, "buy": 1}
BEAR_LEX = {"crash": 3, "plunge": 3, "miss": 1, "selloff": 2, "sell-off": 2, "outflow": 2,
            "liquidation": 2, "bearish": 2, "hawkish": 2, "recession": 3, "downgrade": 2,
            "default": 3, "panic": 3, "collapse": 3}
NEGATION = {"not", "no", "without", "denies", "fails to"}
INTENSIFIERS = {"very": 1.5, "sharply": 1.3, "slightly": 0.7, "marginally": 0.6, "barely": 0.5}
SOURCE_WEIGHTS = {"reuters": 1.0, "bloomberg": 1.0, "wsj": 1.0, "ft": 1.0, "coindesk": 0.85,
                  "theblock": 0.85, "cointelegraph": 0.8, "decrypt": 0.8, "twitter": 0.5,
                  "reddit": 0.4, "telegram": 0.35}

HIGH_IMPACT = re.compile(r"nfp|fomc|cpi|rate decision", re.I)


def _nlp_score(articles: list[dict[str, Any]]) -> tuple[float, float]:
    """Returns (score in [-100, 100], confidence in [0, 100])."""
    bull = bear = 0.0
    signals = 0
    words = 0
    for art in articles or []:
        text = f"{art.get('headline', '')} {art.get('summary', '')}".lower()
        tokens = text.split()
        words += len(tokens)
        source = str(art.get("source", "")).lower()
        cred = SOURCE_WEIGHTS.get(source, 0.5)
        for lex, polarity in ((BULL_LEX, 1), (BEAR_LEX, -1)):
            for phrase, weight in lex.items():
                idx = 0
                while True:
                    i = text.find(phrase, idx)
                    if i < 0:
                        break
                    idx = i + len(phrase)
                    w = weight * (4 if " " in phrase else 3)
                    prior2 = tokens[max(0, text[:i].count(" ") - 1):max(0, text[:i].count(" "))]
                    if any(t in NEGATION for t in prior2):
                        polarity_eff = -polarity
                        w *= 0.7
                    else:
                        polarity_eff = polarity
                    for t in prior2:
                        if t in INTENSIFIERS:
                            w *= INTENSIFIERS[t]
                    if polarity_eff > 0:
                        bull += w * cred
                    else:
                        bear += w * cred
                    signals += 1
    total = bull + bear
    if total <= 0:
        return 0.0, 0.0
    score = (bull - bear) / total * 100
    density = min(signals / max(words / 20, 1), 1)
    confidence = (density * 0.4 + abs(score) / 100 * 0.6) * 100
    return score, confidence


class SentimentAgent(Agent):
    name = "sentiment"
    base_weight = 5.0
    # Framework contract: every agent refuses uniformly on thin data so a
    # thin-data run can never be mistaken for a real "no news" read.
    min_bars = 60

    def evaluate(self, ctx: AgentContext) -> AgentVote:
        # External context (news, COT, fear&greed, calendar) is injected by
        # the engine through the agent context; absent keys are skipped.
        ext = ctx.external or {}
        reasons: list[str] = []
        bull = bear = 0.0

        # ---- news NLP ----
        articles = ext.get("articles") or []
        news_score, news_conf = _nlp_score(articles)
        if articles and news_conf > 20:
            if news_score > 20:
                bull += 2
                reasons.append(f"news flow bullish ({news_score:.0f})")
            elif news_score < -20:
                bear += 2
                reasons.append(f"news flow bearish ({news_score:.0f})")

        # ---- COT (contrarian on crowded specs) ----
        cot = ext.get("cot")
        if cot and cot.get("largeSpecPercentile") is not None:
            pct = float(cot["largeSpecPercentile"])
            if pct >= 95:
                bear += 2
                reasons.append("COT: specs crowded long")
            elif pct <= 5:
                bull += 2
                reasons.append("COT: specs crowded short")

        # ---- Fear & Greed (contrarian) ----
        fg = ext.get("fearGreed")
        if fg and fg.get("value") is not None:
            v = float(fg["value"])
            if v <= 25:
                bull += 2
                reasons.append(f"fear & greed extreme fear ({v:.0f})")
            elif v >= 75:
                bear += 2
                reasons.append(f"fear & greed extreme greed ({v:.0f})")

        # ---- long/short ratio (contrarian) ----
        ls = ext.get("lsRatio")
        if ls and float(ls) >= 2.0:
            bear += 2
            reasons.append("retail crowded long")
        elif ls and float(ls) <= 0.5:
            bull += 2
            reasons.append("retail crowded short")

        # ---- macro calendar blackout ----
        for ev in ext.get("upcomingEvents") or []:
            if HIGH_IMPACT.search(str(ev.get("name", ""))) and abs(float(ev.get("minutesAway", 9999))) <= 30:
                return AgentVote(agent=self.name, direction=Direction.FLAT, score=0.0,
                                 confidence=0.0, weight=self.base_weight,
                                 evidence=["blackout: high-impact event within 30 minutes"])

        if bull == bear:
            return AgentVote(agent=self.name, direction=Direction.FLAT, score=0.0,
                             confidence=round(min(1.0, news_conf / 100), 3),
                             weight=self.base_weight, evidence=reasons[:6])
        direction = Direction.LONG if bull > bear else Direction.SHORT
        lead = abs(bull - bear)
        signed = min(1.0, lead / 4)
        return AgentVote(agent=self.name, direction=direction, score=round(signed, 4),
                         confidence=round(min(1.0, max(news_conf, lead * 20) / 100), 3),
                         weight=self.base_weight, evidence=reasons[:6])
