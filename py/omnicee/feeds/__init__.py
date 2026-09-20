"""Feed layer: live market data in pure Python.

Replaces the Node `feeds/` directory. Two kinds of source:
  * WebSocket streams (Binance, Deriv, Finnhub) — event-driven ticks.
  * REST pollers (Yahoo, exchangerate.host, Frankfurter, BiQuote, TradingView
    scanner, CoinGecko, Fear&Greed, ForexFactory, FRED, StockData, Aletheia,
    Alpha Vantage sentiment, Treasury, FMP) — interval polls.

All ticks funnel through FeedManager, which owns:
  * candle aggregation per (symbol, timeframe)
  * source-priority resolution (identical ranks to the Node engine)
  * `price` and `candles` emission on the event bus
  * is_connected / health reporting

Rules honoured: never emit a fabricated price; unknown fields are null;
timestamps are always ms epoch; every failure is logged and surfaced via
`feed_health`.
"""

from .base import SOURCE_RANK, FeedStats, build_headers
from .integrity import DataIntegrityMonitor
from .manager import FeedManager

__all__ = ["SOURCE_RANK", "DataIntegrityMonitor", "FeedManager", "FeedStats", "build_headers"]
