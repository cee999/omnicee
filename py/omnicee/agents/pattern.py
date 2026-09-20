"""PatternAgent — chart patterns, harmonics, Wyckoff, volume divergence.

Port of Node `agents/pattern-agent.js`. Pivot-based detectors (H&S, double
top/bottom, triangles, flags, wedges, cup & handle), harmonic ratios
(Gartley/Bat/Butterfly/Crab/ABCD), Wyckoff phase/events, and OBV/CMF
divergence, aggregated into a point-based vote.
"""

from __future__ import annotations

import numpy as np

from ..contracts.market import MarketSnapshot
from ..contracts.signals import AgentVote, Direction
from .base import Agent, AgentContext


def _pivots(high: np.ndarray, low: np.ndarray, strength: int = 3) -> tuple[list[int], list[int]]:
    highs, lows = [], []
    n = high.size
    for i in range(strength, n - strength):
        window = slice(i - strength, i + strength + 1)
        if high[i] >= high[window].max():
            highs.append(i)
        if low[i] <= low[window].min():
            lows.append(i)
    return highs, lows


def _chart_patterns(o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray,
                    price: float) -> tuple[float, float, list[str]]:
    """Returns (bull_points, bear_points, reasons)."""
    bull = bear = 0.0
    reasons: list[str] = []
    hi_p, lo_p = _pivots(h, l)
    hi_p = [i for i in hi_p if i >= h.size - 60][-3:]
    lo_p = [i for i in lo_p if i >= l.size - 60][-3:]

    if len(hi_p) == 3:
        a, head, b = hi_p
        if h[head] > h[a] and h[head] > h[b] and abs(h[a] - h[b]) / h[a] < 0.03 and c[-1] < h[b]:
            bear += 0.9 * 2
            reasons.append("head & shoulders broken")
    if len(lo_p) == 3:
        a, head, b = lo_p
        if l[head] < l[a] and l[head] < l[b] and abs(l[a] - l[b]) / l[a] < 0.03 and c[-1] > l[b]:
            bull += 0.9 * 2
            reasons.append("inverse head & shoulders broken")
    if len(hi_p) >= 2:
        p1, p2 = hi_p[-2], hi_p[-1]
        if abs(h[p1] - h[p2]) / h[p1] < 0.025 and p2 - p1 >= 5:
            bear += 0.85 * 2
            reasons.append("double top")
    if len(lo_p) >= 2:
        p1, p2 = lo_p[-2], lo_p[-1]
        if abs(l[p1] - l[p2]) / l[p1] < 0.025 and p2 - p1 >= 5:
            bull += 0.85 * 2
            reasons.append("double bottom")
    if len(hi_p) >= 2 and len(lo_p) >= 2:
        hi_slope = h[hi_p[-1]] - h[hi_p[0]]
        lo_slope = l[lo_p[-1]] - l[lo_p[0]]
        if hi_slope < 0.001 * price and lo_slope > 0:
            bull += 0.75 * 2
            reasons.append("ascending triangle")
        elif lo_slope > -0.001 * price and hi_slope < 0:
            bear += 0.75 * 2
            reasons.append("descending triangle")
    pole = c[-25:-10]
    if pole.size == 15:
        pole_move = (pole[-1] - pole[0]) / pole[0]
        flag = c[-10:]
        flag_size = (flag.max() - flag.min()) / price
        pole_size = abs(pole_move)
        if pole_size > 0.03 and flag_size < 0.5 * pole_size:
            if pole_move > 0:
                bull += 0.72 * 2
                reasons.append("bull flag")
            else:
                bear += 0.72 * 2
                reasons.append("bear flag")
    if len(hi_p) >= 2 and len(lo_p) >= 2:
        hs = np.polyfit(hi_p, h[hi_p], 1)[0]
        ls = np.polyfit(lo_p, l[lo_p], 1)[0]
        if hs > 0 and ls > 0 and ls > hs:
            bear += 0.70 * 2
            reasons.append("rising wedge")
        elif hs < 0 and ls < 0 and hs < ls:
            bull += 0.70 * 2
            reasons.append("falling wedge")
    return bull, bear, reasons


def _harmonics(h: np.ndarray, l: np.ndarray, price: float) -> tuple[float, float, list[str]]:
    bull = bear = 0.0
    reasons: list[str] = []
    hi_p, lo_p = _pivots(h, l, 3)
    pts = sorted([(i, "H", float(h[i])) for i in hi_p[-6:]] + [(i, "L", float(l[i])) for i in lo_p[-6:]])
    if len(pts) >= 5:
        pts = pts[-5:]
        X, A, B, C, D = [p[2] for p in pts]

        def _r(a: float, b: float) -> float:
            return abs(b - a) / abs(a) if a else 0

        rAB = abs(B - A) / abs(A - X) if abs(A - X) else 0
        rBC = abs(C - B) / abs(B - A) if abs(B - A) else 0
        rCD = abs(D - C) / abs(C - B) if abs(C - B) else 0
        rXD = abs(D - X) / abs(A - X) if abs(A - X) else 0
        tol = 0.05
        bullish = A < X
        long_pt, short_pt = (3.0, 0.0) if bullish else (0.0, 3.0)
        if abs(rAB - 0.618) < tol and 0.382 - tol <= rBC <= 0.886 + tol and abs(rXD - 0.786) < tol:
            bull += long_pt
            bear += short_pt
            reasons.append("gartley")
        elif 0.382 - tol <= rAB <= 0.5 + tol and 0.382 - tol <= rBC <= 0.886 + tol and abs(rXD - 0.886) < tol:
            bull += long_pt
            bear += short_pt
            reasons.append("bat")
        elif abs(rAB - 0.786) < tol and 0.382 - tol <= rBC <= 0.886 + tol and 1.27 <= rXD <= 1.618:
            bull += long_pt
            bear += short_pt
            reasons.append("butterfly")
        elif abs(rXD - 1.618) < tol * 2:
            bull += long_pt
            bear += short_pt
            reasons.append("crab")
    return bull, bear, reasons


