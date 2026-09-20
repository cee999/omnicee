"""Deterministic risk gates.

These are hard rules, not model outputs. Nothing downstream — not an agent,
not the ensemble, not the AI advisor — can override them. A gate either passes
or it blocks with a stated reason, and the reason is carried on the signal so
the UI can show exactly why nothing fired.

This is the layer that stops a confident model from emptying an account.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..contracts.market import MarketSnapshot
from ..contracts.signals import Consensus, Direction, Regime, RiskState

__all__ = ["AccountState", "GateResult", "evaluate_gates"]


@dataclass(frozen=True, slots=True)
class AccountState:
    """What the Node edge knows about the live account, passed in per request.

    Every field defaults to a safe value. Missing account data must never
    silently disable a gate, so `known` records whether real figures arrived.
    """

    balance: float = 0.0
    daily_pnl_pct: float = 0.0
    drawdown_pct: float = 0.0
    consecutive_losses: int = 0
    trades_today: int = 0
    open_positions: int = 0
    known: bool = False


@dataclass(slots=True)
class GateResult:
    passed: bool
    risk_state: RiskState
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "passed": self.passed,
            "riskState": self.risk_state.value,
            "reasons": self.reasons,
            "warnings": self.warnings,
        }


def evaluate_gates(
    *,
    snapshot: MarketSnapshot,
    consensus: Consensus,
    regime: Regime,
    account: AccountState,
    max_daily_loss_pct: float,
    max_drawdown_pct: float,
    max_consec_loss: int,
    max_trades_per_day: int,
    min_agents: int,
    min_agreement: float = 0.55,
    max_price_age_ms: int = 90_000,
    max_failed_agents: int = 2,
) -> GateResult:
    """Run every gate. Blocking reasons accumulate — all are reported."""
    blocks: list[str] = []
    warnings: list[str] = []

    # ---- data integrity. Never analyse on stale or thin data. -----------
    # Freshness is measured against the last real tick when the engine
    # supplies one: a just-opened M15 bar is fresh even though its open time
    # is up to one bar-length old. Bar-open age remains the fallback.
    primary = snapshot.primary()
    if snapshot.last_tick_ms is not None:
        age = max(0, snapshot.received_at - snapshot.last_tick_ms)
    else:
        age = primary.age_ms(snapshot.received_at)
    if age > max_price_age_ms:
        blocks.append(
            f"price data is {age / 1000:.0f}s old (limit {max_price_age_ms / 1000:.0f}s)"
        )

    if consensus.failed > max_failed_agents:
        blocks.append(
            f"{consensus.failed} agents failed this run — pipeline is degraded"
        )
    elif consensus.failed > 0:
        warnings.append(f"{consensus.failed} agent(s) failed but the run continued")

    # ---- consensus quality ------------------------------------------------
    if consensus.direction is Direction.FLAT:
        blocks.append("agents did not agree on a direction")
    if consensus.participating < min_agents:
        blocks.append(
            f"only {consensus.participating} agents reported, need {min_agents}"
        )
    if consensus.direction is not Direction.FLAT and consensus.agreement < min_agreement:
        blocks.append(
            f"agent agreement {consensus.agreement:.0%} is below the {min_agreement:.0%} floor"
        )

    # ---- account protection. These block regardless of signal quality. -----
    if account.known:
        if account.daily_pnl_pct <= -abs(max_daily_loss_pct):
            blocks.append(
                f"daily loss limit hit ({account.daily_pnl_pct:.2f}% vs "
                f"{-abs(max_daily_loss_pct):.2f}%)"
            )
        if account.drawdown_pct >= abs(max_drawdown_pct):
            blocks.append(
                f"drawdown {account.drawdown_pct:.2f}% at or past the "
                f"{max_drawdown_pct:.2f}% ceiling"
            )
        if account.consecutive_losses >= max_consec_loss:
            blocks.append(
                f"{account.consecutive_losses} losses in a row — cooling off"
            )
        if account.trades_today >= max_trades_per_day:
            blocks.append(
                f"daily trade cap reached ({account.trades_today}/{max_trades_per_day})"
            )
    else:
        warnings.append(
            "no live account figures supplied — loss, drawdown and trade-count "
            "limits could not be checked"
        )

    # ---- regime caution ----------------------------------------------------
    if regime is Regime.VOLATILE:
        warnings.append("volatility is extreme — size down or stand aside")
    if regime is Regime.UNKNOWN:
        warnings.append("regime could not be determined from available history")

    if blocks:
        return GateResult(False, RiskState.BLOCKED, blocks, warnings)
    if warnings:
        return GateResult(True, RiskState.ELEVATED, [], warnings)
    return GateResult(True, RiskState.ACCEPTABLE, [], [])
