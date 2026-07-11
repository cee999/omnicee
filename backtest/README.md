# OMNICEE Backtesting Harness

Replays historical candles through the **real production decision pipeline**
— the same agent classes, SignalScorer, RiskEngine, DrawdownGuard,
InstitutionalGates, EnsembleEngine, and PositionLifecycle that `index.js`
runs live — so backtest results reflect what the shipped system actually
does, not a separate reimplementation of its logic.

## Quick start

```bash
# Real data (requires internet access to api.binance.com — will NOT work
# from a network-sandboxed environment; run this on your own machine, a
# VPS, or after deploying to Render).
node backtest/run.js --symbol BTCUSDT --timeframe H1 --htf H4,D1 \
  --from 2024-01-01 --to 2025-12-31 --balance 10000 --risk 1.0 \
  --out results.json

# Multiple symbols
node backtest/run.js --symbol BTCUSDT,XAUUSD --timeframe H1 --htf H4 \
  --from 2025-01-01 --to 2025-12-31

# Your own CSV data (needed for forex/stocks — Binance only has crypto)
node backtest/run.js --csv ./data/EURUSD_H1.csv --symbol EURUSD --timeframe H1

# Engine self-test with synthetic data (proves the mechanics work end to
# end — this is NOT a measure of real strategy performance, it's random
# noise. Only use this to sanity-check the code itself after changes.)
node backtest/run.js --synthetic --symbol BTCUSDT --timeframe H1 --htf H4 --candles 2000
```

## Flags

| Flag | Default | Notes |
|---|---|---|
| `--symbol` | `BTCUSDT` | Comma-separated for multiple symbols |
| `--timeframe` | `H1` | MT-style label (M15, H1, H4, D1, ...) |
| `--htf` | *(none)* | Higher timeframes for MTF agent context, e.g. `H4,D1`. **Without this, MTFAgent only ever sees one timeframe and will always return WAIT — you will get zero signals.** |
| `--from` / `--to` | last 180 days | ISO date strings |
| `--balance` | `10000` | Starting account balance |
| `--risk` | `1.0` | Risk % per trade |
| `--maxDailyLoss` | `3.0` | Daily circuit-breaker threshold % |
| `--maxDrawdown` | `10.0` | Max-drawdown-from-peak circuit-breaker threshold % |
| `--minScore` | `75` | Minimum signal score to consider firing |
| `--csv` | *(none)* | Load from a CSV instead of Binance |
| `--synthetic` | *(none)* | Engine self-test with generated noise, not real data |
| `--out` | *(none)* | Write full JSON results (trades, equity curve, stats) to this path |

## What this does NOT do (read before trusting any number it prints)

- **It does not include SentimentAgent.** That agent needs live news APIs
  that don't exist historically in a replayable form. The live system
  treats it as optional too (only SMC/MTF/Momentum are required votes), so
  this is a documented simplification, not a bug — but it does mean
  backtest results will differ somewhat from live behavior.
- **It approximates intrabar price action.** Real tick-by-tick data isn't
  used — each candle's high/low/close are checked in a conservative order
  (adverse extreme first) to avoid overstating win rate when a candle's
  range could have hit both the stop and the target, but this is still an
  approximation, not a tick-accurate replay.
- **Spread and slippage are not modeled.** Real execution will do worse
  than a backtest that assumes exact fills at candle prices.
- **Past performance on any dataset — synthetic or real — does not predict
  future results.** A positive backtest is a necessary but not sufficient
  condition before considering real capital; it needs to be followed by
  paper trading to confirm live behavior matches, per the standard
  validation sequence (backtest → paper trade → small live capital →
  scale gradually).

## Architecture note

`backtest/engine.js` deliberately does **not** import or modify `index.js`
(the live trading entry point) — it constructs the same pipeline classes
independently, mirroring `index.js`'s `runAnalysisCycle()` sequence
step-for-step. If the live decision sequence in `index.js` changes, this
file needs to be updated to match — see the `MIRRORS index.js` comments
throughout `engine.js` for the exact points of correspondence.
