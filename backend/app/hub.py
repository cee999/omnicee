"""In-process pub/sub. Every connected client gets its own bounded queue;
slow clients drop their oldest messages instead of stalling the feed.
Swap for Redis pub/sub when running more than one instance."""
import asyncio
from typing import Any


class Hub:
    def __init__(self) -> None:
        self._clients: set[asyncio.Queue] = set()
        self.latest: dict[str, dict[str, Any]] = {}

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._clients.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._clients.discard(q)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def publish(self, msg: dict[str, Any]) -> None:
        if msg.get("type") == "tick":
            self.latest[msg["symbol"]] = msg
        for q in list(self._clients):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(msg)
