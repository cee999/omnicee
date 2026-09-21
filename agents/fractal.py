"""FractalAgent — chaos-theory regime vote.

Port of Node `agents/fractal-agent.js`: R/S Hurst on returns, DFA on the
integrated series, FRAMA fractal dimension, and a largest-Lyapunov-exponent
estimate, fused into an edge-multiplier-scored directional vote.

Note on Hurst: the shared `features.indicators.hurst` computes on detrended
log PRICES (the project contract). This agent intentionally computes the
Node-parity R/S variant on log returns for its own analysis; both are kept so
the parity port and the project contract never drift into one another.
"""

from __future__ import annotations

import numpy as np

from contracts.signals import AgentVote, Direction

from .base import Agent, AgentContext


def _rs_hurst(values: np.ndarray) -> tuple[float, float]:
    """R/S Hurst over log returns. Returns (H, r_squared)."""
    ret = np.diff(np.log(values[np.asarray(values) > 0]))
    if ret.size < 32:
        return 0.5, 0.0
    sizes: list[int] = []
    s = 8
    while s <= ret.size // 3:
        sizes.append(s)
        s = int(s * 1.4)
    if len(sizes) < 3:
        return 0.5, 0.0
    xs, ys = [], []
    for size in sizes:
        n_blocks = ret.size // size
        if n_blocks < 1:
            continue
        ratios = []
        for b in range(n_blocks):
            block = ret[b * size:(b + 1) * size]
            dev = np.cumsum(block - block.mean())
            rng = dev.max() - dev.min()
            std = block.std(ddof=1)
            if std > 0:
                ratios.append(rng / std)
        if ratios:
            xs.append(size)
            ys.append(float(np.mean(ratios)))
    if len(xs) < 3:
        return 0.5, 0.0
    logx, logy = np.log(np.array(xs, dtype=float)), np.log(np.array(ys, dtype=float))
    slope, intercept = np.polyfit(logx, logy, 1)
    pred = intercept + slope * logx
    ss_res = float(((logy - pred) ** 2).sum())
    ss_tot = float(((logy - logy.mean()) ** 2).sum())
    r2 = max(0.0, 1.0 - ss_res / ss_tot) if ss_tot > 0 else 0.0
    return float(np.clip(slope, 0.0, 1.0)), r2


def _dfa_alpha(returns: np.ndarray) -> tuple[float, float]:
    """Detrended fluctuation analysis, order-1. Returns (alpha, r_squared)."""
    n = returns.size
    if n < 50:
        return 0.5, 0.0
    x = np.cumsum(returns - returns.mean())
    scales: list[int] = []
    s = 8
    while s <= n // 4:
        scales.append(s)
        s = int(s * 1.35)
    scales = sorted(set(scales))
    if len(scales) < 4:
        return 0.5, 0.0
    xs, ys = [], []
    for sc in scales:
        n_seg = n // sc
        if n_seg < 4:
            continue
        variances = []
        for b in range(n_seg):
            seg = x[b * sc:(b + 1) * sc]
            t = np.arange(sc, dtype=float)
            try:
                coeffs = np.polyfit(t, seg, 1)
            except np.linalg.LinAlgError:
                continue
            resid = seg - np.polyval(coeffs, t)
            v = float((resid ** 2).sum() / sc)
            if v > 1e-18:
                variances.append(v)
        if len(variances) >= 3:
            xs.append(sc)
            ys.append(float(np.sqrt(np.mean(variances))))
    if len(xs) < 4:
        return 0.5, 0.0
    logx, logy = np.log(np.array(xs, dtype=float)), np.log(np.array(ys, dtype=float))
    slope, intercept = np.polyfit(logx, logy, 1)
    pred = intercept + slope * logx
    ss_res = float(((logy - pred) ** 2).sum())
    ss_tot = float(((logy - logy.mean()) ** 2).sum())
    r2 = max(0.0, 1.0 - ss_res / ss_tot) if ss_tot > 0 else 0.0
    return float(slope), r2


