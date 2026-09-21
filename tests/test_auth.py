"""AuthService OTP tests — failed delivery must never be reported as success."""

from __future__ import annotations

from datetime import datetime, timedelta

import services.auth as services_mod
from config import Settings
from services.auth import AuthService


class _StubDB:
    """In-memory stand-in for the Mongo-backed store."""

    def __init__(self) -> None:
        self.otps: dict[str, dict] = {}
        self.sessions: dict[str, dict] = {}
        self.email_users: list[str] = []

    def save_otp(self, email: str, code_hash: str, ttl_minutes: int = 10) -> None:
        self.otps[email] = {
            "codeHash": code_hash,
            "attempts": 0,
            "expiresAt": datetime.now() + timedelta(minutes=ttl_minutes),
        }

    def get_otp(self, email: str) -> dict | None:
        return self.otps.get(email)

    def increment_otp_attempts(self, email: str) -> None:
        row = self.otps.get(email)
        if row is not None:
            row["attempts"] = row.get("attempts", 0) + 1

    def delete_otp(self, email: str) -> None:
        self.otps.pop(email, None)

    def save_session(self, token: str, email: str, ttl_days: int = 30) -> None:
        self.sessions[token] = {"token": token, "email": email, "expiresAt": datetime.now() + timedelta(days=ttl_days)}

    def get_session(self, token: str) -> dict | None:
        row = self.sessions.get(token)
        if row and row["expiresAt"] > datetime.now():
            return row
        return None

    def delete_session(self, token: str) -> None:
        self.sessions.pop(token, None)

    def upsert_email_user(self, email: str) -> None:
        if email not in self.email_users:
            self.email_users.append(email)


class _FakeResponse:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


def _service(monkeypatch, status_codes, brevo_key="xkeysib-x", allow_dev=False):
    codes = iter(status_codes) if isinstance(status_codes, list) else iter([status_codes] * 10)
    calls: list[list] = []

    def _fake_post(url, **kwargs):
        calls.append([kwargs])
        return _FakeResponse(next(codes))

    if brevo_key:
        monkeypatch.setattr(services_mod.httpx, "post", _fake_post)
    cfg = Settings(
        NODE_ENV="test",
        BREVO_API_KEY=brevo_key,
        ALLOW_DEV_OTP=allow_dev,
        OTP_PEPPER="test-pepper",
    )
    return AuthService(cfg, _StubDB()), calls


def test_provider_failure_is_surfaced_not_hidden(monkeypatch):
    """Brevo rejects the request: the client must hear about it (HTTP 502), not 'code sent'."""
    service, _ = _service(monkeypatch, 400)
    out = service.request_otp("desk@example.com", "1.2.3.4")
    assert out == {"ok": False, "error": "email delivery failed", "status": 502}


def test_provider_success_is_reported(monkeypatch):
    service, _ = _service(monkeypatch, 201)
    out = service.request_otp("desk@example.com", "1.2.3.4")
    assert out["ok"] is True
    assert "devCode" not in out
    assert out["expiresInSec"] == 600


def test_dev_fallback_when_allowed(monkeypatch):
    """Rejection + ALLOW_DEV_OTP: fallback preserved, code surfaced on screen."""
    service, _ = _service(monkeypatch, 400, allow_dev=True)
    out = service.request_otp("desk@example.com", "1.2.3.4")
    assert out["ok"] is True
    assert len(out.get("devCode", "")) == 6


def test_dev_fallback_when_not_configured(monkeypatch):
    """No Brevo key: fallback works without calling the provider."""
    service, calls = _service(monkeypatch, None, brevo_key="")
    out = service.request_otp("desk@example.com", "1.2.3.4")
    assert out["ok"] is True
    assert len(out.get("devCode", "")) == 6
    assert calls == []


def test_cooldown_cooldown_blocks_immediate_retry(monkeypatch):
    service, _ = _service(monkeypatch, [201, 201])
    assert service.request_otp("desk@example.com", "1.2.3.4")["ok"] is True
    retry = service.request_otp("desk@example.com", "1.2.3.4")
    assert retry == {"ok": False, "error": "cooldown", "status": 429}


def test_wrong_code_never_verifies(monkeypatch):
    """Guard on the verify side: hash mismatch increments attempts and rejects."""
    service, _ = _service(monkeypatch, 201)
    assert service.request_otp("desk@example.com", "1.2.3.4")["ok"] is True
    out = service.verify_otp("desk@example.com", "000000")
    assert out == {"ok": False, "error": "wrong code", "status": 401}
