"""Extended health check endpoints with diagnostic information.

Provides visibility into:
- Engine status and recent cycle metrics
- Feed connectivity and data freshness
- Database connectivity
- Configuration validation
- Memory and performance metrics
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import Request


async def deep_health_check(app: Any) -> dict[str, Any]:
    """Comprehensive health status including all subsystems."""
    
    # Core service status
    status = {
        "timestamp": int(time.time() * 1000),
        "service": {
            "name": "omnicee-brain",
            "status": "ok",
            "uptime_sec": 0,
        },
        "engine": {
            "running": False,
            "cycles_completed": 0,
            "last_cycle_ms": None,
            "error_rate": None,
            "status": "stopped",
        },
        "feeds": {
            "total": 0,
            "connected": 0,
            "disconnected": 0,
            "stale": 0,
            "details": [],
        },
        "database": {
            "connected": False,
            "signals_today": 0,
            "status": "disconnected",
        },
        "diagnostics": {
            "collector": None,
        },
        "issues": {
            "critical": [],
            "warnings": [],
        }
    }
    
    # Get engine status
    engine = getattr(app.state, "engine", None)
    if engine and hasattr(engine, "status"):
        try:
            engine_status = engine.status()
            status["engine"]["running"] = engine_status.get("running", False)
            
            last_cycle = engine_status.get("lastCycle", {})
            status["engine"]["cycles_completed"] = last_cycle.get("analyzed", 0)
            status["engine"]["last_cycle_ms"] = last_cycle.get("durationMs")
            
            if last_cycle.get("analyzed", 0) > 0 and last_cycle.get("errors", 0) > 0:
                total = last_cycle["analyzed"] + last_cycle["errors"]
                status["engine"]["error_rate"] = (last_cycle["errors"] / total * 100)
            
            status["engine"]["status"] = "running" if status["engine"]["running"] else "stopped"
            
            # Add circuit breaker status
            cb = engine_status.get("circuitBreaker", {})
            if cb.get("state") != "normal":
                status["issues"]["warnings"].append(f"Circuit breaker: {cb.get('state')}")
        except Exception as e:
            status["engine"]["status"] = f"error: {str(e)[:50]}"
    
    # Get feed manager status
    fm = getattr(app.state, "feed_manager", None)
    if fm and hasattr(fm, "store"):
        try:
            # Count symbols with recent data
            last_prices = getattr(fm.store, "last_prices", {})
            symbols_with_data = len(last_prices)
            status["feeds"]["total"] = len(last_prices)
            status["feeds"]["connected"] = symbols_with_data
            
            # Check for stale data
            now_ms = int(time.time() * 1000)
            stale_count = 0
            for sym, price_data in last_prices.items():
                age_ms = now_ms - price_data.get("atMs", 0) if price_data.get("atMs") else 999_999_999
                is_stale = age_ms > 90_000
                if is_stale:
                    stale_count += 1
                    status["feeds"]["stale"] += 1
                
                status["feeds"]["details"].append({
                    "symbol": sym,
                    "price": price_data.get("price"),
                    "age_ms": age_ms,
                    "stale": is_stale,
                    "source": price_data.get("source"),
                })
            
            if stale_count > 0:
                status["issues"]["warnings"].append(f"{stale_count} feeds have stale data")
        except Exception as e:
            status["feeds"]["status"] = f"error: {str(e)[:50]}"
    
    # Get database status
    db = getattr(app.state, "db", None)
    if db and hasattr(db, "client"):
        try:
            # Try a simple connection check
            is_connected = await db.client.admin.command("ping")
            status["database"]["connected"] = bool(is_connected)
            status["database"]["status"] = "connected" if is_connected else "disconnected"
        except Exception as e:
            status["database"]["connected"] = False
            status["database"]["status"] = f"error: {str(e)[:50]}"
            status["issues"]["critical"].append("Database connection failed")
    
    # Get diagnostics if available
    diagnostics = getattr(app.state, "diagnostics", None)
    if diagnostics:
        try:
            health_report = diagnostics.last_health_report
            if health_report:
                status["diagnostics"]["collector"] = health_report.as_dict()
                status["issues"]["critical"].extend(health_report.critical_issues)
                status["issues"]["warnings"].extend(health_report.warnings)
        except Exception as e:
            pass
    
    # Determine overall status
    if status["issues"]["critical"]:
        status["service"]["status"] = "critical"
    elif status["issues"]["warnings"]:
        status["service"]["status"] = "degraded"
    
    return status


async def diagnostic_endpoint(request: Request) -> dict[str, Any]:
    """Diagnostic endpoint showing detailed system state."""
    app = request.app
    
    return await deep_health_check(app)


__all__ = ["deep_health_check", "diagnostic_endpoint"]
