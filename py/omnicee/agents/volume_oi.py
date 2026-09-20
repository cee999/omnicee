"""VolumeOIAgent — volume, open interest, funding confirmation vote.

Port of Node `agents/volume-oi-agent.js`.
"""

from __future__ import annotations

import numpy as np

from ..contracts.signals import AgentVote, Direction
from .base import Agent, AgentContext


class VolumeOIAgent(Agent):
    name = "volume_oi"
    base_weight = 4.0
    min_bars = 30

    def evaluate(self, ctx: AgentContext) -> AgentVote:
        s = ctx.snapshot.primary()
        o = np.asarray(s.open, dtype=float)
        h = np.asarray(s.high, dtype=float)
        lo = np.asarray(s.low, dtype=float)
        c = np.asarray(s.close, dtype=float)
        v = np.asarray(s.volume if s.volume is not None and len(s.volume) == len(c) else np.ones(len(c)), dtype=float)
        reasons: list[str] = []
        long_s = short_s = 45.0

        last_vol = float(v[-1])
        prior = v[:-1]
        vol_mean = float(prior.mean()) if prior.size else 0.0
        vol_std = float(np.sqrt(((prior - vol_mean) ** 2).mean())) if prior.size else 0.0
        volume_z = (last_vol - vol_mean) / vol_std if vol_std > 0 else 0.0
        spread = max(float(h[-1] - lo[-1]), 1e-12)
        close_loc = float((c[-1] - lo[-1]) / spread)
        bullish = c[-1] > o[-1]

        if volume_z > 1.2 and bullish and close_loc > 0.62:
            long_s += 18
            reasons.append(f"volume spike z={volume_z:.1f} closing high")
        elif volume_z > 1.2 and not bullish and close_loc < 0.38:
            short_s += 18
            reasons.append(f"volume spike z={volume_z:.1f} closing low")

        sign = np.sign(c[1:] - c[:-1])
        obv = np.concatenate([[0], np.cumsum(sign * v[1:])])
        w = min(20, c.size)
        obv_slope = float(np.polyfit(np.arange(w, dtype=float), obv[-w:], 1)[0]) / (float(np.abs(obv[-w:]).mean()) or 1.0)
        price_slope = float(np.polyfit(np.arange(w, dtype=float), c[-w:], 1)[0]) / (float(np.abs(c[-w:]).mean()) or 1.0)
        if obv_slope > 0 and price_slope >= 0:
            long_s += 12
            reasons.append("obv confirms uptrend")
        elif obv_slope < 0 and price_slope <= 0:
            short_s += 12
            reasons.append("obv confirms downtrend")
        elif obv_slope > 0 > price_slope:
            long_s += 8
            reasons.append("bullish obv/price divergence")
        elif obv_slope < 0 < price_slope:
            short_s += 8
            reasons.append("bearish obv/price divergence")

        body = abs(float(c[-1] - o[-1]))
        body_share = body / spread
        if body_share > 0.62 and last_vol > vol_mean:
            if bullish:
                long_s += 8
            else:
                short_s += 8
            reasons.append("full-bodied high-volume candle")

        oi, funding = None, None
        try:
            oi = s.open_interest  # type: ignore[attr-defined]
            funding = s.funding_rate  # type: ignore[attr-defined]
        except AttributeError:
            pass
        if oi is not None and len(oi) == len(c):
            oi = np.asarray(oi, dtype=float)
            change = float(oi[-1] - oi[-2]) / max(float(oi[-2]), 1e-12)
            if change > 0.005:
                if bullish:
                    long_s += 10
                    reasons.append("open interest rising with price")
                else:
                    short_s += 10
                    reasons.append("open interest rising on decline")
            elif change < -0.006:
                long_s -= 5
                short_s -= 5
                reasons.append("open interest unwinding")
        if funding is not None:
            try:
                f = float(funding[-1]) if hasattr(funding, "__len__") else float(funding)
            except (TypeError, ValueError):
                f = None
            if f is not None:
                if f > 0.0005:
                    short_s += 4
                    reasons.append("positive funding (crowded longs)")
                elif f < -0.0005:
                    long_s += 4
                    reasons.append("negative funding (crowded shorts)")

        long_s, short_s = float(np.clip(long_s, 0, 100)), float(np.clip(short_s, 0, 100))
        if abs(long_s - short_s) < 8:
            return AgentVote(agent=self.name, direction=Direction.FLAT, score=0.0,
                             confidence=min(1.0, max(long_s, short_s) / 100), weight=self.base_weight,
                             evidence=reasons[:6])
        direction = Direction.LONG if long_s > short_s else Direction.SHORT
        winner = max(long_s, short_s)
        signed = winner / 100 * (1 if direction is Direction.LONG else -1)
        return AgentVote(agent=self.name, direction=direction, score=round(signed, 4),
                         confidence=round(min(1.0, winner / 100), 3), weight=self.base_weight,
                         evidence=reasons[:6])
