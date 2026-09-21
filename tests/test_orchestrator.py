"""Regression coverage for orchestrator/engine.py.

test_analyze_symbol_does_not_crash exists specifically because the existing
test suite was green (29/29) while `_analyze_symbol` was raising
AttributeError on every symbol in production — `result.regime.get(...)` on
an enum. None of the other tests exercise the orchestrator's full cycle end
to end, so this bug shipped invisibly. This test closes that gap: it drives
`_analyze_symbol` the same way `Orchestrator.run()`'s cycle does, against
realistic seeded candles, and simply asserts it returns without raising.
"""

from __future__ import annotations

import asyncio

import pytest

from config import Settings
from orchestrator.engine import Orchestrator
from services.bus import EventBus
from tests.conftest import make_series


class _StubStore:
    """Minimal stand-in for FeedManager.store — just what _build_snapshot reads."""

    def __init__(self, rows_by_tf: dict[str, list[dict]]) -> None:
        self._rows_by_tf = rows_by_tf
        self.last_prices: dict[str, dict] = {}

    def get(self, symbol: str, timeframe: str) -> list[dict]:
        return self._rows_by_tf.get(timeframe, [])


class _StubFeedManager:
    def __init__(self, store: _StubStore) -> None:
        self.store = store


def _candle_rows(symbol: str, timeframe: str, n: int = 250) -> list[dict]:
    series = make_series(symbol=symbol, timeframe=timeframe, n=n)
    return [
        {"time": c.time, "open": c.open, "high": c.high, "low": c.low,
         "close": c.close, "volume": c.volume, "source": "test", "isClosed": True}
        for c in series.candles
    ]


@pytest.fixture
def orchestrator() -> Orchestrator:
    settings = Settings(SYMBOLS="EURUSD", TIMEFRAMES="M15")
    store = _StubStore({"M15": _candle_rows("EURUSD", "M15")})
    fm = _StubFeedManager(store)
    return Orchestrator(settings, EventBus(), None, fm, None, None, None)


def test_analyze_symbol_does_not_crash(orchestrator: Orchestrator) -> None:
    result = asyncio.run(orchestrator._analyze_symbol("EURUSD", []))
    assert isinstance(result, dict)
    assert "action" in result


def test_analyze_symbol_regime_translation_is_sane(orchestrator: Orchestrator) -> None:
    """The legacy structure/volatility/trend/tradeability dict built from
    the new Regime contract should always be well-formed, whatever regime
    was actually read — this is what line 231's bug silently broke."""
    result = asyncio.run(orchestrator._analyze_symbol("EURUSD", []))
    engines = result.get("engines") or {}
    strategy = engines.get("strategy") or {}
    assert strategy.get("profile") in {
        "TREND_CONTINUATION", "MEAN_REVERSION", "DEFENSIVE_SELECTIVE",
    }
    assert isinstance(strategy.get("confidenceMultiplier"), float)
