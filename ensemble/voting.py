"""Weighted consensus across agent votes.

The aggregate is a weight-weighted mean of signed scores, with two properties
that matter more than the arithmetic:

  failed agents are excluded, not counted as neutral. Counting a crashed
  agent as a FLAT vote silently drags consensus toward zero and makes a
  degraded system look merely indecisive. The count of failures is reported
  separately so the caller can refuse to act on a half-dead pipeline.

  agreement is measured on participating weight, not on headcount. Two
  heavyweight agents agreeing is stronger evidence than four lightweights
  splitting.
"""

from __future__ import annotations

from contracts.signals import AgentVote, Consensus, Direction

__all__ = ["aggregate"]


def aggregate(
    votes: list[AgentVote], *, min_participation: int = 1, deadband: float = 0.10
) -> Consensus:
    """Combine votes into a single directional consensus."""
    ok = [v for v in votes if v.ok]
    failed = len(votes) - len(ok)

    contributing = [v for v in ok if v.weight > 0]
    total_weight = sum(v.weight for v in contributing)

    if not contributing or total_weight <= 0 or len(ok) < min_participation:
        return Consensus(
            direction=Direction.FLAT,
            raw_score=0.0,
            agreement=0.0,
            participating=len(ok),
            failed=failed,
            votes=votes,
        )

    raw = sum(v.score * v.weight for v in contributing) / total_weight
    raw = max(-1.0, min(1.0, raw))

    if abs(raw) < deadband:
        direction = Direction.FLAT
    else:
        direction = Direction.LONG if raw > 0 else Direction.SHORT

    if direction is Direction.FLAT:
        agreement = 0.0
    else:
        want = 1.0 if direction is Direction.LONG else -1.0
        agreeing = sum(
            v.weight for v in contributing if v.score * want > 0
        )
        agreement = agreeing / total_weight

    return Consensus(
        direction=direction,
        raw_score=round(raw, 4),
        agreement=round(agreement, 4),
        participating=len(ok),
        failed=failed,
        votes=votes,
    )
