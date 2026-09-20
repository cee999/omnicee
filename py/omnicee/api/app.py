"""FastAPI application — the brain's only interface.

This service is never exposed to browsers. The Node edge holds the feeds,
the auth and the public surface; it calls this service over the private
network with a shared secret. That boundary is deliberate:

  * a crashed brain cannot drop ticks (Node still has the feeds)
  * a dead feed cannot crash analysis
  * the brain can be restarted, redeployed or scaled without touching the
    socket layer the mobile app depends on

Every route validates its body against the contracts module, so a
frontend/backend field-name disagreement is a 422 at the boundary rather than
a wrong number on a chart.
"""

from __future__ import annotations

import logging
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..contracts.market import MarketSnapshot
from ..contracts.signals import AnalysisResult
from ..ensemble.calibration import Calibrator
from ..pipeline import PipelineDeps, analyse
from ..risk.gates import AccountState

log = logging.getLogger("omnicee.api")

SERVICE_VERSION = "0.1.0"
_STARTED_AT = time.time()


class AccountStatePayload(BaseModel):
    balance: float = Field(default=0.0, ge=0.0)
    daily_pnl_pct: float = 0.0
    drawdown_pct: float = Field(default=0.0, ge=0.0)
    consecutive_losses: int = Field(default=0, ge=0)
    trades_today: int = Field(default=0, ge=0)
    open_positions: int = Field(default=0, ge=0)

    def to_state(self) -> AccountState:
        return AccountState(
            balance=self.balance,
            daily_pnl_pct=self.daily_pnl_pct,
            drawdown_pct=self.drawdown_pct,
            consecutive_losses=self.consecutive_losses,
            trades_today=self.trades_today,
            open_positions=self.open_positions,
            known=True,
        )


class AnalyzeRequest(BaseModel):
    snapshot: MarketSnapshot
    account: AccountStatePayload | None = None


