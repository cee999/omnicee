import asyncio
import contextlib
import json
import os
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import hyperliquid, sim
from .health import HealthTracker
from .hub import Hub

hub = Hub()
health = HealthTracker()
WATCHLIST = [c.strip().upper() for c in os.getenv("WATCHLIST", "BTC,ETH,SOL,HYPE,XRP,DOGE").split(",") if c.strip()]
SIMULATE = os.getenv("SIMULATE", "0") == "1"


async def _heartbeat() -> None:
    """Pushes feed health + a heartbeat every second so clients can prove the pipe is alive."""
    while True:
        await asyncio.sleep(1)
        hub.publish({"type": "status", "ts": int(time.time() * 1000), "feeds": health.snapshot(), "clients": hub.client_count})


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    ingest = sim.run if SIMULATE else hyperliquid.run
    tasks = [asyncio.create_task(ingest(hub, health, WATCHLIST)), asyncio.create_task(_heartbeat())]
    yield
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="OMNICEE", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    return {"ok": True, "feeds": health.snapshot(), "clients": hub.client_count}


@app.get("/api/snapshot")
async def snapshot():
    return {"ticks": list(hub.latest.values()), "feeds": health.snapshot(), "watchlist": WATCHLIST}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    q = hub.subscribe()
    try:
        await ws.send_text(
            json.dumps({"type": "snapshot", "ticks": list(hub.latest.values()), "feeds": health.snapshot(), "watchlist": WATCHLIST})
        )
        while True:
            await ws.send_text(json.dumps(await q.get()))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.unsubscribe(q)
