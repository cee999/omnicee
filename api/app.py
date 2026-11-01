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

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from api.server import router as server_router
from config import Settings, get_settings
from orchestrator.diagnostics import DiagnosticCollector, SystemHealth
from services.alerts import AlertManager
from services.auth import AuthService
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
    yield
    log.info("backend shutting down")


def create_app(
    settings: Settings,
    bus: EventBus,
    db: Database,
    auth: AuthService,
    persist: PersistenceManager,
    alerts: AlertManager,
    diagnostics: DiagnosticCollector,
) -> FastAPI:
    """Factory: create and configure the FastAPI application."""
    app = FastAPI(
        title="OMNICee",
        description="AI trading system — regime analysis, agent consensus, calibration, risk",
        version="0.1.0",
        lifespan=lifespan,
    )

    origins = [origin.strip() for origin in settings.CORS_ORIGIN.split(",") if origin.strip()]
    if not origins:
        origins = ["*"]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.settings = settings
    app.state.bus = bus
    app.state.db = db
    app.state.auth = auth
    app.state.persist = persist
    app.state.alerts = alerts
    app.state.diagnostics = diagnostics
    app.state.engine_running = False

    app.include_router(server_router)

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
        db_connected = bool(getattr(db, "enabled", False) and getattr(db, "_connected", False))
        report = await diagnostics_obj.generate_health_report(engine_running, db_connected)
        return HealthResponse(ok=report.is_healthy(), engine_running=engine_running, diagnostics=report)

    @app.get("/api/diagnostics")
    async def get_diagnostics(request: Request) -> dict[str, Any]:
        """Real-time system diagnostics: cycles, feeds, memory, CPU, issues."""
        diagnostics_obj = request.app.state.diagnostics
        db = request.app.state.db
        engine_running = getattr(request.app.state, "engine_running", False)
        db_connected = bool(getattr(db, "enabled", False) and getattr(db, "_connected", False))
        report = await diagnostics_obj.generate_health_report(engine_running, db_connected)
        return report.as_dict()

    @app.get("/api/system-status")
    async def get_system_status(request: Request) -> dict[str, Any]:
        """High-level system status for UI dashboard."""
        diagnostics_obj = request.app.state.diagnostics
        db = request.app.state.db
        settings = request.app.state.settings
        engine_running = getattr(request.app.state, "engine_running", False)
        db_connected = bool(getattr(db, "enabled", False) and getattr(db, "_connected", False))
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

    return app


settings = get_settings()
bus = EventBus()
db = Database(
    uri=settings.MONGODB_URI,
    db_name=settings.MONGODB_DB,
    max_pool=settings.MONGODB_MAX_POOL,
    signal_ttl_days=settings.MONGODB_SIGNAL_TTL_DAYS,
    telemetry_ttl_days=settings.MONGODB_TELEMETRY_TTL_DAYS,
    disable_signals=settings.DISABLE_MONGO_SIGNALS,
)
auth = AuthService(settings, db)
persist = PersistenceManager()
alerts = AlertManager()
diagnostics = DiagnosticCollector()

asgi = create_app(
    settings=settings,
    bus=bus,
    db=db,
    auth=auth,
    persist=persist,
    alerts=alerts,
    diagnostics=diagnostics,
)


__all__ = [
    "create_app",
    "asgi",
    "AccountStatePayload",
    "AnalyzeRequest",
    "CalibrationFitRequest",
    "HealthResponse",
]
