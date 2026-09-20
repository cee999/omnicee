"""Yahoo Finance news — port of Node `feeds/yahoo-news-feed.js`.

22 fixed topic queries fanned out concurrently, relevance-scored, noise
filtered. Scores >= 5 survive. Identical category regexes and ranking.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from .base import build_headers, fetch_json
from .rest_pollers import now_ms

log = logging.getLogger(__name__)

UA = "Mozilla/5.0 (compatible; OmniceeNews/1.0)"

TOPIC_QUERIES = [
    "bitcoin", "ethereum", "crypto market", "gold price", "oil price", "dollar index",
    "forex market", "federal reserve", "interest rates", "inflation", "stock market",
    "treasury yields", "central bank", "euro", "yen", "emerging markets",
    "commodities", "earnings", "geopolitics", "recession", "gdp", "employment",
]

CRYPTO_RE = re.compile(r"bitcoin|btc|ethereum|eth|crypto|blockchain|solana|xrp|stablecoin", re.I)
FOREX_RE = re.compile(r"eur/usd|gbp/usd|usd/jpy|forex|currency|dollar|euro|yen|sterling", re.I)
COMMODITY_RE = re.compile(r"gold|silver|oil|crude|opec|copper|commodity", re.I)
MACRO_RE = re.compile(r"federal reserve|fed|fomc|inflation|cpi|gdp|unemployment|central bank|rate", re.I)
STOCKS_RE = re.compile(r"stock|shares|equity|nasdaq|s&p|dow|russell|ipo|earnings", re.I)
NOISE_RE = re.compile(r"clip|transcript|video|podcast|webinar|newsletter sign", re.I)


def _category(headline: str) -> str:
    if CRYPTO_RE.search(headline):
        return "crypto"
    if FOREX_RE.search(headline):
        return "forex"
    if COMMODITY_RE.search(headline):
        return "commodity"
    if MACRO_RE.search(headline):
        return "macro"
    return "markets"


def _score(item: dict[str, Any], headline: str) -> int:
    score = 0
    if CRYPTO_RE.search(headline):
        score += 8
    if FOREX_RE.search(headline):
        score += 8
    if re.search(r"dxy|dollar index", headline, re.I):
        score += 5
    if MACRO_RE.search(headline):
        score += 4
    if COMMODITY_RE.search(headline):
        score += 3
    if STOCKS_RE.search(headline) and not (CRYPTO_RE.search(headline) or FOREX_RE.search(headline)
                                           or COMMODITY_RE.search(headline) or MACRO_RE.search(headline)):
        score -= 4
    age_h = (now_ms() - int(item.get("datetime") or 0)) / 3_600_000
    if age_h < 6:
        score += 2
    elif age_h < 24:
        score += 1
    return score


async def fetch_news(limit: int = 30, symbol: str | None = None) -> list[dict[str, Any]]:
    queries = [symbol] if symbol else TOPIC_QUERIES
    sem = asyncio.Semaphore(6)

    async def one(q: str) -> list[dict[str, Any]]:
        async with sem:
            try:
                d = await fetch_json(
                    f"https://query1.finance.yahoo.com/v1/finance/search?q={q}&newsCount=6&quotesCount=0",
                    timeout=10, headers=build_headers(UA))
                return d.get("news") or []
            except Exception:
                return []

    batches = await asyncio.gather(*(one(q) for q in queries))
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for batch in batches:
        for n in batch:
            headline = n.get("title") or ""
            if not headline or NOISE_RE.search(headline):
                continue
            key = headline.lower()[:80]
            if key in seen:
                continue
            seen.add(key)
            ts = n.get("providerPublishTime")
            try:
                ts = int(float(ts) * 1000) if ts and float(ts) < 1e12 else int(float(ts or 0)) or now_ms()
            except (TypeError, ValueError):
                ts = now_ms()
            category = _category(headline)
            item = {"headline": headline, "summary": "", "source": n.get("publisher"),
                    "url": n.get("link"), "datetime": ts, "category": category,
                    "symbol": (n.get("relatedTickers") or [None])[0]}
            score = _score(item, headline)
            if score >= 5:
                items.append({**item, "score": score})
    items.sort(key=lambda x: (-x["score"], -x["datetime"]))
    return items[:limit]
