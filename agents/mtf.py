"""Multi-timeframe confluence agent.

Reads the trend on every available timeframe and rewards alignment. A setup
that agrees with the timeframe above it is worth more than one fighting it;
this agent is the one that says so.

Higher timeframes carry more weight, and a disagreement between the two
highest available timeframes caps the vote hard — that is the classic
"trading into the daily trend" mistake.
"""

from __future__ import annotations

import numpy as np

from contracts.signals import AgentVote, Direction
from features.indicators import ema, linreg_slope

from .base import Agent, AgentContext

__all__ = ["MTFAgent"]

# Ordered lowest to highest. Unknown timeframes fall back to insertion order.
_TF_ORDER = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]


def _tf_rank(tf: str) -> int:
    try:
        return _TF_ORDER.index(tf.upper())
    except ValueError:
        return len(_TF_ORDER)


class MTFAgent(Agent):
    name = "mtf"
    base_weight = 1.4
    min_bars = 60

    def evaluate(self, ctx: AgentContext) -> AgentVote:
        series = ctx.snapshot.series
        ordered = sorted(series.items(), key=lambda kv: _tf_rank(kv[0]))
        usable = [(tf, s) for tf, s in ordered if len(s) >= 60]

        if len(usable) < 2:
            return AgentVote(
                agent=self.name, direction=Direction.FLAT, score=0.0, confidence=0.0,
                evidence=[f"needs 2+ timeframes with history, has {len(usable)}"],
            )

        reads: list[tuple[str, float, float]] = []  # (tf, direction, weight)
        for i, (tf, s) in enumerate(usable):
            fast, slow = ema(s.close, 21), ema(s.close, 55)
            slope = linreg_slope(s.close, 20)
            if not (np.isfinite(fast[-1]) and np.isfinite(slow[-1])):
                continue
            bias = 0.0
            bias += 0.6 if fast[-1] > slow[-1] else -0.6
            if np.isfinite(slope[-1]):
                bias += 0.4 * np.sign(slope[-1])
            # Weight grows with timeframe rank: the daily outranks the 5-minute.
            weight = 1.0 + i * 0.6
            reads.append((tf, float(np.clip(bias, -1.0, 1.0)), weight))

        if len(reads) < 2:
            return AgentVote(
                agent=self.name, direction=Direction.FLAT, score=0.0, confidence=0.0,
                evidence=["could not establish trend on enough timeframes"],
            )

        total_w = sum(w for _, _, w in reads)
        weighted = sum(b * w for _, b, w in reads) / total_w

        ups = [tf for tf, b, _ in reads if b > 0.2]
        downs = [tf for tf, b, _ in reads if b < -0.2]
        aligned = max(len(ups), len(downs))
        agreement = aligned / len(reads)

        evidence = []
        if ups:
            evidence.append("pointing up: " + ", ".join(ups))
        if downs:
            evidence.append("pointing down: " + ", ".join(downs))

        # Top two timeframes disagreeing is a hard brake.
        top_two = reads[-2:]
        conflicted = len(top_two) == 2 and (top_two[0][1] * top_two[1][1]) < -0.15
        if conflicted:
            weighted *= 0.35
            evidence.append(
                f"{top_two[0][0]} and {top_two[1][0]} disagree — conviction cut"
            )

        score = float(np.clip(weighted, -1.0, 1.0))
        if abs(score) < 0.15:
            return AgentVote(
                agent=self.name, direction=Direction.FLAT, score=0.0, confidence=0.0,
                evidence=evidence[:5] or ["timeframes are mixed"],
            )

        evidence.append(f"{aligned} of {len(reads)} timeframes agree")
        return AgentVote(
            agent=self.name,
            direction=Direction.LONG if score > 0 else Direction.SHORT,
            score=round(score, 4),
            confidence=round(min(1.0, abs(score) * agreement * 1.2), 4),
            evidence=evidence[:5],
        )
