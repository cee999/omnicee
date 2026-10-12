"""Per-provider feed health. This is what powers the status strip in the UI,
so a silent feed is visible instead of just looking dead."""
import time
from dataclasses import dataclass, field


@dataclass
class Provider:
    name: str
    state: str = "idle"  # idle | connecting | live | reconnecting | error
    last_msg_ts: float = 0.0
    msgs: int = 0
    reconnects: int = 0
    last_error: str = ""
    started: float = field(default_factory=time.time)


class HealthTracker:
    def __init__(self) -> None:
        self._p: dict[str, Provider] = {}

    def get(self, name: str) -> Provider:
        return self._p.setdefault(name, Provider(name))

    def set_state(self, name: str, state: str, error: str = "") -> None:
        p = self.get(name)
        p.state = state
        if error:
            p.last_error = error
        if state == "reconnecting":
            p.reconnects += 1

    def mark_msg(self, name: str) -> None:
        p = self.get(name)
        p.msgs += 1
        p.last_msg_ts = time.time()
        p.state = "live"

    def snapshot(self) -> list[dict]:
        now = time.time()
        out = []
        for p in self._p.values():
            age_ms = int((now - p.last_msg_ts) * 1000) if p.last_msg_ts else None
            state = p.state
            if state == "live" and age_ms is not None and age_ms > 10_000:
                state = "stale"
            out.append(
                {
                    "name": p.name,
                    "state": state,
                    "age_ms": age_ms,
                    "msgs": p.msgs,
                    "reconnects": p.reconnects,
                    "error": p.last_error,
                }
            )
        return out
