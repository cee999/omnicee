"""Agent registry.

Single place a new agent is registered. Adding an agent is one import and one
line here — nothing else in the pipeline changes. Keep names stable: they are
persisted on every historical signal and used to weight the learner.
"""

from __future__ import annotations

from .base import Agent
from .momentum import MomentumAgent
from .mtf import MTFAgent
from .smc import SMCAgent

__all__ = ["AGENT_CLASSES", "build_agents"]

AGENT_CLASSES: list[type[Agent]] = [
    SMCAgent,
    MTFAgent,
    MomentumAgent,
]


def build_agents(only: list[str] | None = None) -> list[Agent]:
    """Instantiate the registered agents, optionally filtered by name."""
    agents = [cls() for cls in AGENT_CLASSES]
    if only:
        wanted = {n.strip().lower() for n in only}
        agents = [a for a in agents if a.name.lower() in wanted]
    seen: set[str] = set()
    for a in agents:
        if a.name in seen:
            raise ValueError(f"duplicate agent name registered: {a.name}")
        seen.add(a.name)
    return agents
