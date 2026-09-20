"""Alert dispatch — Telegram + VAPID web push.

Port of Node `alert-dispatcher.js` / `web-push.js` / `web-push-store.js`.
Every send is logged; failures are surfaced, never swallowed. Telegram
messages are plain-text, aligned with the old bot's formatting rules.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from ..config import Settings
from .db import Database

log = logging.getLogger(__name__)

SIGNAL_EMOJI = {"BUY": "\u25b2", "SELL": "\u25bc", "LONG": "\u25b2", "SHORT": "\u25bc", "WAIT": "\u2022"}


class AlertDispatcher:
    def __init__(self, settings: Settings, db: Database) -> None:
        self.cfg = settings
        self.db = db

    # ------------------------------------------------------------ telegram
    def _chat_ids(self) -> list[str]:
        configured = [c.strip() for c in self.cfg.TELEGRAM_CHAT_IDS.split(",") if c.strip()]
        if configured:
            return configured
        return self.db.get_subscriber_chat_ids()

    async def send_telegram(self, text: str, chat_ids: list[str] | None = None) -> dict[str, Any]:
        token = self.cfg.TELEGRAM_BOT_TOKEN
        if not token:
            return {"sent": 0, "reason": "TELEGRAM_BOT_TOKEN not configured"}
        ids = chat_ids if chat_ids is not None else self._chat_ids()
        sent = 0
        async with httpx.AsyncClient(timeout=10) as client:
            for chat_id in ids:
                try:
                    r = await client.post(
                        f"https://api.telegram.org/bot{token}/sendMessage",
                        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True},
                    )
                    if r.status_code == 200:
                        sent += 1
                    else:
                        log.warning("telegram send failed chat=%s status=%s", chat_id, r.status_code)
                except Exception:
                    log.exception("telegram send error chat=%s", chat_id)
        return {"sent": sent, "total": len(ids)}

    def format_signal(self, sig: dict[str, Any]) -> str:
        emoji = SIGNAL_EMOJI.get(str(sig.get("action", "")).upper(), "\u2022")
        score = (sig.get("score") or {}).get("final")
        regime = (sig.get("regime") or {}).get("regime", "?")
        entry = sig.get("entry")
        sl = sig.get("stopLoss")
        targets = sig.get("targets") or []
        entry_s = entry.get("midPoint") if isinstance(entry, dict) else entry
        lines = [
            f"{emoji} <b>{sig.get('action')} {sig.get('symbol')}</b> ({sig.get('timeframe')})",
            f"Score: {score} | Regime: {regime}",
        ]
        if entry_s is not None:
            lines.append(f"Entry: {entry_s}")
        if sl is not None:
            sl_s = sl.get("price") if isinstance(sl, dict) else sl
            lines.append(f"SL: {sl_s}")
        for i, t in enumerate(targets[:3], 1):
            tp = t.get("price") if isinstance(t, dict) else t
            lines.append(f"TP{i}: {tp}")
        reasons = sig.get("reasons") or []
        if reasons:
            lines.append("".join(f"\u2022 {r}" for r in reasons[:3]))
        return "\n".join(lines)

    async def dispatch_signal(self, sig: dict[str, Any]) -> None:
        text = self.format_signal(sig)
        chat_ids = [self.cfg.GRADE_A_CHANNEL_ID] if (sig.get("score") or {}).get("grade") == "A" and self.cfg.GRADE_A_CHANNEL_ID else None
        result = await self.send_telegram(text, chat_ids)
        log.info("signal alert dispatched", extra={"symbol": sig.get("symbol"), "sent": result.get("sent")})

    # ------------------------------------------------------------ web push
    async def send_web_push(self, payload: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
        try:
            from pywebpush import WebPushException, webpush
        except ImportError:
            return {"sent": 0, "reason": "web-push not installed (optional dependency)"}
        if not self.cfg.WEB_PUSH_PUBLIC_KEY or not self.cfg.WEB_PUSH_PRIVATE_KEY:
            return {"sent": 0, "reason": "WEB_PUSH keys not configured"}
        subs = self.db.get_push_subscriptions(user_id, limit=20 if user_id else 500)
        body = {
            "title": "OMNICEE",
            "body": payload.get("body", ""),
            "icon": "/icons/icon-192.png",
            "badge": "/icons/icon-192.png",
            "tag": "omnicee-signal",
            "url": payload.get("url", "/"),
            "timestamp": payload.get("timestamp"),
        }
        sent = 0
        loop = asyncio.get_running_loop()
        for row in subs:
            sub = row.get("subscription") or {}
            endpoint = row.get("endpoint", "")
            if not str(endpoint).startswith("https://"):
                continue
            try:
                await loop.run_in_executor(
                    None,
                    lambda s=sub: webpush(
                        subscription_info=s,
                        data=json_dumps(body),
                        vapid_private_key=self.cfg.WEB_PUSH_PRIVATE_KEY,
                        vapid_claims={"sub": self.cfg.WEB_PUSH_SUBJECT or "mailto:ops@omnicee.app"},
                        ttl=300,
                    ),
                )
                sent += 1
            except WebPushException as exc:
                status = getattr(exc.response, "status_code", None) if hasattr(exc, "response") else None
                if status in (404, 410):
                    self.db.remove_push_subscription(row.get("userId", ""), endpoint)
                else:
                    log.warning("web push failed: %s", exc)
            except Exception:
                log.exception("web push error")
        return {"sent": sent}


def json_dumps(obj: Any) -> str:
    import json
    return json.dumps(obj)
