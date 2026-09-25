from __future__ import annotations

from agents.base import AgentContext
from agents.sentiment import SentimentAgent
from contracts.signals import Direction
from features.regime import classify_regime
from feeds.myfxbook import MyfxbookFeed


def test_disabled_without_credentials():
    feed = MyfxbookFeed("", "")
    assert feed.enabled is False
    assert feed.stats.enabled is False
    assert feed.get_ratio("EURUSD") is None


def test_get_ratio_none_when_no_data():
    feed = MyfxbookFeed("user@example.com", "hunter2")
    assert feed.enabled is True
    assert feed.get_ratio("EURUSD") is None


def test_get_ratio_computed_from_outlook():
    feed = MyfxbookFeed("user@example.com", "hunter2")
    feed._outlook["EURUSD"] = {
        "shortPercentage": 20.0, "longPercentage": 80.0,
        "shortVolume": 100.0, "longVolume": 400.0,
        "totalPositions": 500, "updatedAt": 0,
    }
    # 80% long / 20% short -> crowded long -> ratio 4.0
    assert feed.get_ratio("EURUSD") == 4.0
    # unknown symbol -> no fabricated ratio
    assert feed.get_ratio("GBPUSD") is None


def test_get_ratio_guards_zero_short_percentage():
    feed = MyfxbookFeed("user@example.com", "hunter2")
    feed._outlook["XAUUSD"] = {"shortPercentage": 0.0, "longPercentage": 100.0}
    assert feed.get_ratio("XAUUSD") is None


def _ctx(snapshot, external):
    s = snapshot().primary()
    return AgentContext(snapshot=snapshot(), regime=classify_regime(s.high, s.low, s.close),
                        external=external)


def test_sentiment_agent_fades_crowded_retail_longs(snapshot):
    # Retail 4x long (>= 2.0 threshold) -> contrarian vote is SHORT.
    vote = SentimentAgent().evaluate(_ctx(snapshot, {"lsRatio": 4.0}))
    assert vote.direction is Direction.SHORT
    assert any("crowded long" in e for e in vote.evidence)


def test_sentiment_agent_fades_crowded_retail_shorts(snapshot):
    # Retail 4x short (<= 0.5 threshold) -> contrarian vote is LONG.
    vote = SentimentAgent().evaluate(_ctx(snapshot, {"lsRatio": 0.25}))
    assert vote.direction is Direction.LONG
    assert any("crowded short" in e for e in vote.evidence)


def test_sentiment_agent_skips_missing_ls_ratio(snapshot):
    # No feed data (None, or key absent) must never be treated as neutral
    # crowding — it's simply not counted, per "never fabricate a number".
    vote = SentimentAgent().evaluate(_ctx(snapshot, {}))
    assert not any("crowded" in e for e in vote.evidence)
