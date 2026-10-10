"""ConvexSink: batching, coalescing, retry-without-loss, config gating."""

import asyncio

import httpx
import pytest

from config import Settings
from services.bus import EventBus
from services.convex_sink import ConvexSink


def _settings(**kw):
    base = {"NODE_ENV": "test", "CONVEX_SITE_URL": "https://x.convex.site",
            "CONVEX_INGEST_SECRET": "s" * 32}
    base.update(kw)
    return Settings(**base)


def _sink(handler, **kw):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ConvexSink(_settings(**kw), EventBus(), client=client)


def test_disabled_without_config():
    assert ConvexSink(Settings(NODE_ENV="test"), EventBus()).enabled is False


def test_production_requires_a_durable_store():
    with pytest.raises(ValueError, match="CONVEX_SITE_URL"):
        Settings(NODE_ENV="production", EA_SECRET="e")
    Settings(NODE_ENV="production", EA_SECRET="e",
             CONVEX_SITE_URL="https://x.convex.site", CONVEX_INGEST_SECRET="s")


def test_half_configured_convex_is_rejected_in_production():
    with pytest.raises(ValueError, match="both CONVEX_SITE_URL"):
        Settings(NODE_ENV="production", EA_SECRET="e", MONGODB_URI="mongodb://h/d",
                 CONVEX_SITE_URL="https://x.convex.site")


def test_market_coalesces_signals_do_not():
    sent = []

    def handler(req):
        sent.append(req)
        return httpx.Response(200, json={"ok": True})

    async def go():
        sink = _sink(handler)
        for p in (1.0, 2.0, 3.0):
            sink._accept("market_update", {"symbol": "BTCUSDT", "price": p})
        sink._accept("signal", {"id": "a", "symbol": "BTCUSDT"})
        sink._accept("signal", {"id": "b", "symbol": "BTCUSDT"})
        assert await sink.flush_once()
        return sink

    sink = asyncio.run(go())
    import json
    events = json.loads(sent[0].content)["events"]
    assert sent[0].headers["authorization"] == "Bearer " + "s" * 32
    assert [e["data"].get("id") for e in events if e["kind"] == "signal"] == ["a", "b"]
    market = [e for e in events if e["kind"] == "market"]
    assert len(market) == 1 and market[0]["data"]["price"] == 3.0
    assert sink.sent == 3


def test_failed_post_requeues_and_reports():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(500 if calls["n"] == 1 else 200)

    async def go():
        sink = _sink(handler)
        sink._accept("signal", {"id": "a", "symbol": "XAUUSD"})
        assert await sink.flush_once() is False
        assert sink.stats()["pending"] == 1 and sink.last_error
        assert await sink.flush_once() is True
        return sink

    sink = asyncio.run(go())
    assert sink.sent == 1 and sink.failed_batches == 1 and sink.last_error is None


def test_signal_buffer_drops_oldest_loudly():
    sink = _sink(lambda r: httpx.Response(200), CONVEX_SINK_BUFFER=100)
    for i in range(105):
        sink._accept("signal", {"id": str(i), "symbol": "X"})
    assert sink.dropped == 5 and sink._signals[0]["data"]["id"] == "5"


def test_server_side_rejections_are_surfaced():
    sink = _sink(lambda r: httpx.Response(200, json={"ok": True, "accepted": 0,
                                                     "rejected": ["signal missing id"]}))

    async def go():
        sink._accept("signal", {"id": "a", "symbol": "X"})
        await sink.flush_once()

    asyncio.run(go())
    assert sink.rejected == 1 and "rejected" in (sink.last_error or "")
