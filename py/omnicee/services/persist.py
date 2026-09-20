"""File-based crash cache — port of Node `lib/persist.js`.

Atomic writes (tmp + rename) to `.cache/market.json` and `.cache/candles.json`
so a cold start can serve last-known candles instead of an empty dashboard.
Write-coalesced: at most one flush per interval.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


class Persist:
    def __init__(self, cache_dir: str = ".cache", interval_ms: int = 15_000) -> None:
        self._dir = Path(cache_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._interval = max(1000, interval_ms) / 1000.0
        self._last_flush = 0.0
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._pending_candles: dict[str, Any] | None = None

    def _atomic_write(self, name: str, payload: Any) -> None:
        path = self._dir / name
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            log.exception("persist write failed", extra={"file": name})

    def save_market(self, rows: list[dict[str, Any]]) -> None:
        self._atomic_write("market.json", {"ts": int(time.time() * 1000), "rows": rows[:200]})

    def save_candles(self, candle_stores: dict[str, Any], last_prices: dict[str, Any]) -> None:
        payload = {"ts": int(time.time() * 1000), "candles": {"candleStores": candle_stores, "lastPrices": last_prices}}
        now = time.time()
        with self._lock:
            if now - self._last_flush >= self._interval:
                self._last_flush = now
                self._pending_candles = None
                self._atomic_write("candles.json", payload)
                return
            self._pending_candles = payload
            if self._timer is None:
                delay = max(0.05, self._interval - (now - self._last_flush))
                self._timer = threading.Timer(delay, self._flush_pending)
                self._timer.daemon = True
                self._timer.start()

    def _flush_pending(self) -> None:
        with self._lock:
            payload, self._pending_candles, self._timer = self._pending_candles, None, None
            self._last_flush = time.time()
        if payload is not None:
            self._atomic_write("candles.json", payload)

    def load_market(self) -> list[dict[str, Any]] | None:
        return self._load("market.json", "rows")

    def load_candles(self) -> dict[str, Any] | None:
        wrapper = self._load("candles.json", "candles")
        return wrapper if isinstance(wrapper, dict) else None

    def _load(self, name: str, key: str) -> Any:
        path = self._dir / name
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data.get(key)
        except Exception:
            log.exception("persist load failed", extra={"file": name})
            return None
