# OMNICEE — React + Tailwind Terminal Dashboard

The dashboard, built to match the real backend schemas in this repo
(`api/server.js`, `db.js`'s `compactSignal()`/`getLearningProfiles()`,
`signal-pipeline/manual-mode.js`'s `SignalJournal.getStats()`,
`signal-pipeline/market-outlook.js`, `automation/market-heatmap.js`, and
the `bus.emit` → `io.emit` socket channels). It's the **only** frontend now
— the legacy vanilla-JS `webapp/` UI (`index.html`, `manifest.json`,
`sw.js`, `icons/`) has been removed; `webapp/ws-server.js` stays, since
it's a backend bridge module (`require('./webapp/ws-server')` in
`index.js`), not a frontend asset. `api/server.js`'s `STATIC_ROOT` now
points at `webapp-react/dist`, and `render.yaml`'s `buildCommand` builds it.

## What's here

- `src/App.jsx` — the full dashboard: 8 tabs (DASH/SIGNALS/INTEL/MONITOR/
  HEAT/VALID/TAPE/RISK) in a **bottom nav bar** (moved off the side — this
  is a mobile-first Telegram Mini App), live ticker tape, a working command
  bar, expandable signal rows (agent votes / gate checklist / signal-
  explainer reasons), a live market heat map, position-size calculator,
  drawdown gauge, and A+ signal toast alerts.
- `src/lib/api.js` — `fetch` + `socket.io-client` wrapper for every
  endpoint in `api/server.js`. `App.jsx` imports `connectOmniceeSocket`
  from here directly now.
- `public/manifest.json`, `public/icons/` — migrated from the retired
  `webapp/`, so the React app is installable (same theme colors).

## Live vs. demo — and why demo can show up on Render free tier

1. Probes the unauthenticated `GET /health` on load, then **keeps
   retrying every 4s in the background if it fails, indefinitely** —
   this was a one-shot 2.5s-timeout check before, which meant a cold
   Render free-tier instance (30-60s+ wake time) would fail the single
   attempt and get **permanently stuck showing demo data for the rest of
   the session**, even once the backend was actually up. Now: demo shows
   immediately so the screen is never blank, the top bar says
   **"Demo · Waking Backend"** while it keeps trying, and it silently
   flips to live the instant `/health` answers — no manual refresh needed.
   If you still see demo data for a long time, it means `/health` itself
   is genuinely not answering — check the Render service is deployed and
   not crash-looping, and that the keepalive cron is actually hitting
   `/health` (see repo-root notes on this).
2. Once live: polls `GET /api/signals` + `GET /api/stats` every 5s, `GET
   /api/outlook` / `heatmap` / `audit-trail` / `journal` / `learning`
   every 20s — **and** opens a Socket.IO connection for true push on top
   of that floor: `market` (per-symbol ticks), `signal` (new signals
   immediately), `balance` (real MT5 EA balance/equity). Top bar shows
   **LIVE · RT** once the socket connects, **LIVE · POLL** if only REST
   is up.

Two constants near the top of `src/App.jsx` control the REST half —
`API_BASE` (same-origin by default) and `APP_TOKEN`.

**Note on the chat-artifact preview specifically:** that preview runs
inside claude.ai's sandbox, which has no network path to your Render
backend, so it will always show demo data regardless of anything above —
that's expected and separate from the real deployed site.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api + /socket.io to :3001
```

Run the backend (`node start-all.js`) on port 3001 alongside it.
`npm run build` outputs `dist/`, which `api/server.js` now serves directly.

## Known gaps (by design, for now)

- **Equity curve is still illustrative**, live or demo — no dedicated
  equity-history endpoint yet, only point-in-time balance via
  `/api/stats`/`balance`.
- **Walk-Forward Efficiency and a single top-line Bayesian-confidence
  number aren't surfaced** — `walk-forward-optimizer.js` and
  `bayesian-engine.js` don't have dedicated REST fields yet, so VALID
  shows the real journal/learning numbers that *do* have endpoints (win
  rate, profit factor, expectancy, per-grade breakdown, per-pattern
  learning profiles) instead of guessing at those two.
- **Monte Carlo histogram on VALID is a simulated distribution**,
  clearly labeled as illustrative — `monte-carlo-engine.js` doesn't
  expose its paths over REST/socket yet.

Fixed this session, previously listed here: prices now tick from the
`market` socket channel instead of only moving on fresh signals;
DASH/RISK account balance now pulls from `/api/stats`/`balance` instead
of a hardcoded $10,000; the live/demo probe no longer gets permanently
stuck on a cold backend.

## Notes

- Colors/fonts: CSS custom properties inline in `App.jsx`, mirrored in
  `tailwind.config.js` (`emerald`/`gold`/`coral`/`blue`/`cyan`/`violet`,
  `font-display`/`font-mono`).
- Default symbols/timeframes/risk figures mirror this repo's actual
  `.env` defaults in `index.js`, not arbitrary placeholders.