class CalibrationFitRequest(BaseModel):
    """Closed outcomes used to refit the probability curve."""

    scores: list[float] = Field(..., min_length=1, max_length=50_000)
    wins: list[int] = Field(..., min_length=1, max_length=50_000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = get_settings()
    app.state.settings = cfg
    app.state.calibrator = Calibrator(min_samples=cfg.CALIBRATION_MIN_SAMPLES)
    log.info(
        "brain starting",
        extra={"env": cfg.NODE_ENV, "symbols": len(cfg.symbols), "version": SERVICE_VERSION},
    )
    # ---- full backend wiring (feeds + engine + socket bridge) ----
    # Never under pytest: live WS feeds would keep the loop alive forever.
    if not cfg.DISABLE_ENGINE and cfg.NODE_ENV != "test":
        from ..services.bus import EventBus
        from ..services.db import Database
        from .server import start_backend

        app.state.bus = EventBus()
        app.state.db = Database(
            cfg.MONGODB_URI, cfg.MONGODB_DB, cfg.MONGODB_MAX_POOL,
            cfg.MONGODB_SIGNAL_TTL_DAYS, cfg.MONGODB_TELEMETRY_TTL_DAYS,
            cfg.DISABLE_MONGO_SIGNALS)
        app.state.backend = await start_backend(app)
    yield
    engine = getattr(app.state, "engine", None)
    if engine:
        engine.stop()
    log.info("brain shutting down")


app = FastAPI(
    title="OMNICee Brain",
    version=SERVICE_VERSION,
    description="Analytical core. Consumed by the OMNICee Node edge, never by browsers.",
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/openapi.json",
)


def require_secret(
    x_brain_secret: Annotated[str | None, Header()] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    """Constant-time shared-secret check.

    In development with no secret configured the check is skipped, and that
    fact is logged loudly. In production, config validation has already made
    the secret mandatory, so this can never silently no-op there.
    """
    expected = settings.BRAIN_SHARED_SECRET
    if not expected:
        if settings.is_production:  # pragma: no cover - config guards this
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "secret not configured")
        return
    if not x_brain_secret or not secrets.compare_digest(x_brain_secret, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or missing brain secret")


@app.middleware("http")
async def request_context(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    request.state.request_id = rid
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        log.exception("unhandled error", extra={"request_id": rid, "path": request.url.path})
        return JSONResponse(
            status_code=500,
            content={"error": "internal error", "requestId": rid},
            headers={"x-request-id": rid},
        )
    response.headers["x-request-id"] = rid
    response.headers["x-response-time-ms"] = f"{(time.perf_counter() - started) * 1000:.1f}"
    return response


@app.get("/health", tags=["ops"])
async def health(settings: Settings = Depends(get_settings)) -> dict[str, object]:
    """Liveness + readiness. Never requires auth — Render polls it."""
    cal = getattr(app.state, "calibrator", None)
    return {
        "status": "ok",
        "service": settings.SERVICE_NAME,
        "version": SERVICE_VERSION,
        "env": settings.NODE_ENV,
        "uptimeSec": round(time.time() - _STARTED_AT, 1),
        "symbols": settings.symbols,
        "timeframes": settings.timeframes,
        "calibration": cal.report.as_dict() if cal else None,
        "authRequired": bool(settings.BRAIN_SHARED_SECRET),
    }


@app.post(
    "/v1/analyze",
    response_model=AnalysisResult,
    dependencies=[Depends(require_secret)],
    tags=["analysis"],
)
async def analyze(req: AnalyzeRequest, request: Request) -> AnalysisResult:
    """Analyse one symbol. Always 200 with a body — `signal` is null when
    nothing fired, and `blockedReasons` says why."""
    deps = PipelineDeps(settings=app.state.settings, calibrator=app.state.calibrator)
    account = req.account.to_state() if req.account else AccountState()
    return await analyse(
        req.snapshot, deps, account=account, request_id=request.state.request_id
    )


@app.post("/v1/calibration/fit", dependencies=[Depends(require_secret)], tags=["analysis"])
async def fit_calibration(req: CalibrationFitRequest) -> dict[str, object]:
    """Refit the score-to-probability curve on closed trade outcomes."""
    if len(req.scores) != len(req.wins):
        raise HTTPException(422, "scores and wins must be the same length")
    report = app.state.calibrator.fit(req.scores, req.wins)
    return report.as_dict()


@app.get("/v1/agents", dependencies=[Depends(require_secret)], tags=["analysis"])
async def list_agents() -> list[dict[str, object]]:
    """Introspection for the UI's pipeline view."""
    from ..agents.registry import build_agents

    return [
        {"name": a.name, "baseWeight": a.base_weight, "minBars": a.min_bars}
        for a in build_agents()
    ]


# ---- full public surface (replaces the Node api/server.js routes) ----
from .server import router as api_router, sio  # noqa: E402

app.include_router(api_router)

import socketio as _socketio  # noqa: E402

# Combined ASGI entrypoint: Socket.IO at /socket.io/*, FastAPI elsewhere.
asgi = _socketio.ASGIApp(sio, other_asgi_app=app, socketio_path="socket.io")


@app.get("/api/socket-health", tags=["ops"], include_in_schema=False)
async def socket_health() -> dict[str, object]:
    return {"ok": True, "transport": "socket.io", "path": "socket.io"}


# ---- static React dashboard (webapp-react/dist), built at deploy time ----
# The Node service used to serve this; now FastAPI does. Mounted last so
# /api/*, /health and /docs always win.
from pathlib import Path as _Path  # noqa: E402

_DIST = _Path(__file__).resolve().parents[3] / "webapp-react" / "dist"
if _DIST.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="dashboard")
    log.info("serving React dashboard from %s", _DIST)
else:
    log.info("webapp-react/dist not found — API-only mode")


def run() -> None:  # pragma: no cover - entrypoint
    import uvicorn

    cfg = get_settings()
    uvicorn.run(
        "omnicee.api.app:asgi",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", cfg.PORT)),
        log_level=cfg.LOG_LEVEL if cfg.LOG_LEVEL != "warn" else "warning",
        workers=1,
    )