def _frama(closes: np.ndarray, period: int = 16) -> float | None:
    if closes.size < 2 * period:
        return None
    half = period // 2
    window = closes[-period:]
    first, second, last = window[:half], window[half:], closes[-period:]
    n1 = (first.max() - first.min()) / half
    n2 = (second.max() - second.min()) / half
    n3 = (last.max() - last.min()) / period
    for n in (n1, n2, n3):
        if n <= 0:
            return None
    d = (np.log(n1 + n2) - np.log(n3)) / np.log(2)
    alpha = float(np.clip(np.exp(-4.6 * (d - 1)), 0.01, 1.0))
    frama = float(closes[0])
    for c in closes[1:]:
        frama = alpha * float(c) + (1 - alpha) * frama
    return frama


def _lyapunov(values: np.ndarray, dim: int = 3, delay: int = 1) -> float:
    n_vectors = values.size - (dim - 1) * delay
    if n_vectors < 20:
        return 0.0
    vecs = np.array([values[i:i + (dim - 1) * delay + 1:delay] for i in range(n_vectors)])
    acc: list[float] = []
    for i in range(min(n_vectors, 100)):
        dists = np.sqrt(((vecs - vecs[i]) ** 2).sum(axis=1))
        dists[max(0, i - dim * delay):i + dim * delay + 1] = np.inf
        j = int(dists.argmin())
        if i + 1 < n_vectors and j + 1 < n_vectors:
            d0, d1 = dists[j], float(np.abs(vecs[i + 1] - vecs[j + 1]).max())
            if d0 > 0 and d1 > 0:
                acc.append(np.log(d1 / d0))
    return float(np.mean(acc)) if acc else 0.0


class FractalAgent(Agent):
    name = "fractal"
    base_weight = 3.0
    min_bars = 50

    def evaluate(self, ctx: AgentContext) -> AgentVote:
        s = ctx.snapshot.primary()
        closes = np.asarray(s.close, dtype=float)
        if closes.size < 50:
            return self._flat(f"needs 50 bars, has {closes.size}")
        long_s, short_s, mult = 45.0, 45.0, 1.0
        reasons: list[str] = []

        h, r2 = _rs_hurst(closes)
        conf = r2 * 100
        if conf > 50:
            if h > 0.55:
                side_long = closes[-1] > closes[-20]
                if side_long:
                    long_s += 12
                else:
                    short_s += 12
                mult *= 1.15
                reasons.append(f"persistent series (H={h:.2f})")
            elif h < 0.45:
                if closes[-1] > closes[-5]:
                    short_s += 10
                else:
                    long_s += 10
                reasons.append(f"anti-persistent series (H={h:.2f})")
            else:
                mult *= 0.85

        alpha, _ = _dfa_alpha(np.diff(np.log(closes[closes > 0])))
        if alpha >= 0.58:
            mult *= 1.1
            reasons.append(f"long-range correlated (DFA a={alpha:.2f})")

        frama = _frama(closes)
        if frama is not None:
            speed = "fast"
            if closes[-1] > frama:
                reasons.append("price above FRAMA")
            else:
                reasons.append("price below FRAMA")
            # Speed affects how much we trust the FRAMA read.
            if speed == "fast":
                if closes[-1] > frama:
                    long_s += 8
                else:
                    short_s += 8

        lam = _lyapunov(closes)
        if lam > 0.1:
            mult *= 0.85
            reasons.append("chaotic dynamics detected")

        long_s = float(np.clip(long_s * mult, 0, 100))
        short_s = float(np.clip(short_s * mult, 0, 100))
        if abs(long_s - short_s) < 6:
            return AgentVote(agent=self.name, direction=Direction.FLAT, score=0.0,
                             confidence=min(1.0, max(long_s, short_s) / 100), weight=self.base_weight,
                             evidence=reasons[:6])
        direction = Direction.LONG if long_s > short_s else Direction.SHORT
        winner = max(long_s, short_s)
        signed = winner / 100 * (1 if direction is Direction.LONG else -1)
        return AgentVote(agent=self.name, direction=direction, score=round(signed, 4),
                         confidence=round(min(1.0, winner / 100), 3), weight=self.base_weight,
                         evidence=reasons[:6])
