import pytest
from pydantic import ValidationError

from omnicee.contracts.market import Candle, MarketSnapshot, Series
from omnicee.contracts.signals import Direction, Levels, Signal, SignalState


def test_candle_rejects_incoherent_ohlc():
    with pytest.raises(ValidationError):
        Candle(time=1, open=1.0, high=0.9, low=1.1, close=1.0)
    with pytest.raises(ValidationError):
        Candle(time=1, open=5.0, high=1.1, low=0.9, close=1.0)


def test_candle_rejects_non_positive_price():
    with pytest.raises(ValidationError):
        Candle(time=1, open=0.0, high=1.0, low=0.0, close=0.5)


def test_series_requires_increasing_unique_times():
    c = [Candle(time=t, open=1, high=1.1, low=0.9, close=1.0) for t in (100, 100)]
    with pytest.raises(ValidationError):
        Series(symbol="X", timeframe="M1", candles=c)
    c2 = [Candle(time=t, open=1, high=1.1, low=0.9, close=1.0) for t in (200, 100)]
    with pytest.raises(ValidationError):
        Series(symbol="X", timeframe="M1", candles=c2)


def test_snapshot_rejects_symbol_mismatch():
    s = Series(symbol="AAA", timeframe="M1",
               candles=[Candle(time=1, open=1, high=1.1, low=0.9, close=1.0)])
    with pytest.raises(ValidationError):
        MarketSnapshot(symbol="BBB", series={"M1": s})


def test_levels_direction_coherence():
    good = Levels(entry=1.10, stop_loss=1.09, take_profit=1.12)
    assert good.validate_for(Direction.LONG).risk_reward == 2.0
    with pytest.raises(ValueError):
        good.validate_for(Direction.SHORT)


def test_rejected_signal_must_carry_reason():
    with pytest.raises(ValidationError):
        Signal(symbol="X", timeframe="M1", direction=Direction.LONG,
               state=SignalState.REJECTED)


def test_signal_id_is_deterministic_and_stable():
    kw = dict(symbol="X", timeframe="M1", direction=Direction.LONG, created_at=123)
    assert Signal(**kw).signal_id == Signal(**kw).signal_id
