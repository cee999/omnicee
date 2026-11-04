"""Dashboard auth policy: what is open, what needs a credential, and that the
middleware actually enforces it. Fails-closed behaviour is the point."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.parse

import pytest
from fastapi.testclient import TestClient

from api.app import app
from config import Settings, reset_settings_cache
from services.auth import PUBLIC_GET_PATHS, AuthService
from tests.test_auth import _StubDB

BOT_TOKEN = "123456:TEST-BOT-TOKEN"
APP_TOKEN = "app-token-for-tests"


def _svc(**overrides) -> tuple[AuthService, _StubDB]:
    cfg = Settings(NODE_ENV="test", APP_ACCESS_TOKEN=APP_TOKEN, TELEGRAM_BOT_TOKEN=BOT_TOKEN,
                   **overrides)
    db = _StubDB()
    return AuthService(cfg, db), db  # type: ignore[arg-type]


def _telegram_init_data(user_id: int = 42, age_s: int = 0, token: str = BOT_TOKEN) -> str:
    fields = {"auth_date": str(int(time.time()) - age_s), "user": json.dumps({"id": user_id})}
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(fields)


# ----------------------------------------------------------- policy (pure)
@pytest.mark.parametrize("method,path,expected", [
    ("GET", "/api/market", False),            # public read
    ("HEAD", "/api/signals", False),
    ("GET", "/health", False),                # outside /api
    ("GET", "/", False),                      # static dashboard
    ("GET", "/v1/agents", False),             # has its own brain secret
    ("OPTIONS", "/api/outcomes", False),      # CORS preflight
    ("POST", "/api/auth/email/request", False),
    ("POST", "/api/auth/email/verify", False),
    ("GET", "/api/ea/signals", False),        # EA secret checked in the route
    ("POST", "/api/outcomes", True),          # mutation of learning data
    ("POST", "/api/alerts/test", True),       # fires real alerts
    ("GET", "/api/journal", True),            # not on the public list
    ("GET", "/api/system-status", True),
    ("POST", "/api/market", True),            # public path, but not a GET
    ("GET", "//api/journal", True),           # slash tricks must not dodge it
    ("GET", "/api/market/extra", True),       # unknown sub-path fails closed
])
def test_policy_matrix(method, path, expected):
    svc, _ = _svc()
    assert svc.requires_credentials(method, path) is expected


def test_public_reads_close_when_public_dashboard_read_is_off():
    svc, _ = _svc(PUBLIC_DASHBOARD_READ=False)
    for path in sorted(PUBLIC_GET_PATHS):
        if path.startswith("/api/"):
            assert svc.requires_credentials("GET", path) is True, path
    assert svc.requires_credentials("GET", "/health") is False  # liveness stays open


# ------------------------------------------------------------- credentials
def test_app_token_accepted_via_header_and_bearer():
    svc, _ = _svc()
    assert svc.has_valid_credentials({"x-app-token": APP_TOKEN})
    assert svc.has_valid_credentials({"authorization": f"Bearer {APP_TOKEN}"})
    assert not svc.has_valid_credentials({"x-app-token": "wrong"})
    assert not svc.has_valid_credentials({})


def test_no_app_token_configured_means_no_app_token_login():
    cfg = Settings(NODE_ENV="test", APP_ACCESS_TOKEN="")
    svc = AuthService(cfg, _StubDB())  # type: ignore[arg-type]
    assert not svc.has_valid_credentials({"x-app-token": ""})
    assert not svc.has_valid_credentials({"authorization": "Bearer "})


def test_email_session_accepted_and_logout_revokes_immediately():
    svc, db = _svc()
    db.save_session("sess-token", "a@b.co")
    headers = {"authorization": "Bearer sess-token", "x-session-token": "sess-token"}
    assert svc.has_valid_credentials(headers)
    svc.logout("sess-token")                      # must beat the 60 s cache
    assert not svc.has_valid_credentials(headers)


def test_session_lookups_are_cached():
    svc, db = _svc()
    db.save_session("t", "a@b.co")
    calls = []
    real = db.get_session
    db.get_session = lambda tok: (calls.append(tok), real(tok))[1]  # type: ignore[method-assign]
    for _ in range(5):
        assert svc.session_email("t") == "a@b.co"
    assert len(calls) == 1


def test_unknown_session_is_rejected_and_not_cached():
    svc, _ = _svc()
    assert not svc.has_valid_credentials({"x-session-token": "nope"})
    assert "nope" not in svc._session_cache


def test_valid_telegram_init_data_accepted():
    svc, _ = _svc()
    assert svc.has_valid_credentials({"x-telegram-init-data": _telegram_init_data()})


def test_forged_or_stale_telegram_init_data_rejected():
    svc, _ = _svc()
    assert not svc.has_valid_credentials(
        {"x-telegram-init-data": _telegram_init_data(token="999:OTHER-BOT")})
    assert not svc.has_valid_credentials(
        {"x-telegram-init-data": _telegram_init_data(age_s=2 * 86400)})


def test_telegram_allowlist_is_enforced():
    svc, _ = _svc(TELEGRAM_ALLOWED_USER_IDS="7")
    assert not svc.has_valid_credentials({"x-telegram-init-data": _telegram_init_data(user_id=42)})
    assert svc.has_valid_credentials({"x-telegram-init-data": _telegram_init_data(user_id=7)})


# ----------------------------------------------- middleware (integration)
@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("APP_ACCESS_TOKEN", APP_TOKEN)
    monkeypatch.setenv("BRAIN_SHARED_SECRET", "test-secret-value-at-least-24-chars")
    reset_settings_cache()
    with TestClient(app) as c:
        yield c
    reset_settings_cache()


def test_mutations_without_credentials_are_rejected(client):
    for method, path in [("POST", "/api/outcomes"), ("POST", "/api/alerts/test")]:
        r = client.request(method, path, json={})
        assert r.status_code == 401, path
        assert r.json()["error"] == "authentication required"
        assert r.json()["requestId"]
        assert "x-request-id" in r.headers          # 401s still carry a request id


def test_non_public_read_requires_credentials(client):
    assert client.get("/api/journal").status_code == 401
    assert client.get("/api/system-status").status_code == 401


def test_public_dashboard_read_still_open(client):
    assert client.get("/health").status_code == 200
    assert client.get("/api/health").status_code == 200


def test_login_flow_is_never_gated(client):
    r = client.post("/api/auth/email/request", json={"email": "not-an-email"})
    assert r.status_code != 401                      # reaches the handler (validates input)


def test_authenticated_request_passes_and_gets_security_headers(client):
    r = client.get("/api/system-status", headers={"x-app-token": APP_TOKEN})
    assert r.status_code == 200
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "x-frame-options" not in r.headers        # Telegram Mini App is an iframe
