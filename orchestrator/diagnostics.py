"""Lightweight, dependency-backed diagnostics for the running service."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import psutil

log = logging.getLogger(__name__)


@dataclass(slots=True)
class CycleMetrics:
    cycle_number: int
    duration_ms: float
    analyzed: int
    signaled: int
    waited: int
    errors: int
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))


@dataclass(slots=True)
class FeedHealth:
    name: str
    connected: bool
    last_update_ms: int = 0
    symbols_covered: int = 0
    error_count: int = 0
    last_error: str | None = None
    latency_ms: float | None = None
    stale_threshold_ms: int = 90_000


@dataclass(slots=True)
class SystemHealth:
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))
    engine_running: bool = False
    uptime_sec: float = 0.0
    memory_mb: float = 0.0
    cpu_percent: float = 0.0
    cycles_completed: int = 0
    last_cycle_duration_ms: float = 0.0
    avg_cycle_duration_ms: float = 0.0
    cycle_error_rate: float = 0.0
    feeds_healthy: int = 0
    feeds_unhealthy: int = 0
    any_feed_stale: bool = False
    db_connected: bool | None = None
    signals_persisted_today: int = 0
    critical_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def is_healthy(self) -> bool:
        return self.engine_running and not self.critical_issues

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class DiagnosticCollector:
    """Concurrency-safe in-process metrics collector."""

    def __init__(self, max_history: int = 100) -> None:
        self.start_time = time.time()
        self.cycles: list[CycleMetrics] = []
        self.max_history = max_history
        self.process = psutil.Process()
        self.feeds: dict[str, FeedHealth] = {}
        self.last_health_report: SystemHealth | None = None
        self._lock = asyncio.Lock()

    async def record_cycle(self, duration_ms: float, analyzed: int, signaled: int,
                           waited: int, errors: int) -> None:
        async with self._lock:
            self.cycles.append(CycleMetrics(len(self.cycles), duration_ms, analyzed, signaled, waited, errors))
            if len(self.cycles) > self.max_history:
                self.cycles.pop(0)

    async def update_feed_health(self, feed_name: str, connected: bool, symbols_covered: int = 0,
                                 error: str | None = None, latency_ms: float | None = None) -> None:
        async with self._lock:
            health = self.feeds.setdefault(feed_name, FeedHealth(feed_name, connected))
            health.connected = connected
            health.symbols_covered = symbols_covered
            health.last_update_ms = int(time.time() * 1000)
            health.latency_ms = latency_ms
            if error:
                health.error_count += 1
                health.last_error = error

    async def generate_health_report(self, engine_running: bool, db_connected: bool | None = None,
                                     signals_today: int = 0) -> SystemHealth:
        async with self._lock:
            cycles = list(self.cycles)
            feeds = list(self.feeds.values())
        now_ms = int(time.time() * 1000)
        durations = [cycle.duration_ms for cycle in cycles]
        errors = sum(cycle.errors for cycle in cycles)
        stale = [feed.name for feed in feeds if feed.last_update_ms and now_ms - feed.last_update_ms > feed.stale_threshold_ms]
        critical: list[str] = []
        warnings: list[str] = []
        if not engine_running:
            critical.append("Engine loop is not running")
        if db_connected is False:
            warnings.append("Database is unavailable; persistence is disabled or reconnecting")
        if stale:
            warnings.append(f"Stale feeds: {', '.join(stale)}")
        if errors and errors / max(len(cycles), 1) > 0.2:
            critical.append("High cycle error rate")
        memory_mb = self.process.memory_info().rss / 1024 / 1024
        try:
            cpu = self.process.cpu_percent(interval=0.05)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            cpu = 0.0
        report = SystemHealth(
            engine_running=engine_running,
            uptime_sec=time.time() - self.start_time,
            memory_mb=memory_mb,
            cpu_percent=cpu,
            cycles_completed=len(cycles),
            last_cycle_duration_ms=durations[-1] if durations else 0.0,
            avg_cycle_duration_ms=sum(durations) / len(durations) if durations else 0.0,
            cycle_error_rate=errors / max(len(cycles), 1) * 100,
            feeds_healthy=sum(feed.connected for feed in feeds),
            feeds_unhealthy=sum(not feed.connected for feed in feeds),
            any_feed_stale=bool(stale),
            db_connected=db_connected,
            signals_persisted_today=signals_today,
            critical_issues=critical,
            warnings=warnings,
        )
        self.last_health_report = report
        return report

    async def log_health_summary(self) -> None:
        if self.last_health_report:
            log.info("system health: %s", self.last_health_report.as_dict())


__all__ = ["DiagnosticCollector", "SystemHealth", "FeedHealth", "CycleMetrics"]
