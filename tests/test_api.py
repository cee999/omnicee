
import pytest
from fastapi.testclient import TestClient

from api.app import app
from config import reset_settings_cache


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


# --------------------------------------------------------------------- auth
# Login is email-OTP only now — no desk password. These lock in the route
# consolidation: exactly one path per action, the old bare aliases gone,
# and the config/passwordRequired probe removed. `client` doesn't wire up
# a real auth service (NODE_ENV=test skips DB/backend startup entirely —
# see api/app.py lifespan), so tests that need `request.app.state.auth`
# attach a minimal AuthService with db=None; only inputs that never reach
# the db (invalid email, tokenless logout) are exercised, so that's safe.

@pytest.fixture
def authed_client(client):
    from services.auth import AuthService
    client.app.state.auth = AuthService(client.app.state.settings, None)
    return client


def test_password_field_is_ignored_not_required(authed_client):
    r = authed_client.post("/api/auth/email/request", json={"email": "not-an-email"})
    assert r.status_code == 200
    assert r.json() == {"ok": False, "error": "invalid email"}


def test_logout_lives_at_the_path_the_frontend_calls(authed_client):
    r = authed_client.post("/api/auth/email/logout", json={})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


@pytest.mark.parametrize("path", [
    "/api/auth/email",          # pre-consolidation alias for /email/request
    "/api/auth/verify",         # pre-consolidation alias for /email/verify
    "/api/auth/logout",         # frontend never called this one; /email/logout did
    "/api/auth/email/config",   # passwordRequired probe, no longer exists
])
def test_retired_auth_aliases_are_gone(client, path):
    r = client.post(path, json={})
    # 404 when running API-only; 405 when webapp-react/dist is present, since
    # the SPA static mount then catches the unmatched path and rejects POST.
    # Either way, no auth route is answering it anymore.
    assert r.status_code in (404, 405)
