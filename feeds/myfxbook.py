"""Myfxbook Community Outlook — retail long/short positioning.

Free-tier forex sentiment: for each symbol, the percentage of Myfxbook users
holding long vs short positions right now. Extreme retail crowding is a
standard contrarian tell (retail is systematically wrong at extremes), and
`agents/sentiment.py` already has a fully-implemented contrarian check for
it (`ext.get("lsRatio")`, thresholds at >=2.0 / <=0.5) — it has simply never
had a real feed behind it. This is that feed.

Auth: email+password login returns a session token. Rather than track
session expiry, we log in fresh every poll cycle — at the default 30-minute
interval that is one extra request per cycle, well inside Myfxbook's limits,
and it avoids an entire class of "stale session" bugs for free.

Never fabricated: a login failure, a rejected request, or a response with no
usable rows leaves `_outlook` exactly as it was (or empty on first run).
`get_ratio()` returns None rather than a guess, so `SentimentAgent` correctly
skips the contrarian check instead of voting on a made-up number.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .base import FeedStats, fetch_json

log = logging.getLogger(__name__)

BASE = "https://www.myfxbook.com/api"

# Myfxbook's outlook symbols are plain 6-letter forex pairs / metals, already
# matching our internal symbol convention — no remapping needed.
SUPPORTED_SYMBOLS = {
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
    "EURGBP", "EURJPY", "GBPJPY", "AUDJPY", "EURAUD", "XAUUSD", "XAGUSD",
}


class MyfxbookFeed:
    name = "myfxbook"

    def __init__(self, email: str, password: str, poll_ms: int = 30 * 60_000) -> None:
        self.email = (email or "").strip()
        self.password = (password or "").strip()
        self.enabled = bool(self.email and self.password)
        self.stats = FeedStats(self.name, sorted(SUPPORTED_SYMBOLS), poll_ms=poll_ms, enabled=self.enabled)
        self._outlook: dict[str, dict[str, Any]] = {}

    # ---------------------------------------------------------------- reads
    def get_ratio(self, symbol: str) -> float | None:
        """Long/short ratio for `symbol` (long% / short%), or None if we have
        no current reading. This is exactly the shape `SentimentAgent`
        expects on `external["lsRatio"]`."""
        row = self._outlook.get(symbol.upper())
        if not row:
            return None
        short_pct = row.get("shortPercentage")
        long_pct = row.get("longPercentage")
        if not short_pct or short_pct <= 0 or long_pct is None:
            return None
        return round(long_pct / short_pct, 4)

    def snapshot(self) -> dict[str, Any]:
        return {sym: dict(row) for sym, row in self._outlook.items()}

    # ------------------------------------------------------------- network
    async def _login(self) -> str | None:
        try:
            d = await fetch_json(
                f"{BASE}/login.json?email={self.email}&password={self.password}", timeout=15)
        except Exception as exc:
            self.stats.mark_error(exc)
            return None
        if not isinstance(d, dict) or d.get("error"):
            self.stats.mark_error((d or {}).get("message") or "myfxbook login rejected")
            return None
        session = d.get("session")
        return session if session else None

    async def poll(self) -> None:
        if not self.enabled:
            return
        session = await self._login()
        if not session:
            return
        try:
            d = await fetch_json(f"{BASE}/get-community-outlook.json?session={session}", timeout=15)
        except Exception as exc:
            self.stats.mark_error(exc)
            return
        if not isinstance(d, dict) or d.get("error"):
            self.stats.mark_error((d or {}).get("message") or "myfxbook outlook rejected")
            return
        rows = d.get("symbols") or []
        outlook: dict[str, dict[str, Any]] = {}
        for row in rows:
            sym = str(row.get("name", "")).upper().replace("/", "")
            if sym not in SUPPORTED_SYMBOLS:
                continue
            try:
                short_pct = float(row["shortPercentage"])
                long_pct = float(row["longPercentage"])
            except (KeyError, TypeError, ValueError):
                continue
            outlook[sym] = {
                "shortPercentage": short_pct, "longPercentage": long_pct,
                "shortVolume": row.get("shortVolume"), "longVolume": row.get("longVolume"),
                "totalPositions": row.get("totalPositions"),
                "updatedAt": int(time.time() * 1000),
            }
        if not outlook:
            self.stats.mark_error("myfxbook outlook returned no usable symbols")
            return
        self._outlook = outlook
        self.stats.symbols = sorted(outlook)
        self.stats.mark_ok()

    async def run(self) -> None:
        while True:
            try:
                await self.poll()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.stats.mark_error(exc)
            await asyncio.sleep(self.stats.poll_ms / 1000.0)
