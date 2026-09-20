"""Momentum agent.

Reads RSI, MACD histogram and the slope of price. Strong in trends, actively
harmful in ranges, so it inverts its own interpretation when the regime is
RANGING: an overbought reading in a range is a short, not a long.
"""

from __future__ import annotations

import numpy as np

from ..contracts.signals import AgentVote, Direction, Regime
from ..features.indicators import ema, linreg_slope, macd, rsi
from ..features.regime import RegimeRead
from .base import Agent, AgentContext

__all__ = ["MomentumAgent"]


class MomentumAgent(Agent):
    name = "momentum"
    base_weight = 1.0
    min_bars = 60

    def weight_for_regime(self, regime: RegimeRead) -> float:
        return {
            Regime.TRENDING: self.base_weight * 1.20,
            Regime.RANGING: self.base_weight * 0.70,
            Regime.VOLATILE: self.base_weight * 0.60,
            Regime.COMPRESSED: self.base_weight * 0.55,
        }.get(regime.regime, self.base_weight)

    def evaluate(self, ctx: AgentContext) -> AgentVote:
        s = ctx.snapshot.primary()
        close = s.close
        mean_revert = ctx.regime.regime is Regime.RANGING

        r = rsi(close, 14)
        _, _, hist = macd(close)
        slope = linreg_slope(close, 20)
        fast, slow = ema(close, 21), ema(close, 55)

        score = 0.0
        evidence: list[str] = []

        r_last = r[-1]
        if np.isfinite(r_last):
            # Centre RSI on 50 and scale to roughly [-1, 1].
            raw = (r_last - 50.0) / 30.0
            if mean_revert:
                if r_last >= 70:
                    score -= 0.35
                    evidence.append(f"RSI {r_last:.0f} stretched high in a range — fade it")
                elif r_last <= 30:
                    score += 0.35
                    evidence.append(f"RSI {r_last:.0f} stretched low in a range — fade it")
            else:
                score += 0.30 * max(-1.0, min(1.0, raw))
                if abs(raw) > 0.3:
                    evidence.append(
                        f"RSI {r_last:.0f} leaning {'up' if raw > 0 else 'down'}"
                    )

        h_last = hist[-1]
        if np.isfinite(h_last) and np.isfinite(close[-1]) and close[-1] > 0:
            norm = max(-1.0, min(1.0, float(h_last) / (close[-1] * 0.002)))
            score += 0.25 * norm * (-1.0 if mean_revert else 1.0)
            if abs(norm) > 0.2:
                evidence.append(
                    f"MACD momentum {'building' if norm > 0 else 'fading'}"
                )

        sl = slope[-1]
        if np.isfinite(sl) and close[-1] > 0:
            norm = max(-1.0, min(1.0, float(sl) / (close[-1] * 0.0008)))
            score += 0.25 * norm * (-1.0 if mean_revert else 1.0)

        if np.isfinite(fast[-1]) and np.isfinite(slow[-1]):
            if fast[-1] > slow[-1]:
                score += 0.20 * (-1.0 if mean_revert else 1.0)
                evidence.append("short-term average above long-term")
            else:
                score -= 0.20 * (-1.0 if mean_revert else 1.0)
                evidence.append("short-term average below long-term")

        score = max(-1.0, min(1.0, score))
        if abs(score) < 0.12:
            return AgentVote(
                agent=self.name, direction=Direction.FLAT, score=0.0, confidence=0.0,
                evidence=evidence[:5] or ["momentum is flat"],
            )

        return AgentVote(
            agent=self.name,
            direction=Direction.LONG if score > 0 else Direction.SHORT,
            score=round(score, 4),
            confidence=round(min(1.0, abs(score) * 1.1), 4),
            evidence=evidence[:5],
        )
