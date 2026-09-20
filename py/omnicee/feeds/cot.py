"""CFTC Commitments of Traders — fetch + parse + analysis.

Port of Node `cftc-cot-feed.js` + `cot-report-parser.js`. The critical
normalisation survives: inverted pairs (USDJPY, USDCHF, USDCAD) get long/short
swapped because CFTC reports foreign-currency contracts, opposite of the
USD-base trading convention.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from typing import Any

from .base import FeedStats, fetch_json

log = logging.getLogger(__name__)

UA = "omnicee-trading-system/1.0 (python backend)"
CONTRACTS = {
    "EURUSD": ("Euro FX - CME", False), "GBPUSD": ("British Pound Sterling - CME", False),
    "AUDUSD": ("Australian Dollar - CME", False), "NZDUSD": ("New Zealand Dollar - CME", False),
    "XAUUSD": ("GOLD - COMMODITY EXCHANGE INC.", False), "XAGUSD": ("SILVER - COMMODITY EXCHANGE INC.", False),
    "BTCUSDT": ("BITCOIN - CME", False), "BTCUSD": ("BITCOIN - CME", False),
    "USDJPY": ("JAPANESE YEN - CME", True), "USDCHF": ("SWISS FRANC - CME", True),
    "USDCAD": ("CANADIAN DOLLAR - CME", True),
}
HISTORY_WEEKS = 156
EXTREME_PERCENTILE = 95


class CotReport:
    """In-memory per-symbol COT history with analysis."""

    def __init__(self) -> None:
        self._history: dict[str, deque[dict[str, Any]]] = {}

    def ingest(self, symbol: str, rows: list[dict[str, Any]]) -> None:
        hist = self._history.setdefault(symbol, deque(maxlen=HISTORY_WEEKS))
        for r in rows:
            def _num(field: str) -> int:
                try:
                    return int(r.get(field) or 0)
                except (TypeError, ValueError):
                    return 0
            hist.append({
                "date": r.get("report_date_as_yyyy_mm_dd"),
                "commercialLong": _num("comm_positions_long_all"),
                "commercialShort": _num("comm_positions_short_all"),
                "largeSpecLong": _num("noncomm_positions_long_all"),
                "largeSpecShort": _num("noncomm_positions_short_all"),
                "smallSpecLong": _num("nonrept_positions_long_all"),
                "smallSpecShort": _num("nonrept_positions_short_all"),
                "openInterest": _num("open_interest_all"),
            })

    def analyze(self, symbol: str) -> dict[str, Any] | None:
        hist = list(self._history.get(symbol, ()))
        if not hist:
            return None
        latest = hist[-1]
        prev = hist[-2] if len(hist) > 1 else None

        def net(row: dict[str, Any], group: str) -> int:
            return row[f"{group}Long"] - row[f"{group}Short"]

        wow = None
        if prev:
            wow = {g: net(latest, g) - net(prev, g) for g in ("commercial", "largeSpec", "smallSpec")}
        spec_nets = [net(h, "largeSpec") for h in hist]
        if len(spec_nets) >= 2:
            rank = sum(1 for v in spec_nets if v < spec_nets[-1]) / len(spec_nets) * 100
        else:
            rank = 50.0
        is_extreme = rank >= EXTREME_PERCENTILE or rank <= (100 - EXTREME_PERCENTILE)
        if is_extreme and rank >= EXTREME_PERCENTILE:
            signal, note = "EXTREME_LONG_SPEC_REVERSAL_RISK", "large speculators crowded long"
        elif is_extreme:
            signal, note = "EXTREME_SHORT_SPEC_REVERSAL_RISK", "large speculators crowded short"
        else:
            signal, note = "NEUTRAL", None
        return {
            "symbol": symbol, "date": latest.get("date"),
            "commercial": {"net": net(latest, "commercial"), "long": latest["commercialLong"], "short": latest["commercialShort"]},
            "largeSpec": {"net": net(latest, "largeSpec"), "long": latest["largeSpecLong"], "short": latest["largeSpecShort"]},
            "smallSpec": {"net": net(latest, "smallSpec"), "long": latest["smallSpecLong"], "short": latest["smallSpecShort"]},
            "openInterest": latest["openInterest"],
            "weekOverWeekChange": wow,
            "largeSpecPercentile": round(rank, 1),
            "isExtreme": is_extreme, "signal": signal, "note": note,
        }

    def get_history(self, symbol: str, n: int = 12) -> list[dict[str, Any]]:
        return list(self._history.get(symbol, ()))[-n:]


class CotFeed:
    name = "cftc_cot"

    def __init__(self, parser: CotReport) -> None:
        self.parser = parser
        self.stats = FeedStats(self.name, list(CONTRACTS), poll_ms=12 * 3600_000)
        self.enabled = True
        self._cache: dict[str, tuple[float, list[dict[str, Any]] | None]] = {}

    async def fetch(self, symbol: str) -> list[dict[str, Any]] | None:
        entry = CONTRACTS.get(symbol)
        if not entry:
            return None
        contract, inverted = entry
        cached = self._cache.get(symbol)
        if cached and time.time() - cached[0] < 12 * 3600 and cached[1] is not None:
            return cached[1]
        url = (
            "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
            f"?$where=market_and_exchange_names='{contract}'"
            "&$order=report_date_as_yyyy_mm_dd DESC&$limit=2"
        )
        try:
            rows = await fetch_json(url, timeout=15)
            if not isinstance(rows, list):
                raise RuntimeError("CFTC returned non-array")
            if inverted:
                for r in rows:
                    for prefix in ("noncomm_positions", "comm_positions", "nonrept_positions"):
                        lo, sh = f"{prefix}_long_all", f"{prefix}_short_all"
                        r[lo], r[sh] = r.get(sh), r.get(lo)
            rows.reverse()  # oldest -> newest
            self._cache[symbol] = (time.time(), rows)
            self.parser.ingest(symbol, rows)
            self.stats.mark_ok()
            return rows
        except Exception as exc:
            self.stats.mark_error(exc)
            return cached[1] if cached else None

    async def run(self) -> None:
        while True:
            for sym in CONTRACTS:
                await self.fetch(sym)
            await asyncio_sleep(12 * 3600)


def asyncio_sleep(seconds: float) -> Any:
    import asyncio
    return asyncio.sleep(seconds)
