"""Hyperliquid public WebSocket ingest (no API key needed for market data).
Subscribes to allMids and republishes only the watchlist coins when the price changes."""
import asyncio
import json
import time

import websockets

from .health import HealthTracker
from .hub import Hub

URL = "wss://api.hyperliquid.xyz/ws"
NAME = "hyperliquid"


async def _pinger(ws) -> None:
    # Hyperliquid closes idle sockets after ~60s; ping well inside that.
    while True:
        await asyncio.sleep(25)
        await ws.send(json.dumps({"method": "ping"}))


async def run(hub: Hub, health: HealthTracker, watchlist: list[str]) -> None:
    wanted = set(watchlist)
    last: dict[str, float] = {}
    backoff = 1.0
    while True:
        health.set_state(NAME, "connecting")
        try:
            async with websockets.connect(URL, ping_interval=None, max_size=2**22) as ws:
                await ws.send(
                    json.dumps({"method": "subscribe", "subscription": {"type": "allMids"}})
                )
                backoff = 1.0
                pinger = asyncio.create_task(_pinger(ws))
                try:
                    async for raw in ws:
                        msg = json.loads(raw)
                        health.mark_msg(NAME)
                        if msg.get("channel") != "allMids":
                            continue
                        mids = msg.get("data", {}).get("mids", {})
                        now = int(time.time() * 1000)
                        for coin in wanted:
                            if coin not in mids:
                                continue
                            price = float(mids[coin])
                            if last.get(coin) == price:
                                continue
                            last[coin] = price
                            hub.publish(
                                {
                                    "type": "tick",
                                    "symbol": coin,
                                    "price": price,
                                    "ts": now,
                                    "source": NAME,
                                }
                            )
                finally:
                    pinger.cancel()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - reconnect on anything
            health.set_state(NAME, "reconnecting", error=f"{type(e).__name__}: {e}")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)
