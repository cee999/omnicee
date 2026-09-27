"""OMNICee FastAPI application — RESTful backend with WebSocket push.

Handles:
  - Account and trade state queries
  - Signal analysis and backtesting
  - Live WebSocket connections
  - System diagnostics and health reporting
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request, WebSocketException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from config import Settings
from orchestrator.diagnostics import DiagnosticCollector, SystemHealth
from services.alerts import AlertManager
from services.auth import AuthManager
from services.bus import EventBus
from services.db import Database
from services.persist import PersistenceManager

log = logging.getLogger(__name__)


class AccountStatePayload(BaseModel):
    """Wire format for account state snapshots."""
    symbol: str
    balance: float
    equity: float
    margin_used: float
    margin_available: float
    open_positions: int = 0
    win_rate: float = Field(ge=0, le=100)
    profit_factor: float = 0.0
    dd_percent: float = 0.0

    def to_state(self) -> dict[str, Any]:
        """Convert to internal account state representation."""
        return {
            "symbol": self.symbol,
            "balance": self.balance,
            "equity": self.equity,
            "margin_used": self.margin_used,
            "margin_available": self.margin_available,
            "open_positions": self.open_positions,
            "win_rate": self.win_rate,
            "profit_factor": self.profit_factor,
            "dd_percent": self.dd_percent,
        }


class AnalyzeRequest(BaseModel):
    """Request payload for ad-hoc signal analysis."""
    symbol: str
    timeframe: str
    bars: int = Field(default=100, ge=20, le=1000)
    force_regime_recalc: bool = False


class CalibrationFitRequest(BaseModel):
    """Request payload for ensemble calibration fitting."""
    min_confidence: float = Field(default=0.6, ge=0.0, le=1.0)
    learning_samples: int = Field(default=100, ge=10, le=1000)


class HealthResponse(BaseModel):
    """Health check response."""
    ok: bool
    engine_running: bool
    diagnostics: SystemHealth | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan context: startup and shutdown."""
    log.info("backend starting")
    startup_state = app.state.__dict__.copy()
    yield
    log.info("backend shutting down")


def create_app(settings: Settings, bus: EventBus, db: Database, auth: AuthManager,
               persist: PersistenceManager, alerts: AlertManager,
               diagnostics: DiagnosticCollector) -> FastAPI:
    """Factory: create and configure the FastAPI application."""
    app = FastAPI(
        title="OMNICee",
        description="AI trading system — regime analysis, agent consensus, calibration, risk",
        version="0.1.0",
        lifespan=lifespan,
    )

    # ========================================================================
    # CORS Configuration
    # ========================================================================
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ========================================================================
    # State Injection
    # ========================================================================
    app.state.settings = settings
    app.state.bus = bus
    app.state.db = db
    app.state.auth = auth
    app.state.persist = persist
    app.state.alerts = alerts
    app.state.diagnostics = diagnostics

    # ========================================================================
    # Health and Diagnostics Endpoints
    # ========================================================================

    @app.get("/health")
    async def health() -> dict[str, Any]:
        """Simple health check for load balancers."""
        engine_running = getattr(app.state, "engine_running", False)
        return {
            "ok": True,
            "engine_running": engine_running,
            "service": "omnicee-brain",
        }

    @app.get("/health/detailed")
    async def health_detailed(request: Request) -> HealthResponse:
        """Detailed health including diagnostics and subsystem status."""
        diagnostics_obj = request.app.state.diagnostics
        db = request.app.state.db
        engine_running = getattr(request.app.state, "engine_running", False)
        db_connected = db.enabled and db._connected
        report = await diagnostics_obj.generate_health_report(engine_running, db_connected)
        return HealthResponse(ok=report.is_healthy(), engine_running=engine_running, diagnostics=report)

    @app.get("/api/diagnostics")
    async def get_diagnostics(request: Request) -> dict[str, Any]:
        """Real-time system diagnostics: cycles, feeds, memory, CPU, issues."""
        diagnostics_obj = request.app.state.diagnostics
        db = request.app.state.db
        engine_running = getattr(request.app.state, "engine_running", False)
        db_connected = db.enabled and db._connected
        report = await diagnostics_obj.generate_health_report(engine_running, db_connected)
        return report.as_dict()

    @app.get("/api/system-status")
    async def get_system_status(request: Request) -> dict[str, Any]:
        """High-level system status for UI dashboard."""
        diagnostics_obj = request.app.state.diagnostics
        db = request.app.state.db
        settings = request.app.state.settings
        engine_running = getattr(request.app.state, "engine_running", False)
        db_connected = db.enabled and db._connected
        report = await diagnostics_obj.generate_health_report(engine_running, db_connected)
        return {
            "online": report.is_healthy(),
            "engine": {
                "running": engine_running,
                "cycles_completed": report.cycles_completed,
                "avg_cycle_ms": round(report.avg_cycle_duration_ms, 1),
                "last_cycle_ms": round(report.last_cycle_duration_ms, 1),
                "error_rate_pct": round(report.cycle_error_rate, 1),
            },
            "resources": {
                "memory_mb": round(report.memory_mb, 1),
                "cpu_percent": round(report.cpu_percent, 1),
                "uptime_sec": round(report.uptime_sec, 0),
            },
            "feeds": {
                "healthy": report.feeds_healthy,
                "unhealthy": report.feeds_unhealthy,
                "any_stale": report.any_feed_stale,
            },
            "persistence": {
                "connected": db_connected,
                "signals_today": report.signals_persisted_today,
            },
            "alerts": {
                "critical": len(report.critical_issues),
                "warnings": len(report.warnings),
                "issues": report.critical_issues,
            },
            "config": {
                "mode": "production" if settings.is_production else "development",
                "symbols": settings.symbols,
                "timeframes": settings.timeframes,
            },
        }

    # ========================================================================
    # Placeholder: Existing endpoints will be imported from api.server module
    # ========================================================================

    return app


__all__ = [
    "create_app",
    "AccountStatePayload",
    "AnalyzeRequest",
    "CalibrationFitRequest",
    "HealthResponse",
]
