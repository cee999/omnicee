
import pytest
from fastapi.testclient import TestClient

from omnicee.api.app import app
from omnicee.config import reset_settings_cache


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("BRAIN_SHARED_SECRET", "test-secret-value-at-least-24-chars")
    reset_settings_cache()
    with TestClient(app) as c:
        yield c
    reset_settings_cache()


HDR = {"x-brain-secret": "test-secret-value-at-least-24-chars"}


def test_health_is_open_and_honest(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["authRequired"] is True
    assert body["calibration"]["fitted"] is False
    assert "x-request-id" in r.headers


def test_analyze_requires_the_secret(client, snapshot):
    payload = {"snapshot": snapshot().model_dump(mode="json")}
    assert client.post("/v1/analyze", json=payload).status_code == 401
    assert client.post("/v1/analyze", json=payload,
                       headers={"x-brain-secret": "wrong"}).status_code == 401


def test_analyze_round_trip(client, snapshot):
    payload = {
        "snapshot": snapshot(kind="trend").model_dump(mode="json"),
        "account": {"balance": 10000, "daily_pnl_pct": 0.0},
    }
    r = client.post("/v1/analyze", json=payload, headers=HDR)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["symbol"] == "EURUSD"
    assert "stage_timings_ms" in body or "stageTimingsMs" in body
    assert body["signal"] is not None or body["blocked_reasons"]


def test_malformed_candles_are_rejected_at_the_boundary(client):
    bad = {
        "snapshot": {
            "symbol": "EURUSD",
            "series": {"M15": {"symbol": "EURUSD", "timeframe": "M15", "candles": [
                {"time": 1, "open": 1.0, "high": 0.5, "low": 2.0, "close": 1.0}]}},
        }
    }
    assert client.post("/v1/analyze", json=bad, headers=HDR).status_code == 422


def test_calibration_fit_endpoint(client):
    import numpy as np
    rng = np.random.default_rng(3)
    s = rng.uniform(-1, 1, 300)
    y = (rng.uniform(size=300) < 1 / (1 + np.exp(-3 * s))).astype(int)
    r = client.post("/v1/calibration/fit",
                    json={"scores": s.tolist(), "wins": y.tolist()}, headers=HDR)
    assert r.status_code == 200
    assert r.json()["fitted"] is True
    assert client.get("/health").json()["calibration"]["fitted"] is True


def test_mismatched_calibration_lengths_rejected(client):
    r = client.post("/v1/calibration/fit",
                    json={"scores": [0.1, 0.2], "wins": [1]}, headers=HDR)
    assert r.status_code == 422


def test_agents_endpoint_lists_the_registry(client):
    r = client.get("/v1/agents", headers=HDR)
    assert r.status_code == 200
    names = {a["name"] for a in r.json()}
    assert {"smc", "mtf", "momentum"} <= names
