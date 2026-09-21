"""FeedManager — owns candle stores, source-priority price resolution, and
the lifecycle of every live feed.

This is the Python replacement for the Node `index.js` feed wiring plus the
per-feed classes. Feed implementations live beside this module; the manager
starts them as asyncio tasks and consumes their outputs through callbacks.

Candle store layout (identical to Node):
    candleStores[symbol][timeframe] = [candle, ...]
    candle = {time, open, high, low, close, volume, source, isClosed}
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from config import Settings
from services.bus import EventBus
from services.persist import Persist

from .base import SOURCE_RANK, TF_MS

log = logging.getLogger(__name__)

MAX_CANDLES = 600
PRICE_HOLD_MS = 10_000

EmitFn = Callable[[str, Any], Awaitable[None]]


class CandleStore:
    """Aggregates ticks into candles and holds history per (symbol, tf)."""

    def __init__(self) -> None:
        self.stores: dict[str, dict[str, list[dict[str, Any]]]] = {}
        self.last_prices: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------- candles
    def seed(self, symbol: str, timeframe: str, candles: list[dict[str, Any]]) -> None:
        rows = [c for c in candles if self._valid(c)]
        rows.sort(key=lambda c: c["time"])
        self.stores.setdefault(symbol, {})[timeframe] = rows[-MAX_CANDLES:]

    def append(self, symbol: str, timeframe: str, candle: dict[str, Any]) -> None:
        if not self._valid(candle):
            return
        arr = self.stores.setdefault(symbol, {}).setdefault(timeframe, [])
        if arr and candle["time"] == arr[-1]["time"]:
            arr[-1] = candle
        elif not arr or candle["time"] > arr[-1]["time"]:
            arr.append(candle)
            if len(arr) > MAX_CANDLES:
                del arr[: len(arr) - MAX_CANDLES]

    def update_from_tick(self, symbol: str, timeframe: str, ts_ms: int, price: float,
                         source: str, volume: float = 0.0) -> None:
        bucket = (ts_ms // TF_MS[timeframe]) * TF_MS[timeframe]
        arr = self.stores.setdefault(symbol, {}).setdefault(timeframe, [])
        if arr and arr[-1]["time"] == bucket:
            c = arr[-1]
            c["high"] = max(c["high"], price)
            c["low"] = min(c["low"], price)
            c["close"] = price
            c["volume"] = c.get("volume", 0.0) + volume
            c["source"] = source
        elif not arr or bucket > arr[-1]["time"]:
            arr.append({"time": bucket, "open": price, "high": price, "low": price,
                        "close": price, "volume": volume, "source": source, "isClosed": True})
            if len(arr) > MAX_CANDLES:
                del arr[: len(arr) - MAX_CANDLES]

    def get(self, symbol: str, timeframe: str) -> list[dict[str, Any]]:
        return self.stores.get(symbol, {}).get(timeframe, [])

    def all(self) -> dict[str, dict[str, list[dict[str, Any]]]]:
        return self.stores

    @staticmethod
    def _valid(c: dict[str, Any]) -> bool:
        try:
            t = float(c["time"])
            o, h, lo, cl = float(c["open"]), float(c["high"]), float(c["low"]), float(c["close"])
        except (KeyError, TypeError, ValueError):
            return False
        return not (min(t, o, h, lo, cl) <= 0 or h < lo or o < lo or o > h or cl < lo or cl > h)


class FeedManager:
    def __init__(self, settings: Settings, bus: EventBus, emit: EmitFn) -> None:
        self.cfg = settings
        self.bus = bus
        self.emit = emit
        self.store = CandleStore()
        self.persist = Persist(interval_ms=settings.CANDLE_PERSIST_INTERVAL_MS)
        self.stats: dict[str, Any] = {}
        self._last_market_emit: dict[str, float] = {}
        self._hold_price: dict[str, tuple[float, int, str]] = {}  # symbol -> (price, until_ms, source)
        self._tasks: list[asyncio.Task[None]] = []
        self._tick_tasks: set[asyncio.Task[None]] = set()

    # ------------------------------------------------------------ ingestion
    async def on_price(self, symbol: str, price: float, source: str,
                       bid: float | None = None, ask: float | None = None,
                       change: float | None = None, ts_ms: int | None = None) -> None:
        if not (price and price > 0) or price != price:  # NaN guard
            return
        symbol = symbol.upper()
        now = int(time.time() * 1000)
        ts = ts_ms or now
        rank = SOURCE_RANK.get(source, 0)
        prev = self.store.last_prices.get(symbol, {})
        prev_rank = SOURCE_RANK.get(str(prev.get("source", "")), 0)
        # Source-priority with hold window: a lower-rank source cannot replace
        # a fresher higher-rank quote inside the hold period.
        if prev_rank > rank and (prev.get("atMs") or 0) + PRICE_HOLD_MS > now:
            return
        row = {
            "symbol": symbol, "price": price,
            "bid": bid if bid and bid > 0 else None,
            "ask": ask if ask and ask > 0 else None,
            "change": change if change is not None and change == change else None,
            "source": source, "atMs": now, "ts": ts,
        }
        self.store.last_prices[symbol] = row
        # Aggregate into the smallest tracked timeframes.
        for tf in self.cfg.timeframes:
            if tf in TF_MS:
                self.store.update_from_tick(symbol, tf, ts, price, source)
        if now - self._last_market_emit.get(symbol, 0) >= 2000:
            self._last_market_emit[symbol] = now
            await self.emit("market_update", {**row, "timestamp": ts})

    async def on_candles(self, symbol: str, timeframe: str, candles: list[dict[str, Any]], source: str) -> None:
        rows = []
        for c in candles:
            t = c.get("time") or c.get("timestamp")
            if t is None:
                continue
            t = int(t * 1000) if float(t) < 1e12 else int(t)
            rows.append({"time": t, "open": c.get("open"), "high": c.get("high"),
                         "low": c.get("low"), "close": c.get("close"),
                         "volume": c.get("volume") or 0.0, "source": source, "isClosed": True})
        self.store.seed(symbol, timeframe, rows)
        await self.emit("candles_seeded", {"symbol": symbol, "timeframe": timeframe, "count": len(rows)})

    def on_tick(self, symbol: str, price: float, source: str, **kw: Any) -> None:
        """Sync bridge for WS feeds running their own tasks."""
        loop = asyncio.get_running_loop()
        task = loop.create_task(self.on_price(symbol, price, source, **kw))
        self._tick_tasks.add(task)
        task.add_done_callback(self._tick_tasks.discard)

    # ------------------------------------------------------------ resolution
    def resolved_market_rows(self, symbols: list[str] | None = None) -> list[dict[str, Any]]:
        want = {s.upper() for s in (symbols or self.cfg.symbols)}
        rows = []
        for sym, row in self.store.last_prices.items():
            if sym in want:
                rows.append({k: row.get(k) for k in ("symbol", "price", "bid", "ask", "change", "source")})
        rows.sort(key=lambda r: r["symbol"])
        return rows

    def snapshot_rows(self) -> dict[str, dict[str, Any]]:
        return {s: dict(r) for s, r in self.store.last_prices.items()}

    # ------------------------------------------------------------ lifecycle
    def register(self, name: str, stats: Any) -> None:
        self.stats[name] = stats

    def spawn(self, coro: Any) -> None:
        self._tasks.append(asyncio.get_running_loop().create_task(coro))

    async def stop(self) -> None:
        """Cancel every spawned task (feeds, engine loop, persist, bridge)."""
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                continue
            except Exception:
                log.exception("task failed during shutdown")
        self._tasks.clear()

    async def health_report(self) -> dict[str, Any]:
        feeds = [s.as_dict() for s in self.stats.values()]
        stale = []
        now = time.time() * 1000
        for sym, tfs in self.store.all().items():
            for tf, arr in tfs.items():
                if arr:
                    age = now - arr[-1]["time"]
                    if age > TF_MS.get(tf, 3_600_000) * 3:
                        stale.append({"symbol": sym, "timeframe": tf, "ageMs": round(age)})
        return {
            "feeds": feeds,
            "staleSeries": stale,
            "summary": {
                "feedsTotal": len(feeds),
                "feedsDisconnected": sum(1 for f in feeds if not f["connected"]),
                "staleSeriesCount": len(stale),
                "checkedAt": int(now),
            },
            "ok": all(f["connected"] for f in feeds) and not stale,
        }

    async def persist_loop(self) -> None:
        while True:
            try:
                self.persist.save_candles(self.store.all(), self.store.last_prices)
                self.persist.save_market(self.resolved_market_rows())
            except Exception:
                log.exception("persist loop failed")
            await asyncio.sleep(self.cfg.CANDLE_PERSIST_INTERVAL_MS / 1000.0)
