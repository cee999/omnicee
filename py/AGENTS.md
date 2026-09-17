# AGENTS.md — read this before changing anything in `py/`

This file is the contract between the humans and the several AI agents working
on this repository (Claude, Codex, Grok, and whatever comes next). It is the
first thing to read and the last thing to update.

If you are an AI agent starting a session on OMNICee: read this file top to
bottom, run the test suite, and only then write code.

---

## 1. What this is

`py/` is the **brain**: the analytical core of OMNICee, in Python.

It is *not* a rewrite of the Node service. The Node service at the repo root
still owns everything it owns today. The Python service takes over the
analytical work in stages, and the two talk over HTTP.

```
┌─────────────────────────────────────────────────────┐
│  NODE EDGE  (repo root — index.js, api/, feeds/)    │
│  owns: 5 live price feeds, WebSocket/Socket.IO,     │
│        Telegram bot, auth, web push, static app,    │
│        MongoDB writes, alert dispatch               │
└───────────────────────┬─────────────────────────────┘
                        │  POST /v1/analyze
                        │  x-brain-secret: <shared>
                        ▼
┌─────────────────────────────────────────────────────┐
│  PYTHON BRAIN  (py/ — this service)                 │
│  owns: regime classification, agents, consensus,    │
│        probability calibration, risk gates,         │
│        level placement, position sizing             │
│  owns NO feeds, NO sockets, NO user auth            │
└─────────────────────────────────────────────────────┘
```

**Why split this way.** Feeds are long-lived stateful socket connections that
have taken months to stabilise. Analysis is stateless request/response maths.
Putting them in separate processes means a brain crash cannot drop ticks and a
dead feed cannot crash analysis. It also means the brain can be redeployed
mid-session without the mobile app noticing.

---

## 2. The rules, in priority order

These are not style preferences. Breaking one is a bug even if tests pass.

1. **Never fabricate a number.** If a value is unknown it is `null`. Not zero,
   not the previous bar's value, not a plausible-looking default. A dashboard
   that shows a made-up price is worse than one that shows nothing.
2. **Confidence must be calibrated or absent.** A raw ensemble score is not a
   probability. `confidence` stays `null` until `Calibrator` has fitted on
   enough real closed outcomes. See §6.
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
8. **Contracts are the source of truth.** Anything crossing the Node↔Python
   boundary is defined in `omnicee/contracts/`. FastAPI publishes them at
   `/openapi.json`. Do not hand-write a duplicate type on the Node side —
   generate it.

---

## 3. Layout

```
py/
  omnicee/
    config.py           all env, validated once at boot. Nothing else reads os.environ.
    pipeline.py         the chain. One entry point: analyse().
    contracts/
      market.py         Candle, Series, MarketSnapshot  (+ cached numpy views)
      signals.py        Signal, AgentVote, Consensus, lifecycle enums
    features/
      indicators.py     vectorised numpy indicators. nan in warm-up, never zero.
      structure.py      SMC: swings, BOS/CHoCH, FVG, order blocks, sweeps
      regime.py         two-axis regime classifier (see §5)
    agents/
      base.py           Agent ABC — timeout + isolation. Read before adding one.
      registry.py       ONE place to register a new agent
      smc.py mtf.py momentum.py
    ensemble/
      voting.py         weighted consensus
      calibration.py    isotonic score -> probability
    risk/
      gates.py          deterministic blocks
      sizing.py         fixed-fractional + capped fractional Kelly
    api/app.py          FastAPI. /health, /v1/analyze, /v1/calibration/fit, /v1/agents
  tests/                29 tests. Run them.
```

---

## 4. Adding an agent (the common task)

1. Create `omnicee/agents/yourname.py`, subclass `Agent`.
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

## 5. Two things that were already gotten wrong once — do not regress them

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

---

## 6. Calibration — how confidence becomes real

The brain starts with `confidence: null`. To make it real:

1. Node collects closed outcomes from Mongo: the `raw_score` recorded on each
   signal, and whether it won (1) or lost (0).
2. Node POSTs them to `/v1/calibration/fit`.
3. Isotonic regression fits score → win probability.
4. Below `CALIBRATION_MIN_SAMPLES` (default 80) it refuses to fit and says so
   in `/health`. This is correct. Do not lower it to make the UI look better.

Only once fitted does Kelly sizing activate, because sizing off an
uncalibrated number is sizing off noise.

---

## 7. Deployment reality — read before adding a dependency

Target is Render's **free tier: 512 MB RAM, 0.1 CPU, spins down when idle.**

Measured on-disk footprint of the current stack: **~220 MB**
(numpy 40, scipy 109, scikit-learn 45, fastapi/uvicorn/pydantic ~25).

**Will not fit, do not add:**

| package    | installed size | verdict |
|------------|---------------|---------|
| torch      | ~900 MB       | impossible on free tier |
| tensorflow | ~600 MB+      | impossible on free tier |
| pandas     | ~68 MB        | possible, but the numpy feature layer doesn't need it |
| ta-lib     | needs C build | build will fail |

**To use neural models anyway:** train offline on your own machine, export to
ONNX, commit the `.onnx` file, and infer with `onnxruntime` (~54 MB). That is
the only route that fits. `requirements-ml.txt` exists for this.

Run one uvicorn worker. Two workers means two copies of numpy resident.

---

## 8. Running it

```bash
cd py
pip install -r requirements-dev.txt
python -m pytest tests/ -q          # 29 tests, all must pass
python -m ruff check omnicee tests  # must be clean
uvicorn omnicee.api.app:app --reload --port 8000
open http://localhost:8000/docs
```

---

## 9. Migration status — UPDATE THIS SECTION WHEN YOU SHIP

| stage | scope | status |
|-------|-------|--------|
| 1 | contracts, indicators, structure, regime, 3 agents, consensus, calibration, gates, sizing, API, tests | **done, tested, not yet deployed** |
| 2 | Node calls `/v1/analyze` in shadow mode; log both outputs, compare, do not act on Python yet | not started |
| 3 | port remaining agents (volume-OI, microstructure, fractal, sentiment, pattern) | not started |
| 4 | Python becomes authoritative for signals; Node keeps feeds/sockets/auth | not started |
| 5 | backtesting + walk-forward in Python against Mongo history | not started |
| 6 | port feeds; retire Node analysis modules only after Stage 4 is stable | not started |

**Stage 2 is the next task and it is deliberately boring.** Run both engines
side by side, log the disagreements, and look at them. Do not skip to Stage 4
because the Python output looks nicer. The Node pipeline contains months of
bug fixes that are not written down anywhere except the code.

---

## 10. Coordination between agents

Multiple AI sessions push to `main` in parallel and this has repeatedly caused
merge conflicts.

- **Work on a branch named for your session** (`py/stage-2-shadow-mode`), not
  on `main`.
- **Before starting: `git pull` and read this file again.** Another agent may
  have changed §9 an hour ago.
- **After shipping: update §9 in the same commit as the code.** A status table
  that lags the code is worse than no table.
- **Never delete Node analysis modules** until the corresponding Python stage
  is marked done *and* has run in shadow mode. Stage 6 says this too.

## 11. Things deliberately NOT built yet, and why

- **No LLM calls in the pipeline.** An LLM in the hot path adds seconds of
  latency and non-determinism to a risk decision. Signal explanation belongs
  *after* the signal exists, as a separate call, which is what the existing
  Node `AIAdvisor` already does.
- **No execution.** The brain recommends. It does not place orders. Execution
  stays behind the Node MT5 bridge with a human in the loop.
- **No feed clients.** By design, see §1.
