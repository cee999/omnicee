# OMNICEE — React + Tailwind Terminal Dashboard

A Bloomberg-terminal-style replacement for the vanilla-JS `webapp/` frontend,
built to match the real backend schemas in this repo (`api/server.js`,
`db.js`'s `compactSignal()`, and the `bus.emit` → `io.emit` socket channels).

## What's here

- `src/App.jsx` — the full dashboard: 8 tabs (DASH/SIGNALS/INTEL/MONITOR/
  HEAT/VALID/TAPE/RISK), F-key sidebar nav, live ticker tape, a working
  command bar, expandable signal rows (agent votes / gate checklist /
  signal-explainer reasons), correlation + relative-strength heatmaps,
  Monte Carlo histogram, position-size calculator, drawdown gauge.
- `src/lib/api.js` — real `fetch`/`socket.io-client` wrapper for every
  endpoint documented in `api/server.js`, using the same `x-app-token` /
  `auth.appToken` shared-token pattern as `validateAppToken`.
- Right now `App.jsx` runs on `useLiveFeed()`, a self-contained simulator
  (see below) so the UI is fully interactive out of the box with zero
  backend dependency — useful for local design work or a demo link.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api + /socket.io to :3001
```

Run your existing backend (`node start-all.js`, per `ecosystem.config.js`)
on port 3001 alongside it — `vite.config.js` already proxies both.

For production, `npm run build` outputs `dist/`. Point Express's
`STATIC_ROOT` (in `api/server.js`) at this folder instead of (or behind a
route toggle from) the current `webapp/`, or serve `dist/` from a
`webapp-react/` static mount if you want both frontends live side by side
during rollout.

## Wiring it to the real backend

`App.jsx`'s `useLiveFeed()` hook is the seam. To go live, replace its body
with `OmniceeAPI` calls and a `connectOmniceeSocket()` subscription, e.g.:

```js
import { OmniceeAPI, connectOmniceeSocket } from './lib/api';

useEffect(() => {
  OmniceeAPI.signals({ limit: 50 }).then(r => setSignals(r.signals));
  OmniceeAPI.stats().then(r => setStats(r.stats));
  const socket = connectOmniceeSocket({
    signal: (payload) => setSignals(prev => [payload, ...prev].slice(0, 50)),
    market: (payload) => setPrices(prev => ({ ...prev, ...payload })),
    stats: (payload) => setStats(payload),
  });
  return () => socket.disconnect();
}, []);
```

Set `VITE_APP_TOKEN` in `.env` (copy `.env.example`) to your
`APP_ACCESS_TOKEN` value if the backend requires it outside Telegram.

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
