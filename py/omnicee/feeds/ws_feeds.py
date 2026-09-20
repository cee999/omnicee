"""WebSocket price streams: Binance, Deriv, Finnhub.

Reconnect behaviour mirrors the Node feeds: fixed 3s for Binance, 2s with URL
rotation for Deriv, exponential (x1.6 capped 60s) for Finnhub. A 25s
no-tick watchdog reconnects Deriv; a 20s ping keeps it alive.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import websockets

from .base import FeedStats, TF_SECONDS, to_ms

log = logging.getLogger(__name__)

BINANCE_MAP = {"BTCUSDT": "btcusdt", "ETHUSDT": "ethusdt"}
DERIV_FX = {"EURUSD": "frxEURUSD", "GBPUSD": "frxGBPUSD", "USDJPY": "frxUSDJPY",
            "XAUUSD": "frxXAUUSD", "XAGUSD": "frxXAGUSD", "AUDUSD": "frxAUDUSD",
            "USDCAD": "frxUSDCAD", "NZDUSD": "frxNZDUSD", "USDCHF": "frxUSDCHF"}
DERIV_CRYPTO = {"BTCUSDT": "cryBTCUSD", "ETHUSDT": "cryETHUSD"}
DERIV_TF_GRAN = {"M5": 300, "M15": 900, "H1": 3600, "H4": 14400, "D1": 86400}
DERIV_TF_COUNT = {"M5": 500, "M15": 500, "H1": 500, "H4": 500, "D1": 500}


class BinanceFeed:
    name = "binance"

    def __init__(self, symbols: list[str], on_price: Any) -> None:
        self.symbols = [s for s in symbols if s in BINANCE_MAP]
        self.on_price = on_price
        self.stats = FeedStats(self.name, self.symbols, poll_ms=0)
        self.enabled = bool(self.symbols)

    async def run(self) -> None:
        streams = "/".join(f"{BINANCE_MAP[s]}@trade" for s in self.symbols)
        url = f"wss://stream.binance.com:9443/stream?streams={streams}"
        while True:
            try:
                async with websockets.connect(url, open_timeout=15) as ws:
                    log.info("binance connected")
                    async for raw in ws:
                        try:
                            d = json.loads(raw)
                        except (ValueError, TypeError):
                            continue
                        d = d.get("data") or d
                        if d.get("e") != "trade":
                            continue
                        price = d.get("p")
                        try:
                            price = float(price)
                        except (TypeError, ValueError):
                            continue
                        if price <= 0 or price != price:
                            continue
                        sym = str(d.get("s", "")).upper()
                        omni = sym if sym in BINANCE_MAP else next(
                            (k for k, v in BINANCE_MAP.items() if v == sym.lower()), None)
                        if not omni:
                            continue
                        ts = to_ms(d.get("T")) or int(time.time() * 1000)
                        self.stats.mark_ok()
                        await self.on_price(omni, price, self.name, bid=price, ask=price, ts_ms=ts)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.stats.mark_error(exc)
            await asyncio.sleep(3)


class DerivFeed:
    name = "deriv"

    def __init__(self, app_id: str, symbols: list[str], on_price: Any, on_candles: Any) -> None:
        self.app_id = app_id or "1089"
        self.map = {}
        for s in symbols:
            if s in DERIV_FX:
                self.map[s] = DERIV_FX[s]
            elif s in DERIV_CRYPTO:
                self.map[s] = DERIV_CRYPTO[s]
        self.symbols = list(self.map)
        self.on_price = on_price
        self.on_candles = on_candles
        self.stats = FeedStats(self.name, self.symbols, poll_ms=0)
        self.enabled = bool(self.symbols)
        self._urls = [f"wss://ws.derivws.com/websockets/v3?app_id={self.app_id}",
                      f"wss://ws.binaryws.com/websockets/v3?app_id={self.app_id}"]
        self._url_idx = 0
        self._last_quote: dict[str, float] = {}
        self._last_tick_ms = 0.0
        self._history_queue: list[tuple[str, str]] = []

    def _next_url(self) -> str:
        url = self._urls[self._url_idx % len(self._urls)]
        self._url_idx += 1
        return url

    async def run(self) -> None:
        if not self.enabled:
            return
        while True:
            try:
                async with websockets.connect(self._next_url(), open_timeout=15) as ws:
                    log.info("deriv connected")
                    for sym in self.symbols:
                        await ws.send(json.dumps({"ticks": self.map[sym], "subscribe": 1}))
                    for tf in ("M5", "M15", "H1", "H4", "D1"):
                        for sym in self.symbols:
                            self._history_queue.append((sym, tf))
                    last_ping = time.time()
                    last_drain = 0.0
                    while True:
                        now = time.time()
                        if now - last_ping >= 20:
                            await ws.send(json.dumps({"ping": 1}))
                            last_ping = now
                        if now - last_drain >= 0.5 and self._history_queue:
                            sym, tf = self._history_queue.pop(0)
                            await ws.send(json.dumps({
                                "ticks_history": self.map[sym],
                                "adjust_start_time": 1, "count": DERIV_TF_COUNT[tf],
                                "end": "latest", "granularity": DERIV_TF_GRAN[tf], "style": "candles",
                                "passthrough": {"omni": sym, "tf": tf},
                            }))
                            last_drain = now
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        except asyncio.TimeoutError:
                            if self._last_tick_ms and now * 1000 - self._last_tick_ms > 25_000:
                                log.warning("deriv watchdog: no tick for 25s, reconnecting")
                                break
                            continue
                        await self._handle(json.loads(raw) if raw else {})
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.stats.mark_error(exc)
            await asyncio.sleep(2)

    async def _handle(self, d: dict[str, Any]) -> None:
        if d.get("msg_type") == "tick" and isinstance(d.get("tick"), dict):
            tick = d["tick"]
            sym = next((k for k, v in self.map.items() if v == tick.get("symbol")), None)
            price = tick.get("quote")
            try:
                price = float(price)
            except (TypeError, ValueError):
                return
            if not sym or price <= 0 or price != price:
                return
            self._last_tick_ms = time.time() * 1000
            prev = self._last_quote.get(sym)
            change = ((price - prev) / prev * 100) if prev else None
            self._last_quote[sym] = price
            self.stats.mark_ok()
            ts = to_ms(tick.get("epoch")) or int(time.time() * 1000)
            await self.on_price(sym, price, self.name, bid=price, ask=price, change=change, ts_ms=ts)
        elif d.get("msg_type") == "candles" and isinstance(d.get("candles"), list):
            pt = (d.get("echo_req") or {}).get("passthrough") or {}
            sym, tf = pt.get("omni"), pt.get("tf")
            if sym in self.map and tf in DERIV_TF_GRAN:
                rows = []
                for c in d["candles"]:
                    try:
                        rows.append({"time": to_ms(c.get("epoch")), "open": float(c["open"]),
                                     "high": float(c["high"]), "low": float(c["low"]),
                                     "close": float(c["close"]), "volume": 0.0})
                    except (KeyError, TypeError, ValueError):
                        continue
                self.stats.mark_ok()
                await self.on_candles(sym, tf, rows, self.name)


class FinnhubWS:
    name = "finnhub_ws"

    FOREX_MAP = {"XAUUSD": "OANDA:XAU_USD", "EURUSD": "OANDA:EUR_USD", "GBPUSD": "OANDA:GBP_USD",
                 "USDJPY": "OANDA:USD_JPY", "AUDUSD": "OANDA:AUD_USD", "USDCAD": "OANDA:USD_CAD",
                 "NZDUSD": "OANDA:NZD_USD", "USDCHF": "OANDA:USD_CHF"}
    EQUITY_MAP = {"UUP": "UUP", "USOIL": "USO"}

    def __init__(self, api_key: str, symbols: list[str], on_price: Any) -> None:
        self.api_key = (api_key or "").strip()
        self.map = {}
        for s in symbols:
            if s in self.FOREX_MAP:
                self.map[self.FOREX_MAP[s]] = s
            elif s in self.EQUITY_MAP:
                self.map[self.EQUITY_MAP[s]] = s
        self.on_price = on_price
        self.stats = FeedStats(self.name, list(self.map.values()), poll_ms=0)
        self.enabled = bool(self.api_key) and bool(self.map)

    async def run(self) -> None:
        if not self.enabled:
            return
        url = f"wss://ws.finnhub.io?token={self.api_key}"
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(url, open_timeout=15) as ws:
                    backoff = 1.0
                    for ticker in self.map:
                        await ws.send(json.dumps({"type": "subscribe", "symbol": ticker}))
                    async for raw in ws:
                        d = json.loads(raw)
                        if d.get("type") != "trade" or not isinstance(d.get("data"), list):
                            continue
                        self.stats.mark_ok()
                        for t in d["data"]:
                            sym = self.map.get(t.get("s", ""))
                            try:
                                price = float(t.get("p"))
                            except (TypeError, ValueError):
                                continue
                            if sym and price > 0 and price == price:
                                ts = to_ms(t.get("t")) or int(time.time() * 1000)
                                await self.on_price(sym, price, "finnhub", ts_ms=ts)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.stats.mark_error(exc)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.6, 60)
