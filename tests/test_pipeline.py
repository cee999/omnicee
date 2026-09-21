import asyncio

import numpy as np

from config import Settings
from contracts.signals import Direction, SignalState
from ensemble.calibration import Calibrator
from pipeline import PipelineDeps, analyse
from risk.gates import AccountState


def _deps(**overrides):
    cfg = Settings(NODE_ENV="test", **overrides)
    return PipelineDeps(settings=cfg, calibrator=Calibrator(min_samples=80))


def run(snap, deps=None, account=None):
    return asyncio.run(analyse(snap, deps or _deps(), account=account))


def test_returns_a_result_even_when_nothing_fires(snapshot):
    res = run(snapshot(kind="range"))
    assert res.symbol == "EURUSD"
    assert res.consensus is not None
    assert res.total_latency_ms >= 0
    # Silence is never the output: either a signal or stated reasons.
    assert res.signal is not None or res.blocked_reasons


def test_stage_timings_are_measured_not_invented(snapshot):
    res = run(snapshot(kind="trend"))
    assert "regime" in res.stage_timings_ms and "agents" in res.stage_timings_ms
    assert all(v >= 0 for v in res.stage_timings_ms.values())
    assert sum(res.stage_timings_ms.values()) <= res.total_latency_ms + 5


def test_stale_data_is_blocked_not_analysed(snapshot):
    snap = snapshot(kind="trend")
    stale = snap.model_copy(update={"received_at": snap.received_at + 10 * 60 * 1000})
    res = run(stale)
    assert res.signal is None
    assert any("old" in r for r in res.blocked_reasons)


def test_daily_loss_limit_blocks_regardless_of_signal(snapshot):
    blown = AccountState(balance=10_000, daily_pnl_pct=-9.0, known=True)
    res = run(snapshot(kind="trend"), account=blown)
    assert res.signal is None
    assert any("daily loss limit" in r for r in res.blocked_reasons)


def test_drawdown_ceiling_blocks(snapshot):
    res = run(snapshot(kind="trend"),
              account=AccountState(balance=10_000, drawdown_pct=25.0, known=True))
    assert res.signal is None
    assert any("drawdown" in r for r in res.blocked_reasons)


def test_consecutive_losses_block(snapshot):
    res = run(snapshot(kind="trend"),
              account=AccountState(balance=10_000, consecutive_losses=9, known=True))
    assert res.signal is None
    assert any("losses in a row" in r for r in res.blocked_reasons)


def test_confidence_is_null_until_calibrated(snapshot):
    res = run(snapshot(kind="trend"), account=AccountState(balance=10_000, known=True))
    if res.signal is not None:
        assert res.signal.confidence is None
        assert res.signal.state is SignalState.CANDIDATE
        assert any("confidence not shown" in r for r in res.signal.rationale)


def test_calibrated_confidence_appears_once_fitted(snapshot):
    deps = _deps()
    rng = np.random.default_rng(0)
    s = rng.uniform(-1, 1, 400)
    p = 1 / (1 + np.exp(-3 * s))
    deps.calibrator.fit(s, (rng.uniform(size=400) < p).astype(int))
    res = run(snapshot(kind="trend"), deps=deps,
              account=AccountState(balance=10_000, known=True))
    if res.signal is not None:
        assert res.signal.confidence is not None
        assert 0.0 <= res.signal.confidence <= 1.0
        assert res.signal.confidence_samples == 400


def test_levels_are_directionally_coherent(snapshot):
    for kind in ("trend", "down"):
        res = run(snapshot(kind=kind), account=AccountState(balance=10_000, known=True))
        if res.signal and res.signal.levels:
            lv, d = res.signal.levels, res.signal.direction
            if d is Direction.LONG:
                assert lv.stop_loss < lv.entry < lv.take_profit
            elif d is Direction.SHORT:
                assert lv.take_profit < lv.entry < lv.stop_loss
            assert lv.risk_reward > 0


def test_unknown_account_warns_but_does_not_silently_pass(snapshot):
    res = run(snapshot(kind="trend"))
    gates = res.data_quality.get("gates", {})
    assert any("no live account figures" in w for w in gates.get("warnings", []))


def test_pipeline_never_raises_on_degenerate_input(snapshot):
    snap = snapshot(kind="trend", n=250)
    tiny = snap.model_copy(update={"series": {"M15": snap.series["M15"].tail(5)}})
    res = run(tiny)
    assert res.signal is None and res.blocked_reasons
