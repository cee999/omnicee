"""Health verdict logic: every branch that can turn the dashboard red or amber."""

from __future__ import annotations

import asyncio
import time

from orchestrator.diagnostics import (
    CYCLE_ERROR_RATE_CRITICAL_PCT,
    DiagnosticCollector,
)

INTERVAL = 45_000
RUNNING = {"running": True, "bootGraceRemainingMs": 0, "circuitBreaker": {"state": "CLOSED"}}
HEALTHY_FEEDS = {
    "feeds": [{"name": "deriv", "connected": True, "enabled": True},
              {"name": "binance", "connected": True, "enabled": True}],
    "summary": {"staleSeriesCount": 0},
}
DB_OK = {"ok": True, "enabled": True}


def health(c: DiagnosticCollector, **kw):
    args = dict(engine_enabled=True, engine_status=RUNNING, feeds_report=HEALTHY_FEEDS,
                db_status=DB_OK, analysis_interval_ms=INTERVAL)
    args.update(kw)
    return c.build_health(**args)


def cycle(c, errors=0, analyzed=6):
    c.record_cycle(100.0, analyzed, 1, analyzed - 1, errors)


def test_healthy_system_is_ok_with_no_issues():
    c = DiagnosticCollector()
    cycle(c)
    h = health(c)
    assert h.status == "ok" and h.is_healthy()
    assert h.critical_issues == [] and h.warnings == []
    assert h.feeds_healthy == 2 and h.db_connected is True


def test_unknowns_are_none_not_fabricated_zeros():
    c = DiagnosticCollector()
    h = health(c, feeds_report=None, db_status=None)
    assert h.last_cycle_duration_ms is None and h.avg_cycle_duration_ms is None
    assert h.cycle_error_rate_pct is None
    assert h.feeds_total is None and h.stale_series is None and h.db_connected is None


def test_cycle_counter_is_total_not_capped_at_history():
    c = DiagnosticCollector(max_history=5)
    for _ in range(12):
        cycle(c)
    assert c.total_cycles == 12 and len(c.cycles) == 5
    assert health(c).cycles_completed == 12
    assert c.cycles[-1].cycle_number == 12


def test_engine_not_running_is_critical_but_disabled_engine_is_a_warning():
    c = DiagnosticCollector()
    h = health(c, engine_status={"running": False})
    assert "Engine loop is not running" in h.critical_issues
    h = health(c, engine_enabled=False, engine_status=None)
    assert h.critical_issues == [] and any("DISABLE_ENGINE" in w for w in h.warnings)


def test_high_error_rate_is_critical_and_uses_symbol_attempts():
    c = DiagnosticCollector()
    cycle(c, errors=2, analyzed=6)               # 2 / 8 = 25% of attempts
    h = health(c)
    assert h.cycle_error_rate_pct == 25.0 > CYCLE_ERROR_RATE_CRITICAL_PCT
    assert any("error rate" in i for i in h.critical_issues)


def test_few_errors_are_not_critical():
    c = DiagnosticCollector()
    cycle(c, errors=1, analyzed=19)              # 5%
    assert health(c).critical_issues == []


def test_stalled_engine_is_critical():
    c = DiagnosticCollector()
    cycle(c)
    c.cycles[-1].timestamp_ms = int(time.time() * 1000) - 10 * INTERVAL
    h = health(c)
    assert any("stalled" in i for i in h.critical_issues)


def test_boot_grace_suppresses_stall_and_all_feeds_down_criticals():
    c = DiagnosticCollector()
    grace = {"running": True, "bootGraceRemainingMs": 30_000}
    all_down = {"feeds": [{"name": "deriv", "connected": False, "enabled": True}],
                "summary": {"staleSeriesCount": 0}}
    h = health(c, engine_status=grace, feeds_report=all_down)
    assert h.critical_issues == []


