"""Market data contracts.

These models are the single source of truth for the shape of market data
crossing the Node <-> Python boundary. FastAPI publishes them as OpenAPI, so
the Node side can generate a typed client instead of guessing field names.

Rule: if a value is not known, it is None. It is never zero, never a
placeholder, never carried forward from a previous bar.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Price = Annotated[float, Field(gt=0, description="Absolute price, must be positive")]


class Candle(BaseModel):
    """One OHLCV bar. Time is the bar OPEN time, always UTC epoch milliseconds."""

    model_config = ConfigDict(frozen=True)

    time: int = Field(..., ge=0, description="Bar open time, UTC epoch ms")
    open: Price
    high: Price
    low: Price
    close: Price
    volume: float = Field(default=0.0, ge=0.0)

    @model_validator(mode="after")
    def _ohlc_coherent(self) -> Candle:
        if self.high < self.low:
            raise ValueError(f"high {self.high} below low {self.low}")
        if not (self.low <= self.open <= self.high):
            raise ValueError(f"open {self.open} outside [{self.low}, {self.high}]")
        if not (self.low <= self.close <= self.high):
            raise ValueError(f"close {self.close} outside [{self.low}, {self.high}]")
        return self

    @property
    def range(self) -> float:
        return self.high - self.low

    @property
    def body(self) -> float:
        return abs(self.close - self.open)

    @property
    def is_bullish(self) -> bool:
        return self.close > self.open


class Series(BaseModel):
    """A validated, ordered candle series for one symbol/timeframe.

    Converting to numpy once here means every downstream feature function gets
    contiguous float64 arrays rather than re-walking a list of objects.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    symbol: str = Field(..., min_length=1, max_length=24)
    timeframe: str = Field(..., min_length=1, max_length=8)
    candles: list[Candle] = Field(..., min_length=1)

    @field_validator("symbol", "timeframe")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()

    @model_validator(mode="after")
    def _strictly_increasing_time(self) -> Series:
        times = [c.time for c in self.candles]
        for i in range(1, len(times)):
            if times[i] <= times[i - 1]:
                raise ValueError(
                    f"candles must be time-ordered and unique; "
                    f"index {i} ({times[i]}) <= index {i - 1} ({times[i - 1]})"
                )
        return self

    def __len__(self) -> int:
        return len(self.candles)

    # ---- numpy views (cached on first access) --------------------------
    def _col(self, name: str) -> np.ndarray:
        key = f"_np_{name}"
        cached = getattr(self, key, None)
        if cached is None:
            cached = np.fromiter(
                (getattr(c, name) for c in self.candles),
                dtype=np.float64,
                count=len(self.candles),
            )
            cached.setflags(write=False)
            object.__setattr__(self, key, cached)
        return cached

    @property
    def open(self) -> np.ndarray:
        return self._col("open")

    @property
    def high(self) -> np.ndarray:
        return self._col("high")

    @property
    def low(self) -> np.ndarray:
        return self._col("low")

    @property
    def close(self) -> np.ndarray:
        return self._col("close")

    @property
    def volume(self) -> np.ndarray:
        return self._col("volume")

    @property
    def time(self) -> np.ndarray:
        return self._col("time")

    @property
    def last(self) -> Candle:
        return self.candles[-1]

    def age_ms(self, now_ms: int | None = None) -> int:
        """Milliseconds since the last bar opened."""
        now = now_ms if now_ms is not None else int(datetime.now(UTC).timestamp() * 1000)
        return max(0, now - self.last.time)

    def tail(self, n: int) -> Series:
        return Series(
            symbol=self.symbol, timeframe=self.timeframe, candles=self.candles[-n:]
        )


class MarketSnapshot(BaseModel):
    """Everything the brain needs to analyse one symbol, in one payload.

    The Node edge owns the feeds; it assembles this and posts it. The brain
    holds no feed connections of its own, which keeps the failure domains
    separate: a dead feed cannot crash analysis, and a crashed brain cannot
    drop ticks.
    """

    symbol: str = Field(..., min_length=1, max_length=24)
    series: dict[str, Series] = Field(
        ..., description="Keyed by timeframe, e.g. {'M15': Series, 'H1': Series}"
    )
    spread: float | None = Field(default=None, ge=0.0)
    pip_size: float = Field(default=0.0001, gt=0.0)
    contract_size: float = Field(default=100_000.0, gt=0.0)
    received_at: int = Field(
        default_factory=lambda: int(datetime.now(UTC).timestamp() * 1000)
    )
    source: str | None = Field(
        default=None, description="Which feed produced this, for audit"
    )

    @field_validator("symbol")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()

    @model_validator(mode="after")
    def _series_match_symbol(self) -> MarketSnapshot:
        if not self.series:
            raise ValueError("series must contain at least one timeframe")
        for tf, s in self.series.items():
            if s.symbol != self.symbol:
                raise ValueError(
                    f"series[{tf}] carries symbol {s.symbol}, expected {self.symbol}"
                )
        return self

    def primary(self, preferred: tuple[str, ...] = ("M15", "M5", "H1")) -> Series:
        """The working timeframe for entry logic."""
        for tf in preferred:
            if tf in self.series:
                return self.series[tf]
        return next(iter(self.series.values()))


__all__ = ["Candle", "MarketSnapshot", "Price", "Series"]
