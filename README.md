# OMNICEE — AI Trading Assistant

OMNICEE is a trading decision-support system. It can enforce risk gates, store outcomes, learn from failed setup fingerprints, and alert you, but it cannot guarantee accuracy or eliminate market risk. Run it in paper mode first and only risk money after audited out-of-sample performance.

## Quick Start

```bash
# 1. Copy env template
cp .env.example .env

# 2. Fill in your values in .env (at minimum: TELEGRAM_BOT_TOKEN, SYMBOLS)
nano .env

# 3. Install dependencies
npm install

# 4. Run smoke test (no API keys needed)
npm test

# 5. Start the system
# FIX: `npm start` alone only runs index.js (the trading/signal engine) —
# it opens no HTTP port at all, so there is no web app, no Mini App, and no
# REST API to hit. index.js and api/server.js share live data through an
# in-memory EventEmitter, which only works if both run in the same process
# — use start:all (or pm2:start / the Render blueprint, which do the same
# thing) for anything that needs the web app or Telegram Mini App.
npm run start:all
```

## Directory Structure

```
omnicee/
├── index.js                  ← MAIN ENTRY POINT — boot everything here
├── package.json
├── .env.example              ← Copy to .env and fill in keys
│
├── agents/                   ← 5 specialized signal agents
│   ├── smc-agent.js          ← Smart Money Concepts (OB, FVG, BOS, sweeps)
│   ├── mtf-agent.js          ← Multi-timeframe alignment + HTF bias
│   ├── momentum-agent.js     ← RSI, MACD, EMA stack, VWAP, Ichimoku, BB
│   ├── sentiment-agent.js    ← News NLP, COT, Fear/Greed
│   └── pattern-agent.js      ← Wyckoff, harmonics, classic patterns
│
├── orchestrator/
│   ├── conflict-resolver.js  ← Agent vote arbitration (weighted majority)
│   ├── memory-manager.js     ← Signal history + stats (in-memory → Redis → PG)
│   └── task-planner.js       ← Full orchestrator (alternative to index.js)
│
├── signal-pipeline/
│   ├── signal-scorer.js      ← Weighted confluence scorer (75+ = fire)
│   ├── sl-tp-engine.js       ← Structure-based SL + multi-TP
│   ├── entry-optimizer.js    ← OTE/FVG/OB zone refinement
│   ├── alert-dispatcher.js   ← Telegram bot delivery
│   └── manual-mode.js        ← Position tracker + journal
│
├── risk-engine/
│   ├── position-sizer.js     ← ATR/Kelly/Fixed sizing (class: RiskEngine)
│   ├── drawdown-guard.js     ← Circuit breaker (daily/DD/streak limits)
│   ├── session-filter.js     ← Killzone + liquidity quality gates
│   └── correlation.js        ← Portfolio correlation checker
│
├── feeds/
│   ├── binance-ws.js         ← Crypto: BTC, ETH real-time OHLCV
│   ├── bybit-ws.js           ← Crypto: perps, funding, OI
│   ├── twelve-data.js        ← Forex + commodities: XAUUSD, EURUSD, etc.
│   └── news-feed.js          ← Headlines, sentiment, COT
│
└── test/
    └── smoke-test.js         ← Verifies all modules load + pipeline runs
```

## Signal Flow

```
BinanceFeed/TwelveData
       ↓ candle closed
  onCandle() [index.js]
       ↓
  [SMC + MTF + Momentum + Volume/OI] — parallel
       ↓
  ConflictResolver.resolve()
       ↓
  SignalScorer.score() — minimum 75/100 to fire
       ↓
  RegimeEngine + EntryOptimizer + SLTPEngine + RiskEngine
       ↓
  AdaptiveLearningEngine checks prior losing fingerprints
       ↓
  InstitutionalGates approves/rejects
       ↓
  MongoDB Atlas + Socket.IO Mini App + Telegram alerts
```

## Production Layers Added

- Express REST API at `api/server.js`.
- Socket.IO live transport at `/socket.io`.
- Telegram Mini App init-data validation in `api/telegram-auth.js`.
- MongoDB Atlas persistence in `db.js` with TTL indexes for free-tier control.
- Adaptive trade-outcome learning in `signal-pipeline/adaptive-learning-engine.js`.
- Finnhub adapter in `feeds/finnhub-feed.js`.
- PM2 process file in `ecosystem.config.js`.
- Nginx/Let’s Encrypt reverse-proxy template in `deploy/nginx.omnicee.conf`.
- Modern matrix-based Mini App UI in `webapp/index.html`.

## Mini App Deployment

1. Put secrets in `.env`, not source. URL-encode special characters in MongoDB passwords, for example `@` becomes `%40`.
2. Run locally with `npm run start:all`, then open `http://localhost:3001/`.
3. For Telegram production, deploy behind HTTPS and set the Mini App URL in BotFather to your public `https://your-domain.com/`.
4. The same URL is also a real installable PWA (`webapp/manifest.json` + `webapp/sw.js`) — open it in a browser (not inside Telegram) and use the browser's "Install" / "Add to Home Screen" prompt for a standalone app icon outside Telegram. Only the static shell is cached offline; signals/prices/risk data always require a live connection by design.
5. On a VPS, use:

```bash
npm install -g pm2
npm run pm2:start
sudo cp deploy/nginx.omnicee.conf /etc/nginx/sites-available/omnicee
sudo ln -s /etc/nginx/sites-available/omnicee /etc/nginx/sites-enabled/omnicee
sudo certbot --nginx -d your-domain.com
```

## Learning Loop

When you mark a signal as WIN, BREAKEVEN, or LOSS in the Mini App, OMNICEE stores the setup fingerprint in MongoDB. Future signals with the same fingerprint receive an adaptive penalty, warning, or hard block when historical outcomes are poor.

## Environment Variables

See `.env.example` for full list. Minimum needed:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_IDS` | Your Telegram user/group ID(s) |
| `SYMBOLS` | e.g. `BTCUSDT,XAUUSD,EURUSD` |
| `TWELVE_DATA_API_KEY` | Required for forex/commodities |

## Notes

- **No Redis/PostgreSQL needed to start** — MemoryManager falls back to in-memory automatically
- `XAUUSD`, `EURUSD`, `GBPUSD` require `TWELVE_DATA_API_KEY`
- `BTCUSDT`, `ETHUSDT` use Binance WebSocket (no key needed for public streams)
- `MIN_SIGNAL_SCORE=75` means Grade B+ only fires. Lower to `65` to see more signals during testing.
