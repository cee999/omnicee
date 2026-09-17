"""Agent framework.

Every analytical agent is a small, independent unit that looks at one
snapshot and returns one vote. The framework guarantees three properties that
the calling pipeline depends on:

  isolation   an agent that raises returns a FLAT vote carrying the error.
              It never propagates an exception into the pipeline. One broken
              agent degrades the signal; it does not take the service down.
  bounded     every agent runs under a wall-clock timeout. A hung HTTP call
              or a pathological loop cannot stall analysis past its budget.
  auditable   latency and evidence are recorded on every vote, success or
              failure, so the pipeline view in the UI shows real numbers
              rather than invented progress.

Agents must be pure with respect to the snapshot: no I/O, no global state, no
mutation of the input. That is what makes them safe to run concurrently and
trivially testable.
"""

from __future__ import annotations

import abc
import asyncio
import logging
import time
from dataclasses import dataclass

from ..contracts.market import MarketSnapshot
from ..contracts.signals import AgentVote, Direction
from ..features.regime import RegimeRead

log = logging.getLogger(__name__)

__all__ = ["Agent", "AgentContext", "run_agents"]


@dataclass(frozen=True, slots=True)
class AgentContext:
    """Everything an agent may read. Deliberately small and immutable."""

    snapshot: MarketSnapshot
    regime: RegimeRead
    request_id: str = ""


class Agent(abc.ABC):
    """Base class for all analytical agents."""

    #: stable identifier, persisted with every signal — do not rename casually
    name: str = "agent"

    #: baseline weight in the ensemble before regime adjustment
    base_weight: float = 1.0

    #: minimum bars on the primary timeframe before this agent will vote
    min_bars: int = 60

    @abc.abstractmethod
    def evaluate(self, ctx: AgentContext) -> AgentVote:
        """Return this agent's vote. May raise; the runner catches it."""

    def weight_for_regime(self, regime: RegimeRead) -> float:
        """Override to up- or down-weight this agent per regime."""
        return self.base_weight

    # ---- framework internals ------------------------------------------
    def _flat(self, reason: str, *, error: str | None = None, latency: float = 0.0) -> AgentVote:
        return AgentVote(
            agent=self.name,
            direction=Direction.FLAT,
            score=0.0,
            confidence=0.0,
            weight=0.0 if error else self.base_weight,
            evidence=[reason],
            latency_ms=latency,
            error=error,
        )

    async def run(self, ctx: AgentContext, timeout_ms: int) -> AgentVote:
        started = time.perf_counter()

        primary = ctx.snapshot.primary()
        if len(primary) < self.min_bars:
            return self._flat(
                f"needs {self.min_bars} bars, has {len(primary)}",
                latency=(time.perf_counter() - started) * 1000,
            )

        try:
            vote = await asyncio.wait_for(
                asyncio.to_thread(self.evaluate, ctx), timeout=timeout_ms / 1000
            )
        except TimeoutError:
            elapsed = (time.perf_counter() - started) * 1000
            log.warning(
                "agent timed out",
                extra={"agent": self.name, "timeout_ms": timeout_ms, "request_id": ctx.request_id},
            )
            return self._flat(
                "timed out", error=f"timeout after {timeout_ms}ms", latency=elapsed
            )
        except Exception as exc:
            elapsed = (time.perf_counter() - started) * 1000
            log.exception(
                "agent raised",
                extra={"agent": self.name, "request_id": ctx.request_id},
            )
            return self._flat(
                "internal error",
                error=f"{type(exc).__name__}: {exc}"[:200],
                latency=elapsed,
            )

        elapsed = (time.perf_counter() - started) * 1000
        return vote.model_copy(
            update={
                "latency_ms": round(elapsed, 3),
                "weight": self.weight_for_regime(ctx.regime),
            }
        )


async def run_agents(
    agents: list[Agent], ctx: AgentContext, timeout_ms: int
) -> list[AgentVote]:
    """Run every agent concurrently. Always returns one vote per agent."""
    if not agents:
        return []
    results = await asyncio.gather(
        *(a.run(ctx, timeout_ms) for a in agents), return_exceptions=True
    )
    votes: list[AgentVote] = []
    for agent, result in zip(agents, results, strict=True):
        if isinstance(result, BaseException):
            # Defence in depth: Agent.run already catches, so reaching here
            # means the framework itself failed. Still never propagate.
            log.error(
                "agent runner failed outside the guard",
                extra={"agent": agent.name, "error": repr(result)},
            )
            votes.append(agent._flat("runner failure", error=repr(result)[:200]))
        else:
            votes.append(result)
    return votes
