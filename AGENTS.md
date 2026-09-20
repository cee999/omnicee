# AGENTS.md — start here

Read this before writing code. It takes two minutes and will save you hours.

Multiple AI agents work on this repository in parallel (Claude, Codex, Grok).
That is the single biggest source of wasted work here: two agents building the
same feature, or one agent's push clobbering another's. This file exists to
stop that.

---

## Current state of the repo

There is **one backend**: Python, in [`py/`](./py). The Node runtime was fully
retired (owner decision); every Node module was ported behaviour-for-behaviour
(porting specs were extracted from the code before deletion — see the git
history of the migration commit).

| | location | language | owns |
|---|---|---|---|
| **Everything** | [`py/`](./py) | Python | feeds (WS + REST), candle stores, regime, 8 agents, consensus, calibration, validation stack (Monte Carlo / Bayesian / statistical / walk-forward / ensemble), risk stack, SL/TP + trap/compression/cycle engines, gold desk, orchestrator loop, REST `/api/*`, Socket.IO (`/socket.io`), Telegram + email auth, alerts, Mongo persistence, MT5 EA bridge, static `webapp-react/dist` |

Single service entrypoint: `omnicee.api.app:asgi` (FastAPI + python-socketio
combined ASGI app). `DISABLE_ENGINE=1` gives you the old stateless-brain mode.

**Before touching `py/`, read [`py/AGENTS.md`](./py/AGENTS.md).** It holds the
architecture contract, the engineering rules in priority order, the two bugs
that must not be reintroduced, and the migration status table.

---

## Where the work is up to

The Node-to-Python migration is **complete and tested** (29 pytest green).
Stage table: [`py/AGENTS.md`](./py/AGENTS.md) section 9. The frontend
(`webapp-react/`) is unchanged and contract-compatible — same REST paths, same
Socket.IO path/events.

Next candidate work: Myfxbook sentiment + OpenInsider feeds (keys exist in
config), the researched API-vault candidates (Twelve Data, Tiingo, EODHD — see
`py/omnicee/feeds/api_vault.py`), and frontend polish on the new
engine-status endpoints (`/api/engine`, `/api/feed-health`, `/api/api-vault`).

Full stage table: [`py/AGENTS.md`](./py/AGENTS.md) section 9. **Update it in
the same commit as your code.** A status table that lags the code is worse
than no table.

---

## Rules that apply to every agent, in both languages

1. **Never fabricate a number.** Unknown means `null`, never zero, never the
   last known value, never a plausible default. If real data is unavailable
   the UI shows `DATA UNAVAILABLE`. A dashboard showing an invented price is
   worse than one showing nothing.
2. **Confidence must be earned.** A raw model score is not a probability.
   Do not display one as a percentage.
3. **Risk gates are final.** No agent, model or advisor overrides them.
4. **Silence is never an output.** "Nothing fired" and "it crashed" must never
   look the same to the user. Return the reason.
5. **Do not swallow exceptions.** Log them, surface them, degrade visibly.
6. **Do not delete working code** because a rewrite looks cleaner. Incremental
   improvement wins. See `.grok/` and the repo history — this codebase has
   already survived several near-rewrites.

---

## Coordination — read this part twice

Parallel pushes to `main` have repeatedly caused merge conflicts and lost
work in this repo.

- **Work on a branch named for your session.** `py/stage-2-shadow-mode`,
  `fix/chart-mobile-layout`. Not `main`.
- **`git pull` before you start, and read this file again.** Another agent may
  have changed it an hour ago.
- **Check the branch list before building a feature.** Someone may already be
  halfway through it. This has happened more than once.
- **Never commit `node_modules`.** It was tracked once and caused spurious
  conflicts on every install. It is in `.gitignore` — keep it there.
- **Never commit a token, key or password.** If you find one in the history,
  say so loudly and tell the owner to revoke it.

---

## Deployment constraints — check before adding any dependency

Production is **Render free tier: 512 MB RAM, 0.1 CPU, spins down when idle**,
Singapore region, with MongoDB Atlas M0.

Measured install sizes, not estimates:

| package | size | verdict |
|---|---|---|
| numpy + scipy + scikit-learn + FastAPI | ~220 MB | fits |
| onnxruntime | ~54 MB | fits — this is the route for neural models |
| PyTorch | ~900 MB | **will not run** |
| TensorFlow | ~600 MB+ | **will not run** |

To use neural models: train offline, export to ONNX, commit the `.onnx` file,
infer with `onnxruntime`. There is no other route that fits this box.