def test_all_feeds_down_after_grace_is_critical_partial_is_warning():
    c = DiagnosticCollector()
    cycle(c)
    down = {"feeds": [{"name": "a", "connected": False, "enabled": True},
                      {"name": "b", "connected": False, "enabled": True}],
            "summary": {"staleSeriesCount": 0}}
    assert "All data feeds are disconnected" in health(c, feeds_report=down).critical_issues
    partial = {"feeds": [{"name": "a", "connected": True, "enabled": True},
                         {"name": "b", "connected": False, "enabled": True}],
               "summary": {"staleSeriesCount": 3}}
    h = health(c, feeds_report=partial)
    assert h.critical_issues == [] and h.status == "degraded"
    assert any("1 of 2 feeds" in w for w in h.warnings)
    assert any("3 price series are stale" in w for w in h.warnings)


def test_disabled_feeds_are_not_counted_as_failures():
    c = DiagnosticCollector()
    cycle(c)
    rep = {"feeds": [{"name": "a", "connected": True, "enabled": True},
                     {"name": "off", "connected": False, "enabled": False}],
           "summary": {"staleSeriesCount": 0}}
    h = health(c, feeds_report=rep)
    assert h.feeds_total == 1 and h.feeds_unhealthy == 0 and h.warnings == []


def test_database_states():
    c = DiagnosticCollector()
    cycle(c)
    assert health(c, db_status={"ok": False, "enabled": True}).critical_issues == [
        "Database is configured but unreachable"]
    h = health(c, db_status={"ok": True, "enabled": False})
    assert h.db_connected is None and any("not configured" in w for w in h.warnings)


def test_circuit_breaker_states_map_to_the_right_severity():
    c = DiagnosticCollector()
    cycle(c)
    closed = health(c)                                         # CLOSED = healthy, silent
    assert closed.circuit_breaker == "CLOSED" and closed.status == "ok"
    for state in ("WARNING", "HALF"):
        h = health(c, engine_status={**RUNNING, "circuitBreaker": {"state": state}})
        assert h.critical_issues == [] and any(state in w for w in h.warnings)
    h = health(c, engine_status={**RUNNING, "circuitBreaker": {"state": "OPEN"}})
    assert h.status == "critical" and any("trading is halted" in i for i in h.critical_issues)


def test_ingest_telemetry_only_accepts_wellformed_cycle_events():
    c = DiagnosticCollector()
    c.ingest_telemetry({"kind": "no_prices", "at": 1})
    c.ingest_telemetry("garbage")
    c.ingest_telemetry({"kind": "cycle", "durationMs": "x"})      # malformed: logged, not recorded
    assert c.total_cycles == 0
    c.ingest_telemetry({"kind": "cycle", "durationMs": 12.5, "analyzed": 5,
                        "signaled": 1, "waited": 4, "errors": 0, "at": 1})
    assert c.total_cycles == 1 and c.cycles[-1].duration_ms == 12.5


def test_run_consumes_cycles_from_the_event_bus():
    from services.bus import EventBus

    async def scenario() -> int:
        bus, c = EventBus(), DiagnosticCollector()
        task = asyncio.create_task(c.run(bus))
        await asyncio.sleep(0)                    # let it subscribe
        await bus.emit("engine_telemetry", {"kind": "cycle", "durationMs": 9.0, "analyzed": 3,
                                            "signaled": 0, "waited": 3, "errors": 0})
        await bus.emit("engine_telemetry", {"kind": "no_prices"})
        await asyncio.sleep(0.05)
        task.cancel()
        return c.total_cycles

    assert asyncio.run(scenario()) == 1


def test_wire_format_is_camel_case_and_complete():
    c = DiagnosticCollector()
    cycle(c)
    d = health(c).as_dict()
    assert d["status"] == "ok"
    assert set(d) == {"status", "timestamp", "engine", "resources", "feeds", "persistence", "issues"}
    assert {"cyclesCompleted", "lastCycleMs", "avgCycleMs", "errorRatePct"} <= set(d["engine"])
    assert d["resources"]["memoryMb"] > 0
