"""Startup validator: reuses the app's Database, never opens its own."""

from __future__ import annotations

import asyncio

from config import Settings
from orchestrator.startup_validator import StartupValidator


class _Db:
    def __init__(self, ok: bool = True, delay: float = 0.0) -> None:
        self.ok, self.delay, self.calls = ok, delay, 0

    def health(self):
        import time
        self.calls += 1
        time.sleep(self.delay)
        return {"ok": self.ok, "enabled": True}


def run(settings: Settings, db=None):
    return asyncio.run(StartupValidator(settings, db).run_all_checks())


def test_clean_config_without_mongo_passes_with_warnings():
    r = run(Settings(NODE_ENV="test"))
    assert r["passed"] is True
    assert any("MongoDB is disabled" in w for w in r["warnings"])
    assert set(r) >= {"passed", "checksRun", "checksPassed", "checksTotal", "criticalIssues", "warnings"}


def test_uses_the_shared_database_instance():
    db = _Db(ok=True)
    r = run(Settings(NODE_ENV="test", MONGODB_URI="mongodb://example"), db)
    assert r["passed"] is True and db.calls == 1


def test_unreachable_database_is_a_critical_issue():
    r = run(Settings(NODE_ENV="test", MONGODB_URI="mongodb://example"), _Db(ok=False))
    assert r["passed"] is False
    assert "Database is configured but unreachable" in r["criticalIssues"]


def test_database_timeout_is_reported_not_raised(monkeypatch):
    import orchestrator.startup_validator as mod
    real = asyncio.wait_for
    monkeypatch.setattr(mod.asyncio, "wait_for", lambda aw, timeout: real(aw, 0.05))
    r = run(Settings(NODE_ENV="test", MONGODB_URI="mongodb://example"), _Db(delay=0.5))
    assert r["passed"] is False and any("timed out" in i for i in r["criticalIssues"])
