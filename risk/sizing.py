"""Position sizing.

Two methods, both bounded:

  fixed fractional   risk a fixed % of balance per trade. Predictable, and
                     what the system defaults to.
  fractional Kelly   scale by edge when a calibrated win probability exists.
                     Full Kelly is far too aggressive for a retail account
                     with imperfect probability estimates, so it is capped
                     (KELLY_FRACTION_CAP, default 0.25 = quarter-Kelly) and
                     can never exceed the fixed-fractional risk.

Kelly is only used when a CALIBRATED probability is available. Feeding it a
raw ensemble score would size positions off a number that means nothing.
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = ["SizingResult", "kelly_fraction", "size_position"]


@dataclass(frozen=True, slots=True)
class SizingResult:
    units: float
    risk_amount: float
    risk_pct: float
    method: str
    notes: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "units": self.units,
            "riskAmount": self.risk_amount,
            "riskPct": self.risk_pct,
            "method": self.method,
            "notes": list(self.notes),
        }


def kelly_fraction(win_prob: float, reward_risk: float) -> float:
    """Kelly fraction f* = (p*b - q) / b. Negative means no edge — do not bet."""
    if not (0.0 < win_prob < 1.0) or reward_risk <= 0:
        return 0.0
    b = reward_risk
    f = (win_prob * b - (1.0 - win_prob)) / b
    return max(0.0, f)


def size_position(
    *,
    balance: float,
    entry: float,
    stop_loss: float,
    risk_pct: float,
    contract_size: float = 100_000.0,
    win_prob: float | None = None,
    reward_risk: float | None = None,
    kelly_cap: float = 0.25,
) -> SizingResult:
    """Return position size in units. Returns zero size rather than raising
    when inputs make sizing impossible — an un-sizeable trade is simply not
    taken."""
    notes: list[str] = []

    if balance <= 0:
        return SizingResult(0.0, 0.0, 0.0, "none", ("account balance not set",))

    stop_distance = abs(entry - stop_loss)
    if stop_distance <= 0:
        return SizingResult(0.0, 0.0, 0.0, "none", ("stop distance is zero",))

    base_pct = risk_pct / 100.0
    method = "fixed-fractional"
    final_pct = base_pct

    if win_prob is not None and reward_risk is not None and reward_risk > 0:
        f = kelly_fraction(win_prob, reward_risk)
        scaled = f * kelly_cap
        if scaled <= 0:
            notes.append(
                f"no mathematical edge at {win_prob:.0%} win rate and {reward_risk:.1f}R — "
                "size reduced to zero"
            )
            return SizingResult(0.0, 0.0, 0.0, "kelly", tuple(notes))
        # Never let Kelly increase risk above the fixed-fractional ceiling.
        final_pct = min(scaled, base_pct)
        method = "fractional-kelly"
        notes.append(
            f"quarter-Kelly suggests {scaled:.2%}, capped at the {base_pct:.2%} per-trade limit"
            if scaled > base_pct
            else f"quarter-Kelly sized at {scaled:.2%} of balance"
        )
    else:
        notes.append("no calibrated probability yet — using fixed fractional risk")

    risk_amount = balance * final_pct
    units = risk_amount / stop_distance
    if contract_size > 0:
        units = units / contract_size * contract_size  # explicit, keeps units in base

    return SizingResult(
        units=round(max(0.0, units), 6),
        risk_amount=round(risk_amount, 2),
        risk_pct=round(final_pct * 100.0, 4),
        method=method,
        notes=tuple(notes),
    )
