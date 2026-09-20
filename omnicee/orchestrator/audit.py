"""Audit trail — every cycle outcome is recorded; silence is never an output."""

from __future__ import annotations

import time
from collections import deque
from typing import Any


class AuditTrail:
    def __init__(self, maxlen: int = 500) -> None:
        self._rows: deque[dict[str, Any]] = deque(maxlen=maxlen)

    def record(self, entry: dict[str, Any]) -> None:
        self._rows.append({**entry, "at": int(time.time() * 1000)})

    def tail(self, n: int = 50) -> list[dict[str, Any]]:
        return list(self._rows)[-n:]
