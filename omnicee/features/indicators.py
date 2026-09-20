"""Vectorised technical indicators.

Pure numpy, no pandas, no TA-Lib. Reasons:
  * numpy alone is ~40 MB installed; pandas adds ~68 MB and TA-Lib needs a C
    build. On a 512 MB box that matters.
  * Every function returns a full-length array with np.nan in the warm-up
    region. Callers must check for nan rather than receiving a silently
    truncated or zero-padded array — a zero where a value is unknown is how
    fake indicator readings get into signals.

Convention: arrays are float64, oldest-first, index -1 is the newest bar.
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "adx",
    "atr",
    "bollinger",
    "donchian",
    "ema",
    "hurst",
    "linreg_slope",
    "macd",
    "pct_rank",
    "realised_vol",
    "rolling_std",
    "rsi",
    "sma",
    "stochastic",
    "true_range",
    "vwap",
    "wilder",
    "zscore",
]


def _check(a: np.ndarray, name: str = "series") -> np.ndarray:
    arr = np.asarray(a, dtype=np.float64)
    if arr.ndim != 1:
        raise ValueError(f"{name} must be 1-D, got shape {arr.shape}")
    return arr


def _nan_head(length: int, warmup: int) -> np.ndarray:
    out = np.full(length, np.nan, dtype=np.float64)
    return out


# ---------------------------------------------------------------- averages


def sma(values: np.ndarray, period: int) -> np.ndarray:
    """Simple moving average via cumulative sum. O(n)."""
    v = _check(values)
    if period < 1:
        raise ValueError("period must be >= 1")
    out = _nan_head(v.size, period)
    if v.size < period:
        return out
    csum = np.cumsum(np.insert(v, 0, 0.0))
    out[period - 1 :] = (csum[period:] - csum[:-period]) / period
    return out


def ema(values: np.ndarray, period: int) -> np.ndarray:
    """Exponential moving average, seeded with an SMA of the first `period`."""
    v = _check(values)
    if period < 1:
        raise ValueError("period must be >= 1")
    out = _nan_head(v.size, period)
    if v.size < period:
        return out
    alpha = 2.0 / (period + 1.0)
    acc = float(v[:period].mean())
    out[period - 1] = acc
    for i in range(period, v.size):
        acc = alpha * v[i] + (1.0 - alpha) * acc
        out[i] = acc
    return out


def wilder(values: np.ndarray, period: int) -> np.ndarray:
    """Wilder's smoothing (used by RSI/ATR/ADX). alpha = 1/period."""
    v = _check(values)
    out = _nan_head(v.size, period)
    if v.size < period:
        return out
    acc = float(v[:period].mean())
    out[period - 1] = acc
    for i in range(period, v.size):
        acc = (acc * (period - 1) + v[i]) / period
        out[i] = acc
    return out


# ---------------------------------------------------------------- volatility


def true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    h, lo, c = _check(high, "high"), _check(low, "low"), _check(close, "close")
    if not (h.size == lo.size == c.size):
        raise ValueError("high/low/close must be the same length")
    tr = np.empty(h.size, dtype=np.float64)
    tr[0] = h[0] - lo[0]
    prev = c[:-1]
    tr[1:] = np.maximum.reduce(
        [h[1:] - lo[1:], np.abs(h[1:] - prev), np.abs(lo[1:] - prev)]
    )
    return tr


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    return wilder(true_range(high, low, close), period)


def rolling_std(values: np.ndarray, period: int) -> np.ndarray:
    """Population std over a rolling window, O(n) via cumulative sums."""
    v = _check(values)
    out = _nan_head(v.size, period)
    if v.size < period or period < 2:
        return out
    c1 = np.cumsum(np.insert(v, 0, 0.0))
    c2 = np.cumsum(np.insert(v * v, 0, 0.0))
    s = c1[period:] - c1[:-period]
    ss = c2[period:] - c2[:-period]
    var = np.maximum(ss / period - (s / period) ** 2, 0.0)
    out[period - 1 :] = np.sqrt(var)
    return out


