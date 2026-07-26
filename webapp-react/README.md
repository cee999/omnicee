# OMNICEE — React + Tailwind Terminal Dashboard

A Bloomberg-terminal-style replacement for the vanilla-JS `webapp/` frontend,
built to match the real backend schemas in this repo (`api/server.js`,
`db.js`'s `compactSignal()`, `signal-pipeline/market-outlook.js`,
`automation/market-heatmap.js`, and the `bus.emit` → `io.emit` socket
channels).

## What's here

- `src/App.jsx` — the full dashboard: 8 tabs (DASH/SIGNALS/INTEL/MONITOR/
  HEAT/VALID/TAPE/RISK), F-key sidebar nav, live ticker tape, a working
  command bar, expandable signal rows (agent votes / gate checklist /
  signal-explainer reasons), a live market heat map, Monte Carlo histogram,
  position-size calculator, drawdown gauge.
- `src/lib/api.js` — `fetch` + `socket.io-client` wrapper for every endpoint
  in `api/server.js`, using the `x-app-token` / `auth.appToken` shared-token
  pattern from `validateAppToken`. Ready to use if you want to upgrade from
  polling (below) to real push updates.

## It's already wired to your backend

`App.jsx` no longer needs a manual swap — it now:

1. Probes the unauthenticated `GET /health` once on load.
2. If that succeeds, switches to **live mode**: polls `GET /api/signals`
   and `GET /api/stats` every 5s, and `GET /api/outlook`, `GET /api/heatmap`,
   `GET /api/audit-trail`, and `GET /api/health` (data-integrity) every 20s.
   The top bar shows **LIVE** and the Intel/Heat/Monitor tabs render the
   real `MarketOutlookBuilder` narrative, COT positioning, calendar,
   `MarketHeatMap` tiles, and feed-connectivity report instead of demo data.
3. If the probe fails (no backend reachable), it falls back to the original
   self-contained simulator and the top bar shows **DEMO DATA** — so the UI
   is never a blank screen, in Claude's preview or anywhere else.

Two constants near the top of `src/App.jsx` control where it looks:

```js
const API_BASE = '';   // '' = same origin. Set to an absolute URL (e.g.
                        // your Render URL) to point at a deployed backend
                        // from a different origin — CORS_ORIGIN defaults
                        // to '*' server-side, so this works out of the box.
const APP_TOKEN = '';   // set to your APP_ACCESS_TOKEN value if the
                        // backend requires it outside Telegram
```

This intentionally uses plain `fetch()`/polling rather than
`socket.io-client` so the *same* `App.jsx` works unmodified both here (a
real Vite build, where `socket.io-client` is available) and as a
standalone single-file preview elsewhere (where it isn't). `src/lib/api.js`
still ships the real-time socket version — `connectOmniceeSocket()` — for
when you want push updates instead of 5s/20s polling; see its source for
the channel list (`signal`/`market`/`risk`/`stats`/`regime`/`telemetry`/
`intel`/`feed_health`/`balance`/…).

## Running it

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api + /health to :3001
```

Run your existing backend (`node start-all.js`, per `ecosystem.config.js`)
on port 3001 alongside it — `vite.config.js` already proxies `/api`,
`/health`, and `/socket.io`.

For production, `npm run build` outputs `dist/`. Point Express's
`STATIC_ROOT` (in `api/server.js`) at this folder instead of (or behind a
route toggle from) the current `webapp/`, or serve `dist/` from a
`webapp-react/` static mount if you want both frontends live side by side
during rollout.

## It's now the live production frontend

`api/server.js`'s `STATIC_ROOT` points at `webapp-react/dist` (the retired
`webapp/` vanilla-JS frontend, including its `index.html`, has been
removed). `render.yaml`'s `buildCommand` builds this app during deploy —
locally, run `npm install && npm run build --prefix webapp-react` once (or
`npm run dev` here for hot-reload against the backend on :3001).

## Closed gaps (previously listed below as "by design, for now")

- **Prices now tick from a real feed, not just from signals.** `App.jsx`
  dynamically imports `socket.io-client` in live mode and subscribes to the
  `market` channel (`index.js`'s `market_update`, throttled to ~1/sec/
  symbol) for true push updates. The dynamic import (not a static
  top-level one) is deliberate — it keeps this file working unmodified as
  a standalone preview outside the real Vite build, where that package
  isn't resolvable; a failed import just leaves the original signal-driven
  REST polling as the price source, so nothing regresses. The top bar
  shows a `push`/`poll` tag reflecting which one is actually active.
- **Equity curve is real in live mode.** `db.getEquityCurve()` + `GET
  /api/equity-curve` compound each closed `trade_outcomes` row's `pnlPct`
  onto a starting balance, in `closedAt` order. This is realized-only (no
  floating/unrealized P&L between trades) — the dashboard labels it "live ·
  realized trades" rather than presenting it as more precise than it is,
  and falls back to the demo curve until the first trade closes.
- **DASH/RISK account-balance figures now pull from `/api/stats`'s
  `accountBalance` field** (and get pushed live over the `balance` socket
  channel the instant a new MT5 EA report lands). RISK's calculator still
  keeps the value user-editable for what-if sizing — the real balance only
  seeds it once, on the first real value.

## Also fixed while wiring this up

`App.jsx` and `src/lib/api.js` never actually sent Telegram's
`initData` anywhere, even though `api/telegram-auth.js`'s
`telegramAuthMiddleware` requires it (or a valid `x-app-token`) on every
`/api/*` route in production. Since this Mini App's primary surface *is*
Telegram, every authenticated request would have 401'd the moment this
went live outside of local dev. Both files now read
`window.Telegram.WebApp.initData` and send it as `x-telegram-init-data`
(REST) / `auth.initData` (socket) — a no-op outside Telegram, where that
object is simply `undefined`. `index.html` also now loads the Telegram
Mini App SDK script and the PWA manifest/icons (copied from the retired
`webapp/`), and calls `tg.ready()`/`tg.expand()` + registers the service
worker on mount, matching what the old file did.


## Notes

- Colors/fonts are defined twice on purpose: as CSS custom properties
  inline in `App.jsx` (so the component is portable/self-contained) *and*
  in `tailwind.config.js` (`emerald`/`gold`/`coral`/`blue`/`cyan`/`violet`,
  `font-display`/`font-mono`) if you'd rather refactor toward plain
  Tailwind classes over time.
- Default symbols/timeframes/risk figures shown (`EURUSD`/`XAUUSD`/
  `BTCUSDT`, `H1`/`H4`, 1.0% risk, $10,000 balance, 3%/10% daily-loss/
  drawdown caps) mirror this repo's actual `.env` defaults in `index.js`,
  not arbitrary placeholders.
