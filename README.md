# OMNICEE

**Institutional-style AI trading decision-support system**  
Developed by **James Yelbert**

Live: [omnicee.onrender.com](https://omnicee.onrender.com) · Repo: [github.com/cee999/omnicee](https://github.com/cee999/omnicee)

OMNICEE aggregates multi-agent confluence, session/risk gates, broker-grade prices (MetaTrader 5 / Exness), economic calendar, and adaptive learning into one desk-style web app. It is **decision support**, not a guarantee of profit. Markets are risky — paper-trade first.

---

## What it does

| Area | Capability |
|------|------------|
| **Signals** | Multi-agent ensemble (SMC, MTF, microstructure, fractal, momentum, volume/OI, sentiment, pattern) with score gates and conflict resolution |
| **Risk** | Position sizing, drawdown circuit breaker, session filter, correlation / intermarket checks |
| **Prices** | Prefer live **MT5 EA** bid/ask (Exness); fallbacks only when the EA is offline |
| **Intel** | Session briefing (“What to expect”), regime/tradeability, COT positioning, economic calendar |
| **News** | Multi-source forex / gold / oil / crypto-focused headlines |
| **Auth** | Email one-time code login (Brevo or SMTP); sessions persist on device |
| **Execution bridge** | MT5 EA pushes prices + balance; polls **approved** signals only |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  webapp-react (Vite)  — desk UI, PWA-installable             │
└────────────────────────────┬────────────────────────────────┘
                             │ REST + Socket.IO
┌────────────────────────────▼────────────────────────────────┐
│  start-all.js                                                │
│    ├─ api/server.js   REST, Socket.IO, static UI, EA routes │
│    └─ index.js        signal engine, agents, risk, feeds    │
└────────────────────────────┬────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   MongoDB Atlas      MT5 OmniceeEA.mq5      External feeds
   signals/sessions   prices + optional      Finnhub, calendar,
   users/outcomes     approved execution     news, COT, …
```

**Single Render service** builds the React app and runs API + engine in one process (`node start-all.js`).

---

## Repository layout

```
agents/              Multi-agent scorers (SMC, MTF, microstructure, …)
api/                 Express + Socket.IO server, email OTP auth
feeds/               Market data, news, calendar, COT, …
mt5/OmniceeEA.mq5    MetaTrader 5 bridge (prices + approved trades)
orchestrator/        Conflict resolution, audit, scheduling
risk-engine/         Drawdown, session filter, sizing, intermarket
signal-pipeline/     Scoring, regime, outlook, gates, learning
webapp-react/        Production frontend (Vite + React)
index.js             Signal / trading engine entry
start-all.js         Boots API then engine
render.yaml          Render Blueprint
.env.example         All environment variables documented
```

---

## Quick start (local)

```bash
git clone https://github.com/cee999/omnicee.git
cd omnicee
cp .env.example .env
# Edit .env — at minimum MONGODB_URI; for full desk also EA_SECRET, feed keys

npm install
npm --prefix webapp-react install
npm --prefix webapp-react run build

node start-all.js
# → http://localhost:3001  (or PORT)
```

Smoke test (no keys required for basic syntax path):

```bash
npm test
```

---

## Production (Render)

1. Connect this repo; use **Blueprint** (`render.yaml`) or a single **Web Service**.
2. **Build:**  
   `npm ci --omit=dev && npm --prefix webapp-react ci --include=dev && VITE_APP_TOKEN=$APP_ACCESS_TOKEN npm --prefix webapp-react run build`
3. **Start:** `node start-all.js`
4. **Health:** `GET /health`

### Required environment

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `MONGODB_DB` | Database name (default `omnicee_db`) |
| `EA_SECRET` | Shared secret for MT5 EA (`/api/ea/*`) |
| `SYMBOLS` | Comma list, e.g. `BTCUSDT,ETHUSDT,XAUUSD,USOIL,UUP,EURUSD,GBPUSD,USDJPY` |

### Email login (friends / web)

| Variable | Purpose |
|----------|---------|
| `EMAIL_AUTH_REQUIRED` | `true` to require login on the dashboard |
| `BREVO_API_KEY` | Brevo API key (recommended) |
| `EMAIL_FROM` | Must be valid: `OMNICEE <noreply@omnicee.app>` or `email@domain.com` — **no extra quotes** |

SMTP alternative: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`.

Flow: user enters email → 6-digit code (10 min TTL) → session token (~30 days on that device).

### Useful optional keys

- `APP_ACCESS_TOKEN` — alternate API token; baked into the UI build as `VITE_APP_TOKEN`
- `FINNHUB_API_KEY`, `FMP_API_KEY`, `ALPHA_VANTAGE_API_KEY` — news / calendar / macro
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` — alerts / Mini App
- `MIN_SIGNAL_SCORE`, `RISK_PCT_PER_TRADE`, `MAX_DAILY_LOSS_PCT`, `MAX_DRAWDOWN_PCT` — risk / quality bar
- `BROKER_PRICE_HOLD_MS` — how long MT5 ticks stay authoritative over weaker sources

Full list: [`.env.example`](.env.example).

---

## MetaTrader 5 / Exness bridge

File: [`mt5/OmniceeEA.mq5`](mt5/OmniceeEA.mq5)

1. Copy into `MQL5/Experts`, compile (0 errors).
2. **Tools → Options → Expert Advisors:** allow WebRequest for your server URL (e.g. `https://omnicee.onrender.com`).
3. Attach to **one** chart. Inputs:
   - `InpServerURL` = public HTTPS origin  
   - `InpEASecret` = same as Render `EA_SECRET`
4. EA:
   - Pushes **bid/ask** on a timer (`/api/ea/prices`)
   - Syncs **balance** (`/api/ea/balance`)
   - Polls **approved** signals only (`/api/ea/signals`) and can place trades with SL/TP

Symbol map (Exness-style suffixes) is inside `MapSymbol()` — adjust if your broker names differ. `UUP` is shown as **DXY** in the UI when used as dollar proxy.

---

## Web app (desk)

Tabs (typical):

- **Home** — live chart, market watch (broker ticks when EA is live), market voice + S/R, recent signals  
- **Signals** — filtered book by desk (Gold / FX / Oil / DXY / Crypto)  
- **Intel** — What to expect (session + briefing), regime, COT, economic calendar  
- **News** — multi-source, topic filters  
- **Desk / Valid / Monitor** — book tools, validation/learning, feed health  

Install: mobile browser → **Add to Home Screen**; desktop Chrome/Edge → install icon in the address bar.

---

## Signal path (high level)

1. Feeds + optional MT5 ticks update candles / quotes.  
2. Agents score direction and confidence.  
3. **Signal scorer** applies weights, adverse-selection / regime-aware penalties.  
4. **Conflict resolver** + institutional gates + session / drawdown checks.  
5. Approved signals persist (MongoDB), stream to UI, optional Telegram, and EA poll.  
6. Outcomes feed adaptive learning profiles over time.

Default symbols include major FX, gold, oil, dollar proxy (`UUP`), and major crypto pairs — override with `SYMBOLS`.

---

## Security notes

- Never commit real `.env` or live `EA_SECRET` / API keys.  
- Set `EA_SECRET` in production; without it, EA routes may be open.  
- Prefer `EMAIL_AUTH_REQUIRED=true` when sharing the URL with friends.  
- Brevo `EMAIL_FROM` must be a real address format or sends fail with HTTP 422.

---

## Scripts

| Command | Action |
|---------|--------|
| `node start-all.js` | Production-style: API + engine |
| `npm start` | Engine only (`index.js`) — no HTTP UI |
| `npm run start:api` | API only |
| `npm test` | Smoke tests |
| `npm run build --prefix webapp-react` | Build UI into `webapp-react/dist` |

---

## Disclaimer

OMNICEE does not guarantee profits. Past signals and backtests do not predict future results. You are solely responsible for trading decisions and broker compliance. Use at your own risk.

---

## License & author

Developed by **James Yelbert**.  
Repository: https://github.com/cee999/omnicee  