def realised_vol(close: np.ndarray, period: int = 20, annualise: float = 1.0) -> np.ndarray:
    """Std of log returns over the window, optionally annualised."""
    c = _check(close, "close")
    out = _nan_head(c.size, period + 1)
    if c.size < period + 2:
        return out
    rets = np.full(c.size, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        rets[1:] = np.log(c[1:] / c[:-1])
    sd = rolling_std(np.nan_to_num(rets, nan=0.0), period)
    out[:] = sd * annualise
    out[: period + 1] = np.nan
    return out


# ---------------------------------------------------------------- oscillators


def rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    c = _check(close, "close")
    out = _nan_head(c.size, period + 1)
    if c.size < period + 1:
        return out
    delta = np.diff(c, prepend=c[0])
    gains = np.where(delta > 0, delta, 0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    gains[0] = losses[0] = np.nan
    avg_gain = wilder(np.nan_to_num(gains[1:], nan=0.0), period)
    avg_loss = wilder(np.nan_to_num(losses[1:], nan=0.0), period)
    rs = np.divide(
        avg_gain,
        avg_loss,
        out=np.full_like(avg_gain, np.inf),
        where=avg_loss > 0,
    )
    vals = 100.0 - (100.0 / (1.0 + rs))
    vals[np.isinf(rs)] = 100.0
    out[1:] = vals
    return out


def stochastic(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, k: int = 14, d: int = 3
) -> tuple[np.ndarray, np.ndarray]:
    h, lo, c = _check(high), _check(low), _check(close)
    n = c.size
    pk = _nan_head(n, k)
    if n < k:
        return pk, pk.copy()
    for i in range(k - 1, n):
        hh = h[i - k + 1 : i + 1].max()
        ll = lo[i - k + 1 : i + 1].min()
        rng = hh - ll
        pk[i] = 50.0 if rng <= 0 else (c[i] - ll) / rng * 100.0
    pd_ = sma(np.nan_to_num(pk, nan=50.0), d)
    pd_[: k - 1 + d - 1] = np.nan
    return pk, pd_


def macd(
    close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if fast >= slow:
        raise ValueError("fast period must be shorter than slow period")
    f, s = ema(close, fast), ema(close, slow)
    line = f - s
    valid = ~np.isnan(line)
    sig = np.full_like(line, np.nan)
    if valid.sum() >= signal:
        sig[valid] = ema(line[valid], signal)
    return line, sig, line - sig


def adx(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (adx, +di, -di). Trend strength, not direction, in `adx`."""
    h, lo, c = _check(high), _check(low), _check(close)
    n = h.size
    nan = _nan_head(n, period * 2)
    if n < period * 2 + 1:
        return nan, nan.copy(), nan.copy()

    up = np.zeros(n)
    dn = np.zeros(n)
    up_move = h[1:] - h[:-1]
    dn_move = lo[:-1] - lo[1:]
    up[1:] = np.where((up_move > dn_move) & (up_move > 0), up_move, 0.0)
    dn[1:] = np.where((dn_move > up_move) & (dn_move > 0), dn_move, 0.0)

    tr = true_range(h, lo, c)
    atr_s = wilder(tr[1:], period)
    up_s = wilder(up[1:], period)
    dn_s = wilder(dn[1:], period)

    with np.errstate(divide="ignore", invalid="ignore"):
        pdi = np.where(atr_s > 0, 100.0 * up_s / atr_s, np.nan)
        ndi = np.where(atr_s > 0, 100.0 * dn_s / atr_s, np.nan)
        denom = pdi + ndi
        dx = np.where(denom > 0, 100.0 * np.abs(pdi - ndi) / denom, np.nan)

    dx_clean = np.nan_to_num(dx, nan=0.0)
    adx_s = wilder(dx_clean, period)

    out_adx, out_p, out_n = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
    out_adx[1:] = adx_s
    out_p[1:] = pdi
    out_n[1:] = ndi
    out_adx[: period * 2] = np.nan
    return out_adx, out_p, out_n


# ---------------------------------------------------------------- bands


def bollinger(
    close: np.ndarray, period: int = 20, mult: float = 2.0
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mid = sma(close, period)
    sd = rolling_std(close, period)
    return mid + mult * sd, mid, mid - mult * sd


def donchian(
    high: np.ndarray, low: np.ndarray, period: int = 20
) -> tuple[np.ndarray, np.ndarray]:
    h, lo = _check(high), _check(low)
    n = h.size
    up, dn = _nan_head(n, period), _nan_head(n, period)
    for i in range(period - 1, n):
        up[i] = h[i - period + 1 : i + 1].max()
        dn[i] = lo[i - period + 1 : i + 1].min()
    return up, dn


# ---------------------------------------------------------------- stats


def zscore(values: np.ndarray, period: int = 50) -> np.ndarray:
    v = _check(values)
    mean = sma(v, period)
    sd = rolling_std(v, period)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(sd > 0, (v - mean) / sd, np.nan)


def linreg_slope(values: np.ndarray, period: int = 20) -> np.ndarray:
    """Least-squares slope per bar over a rolling window."""
    v = _check(values)
    n = v.size
    out = _nan_head(n, period)
    if n < period:
        return out
    x = np.arange(period, dtype=np.float64)
    x_mean = x.mean()
    denom = ((x - x_mean) ** 2).sum()
    for i in range(period - 1, n):
        y = v[i - period + 1 : i + 1]
        out[i] = ((x - x_mean) * (y - y.mean())).sum() / denom
    return out


def hurst(close: np.ndarray, min_lag: int = 2, max_lag: int = 40) -> float:
    """Hurst exponent via rescaled-range/variance scaling on log returns.

    H > 0.5 persistent (trending), H < 0.5 mean-reverting, H ~ 0.5 random.
    Returns nan when there is not enough data to estimate honestly.
    """
    c = _check(close, "close")
    if c.size < max_lag * 2 or np.any(c <= 0):
        return float("nan")
    # Variance scaling is applied to the LOG PRICE path, not to returns.
    # Differencing returns as well would difference twice and pin H near 0.
    lp = np.log(c)
    # Remove the linear drift first. Hurst measures how FLUCTUATIONS scale;
    # a steady drift is not a fluctuation, and left in it swamps the estimate
    # and pushes H toward 0 on any strongly trending market. Classical R/S
    # detrends inside each window for the same reason.
    idx = np.arange(lp.size, dtype=np.float64)
    coef = np.polyfit(idx, lp, 1)
    lp = lp - (coef[0] * idx + coef[1])
    lags = np.arange(min_lag, min(max_lag, lp.size // 2))
    if lags.size < 4:
        return float("nan")
    taus = []
    keep = []
    for lag in lags:
        diff = lp[lag:] - lp[:-lag]
        sd = float(np.std(diff))
        if sd > 0:
            taus.append(sd)
            keep.append(lag)
    if len(taus) < 4:
        return float("nan")
    slope = np.polyfit(np.log(np.asarray(keep, dtype=float)), np.log(taus), 1)[0]
    return float(np.clip(slope, 0.0, 1.0))


def pct_rank(values: np.ndarray, period: int = 100) -> np.ndarray:
    """Percentile rank of each value within its trailing window, 0..1."""
    v = _check(values)
    n = v.size
    out = _nan_head(n, period)
    if n < period:
        return out
    for i in range(period - 1, n):
        window = v[i - period + 1 : i + 1]
        out[i] = float((window <= v[i]).sum()) / period
    return out


def vwap(high: np.ndarray, low: np.ndarray, close: np.ndarray, volume: np.ndarray) -> np.ndarray:
    """Cumulative VWAP. Returns nan throughout when volume is absent (most FX)."""
    h, lo, c, v = _check(high), _check(low), _check(close), _check(volume)
    if v.sum() <= 0:
        return np.full(c.size, np.nan)
    typical = (h + lo + c) / 3.0
    cum_pv = np.cumsum(typical * v)
    cum_v = np.cumsum(v)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(cum_v > 0, cum_pv / cum_v, np.nan)
