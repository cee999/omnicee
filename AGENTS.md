# AGENTS.md — start here

Read this before writing code. It takes two minutes and will save you hours.

Multiple AI agents work on this repository in parallel (Claude, Codex, Grok).
That is the single biggest source of wasted work here: two agents building the
same feature, or one agent's push clobbering another's. This file exists to
stop that.

---

## Current state of the repo

There is **one backend**: Python, at the **repo root** as top-level modules (no package wrapper).
The Node runtime was fully retired (owner decision) and the backend now lives
at the root, not in `py/` — every Node module was ported
behaviour-for-behaviour (porting specs were extracted from the code before
deletion — see the git history of the migration commit).

| | location | language | owns |
|---|---|---|---|
| **Everything** | [top-level modules](.) | Python | feeds (WS + REST), candle stores, regime, 8 agents, consensus, calibration, validation stack (Monte Carlo / Bayesian / statistical / walk-forward / ensemble), risk stack, SL/TP + trap/compression/cycle engines, gold desk, orchestrator loop, REST `/api/*`, Socket.IO (`/socket.io`), Telegram + email auth, alerts, Mongo persistence, MT5 EA bridge, static `webapp-react/dist` |

Single service entrypoint: `api.app:asgi` (FastAPI + python-socketio
combined ASGI app), run from the repo root. `DISABLE_ENGINE=1` gives you the
old stateless-brain mode.

### Layout

```
config.py           all env, validated once at boot. Nothing else reads os.environ.
  pipeline.py         the analysis chain. One entry point: analyse().
  contracts/          Candle, Series, MarketSnapshot, Signal, AgentVote, Consensus
  features/           numpy indicators, SMC structure, two-axis regime classifier
  agents/             8 scorers. base.py = timeout + isolation. registry.py = wiring.
  ensemble/           weighted voting, isotonic calibration, validation stack
  risk/               deterministic gates, sizing, risk stack
  engines/            SL/TP, trap, compression, cycle engines
  feeds/              Binance/Deriv/Finnhub WS + REST pollers, news, COT, api_vault
  orchestrator/       engine loop, audit, opportunity ranker
  services/           bus, db (Mongo), auth, alerts, persist (crash cache)
  api/                FastAPI + Socket.IO (single ASGI app)
tests/                pytest suite — run it before every push
requirements.txt      runtime deps (~220 MB installed — see deployment constraints)
```

---

## The rules, in priority order

These are not style preferences. Breaking one is a bug even if tests pass.

1. **Never fabricate a number.** If a value is unknown it is `null`. Not zero,
   not the previous bar's value, not a plausible-looking default. A dashboard
   that shows a made-up price is worse than one that shows nothing.
2. **Confidence must be calibrated or absent.** A raw ensemble score is not a
   probability. `confidence` stays `null` until `Calibrator` has fitted on
   enough real closed outcomes (see Calibration below).
3. **Risk gates are deterministic and final.** No agent, no model, no AI
   advisor overrides `risk/gates.py`. Gates block with stated reasons.
4. **Silence is never an output.** Every analysis returns a body. Either a
   signal, or `blocked_reasons` saying exactly why not. "Nothing fired" and
   "the pipeline crashed" must never look identical to the UI.
5. **Agents are isolated.** An agent that raises or hangs returns a FLAT vote
   carrying its error. It never propagates. `agents/base.py` enforces this —
   do not bypass it by calling `evaluate()` directly in production paths.
6. **Failed agents are excluded from consensus, not counted as neutral.**
   Counting a crashed agent as FLAT quietly drags the score toward zero and
   makes a broken pipeline look merely indecisive.
7. **No stale analysis.** Price older than `MAX_PRICE_AGE_MS` blocks.
8. **Contracts are the source of truth.** Anything crossing the API boundary
   is defined in `contracts/`. FastAPI publishes them at
   `/openapi.json`. Do not hand-write a duplicate type.
9. **Do not swallow exceptions.** Log them, surface them, degrade visibly.
10. **Do not delete working code** because a rewrite looks cleaner. Incremental
    improvement wins.

---

## Two things that were already gotten wrong once — do not regress them

**Regime classification.** An earlier version put trend strength and
volatility on a single ballot. A squeeze inside a strong trend then outvoted
ADX and labelled the market COMPRESSED, which down-weighted every
trend-following agent at exactly the wrong moment. It is now two orthogonal
axes with an explicit resolution order (`features/regime.py`). If you
"simplify" it back to one vote you will reintroduce the bug.

**Hurst exponent.** It was computed on log *returns*, which differences the
series twice and pins H near 0 for everything. It is now computed on
*detrended log prices*. Verified: random walk → 0.500, persistent → 0.564,
anti-persistent → 0.410, and drift-invariant. If you touch `hurst()`, re-run
that check.

