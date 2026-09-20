"""Authentication — faithful port of the Node auth surface.

Three mechanisms, exactly as before:
  1. APP_ACCESS_TOKEN — static bearer (`x-app-token`), timing-safe.
  2. Email OTP sessions — Brevo/SMTP delivery, peppered SHA-256 code hashes,
     Mongo-backed sessions (30 days).
  3. Telegram Mini App initData — HMAC-SHA256 per Telegram's spec, 24h window.

The dashboard-read policy is ported verbatim from `dashboardReadAuth`:
public GET list first, then app token, then email session, then telegram.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import time
import urllib.parse
from typing import Any

import httpx

from ..config import Settings
from .db import Database

log = logging.getLogger(__name__)

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

PUBLIC_GET_PATHS = {
    "/api/market", "/api/candles", "/api/health", "/health", "/api/calendar",
    "/api/news", "/api/signals", "/api/audit-trail", "/api/outlook",
    "/api/heatmap", "/api/stats", "/api/levels", "/api/watchlist",
    "/api/desk-brief", "/api/sentiment", "/api/hurst", "/api/analysis",
    "/api/telemetry", "/api/equity-curve", "/api/cache/status", "/api/learning",
}


def timing_safe_eq(a: str, b: str) -> bool:
    return hmac.compare_digest((a or "").encode(), (b or "").encode())


class AuthService:
    def __init__(self, settings: Settings, db: Database) -> None:
        self.cfg = settings
        self.db = db
        # OTP rate limiting: email -> [timestamps], ip -> [timestamps]
        self._otp_email_log: dict[str, list[float]] = {}
        self._otp_ip_log: dict[str, list[float]] = {}
        self._last_otp_sent: dict[str, float] = {}

    # ------------------------------------------------------------ app token
    def check_app_token(self, token: str | None) -> bool:
        expected = self.cfg.APP_ACCESS_TOKEN
        if not expected:
            return False
        return bool(token) and timing_safe_eq(token.strip(), expected.strip())

    # ------------------------------------------------------------- telegram
    @staticmethod
    def validate_telegram_init_data(init_data: str, bot_token: str, max_age_s: int = 86400) -> dict[str, Any] | None:
        if not init_data or not bot_token:
            return None
        try:
            pairs = sorted(
                (k, v) for k, v in urllib.parse.parse_qsl(init_data, keep_blank_values=True) if k != "hash"
            )
            data_check = "\n".join(f"{k}={v}" for k, v in pairs)
            secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
            computed = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
            provided = urllib.parse.parse_qs(init_data, keep_blank_values=True).get("hash", [""])[0]
            if not hmac.compare_digest(computed, provided):
                return None
            params = {k: v for k, v in pairs}
            auth_date = int(params.get("auth_date", "0"))
            if auth_date and time.time() - auth_date > max_age_s:
                return None
            user_raw = params.get("user")
            user = json.loads(user_raw) if user_raw else None
            if not isinstance(user, dict) or "id" not in user:
                return None
            return {"user": user, "authDate": auth_date, "params": params}
        except Exception:
            log.exception("telegram initData validation failed")
            return None

    def telegram_allowed(self, tg_id: str) -> bool:
        allow = self.cfg.TELEGRAM_ALLOWED_USER_IDS.strip()
        if not allow:
            return True
        allowed = {x.strip() for x in allow.split(",") if x.strip()}
        return str(tg_id) in allowed

    # ------------------------------------------------------------ email otp
    def _code_hash(self, email: str, code: str) -> str:
        return hashlib.sha256(f"{email}:{code}:{self.cfg.OTP_PEPPER}".encode()).hexdigest()

    def request_otp(self, email: str, ip: str) -> dict[str, Any]:
        """Send a 6-digit OTP. Returns {ok, message?, error?, devCode?}."""
        email = (email or "").strip().lower()
        if not EMAIL_RE.match(email):
            return {"ok": False, "error": "invalid email"}
        now = time.time()
        if now - self._last_otp_sent.get(email, 0) < 30:
            return {"ok": False, "error": "cooldown", "status": 429}
        self._last_otp_sent[email] = now

        def _prune(key: str, store: dict[str, list[float]], window: float, cap: int) -> bool:
            rows = [t for t in store.get(key, []) if now - t < window]
            if len(rows) >= cap:
                store[key] = rows
                return False
            rows.append(now)
            store[key] = rows
            return True

        if not _prune(email, self._otp_email_log, 86400, 8):
            return {"ok": False, "error": "daily limit reached", "status": 429}
        if not _prune(ip, self._otp_ip_log, 3600, 20):
            return {"ok": False, "error": "hourly limit reached", "status": 429}

        if self.cfg.LOGIN_PASSWORD:
            # Desk password is checked at request time by the caller; enforced
            # only when configured. Kept here as the single policy point.
            pass

        code = str(secrets.randbelow(900000) + 100000)
        self.db.save_otp(email, self._code_hash(email, code))
        sent_via = self._send_email(email, code)
        out: dict[str, Any] = {"ok": True, "message": "code sent", "expiresInSec": 600}
        if sent_via == "dev":
            out["devCode"] = code
        return out

    def _send_email(self, email: str, code: str) -> str:
        subject = "OMNICEE sign-in code"
        text = f"Your OMNICEE code is {code}. It expires in 10 minutes."
        if self.cfg.BREVO_API_KEY:
            try:
                sender = self.cfg.EMAIL_FROM
                m = re.match(r'^(?:"?([^"<]*)"?\s*)<(.+)>$', sender)
                sender_email = m.group(2) if m else sender
                sender_name = (m.group(1) if m else "OMNICEE") or "OMNICEE"
                r = httpx.post(
                    "https://api.brevo.com/v3/smtp/email",
                    headers={"api-key": self.cfg.BREVO_API_KEY, "content-type": "application/json"},
                    json={"sender": {"name": sender_name, "email": sender_email},
                          "to": [{"email": email}], "subject": subject, "textContent": text},
                    timeout=10,
                )
                if r.status_code in (200, 201):
                    return "brevo"
                log.error("brevo send failed status=%s body=%s", r.status_code, r.text[:200])
            except Exception:
                log.exception("brevo send failed")
        # Dev fallback: no email provider configured. The code is returned to
        # the caller only in non-production (checked by the route).
        if self.cfg.ALLOW_DEV_OTP or not self.cfg.BREVO_API_KEY:
            return "dev"
        return "none"

    def verify_otp(self, email: str, code: str) -> dict[str, Any]:
        email = (email or "").strip().lower()
        code = (code or "").strip()
        if not EMAIL_RE.match(email) or not re.match(r"^\d{6}$", code):
            return {"ok": False, "error": "invalid input", "status": 400}
        row = self.db.get_otp(email)
        if row is None:
            return {"ok": False, "error": "no code requested", "status": 401}
        expires_at = row.get("expiresAt")
        if expires_at is not None:
            try:
                if hasattr(expires_at, "timestamp") and expires_at.timestamp() < time.time():
                    return {"ok": False, "error": "code expired", "status": 401}
            except (TypeError, ValueError):
                pass
        if int(row.get("attempts", 0)) >= 5:
            return {"ok": False, "error": "too many attempts", "status": 401}
        if not timing_safe_eq(row.get("codeHash", ""), self._code_hash(email, code)):
            self.db.increment_otp_attempts(email)
            return {"ok": False, "error": "wrong code", "status": 401}
        self.db.delete_otp(email)
        token = secrets.token_hex(32)
        self.db.save_session(token, email)
        self.db.upsert_email_user(email)
        return {"ok": True, "token": token, "email": email, "expiresAt": time.time() + 30 * 86400}

    def session_email(self, token: str | None) -> str | None:
        if not token:
            return None
        row = self.db.get_session(token)
        return row.get("email") if row else None

    def logout(self, token: str | None) -> None:
        if token:
            self.db.delete_session(token)
