"""Offline random-walk feed so the UI can be developed without network access."""
import asyncio
import random
import time

from .health import HealthTracker
from .hub import Hub

SEED = {"BTC": 68000, "ETH": 3400, "SOL": 165, "HYPE": 24, "XRP": 0.62, "DOGE": 0.16}


async def run(hub: Hub, health: HealthTracker, watchlist: list[str]) -> None:
    prices = {c: SEED.get(c, 100.0) for c in watchlist}
    health.set_state("simulator", "live")
    while True:
        for c in watchlist:
            prices[c] *= 1 + random.gauss(0, 0.0004)
            hub.publish(
                {
                    "type": "tick",
                    "symbol": c,
                    "price": round(prices[c], 6),
                    "ts": int(time.time() * 1000),
                    "source": "simulator",
                }
            )
        health.mark_msg("simulator")
        await asyncio.sleep(0.4)
