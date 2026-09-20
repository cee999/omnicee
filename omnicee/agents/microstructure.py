"""MicrostructureAgent — volume profile, CVD, initiative analysis.

Port of Node `agents/microstructure-agent.js` (volume/OI order-flow
confirmation vote).
"""

from __future__ import annotations

import numpy as np

from ..contracts.signals import AgentVote, Direction
from .base import Agent, AgentContext


def _volume_profile(high: np.ndarray, low: np.ndarray, open_: np.ndarray, close: np.ndarray,
                    volume: np.ndarray, bins: int = 50) -> dict[str, object] | None:
    lo, hi = float(low.min()), float(high.max())
    if hi - lo <= 0:
        return None
    bin_size = (hi - lo) / bins
    buy_p = np.zeros(bins)
    sell_p = np.zeros(bins)
    for i in range(high.size):
        vol = float(volume[i]) if volume[i] > 0 else 1.0
        is_buy = close[i] >= open_[i]
        span = high[i] - low[i]
        if span <= 0:
            idx = min(int((low[i] - lo) / bin_size), bins - 1)
            (buy_p if is_buy else sell_p)[idx] += vol
            continue
        n = int(np.ceil(span / bin_size))
        step = vol / n
        price = low[i]
        for _ in range(n):
            idx = min(int((price - lo) / bin_size), bins - 1)
            (buy_p if is_buy else sell_p)[idx] += step
            price += bin_size
    total = buy_p + sell_p
    if total.sum() <= 0:
        return None
    poc_bin = int(total.argmax())
    target = total.sum() * 0.7
    lo_b = hi_b = poc_bin
    acc = total[poc_bin]
    while acc < target and (lo_b > 0 or hi_b < bins - 1):
        below = total[lo_b - 1] if lo_b > 0 else -1
        above = total[hi_b + 1] if hi_b < bins - 1 else -1
        if above >= below:
            hi_b += 1
            acc += max(above, 0)
        else:
            lo_b -= 1
            acc += max(below, 0)
    avg_bin = total.mean()
    hvn = [{"price": lo + (i + 0.5) * bin_size, "volume": float(total[i])}
           for i in np.argsort(total)[-5:] if total[i] > 1.5 * avg_bin]
    lvn_idx = [i for i in np.argsort(total)[:5] if 0 < total[i] < 0.3 * avg_bin]
    lvn = [{"price": lo + (i + 0.5) * bin_size, "volume": float(total[i])} for i in lvn_idx]
    third = bins / 3
    lower, middle, upper = total[:int(third)].sum(), total[int(third):int(2 * third)].sum(), total[int(2 * third):].sum()
    tot = total.sum()
    if tot == 0:
        shape = "FLAT"
    elif middle / tot > 0.45:
        shape = "NORMAL"
    elif lower / tot > 0.45:
        shape = "P_SHAPED"
    elif upper / tot > 0.45:
        shape = "B_SHAPED"
    elif lower / tot > 0.35 and upper / tot > 0.35:
        shape = "D_SHAPED"
    else:
        shape = "LEAN"
    return {"poc": lo + (poc_bin + 0.5) * bin_size, "vah": lo + (hi_b + 1) * bin_size,
            "val": lo + lo_b * bin_size, "shape": shape,
            "buyDominance": float(buy_p.sum() / tot), "hvn": hvn, "lvn": lvn}


def _cvd(open_: np.ndarray, high: np.ndarray, low: np.ndarray, close: np.ndarray,
         volume: np.ndarray) -> dict[str, object] | None:
    n = close.size
    if n < 10:
        return None
    rng = high - low
    buy_pct = np.where(rng > 0, (((close - low) - (high - close)) / np.where(rng > 0, rng, 1) + 1) / 2, 0.5)
    delta = volume * (2 * buy_pct - 1)
    cvd = np.cumsum(delta)
    w = min(20, n)
    x = np.arange(w, dtype=float)

    def _norm_slope(arr: np.ndarray) -> float:
        y = arr[-w:]
        if y.size < 3:
            return 0.0
        mean = float(np.abs(y.mean())) or 1.0
        slope = float(np.polyfit(x, y, 1)[0])
        return slope / mean

    cvd_slope = _norm_slope(cvd)
    half = min(30, n) // 2
    divergence = "NONE"
    if half >= 2:
        p1, p2 = close[-2 * half:-half], close[-half:]
        c1, c2 = cvd[-2 * half:-half], cvd[-half:]
        if p2.max() > 1.001 * p1.max() and c2.max() < 0.999 * c1.max():
            divergence = "BEARISH"
        elif p2.min() < 0.999 * p1.min() and c2.min() > 1.001 * c1.min():
            divergence = "BULLISH"
    absorptions = []
    if n >= 10:
        avg_vol = float(volume[-10:].mean())
        for i in range(n - 10, n):
            if volume[i] > 1.5 * avg_vol and avg_vol > 0:
                body = abs(close[i] - open_[i])
                spread = high[i] - low[i]
                if spread > 0 and body / spread < 0.35:
                    absorptions.append("BUY_ABSORPTION" if close[i] > open_[i] else "SELL_ABSORPTION")
    return {"trend": "ACCUMULATION" if cvd_slope > 0 else "DISTRIBUTION",
            "divergence": divergence, "absorptions": absorptions, "cvdSlope": cvd_slope}


class MicrostructureAgent(Agent):
    name = "microstructure"
    base_weight = 2.0
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

        profile = _volume_profile(h[-100:], lo[-100:], o[-100:], c[-100:], v[-100:])
        if profile:
            poc = profile["poc"]
            price = float(c[-1])
            if price < poc and profile["shape"] == "P_SHAPED":
                long_s += 15
                reasons.append("price under POC in P-shaped profile")
            if price > poc and profile["shape"] == "B_SHAPED":
                short_s += 15
                reasons.append("price over POC in B-shaped profile")
            for node in profile["lvn"]:
                if abs(price - node["price"]) / price < 0.003:
                    long_s += 5
                    short_s += 5
                    reasons.append("at low-volume node")
                    break
            if profile["buyDominance"] > 0.58:
                long_s += 10
                reasons.append("buy-dominant tape")
            elif profile["buyDominance"] < 0.42:
                short_s += 10
                reasons.append("sell-dominant tape")
            if price > profile["vah"] and v[-1] > 1.2 * v[-20:].mean() and c[-1] > o[-1]:
                long_s += 12
                reasons.append("initiative buying above value")
            elif price < profile["val"] and v[-1] > 1.2 * v[-20:].mean() and c[-1] < o[-1]:
                short_s += 12
                reasons.append("initiative selling below value")

        cvd = _cvd(o, h, lo, c, v)
        if cvd:
            if cvd["trend"] == "ACCUMULATION":
                long_s += 12
                reasons.append("cvd accumulation")
            else:
                short_s += 12
                reasons.append("cvd distribution")
            if cvd["divergence"] == "BULLISH":
                long_s += 10
                reasons.append("bullish cvd divergence")
            elif cvd["divergence"] == "BEARISH":
                short_s += 10
                reasons.append("bearish cvd divergence")
            for ab in cvd["absorptions"]:
                if ab == "BUY_ABSORPTION":
                    short_s += 6
                else:
                    long_s += 6

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
