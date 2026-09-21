"""The analysis pipeline.

One entry point, `analyse`, runs the full chain for one symbol and returns an
AnalysisResult. The order is fixed and each stage is timed, so the UI's
pipeline view shows measured latency rather than an animation.

    market data -> regime -> agents -> consensus -> risk gates
                -> levels -> calibration -> sizing -> signal

Two rules govern the whole chain:

  1. A blocked signal is still returned, with its reasons. Silence is the
     worst possible output for a trading system — "nothing fired" and "the
     pipeline crashed" must never look the same.
  2. Nothing is fabricated. If confidence cannot be calibrated, it is null.
     If the account is unknown, sizing says so. If data is stale, the gate
     blocks rather than analysing an old price.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any

import numpy as np

from agents.base import AgentContext, run_agents
from agents.registry import build_agents
from config import Settings
from contracts.market import MarketSnapshot
from contracts.signals import (
    AnalysisResult,
    Direction,
    Levels,
    Signal,
    SignalState,
)
from ensemble.calibration import Calibrator
from ensemble.voting import aggregate
from features.indicators import atr
from features.regime import classify_regime
from features.structure import analyse_structure
from risk.gates import AccountState, evaluate_gates
from risk.sizing import size_position

log = logging.getLogger(__name__)

__all__ = ["PipelineDeps", "analyse"]


@dataclass(slots=True)
class PipelineDeps:
    settings: Settings
    calibrator: Calibrator


class _Timer:
    def __init__(self) -> None:
        self.stages: dict[str, float] = {}
        self._start = time.perf_counter()
        self._mark = self._start

    def stage(self, name: str) -> None:
        now = time.perf_counter()
        self.stages[name] = round((now - self._mark) * 1000, 3)
        self._mark = now

    @property
    def total_ms(self) -> float:
        return round((time.perf_counter() - self._start) * 1000, 3)


def _build_levels(
    snapshot: MarketSnapshot, direction: Direction, atr_value: float
) -> tuple[Levels | None, list[str]]:
    """Structure-aware stop placement, ATR fallback.

    Preference order for the stop:
      1. just beyond the most recent opposing swing (where the trade is
         genuinely invalidated)
      2. a 1.5x ATR buffer, when no usable swing exists

    A target is then placed at 2R. Returning None is valid — a trade with no
    sane stop is a trade not worth taking.
    """
    if direction is Direction.FLAT or atr_value <= 0:
        return None, ["no direction or no volatility estimate"]

    s = snapshot.primary()
    entry = float(s.close[-1])
    if entry <= 0:
        return None, ["last close is not a usable price"]

    notes: list[str] = []
    ms = analyse_structure(s.open, s.high, s.low, s.close, s.time)
    buffer = atr_value * 0.25
    stop: float | None = None

    if direction is Direction.LONG and ms.last_swing_low is not None:
        candidate = ms.last_swing_low.price - buffer
        if candidate < entry:
            stop = candidate
            notes.append("stop placed under the last swing low")
    elif direction is Direction.SHORT and ms.last_swing_high is not None:
        candidate = ms.last_swing_high.price + buffer
        if candidate > entry:
            stop = candidate
            notes.append("stop placed above the last swing high")

    if stop is None:
        offset = atr_value * 1.5
        stop = entry - offset if direction is Direction.LONG else entry + offset
        notes.append("no usable swing nearby — stop set 1.5x ATR away")

    risk = abs(entry - stop)
    if risk <= 0 or risk / entry > 0.10:
        return None, ["stop distance is unusable (zero or more than 10% away)"]

    target = entry + 2.0 * risk if direction is Direction.LONG else entry - 2.0 * risk
    notes.append("target set at 2R")

    try:
        return Levels(entry=entry, stop_loss=stop, take_profit=target).validate_for(
            direction
        ), notes
    except ValueError as exc:
        return None, [f"level check failed: {exc}"]


async def analyse(
    snapshot: MarketSnapshot,
    deps: PipelineDeps,
    account: AccountState | None = None,
    request_id: str | None = None,
    external: dict[str, Any] | None = None,
) -> AnalysisResult:
    """Run the full analysis chain for one symbol."""
    rid = request_id or uuid.uuid4().hex[:12]
    cfg = deps.settings
    account = account or AccountState()
    timer = _Timer()

    primary = snapshot.primary()
    data_quality: dict[str, object] = {
        "bars": len(primary),
        "timeframe": primary.timeframe,
        "timeframesSupplied": sorted(snapshot.series.keys()),
        "priceAgeMs": primary.age_ms(snapshot.received_at),
        "source": snapshot.source,
    }

    # ---- stage 1: regime --------------------------------------------------
    regime_read = classify_regime(primary.high, primary.low, primary.close)
    timer.stage("regime")

    # ---- stage 2: agents ---------------------------------------------------
    agents = build_agents()
    ctx = AgentContext(snapshot=snapshot, regime=regime_read, request_id=rid,
                       external=dict(external or {}))
    votes = await run_agents(agents, ctx, cfg.AGENT_TIMEOUT_MS)
    timer.stage("agents")

    # ---- stage 3: consensus -------------------------------------------------
    consensus = aggregate(votes, min_participation=1)
    timer.stage("consensus")

    # ---- stage 4: risk gates -------------------------------------------------
    gate = evaluate_gates(
        snapshot=snapshot,
        consensus=consensus,
        regime=regime_read.regime,
        account=account,
        max_daily_loss_pct=cfg.MAX_DAILY_LOSS_PCT,
        max_drawdown_pct=cfg.MAX_DRAWDOWN_PCT,
        max_consec_loss=cfg.MAX_CONSEC_LOSS,
        max_trades_per_day=cfg.MAX_TRADES_PER_DAY,
        min_agents=cfg.ENSEMBLE_MIN_AGENTS,
        max_price_age_ms=cfg.MAX_PRICE_AGE_MS,
    )
    timer.stage("risk_gates")

    data_quality["regime"] = regime_read.as_dict()
    data_quality["gates"] = gate.as_dict()

    if not gate.passed:
        timer.stage("finalise")
        return AnalysisResult(
            symbol=snapshot.symbol,
            signal=None,
            regime=regime_read.regime,
            consensus=consensus,
            blocked_reasons=gate.reasons,
            data_quality=data_quality,
            stage_timings_ms=timer.stages,
            total_latency_ms=timer.total_ms,
            request_id=rid,
        )

    # ---- stage 5: levels ------------------------------------------------------
    atr_series = atr(primary.high, primary.low, primary.close, 14)
    atr_value = float(atr_series[-1]) if np.isfinite(atr_series[-1]) else 0.0
    levels, level_notes = _build_levels(snapshot, consensus.direction, atr_value)
    timer.stage("levels")

    if levels is None:
        timer.stage("finalise")
        return AnalysisResult(
            symbol=snapshot.symbol,
            signal=None,
            regime=regime_read.regime,
            consensus=consensus,
            blocked_reasons=["could not place a sane stop: " + "; ".join(level_notes)],
            data_quality=data_quality,
            stage_timings_ms=timer.stages,
            total_latency_ms=timer.total_ms,
            request_id=rid,
        )

    # ---- stage 6: calibration ---------------------------------------------------
    probability = deps.calibrator.probability(consensus.raw_score)
    cal_report = deps.calibrator.report
    data_quality["calibration"] = cal_report.as_dict()
    timer.stage("calibration")

    # ---- stage 7: sizing ----------------------------------------------------------
    sizing = size_position(
        balance=account.balance or cfg.ACCOUNT_BALANCE,
        entry=levels.entry,
        stop_loss=levels.stop_loss,
        risk_pct=cfg.RISK_PCT_PER_TRADE,
        contract_size=snapshot.contract_size,
        win_prob=probability,
        reward_risk=levels.risk_reward,
        kelly_cap=cfg.KELLY_FRACTION_CAP,
    )
    data_quality["sizing"] = sizing.as_dict()
    timer.stage("sizing")

    # ---- stage 8: assemble ----------------------------------------------------------
    rationale: list[str] = list(regime_read.reasons[:2])
    for v in sorted(
        (v for v in votes if v.ok and v.direction is not Direction.FLAT),
        key=lambda v: abs(v.score) * v.weight,
        reverse=True,
    )[:3]:
        if v.evidence:
            rationale.append(f"{v.agent}: {v.evidence[0]}")
    rationale.extend(level_notes[:2])
    rationale.extend(sizing.notes[:2])
    if probability is None:
        rationale.append(f"confidence not shown — {cal_report.reason}")
    if sizing.units <= 0:
        rationale.append(
            "position size is zero — this is information, not a trade to take"
        )

    # A signal only reaches VALIDATED when a calibrated probability clears the
    # configured floor. Without calibration it stays a CANDIDATE: visible,
    # tracked, learnable from, but never presented as validated.
    if probability is None:
        state = SignalState.CANDIDATE
    elif probability >= cfg.ENSEMBLE_MIN_CONFIDENCE:
        state = SignalState.VALIDATED
    else:
        state = SignalState.CANDIDATE

    signal = Signal(
        symbol=snapshot.symbol,
        timeframe=primary.timeframe,
        direction=consensus.direction,
        state=state,
        levels=levels,
        confidence=probability,
        confidence_samples=cal_report.samples,
        raw_score=consensus.raw_score,
        regime=regime_read.regime,
        risk_state=gate.risk_state,
        consensus=consensus,
        blocked_reasons=[],
        rationale=rationale[:16],
        position_size=sizing.units or None,
        risk_amount=sizing.risk_amount or None,
        analysis_latency_ms=timer.total_ms,
    )
    timer.stage("finalise")

    log.info(
        "analysis complete",
        extra={
            "request_id": rid,
            "symbol": snapshot.symbol,
            "direction": signal.direction.value,
            "state": signal.state.value,
            "latency_ms": timer.total_ms,
        },
    )

    return AnalysisResult(
        symbol=snapshot.symbol,
        signal=signal,
        regime=regime_read.regime,
        consensus=consensus,
        blocked_reasons=[],
        data_quality=data_quality,
        stage_timings_ms=timer.stages,
        total_latency_ms=timer.total_ms,
        request_id=rid,
    )
