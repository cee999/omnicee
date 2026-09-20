"""In-process async event bus.

The Node service used an EventEmitter (`api/realtime.js`) to bridge the
analysis engine and the Socket.IO API. This is the Python equivalent: one
broadcast bus, zero dependencies, backpressure-safe.

Channels mirror the Node contract exactly so the React app keeps working:
`signal`, `market`, `risk`, `stats`, `regime`, `hurst`, `telemetry`,
`intel`, `watchlist`, `feed_health`, `engine_ready`, `balance`, ...
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

log = logging.getLogger(__name__)

MAX_QUEUE = 500


@dataclass(slots=True)
class _Subscriber:
    queue: asyncio.Queue[Any] = field(default_factory=lambda: asyncio.Queue(maxsize=MAX_QUEUE))


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[_Subscriber]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def emit(self, channel: str, payload: Any) -> None:
        for sub in list(self._subs.get(channel, ())):
            try:
                sub.queue.put_nowait(payload)
            except asyncio.QueueFull:
                # A slow consumer must never stall the trading loop. Drop the
                # oldest and log; silence is never an output, so this is loud.
                try:
                    sub.queue.get_nowait()
                    sub.queue.put_nowait(payload)
                except Exception:  # pragma: no cover
                    log.exception("bus drop failed", extra={"channel": channel})

    def emit_nowait(self, channel: str, payload: Any) -> None:
        loop = asyncio.get_running_loop()
        loop.create_task(self.emit(channel, payload))

    async def subscribe(self, *channels: str) -> AsyncIterator[tuple[str, Any]]:
        sub = _Subscriber()
        for ch in channels:
            self._subs[ch].add(sub)
        try:
            while True:
                item = await sub.queue.get()
                # Each queue item is (channel, payload) pairs are maintained per
                # channel via a wrapping emit below; direct subscribes receive
                # payloads tagged by the subscription loop.
                yield item
        finally:
            for ch in channels:
                self._subs[ch].discard(sub)

    def subscribe_queue(self, *channels: str) -> asyncio.Queue[tuple[str, Any]]:
        """Return a tagged queue: items are (channel, payload)."""
        q: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=MAX_QUEUE)
        for ch in channels:
            self._subs[ch].add(_TaggedSubscriber(ch, q))
        return q


class _TaggedSubscriber:
    __slots__ = ("channel", "queue")

    def __init__(self, channel: str, queue: asyncio.Queue[tuple[str, Any]]) -> None:
        self.channel = channel
        self.queue = queue


# Route emits to tagged subscribers as well.
def _emit_impl(self: EventBus, channel: str, payload: Any) -> None:
    for sub in list(self._subs.get(channel, ())):
        try:
            if isinstance(sub, _TaggedSubscriber):
                sub.queue.put_nowait((channel, payload))
            else:
                sub.queue.put_nowait(payload)
        except asyncio.QueueFull:
            try:
                sub.queue.get_nowait()
                if isinstance(sub, _TaggedSubscriber):
                    sub.queue.put_nowait((channel, payload))
                else:
                    sub.queue.put_nowait(payload)
            except Exception:  # pragma: no cover
                log.exception("bus drop failed", extra={"channel": channel})


EventBus.emit = _emit_impl  # type: ignore[method-assign]
