"""Market structure / smart-money concepts.

Everything here is derived from price only — no indicator smoothing — because
structure is about where price actually traded, not an average of it.

Definitions used (stated explicitly so a future agent does not silently
substitute a different one):

  swing high   a bar whose high exceeds the highs of `left` bars before and
               `right` bars after it. Requires `right` bars of hindsight, so
               the most recent `right` bars can never contain a confirmed
               swing. This lag is real and is not hidden.
  BOS          break of structure: close beyond the most recent confirmed
               swing in the direction of the prevailing trend.
  CHoCH        change of character: close beyond the most recent confirmed
               swing against the prevailing trend. The first sign of a
               structural flip.
  FVG          fair value gap: a 3-bar imbalance where bar1.high < bar3.low
               (bullish) or bar1.low > bar3.high (bearish).
  order block  the last opposing candle before an impulsive move that caused
               a BOS.
  sweep        price takes out a prior swing (wick beyond it) then closes back
               inside — a stop run rather than a genuine break.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from .indicators import atr

__all__ = [
    "FairValueGap",
    "LiquiditySweep",
    "MarketStructure",
    "OrderBlock",
    "StructureEvent",
    "Swing",
    "Trend",
    "analyse_structure",
]


class Trend(str, Enum):
    UP = "UP"
    DOWN = "DOWN"
    NEUTRAL = "NEUTRAL"


@dataclass(frozen=True, slots=True)
class Swing:
    index: int
    price: float
    is_high: bool
    time: int


@dataclass(frozen=True, slots=True)
class StructureEvent:
    kind: str  # "BOS" | "CHoCH"
    direction: Trend
    index: int
    time: int
    broken_level: float
    close: float


@dataclass(frozen=True, slots=True)
class FairValueGap:
    index: int  # index of the middle (impulse) bar
    time: int
    top: float
    bottom: float
    bullish: bool
    filled: bool

    @property
    def size(self) -> float:
        return self.top - self.bottom

    @property
    def midpoint(self) -> float:
        return (self.top + self.bottom) / 2.0


@dataclass(frozen=True, slots=True)
class OrderBlock:
    index: int
    time: int
    top: float
    bottom: float
    bullish: bool
    mitigated: bool


@dataclass(frozen=True, slots=True)
class LiquiditySweep:
    index: int
    time: int
    level: float
    swept_high: bool


@dataclass(slots=True)
class MarketStructure:
    trend: Trend = Trend.NEUTRAL
    swings: list[Swing] = field(default_factory=list)
    events: list[StructureEvent] = field(default_factory=list)
    fvgs: list[FairValueGap] = field(default_factory=list)
    order_blocks: list[OrderBlock] = field(default_factory=list)
    sweeps: list[LiquiditySweep] = field(default_factory=list)
    last_swing_high: Swing | None = None
    last_swing_low: Swing | None = None
    confirmation_lag: int = 0
    insufficient_data: bool = False

    @property
    def last_event(self) -> StructureEvent | None:
        return self.events[-1] if self.events else None

    def open_fvgs(self, bullish: bool | None = None) -> list[FairValueGap]:
        return [
            g
            for g in self.fvgs
            if not g.filled and (bullish is None or g.bullish is bullish)
        ]

    def unmitigated_blocks(self, bullish: bool | None = None) -> list[OrderBlock]:
        return [
            b
            for b in self.order_blocks
            if not b.mitigated and (bullish is None or b.bullish is bullish)
        ]


def find_swings(
    high: np.ndarray, low: np.ndarray, time: np.ndarray, left: int = 2, right: int = 2
) -> list[Swing]:
    """Fractal swing detection. Returns swings in chronological order."""
    n = high.size
    swings: list[Swing] = []
    if n < left + right + 1:
        return swings
    for i in range(left, n - right):
        window_h = high[i - left : i + right + 1]
        window_l = low[i - left : i + right + 1]
        centre = left
        if high[i] == window_h.max() and (window_h[centre] > np.delete(window_h, centre)).all():
            swings.append(Swing(i, float(high[i]), True, int(time[i])))
        elif low[i] == window_l.min() and (window_l[centre] < np.delete(window_l, centre)).all():
            swings.append(Swing(i, float(low[i]), False, int(time[i])))
    return swings


def _detect_events(
    close: np.ndarray, swings: list[Swing], time: np.ndarray
) -> tuple[list[StructureEvent], Trend]:
    """Walk forward through confirmed swings, emitting BOS/CHoCH."""
    events: list[StructureEvent] = []
    trend = Trend.NEUTRAL
    active_high: Swing | None = None
    active_low: Swing | None = None

    for sw in swings:
        # A swing only becomes tradeable `right` bars after its own index; we
        # scan closes strictly after the swing index for the break.
        if sw.is_high:
            active_high = sw
        else:
            active_low = sw

        for j in range(sw.index + 1, close.size):
            if active_high is not None and close[j] > active_high.price:
                kind = "BOS" if trend is Trend.UP else "CHoCH"
                events.append(
                    StructureEvent(
                        kind, Trend.UP, j, int(time[j]), active_high.price, float(close[j])
                    )
                )
                trend = Trend.UP
                active_high = None
                break
            if active_low is not None and close[j] < active_low.price:
                kind = "BOS" if trend is Trend.DOWN else "CHoCH"
                events.append(
                    StructureEvent(
                        kind, Trend.DOWN, j, int(time[j]), active_low.price, float(close[j])
                    )
                )
                trend = Trend.DOWN
                active_low = None
                break

    # Deduplicate: the loop above can emit the same break from nested swings.
    deduped: list[StructureEvent] = []
    for ev in sorted(events, key=lambda e: (e.index, e.broken_level)):
        if deduped and deduped[-1].index == ev.index and deduped[-1].direction == ev.direction:
            continue
        deduped.append(ev)

    final_trend = deduped[-1].direction if deduped else Trend.NEUTRAL
    return deduped, final_trend


def _detect_fvgs(
    high: np.ndarray, low: np.ndarray, time: np.ndarray, min_size: float
) -> list[FairValueGap]:
    gaps: list[FairValueGap] = []
    n = high.size
    for i in range(1, n - 1):
        # bullish: gap between bar i-1 high and bar i+1 low
        if high[i - 1] < low[i + 1]:
            top, bottom = float(low[i + 1]), float(high[i - 1])
            if top - bottom >= min_size:
                filled = bool((low[i + 2 :] <= bottom).any()) if i + 2 < n else False
                gaps.append(FairValueGap(i, int(time[i]), top, bottom, True, filled))
        elif low[i - 1] > high[i + 1]:
            top, bottom = float(low[i - 1]), float(high[i + 1])
            if top - bottom >= min_size:
                filled = bool((high[i + 2 :] >= top).any()) if i + 2 < n else False
                gaps.append(FairValueGap(i, int(time[i]), top, bottom, False, filled))
    return gaps


def _detect_order_blocks(
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    time: np.ndarray,
    events: list[StructureEvent],
    lookback: int = 12,
) -> list[OrderBlock]:
    """The last opposing candle before the impulse that broke structure."""
    blocks: list[OrderBlock] = []
    n = close.size
    for ev in events:
        bullish = ev.direction is Trend.UP
        start = max(0, ev.index - lookback)
        found = None
        for i in range(ev.index - 1, start - 1, -1):
            is_down_candle = close[i] < open_[i]
            if bullish and is_down_candle:
                found = i
                break
            if not bullish and not is_down_candle and close[i] > open_[i]:
                found = i
                break
        if found is None:
            continue
        top, bottom = float(high[found]), float(low[found])
        after = slice(ev.index + 1, n)
        if bullish:
            mitigated = bool((low[after] <= top).any())
        else:
            mitigated = bool((high[after] >= bottom).any())
        blocks.append(OrderBlock(found, int(time[found]), top, bottom, bullish, mitigated))
    return blocks


def _detect_sweeps(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    time: np.ndarray,
    swings: list[Swing],
    lookahead: int = 3,
) -> list[LiquiditySweep]:
    """Wick beyond a prior swing, close back inside within `lookahead` bars."""
    sweeps: list[LiquiditySweep] = []
    n = close.size
    for sw in swings:
        for j in range(sw.index + 1, min(sw.index + 1 + 40, n)):
            if sw.is_high and high[j] > sw.price:
                window = close[j : min(j + lookahead + 1, n)]
                if window.size and (window < sw.price).any():
                    sweeps.append(LiquiditySweep(j, int(time[j]), sw.price, True))
                break
            if not sw.is_high and low[j] < sw.price:
                window = close[j : min(j + lookahead + 1, n)]
                if window.size and (window > sw.price).any():
                    sweeps.append(LiquiditySweep(j, int(time[j]), sw.price, False))
                break
    return sweeps


def analyse_structure(
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    time: np.ndarray,
    swing_left: int = 2,
    swing_right: int = 2,
    min_bars: int = 40,
) -> MarketStructure:
    """Full structural read of one series.

    Returns a MarketStructure with `insufficient_data=True` rather than
    guessing when there are not enough bars.
    """
    n = close.size
    if n < min_bars:
        return MarketStructure(insufficient_data=True, confirmation_lag=swing_right)

    swings = find_swings(high, low, time, swing_left, swing_right)
    if len(swings) < 2:
        return MarketStructure(
            swings=swings, insufficient_data=True, confirmation_lag=swing_right
        )

    events, trend = _detect_events(close, swings, time)

    atr_series = atr(high, low, close, 14)
    last_atr = float(atr_series[-1]) if np.isfinite(atr_series[-1]) else 0.0
    min_gap = last_atr * 0.15 if last_atr > 0 else 0.0

    fvgs = _detect_fvgs(high, low, time, min_gap)
    blocks = _detect_order_blocks(open_, high, low, close, time, events)
    sweeps = _detect_sweeps(high, low, close, time, swings)

    highs = [s for s in swings if s.is_high]
    lows = [s for s in swings if not s.is_high]

    return MarketStructure(
        trend=trend,
        swings=swings,
        events=events,
        fvgs=fvgs,
        order_blocks=blocks,
        sweeps=sweeps,
        last_swing_high=highs[-1] if highs else None,
        last_swing_low=lows[-1] if lows else None,
        confirmation_lag=swing_right,
        insufficient_data=False,
    )
