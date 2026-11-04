"""Engine diagnostics: rolling cycle metrics and one honest health verdict.

This is a read-side module. Nothing in the trading path depends on it:

* The engine already publishes an ``engine_telemetry`` event (``kind="cycle"``)
  at the end of every analysis cycle. ``DiagnosticCollector.run`` subscribes to
  that and keeps a bounded history.
* ``DiagnosticCollector.build_health`` is a pure function of that history plus
  the engine / feed / database snapshots the API layer already has, so it is
  unit-testable without a running service.

Rules this module follows (see AGENTS.md rule 1): an unknown value is ``None``,
never a made-up zero, and a problem is reported, never swallowed.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import psutil

log = logging.getLogger(__name__)

# A cycle error rate above this (share of symbol analyses that raised) is
# reported as critical: the engine is running but mostly failing.
CYCLE_ERROR_RATE_CRITICAL_PCT = 20.0
# The engine is declared stalled when no cycle has completed for this many
# analysis intervals (after the boot grace has elapsed).
STALL_INTERVALS = 4
MIN_STALL_MS = 60_000
MAX_FEED_NAMES_IN_MESSAGE = 5


@dataclass(slots=True)
class CycleMetrics:
    cycle_number: int
    duration_ms: float
    analyzed: int
    signaled: int
    waited: int
    errors: int
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))


@dataclass(slots=True)
class SystemHealth:
    timestamp_ms: int
    engine_enabled: bool
    engine_running: bool
    uptime_sec: float
    memory_mb: float
    cpu_percent: float
    cycles_completed: int
    last_cycle_duration_ms: float | None
    avg_cycle_duration_ms: float | None
    cycle_error_rate_pct: float | None
    feeds_total: int | None
    feeds_healthy: int | None
    feeds_unhealthy: int | None
    stale_series: int | None
    db_connected: bool | None
    circuit_breaker: str | None
    critical_issues: list[str]
    warnings: list[str]

    @property
    def status(self) -> str:
        if self.critical_issues:
            return "critical"
        if self.warnings:
            return "degraded"
        return "ok"

    def is_healthy(self) -> bool:
        return self.status != "critical"

    def as_dict(self) -> dict[str, Any]:
        """Wire format (camelCase, matching the rest of /api)."""
        return {
            "status": self.status,
            "timestamp": self.timestamp_ms,
            "engine": {
                "enabled": self.engine_enabled,
                "running": self.engine_running,
                "cyclesCompleted": self.cycles_completed,
                "lastCycleMs": self.last_cycle_duration_ms,
                "avgCycleMs": self.avg_cycle_duration_ms,
                "errorRatePct": self.cycle_error_rate_pct,
                "circuitBreaker": self.circuit_breaker,
            },
            "resources": {
                "memoryMb": self.memory_mb,
                "cpuPercent": self.cpu_percent,
                "uptimeSec": self.uptime_sec,
            },
            "feeds": {
                "total": self.feeds_total,
                "healthy": self.feeds_healthy,
                "unhealthy": self.feeds_unhealthy,
                "staleSeries": self.stale_series,
            },
            "persistence": {"connected": self.db_connected},
            "issues": {"critical": self.critical_issues, "warnings": self.warnings},
        }


class DiagnosticCollector:
    """Bounded cycle history + health verdict. Single-event-loop, no locks needed
    (every mutation is synchronous, so it cannot interleave)."""

    def __init__(self, max_history: int = 100) -> None:
        self.start_time = time.time()
        self.cycles: deque[CycleMetrics] = deque(maxlen=max_history)
        self.total_cycles = 0
        self._process = psutil.Process()
        # cpu_percent(None) measures since the previous call and never blocks;
        # the first call always returns 0.0, so prime it here.
        self._process.cpu_percent(None)

    # ------------------------------------------------------------- ingestion
    def record_cycle(self, duration_ms: float, analyzed: int, signaled: int,
                     waited: int, errors: int) -> None:
        self.total_cycles += 1
        self.cycles.append(CycleMetrics(self.total_cycles, duration_ms, analyzed,
                                        signaled, waited, errors))

    def ingest_telemetry(self, payload: Any) -> None:
        """Consume one ``engine_telemetry`` payload; ignore non-cycle kinds."""
        if not isinstance(payload, dict) or payload.get("kind") != "cycle":
            return
        try:
            self.record_cycle(
                float(payload["durationMs"]), int(payload["analyzed"]),
                int(payload["signaled"]), int(payload["waited"]), int(payload["errors"]),
            )
        except (KeyError, TypeError, ValueError):
            # A malformed cycle event is a contract break worth seeing, not hiding.
            log.warning("malformed engine cycle telemetry: %r", payload)

    async def run(self, bus: Any) -> None:
        """Long-running task: feed the collector from the event bus."""
        queue = bus.subscribe_queue("engine_telemetry")
        while True:
            _channel, payload = await queue.get()
            self.ingest_telemetry(payload)

    # --------------------------------------------------------------- verdict
    def build_health(
        self,
        *,
        engine_enabled: bool,
        engine_status: dict[str, Any] | None,
        feeds_report: dict[str, Any] | None,
        db_status: dict[str, Any] | None,
        analysis_interval_ms: int,
    ) -> SystemHealth:
        critical: list[str] = []
        warnings: list[str] = []
        now_ms = int(time.time() * 1000)
        status = engine_status or {}
        running = bool(status.get("running"))
        in_grace = int(status.get("bootGraceRemainingMs") or 0) > 0

        cycles = list(self.cycles)
        durations = [c.duration_ms for c in cycles]
        attempts = sum(c.analyzed + c.errors for c in cycles)
        errors = sum(c.errors for c in cycles)
        error_rate = round(errors / attempts * 100, 1) if attempts else None

        # ---- engine
        if not engine_enabled:
            warnings.append("Engine disabled (DISABLE_ENGINE=1): no live analysis")
        elif not running:
            critical.append("Engine loop is not running")
        elif not in_grace:
            stall_ms = max(MIN_STALL_MS, STALL_INTERVALS * analysis_interval_ms)
            last = cycles[-1].timestamp_ms if cycles else None
            if last is not None and now_ms - last > stall_ms:
                critical.append(f"Engine stalled: no completed cycle for {(now_ms - last) // 1000}s")
            elif last is None and (time.time() - self.start_time) * 1000 > stall_ms + int(
                    status.get("bootGraceRemainingMs") or 0):
                warnings.append("No analysis cycle has completed yet (check feeds)")
        if error_rate is not None and error_rate > CYCLE_ERROR_RATE_CRITICAL_PCT:
            critical.append(f"High analysis error rate: {error_rate}% of recent symbol runs failed")
        # States come from risk.stack.DrawdownGuard: CLOSED is healthy; WARNING and
        # HALF cut position sizing; OPEN blocks every new signal (trading halted).
        breaker = (status.get("circuitBreaker") or {}).get("state")
        if breaker == "OPEN":
            critical.append("Circuit breaker OPEN: trading is halted, no new signals")
        elif breaker in ("WARNING", "HALF"):
            warnings.append(f"Circuit breaker {breaker}: position sizing is reduced")

        # ---- feeds (disabled feeds are not failures)
        feeds_total = feeds_healthy = feeds_unhealthy = stale_series = None
        if feeds_report is not None:
            feeds = [f for f in feeds_report.get("feeds", []) if f.get("enabled", True)]
            feeds_total = len(feeds)
            feeds_healthy = sum(1 for f in feeds if f.get("connected"))
            feeds_unhealthy = feeds_total - feeds_healthy
            stale_series = int((feeds_report.get("summary") or {}).get("staleSeriesCount") or 0)
            down = [f.get("name", "?") for f in feeds if not f.get("connected")]
            if feeds_total and feeds_healthy == 0 and not in_grace:
                critical.append("All data feeds are disconnected")
            elif down:
                shown = ", ".join(down[:MAX_FEED_NAMES_IN_MESSAGE])
                more = f" (+{len(down) - MAX_FEED_NAMES_IN_MESSAGE} more)" if len(down) > MAX_FEED_NAMES_IN_MESSAGE else ""
                warnings.append(f"{len(down)} of {feeds_total} feeds disconnected: {shown}{more}")
            if stale_series:
                warnings.append(f"{stale_series} price series are stale")

        # ---- database
        db_connected: bool | None = None
        if db_status is not None:
            if not db_status.get("enabled", False):
                warnings.append("MongoDB not configured: persistence, login sessions and learning are unavailable")
            elif db_status.get("ok"):
                db_connected = True
            else:
                db_connected = False
                critical.append("Database is configured but unreachable")

        try:
            memory_mb = round(self._process.memory_info().rss / 1024 / 1024, 1)
            cpu = round(self._process.cpu_percent(None), 1)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            log.warning("could not read process resource usage", exc_info=True)
            memory_mb, cpu = 0.0, 0.0

        return SystemHealth(
            timestamp_ms=now_ms,
            engine_enabled=engine_enabled,
            engine_running=running,
            uptime_sec=round(time.time() - self.start_time, 1),
            memory_mb=memory_mb,
            cpu_percent=cpu,
            cycles_completed=self.total_cycles,
            last_cycle_duration_ms=durations[-1] if durations else None,
            avg_cycle_duration_ms=round(sum(durations) / len(durations), 1) if durations else None,
            cycle_error_rate_pct=error_rate,
            feeds_total=feeds_total,
            feeds_healthy=feeds_healthy,
            feeds_unhealthy=feeds_unhealthy,
            stale_series=stale_series,
            db_connected=db_connected,
            circuit_breaker=breaker,
            critical_issues=critical,
            warnings=warnings,
        )


__all__ = ["CycleMetrics", "DiagnosticCollector", "SystemHealth"]
