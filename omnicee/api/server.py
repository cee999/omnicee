"""Public API surface + Socket.IO bridge + feed lifecycle.

Replaces the Node `api/server.js`, `api/realtime.js` and `webapp/ws-server.js`
in one place. Route paths, query params and payload shapes mirror the Node
contract so `webapp-react` keeps working unchanged:

  GET  /api/market            resolved price rows
  GET  /api/candles           OHLC per symbol/timeframe
  GET  /api/health            engine + feed + mongo health
  GET  /api/signals           recent signals
  GET  /api/calendar          upcoming economic events
  GET  /api/news              scored headlines
  GET  /api/audit-trail       engine decisions incl. waits
  GET  /api/status            orchestrator status
  GET  /api/learning          pattern performance profiles
  GET  /api/equity-curve      balance curve from outcomes
  GET  /api/heatmap           multi-timeframe change map
  GET  /api/hurst             chaos read per symbol
  GET  /api/levels            S/R pivot levels
  GET  /api/outlook           market outlook brief
  GET  /api/sentiment         fear&greed + crypto global + cot
  GET  /api/feed-health       per-feed connection matrix
  GET  /api/cache/status      warm/cold cache state
  GET  /api/api-vault         researched provider catalog
  POST /api/auth/email        request OTP
  POST /api/auth/verify       verify OTP -> session token
  POST /api/auth/logout       drop session
  GET  /api/auth/me           session identity
  POST /api/alerts/test       fire a test push/telegram

Socket.IO events out: market_update, signal, engine_telemetry, feed_health.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Annotated, Any

import socketio
from fastapi import APIRouter, Header, HTTPException, Request

from ..feeds.api_vault import status_report as vault_report
from ..feeds.cot import CotFeed, CotReport
from ..feeds.integrity import DataIntegrityMonitor
from ..feeds.manager import FeedManager
from ..feeds.news import fetch_news
from ..feeds.rest_pollers import (
    AlphaVantageSentiment,
    BiQuotePoller,
    CalendarPoller,
    ExchangeRatePoller,
    FrankfurterPoller,
    FredPoller,
    MarketInfoPoller,
    TradingViewPoller,
    YahooQuotePoller,
)
from ..feeds.ws_feeds import BinanceFeed, DerivFeed, FinnhubWS
from ..orchestrator.engine import Orchestrator
from ..services.auth import timing_safe_eq

log = logging.getLogger("omnicee.api.server")

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

router = APIRouter(prefix="/api")


def _app(request: Request):
    return request.app


def _cfg(request: Request):
    return request.app.state.settings


def _engine(request: Request) -> Orchestrator | None:
    return getattr(request.app.state, "engine", None)


def _fm(request: Request) -> FeedManager | None:
    return getattr(request.app.state, "feed_manager", None)


def _db(request: Request):
    return getattr(request.app.state, "db", None)


# --------------------------------------------------------------------- market
@router.get("/market")
async def market(request: Request, symbols: str | None = None) -> dict[str, Any]:
    fm = _fm(request)
    if fm is None:
        raise HTTPException(503, "engine disabled")
    want = [s.strip().upper() for s in symbols.split(",")] if symbols else None
    rows = fm.resolved_market_rows(want)
    return {"ok": bool(rows), "market": rows, "rows": rows, "count": len(rows), "timestamp": int(time.time() * 1000),
            "note": None if rows else "no live prices yet — feeds warming up"}


@router.get("/candles")
async def candles(request: Request, symbol: str, timeframe: str = "M15", limit: int = 300) -> dict[str, Any]:
    fm = _fm(request)
    if fm is None:
        raise HTTPException(503, "engine disabled")
    rows = fm.store.get(symbol.upper(), timeframe.upper())[-min(limit, 600):]
    return {"ok": bool(rows), "symbol": symbol.upper(), "timeframe": timeframe.upper(),
            "candles": rows, "count": len(rows)}


@router.get("/heatmap")
async def heatmap(request: Request) -> dict[str, Any]:
    fm = _fm(request)
    if fm is None:
        raise HTTPException(503, "engine disabled")
    out = []
    for sym in _cfg(request).symbols:
        row = {"symbol": sym}
        for tf in _cfg(request).timeframes:
            arr = fm.store.get(sym, tf)
            if len(arr) >= 2:
                prev, last = float(arr[-2]["close"]), float(arr[-1]["close"])
                row[tf] = round((last - prev) / prev * 100, 3) if prev else None
            else:
                row[tf] = None
        out.append(row)
    return {"ok": True, "tiles": out, "rows": out, "timeframes": _cfg(request).timeframes}


@router.get("/levels")
async def levels(request: Request, symbol: str | None = None) -> dict[str, Any]:
    fm = _fm(request)
    if fm is None:
        raise HTTPException(503, "engine disabled")

    def _calc(sym: str) -> list[dict[str, Any]] | None:
        arr = fm.store.get(sym, "D1") or fm.store.get(sym, "H4")
        if len(arr) < 10:
            return None
        high = max(float(c["high"]) for c in arr[-30:])
        low = min(float(c["low"]) for c in arr[-30:])
        close = float(arr[-1]["close"])
        rng = max(high - low, 1e-12)
        piv = (high + low + close) / 3
        return [
            {"name": "R3", "price": round(high + 2 * (piv - low), 6)},
            {"name": "R2", "price": round(piv + rng / 2, 6)},
            {"name": "R1", "price": round(2 * piv - low, 6)},
            {"name": "PP", "price": round(piv, 6)},
            {"name": "S1", "price": round(2 * piv - high, 6)},
            {"name": "S2", "price": round(piv - rng / 2, 6)},
            {"name": "S3", "price": round(low - 2 * (high - piv), 6)},
        ]

    if symbol:
        sym = symbol.upper()
        ls = _calc(sym)
        return {"ok": ls is not None, "symbol": sym, "levels": ls or [],
                "note": None if ls else "insufficient candles"}
    # No symbol → full map for the desk (frontend polls it without args).
    return {"ok": True, "levels": {s: _calc(s) for s in _cfg(request).symbols}}


# -------------------------------------------------------------------- engine
_BOOT_MS = int(time.time() * 1000)


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    engine = _engine(request)
    db = _db(request)
    fm = _fm(request)
    feed_health = await fm.health_report() if fm else {"ok": None, "feeds": [], "summary": {}}
    return {
        "status": "ok" if (engine and engine._running) else "degraded",
        "service": "omnicee-python-backend",
        "engine": engine.status() if engine else {"running": False, "reason": "DISABLE_ENGINE=1"},
        "mongo": db.health() if db else {"ok": None, "enabled": False},
        "feeds": feed_health["feeds"],
        "summary": feed_health["summary"],
        "uptime": round((int(time.time() * 1000) - _BOOT_MS) / 1000),
        "eaAuthFailures": None,
        "eaAuthLastFailureAt": None,
        "timestamp": int(time.time() * 1000),
    }


@router.get("/signals")
async def signals(request: Request, symbol: str | None = None, limit: int = 100) -> dict[str, Any]:
    db = _db(request)
    rows = db.get_signals(symbol, limit) if db else []
    return {"ok": True, "signals": rows, "count": len(rows),
            "note": None if rows else "no signals yet — gates may be holding"}


@router.get("/audit-trail")
async def audit_trail(request: Request, limit: int = 100) -> dict[str, Any]:
    engine = _engine(request)
    rows = engine.audit.tail(min(limit, 500)) if engine else []
    near = [e for e in rows if str(e.get("action", "")).upper() in ("WAIT", "NEAR_MISS")]
    return {"ok": True, "entries": rows, "nearMisses": near, "count": len(rows)}


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    engine = _engine(request)
    return {"ok": True, "orchestrator": engine.status() if engine else None}


@router.get("/learning")
async def learning(request: Request) -> dict[str, Any]:
    db = _db(request)
    profiles = db.get_learning_profiles() if db else []
    return {"ok": True, "profiles": profiles, "count": len(profiles)}


@router.get("/equity-curve")
async def equity_curve(request: Request) -> dict[str, Any]:
    db = _db(request)
    curve = db.get_equity_curve() if db else []
    return {"ok": True, "curve": curve, "count": len(curve)}


@router.get("/hurst")
async def hurst(request: Request) -> dict[str, Any]:
    import numpy as np

    from ..features.indicators import hurst as hurst_fn
    fm = _fm(request)
    if fm is None:
        raise HTTPException(503, "engine disabled")
    rows = []
    for sym in _cfg(request).symbols:
        arr = fm.store.get(sym, "H4") or fm.store.get(sym, "M15")
        if len(arr) < 100:
            rows.append({"symbol": sym, "hurst": None, "note": "insufficient candles"})
            continue
        closes = np.asarray([c["close"] for c in arr], dtype=float)
        h = hurst_fn(closes)
        rows.append({"symbol": sym, "hurst": round(float(h), 4),
                     "character": "trending" if h > 0.55 else "mean-reverting" if h < 0.45 else "random-walk"})
    return {"ok": True, "board": rows, "rows": rows}


# ------------------------------------------------------------------- content
@router.get("/calendar")
async def calendar(request: Request, limit: int = 50) -> dict[str, Any]:
    cal = getattr(request.app.state, "calendar", None)
    events = cal.upcoming(limit) if cal else []
    return {"ok": True, "events": events, "count": len(events),
            "note": None if events else "calendar sources warming up"}


@router.get("/news")
async def news(symbol: str | None = None, limit: int = 30) -> dict[str, Any]:
    try:
        items = await fetch_news(limit=limit, symbol=symbol)
    except Exception:
        log.exception("news fetch failed")
        items = []
    return {"ok": True, "news": items, "count": len(items)}


@router.get("/sentiment")
async def sentiment(request: Request) -> dict[str, Any]:
    mi = getattr(request.app.state, "market_info", None)
    cot = getattr(request.app.state, "cot_feed", None)
    return {"ok": True,
            "fearGreed": mi.fear_greed if mi else None,
            "cryptoGlobal": mi.crypto_global if mi else None,
            "cot": {sym: cot.parser.analyze(sym) for sym in (_cfg(request).symbols[:4])} if cot else {}}


@router.get("/outlook")
async def outlook(request: Request) -> dict[str, Any]:
    engine = _engine(request)
    fm = _fm(request)
    ranked = engine.ranker.get_ranked(10) if engine else []
    rows = fm.resolved_market_rows() if fm else []
    bull = [r for r in ranked if r.get("action") in ("LONG", "BUY")]
    bear = [r for r in ranked if r.get("action") in ("SHORT", "SELL")]
    return {"ok": True, "topOpportunities": ranked[:5],
            "bias": "RISK-ON" if len(bull) > len(bear) else "RISK-OFF" if len(bear) > len(bull) else "MIXED",
            "pricesTracked": len(rows),
            "outlook": {"topOpportunities": ranked[:5],
                        "bias": "RISK-ON" if len(bull) > len(bear) else "RISK-OFF" if len(bear) > len(bull) else "MIXED",
                        "pricesTracked": len(rows)}}


# -------------------------------------------------------------------- feeds
@router.get("/feed-health")
async def feed_health(request: Request) -> dict[str, Any]:
    fm = _fm(request)
    report = await fm.health_report() if fm else {"ok": None, "feeds": [], "summary": {}}
    return {"ok": True, **report}


@router.get("/cache/status")
async def cache_status(request: Request) -> dict[str, Any]:
    fm = _fm(request)
    import os
    files = {}
    for name in ("market.json", "candles.json"):
        path = f".cache/{name}"
        if os.path.exists(path):
            st = os.stat(path)
            files[name] = {"sizeBytes": st.st_size, "modifiedAt": int(st.st_mtime * 1000)}
        else:
            files[name] = None
    candle_count = sum(len(tfs) for tfs in (fm.store.all().values() if fm else []))
    return {"ok": True, "files": files, "candleSeries": candle_count,
            "warm": candle_count > 0}


@router.get("/api-vault")
async def api_vault() -> dict[str, Any]:
    return {"ok": True, **vault_report()}


# --------------------------------------------------------------------- auth
@router.get("/auth/email/config")
async def auth_email_config(request: Request) -> dict[str, Any]:
    cfg = _cfg(request)
    return {"ok": True, "passwordRequired": bool(cfg.LOGIN_PASSWORD)}


@router.post("/auth/email")
@router.post("/auth/email/request")
async def auth_email(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    auth = getattr(request.app.state, "auth", None)
    if auth is None:
        raise HTTPException(503, "auth not configured")
    cfg = _cfg(request)
    if cfg.LOGIN_PASSWORD and str(body.get("password", "")) != cfg.LOGIN_PASSWORD:
        raise HTTPException(401, "invalid desk password")
    out = auth.request_otp(str(body.get("email", "")), request.client.host if request.client else "unknown")
    if out.get("status"):
        raise HTTPException(out.pop("status"), out.get("error", "rate limited"))
    if out.get("devCode") and cfg.NODE_ENV == "production" and not cfg.ALLOW_DEV_OTP:
        out.pop("devCode", None)
    return out


@router.post("/auth/verify")
@router.post("/auth/email/verify")
async def auth_verify(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    auth = getattr(request.app.state, "auth", None)
    if auth is None:
        raise HTTPException(503, "auth not configured")
    out = auth.verify_otp(str(body.get("email", "")), str(body.get("code", "")))
    if out.get("status"):
        raise HTTPException(out.pop("status"), out.get("error", "verification failed"))
    return out


@router.post("/auth/logout")
async def auth_logout(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    auth = getattr(request.app.state, "auth", None)
    if auth:
        auth.logout(body.get("token"))
    return {"ok": True}


@router.get("/auth/me")
async def auth_me(request: Request, token: str | None = None) -> dict[str, Any]:
    auth = getattr(request.app.state, "auth", None)
    if auth is None:
        return {"ok": False, "email": None}
    email = auth.session_email(token)
    return {"ok": bool(email), "email": email}


# -------------------------------------------------------------------- alerts
@router.post("/alerts/test")
async def alerts_test(request: Request) -> dict[str, Any]:
    alerts = getattr(request.app.state, "alerts", None) if _engine(request) else None
    if alerts is None:
        raise HTTPException(503, "engine disabled")
    result = await alerts.send_telegram("OMNICEE test alert — Python backend live")
    return {"ok": True, "telegram": result}


# ------------------------------------------------- frontend-only endpoints
@router.get("/watchlist")
async def watchlist(request: Request) -> dict[str, Any]:
    """Opportunity ranking + real relative strength from live candle closes."""
    engine = _engine(request)
    fm = _fm(request)
    ranked = engine.ranker.get_ranked(10) if engine else []
    rs: list[dict[str, Any]] = []
    if fm:
        for sym in _cfg(request).symbols:
            arr = fm.store.get(sym, "H1") or fm.store.get(sym, "M15")
            if len(arr) >= 2:
                prev, last = float(arr[-2]["close"]), float(arr[-1]["close"])
                if prev:
                    rs.append({"symbol": sym, "change": round((last - prev) / prev * 100, 3)})
    rs.sort(key=lambda r: r["change"], reverse=True)
    return {"ok": True, "opportunities": ranked, "relativeStrength": rs or None,
            "note": None if (rs or ranked) else "insufficient data for watchlist scoring"}


@router.get("/journal")
async def journal(request: Request, limit: int = 500) -> dict[str, Any]:
    """Aggregate trading-journal stats from recorded outcomes (real only)."""
    db = _db(request)
    rows = db.get_outcomes(limit) if db else []
    wins = sum(1 for r in rows if r.get("outcome") == "WIN")
    losses = sum(1 for r in rows if r.get("outcome") == "LOSS")
    breaks = sum(1 for r in rows if r.get("outcome") == "BE")
    total = len(rows)
    return {"ok": True, "count": total,
            "stats": {"total": total, "wins": wins, "losses": losses, "breakEven": breaks,
                      "winRate": round(wins / total, 4) if total else None}}


@router.get("/desk-brief")
async def desk_brief(request: Request) -> dict[str, Any]:
    """Session briefing composed from real engine/calendar state only."""
    engine = _engine(request)
    fm = _fm(request)
    cal = getattr(request.app.state, "calendar", None)
    ranked = engine.ranker.get_ranked(5) if engine else []
    events = cal.upcoming(3) if cal else []
    utc_h = time.gmtime().tm_hour
    if utc_h < 8:
        session = "Sydney / Tokyo"
    elif utc_h < 13:
        session = "London"
    elif utc_h < 16:
        session = "London / New York overlap"
    elif utc_h < 21:
        session = "New York"
    else:
        session = "Late New York / Sydney"
    rows = fm.resolved_market_rows() if fm else []
    return {"ok": True, "session": session, "utcHour": utc_h,
            "topOpportunities": ranked, "nextEvents": events,
            "pricesTracked": len(rows),
            "note": None if (ranked or events) else "engine warming up — brief fills in as feeds connect"}


@router.get("/engine")
async def engine_status(request: Request) -> dict[str, Any]:
    engine = _engine(request)
    if engine is None:
        return {"ok": False, "running": False, "reason": "DISABLE_ENGINE=1"}
    return {"ok": True, **engine.status()}


@router.get("/stats")
async def stats(request: Request) -> dict[str, Any]:
    db = _db(request)
    counts = db.get_stats() if db else {}
    engine = _engine(request)
    acct = engine.account_state if engine else None
    return {"ok": True, "stats": counts, "db": counts,
            "engine": engine._last_cycle_stats if engine else {},
            # Real MT5-reported balance only — null until the EA syncs,
            # never a fabricated number.
            "accountBalance": acct.get("balance") if acct else None,
            "accountEquity": acct.get("equity") if acct else None}


@router.get("/outcomes")
async def outcomes(request: Request, limit: int = 200) -> dict[str, Any]:
    db = _db(request)
    rows = db.get_outcomes(limit) if db else []
    return {"ok": True, "outcomes": rows, "count": len(rows)}


@router.post("/outcomes")
async def record_outcome(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    db = _db(request)
    signal_id = str(body.get("signalId", "")).strip()
    outcome = str(body.get("outcome", "")).upper()
    if not signal_id or outcome not in ("WIN", "LOSS", "BE"):
        raise HTTPException(422, "signalId and outcome (WIN|LOSS|BE) required")
    if db is None:
        raise HTTPException(503, "persistence disabled")
    doc = db.save_outcome({"signalId": signal_id, "outcome": outcome})
    return {"ok": doc is not None, "outcome": doc}


@router.get("/telegram-user")
async def telegram_user(request: Request) -> dict[str, Any]:
    """Validate Telegram Mini App initData and echo the user."""
    auth = getattr(request.app.state, "auth", None)
    cfg = _cfg(request)
    init_data = request.query_params.get("initData") or ""
    user = auth.validate_telegram_init_data(init_data, cfg.TELEGRAM_BOT_TOKEN) if auth else None
    if user is None:
        raise HTTPException(401, "invalid initData")
    tg = user["user"]
    if not auth.telegram_allowed(tg.get("id", "")):
        raise HTTPException(403, "user not allowlisted")
    if db := _db(request):
        db.upsert_telegram_user(tg)
    return {"ok": True, "user": tg}


# -------------------------------------------------------- MT5 EA bridge
def _require_ea_secret(request: Request, secret: str | None) -> None:
    expected = _cfg(request).EA_SECRET
    if not expected:
        raise HTTPException(503, "EA_SECRET not configured")
    if not secret or not timing_safe_eq(secret, expected):
        raise HTTPException(401, "invalid EA secret")


@router.post("/ea/balance")
async def ea_balance(request: Request, body: dict[str, Any],
                     x_ea_secret: Annotated[str | None, Header()] = None,
                     secret: str | None = None) -> dict[str, Any]:
    """MT5 EA account sync — gates and sizing run on the real balance."""
    _require_ea_secret(request, secret or x_ea_secret)
    engine = _engine(request)
    if engine is None:
        raise HTTPException(503, "engine disabled")
    try:
        balance = float(body.get("balance") or 0.0)
        equity = float(body.get("equity") or 0.0)
    except (TypeError, ValueError):
        raise HTTPException(422, "balance and equity must be numbers") from None
    if balance <= 0:
        raise HTTPException(422, "balance must be positive")
    engine.account_state = {
        "balance": balance, "equity": equity,
        "margin": body.get("margin"), "freeMargin": body.get("freeMargin"),
        "atMs": int(time.time() * 1000),
    }
    await engine.bus.emit("balance", {"balance": balance, "equity": equity,
                                      "source": "mt5_ea", "at": engine.account_state["atMs"]})
    return {"ok": True, "balance": balance}


@router.get("/ea/signals")
async def ea_signals(request: Request, secret: str | None = None) -> dict[str, Any]:
    """Latest executable signals for the MT5 EA poller."""
    _require_ea_secret(request, secret)
    db = _db(request)
    rows = db.get_signals(limit=20) if db else []
    now = time.time() * 1000
    # Only calibrated-confidence signals are executable: CANDIDATE means
    # confidence was never earned, and the EA must not trade on it.
    executable = {"validated", "approved"}
    fresh = [r for r in rows
             if now - float(r.get("timestamp") or 0) < 10 * 60_000
             and str(r.get("state") or "") in executable]
    return {"ok": True, "signals": fresh[:5],
            "note": None if fresh else "no validated signals in the last 10 minutes"}


@router.post("/ea/prices")
async def ea_prices(request: Request, body: dict[str, Any], secret: str | None = None) -> dict[str, Any]:
    """Broker tick push from the MT5 EA (source rank 100 — beats every feed)."""
    _require_ea_secret(request, secret)
    fm = _fm(request)
    if fm is None:
        raise HTTPException(503, "engine disabled")
    rows = body.get("prices")
    if not isinstance(rows, list) or not rows:
        raise HTTPException(422, "prices array required")
    accepted = 0
    for row in rows[:100]:
        sym = str(row.get("symbol", "")).upper()
        try:
            price = float(row.get("price"))
        except (TypeError, ValueError):
            continue
        if not sym or price <= 0:
            continue
        bid = row.get("bid")
        ask = row.get("ask")
        await fm.on_price(sym, price, "mt5_ea",
                          bid=float(bid) if bid else None, ask=float(ask) if ask else None)
        accepted += 1
    return {"ok": True, "accepted": accepted}


# ------------------------------------------------------------ socket bridge
# The React app listens on these names (the Node contract); the bus emits the
# engine's internal names. Map at the boundary, never inside the engine.
CHANNEL_ALIAS = {"market_update": "market", "engine_telemetry": "telemetry"}


async def _socket_bridge(app) -> None:
    """Fan the event bus out to connected Socket.IO clients."""
    bus = app.state.bus
    q = bus.subscribe_queue("market_update", "signal", "engine_telemetry",
                            "feed_health", "candles_seeded")
    while True:
        channel, payload = await q.get()
        try:
            await sio.emit(CHANNEL_ALIAS.get(channel, channel), payload)
        except Exception:
            log.exception("socket emit failed for %s", channel)


# ---- Socket.IO client contract (subscribe / history / heartbeat) ---------
@sio.event
async def connect(sid: str, environ: dict[str, Any]) -> None:
    state = getattr(sio, "omnicee_state", None)
    ready = state is not None and getattr(state, "engine", None) is not None
    try:
        await sio.emit("engine_ready", {"ok": ready}, to=sid)
    except Exception:
        log.exception("engine_ready emit failed")


@sio.on("subscribe")
async def on_subscribe(sid: str, data: Any = None) -> None:
    channels = data.get("channels") if isinstance(data, dict) else None
    try:
        await sio.emit("subscribed", {"ok": True, "channels": channels or []}, to=sid)
    except Exception:
        log.exception("subscribed ack failed")


@sio.on("get_history")
async def on_get_history(sid: str, data: Any = None) -> None:
    """Recent signals + current market rows, replayed on (re)connect."""
    state = getattr(sio, "omnicee_state", None)
    limit = int(data.get("limit") or 40) if isinstance(data, dict) else 40
    db = getattr(state, "db", None)
    fm = getattr(state, "feed_manager", None)
    try:
        signals = db.get_signals(limit=limit) if db else []
    except Exception:
        log.exception("get_history signals query failed")
        signals = []
    try:
        rows = fm.resolved_market_rows() if fm else []
    except Exception:
        log.exception("get_history market rows failed")
        rows = []
    try:
        await sio.emit("history", {"signals": signals, "market": rows,
                                   "serverTime": int(time.time() * 1000)}, to=sid)
    except Exception:
        log.exception("history emit failed")


@sio.on("heartbeat")
async def on_heartbeat(sid: str, data: Any = None) -> None:
    try:
        await sio.emit("heartbeat_ack",
                       {"t": data.get("t") if isinstance(data, dict) else None,
                        "serverTime": int(time.time() * 1000)}, to=sid)
    except Exception:
        log.exception("heartbeat ack failed")


# ------------------------------------------------------------------ assembly
async def start_backend(app) -> dict[str, Any]:
    """Create feeds + orchestrator and spawn their tasks. Called from lifespan."""
    cfg = app.state.settings
    bus = app.state.bus
    db = app.state.db

    async def emit(channel: str, payload: Any) -> None:
        await bus.emit(channel, payload)

    fm = FeedManager(cfg, bus, emit)
    app.state.feed_manager = fm

    # Seed from crash cache
    cached = fm.persist.load_candles()
    if cached:
        stores = cached.get("candleStores") or {}
        for sym, tfs in stores.items():
            for tf, rows in tfs.items():
                fm.store.seed(sym, tf, rows)
        for sym, row in (cached.get("lastPrices") or {}).items():
            fm.store.last_prices[sym] = row
        log.info("cache warm: %d symbols restored", len(stores))

    cot_report = CotReport()
    cot_feed = CotFeed(cot_report)
    market_info = MarketInfoPoller()
    calendar = CalendarPoller(cfg.FINNHUB_API_KEY, cfg.FMP_API_KEY)
    app.state.cot_feed = cot_feed
    app.state.market_info = market_info
    app.state.calendar = calendar

    symbols = cfg.symbols
    engine = Orchestrator(cfg, bus, db, fm, cot_feed, market_info, calendar)
    app.state.engine = engine

    from ..services.auth import AuthService
    app.state.auth = AuthService(cfg, db)
    app.state.alerts = engine.alerts
    sio.omnicee_state = app.state  # for socket handlers needing engine/db/feeds

    monitor = DataIntegrityMonitor()
    feeds: list[Any] = []

    def spawn_feed(feed) -> None:
        feeds.append(feed)
        fm.register(feed.name, feed.stats)
        fm.spawn(feed.run())

    if not cfg.DISABLE_DERIV:
        spawn_feed(DerivFeed(cfg.DERIV_APP_ID, symbols, fm.on_price, fm.on_candles))
    spawn_feed(BinanceFeed(symbols, fm.on_price))
    if cfg.FINNHUB_API_KEY:
        spawn_feed(FinnhubWS(cfg.FINNHUB_API_KEY, symbols, fm.on_price))
    if not cfg.DISABLE_YAHOO_QUOTES:
        spawn_feed(YahooQuotePoller(symbols, fm.on_price))
    if not cfg.DISABLE_EXCHANGERATE:
        spawn_feed(ExchangeRatePoller(fm.on_price))
    if not cfg.DISABLE_FRANKFURTER:
        spawn_feed(FrankfurterPoller(fm.on_price))
    if not cfg.DISABLE_BIQUOTE:
        spawn_feed(BiQuotePoller(symbols, fm.on_price))
    if not cfg.DISABLE_TRADINGVIEW:
        spawn_feed(TradingViewPoller(symbols, fm.on_price))
    spawn_feed(market_info)
    spawn_feed(calendar)
    spawn_feed(cot_feed)
    if cfg.FRED_API_KEY:
        spawn_feed(FredPoller(cfg.FRED_API_KEY, symbols, fm.on_price))
    if cfg.ALPHA_VANTAGE_API_KEY:
        spawn_feed(AlphaVantageSentiment(cfg.ALPHA_VANTAGE_API_KEY, emit))

    async def feed_health_loop() -> None:
        while True:
            try:
                report = monitor.check([f.stats for f in feeds], fm.store.all())
                report["feeds"] = [f.stats.as_dict() for f in feeds]
                await emit("feed_health", report)
            except Exception:
                log.exception("feed health loop failed")
            await asyncio.sleep(30)

    fm.spawn(engine.run())
    fm.spawn(fm.persist_loop())
    fm.spawn(feed_health_loop())
    fm.spawn(_socket_bridge(app))
    log.info("backend started: %d feeds, %d symbols", len(feeds), len(symbols))
    return {"feeds": len(feeds), "symbols": len(symbols)}