def _wyckoff(o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray,
             v: np.ndarray) -> tuple[float, float, list[str]]:
    bull = bear = 0.0
    reasons: list[str] = []
    n = c.size
    if n < 60:
        return bull, bear, reasons
    avg_vol30 = float(v[-30:].mean())
    range_recent = float((h[-20:] - l[-20:]).mean())
    range_all = float((h[-60:] - l[-60:]).mean())
    contracting = range_recent < 0.7 * range_all
    vol20, vol60 = float(v[-20:].mean()), float(v[-60:].mean())
    pos = (c[-1] - float(l[-60:].min())) / max(float(h[-60:].max() - l[-60:].min()), 1e-12)
    if pos < 0.4 and (vol20 < 0.8 * vol60 or contracting):
        bull += 0.75 * 3
        reasons.append("wyckoff accumulation")
    elif pos > 0.6 and (vol20 > 1.2 * vol60 or contracting):
        bear += 0.75 * 3
        reasons.append("wyckoff distribution")
    # Events (last 40 bars)
    for i in range(max(n - 40, 1), n):
        if v[i] > 2 * avg_vol30 and c[i] < o[i] and pos < 0.35:
            bull += 10 / 100 * 3
            reasons.append("selling climax")
        elif v[i] > 2 * avg_vol30 and c[i] > o[i] and pos > 0.65:
            bear += 10 / 100 * 3
            reasons.append("buying climax")
    return bull, bear, reasons


class PatternAgent(Agent):
    name = "pattern"
    base_weight = 6.0
    min_bars = 50

    def evaluate(self, ctx: AgentContext) -> AgentVote:
        s = ctx.snapshot.primary()
        o = np.asarray(s.open, dtype=float)
        h = np.asarray(s.high, dtype=float)
        l = np.asarray(s.low, dtype=float)
        c = np.asarray(s.close, dtype=float)
        v = np.asarray(s.volume if s.volume is not None and len(s.volume) == len(c) else np.ones(len(c)), dtype=float)
        price = float(c[-1])
        reasons: list[str] = []
        bull = bear = 0.0

        b1, b2, r1 = _chart_patterns(o, h, l, c, price)
        bull += b1
        bear += b2
        reasons.extend(r1)
        b3, b4, r2 = _harmonics(h, l, price)
        bull += b3
        bear += b4
        reasons.extend(r2)
        b5, b6, r3 = _wyckoff(o, h, l, c, v)
        bull += b5
        bear += b6
        reasons.extend(r3)

        # OBV + CMF divergence (last 20)
        if c.size >= 20:
            direction_sign = np.sign(c[1:] - c[:-1])
            obv = np.concatenate([[0], np.cumsum(direction_sign * v[1:])])
            obv_slope = float(np.polyfit(np.arange(20, dtype=float), obv[-20:], 1)[0])
            price_slope = float(np.polyfit(np.arange(20, dtype=float), c[-20:], 1)[0])
            if price_slope <= 0 < obv_slope:
                bull += 1.5
                reasons.append("bullish obv divergence")
            elif price_slope >= 0 > obv_slope:
                bear += 1.5
                reasons.append("bearish obv divergence")
            mfm = ((c - l) - (h - c)) / np.where(h - l > 0, h - l, 1)
            cmf = float((mfm[-20:] * v[-20:]).sum() / max(v[-20:].sum(), 1e-12))
            if cmf > 0.05:
                bull += 1
            elif cmf < -0.05:
                bear += 1

        if bull > bear + 0.5:
            direction = Direction.LONG
            score = round(min(100.0, abs(bull - bear) / max(bull + bear, 1) * 100), 2) / 100
            signed = score
        elif bear > bull + 0.5:
            direction = Direction.SHORT
            score = round(min(100.0, abs(bull - bear) / max(bull + bear, 1) * 100), 2) / 100
            signed = -score
        else:
            return AgentVote(agent=self.name, direction=Direction.FLAT, score=0.0,
                             confidence=min(1.0, max(bull, bear) / 10), weight=self.base_weight,
                             evidence=reasons[:6])
        return AgentVote(agent=self.name, direction=direction, score=round(signed, 4),
                         confidence=round(min(1.0, score), 3), weight=self.base_weight,
                         evidence=reasons[:6])
