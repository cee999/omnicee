"""Market regime classification.

Regime is decided before direction. A momentum read that is excellent in a
trend is noise in a range, so every agent downstream is told which world it is
operating in and weights itself accordingly.

Two orthogonal axes are measured, then resolved into one label:

  direction axis    TRENDING vs RANGING         (ADX + Hurst exponent)
  volatility axis   COMPRESSED / NORMAL / HIGH  (ATR and band-width
                                                 percentiles)

These are deliberately kept separate. An earlier single-ballot version let a
volatility squeeze outvote a strong ADX reading, so a tight consolidation
inside a powerful trend was labelled COMPRESSED and every trend-following
agent was down-weighted at exactly the wrong moment. Resolution order now is:

  1. extreme volatility wins outright — it changes position sizing regardless
     of direction, so it must surface
  2. otherwise a strong direction wins even if bands are tight (a squeeze
     inside a trend is a pause, not a regime change)
  3. otherwise a squeeze wins
  4. otherwise the direction axis decides

Both axes are always returned, so callers that care about only one are not
forced through the resolution.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import numpy as np

from contracts.signals import Regime

from .indicators import adx, atr, bollinger, hurst, pct_rank

__all__ = ["DirectionAxis", "RegimeRead", "VolatilityAxis", "classify_regime"]


class DirectionAxis(str, Enum):
    TRENDING = "TRENDING"
    RANGING = "RANGING"
    UNCLEAR = "UNCLEAR"


class VolatilityAxis(str, Enum):
    COMPRESSED = "COMPRESSED"
    NORMAL = "NORMAL"
    HIGH = "HIGH"


@dataclass(frozen=True, slots=True)
class RegimeRead:
    regime: Regime
    direction_axis: DirectionAxis
    volatility_axis: VolatilityAxis
    adx: float | None
    hurst: float | None
    atr_percentile: float | None
    bandwidth_percentile: float | None
    confidence: float
    reasons: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "regime": self.regime.value,
            "directionAxis": self.direction_axis.value,
            "volatilityAxis": self.volatility_axis.value,
            "adx": self.adx,
            "hurst": self.hurst,
            "atrPercentile": self.atr_percentile,
            "bandwidthPercentile": self.bandwidth_percentile,
            "confidence": self.confidence,
            "reasons": list(self.reasons),
        }


def _last_finite(a: np.ndarray) -> float | None:
    if a.size == 0:
        return None
    v = a[-1]
    return float(v) if np.isfinite(v) else None


def classify_regime(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    *,
    adx_trend: float = 22.0,
    adx_range: float = 18.0,
    hurst_trend: float = 0.55,
    hurst_revert: float = 0.45,
    vol_high_pct: float = 0.85,
    squeeze_pct: float = 0.20,
    lookback: int = 100,
    min_bars: int = 60,
) -> RegimeRead:
    """Classify the current regime. Returns UNKNOWN when data is too thin."""
    n = close.size
    if n < min_bars:
        return RegimeRead(
            Regime.UNKNOWN,
            DirectionAxis.UNCLEAR,
            VolatilityAxis.NORMAL,
            None, None, None, None, 0.0,
            (f"fewer than {min_bars} bars available",),
        )

    adx_v = _last_finite(adx(high, low, close, 14)[0])
    h_raw = hurst(close, max_lag=min(50, n // 4))
    h_v = float(h_raw) if np.isfinite(h_raw) else None

    win = min(lookback, max(30, n // 2))
    atr_pct = _last_finite(
        pct_rank(np.nan_to_num(atr(high, low, close, 14), nan=0.0), win)
    )

    upper, mid, lower = bollinger(close, 20, 2.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        bandwidth = np.where(mid > 0, (upper - lower) / mid, np.nan)
    bw_pct = _last_finite(pct_rank(np.nan_to_num(bandwidth, nan=0.0), win))

    reasons: list[str] = []

    # ---- direction axis --------------------------------------------------
    trend_score = 0.0
    range_score = 0.0
    if adx_v is not None:
        if adx_v >= adx_trend:
            trend_score += 1.0
            reasons.append(f"ADX {adx_v:.0f} — price is moving with direction")
        elif adx_v <= adx_range:
            range_score += 1.0
            reasons.append(f"ADX {adx_v:.0f} — no clear direction")
    if h_v is not None:
        if h_v >= hurst_trend:
            trend_score += 0.8
            reasons.append(f"Hurst {h_v:.2f} — moves tend to continue")
        elif h_v <= hurst_revert:
            range_score += 0.8
            reasons.append(f"Hurst {h_v:.2f} — moves tend to snap back")

    if trend_score > range_score:
        direction, dir_conf = DirectionAxis.TRENDING, trend_score / 1.8
    elif range_score > trend_score:
        direction, dir_conf = DirectionAxis.RANGING, range_score / 1.8
    else:
        direction, dir_conf = DirectionAxis.UNCLEAR, 0.0

    # ---- volatility axis ---------------------------------------------------
    volatility = VolatilityAxis.NORMAL
    vol_conf = 0.0
    if atr_pct is not None and atr_pct >= vol_high_pct:
        volatility = VolatilityAxis.HIGH
        vol_conf = atr_pct
        reasons.append(
            f"volatility in the top {(1 - atr_pct) * 100:.0f}% of its recent range"
        )
    elif bw_pct is not None and bw_pct <= squeeze_pct:
        volatility = VolatilityAxis.COMPRESSED
        vol_conf = 1.0 - bw_pct
        reasons.append(f"price range unusually tight — {bw_pct * 100:.0f}th percentile")

    # ---- resolution ---------------------------------------------------------
    strong_direction = dir_conf >= 0.55

    if volatility is VolatilityAxis.HIGH:
        regime, confidence = Regime.VOLATILE, vol_conf
    elif direction is DirectionAxis.TRENDING and strong_direction:
        regime, confidence = Regime.TRENDING, dir_conf
        if volatility is VolatilityAxis.COMPRESSED:
            reasons.append("tight range inside a trend — read as a pause, not a reversal")
    elif volatility is VolatilityAxis.COMPRESSED:
        regime, confidence = Regime.COMPRESSED, vol_conf
    elif direction is DirectionAxis.TRENDING:
        regime, confidence = Regime.TRENDING, dir_conf
    elif direction is DirectionAxis.RANGING:
        regime, confidence = Regime.RANGING, dir_conf
    else:
        return RegimeRead(
            Regime.UNKNOWN, direction, volatility, adx_v, h_v, atr_pct, bw_pct, 0.0,
            tuple(reasons) or ("no measurement crossed a decision threshold",),
        )

    return RegimeRead(
        regime,
        direction,
        volatility,
        adx_v,
        h_v,
        atr_pct,
        bw_pct,
        round(min(1.0, max(0.0, confidence)), 3),
        tuple(reasons),
    )
