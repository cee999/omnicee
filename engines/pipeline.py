"""Signal-pipeline engines: trade plans, trap/compression detection, session
cycles, strategy selection, opportunity ranking, institutional gates, and the
gold desk profile. Ports of the Node `signal-pipeline/` modules of the same
names — constants preserved verbatim.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
# SL/TP engine

def atr_wilder(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> float:
    tr = np.maximum(high[1:], close[:-1]) - np.minimum(low[1:], close[:-1])
    if tr.size < period:
        return float((high - low).mean()) if (high - low).size else 0.0
    atr = float(tr[:period].mean())
    for t in tr[period:]:
        atr = (atr * (period - 1) + float(t)) / period
    return atr


def build_trade_plan(candles: dict[str, Any], direction: str, entry_zone: dict[str, float],
                     smc_sl: float | None = None) -> dict[str, Any]:
    """ATR stop + RR targets with a partial-close schedule. min RR 1.5."""
    high = np.asarray(candles.get("high", []), dtype=float)
    low = np.asarray(candles.get("low", []), dtype=float)
    close = np.asarray(candles.get("close", []), dtype=float)
    if close.size < 20:
        return {"plan": None, "error": "need >= 20 candles"}
    atr_value = atr_wilder(high, low, close, 14)
    if atr_value <= 0:
        return {"plan": None, "error": "no volatility estimate"}
    zone_high = float(entry_zone.get("zoneHigh") or close[-1])
    zone_low = float(entry_zone.get("zoneLow") or close[-1])
    entry = (zone_high + zone_low) / 2
    sign = 1.0 if direction.upper() in ("LONG", "BUY") else -1.0
    stop = None
    method = "ATR"
    ob_low = smc_sl
    if ob_low is not None:
        candidate = ob_low - 0.5 * atr_value if sign > 0 else ob_low + 0.5 * atr_value
        if sign * (candidate - entry) < 0:
            stop = candidate
            method = "STRUCTURE_OB"
    if stop is None:
        swing = float(low[-30:].min()) if sign > 0 else float(high[-30:].max())
        candidate = swing - 0.5 * atr_value if sign > 0 else swing + 0.5 * atr_value
        if sign * (candidate - entry) < 0 and abs(candidate - entry) / entry >= 0.003:
            stop = candidate
            method = "STRUCTURE_SWING"
    if stop is None:
        stop = entry - sign * 1.5 * atr_value
        method = "ATR"
    risk = abs(entry - stop)
    if risk <= 0:
        return {"plan": None, "error": "zero risk distance"}
    targets = []
    for rr, close_pct in ((1.5, 50), (3.0, 30), (5.0, 20)):
        tp = entry + sign * rr * risk
        targets.append({"price": round(tp, 6), "rr": rr, "closePct": close_pct})
    return {"plan": {
        "direction": direction.upper(), "entry": {"zoneHigh": zone_high, "zoneLow": zone_low,
                                                  "midPoint": round(entry, 6)},
        "stopLoss": {"price": round(stop, 6), "method": method, "riskPoints": round(risk, 6)},
        "targets": targets,
        "management": {"partialClose": "50% at TP1 (SL->BE), 30% at TP2 (SL->TP1), 20% at TP3",
                       "trailAfterTP2": "2x ATR in profit direction"},
        "risk": {"atr": round(atr_value, 6), "atrPct": round(atr_value / entry * 100, 3),
                 "riskPoints": round(risk, 6)},
    }, "error": None}


# ---------------------------------------------------------------------------
# Trap detector (failed breakouts)

def detect_traps(candles: dict[str, Any]) -> dict[str, Any]:
    high = np.asarray(candles.get("high", []), dtype=float)
    low = np.asarray(candles.get("low", []), dtype=float)
    close = np.asarray(candles.get("close", []), dtype=float)
    n = close.size
    if n < 18:
        return {"traps": [], "activeTrap": None, "trapRisk": 0.0}
    atr_value = atr_wilder(high, low, close, 14) or float((high - low)[-20:].mean()) or 0.0001
    traps: list[dict[str, Any]] = []
    for i in range(5, n - 3):
        prior_avg = float(close[max(0, i - 5):i].mean())
        # Bull trap: breakout above prior resistance then rejection
        resist = float(high[max(0, i - 20):i].max())
        if high[i] > resist + 0.3 * atr_value and prior_avg < resist:
            rng = max(float(high[i] - low[i]), 1e-12)
            upper_wick = float(high[i] - max(close[i], candles["open"][i]))
            wick_ratio = upper_wick / rng
            confirmed = any(close[j] < resist - 0.15 * atr_value for j in range(i, min(i + 4, n)))
            if confirmed and (wick_ratio >= 0.55 or (wick_ratio >= 0.3)):
                strength = min(1.0, 0.4 * min(1.0, wick_ratio) + 0.3 * min(1.0, (high[i] - resist) / (2 * atr_value)) + 0.3)
                traps.append({"type": "BULL_TRAP", "level": resist, "breakIndex": i, "strength": round(strength, 3)})
        # Bear trap
        support = float(low[max(0, i - 20):i].min())
        if low[i] < support - 0.3 * atr_value and prior_avg > support:
            rng = max(float(high[i] - low[i]), 1e-12)
            lower_wick = float(min(close[i], candles["open"][i]) - low[i])
            wick_ratio = lower_wick / rng
            confirmed = any(close[j] > support + 0.15 * atr_value for j in range(i, min(i + 4, n)))
            if confirmed and wick_ratio >= 0.3:
                strength = min(1.0, 0.4 * min(1.0, wick_ratio) + 0.3 * min(1.0, (support - low[i]) / (2 * atr_value)) + 0.3)
                traps.append({"type": "BEAR_TRAP", "level": support, "breakIndex": i, "strength": round(strength, 3)})
    recent = [t for t in traps if t["breakIndex"] >= n - 20]
    active = [t for t in recent if t["breakIndex"] >= n - 3]
    trap_risk = min(1.0, sum(t["strength"] for t in recent) / 2)
    return {"traps": traps[-20:], "activeTrap": active[-1] if active else None,
            "trapRisk": round(trap_risk, 3), "atr": round(float(atr_value), 6)}


def should_dampen_breakout(trap_result: dict[str, Any], direction: str) -> dict[str, Any]:
    opposing = {"LONG": "BULL_TRAP", "BUY": "BULL_TRAP", "SHORT": "BEAR_TRAP", "SELL": "BEAR_TRAP"}.get(
        direction.upper())
    active = trap_result.get("activeTrap")
    if active and opposing and active["type"] == opposing:
        return {"dampen": True, "factor": round(1 - active["strength"], 3), "reason": "active opposing trap"}
    if trap_result.get("trapRisk", 0) >= 0.5:
        return {"dampen": True, "factor": round(1 - trap_result["trapRisk"], 3), "reason": "elevated trap risk"}
    return {"dampen": False, "factor": 1.0, "reason": None}


# ---------------------------------------------------------------------------
# Compression detector (squeeze)

def detect_compression(candles: dict[str, Any]) -> dict[str, Any]:
    high = np.asarray(candles.get("high", []), dtype=float)
    low = np.asarray(candles.get("low", []), dtype=float)
    close = np.asarray(candles.get("close", []), dtype=float)
    if close.size < 50:
        return {"compressionScore": 0.0, "isCompressed": False, "biasHint": "NEUTRAL",
                "note": "insufficient candles"}
    # BB width percentile
    widths = []
    for i in range(20, close.size):
        w = close[i - 20:i]
        sma = float(w.mean())
        sd = float(w.std(ddof=0))
        upper, lower = sma + 2 * sd, sma - 2 * sd
        widths.append((upper - lower) / sma if sma else 0.0)
    widths = np.array(widths)
    cur = float(widths[-1])
    bbw_pct = float((widths[:-1] < cur).mean() * 100)
    # ATR percentile
    trs = np.maximum(high[1:], close[:-1]) - np.minimum(low[1:], close[:-1])
    atr_series = np.convolve(trs, np.ones(14) / 14, mode="valid")
    atr_pct = float((atr_series[:-1] < atr_series[-1]).mean() * 100)
    # Donchian ratio
    donch = high[-20:].max() - low[-20:].min()
    prior_ranges = [high[i - 20:i].max() - low[i - 20:i].min() for i in range(close.size - 40, close.size - 20, 5)]
    prior_avg = float(np.mean(prior_ranges)) if prior_ranges else 0.0
    donch_ratio = donch / prior_avg if prior_avg > 0 else 1.0
    # Small-range streak
    ranges = high[-20:] - low[-20:]
    avg_range = float(ranges.mean())
    streak = 0
    for r in ranges[::-1]:
        if r <= 0.6 * avg_range:
            streak += 1
        else:
            break
    score = (0.35 * (100 - bbw_pct) + 0.30 * (100 - atr_pct)
             + 0.20 * float(np.clip((1 - donch_ratio) * 150, 0, 100)) + 0.15 * min(100.0, streak * 12))
    is_compressed = score >= 80
    in_range = (float(close[-1]) - float(low[-20:].min())) / max(float(high[-20:].max() - low[-20:].min()), 1e-12)
    drift = float((close[-1] - close[-10]) / close[-10]) if close.size >= 10 else 0.0
    lean_score = (in_range - 0.5) * 2 + drift * 10
    bias = "UPSIDE_LEAN" if lean_score > 0.15 else "DOWNSIDE_LEAN" if lean_score < -0.15 else "NEUTRAL"
    return {"compressionScore": round(float(score), 2), "isCompressed": is_compressed, "biasHint": bias,
            "detail": {"bbwPercentile": round(bbw_pct, 1), "atrPercentile": round(atr_pct, 1),
                       "donchianRatio": round(donch_ratio, 3), "consecutiveSmallRangeCandles": streak,
                       "positionInRange": round(in_range, 3)},
            "note": None}


# ---------------------------------------------------------------------------
# Time-cycle engine (hour-of-day / weekday seasonality)

def time_cycles(candles: list[dict[str, Any]], forward_bars: int = 4) -> dict[str, Any]:
    if len(candles) < 40:
        return {"forwardBars": forward_bars, "hourOfDay": [], "dayOfWeek": [],
                "currentBucket": None, "reason": "insufficient candles"}
    by_hour: dict[int, list[float]] = {}
    by_dow: dict[int, list[float]] = {}
    for i in range(len(candles) - forward_bars):
        c0, cf = candles[i], candles[i + forward_bars]
        try:
            ts = int(c0["time"]) // 1000
            ret = (float(cf["close"]) - float(c0["close"])) / float(c0["close"]) * 100
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            continue
        if ret != ret:
            continue
        hour = time.gmtime(ts).tm_hour
        dow = time.gmtime(ts).tm_wday
        by_hour.setdefault(hour, []).append(ret)
        by_dow.setdefault(dow, []).append(ret)
    def rows(by: dict[int, list[float]], label: str) -> list[dict[str, Any]]:
        out = []
        for bucket in sorted(by):
            arr = by[bucket]
            out.append({"bucket": bucket, "label": label, "sampleSize": len(arr),
                        "avgForwardReturnPct": round(float(np.mean(arr)), 4),
                        "winRate": round(float(np.mean([1 if r > 0 else 0 for r in arr])), 3),
                        "significant": len(arr) >= 20})
        return out
    last = candles[-1]
    last_hour = time.gmtime(int(last["time"]) // 1000).tm_hour
    last_dow = time.gmtime(int(last["time"]) // 1000).tm_wday
    return {"forwardBars": forward_bars, "hourOfDay": rows(by_hour, "hour"),
            "dayOfWeek": rows(by_dow, "day"), "currentBucket": {"hour": last_hour, "dayOfWeek": last_dow}}


# ---------------------------------------------------------------------------
# Strategy selector

def select_strategy(regime: dict[str, Any], signal_action: str) -> dict[str, Any]:
    structure = str(regime.get("structure", "CHOP")).upper()
    volatility = str(regime.get("volatility", "NORMAL")).upper()
    tradeability = float(regime.get("tradeability", 50))
    profile, mult, floor = "DEFENSIVE_SELECTIVE", 0.80, 82.0
    emphasize: list[str] = []
    if structure == "DIRECTIONAL":
        profile, mult, floor = "TREND_CONTINUATION", 1.08, None
        emphasize = ["mtf", "momentum"]
    elif structure == "RANGE":
        profile, mult, floor = "MEAN_REVERSION", 0.97, 78.0
        emphasize = ["smc", "volume_oi"]
    if volatility == "EXPANSION":
        mult *= 0.93
        floor = max(floor or 0, 80)
    elif volatility == "COMPRESSION":
        mult *= 0.95
    trend = str(regime.get("trend", "")).upper()
    if (trend == "BULL_TREND" and signal_action.upper() in ("SHORT", "SELL")) or (trend == "BEAR_TREND" and signal_action.upper() in ("LONG", "BUY")):
        mult *= 0.9
    elif trend in ("BULL_TREND", "BEAR_TREND"):
        mult *= 1.05
    mult *= 0.85 + tradeability / 100 * 0.3
    mult = float(np.clip(mult, 0.5, 1.3))
    return {"profile": profile, "confidenceMultiplier": round(mult, 3),
            "minScoreFloor": floor, "emphasize": emphasize}


# ---------------------------------------------------------------------------
# Opportunity ranker

class OpportunityRanker:
    def __init__(self, stale_after_ms: int = 15 * 60_000) -> None:
        self._entries: dict[str, dict[str, Any]] = {}
        self.stale_after_ms = stale_after_ms

    def update(self, symbol: str, **kw: Any) -> None:
        kw.setdefault("timestamp", int(time.time() * 1000))
        kw.setdefault("action", "WAIT")
        kw.setdefault("score", 0)
        self._entries[symbol.upper()] = kw

    def get_ranked(self, limit: int = 20, include_stale: bool = False) -> list[dict[str, Any]]:
        now = int(time.time() * 1000)
        out = []
        for sym, e in self._entries.items():
            age = now - int(e.get("timestamp", 0))
            stale = age > self.stale_after_ms
            if stale and not include_stale:
                continue
            out.append({**e, "symbol": sym, "ageMs": age, "stale": stale})
        out.sort(key=lambda e: -(e.get("score") or 0))
        return out[:limit]

    def prune(self, active: list[str]) -> None:
        keep = {s.upper() for s in active}
        self._entries = {s: e for s, e in self._entries.items() if s in keep}


# ---------------------------------------------------------------------------
# Institutional gates (final hard gate)

def institutional_gates(*, score: float, rr: float, regime: dict[str, Any],
                        risk_approved: bool, effective_risk: float,
                        consensus: float, ensemble: dict[str, Any] | None,
                        learning_action: str | None, symbol_loss_streak: int,
                        core_directions: dict[str, str], signal_direction: str,
                        min_score: float = 75, min_rr: float = 1.5,
                        min_tradeability: float = 50) -> dict[str, Any]:
    failures: list[str] = []
    warnings: list[str] = []
    if score < min_score:
        failures.append(f"score {score:.0f} < {min_score:.0f}")
    if rr and rr < min_rr:
        failures.append(f"rr {rr:.2f} < {min_rr}")
    if float(regime.get("tradeability", 50)) < min_tradeability:
        failures.append(f"tradeability {regime.get('tradeability')} < {min_tradeability}")
    if str(regime.get("structure", "")).upper() == "CHOP":
        failures.append("market structure is CHOP")
    if not risk_approved:
        failures.append("risk evaluation rejected")
    if effective_risk > 2.0:
        failures.append(f"effective risk {effective_risk:.2f}% > 2%")
    for name, direction in core_directions.items():
        if direction and signal_direction and direction.upper() != signal_direction.upper() and direction.upper() != "WAIT":
            failures.append(f"core agent {name} opposes")
    if consensus < 0.5:
        failures.append(f"agent consensus {consensus:.2f} < 0.5")
    if ensemble is not None:
        if not ensemble.get("approved"):
            failures.append("ensemble gate rejected")
        elif float(ensemble.get("ensembleScore", 0)) < 55:
            failures.append("ensemble score < 55")
    if learning_action == "BLOCK":
        failures.append("adaptive learning blocks this setup")
    if symbol_loss_streak >= 3:
        failures.append(f"symbol loss streak {symbol_loss_streak}")
    if regime.get("earlyWarning", {}).get("warning") if isinstance(regime.get("earlyWarning"), dict) else regime.get("earlyWarning"):
        warnings.append("regime early warning active")
    confidence = (0.48 * score + 7 * min(rr, 3) + 0.20 * (float(regime.get("tradeability", 50)) - 50)
                  + 0.15 * (float(ensemble.get("ensembleScore", 60)) - 60 if ensemble else 0)
                  - 30 * (not risk_approved) - 2.5 * len(warnings) - 15 * len(failures))
    confidence = float(np.clip(confidence, 0, 100))
    return {"approved": not failures,
            "status": "APPROVED" if not failures and not warnings else
                      "APPROVED_WITH_WARNINGS" if not failures else "REJECTED",
            "failures": failures, "warnings": warnings,
            "confidence": round(confidence, 1)}


# ---------------------------------------------------------------------------
# Gold desk profile

def evaluate_gold_desk(symbol: str, action: str, score: float, *, consec_loss: int,
                       trades_today: int, trades_last_hour: int = 0,
                       swarm_consensus: float = 1.0, rr: float | None = None) -> dict[str, Any]:
    if "XAU" not in symbol.upper() and "GOLD" not in symbol.upper():
        return {"applies": False, "softBlock": False, "hardBlock": False, "sizeMult": 1.0}
    notes: list[str] = []
    size = 1.0
    hour = time.gmtime().tm_hour
    peak = hour in (13, 14, 15, 18, 19)
    soft = hard = False
    if not peak:
        size *= 0.7
        notes.append("off-peak session")
    if action.upper() in ("SELL", "SHORT"):
        size *= 0.8
    if score < 65:
        soft = True
        size *= 0.5
        notes.append("score below 65")
    if swarm_consensus < 0.55:
        soft = True
        size *= 0.6
        notes.append("weak swarm consensus")
    if rr is not None and rr < 1.5:
        size *= 0.75
        notes.append("rr under 1.5")
    if consec_loss >= 4:
        hard = True
        notes.append("consecutive loss halt")
    elif consec_loss >= 2:
        soft = True
        size *= 0.45
    if trades_today >= 12:
        hard = True
        notes.append("daily trade cap")
    elif trades_today >= 8:
        size *= 0.65
    if trades_last_hour >= 4:
        hard = True
        notes.append("overtrading this hour")
    size = float(np.clip(size, 0.2, 1.0))
    return {"applies": True, "softBlock": soft, "hardBlock": hard, "sizeMult": round(size, 3),
            "notes": notes, "sessionPeak": peak}


# ---------------------------------------------------------------------------
# Relative strength + intermarket (small risk helpers kept with engines)

def relative_strength(candle_stores: dict[str, dict[str, list[dict[str, Any]]]],
                      timeframe: str, lookback: int = 20) -> list[dict[str, Any]]:
    rows = []
    for sym, tfs in candle_stores.items():
        arr = tfs.get(timeframe) or []
        if len(arr) < lookback + 1:
            continue
        start = float(arr[-(lookback + 1)]["close"])
        end = float(arr[-1]["close"])
        if start <= 0:
            continue
        change_pct = (end - start) / start * 100
        trs = []
        for i in range(len(arr) - lookback, len(arr)):
            tr = (float(arr[i]["high"]) - float(arr[i]["low"])) / float(arr[i]["close"])
            trs.append(tr)
        atr_pct = float(np.mean(trs)) * 100 if trs else 0.0
        vol_adj = change_pct / atr_pct if atr_pct > 0.01 else change_pct
        rows.append({"symbol": sym, "changePct": round(change_pct, 3),
                     "atrPct": round(atr_pct, 3), "volAdjScore": round(vol_adj, 3)})
    rows.sort(key=lambda r: -r["volAdjScore"])
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


def intermarket_check(symbol: str, direction: str, dxy_prices: deque[float],
                      equity_prices: deque[float], flat_threshold: float = 0.05) -> dict[str, Any]:
    def bias(prices: deque[float]) -> str | None:
        if len(prices) < 3:
            return None
        change = (prices[-1] - prices[0]) / prices[0] * 100
        if change > flat_threshold:
            return "UP"
        if change < -flat_threshold:
            return "DOWN"
        return "FLAT"

    dxy, eq = bias(dxy_prices), bias(equity_prices)
    confirmations, divergences, reasons = 0, 0, []
    sym = symbol.upper()
    ends_usd = sym.endswith("USD") and not sym.startswith("USD")
    starts_usd = sym.startswith("USD")
    is_metal = sym.startswith(("XAU", "XAG"))
    if dxy and direction.upper() in ("LONG", "BUY"):
        expected = "DOWN" if (ends_usd or is_metal) else ("UP" if starts_usd else None)
        if expected:
            if dxy == expected:
                confirmations += 1
                reasons.append("dxy confirms")
            elif dxy != "FLAT":
                divergences += 1
                reasons.append("dxy diverges")
    elif dxy and direction.upper() in ("SHORT", "SELL"):
        expected = "UP" if (ends_usd or is_metal) else ("DOWN" if starts_usd else None)
        if expected:
            if dxy == expected:
                confirmations += 1
                reasons.append("dxy confirms")
            elif dxy != "FLAT":
                divergences += 1
                reasons.append("dxy diverges")
    confirmed = None if confirmations == divergences else confirmations > divergences
    return {"available": confirmations + divergences > 0, "confirmed": confirmed,
            "confirmSignals": confirmations, "divergeSignals": divergences,
            "reasons": reasons, "dxy": {"direction": dxy}, "equity": {"direction": eq}}
