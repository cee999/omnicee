import asyncio

from agents.base import Agent, AgentContext, run_agents
from agents.registry import build_agents
from contracts.signals import AgentVote, Direction
from features.regime import classify_regime


class Exploding(Agent):
    name = "exploding"
    min_bars = 1

    def evaluate(self, ctx):
        raise RuntimeError("deliberate failure")


class Hanging(Agent):
    name = "hanging"
    min_bars = 1

    def evaluate(self, ctx):
        import time
        time.sleep(2.0)
        return AgentVote(agent=self.name, direction=Direction.LONG, score=1.0, confidence=1.0)


class Good(Agent):
    name = "good"
    min_bars = 1

    def evaluate(self, ctx):
        return AgentVote(agent=self.name, direction=Direction.LONG, score=0.5, confidence=0.5)


def _ctx(snapshot):
    s = snapshot().primary()
    return AgentContext(snapshot=snapshot(), regime=classify_regime(s.high, s.low, s.close))


def test_failing_agent_is_isolated(snapshot):
    votes = asyncio.run(run_agents([Exploding(), Good()], _ctx(snapshot), 1000))
    assert len(votes) == 2
    bad = next(v for v in votes if v.agent == "exploding")
    assert bad.error and bad.direction is Direction.FLAT and bad.score == 0.0
    good = next(v for v in votes if v.agent == "good")
    assert good.ok and good.score == 0.5


def test_hanging_agent_is_cut_off(snapshot):
    votes = asyncio.run(run_agents([Hanging(), Good()], _ctx(snapshot), 200))
    hung = next(v for v in votes if v.agent == "hanging")
    assert hung.error and "timeout" in hung.error
    assert next(v for v in votes if v.agent == "good").ok


def test_real_agents_return_one_vote_each(snapshot):
    agents = build_agents()
    votes = asyncio.run(run_agents(agents, _ctx(snapshot), 3000))
    assert len(votes) == len(agents)
    assert {v.agent for v in votes} == {a.name for a in agents}
    assert all(-1.0 <= v.score <= 1.0 for v in votes)


def test_agent_refuses_on_thin_data(snapshot):
    snap = snapshot(n=250)
    thin = snap.model_copy(update={"series": {"M15": snap.series["M15"].tail(10)}})
    ctx = AgentContext(snapshot=thin, regime=classify_regime(
        thin.primary().high, thin.primary().low, thin.primary().close))
    votes = asyncio.run(run_agents(build_agents(), ctx, 2000))
    assert all(v.direction is Direction.FLAT for v in votes)
    assert all("bars" in " ".join(v.evidence).lower() for v in votes)
