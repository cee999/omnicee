"""GET /api/system-status end to end through the real app."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.app import app
from config import reset_settings_cache

TOKEN = "status-token"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("APP_ACCESS_TOKEN", TOKEN)
    reset_settings_cache()
    with TestClient(app) as c:
        yield c
    reset_settings_cache()


def test_status_requires_auth(client):
    assert client.get("/api/system-status").status_code == 401


def test_status_reports_engine_disabled_honestly(client):
    body = client.get("/api/system-status", headers={"x-app-token": TOKEN}).json()
    assert body["status"] == "degraded"                       # warnings, nothing critical
    assert body["engine"]["enabled"] is False
    assert body["engine"]["running"] is False
    assert body["engine"]["lastCycleMs"] is None             # unknown, not 0
    assert body["feeds"]["total"] is None
    assert body["persistence"]["connected"] is None          # Mongo not configured in test
    assert any("DISABLE_ENGINE" in w for w in body["issues"]["warnings"])
    assert body["issues"]["critical"] == []
    assert "status" in body["startup"] or "passed" in body["startup"]


def test_status_never_blocks_on_repeated_polling(client):
    h = {"x-app-token": TOKEN}
    for _ in range(5):
        assert client.get("/api/system-status", headers=h).status_code == 200
