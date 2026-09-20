"""Smart-money concepts agent.

Votes on structural evidence only: break of structure, change of character,
unmitigated order blocks, open fair value gaps and liquidity sweeps.

It is the highest-weighted agent in a trending regime and heavily discounted
in a compressed one, where structural breaks are mostly noise.
"""

from __future__ import annotations

from ..contracts.signals import AgentVote, Direction, Regime
from ..features.regime import RegimeRead
from ..features.structure import Trend, analyse_structure
from .base import Agent, AgentContext

__all__ = ["SMCAgent"]


class SMCAgent(Agent):
    name = "smc"
    base_weight = 1.6
    min_bars = 80

    def weight_for_regime(self, regime: RegimeRead) -> float:
        return {
            Regime.TRENDING: self.base_weight * 1.25,
            Regime.RANGING: self.base_weight * 0.75,
            Regime.VOLATILE: self.base_weight * 0.85,
            Regime.COMPRESSED: self.base_weight * 0.50,
        }.get(regime.regime, self.base_weight)

    def evaluate(self, ctx: AgentContext) -> AgentVote:
        s = ctx.snapshot.primary()
        ms = analyse_structure(s.open, s.high, s.low, s.close, s.time)

        if ms.insufficient_data:
            return AgentVote(
                agent=self.name, direction=Direction.FLAT, score=0.0, confidence=0.0,
                evidence=["not enough confirmed structure to read"],
            )

        score = 0.0
        evidence: list[str] = []
        last = ms.last_event

        if last is not None:
            bars_since = len(s) - 1 - last.index
            # Structural evidence decays; a break 40 bars ago is history.
            freshness = max(0.0, 1.0 - bars_since / 40.0)
            direction_sign = 1.0 if last.direction is Trend.UP else -1.0
            magnitude = 0.55 if last.kind == "BOS" else 0.40
            score += direction_sign * magnitude * freshness
            if freshness > 0.05:
                word = "continued" if last.kind == "BOS" else "flipped"
                evidence.append(
                    f"structure {word} {'up' if direction_sign > 0 else 'down'} "
                    f"{bars_since} bars ago at {last.broken_level:.5f}"
                )

        price = float(s.close[-1])

        for bullish, sign in ((True, 1.0), (False, -1.0)):
            blocks = ms.unmitigated_blocks(bullish=bullish)
            if blocks:
                nearest = min(blocks, key=lambda b: abs(price - (b.top + b.bottom) / 2))
                mid = (nearest.top + nearest.bottom) / 2
                distance = abs(price - mid) / price if price else 1.0
                if distance < 0.004:
                    score += sign * 0.20
                    evidence.append(
                        f"price sitting on an untouched {'demand' if bullish else 'supply'} zone"
                    )

        for bullish, sign in ((True, 1.0), (False, -1.0)):
            gaps = ms.open_fvgs(bullish=bullish)
            if gaps:
                score += sign * min(0.15, 0.05 * len(gaps))
                evidence.append(
                    f"{len(gaps)} unfilled {'bullish' if bullish else 'bearish'} "
                    "imbalance(s) below" if bullish else
                    f"{len(gaps)} unfilled bearish imbalance(s) above"
                )

        recent_sweeps = [sw for sw in ms.sweeps if len(s) - 1 - sw.index <= 10]
        for sw in recent_sweeps:
            # A swept high is a failed breakout upward -> bearish, and vice versa.
            score += -0.18 if sw.swept_high else 0.18
            evidence.append(
                f"stops taken {'above' if sw.swept_high else 'below'} "
                f"{sw.level:.5f} then price rejected"
            )

        score = max(-1.0, min(1.0, score))
        if abs(score) < 0.12:
            return AgentVote(
                agent=self.name, direction=Direction.FLAT, score=0.0, confidence=0.0,
                evidence=evidence[:6] or ["structure is balanced, no edge"],
            )

        return AgentVote(
            agent=self.name,
            direction=Direction.LONG if score > 0 else Direction.SHORT,
            score=round(score, 4),
            confidence=round(min(1.0, abs(score) * 1.15), 4),
            evidence=evidence[:6],
        )