**EventBus.emit is async.** It was once monkey-patched with a sync function,
which made every successful price update raise
`TypeError: object NoneType can't be used in 'await' expression` and silently
killed the `market_update` stream. Never patch it back to a sync callable.

---

## Adding an agent (the common task)

1. Create `agents/yourname.py`, subclass `Agent`.
2. Implement `evaluate(ctx) -> AgentVote`. It must be **pure**: no I/O, no
   globals, no mutation of `ctx`. That is what makes it safe to run
   concurrently and testable.
3. Set `min_bars` honestly. Below it, the framework votes FLAT for you.
4. Optionally override `weight_for_regime` — most agents should, because
   almost no agent is equally useful in a trend and a range.
5. Register it in `agents/registry.py`. That is the only wiring needed.
6. Add a test asserting it votes FLAT on thin data and bounded on real data.

`name` is persisted on every historical signal. **Renaming an agent breaks
historical attribution and the learner.** Don't.

---

## Calibration — how confidence becomes real

The brain starts with `confidence: null`. To make it real:

1. The engine collects closed outcomes from Mongo: the raw score recorded on
   each signal, and whether it won (1) or lost (0).
2. Isotonic regression fits score → win probability
   (`POST /v1/calibration/fit` for external callers).
3. Below `CALIBRATION_MIN_SAMPLES` (default 80) it refuses to fit and says so
   in `/health`. This is correct. Do not lower it to make the UI look better.

Only once fitted does Kelly sizing activate, because sizing off an
uncalibrated number is sizing off noise.

---

## Where the work is up to

The Node-to-Python migration is **complete and tested** (37 pytest green).
The frontend (`webapp-react/`) is contract-compatible — same REST paths, same
Socket.IO path/events.

**2026-09-21 — Email OTP login fix.** `AuthService.request_otp` no longer
reports success when Brevo rejects the send. Failed delivery now returns
`{ok: false, error: "email delivery failed"}` (HTTP 502 at the route) with a
matching actionable message in the `LoginGate` UI. Previously a rejected Brevo
send was swallowed server-side and the UI lied with "Code sent — check inbox
and spam". Preserved: `ALLOW_DEV_OTP` fallback and the unconfigured-provider
fallback, both covered in `tests/test_auth.py`.

Next candidate work: Myfxbook sentiment + OpenInsider feeds (keys exist in
config), the researched API-vault candidates (Twelve Data, Tiingo, EODHD — see
`feeds/feeds_feeds.py`), and frontend polish on the new
engine-status endpoints (`/api/engine`, `/api/feed-health`, `/api/api-vault`).

**Update this section in the same commit as your code.** Documentation that
lags the code is worse than no documentation.

---

## Coordination — read this part twice

Parallel pushes to `main` have repeatedly caused merge conflicts and lost
work in this repo.

- **Work on a branch named for your session.** `fix/feed-health`,
  `feat/myfxbook-sentiment`. Not `main`.
- **`git pull` before you start, and read this file again.** Another agent may
  have changed it an hour ago.
- **Check the branch list before building a feature.** Someone may already be
  halfway through it. This has happened more than once.
- **Never commit `node_modules`.** It was tracked once and caused spurious
  conflicts on every install. It is in `.gitignore` — keep it there.
- **Never commit a token, key or password.** If you find one in the history,
  say so loudly and tell the owner to revoke it.

---

## Running it

```bash
# from the repo root
pip install -r requirements-dev.txt
set NODE_ENV=test&& python -m pytest tests -q     # 29 tests, all must pass
python -m ruff check .                # must be clean
uvicorn api.app:asgi --port 8000          # http://localhost:8000/docs
```

---

## Deployment constraints — check before adding any dependency

Production is **Render free tier: 512 MB RAM, 0.1 CPU, spins down when idle**,
Singapore region, with MongoDB Atlas M0. Blueprint: [`render.yaml`](render.yaml)
— build installs `requirements.txt` + builds `webapp-react/dist`, start is
`uvicorn api.app:asgi` from the repo root.

Measured install sizes, not estimates:

| package | size | verdict |
|---|---|---|
| numpy + scipy + scikit-learn + FastAPI | ~220 MB | fits |
| onnxruntime | ~54 MB | fits — this is the route for neural models |
| PyTorch | ~900 MB | **will not run** |
| TensorFlow | ~600 MB+ | **will not run** |

To use neural models: train offline, export to ONNX, commit the `.onnx` file,
infer with `onnxruntime`. There is no other route that fits this box.
Run one uvicorn worker. Two workers means two copies of numpy resident.

---

## Things deliberately NOT built yet, and why

- **No LLM calls in the pipeline.** An LLM in the hot path adds seconds of
  latency and non-determinism to a risk decision. Signal explanation belongs
  *after* the signal exists, as a separate call.
- **No execution.** The system recommends. It does not place orders. Execution
  stays behind the MT5 EA bridge with a human in the loop.
