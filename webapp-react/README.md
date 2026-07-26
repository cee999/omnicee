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

## Known gaps (by design, for now)

- **Prices tick from signals, not a true feed.** REST polling has no
  endpoint for a continuous per-symbol price stream (that only exists on
  the `market` socket channel). In live mode, the ticker updates a
  symbol's price whenever a fresh signal references it — accurate, just
  not tick-by-tick. `connectOmniceeSocket()`'s `market` handler is the fix
  if you switch to sockets.
- **Equity curve stays illustrative even in live mode** — there's no
  dedicated equity-history endpoint in the current API, only point-in-time
  `/api/stats`. Worth adding a `db.getEquityCurve()` + route if you want
  this real too.
- **DASH/RISK account-balance figures** aren't yet pulled from
  `/api/stats`'s `accountBalance` field — still the demo-seeded number.
  Small follow-up if you want it.

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
