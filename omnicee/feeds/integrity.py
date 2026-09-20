"""Data integrity monitor — port of Node `feeds/data-integrity-monitor.js`.

Two invalid conditions: an explicitly disconnected feed, and a candle series
whose last bar is older than timeframe x staleFactor (default 3).
"""

from __future__ import annotations

import time
from typing import Any

from .base import TF_MS


class DataIntegrityMonitor:
    def __init__(self, stale_factor: float = 3.0) -> None:
        self.stale_factor = stale_factor

    def check(self, feeds: list[Any], candle_stores: dict[str, dict[str, list[dict[str, Any]]]]) -> dict[str, Any]:
        now = time.time() * 1000
        feed_rows = []
        for f in feeds:
            try:
                connected = f.is_connected()
            except Exception:
                connected = None
            feed_rows.append({"name": getattr(f, "name", str(f)), "connected": connected,
                              "status": "ok" if connected in (True, None) else "disconnected",
                              "symbols": getattr(f, "symbols", [])})
        stale = []
        for sym, tfs in candle_stores.items():
            for tf, arr in tfs.items():
                tf_ms = TF_MS.get(tf)
                if tf_ms is None or not arr:
                    continue
                ts = arr[-1].get("time") or arr[-1].get("timestamp")
                if ts is None:
                    continue
                age = now - float(ts)
                if age > tf_ms * self.stale_factor:
                    stale.append({"symbol": sym, "timeframe": tf, "ageMs": round(age),
                                  "thresholdMs": tf_ms * self.stale_factor})
        disconnected = sum(1 for f in feed_rows if f["connected"] is False)
        return {
            "ok": disconnected == 0 and not stale,
            "feeds": feed_rows,
            "staleSeries": stale,
            "summary": {"feedsTotal": len(feed_rows), "feedsDisconnected": disconnected,
                        "staleSeriesCount": len(stale), "checkedAt": int(now)},
        }
