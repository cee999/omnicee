"""Feed base utilities shared by all sources."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger(__name__)

# Price source priority — identical to the Node engine. Higher wins.
SOURCE_RANK: dict[str, int] = {
    "mt5_ea": 100,
    "tradingview": 92,
    "deriv": 70,
    "finnhub": 60,
    "binance": 58,
    "exchangerate": 48,
    "stockdata": 45,
    "aletheia": 44,
    "candle": 40,
    "fred": 30,
    "treasury": 20,
    "yahoo": 42,
    "biquote": 46,
    "frankfurter": 43,
}

TF_MS: dict[str, int] = {
    "M1": 60_000, "M5": 300_000, "M15": 900_000, "M30": 1_800_000,
    "H1": 3_600_000, "H2": 7_200_000, "H4": 14_400_000, "H6": 21_600_000,
    "H8": 28_800_000, "H12": 43_200_000, "D1": 86_400_000, "W1": 604_800_000,
}

TF_SECONDS: dict[str, int] = {k: v // 1000 for k, v in TF_MS.items()}


def build_headers(ua: str) -> dict[str, str]:
    return {"User-Agent": ua}


@dataclass
class FeedStats:
    name: str
    symbols: list[str] = field(default_factory=list)
    last_ok_ms: float = 0.0
    poll_ms: int = 60_000
    connected: bool = False
    enabled: bool = True
    errors: int = 0

    def mark_ok(self) -> None:
        self.last_ok_ms = time.time() * 1000
        self.connected = True

    def mark_error(self, exc: Exception | str | None = None) -> None:
        self.connected = False
        self.errors += 1
        if exc is not None:
            log.warning("feed error: %s — %s", self.name, exc)

    def is_connected(self) -> bool:
        if not self.enabled:
            return False
        if self.poll_ms <= 0:
            return self.connected
        return (time.time() * 1000 - self.last_ok_ms) < 3 * self.poll_ms

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "connected": self.is_connected(),
            "symbols": self.symbols,
            "lastOkMs": round(self.last_ok_ms),
            "pollMs": self.poll_ms,
            "errors": self.errors,
            "enabled": self.enabled,
        }


async def fetch_json(url: str, *, timeout: float = 15.0, headers: dict[str, str] | None = None,
                     method: str = "GET", json_body: Any = None) -> Any:
    """GET/POST JSON with a hard timeout. Raises on HTTP >= 400."""
    async with httpx.AsyncClient(timeout=timeout, headers=headers or {}) as client:
        if method == "POST":
            r = await client.post(url, json=json_body)
        else:
            r = await client.get(url)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code} from {url}: {r.text[:120]}")
        return r.json()


def to_ms(ts: Any) -> int | None:
    """Normalize a timestamp to ms epoch. Values < 1e12 are treated as seconds."""
    if ts is None:
        return None
    try:
        v = float(ts)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    return int(v * 1000) if v < 1e12 else int(v)
