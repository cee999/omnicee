"""Signal and agent-vote contracts.

A signal is a first-class object with an explicit lifecycle. The states are
closed enums, not free strings, so the frontend and backend cannot drift.

Nothing here promises an outcome. `confidence` is a calibrated probability
estimate with a stated sample size behind it, and it is allowed to be None
when there is not enough history to calibrate honestly.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator


class Direction(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"
    FLAT = "FLAT"


class SignalState(str, Enum):
    CANDIDATE = "candidate"
    VALIDATED = "validated"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTED = "executed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class RiskState(str, Enum):
    ACCEPTABLE = "ACCEPTABLE"
    ELEVATED = "ELEVATED"
    BLOCKED = "BLOCKED"


class Regime(str, Enum):
    TRENDING = "TRENDING"
    RANGING = "RANGING"
    VOLATILE = "VOLATILE"
    COMPRESSED = "COMPRESSED"
    UNKNOWN = "UNKNOWN"


class AgentVote(BaseModel):
    """One agent's opinion, with everything needed to audit it later.

    `evidence` holds structured, human-readable reasons. It is deliberately
    plain strings, not internal reasoning traces.
    """

    model_config = ConfigDict(frozen=True)

    agent: str = Field(..., min_length=1, max_length=48)
    direction: Direction
    score: float = Field(
        ..., ge=-1.0, le=1.0, description="Signed conviction: -1 max short, +1 max long"
    )
    confidence: float = Field(
        ..., ge=0.0, le=1.0, description="How sure the agent is of its own read"
    )
    weight: float = Field(default=1.0, ge=0.0, le=10.0)
    evidence: list[str] = Field(default_factory=list, max_length=12)
    latency_ms: float = Field(default=0.0, ge=0.0)
    error: str | None = Field(
        default=None, description="Set when the agent failed; score is then 0"
    )

    @model_validator(mode="after")
    def _failed_agents_are_neutral(self) -> AgentVote:
        if self.error and (self.score != 0.0 or self.direction is not Direction.FLAT):
            raise ValueError("a failed agent must vote FLAT with score 0")
        return self

    @property
    def ok(self) -> bool:
        return self.error is None


class Levels(BaseModel):
    """Entry / stop / target. Validated for directional coherence."""

    model_config = ConfigDict(frozen=True)

    entry: float = Field(..., gt=0)
    stop_loss: float = Field(..., gt=0)
    take_profit: float = Field(..., gt=0)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def risk_reward(self) -> float:
        risk = abs(self.entry - self.stop_loss)
        if risk <= 0:
            return 0.0
        return round(abs(self.take_profit - self.entry) / risk, 3)

    def validate_for(self, direction: Direction) -> Levels:
        if direction is Direction.LONG:
            if self.stop_loss >= self.entry:
                raise ValueError("long stop must sit below entry")
            if self.take_profit <= self.entry:
                raise ValueError("long target must sit above entry")
        elif direction is Direction.SHORT:
            if self.stop_loss <= self.entry:
                raise ValueError("short stop must sit above entry")
            if self.take_profit >= self.entry:
                raise ValueError("short target must sit below entry")
        return self


class Consensus(BaseModel):
    """Aggregate of all agent votes for one analysis."""

    model_config = ConfigDict(frozen=True)

    direction: Direction
    raw_score: float = Field(..., ge=-1.0, le=1.0)
    agreement: float = Field(
        ..., ge=0.0, le=1.0, description="Share of participating weight that agreed"
    )
    participating: int = Field(..., ge=0)
    failed: int = Field(default=0, ge=0)
    votes: list[AgentVote] = Field(default_factory=list)


class Signal(BaseModel):
    """The primary output of the brain."""

    signal_id: str = Field(default="")
    symbol: str = Field(..., min_length=1, max_length=24)
    timeframe: str = Field(..., min_length=1, max_length=8)
    direction: Direction
    state: SignalState = SignalState.CANDIDATE

    levels: Levels | None = None

    confidence: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Calibrated probability. None means not enough history to claim one.",
    )
    confidence_samples: int = Field(
        default=0, ge=0, description="Outcomes the calibration was fitted on"
    )
    raw_score: float = Field(default=0.0, ge=-1.0, le=1.0)

    regime: Regime = Regime.UNKNOWN
    risk_state: RiskState = RiskState.ACCEPTABLE
    strategy: str = Field(default="ensemble", max_length=64)

    consensus: Consensus | None = None
    blocked_reasons: list[str] = Field(default_factory=list)
    rationale: list[str] = Field(default_factory=list, max_length=16)

    position_size: float | None = Field(default=None, ge=0.0)
    risk_amount: float | None = Field(default=None, ge=0.0)

    created_at: int = Field(
        default_factory=lambda: int(datetime.now(UTC).timestamp() * 1000)
    )
    expires_at: int | None = None
    analysis_latency_ms: float = Field(default=0.0, ge=0.0)
    engine_version: str = Field(default="py-1")

    @model_validator(mode="after")
    def _coherent(self) -> Signal:
        if not self.signal_id:
            seed = f"{self.symbol}|{self.timeframe}|{self.direction.value}|{self.created_at}"
            object.__setattr__(
                self, "signal_id", hashlib.sha1(seed.encode()).hexdigest()[:16]
            )
        if self.levels is not None and self.direction is not Direction.FLAT:
            self.levels.validate_for(self.direction)
        if self.state is SignalState.REJECTED and not self.blocked_reasons:
            raise ValueError("a rejected signal must carry at least one reason")
        if self.expires_at is not None and self.expires_at <= self.created_at:
            raise ValueError("expires_at must be after created_at")
        return self

    @property
    def is_actionable(self) -> bool:
        return (
            self.state in (SignalState.VALIDATED, SignalState.APPROVED)
            and self.direction is not Direction.FLAT
            and self.levels is not None
            and self.risk_state is not RiskState.BLOCKED
        )


class AnalysisResult(BaseModel):
    """Full envelope returned by POST /v1/analyze.

    Always returns 200 with a body, even when no signal fired. `signal` is
    None when there is nothing to act on, and `stage_timings` gives the UI the
    pipeline view it needs without the brain fabricating progress.
    """

    symbol: str
    signal: Signal | None = None
    regime: Regime = Regime.UNKNOWN
    consensus: Consensus | None = None
    blocked_reasons: list[str] = Field(default_factory=list)
    data_quality: dict[str, object] = Field(default_factory=dict)
    stage_timings_ms: dict[str, float] = Field(default_factory=dict)
    total_latency_ms: float = 0.0
    request_id: str = ""
    generated_at: int = Field(
        default_factory=lambda: int(datetime.now(UTC).timestamp() * 1000)
    )


__all__ = [
    "AgentVote",
    "AnalysisResult",
    "Consensus",
    "Direction",
    "Levels",
    "Regime",
    "RiskState",
    "Signal",
    "SignalState",
]
