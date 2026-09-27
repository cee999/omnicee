"""System diagnostics and health monitoring for OMNICEE.

Provides real-time visibility into:
- Engine loop status and cycle latency
- Feed manager health (active connections, data staleness)
- Database connectivity and signal persistence
- Configuration validation at boot
- Memory and performance metrics
- Critical failure tracking and recovery
"""

from __future__ import annotations

import asyncio
import logging
import psutil
import sys
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Optional
from datetime import datetime, timedelta

log = logging.getLogger(__name__)


@dataclass
class FeedHealth:
    """Health status of individual feeds."""
    name: str
    connected: bool
    last_update_ms: int = 0
    symbols_covered: int = 0
    error_count: int = 0
    last_error: Optional[str] = None
    latency_ms: Optional[float] = None
    stale_threshold_ms: int = 90_000


@dataclass
class CycleMetrics:
    """Metrics from a single engine cycle."""
    cycle_number: int
    duration_ms: float
    analyzed: int
    signaled: int
    waited: int
    errors: int
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))

    @property
    def success_rate(self) -> float:
        total = self.analyzed + self.errors
        return (self.analyzed / total * 100) if total > 0 else 0.0


@dataclass
class SystemHealth:
    """Comprehensive system health snapshot."""
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))
    engine_running: bool = False
    uptime_sec: float = 0.0
    memory_mb: float = 0.0
    cpu_percent: float = 0.0
    
    # Engine metrics
    cycles_completed: int = 0
    last_cycle_duration_ms: float = 0.0
    avg_cycle_duration_ms: float = 0.0
    cycle_error_rate: float = 0.0
    
    # Feed health
    feeds_healthy: int = 0
    feeds_unhealthy: int = 0
    any_feed_stale: bool = False
    
    # Database
    db_connected: bool = False
    signals_persisted_today: int = 0
    
    # Critical issues
    critical_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def is_healthy(self) -> bool:
        """System is healthy if engine runs, feeds are mostly connected, no critical issues."""
        return (
            self.engine_running 
            and self.feeds_healthy > 0 
            and len(self.critical_issues) == 0
        )

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class DiagnosticCollector:
    """Collects and reports system diagnostics continuously."""
    
    def __init__(self, max_history: int = 100):
        self.start_time = time.time()
        self.cycles: list[CycleMetrics] = []
        self.max_history = max_history
        self.process = psutil.Process()
        self.feeds: dict[str, FeedHealth] = {}
        self.last_health_report: Optional[SystemHealth] = None
        self._lock = asyncio.Lock()
        self.critical_errors: list[tuple[float, str]] = []  # (timestamp, error)
        
    async def record_cycle(self, duration_ms: float, analyzed: int, signaled: int,
                          waited: int, errors: int) -> None:
        """Record metrics from a completed cycle."""
        async with self._lock:
            cycle = CycleMetrics(
                cycle_number=len(self.cycles),
                duration_ms=duration_ms,
                analyzed=analyzed,
                signaled=signaled,
                waited=waited,
                errors=errors,
            )
            self.cycles.append(cycle)
            if len(self.cycles) > self.max_history:
                self.cycles.pop(0)
            
            # Log high-latency cycles
            if duration_ms > 5000:
                log.warning(
                    "slow cycle detected",
                    extra={
                        "cycle": cycle.cycle_number,
                        "duration_ms": duration_ms,
                        "analyzed": analyzed,
                    }
                )
    
    async def update_feed_health(self, feed_name: str, connected: bool, 
                                symbols_covered: int = 0, error: Optional[str] = None,
                                latency_ms: Optional[float] = None) -> None:
        """Update health status for a feed."""
        async with self._lock:
            if feed_name not in self.feeds:
                self.feeds[feed_name] = FeedHealth(name=feed_name, connected=connected)
            
            health = self.feeds[feed_name]
            health.connected = connected
            health.symbols_covered = symbols_covered
            health.last_update_ms = int(time.time() * 1000)
            health.latency_ms = latency_ms
            
            if error:
                health.error_count += 1
                health.last_error = error
                log.warning(f"feed error: {feed_name}", extra={"error": error})
            
            log.debug(f"feed {feed_name} status: {'connected' if connected else 'disconnected'}")
    
    def record_critical_error(self, error: str) -> None:
        """Record a critical error that may require immediate attention."""
        timestamp = time.time()
        self.critical_errors.append((timestamp, error))
        if len(self.critical_errors) > 50:
            self.critical_errors.pop(0)
        log.critical("critical system error: %s", error)
    
    async def generate_health_report(self, 
                                    engine_running: bool,
                                    db_connected: bool = False,
                                    signals_today: int = 0) -> SystemHealth:
        """Generate comprehensive health report."""
        async with self._lock:
            cycles_copy = list(self.cycles)
        
        uptime = time.time() - self.start_time
        memory_info = self.process.memory_info()
        memory_mb = memory_info.rss / 1024 / 1024
        
        try:
            cpu_percent = self.process.cpu_percent(interval=0.1)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            cpu_percent = 0.0
        
        # Cycle statistics
        cycles_completed = len(cycles_copy)
        avg_duration = (sum(c.duration_ms for c in cycles_copy) / len(cycles_copy)) if cycles_copy else 0.0
        last_duration = cycles_copy[-1].duration_ms if cycles_copy else 0.0
        
        error_count = sum(c.errors for c in cycles_copy)
        cycle_error_rate = (error_count / cycles_completed * 100) if cycles_completed > 0 else 0.0
        
        # Feed health
        healthy_feeds = sum(1 for f in self.feeds.values() if f.connected)
        unhealthy_feeds = len(self.feeds) - healthy_feeds
        stale_feeds = [
            f.name for f in self.feeds.values()
            if f.last_update_ms and 
            (int(time.time() * 1000) - f.last_update_ms) > f.stale_threshold_ms
        ]
        
        # Build issues list
        critical_issues = []
        warnings = []
        
        # Check for critical problems
        if not engine_running:
            critical_issues.append("Engine loop is not running")
        
        if cycle_error_rate > 20:
            critical_issues.append(f"High cycle error rate: {cycle_error_rate:.1f}%")
        
        if unhealthy_feeds > 0 and unhealthy_feeds >= len(self.feeds) * 0.5:
            critical_issues.append(f"Majority of feeds disconnected: {unhealthy_feeds}/{len(self.feeds)}")
        
        if not db_connected:
            critical_issues.append("Database not connected - signals cannot persist")
        
        if last_duration > 10000:
            critical_issues.append(f"Last cycle took {last_duration:.0f}ms - possible deadlock")
        
        # Check for warnings
        if stale_feeds:
            warnings.append(f"Stale feeds: {', '.join(stale_feeds)}")
        
        if memory_mb > 400:
            warnings.append(f"High memory usage: {memory_mb:.0f}MB")
        
        if unhealthy_feeds > 0:
            warnings.append(f"{unhealthy_feeds} feeds disconnected")
        
        if avg_duration > 3000:
            warnings.append(f"Average cycle duration: {avg_duration:.0f}ms (expected <1000ms)")
        
        health = SystemHealth(
            engine_running=engine_running,
            uptime_sec=uptime,
            memory_mb=memory_mb,
            cpu_percent=cpu_percent,
            cycles_completed=cycles_completed,
            last_cycle_duration_ms=last_duration,
            avg_cycle_duration_ms=avg_duration,
            cycle_error_rate=cycle_error_rate,
            feeds_healthy=healthy_feeds,
            feeds_unhealthy=unhealthy_feeds,
            any_feed_stale=len(stale_feeds) > 0,
            db_connected=db_connected,
            signals_persisted_today=signals_today,
            critical_issues=critical_issues,
            warnings=warnings,
        )
        
        self.last_health_report = health
        return health
    
    async def log_health_summary(self) -> None:
        """Log a health summary at regular intervals."""
        if not self.last_health_report:
            return
        
        report = self.last_health_report
        status = "🟢 HEALTHY" if report.is_healthy() else "🔴 CRITICAL" if report.critical_issues else "🟡 DEGRADED"
        
        log.info(
            f"{status} | Engine: {'✓' if report.engine_running else '✗'} | "
            f"Feeds: {report.feeds_healthy}/{report.feeds_healthy + report.feeds_unhealthy} | "
            f"Cycles: {report.cycles_completed} | "
            f"Memory: {report.memory_mb:.0f}MB | "
            f"CPU: {report.cpu_percent:.1f}%",
            extra=asdict(report)
        )
        
        for issue in report.critical_issues:
            log.error(f"CRITICAL: {issue}")
        
        for warning in report.warnings:
            log.warning(f"WARNING: {warning}")


__all__ = ["DiagnosticCollector", "SystemHealth", "FeedHealth", "CycleMetrics"]
