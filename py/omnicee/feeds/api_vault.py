"""API vault — researched catalog of upstream data providers.

This is the single place to add a new market-data source. Priorities encode
what to integrate next; `envKey` names the config setting that enables it.

Ranked from the 2026 API landscape research:
  * Free tier champions: Finnhub (60 req/min), Twelve Data (800/day),
    Tiingo (1000/day), Alpha Vantage (25/day), exchangerate.host,
    Frankfurter (ECB), Binance public WS, CoinGecko, alternative.me FNG.
  * Institutional depth (paid): EODHD, FMP, Polygon.io, sec-api.io.
  * Alternative data: CFTC COT (free SODA), OpenInsider via ParseBot,
    StockTwits sentiment, Treasury fiscal data, FRED.
"""

from __future__ import annotations

from typing import Any

CATALOG: list[dict[str, Any]] = [
    # id, name, category, url, auth, note, priority, envKey, integrated
    {"id": "binance", "name": "Binance Public Streams", "category": "crypto-prices",
     "url": "https://stream.binance.com:9443", "auth": "none", "priority": 100,
     "envKey": None, "integrated": True, "note": "BTC/ETH trade WS, no key"},
    {"id": "deriv", "name": "Deriv WS", "category": "forex-prices",
     "url": "https://ws.derivws.com", "auth": "app_id", "priority": 96,
     "envKey": "DERIV_APP_ID", "integrated": True, "note": "FX/metals/crypto ticks + 500-bar history"},
    {"id": "finnhub", "name": "Finnhub", "category": "prices-news-calendar",
     "url": "https://finnhub.io", "auth": "token", "priority": 90,
     "envKey": "FINNHUB_API_KEY", "integrated": True, "note": "60 req/min free; WS trades, news, calendar"},
    {"id": "tradingview", "name": "TradingView Scanner", "category": "forex-prices",
     "url": "https://scanner.tradingview.com", "auth": "none", "priority": 85,
     "envKey": None, "integrated": True, "note": "public scan endpoint, POST quotes"},
    {"id": "biquote", "name": "BiQuote", "category": "forex-prices",
     "url": "https://biquote.io", "auth": "none", "priority": 80,
     "envKey": None, "integrated": True, "note": "2.5s batch quotes"},
    {"id": "coingecko", "name": "CoinGecko", "category": "crypto-analytics",
     "url": "https://api.coingecko.com", "auth": "none", "priority": 78,
     "envKey": None, "integrated": True, "note": "global market cap + dominance"},
    {"id": "alternative-me", "name": "Fear & Greed Index", "category": "sentiment",
     "url": "https://api.alternative.me", "auth": "none", "priority": 75,
     "envKey": None, "integrated": True, "note": "crypto fear & greed"},
    {"id": "cftc", "name": "CFTC Commitments of Traders", "category": "positioning",
     "url": "https://publicreporting.cftc.gov", "auth": "none", "priority": 74,
     "envKey": None, "integrated": True, "note": "SODA API, weekly COT"},
    {"id": "yahoo-quotes", "name": "Yahoo Finance Quotes", "category": "prices",
     "url": "https://query1.finance.yahoo.com", "auth": "none", "priority": 72,
     "envKey": None, "integrated": True, "note": "chart endpoint, 8s cycle"},
    {"id": "yahoo-news", "name": "Yahoo Finance News", "category": "news",
     "url": "https://query1.finance.yahoo.com/v1/finance/search", "auth": "none", "priority": 70,
     "envKey": None, "integrated": True, "note": "22-topic fan-out, relevance scored"},
    {"id": "exchangerate-host", "name": "open.er-api.com", "category": "forex-prices",
     "url": "https://open.er-api.com", "auth": "none", "priority": 65,
     "envKey": None, "integrated": True, "note": "30s USD rates"},
    {"id": "frankfurter", "name": "Frankfurter (ECB)", "category": "forex-prices",
     "url": "https://api.frankfurter.app", "auth": "none", "priority": 62,
     "envKey": None, "integrated": True, "note": "official ECB reference rates"},
    {"id": "forex-factory", "name": "ForexFactory Calendar", "category": "calendar",
     "url": "https://nfs.faireconomy.media/ff_calendar_thisweek.json", "auth": "none", "priority": 60,
     "envKey": None, "integrated": True, "note": "weekly file, 20min 429 backoff"},
    {"id": "fred", "name": "FRED (St. Louis Fed)", "category": "macro",
     "url": "https://api.stlouisfed.org", "auth": "api_key", "priority": 55,
     "envKey": "FRED_API_KEY", "integrated": True, "note": "daily official FX fixings"},
    {"id": "alpha-vantage", "name": "Alpha Vantage News Sentiment", "category": "sentiment",
     "url": "https://www.alphavantage.co", "auth": "api_key", "priority": 52,
     "envKey": "ALPHA_VANTAGE_API_KEY", "integrated": True, "note": "25/day free, 90min poll"},
    {"id": "stockdata", "name": "StockData.org", "category": "equities-eod",
     "url": "https://api.stockdata.org", "auth": "api_token", "priority": 50,
     "envKey": "STOCKDATA_API_TOKEN", "integrated": True, "note": "US equities quotes + EOD"},
    {"id": "aletheia", "name": "Aletheia", "category": "equities",
     "url": "https://api.aletheiaapi.com", "auth": "api_key", "priority": 45,
     "envKey": "ALETHEIA_API_KEY", "integrated": True, "note": "UUP/USO quotes"},
    {"id": "treasury", "name": "US Treasury Fiscal Data", "category": "forex-official",
     "url": "https://api.fiscaldata.treasury.gov", "auth": "none", "priority": 42,
     "envKey": None, "integrated": True, "note": "quarterly official rates"},
    {"id": "fmp", "name": "Financial Modeling Prep", "category": "calendar-fundamentals",
     "url": "https://financialmodelingprep.com/stable", "auth": "api_key", "priority": 40,
     "envKey": "FMP_API_KEY", "integrated": True, "note": "economic calendar fallback"},
    {"id": "myfxbook", "name": "Myfxbook Community Sentiment", "category": "positioning",
     "url": "https://www.myfxbook.com/api", "auth": "email+password", "priority": 38,
     "envKey": "MYFXBOOK_EMAIL", "integrated": False, "note": "retail long/short, contrarian signal"},
    {"id": "parsebot-openinsider", "name": "OpenInsider via ParseBot", "category": "insider",
     "url": "https://api.parse.bot/v1/open-insider-scraper", "auth": "api_key", "priority": 35,
     "envKey": "PARSE_API_KEY", "integrated": False, "note": "insider cluster buys"},
    # Candidates — researched, not yet integrated:
    {"id": "twelve-data", "name": "Twelve Data", "category": "prices",
     "url": "https://api.twelvedata.com", "auth": "api_key", "priority": 34,
     "envKey": "TWELVE_DATA_API_KEY", "integrated": False, "note": "800 req/day free; forex+stocks+crypto"},
    {"id": "tiingo", "name": "Tiingo", "category": "prices-news",
     "url": "https://api.tiingo.com", "auth": "api_key", "priority": 32,
     "envKey": "TIINGO_API_KEY", "integrated": False, "note": "1000 req/day free; clean EOD + news"},
    {"id": "eodhd", "name": "EOD Historical Data", "category": "prices-fundamentals",
     "url": "https://eodhd.com", "auth": "api_token", "priority": 30,
     "envKey": "EODHD_API_TOKEN", "integrated": False, "note": "60+ exchanges, insider + fundamentals"},
    {"id": "stocktwits", "name": "StockTwits", "category": "sentiment",
     "url": "https://api.stocktwits.com", "auth": "none", "priority": 28,
     "envKey": None, "integrated": False, "note": "streaming social sentiment"},
    {"id": "ccxt", "name": "CCXT (100+ exchanges)", "category": "crypto-prices",
     "url": "https://github.com/ccxt/ccxt", "auth": "varies", "priority": 26,
     "envKey": None, "integrated": False, "note": "unified crypto exchange layer"},
    {"id": "marketstack", "name": "Marketstack", "category": "equities",
     "url": "https://marketstack.com", "auth": "api_key", "priority": 24,
     "envKey": None, "integrated": False, "note": "100 req/month free"},
    {"id": "polygon", "name": "Polygon.io", "category": "prices-institutional",
     "url": "https://polygon.io", "auth": "api_key", "priority": 22,
     "envKey": None, "integrated": False, "note": "paid; institutional-grade ticks"},
    {"id": "nasdaq-data-link", "name": "Nasdaq Data Link (Quandl)", "category": "macro-alternative",
     "url": "https://data.nasdaq.com", "auth": "api_key", "priority": 20,
     "envKey": None, "integrated": False, "note": "economic + alternative datasets"},
]


def list_by_category(category: str) -> list[dict[str, Any]]:
    return [c for c in CATALOG if c["category"] == category]


def not_integrated() -> list[dict[str, Any]]:
    return sorted((c for c in CATALOG if not c["integrated"]), key=lambda c: -c["priority"])


def status_report() -> dict[str, Any]:
    return {"total": len(CATALOG), "integrated": sum(1 for c in CATALOG if c["integrated"]),
            "candidates": not_integrated(), "source": "researched 2026 api landscape"}
