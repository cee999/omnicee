"""Validation engines: Monte Carlo, Bayesian, statistical, walk-forward, and
the final ensemble gate.

Ports of Node `signal-pipeline/{monte-carlo,bayesian,statistical-validator,
walk-forward-optimizer,ensemble-engine}.js`. All operate on numpy arrays and
plain dicts so they can be unit-tested without the pipeline.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Monte Carlo (GBM + iid bootstrap + block bootstrap)

def _normal(n: int, rng: np.random.Generator) -> np.ndarray:
    return rng.standard_normal(n)


def monte_carlo_validate(candles: dict[str, Any], direction: str, entry: float,
                         stop_loss: float, targets: list[float], *,
                         simulations: int = 5000, max_steps: int = 200,
                         min_win_prob: float = 0.55, min_expected_r: float = 0.3,
                         max_risk_of_ruin: float = 0.15, seed: int | None = None) -> dict[str, Any]:
    """Path-simulate SL/target outcomes under three return models."""
    closes = np.asarray(candles.get("close", []), dtype=float)
    if closes.size < 50 or not targets or stop_loss <= 0 or entry <= 0:
        return {"approved": True, "simulations": 0, "winProbability": None,
                "expectedR": None, "riskOfRuin": None, "penalty": 0,
                "note": "insufficient data for simulation — non-blocking"}
    risk = abs(entry - stop_loss)
    if risk <= 0:
        return {"approved": True, "simulations": 0, "winProbability": None,
                "expectedR": None, "riskOfRuin": None, "penalty": 0, "note": "zero risk distance"}
    log_ret = np.diff(np.log(closes[closes > 0]))
    sigma = float(log_ret.std(ddof=1))
    mu = float(log_ret.mean())
    if sigma <= 0:
        sigma = 1e-6
    vol_ratio = float(log_ret[-20:].std(ddof=1) / sigma) if log_ret.size >= 20 else 1.0
    adj_sigma = sigma * float(np.clip(vol_ratio, 0.5, 2.0))
    drift = mu
    if "TREND" in str(candles.get("regime", "")).upper():
        drift = mu + 0.05 * adj_sigma * (1 if "BULL" in str(candles.get("regime", "")).upper() else -1)

    rng = np.random.default_rng(seed)
    sign = 1.0 if direction.upper() in ("LONG", "BUY") else -1.0

    def run_paths(mode: str) -> dict[str, float]:
        wins = 0
        outcomes = np.empty(simulations)
        drawdowns = np.empty(simulations)
        n_ret = log_ret.size
        for i in range(simulations):
            price = entry
            peak = entry
            max_dd = 0.0
            outcome = 0.0
            for _ in range(max_steps):
                if mode == "gbm":
                    z = _normal(1, rng)[0]
                    price *= np.exp((drift - adj_sigma ** 2 / 2) + adj_sigma * z)
                elif mode == "bootstrap":
                    price *= np.exp(log_ret[rng.integers(n_ret)])
                else:  # block bootstrap
                    start = rng.integers(max(1, n_ret - 5))
                    price *= np.exp(log_ret[start:start + 5].mean())
                peak = max(peak, price)
                max_dd = max(max_dd, (peak - price) / peak)
                hit_sl = (sign > 0 and price <= stop_loss) or (sign < 0 and price >= stop_loss)
                if hit_sl:
                    outcome = -risk / entry
                    break
                for ti, tp in enumerate(targets):
                    if (sign > 0 and price >= tp) or (sign < 0 and price <= tp):
                        outcome = sign * (tp - entry) / entry
                        break
                else:
                    continue
                break
            else:
                outcome = sign * (price - entry) / entry
            outcomes[i] = outcome
            drawdowns[i] = max_dd
            if outcome > 0:
                wins += 1
        return {"winProb": wins / simulations, "expectedR": float(outcomes.mean()),
                "medianR": float(np.median(outcomes)), "maxDD": float(drawdowns.max()),
                "var95": float(np.percentile(outcomes, 5)),
                "cvar95": float(outcomes[outcomes <= np.percentile(outcomes, 5)].mean())}

    gbm = run_paths("gbm")
    boot = run_paths("bootstrap")
    block = run_paths("block")

    win_prob = 0.30 * gbm["winProb"] + 0.40 * boot["winProb"] + 0.30 * block["winProb"]
    expected_r = 0.30 * gbm["expectedR"] + 0.40 * boot["expectedR"] + 0.30 * block["expectedR"]
    max_dd = max(gbm["maxDD"], boot["maxDD"], block["maxDD"])
    risk_of_ruin = 1.0 if win_prob <= 0.5 else ((1 - win_prob) / win_prob) ** 10 * min(2.0, vol_ratio)
    risk_of_ruin = min(risk_of_ruin, 1.0)
    approved = win_prob >= min_win_prob and expected_r >= min_expected_r and risk_of_ruin <= max_risk_of_ruin
    penalty = 0
    if not approved:
        gaps = max(0, (min_win_prob - win_prob) * 40) + max(0, (min_expected_r - expected_r) * 30) \
            + max(0, (risk_of_ruin - max_risk_of_ruin) * 60)
        penalty = int(min(20, max(5, round(gaps))))
    return {"approved": approved, "simulations": simulations * 3,
            "winProbability": round(win_prob, 4), "expectedR": round(expected_r, 4),
            "medianR": round(0.3 * gbm["medianR"] + 0.4 * boot["medianR"] + 0.3 * block["medianR"], 4),
            "riskOfRuin": round(risk_of_ruin, 4), "maxDrawdownPct": round(max_dd * 100, 2),
            "var95": round(0.3 * gbm["var95"] + 0.4 * boot["var95"] + 0.3 * block["var95"], 4),
            "calibration": {"annualizedVolPct": round(adj_sigma * np.sqrt(252 * 24) * 100, 2), "drift": round(drift, 6)},
            "penalty": penalty}


# ---------------------------------------------------------------------------
# Bayesian engine (likelihood-ratio evidence + Beta-Binomial posteriors)

LR_FACTORS = {
    "agentAgreement>=0.8": (0.75, 0.35), "agentAgreement>=0.6": (0.60, 0.45), "agentAgreement<0.6": (0.35, 0.65),
    "score>=85": (0.80, 0.25), "score>=75": (0.60, 0.40), "score<75": (0.35, 0.60),
    "tradeability>=75": (0.72, 0.38), "tradeability>=55": (0.55, 0.48), "tradeability<55": (0.30, 0.65),
    "rr>=3": (0.72, 0.30), "rr>=2": (0.62, 0.40), "rr>=1.5": (0.52, 0.48), "rr>0": (0.30, 0.65),
    "riskRejected": (0.15, 0.80),
}


def bayesian_posterior(features: dict[str, Any], prior: float = 0.50,
                       min_posterior: float = 0.52) -> dict[str, Any]:
    """Fuse likelihood-ratio evidence into a win probability."""
    odds = prior / (1 - prior)
    factors: list[dict[str, Any]] = []

    def add(name: str, lr: float) -> None:
        lr = float(np.clip(lr, 0.1, 10.0))
        factors.append({"name": name, "lr": round(lr, 3),
                        "direction": "SUPPORTS" if lr > 1 else "OPPOSES"})
        nonlocal odds
        odds *= lr

    agreement = float(features.get("agentAgreement", 0.5))
    if agreement >= 0.8:
        add("agentAgreement>=0.8", 0.75 / 0.35)
    elif agreement >= 0.6:
        add("agentAgreement>=0.6", 0.60 / 0.45)
    else:
        add("agentAgreement<0.6", 0.35 / 0.65)
    score = float(features.get("score", 0))
    if score >= 85:
        add("score>=85", 0.80 / 0.25)
    elif score >= 75:
        add("score>=75", 0.60 / 0.40)
    else:
        add("score<75", 0.35 / 0.60)
    tradeability = float(features.get("tradeability", 50))
    if tradeability >= 75:
        add("tradeability>=75", 0.72 / 0.38)
    elif tradeability >= 55:
        add("tradeability>=55", 0.55 / 0.48)
    else:
        add("tradeability<55", 0.30 / 0.65)
    rr = float(features.get("rr", 0))
    if rr >= 3:
        add("rr>=3", 0.72 / 0.30)
    elif rr >= 2:
        add("rr>=2", 0.62 / 0.40)
    elif rr >= 1.5:
        add("rr>=1.5", 0.52 / 0.48)
    elif rr > 0:
        add("rr>0", 0.30 / 0.65)
    if features.get("riskRejected"):
        add("riskRejected", 0.15 / 0.80)
    posterior = float(np.clip(odds / (1 + odds), 0.01, 0.99))
    approved = posterior >= min_posterior
    penalty = min(15, round((min_posterior - posterior) * 60)) if not approved else 0
    return {"approved": approved, "posterior": round(posterior, 4), "prior": prior,
            "evidenceCount": len(factors), "topFactors": sorted(factors, key=lambda f: -f["lr"])[:5],
            "penalty": penalty}


# ---------------------------------------------------------------------------
# Statistical validator — 10 hypothesis tests, gate at >= 5 passed

import math


def _normal_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def statistical_validate(candles: dict[str, Any], direction: str, score: float, *,
                         min_tests: int = 5, significance: float = 0.05) -> dict[str, Any]:
    closes = np.asarray(candles.get("close", []), dtype=float)
    if closes.size < 50:
        return {"approved": True, "passed": 0, "neutral": 0, "total": 10,
                "compositeScore": 50.0, "penalty": 0, "note": "insufficient bars — non-blocking"}
    ret = np.diff(np.log(closes[closes > 0]))
    sign = 1 if direction.upper() in ("LONG", "BUY") else -1
    tests: list[dict[str, Any]] = []

    def record(name: str, weight: float, passed: bool | None, statistic: Any = None,
               p_value: float | None = None) -> None:
        tests.append({"name": name, "weight": weight,
                      "passed": passed is True, "neutral": passed is None,
                      "statistic": statistic, "pValue": p_value})

    # 1 mean-reversion extension
    w = closes[-50:]
    z = (closes[-1] - w.mean()) / (w.std(ddof=1) or 1e-12)
    record("meanReversionExtension", 1.5, (-2.5 < z < 2.0) if sign > 0 else (-2.0 < z < 2.5), round(z, 3))
    # 2 trend significance
    x = np.arange(30, dtype=float)
    slope, intercept = np.polyfit(x, closes[-30:], 1)
    resid = closes[-30:] - (intercept + slope * x)
    mse = float((resid ** 2).mean())
    se = np.sqrt(mse / ((x - x.mean()) ** 2).sum()) if mse > 0 else 0.0
    t_stat = slope / se if se > 0 else 0.0
    p_val = 2 * (1 - _normal_cdf(abs(t_stat)))
    record("trendSignificance", 2.0, (p_val < significance and np.sign(slope) == sign) or None,
            round(t_stat, 3), round(p_val, 5))
    # 3 Ljung-Box
    acf = []
    for k in range(1, 6):
        r = ret[:-k]
        denom = float((ret ** 2).sum())
        acf.append(float((ret[k:] * r).sum() / denom) if denom > 0 else 0.0)
    n = ret.size
    q = n * (n + 2) * sum(rho ** 2 / (n - k) for k, rho in zip(range(1, 6), acf, strict=False))
    p_lb = 1 - _normal_cdf(np.sqrt(q / 5)) if q > 0 else 1.0
    record("ljungBox", 1.0, p_lb < significance or None, round(q, 3), round(p_lb, 5))
    # 4 variance ratio
    sums5 = np.convolve(ret, np.ones(5), mode="valid")
    var5 = float(sums5.var(ddof=1)) if sums5.size > 2 else 0.0
    var1 = float(ret.var(ddof=1)) or 1e-12
    vr = var5 / (5 * var1)
    vr_z = (vr - 1) / np.sqrt(2 * 4 / (n * 5))
    p_vr = 2 * (1 - _normal_cdf(abs(vr_z)))
    record("varianceRatio", 1.5, p_vr < significance or None, round(vr, 3), round(p_vr, 5))
    # 5 runs test
    med = float(np.median(closes[-50:]))
    runs_sign = closes[-50:] > med
    runs = 1 + int((np.diff(runs_sign.astype(int)) != 0).sum())
    n1 = int(runs_sign.sum())
    n2 = len(runs_sign) - n1
    exp_runs = 2 * n1 * n2 / max(n1 + n2, 1) + 1
    var_runs = 2 * n1 * n2 * (2 * n1 * n2 - n1 - n2) / max((n1 + n2) ** 2 * (n1 + n2 - 1), 1)
    runs_z = (runs - exp_runs) / np.sqrt(var_runs) if var_runs > 0 else 0.0
    p_runs = 2 * (1 - _normal_cdf(abs(runs_z)))
    record("runsTest", 1.0, p_runs < significance or None, round(runs_z, 3), round(p_runs, 5))
    # 6 hurst
    from ..features.indicators import hurst
    h_val = hurst(closes)
    record("hurst", 2.0, (h_val > 0.55 or h_val < 0.45) if np.isfinite(h_val) else None, round(float(h_val), 3))
    # 7 signal z-score
    z_sig = (score - 65) / 12
    record("signalZScore", 1.5, z_sig > 0.8, round(z_sig, 3))
    # 8 bootstrap CI of mean return
    rng = np.random.default_rng(42)
    boot_means = np.array([ret[rng.integers(0, n, n)].mean() for _ in range(2000)])
    lo, hi = float(np.percentile(boot_means, 2.5)), float(np.percentile(boot_means, 97.5))
    record("bootstrapCI", 1.5, (lo > -0.0001) if sign > 0 else (hi < 0.0001), None, None)
    # 9 CUSUM stability
    demeaned = ret - ret.mean()
    cusum = np.cumsum(demeaned)
    threshold = float(ret.std(ddof=1) * np.sqrt(n) * 1.36)
    recent_max = float(np.abs(cusum[-10:]).max())
    record("cusum", 1.5, recent_max <= 0.7 * threshold, round(recent_max, 4))
    # 10 volatility stability
    vol_recent = float(ret[-15:].std(ddof=1))
    vol_rest = float(ret[:-15].std(ddof=1)) if ret.size > 15 else 0.0
    ratio = vol_recent / vol_rest if vol_rest > 0 else 1.0
    record("volatilityStability", 1.0, 0.5 <= ratio <= 2.0, round(ratio, 3))

    passed = sum(1 for t in tests if t["passed"])
    neutral = sum(1 for t in tests if t["neutral"])
    total_w = sum(t["weight"] for t in tests)
    score_sum = sum(t["weight"] if t["passed"] else (-0.5 * t["weight"] if not t["neutral"] else 0) for t in tests)
    composite = score_sum / total_w * 100 if total_w else 50.0
    approved = passed >= min_tests
    penalty = min(15, (min_tests - passed) * 3) if not approved else 0
    return {"approved": approved, "passed": passed, "neutral": neutral, "total": len(tests),
            "compositeScore": round(composite, 2), "tests": tests, "penalty": penalty}


# ---------------------------------------------------------------------------
# Walk-forward optimizer

def walk_forward(history: list[dict[str, Any]], *, min_samples: int = 20,
                 min_wfe: float = 0.35) -> dict[str, Any]:
    """In-sample/out-of-sample Sharpe split on closed outcomes (pnlR)."""
    if len(history) < min_samples:
        return {"sufficient": False, "wfe": None, "robust": False, "needsRecalibration": False,
                "penalty": 0, "note": f"{len(history)}/{min_samples} outcomes", "adjustments": {}}
    split = int(len(history) * 0.7)
    ins, oos = history[:split], history[split:]
    if len(oos) < 5:
        return {"sufficient": False, "wfe": None, "robust": False, "needsRecalibration": False,
                "penalty": 0, "note": "out-of-sample too small", "adjustments": {}}

    def sharpe(rows: list[dict[str, Any]]) -> float:
        r = np.array([float(x.get("pnlR") or 0) for x in rows])
        return float(r.mean() / r.std(ddof=1)) if r.std(ddof=1) > 0 else 0.0

    is_sharpe, oos_sharpe = sharpe(ins), sharpe(oos)
    wfe = oos_sharpe / is_sharpe if is_sharpe > 0 else 0.0
    robust = wfe >= min_wfe
    recent_wr = float(np.mean([1 if float(x.get("pnlR") or 0) > 0 else 0 for x in history[-10:]]))
    prior_wr = float(np.mean([1 if float(x.get("pnlR") or 0) > 0 else 0 for x in history[-30:-10]]))
    degrading = prior_wr - recent_wr > 0.15
    needs_recal = wfe < 0.25 or degrading
    penalty = 10 if needs_recal else (5 if not robust else 0)
    return {"sufficient": True, "wfe": round(wfe, 4), "robust": robust,
            "needsRecalibration": needs_recal, "penalty": penalty,
            "inSample": {"count": len(ins), "sharpe": round(is_sharpe, 4)},
            "outOfSample": {"count": len(oos), "sharpe": round(oos_sharpe, 4)},
            "degradation": {"degrading": degrading, "recentWinRate": round(recent_wr, 3),
                            "previousWinRate": round(prior_wr, 3)},
            "adjustments": {}}


# ---------------------------------------------------------------------------
# Ensemble gate — weighted layer scoring + hard rejections

LAYER_WEIGHTS = {"monteCarlo": 20, "bayesian": 18, "statistical": 15, "walkForward": 12,
                 "learning": 15, "agentConsensus": 10, "regime": 5, "fractal": 3, "microstructure": 2}


def ensemble_gate(layers: dict[str, dict[str, Any]], signal_score: float, *,
                  min_confidence: float = 60.0, max_total_penalty: float = 35.0) -> dict[str, Any]:
    """layers: name -> {approved, score, penalty?}. Missing optional layers reduce denominator."""
    scored: list[dict[str, Any]] = []
    total_w = 0.0
    weighted = 0.0
    total_penalty = 0.0
    hard_rejections: list[str] = []
    for name, layer in layers.items():
        weight = LAYER_WEIGHTS.get(name, 5)
        approved = bool(layer.get("approved", True))
        score = float(layer.get("score", 50))
        penalty = float(layer.get("penalty", 0))
        present = layer.get("present", True)
        w = weight * (0.3 if not present else 1.0)
        scored.append({"name": name, "approved": approved, "score": round(score, 2),
                       "weight": w, "present": present, "penalty": penalty})
        total_w += w
        weighted += score * w
        total_penalty += penalty
        if not approved and weight >= 10 and present:
            hard_rejections.append(name)
    ensemble_score = weighted / total_w if total_w else 50.0
    total_penalty = min(total_penalty, max_total_penalty)
    approved = ensemble_score >= min_confidence and not hard_rejections
    return {"approved": approved, "ensembleScore": round(ensemble_score, 2),
            "totalPenalty": round(total_penalty, 2),
            "adjustedScore": max(0.0, signal_score - total_penalty),
            "approvedLayers": sum(1 for l in scored if l["approved"]),
            "rejectedLayers": sum(1 for l in scored if not l["approved"]),
            "hardRejections": hard_rejections, "layers": scored}
