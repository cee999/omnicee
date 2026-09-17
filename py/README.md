# OMNICee Brain

The analytical core of OMNICee, in Python. Regime classification, agent
voting, probability calibration, deterministic risk gates, position sizing.

**If you are an AI agent working on this repo, read [AGENTS.md](./AGENTS.md)
first.** It contains the architecture contract, the rules, and the migration
status table.

## Quick start

```bash
cd py
pip install -r requirements-dev.txt
python -m pytest tests/ -q                     # 29 tests
uvicorn omnicee.api.app:app --reload --port 8000
```

Interactive API docs at <http://localhost:8000/docs>.

## What it does

```
market snapshot
   -> regime        two axes: direction (ADX + Hurst), volatility (ATR/bandwidth percentile)
   -> agents        SMC, multi-timeframe, momentum — run concurrently, isolated, timed out
   -> consensus     weighted by agent weight and regime; failures excluded, not neutralised
   -> risk gates    deterministic. Stale data, thin consensus, loss limits, drawdown, trade caps
   -> levels        stop beyond the invalidating swing, ATR fallback, 2R target
   -> calibration   isotonic score -> real win probability, or null if not enough history
   -> sizing        fixed-fractional, or quarter-Kelly once calibrated. Capped both ways
   -> signal
```

Typical end-to-end latency, measured: **12–15 ms per symbol** on 250 bars
across three timeframes.

## What it does NOT do

No feeds, no sockets, no user auth, no order execution, no LLM calls in the
hot path. Those stay in the Node service. See AGENTS.md §1 for why.

## The one thing to understand

`confidence` is `null` until the calibrator has been fitted on real closed
trade outcomes. This is intentional. A raw ensemble score of 0.8 is not an 80%
chance of anything, and showing it as one is the most common way a trading
dashboard lies to its owner.

Feed it outcomes via `POST /v1/calibration/fit` and confidence becomes real.
