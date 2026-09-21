from __future__ import annotations

import numpy as np
import pytest

from contracts.market import Candle, MarketSnapshot, Series


def make_series(symbol="EURUSD", timeframe="M15", n=250, kind="trend", seed=1, start_ms=1_700_000_000_000):
    r = np.random.default_rng(seed)
    if kind == "trend":
        inc = np.zeros(n)
        e = r.normal(0, 0.004, n)
        for i in range(1, n):
            inc[i] = 0.55 * inc[i - 1] + e[i]
        base = 1.10 * np.exp(np.cumsum(inc + 0.0012))
    elif kind == "down":
        inc = np.zeros(n)
        e = r.normal(0, 0.004, n)
        for i in range(1, n):
            inc[i] = 0.55 * inc[i - 1] + e[i]
        base = 1.10 * np.exp(np.cumsum(inc - 0.0012))
    else:
        base = np.full(n, 1.10)
        for i in range(1, n):
            base[i] = base[i - 1] + 0.12 * (1.10 - base[i - 1]) + r.normal(0, 0.002)

    candles = []
    for i in range(n):
        c = float(base[i])
        o = float(base[i - 1]) if i else c
        wick = abs(r.normal(0, 0.0008)) + 1e-6
        candles.append(
            Candle(
                time=start_ms + i * 900_000,
                open=max(o, 1e-6),
                high=max(o, c) + wick,
                low=max(min(o, c) - wick, 1e-6),
                close=max(c, 1e-6),
                volume=float(abs(r.normal(1000, 200))),
            )
        )
    return Series(symbol=symbol, timeframe=timeframe, candles=candles)


@pytest.fixture
def snapshot():
    def _make(kind="trend", symbol="EURUSD", n=250, seed=1):
        m15 = make_series(symbol, "M15", n, kind, seed)
        h1 = make_series(symbol, "H1", n, kind, seed + 1)
        h4 = make_series(symbol, "H4", n, kind, seed + 2)
        return MarketSnapshot(
            symbol=symbol,
            series={"M15": m15, "H1": h1, "H4": h4},
            received_at=m15.candles[-1].time + 1000,
            source="test",
        )
    return _make
