"""Convex sink: pushes engine output to Convex over an authenticated HTTP route.

Convex is the system of record and the realtime layer for the dashboard. This
process (feeds + engine) stays the producer because it needs long-lived
WebSockets that serverless functions cannot hold.

Rules inherited from AGENTS.md:
  * Never fabricate: only what the bus emitted is sent; nothing is defaulted.
  * Never swallow: failures are logged, counted, and exposed via stats() so
    /health can say "sink is failing" instead of the UI going quiet.
  * Never stall the trading loop: bounded buffer, drop-oldest, all I/O is
    off the analysis path.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Any

import httpx

from config import Settings
from services.bus import EventBus

log = logging.getLogger("omnicee.convex")

# Bus channel -> Convex event kind. Mapped at the boundary, like CHANNEL_ALIAS.
CHANNEL_KIND = {
    "signal": "signal",
    "market_update": "market",
    "feed_health": "feed_health",
    "engine_telemetry": "telemetry",
    "balance": "balance",
}
_COALESCE = {"market", "feed_health", "telemetry", "balance"}  # latest wins
BATCH_MAX = 100
RETRY_BACKOFF_S = (1, 2, 5, 15, 30)


class ConvexSink:
    def __init__(self, settings: Settings, bus: EventBus,
                 client: httpx.AsyncClient | None = None) -> None:
        self.enabled = settings.convex_enabled
        self._url = settings.CONVEX_SITE_URL.rstrip("/") + "/ingest"
        self._secret = settings.CONVEX_INGEST_SECRET
        self._flush_s = settings.CONVEX_SINK_FLUSH_MS / 1000
        self._cap = settings.CONVEX_SINK_BUFFER
        self._bus = bus
        self._client = client
        # Signals are never coalesced: every actionable signal is delivered.
        self._signals: deque[dict[str, Any]] = deque()
        self._latest: dict[tuple[str, str], dict[str, Any]] = {}
        self.sent = 0
        self.failed_batches = 0
        self.dropped = 0
        self.last_ok_at: int | None = None
        self.last_error: str | None = None

    # ---- intake ------------------------------------------------------------
    def _accept(self, channel: str, payload: Any) -> None:
        kind = CHANNEL_KIND.get(channel)
        if kind is None or not isinstance(payload, dict):
            return
        event = {"kind": kind, "data": payload, "at": int(time.time() * 1000)}
        if kind in _COALESCE:
            key = (kind, str(payload.get("symbol", "")))
            self._latest[key] = event
            return
        if len(self._signals) >= self._cap:
            self._signals.popleft()
            self.dropped += 1
            log.error("convex sink buffer full; dropped oldest signal")
        self._signals.append(event)

    # ---- delivery ----------------------------------------------------------
    def _drain(self) -> list[dict[str, Any]]:
        batch: list[dict[str, Any]] = []
        while self._signals and len(batch) < BATCH_MAX:
            batch.append(self._signals.popleft())
        for key in list(self._latest)[: BATCH_MAX - len(batch)]:
            batch.append(self._latest.pop(key))
        return batch

    def _requeue(self, batch: list[dict[str, Any]]) -> None:
        for ev in reversed(batch):
            if ev["kind"] in _COALESCE:
                self._latest.setdefault((ev["kind"], str(ev["data"].get("symbol", ""))), ev)
            elif len(self._signals) < self._cap:
                self._signals.appendleft(ev)
            else:
                self.dropped += 1

    async def _post(self, batch: list[dict[str, Any]]) -> None:
        client = self._client or httpx.AsyncClient(timeout=10)
        try:
            resp = await client.post(
                self._url, json={"events": batch},
                headers={"Authorization": f"Bearer {self._secret}"})
            resp.raise_for_status()
        finally:
            if self._client is None:
                await client.aclose()

    async def flush_once(self) -> bool:
        batch = self._drain()
        if not batch:
            return True
        try:
            await self._post(batch)
        except Exception as exc:
            self.failed_batches += 1
            self.last_error = f"{type(exc).__name__}: {exc}"
            log.error("convex ingest failed (%d events requeued): %s", len(batch), self.last_error)
            self._requeue(batch)
            return False
        self.sent += len(batch)
        self.last_ok_at = int(time.time() * 1000)
        self.last_error = None
        return True

    async def run(self) -> None:
        if not self.enabled:
            log.info("convex sink disabled (CONVEX_SITE_URL / CONVEX_INGEST_SECRET unset)")
            return
        q = self._bus.subscribe_queue(*CHANNEL_KIND)
        log.info("convex sink started -> %s", self._url)
        failures = 0
        while True:
            try:
                channel, payload = await asyncio.wait_for(q.get(), timeout=self._flush_s)
                self._accept(channel, payload)
                while not q.empty():
                    self._accept(*q.get_nowait())
            except asyncio.TimeoutError:
                pass
            ok = await self.flush_once()
            failures = 0 if ok else failures + 1
            if not ok:
                await asyncio.sleep(RETRY_BACKOFF_S[min(failures, len(RETRY_BACKOFF_S)) - 1])

    def stats(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled, "sent": self.sent,
            "failedBatches": self.failed_batches, "dropped": self.dropped,
            "pending": len(self._signals) + len(self._latest),
            "lastOkAt": self.last_ok_at, "lastError": self.last_error,
        }
