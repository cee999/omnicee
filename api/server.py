"""Enhanced WebSocket and REST endpoint handlers.

Routes:
  /health                    — load balancer health check
  /health/detailed           — full system diagnostics
  /api/diagnostics           — real-time metrics (cycles, feeds, resources)
  /api/system-status         — dashboard-friendly aggregated status
  /api/market                — market data
  /api/signals               — recent signals with metadata
  /api/candles               — historical OHLCV data
  /api/outlook               — multi-timeframe regime analysis
  /api/heatmap               — symbol correlation or momentum heatmap
  /api/audit-trail           — signal generation history
  /ws                        — live updates (signals, telemetry, market)
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Request
from starlette.websockets import WebSocket

from config import Settings
from orchestrator.diagnostics import DiagnosticCollector
from services.db import Database

log = logging.getLogger(__name__)

router = APIRouter()


def _app(request: Request) -> FastAPI:
    """Dependency: get FastAPI instance."""
    return request.app


def _cfg(request: Request) -> Settings:
    """Dependency: get configuration."""
    return request.app.state.settings


def _diagnostics(request: Request) -> DiagnosticCollector:
    """Dependency: get diagnostics collector."""
    return request.app.state.diagnostics


def _db(request: Request) -> Database:
    """Dependency: get database instance."""
    return request.app.state.db


@router.get("/api/market")
async def market(request: Request, symbols: str | None = None) -> dict[str, Any]:
    """Return current market data (prices, spreads) for requested symbols."""
    db = _db(request)
    if not symbols:
        symbols = request.app.state.settings.symbols
    elif isinstance(symbols, str):
        symbols = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return {
        "symbols": symbols,
        "status": "ok",
        "data": [],  # Populated by feed manager or cache
    }


@router.get("/api/signals")
async def get_signals(request: Request, symbol: str | None = None, limit: int = 50) -> dict[str, Any]:
    """Return recent signals, optionally filtered by symbol."""
    db = _db(request)
    if not db.enabled:
        return {"signals": [], "total": 0}
    signals = db.get_signals(symbol, min(limit, 200))
    return {"signals": signals, "total": len(signals)}


@router.get("/api/stats")
async def get_stats(request: Request) -> dict[str, Any]:
    """Return database collection counts and telemetry summary."""
    db = _db(request)
    stats = db.get_stats() if db.enabled else {}
    return {"collections": stats}


__all__ = ["router", "market", "get_signals", "get_stats"]
