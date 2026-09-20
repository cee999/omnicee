"""REST pollers — one class per upstream, faithful to the Node feeds.

Each poller loops: immediate poll, then interval sleep. Invalid prices are
skipped (never fabricated); null-able fields stay null; every poll failure is
counted in FeedStats and surfaced through feed_health.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .base import FeedStats, build_headers, fetch_json, to_ms

log = logging.getLogger(__name__)

UA = "Mozilla/5.0 (compatible; OMNICEE-Python/1.0)"


def _pct(a: float, b: float) -> float:
    return (a - b) / b * 100.0 if b else 0.0


class RestPoller:
    """Base: loop with poll() implemented per source."""
    name = "rest"

    def __init__(self, poll_ms: int) -> None:
        self.stats = FeedStats(self.name, [], poll_ms=poll_ms)

    async def poll(self) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    async def run(self) -> None:
        while True:
            try:
                await self.poll()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.stats.mark_error(exc)
            await asyncio.sleep(self.stats.poll_ms / 1000.0)


class YahooQuotePoller(RestPoller):
    name = "yahoo"
    MAP = {"UUP": "UUP", "USOIL": "CL=F", "XAUUSD": "GC=F", "BTCUSDT": "BTC-USD",
           "ETHUSDT": "ETH-USD", "EURUSD": "EURUSD=X", "GBPUSD": "GBPUSD=X", "USDJPY": "USDJPY=X"}

    def __init__(self, symbols: list[str], on_price: Any, poll_ms: int = 8000) -> None:
        super().__init__(max(5000, poll_ms))
        self.symbols = [s for s in symbols if s in self.MAP]
        self.stats.symbols = self.symbols
        self.on_price = on_price
        self.enabled = bool(self.symbols)

    async def poll(self) -> None:
        ok_any = False
        for sym in self.symbols:
            try:
                d = await fetch_json(
                    f"https://query1.finance.yahoo.com/v8/finance/chart/{self.MAP[sym]}?interval=1m&range=1d",
                    timeout=10, headers=build_headers(UA))
                meta = ((d.get("chart") or {}).get("result") or [{}])[0].get("meta", {})
                price = meta.get("regularMarketPrice")
                prev = meta.get("chartPreviousClose") or meta.get("previousClose")
                price = float(price) if price is not None else None
                if price and price > 0:
                    change = _pct(price, float(prev)) if prev else None
                    ok_any = True
                    self.stats.mark_ok()
                    await self.on_price(sym, price, self.name, bid=price, ask=price, change=change)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.stats.mark_error(exc)
            await asyncio.sleep(0.15)
        if ok_any:
            self.stats.mark_ok()


class ExchangeRatePoller(RestPoller):
    name = "exchangerate"
    SYMBOLS = ("EURUSD", "GBPUSD", "USDJPY")

    def __init__(self, on_price: Any, poll_ms: int = 30_000) -> None:
        super().__init__(max(15_000, poll_ms))
        self.on_price = on_price
        self.stats.symbols = list(self.SYMBOLS)
        self.enabled = True

    async def poll(self) -> None:
        d = await fetch_json("https://open.er-api.com/v6/latest/USD", timeout=15)
        if d.get("result") != "success":
            raise RuntimeError(f"er-api result={d.get('result')}")
        rates = d.get("rates", {})
        inv = {"EURUSD": "EUR", "GBPUSD": "GBP"}
        now = int(time.time() * 1000)
        for sym in self.SYMBOLS:
            rate = rates.get(inv[sym] if sym in inv else sym[3:])
            if rate is None:
                continue
            price = 1.0 / float(rate) if sym in inv else float(rate)
            if price > 0:
                self.stats.mark_ok()
                await self.on_price(sym, price, self.name, ts_ms=now)


class FrankfurterPoller(RestPoller):
    name = "frankfurter"
    SYMBOLS = ("EURUSD", "GBPUSD", "USDJPY")

    def __init__(self, on_price: Any, poll_ms: int = 60_000) -> None:
        super().__init__(max(30_000, poll_ms))
        self.on_price = on_price
        self.stats.symbols = list(self.SYMBOLS)
        self.enabled = True

    async def poll(self) -> None:
        d = await fetch_json("https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY", timeout=15)
        rates = d.get("rates", {})
        inv = {"EURUSD": "EUR", "GBPUSD": "GBP"}
        for sym in self.SYMBOLS:
            rate = rates.get(inv[sym] if sym in inv else sym[3:])
            if rate is None:
                continue
            price = 1.0 / float(rate) if sym in inv else float(rate)
            if price > 0:
                self.stats.mark_ok()
                await self.on_price(sym, price, self.name, bid=price, ask=price, ts_ms=now_ms())


class BiQuotePoller(RestPoller):
    name = "biquote"
    MAP = {"BTCUSDT": "BTCUSD", "ETHUSDT": "ETHUSD", "EURUSD": "EURUSD", "GBPUSD": "GBPUSD",
           "USDJPY": "USDJPY", "XAUUSD": "XAUUSD", "USOIL": "USOIL"}

    def __init__(self, symbols: list[str], on_price: Any, poll_ms: int = 2500) -> None:
        super().__init__(max(1500, poll_ms))
        self.symbols = [s for s in symbols if s in self.MAP]
        self.stats.symbols = self.symbols
        self.on_price = on_price
        self.enabled = bool(self.symbols)

    async def poll(self) -> None:
        url = "https://biquote.io/api/latest?" + "&".join(f"symbols={self.MAP[s]}" for s in self.symbols)
        d = await fetch_json(url, timeout=8)
        by_provider = {row.get("symbol"): row for row in d if isinstance(row, dict)}
        for sym in self.symbols:
            row = by_provider.get(self.MAP[sym])
            if not row:
                continue
            bid, ask = row.get("bid"), row.get("ask")
            mid = row.get("mid")
            if mid is None and bid and ask:
                mid = (float(bid) + float(ask)) / 2
            price = float(mid) if mid else (float(bid) if bid else None)
            if not price or price <= 0:
                continue
            if row.get("stale") and (row.get("quoteAgeSeconds") or 0) > 600:
                continue
            self.stats.mark_ok()
            await self.on_price(sym, price, self.name,
                                bid=float(bid) if bid else None, ask=float(ask) if ask else None,
                                change=row.get("dayDiffPercent"), ts_ms=now_ms())


class TradingViewPoller(RestPoller):
    name = "tradingview"
    MARKETS = {
        "forex-am": {"prefix": "OANDA:", "syms": ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "NZDUSD", "USDCHF"]},
        "crypto": {"prefix": "BINANCE:", "syms": ["BTCUSDT", "ETHUSDT"]},
        "cfd": {"prefix": "TVC:", "syms": ["USOIL"]},
        "america": {"prefix": "AMEX:", "syms": ["UUP"]},
    }

    def __init__(self, symbols: list[str], on_price: Any, poll_ms: int = 2500) -> None:
        super().__init__(max(1500, poll_ms))
        self.on_price = on_price
        self.stats.symbols = symbols
        self.enabled = True
        self.ticker_map: dict[str, str] = {}
        for market, cfg in self.MARKETS.items():
            for s in cfg["syms"]:
                if s in symbols:
                    self.ticker_map[f"{cfg['prefix']}{s}"] = s

    async def poll(self) -> None:
        for market, cfg in self.MARKETS.items():
            tickers = [f"{cfg['prefix']}{s}" for s in cfg["syms"] if f"{cfg['prefix']}{s}" in self.ticker_map]
            if not tickers:
                continue
            try:
                d = await fetch_json(
                    f"https://scanner.tradingview.com/{market}/scan",
                    method="POST", timeout=8, headers=build_headers("Mozilla/5.0 OmniceeTVQuotes/1.0"),
                    json_body={"symbols": {"tickers": tickers},
                               "columns": ["close", "bid", "ask", "change", "change_abs"]})
                for row in d.get("data", []):
                    ticker = row.get("s")
                    sym = self.ticker_map.get(ticker)
                    v = row.get("v") or []
                    close = float(v[0]) if len(v) > 0 and v[0] is not None else None
                    bid = float(v[1]) if len(v) > 1 and v[1] is not None else None
                    ask = float(v[2]) if len(v) > 2 and v[2] is not None else None
                    change = float(v[3]) if len(v) > 3 and v[3] is not None else None
                    price = close if close else ((bid + ask) / 2 if bid and ask else None)
                    if sym and price and price > 0:
                        self.stats.mark_ok()
                        await self.on_price(sym, price, self.name, bid=bid, ask=ask, change=change, ts_ms=now_ms())
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.stats.mark_error(exc)


class MarketInfoPoller(RestPoller):
    """CoinGecko global + Fear&Greed — on-demand style, polled slowly."""
    name = "market_info"

    def __init__(self, poll_ms: int = 300_000) -> None:
        super().__init__(poll_ms)
        self.fear_greed: dict[str, Any] | None = None
        self.crypto_global: dict[str, Any] | None = None
        self.enabled = True

    async def poll(self) -> None:
        try:
            d = await fetch_json("https://api.alternative.me/fng/?limit=1", timeout=10)
            row = (d.get("data") or [None])[0]
            if row:
                self.fear_greed = {"value": int(row["value"]), "label": row.get("value_classification", "Unknown"),
                                   "timestamp": int(row.get("timestamp", 0)) * 1000, "source": "alternative.me"}
                self.stats.mark_ok()
        except Exception as exc:
            log.warning("fear&greed poll failed: %s", exc)
        try:
            g = await fetch_json("https://api.coingecko.com/api/v3/global", timeout=12)
            gd = g.get("data", {})
            self.crypto_global = {
                "btcDominance": gd.get("market_cap_percentage", {}).get("btc"),
                "totalMarketCapUsd": gd.get("total_market_cap", {}).get("usd"),
                "marketCapChange24h": gd.get("market_cap_change_percentage_24h_usd"),
                "source": "coingecko", "timestamp": now_ms(),
            }
        except Exception as exc:
            log.warning("coingecko global poll failed: %s", exc)


class CalendarPoller(RestPoller):
    """ForexFactory weekly calendar, Finnhub + FMP fallbacks (priority order)."""
    name = "calendar"

    CCY = {"USD": "USD", "EUR": "EUR", "GBP": "GBP", "JPY": "JPY", "CHF": "CHF",
           "CAD": "CAD", "AUD": "AUD", "NZD": "NZD", "CNY": "USD"}
    TIER = {"high": "TIER_1", "medium": "TIER_2", "low": "TIER_3", "holiday": "TIER_4"}

    def __init__(self, finnhub_key: str, fmp_key: str, poll_ms: int = 900_000) -> None:
        super().__init__(poll_ms)
        self.finnhub_key = finnhub_key
        self.fmp_key = fmp_key
        self.events: list[dict[str, Any]] = []
        self.enabled = True
        self.backoff_until = 0.0

    async def poll(self) -> None:
        if time.time() < self.backoff_until:
            return
        merged: dict[str, dict[str, Any]] = {}
        sources: list[str] = []
        try:
            d = await fetch_json("https://nfs.faireconomy.media/ff_calendar_thisweek.json",
                                 timeout=15, headers=build_headers(UA))
            for ev in d if isinstance(d, list) else []:
                ts = self._parse_time(ev)
                if not ts:
                    continue
                ccy = str(ev.get("country", "")).upper()
                ccy = self.CCY.get(ccy, ccy if len(ccy) == 3 else "USD")
                impact = str(ev.get("impact", "")).lower()
                key = f"{ev.get('title', ev.get('name', 'Event'))}|{ccy}|{ts // 86_400_000}"
                merged[key] = {"name": ev.get("title", ev.get("name", "Economic Event")), "currency": ccy,
                               "time": ts, "impact": impact or None,
                               "tierHint": self.TIER.get(impact), "forecast": ev.get("forecast"),
                               "previous": ev.get("previous"), "actual": ev.get("actual"), "source": "forex-factory"}
            sources.append("forex-factory")
        except Exception as exc:
            msg = str(exc)
            self.stats.mark_error(exc)
            if "429" in msg:
                self.backoff_until = time.time() + 20 * 60
        if self.finnhub_key and len(merged) < 5:
            try:
                d = await fetch_json(f"https://finnhub.io/api/v1/calendar/economic?token={self.finnhub_key}", timeout=15)
                rows = d if isinstance(d, list) else d.get("economicCalendar") or d.get("data") or []
                for ev in rows:
                    try:
                        ts = to_ms(ev.get("time"))
                    except Exception:
                        ts = None
                    if not ts:
                        continue
                    impact_num = ev.get("impact")
                    impact = {3: "high", 2: "medium", 1: "low"}.get(impact_num) or str(impact_num or "").lower()
                    key = f"{ev.get('event', 'Event')}|{ev.get('country', '')}|{ts // 86_400_000}"
                    merged[key] = {"name": ev.get("event", "Economic Event"), "currency": ev.get("country", "USD"),
                                   "time": ts, "impact": impact, "tierHint": self.TIER.get(impact),
                                   "forecast": ev.get("estimate"), "previous": ev.get("prev"),
                                   "actual": ev.get("actual"), "source": "finnhub"}
                sources.append("finnhub")
            except Exception as exc:
                self.stats.mark_error(exc)
        if self.fmp_key and len(merged) < 5:
            try:
                to_d = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 7 * 86400))
                from_d = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))
                d = await fetch_json(
                    f"https://financialmodelingprep.com/stable/economic-calendar?from={from_d}&to={to_d}&apikey={self.fmp_key}",
                    timeout=15)
                for ev in d if isinstance(d, list) else []:
                    try:
                        ts = to_ms(ev.get("date"))
                    except Exception:
                        ts = None
                    if not ts:
                        continue
                    key = f"{ev.get('event', 'Event')}|{ev.get('country', '')}|{ts // 86_400_000}"
                    merged[key] = {"name": ev.get("event", "Economic Event"), "currency": ev.get("currency", "USD"),
                                   "time": ts, "impact": str(ev.get("impact", "")).lower() or None,
                                   "forecast": ev.get("estimate"), "previous": ev.get("previous"),
                                   "actual": ev.get("actual"), "source": "fmp"}
                sources.append("fmp")
            except Exception as exc:
                self.stats.mark_error(exc)
        if merged:
            self.events = list(merged.values())
            self.stats.mark_ok()

    def upcoming(self, limit: int = 100) -> list[dict[str, Any]]:
        now = time.time() * 1000
        rows = [e for e in self.events if e.get("time") and e["time"] >= now - 12 * 3600_000]
        impact_rank = {"high": 0, "medium": 1, "low": 2}
        rows.sort(key=lambda e: (impact_rank.get(str(e.get("impact")), 3), e["time"]))
        return rows[:limit]

    @staticmethod
    def _parse_time(ev: dict[str, Any]) -> int | None:
        raw = ev.get("timestamp") or ev.get("date")
        if raw is None:
            return None
        try:
            v = float(raw)
            return int(v * 1000) if v < 1e12 else int(v)
        except (TypeError, ValueError):
            try:
                return int(time.mktime(time.strptime(str(raw)[:19], "%Y-%m-%dT%H:%M:%S")) * 1000)
            except ValueError:
                return None


class AlphaVantageSentiment(RestPoller):
    name = "alpha_vantage_sentiment"
    TOPICS = "financial_markets,economy_macro,economy_monetary"

    def __init__(self, api_key: str, on_sentiment: Any) -> None:
        super().__init__(90 * 60_000)  # free quota is 25/day — deliberate
        self.api_key = (api_key or "").strip()
        self.on_sentiment = on_sentiment
        self.enabled = bool(self.api_key)
        self._quota_date: str | None = None
        self._last_label: str | None = None

    async def poll(self) -> None:
        if self._quota_date == time.strftime("%Y-%m-%d", time.gmtime()):
            return
        d = await fetch_json(
            f"https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics={self.TOPICS}&sort=LATEST&limit=50&apikey={self.api_key}",
            timeout=20)
        if "Note" in d or "Information" in d:
            self._quota_date = time.strftime("%Y-%m-%d", time.gmtime())
            log.warning("alpha vantage quota exhausted for today")
            return
        feed = d.get("feed") or []
        scores = [float(a["overall_sentiment_score"]) for a in feed
                  if a.get("overall_sentiment_score") not in (None, "")]
        if not scores:
            return
        avg = sum(scores) / len(scores)
        label = ("Bearish" if avg <= -0.35 else "Somewhat-Bearish" if avg <= -0.15
                 else "Neutral" if avg < 0.15 else "Somewhat-Bullish" if avg < 0.35 else "Bullish")
        top = feed[0]
        payload = {"score": round(avg, 3), "label": label, "articleCount": len(scores),
                   "topHeadline": top.get("title"), "topUrl": top.get("url"),
                   "topSource": top.get("source"), "timestamp": now_ms()}
        self.stats.mark_ok()
        await self.on_sentiment(payload)
        if label != self._last_label:
            self._last_label = label
            await self.on_sentiment({**payload, "kind": "sentiment_shift"})


class FredPoller(RestPoller):
    name = "fred"
    SERIES = {"EURUSD": ("DEXUSEU", False), "GBPUSD": ("DEXUSUK", False), "USDJPY": ("DEXJPUS", False)}

    def __init__(self, api_key: str, symbols: list[str], on_price: Any) -> None:
        super().__init__(30 * 60_000)
        self.api_key = (api_key or "").strip()
        self.symbols = [s for s in symbols if s in self.SERIES and self.api_key]
        self.stats.symbols = self.symbols
        self.on_price = on_price
        self.enabled = bool(self.symbols)

    async def poll(self) -> None:
        for sym in self.symbols:
            series_id, invert = self.SERIES[sym]
            try:
                d = await fetch_json(
                    f"https://api.stlouisfed.org/fred/series/observations?series_id={series_id}&api_key={self.api_key}&file_type=json&sort_order=desc&limit=5",
                    timeout=15)
                rows = d.get("observations") or []
                for row in rows:
                    val = row.get("value")
                    if val in (None, "."):
                        continue
                    price = float(val)
                    if invert:
                        price = 1.0 / price
                    if price > 0:
                        self.stats.mark_ok()
                        await self.on_price(sym, price, self.name, asOf=row.get("date"), mode="daily")
                        break
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.stats.mark_error(exc)
                return
            await asyncio.sleep(0.3)


def now_ms() -> int:
    return int(time.time() * 1000)
