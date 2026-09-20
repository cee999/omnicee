"""Risk stack: correlation gates, drawdown circuit breaker, session filter,
position sizer. Ports of Node `risk-engine/` modules — thresholds verbatim.

Risk gates are deterministic and final. No agent, model or advisor overrides
them.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any

import numpy as np

from ..engines.pipeline import atr_wilder

KNOWN_CORRELATIONS = {
    ("EURUSD", "GBPUSD"): 0.85, ("EURUSD", "USDCHF"): -0.90, ("BTCUSDT", "ETHUSDT"): 0.90,
    ("EURUSD", "UUP"): -0.97,
}
CORRELATION_GROUPS = [
    {"USD_MAJORS": ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD"]},
    {"USD_JPY_GROUP": ["USDJPY", "USDCHF"]},
    {"GOLD_SILVER": ["XAUUSD", "XAGUSD"]},
    {"CRYPTO_MAJOR": ["BTCUSDT", "ETHUSDT"]},
    {"OIL_ENERGY": ["USOIL"]},
]
MAX_CLASS_EXPOSURE_PCT = {"FOREX_MAJOR": 6, "FOREX_CROSS": 4, "METALS": 4,
                          "CRYPTO": 5, "INDICES": 4, "ENERGY": 2}


def asset_class(symbol: str) -> str:
    s = symbol.upper()
    if s in ("BTCUSDT", "ETHUSDT") or "USDT" in s or "USDC" in s:
        return "CRYPTO"
    if s.startswith(("XAU", "XAG")):
        return "METALS"
    if "OIL" in s or "CL=" in s or "USO" in s:
        return "ENERGY"
    if len(s) == 6 and s.endswith("USD") and not s.startswith("USD"):
        return "FOREX_MAJOR"
    if len(s) == 6 and "USD" in s:
        return "FOREX_CROSS"
    return "INDICES"


class CorrelationFilter:
    def __init__(self, max_open: int = 5, max_correlated: int = 2,
                 threshold: float = 0.70, window: int = 50) -> None:
        self.max_open = max_open
        self.max_correlated = max_correlated
        self.threshold = threshold
        self.window = window
        self.positions: dict[str, dict[str, Any]] = {}
        self.returns: dict[str, deque[float]] = {}

    def update_candles(self, symbol: str, closes: list[float]) -> None:
        arr = self.returns.setdefault(symbol.upper(), deque(maxlen=self.window))
        arr.clear()
        for a, b in zip(closes[-(self.window + 1):], closes[-self.window:], strict=False):
            if a > 0:
                arr.append((b - a) / a)

    @staticmethod
    def _pearson(a: list[float], b: list[float]) -> float:
        n = min(len(a), len(b))
        if n < 2:
            return 0.0
        x, y = np.array(list(a)[-n:]), np.array(list(b)[-n:])
        sx, sy = x.std(), y.std()
        if sx == 0 or sy == 0:
            return 0.0
        return float(np.clip(((x - x.mean()) * (y - y.mean())).mean() / (sx * sy), -1, 1))

    def correlation(self, a: str, b: str) -> float:
        ra, rb = self.returns.get(a), self.returns.get(b)
        if ra and rb and len(ra) >= 5 and len(rb) >= 5:
            return self._pearson(list(ra), list(rb))
        for pair, value in KNOWN_CORRELATIONS.items():
            if set(pair) == {a.upper(), b.upper()}:
                return value
        for group in CORRELATION_GROUPS:
            names = next(iter(group.values()))
            if a.upper() in names and b.upper() in names:
                return 0.75
        return 0.0

    def check(self, symbol: str, direction: str, risk_pct: float) -> dict[str, Any]:
        sym = symbol.upper()
        if len(self.positions) >= self.max_open:
            return {"allowed": False, "reason": f"max open positions ({self.max_open})"}
        if sym in self.positions:
            return {"allowed": False, "reason": "already open on this symbol"}
        compounding = 0
        conflicts = []
        for other, pos in self.positions.items():
            corr = self.correlation(sym, other)
            if abs(corr) >= self.threshold:
                same_dir = (pos["direction"] == direction) if corr > 0 else (pos["direction"] != direction)
                if same_dir:
                    compounding += 1
                    conflicts.append({"symbol": other, "corr": round(corr, 3), "type": "COMPOUNDING"})
        if compounding >= self.max_correlated:
            return {"allowed": False, "reason": f"{compounding} compounding correlated positions",
                    "conflicts": conflicts}
        new_class = asset_class(sym)
        class_risk = sum(float(p.get("riskPct", 0)) for p in self.positions.values()
                         if asset_class(p["symbol"]) == new_class)
        cap = MAX_CLASS_EXPOSURE_PCT.get(new_class, 6)
        if class_risk + risk_pct > cap:
            return {"allowed": False, "reason": f"{new_class} exposure {class_risk + risk_pct:.1f}% > {cap}%",
                    "conflicts": conflicts}
        return {"allowed": True, "reason": None, "conflicts": conflicts,
                "newExposureWarnings": []}

    def open_position(self, signal_id: str, symbol: str, direction: str, risk_pct: float) -> None:
        self.positions[signal_id] = {"symbol": symbol.upper(), "direction": direction, "riskPct": risk_pct,
                                     "openedAt": time.time() * 1000}

    def close_position(self, signal_id: str) -> None:
        self.positions.pop(signal_id, None)


class DrawdownGuard:
    """Circuit breaker + adaptive sizing factor."""

    def __init__(self, max_daily_loss_pct: float = 3.0, max_drawdown_pct: float = 10.0,
                 max_consec_loss: int = 4, max_trades_per_day: int = 10,
                 weekly_loss_limit_pct: float = 7.0) -> None:
        self.max_daily = max_daily_loss_pct
        self.max_dd = max_drawdown_pct
        self.max_consec = max_consec_loss
        self.max_trades = max_trades_per_day
        self.weekly_limit = weekly_loss_limit_pct
        self.daily_pnl = 0.0
        self.weekly_pnl = 0.0
        self.trades_today = 0
        self.consec_loss = 0
        self.peak_balance = 0.0
        self.balance = 0.0
        self.state = "CLOSED"
        self._day = time.gmtime().tm_yday

    def set_balance(self, balance: float) -> None:
        self.balance = balance
        self.peak_balance = max(self.peak_balance, balance)

    def record(self, pnl_pct: float, won: bool) -> None:
        self._roll_day()
        self.daily_pnl += pnl_pct
        self.weekly_pnl += pnl_pct
        self.trades_today += 1
        if won:
            self.consec_loss = 0
        else:
            self.consec_loss += 1
        self._update_state()

    def _roll_day(self) -> None:
        today = time.gmtime().tm_yday
        if today != self._day:
            self._day = today
            self.daily_pnl = 0.0
            self.trades_today = 0
            self.consec_loss = 0
            if self.state in ("WARNING", "HALF"):
                self.state = "CLOSED"

    def _update_state(self) -> None:
        dd = self.drawdown_pct()
        if (self.daily_pnl <= -self.max_daily or dd >= self.max_dd
                or self.consec_loss >= self.max_consec or self.weekly_pnl <= -self.weekly_limit):
            self.state = "OPEN"
        elif self.daily_pnl <= -0.67 * self.max_daily or dd >= 0.75 * self.max_dd or self.consec_loss >= 3:
            self.state = "HALF"
        elif self.daily_pnl <= -0.5 * self.max_daily or dd >= 0.5 * self.max_dd or self.consec_loss >= 2:
            self.state = "WARNING"
        else:
            self.state = "CLOSED"

    def drawdown_pct(self) -> float:
        if self.peak_balance <= 0 or self.balance <= 0:
            return 0.0
        return (self.peak_balance - self.balance) / self.peak_balance * 100

    def evaluate(self) -> dict[str, Any]:
        self._roll_day()
        self._update_state()
        factor = {"CLOSED": 1.0, "WARNING": 0.75, "HALF": 0.5, "OPEN": 0.0}.get(self.state, 1.0)
        if self.state == "OPEN":
            return {"allowed": False, "sizingFactor": 0.0, "reason": "circuit breaker OPEN",
                    "state": self.state, "warnings": []}
        if self.trades_today >= self.max_trades:
            return {"allowed": False, "sizingFactor": 0.0, "reason": "daily trade cap",
                    "state": self.state, "warnings": []}
        warnings = []
        if self.state == "HALF":
            warnings.append("circuit breaker HALF — sizing halved")
        elif self.state == "WARNING":
            warnings.append("circuit breaker WARNING — sizing reduced")
        return {"allowed": True, "sizingFactor": factor, "reason": None,
                "state": self.state, "warnings": warnings,
                "dailyPnl": round(self.daily_pnl, 3), "weeklyPnl": round(self.weekly_pnl, 3),
                "consecLoss": self.consec_loss, "dailyTrades": self.trades_today,
                "drawdownPct": round(self.drawdown_pct(), 3)}


class SessionFilter:
    """Session/news/weekend gate — returns a size multiplier (0 = block)."""

    LIQUIDITY: dict[str, list[float]] = {
        "FOREX_MAJOR": [0.3, 0.2, 0.2, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0, 0.95, 0.9, 0.85, 0.8, 0.9, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.35, 0.3],
        "CRYPTO": [0.8] * 24,
        "METALS": [0.3, 0.2, 0.2, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0, 0.95, 0.9, 0.85, 0.8, 0.9, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.35, 0.3],
        "INDICES": [0.2] * 7 + [0.5, 0.9, 1.0, 1.0, 1.0, 0.9, 0.7, 0.4, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
        "ENERGY": [0.2] * 7 + [0.5, 0.9, 1.0, 1.0, 1.0, 0.9, 0.7, 0.4, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
        "FOREX_CROSS": [0.3, 0.2, 0.2, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0, 0.95, 0.9, 0.85, 0.8, 0.9, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.35, 0.3],
    }

    def __init__(self, require_killzone: bool = False) -> None:
        self.require_killzone = require_killzone

    def check(self, symbol: str, ts_ms: int | None = None,
              news_events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        ts = time.gmtime((ts_ms or time.time() * 1000) / 1000)
        sym = symbol.upper()
        klass = asset_class(sym)
        is_crypto = klass == "CRYPTO"
        hour = ts.tm_hour + ts.tm_min / 60
        breakdown: dict[str, Any] = {"assetClass": klass, "utcHour": ts.tm_hour}
        # weekend
        if not is_crypto and (ts.tm_wday == 5 or (ts.tm_wday == 6 and hour < 21) or (ts.tm_wday == 4 and hour >= 21)):
            return {"allowed": False, "reason": "weekend", "multiplier": 0.0, "assetClass": klass,
                    "breakdown": breakdown}
        # liquidity
        curve = self.LIQUIDITY.get(klass, self.LIQUIDITY["FOREX_MAJOR"])
        liq = curve[ts.tm_hour] * 100
        breakdown["liquidity"] = round(liq, 1)
        if liq < 15:
            return {"allowed": False, "reason": "illiquid hour", "multiplier": 0.0,
                    "assetClass": klass, "breakdown": breakdown}
        # news blackout
        multiplier = liq / 100
        is_pre_event = False
        for ev in news_events or []:
            mins = (float(ev.get("time", 0)) - (ts_ms or time.time() * 1000)) / 60_000
            tier = str(ev.get("tierHint") or "")
            pre, post = {"TIER_1": (60, 30), "TIER_2": (30, 20)}.get(tier, (15, 10))
            if -post <= mins <= pre:
                if mins <= 15 and tier in ("TIER_1", "TIER_2"):
                    return {"allowed": False, "reason": f"news blackout: {ev.get('name')}",
                            "multiplier": 0.0, "assetClass": klass, "breakdown": breakdown}
                if 0 < mins <= pre:
                    is_pre_event = True
                    multiplier *= 0.5 if tier == "TIER_1" else 0.75
                    breakdown["calendar"] = f"pre-event {ev.get('name')}"
        if self.require_killzone and not is_crypto and not (13 <= ts.tm_hour < 16):
            return {"allowed": False, "reason": "killzone required", "multiplier": 0.0,
                    "assetClass": klass, "breakdown": breakdown}
        return {"allowed": True, "reason": None, "multiplier": round(float(np.clip(multiplier, 0.30, 1.20)), 3),
                "assetClass": klass, "isPreEvent": is_pre_event,
                "liquidityTier": "PRIME" if liq >= 85 else "GOOD" if liq >= 60 else "FAIR" if liq >= 35 else "POOR",
                "breakdown": breakdown}


class PositionSizer:
    """ATR-based sizing with volatility scaling, drawdown and session factors."""

    LOT_STEP = {"BTCUSDT": 0.001, "ETHUSDT": 0.01, "XAUUSD": 0.01, "EURUSD": 0.01, "GBPUSD": 0.01}

    def __init__(self, balance: float, risk_pct: float, max_risk_pct: float = 2.0,
                 leverage: int = 20, drawdown: DrawdownGuard | None = None) -> None:
        self.balance = balance
        self.risk_pct = risk_pct
        self.max_risk_pct = max_risk_pct
        self.leverage = leverage
        self.drawdown = drawdown

    def size(self, symbol: str, entry: float, stop_loss: float,
             session_mult: float = 1.0, atr: float | None = None) -> dict[str, Any]:
        if entry <= 0 or stop_loss <= 0 or entry == stop_loss:
            return {"approved": False, "reason": "invalid entry/stop geometry", "positionSize": 0}
        risk_pct = self.risk_pct
        if atr and entry:
            atr_pct = atr / entry
            if atr_pct > 0.015:
                risk_pct *= 0.5
            elif atr_pct < 0.003:
                risk_pct *= 1.5
        risk_pct = min(risk_pct * session_mult, self.max_risk_pct)
        risk_pct = max(risk_pct, 0.25)
        dd_eval = self.drawdown.evaluate() if self.drawdown else {"allowed": True, "sizingFactor": 1.0}
        if not dd_eval.get("allowed"):
            return {"approved": False, "reason": dd_eval.get("reason"), "positionSize": 0,
                    "drawdown": dd_eval}
        risk_pct *= dd_eval.get("sizingFactor", 1.0)
        risk_amount = self.balance * risk_pct / 100
        sl_distance = abs(entry - stop_loss)
        units = risk_amount / sl_distance
        step = self.LOT_STEP.get(symbol.upper(), 0.01)
        units = max(round(units / step) * step, 0.0)
        position_value = units * entry
        margin = position_value / self.leverage
        if margin > 0.9 * self.balance:
            return {"approved": False, "reason": "insufficient margin", "positionSize": 0}
        return {"approved": True, "reason": None, "positionSize": units,
                "sizing": {"units": units, "positionValue": round(position_value, 2),
                           "riskAmount": round(risk_amount, 2), "effectiveRiskPct": round(risk_pct, 3),
                           "margin": round(margin, 2), "slDistance": round(sl_distance, 6),
                           "lotStep": step, "sessionMultiplier": session_mult,
                           "drawdownFactor": dd_eval.get("sizingFactor", 1.0)}}
