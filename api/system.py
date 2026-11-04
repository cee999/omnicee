"""Operational status endpoint: ``GET /api/system-status``.

One authenticated route that answers "is the whole system actually working?"
(engine loop, feeds, database, resources, startup validation). The public
``/health`` stays a cheap liveness probe for Render; this is the deep check
for the dashboard and for humans. It is deliberately NOT in
``services.auth.PUBLIC_GET_PATHS`` — memory, CPU and internal issue text are
not for anonymous callers.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api", tags=["ops"])

# Mongo is pinged at most this often, however fast the dashboard polls.
DB_STATUS_TTL_S = 10.0


async def _db_status(app: Any) -> dict[str, Any] | None:
    """Cached, off-loop database ping. PyMongo is synchronous: calling it
    directly in a handler would freeze every feed and the engine."""
    db = getattr(app.state, "db", None)
    if db is None:
        return None
    cached = getattr(app.state, "db_status_cache", None)
    now = time.monotonic()
    if cached and now - cached[0] < DB_STATUS_TTL_S:
        return cached[1]
    status = await asyncio.to_thread(db.health)
    app.state.db_status_cache = (now, status)
    return status


@router.get("/system-status")
async def system_status(request: Request) -> dict[str, Any]:
    app = request.app
    cfg = app.state.settings
    engine = getattr(app.state, "engine", None)
    fm = getattr(app.state, "feed_manager", None)
    engine_enabled = not cfg.DISABLE_ENGINE and cfg.NODE_ENV != "test"

    health = app.state.diagnostics.build_health(
        engine_enabled=engine_enabled,
        engine_status=engine.status() if engine else None,
        feeds_report=await fm.health_report() if fm else None,
        db_status=await _db_status(app),
        analysis_interval_ms=cfg.ANALYSIS_INTERVAL_MS,
    )
    out = health.as_dict()
    out["startup"] = getattr(app.state, "startup_report", None) or {"status": "pending"}
    return out
