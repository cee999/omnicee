"""MongoDB persistence — port of Node `db.js`.

Collection contracts are identical to the Node service so existing data
survives the migration:
  signals, telemetry, users, email_otps, sessions, market_snapshots,
  trade_outcomes, candle_history, web_push_subscriptions

Rules honoured here:
  * every failure is logged and surfaced (never swallowed silently)
  * /health must never block more than 2s on Mongo
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument

log = logging.getLogger(__name__)

MAX_STORED_CANDLES = 500


def _now() -> datetime:
    return datetime.now(UTC)


def _ttl_expiry(days: int) -> datetime:
    return _now() + timedelta(days=days)


class Database:
    def __init__(self, uri: str, db_name: str, max_pool: int = 5,
                 signal_ttl_days: int = 45, telemetry_ttl_days: int = 7,
                 disable_signals: bool = False) -> None:
        self._uri = (uri or "").strip()
        self._db_name = db_name or "omnicee"
        self._client: MongoClient | None = None
        self._connected = False
        self._retry_until = 0.0
        self._max_pool = max(1, max_pool)
        self.signal_ttl_days = signal_ttl_days
        self.telemetry_ttl_days = telemetry_ttl_days
        self.disable_signals = disable_signals

    # ------------------------------------------------------------------ core
    @property
    def enabled(self) -> bool:
        return bool(self._uri)

    def _db(self):
        if not self.enabled:
            return None
        if self._client is None:
            try:
                self._client = MongoClient(
                    self._uri,
                    maxPoolSize=self._max_pool,
                    serverSelectionTimeoutMS=8000,
                    retryWrites=True,
                    retryReads=True,
                )
                self._client.admin.command("ping")
                self._setup_indexes()
                self._connected = True
                log.info("mongo connected", extra={"db": self._db_name})
            except Exception:
                log.exception("mongo connect failed")
                self._client = None
                self._retry_until = time.time() + 15
                return None
        if time.time() < self._retry_until:
            return None
        return self._client[self._db_name]

    def _setup_indexes(self) -> None:
        db = self._client[self._db_name]
        plans: list[tuple[str, object, dict[str, Any]]] = [
            ("signals", [("timestamp", DESCENDING)], {}),
            ("signals", [("symbol", ASCENDING), ("timeframe", ASCENDING), ("timestamp", DESCENDING)], {}),
            ("signals", "expiresAt", {"expireAfterSeconds": 0}),
            ("telemetry", "expiresAt", {"expireAfterSeconds": 0}),
            ("users", "telegramId", {"unique": True}),
            ("users", "email", {"unique": True, "sparse": True}),
            ("email_otps", "expiresAt", {"expireAfterSeconds": 0}),
            ("sessions", "expiresAt", {"expireAfterSeconds": 0}),
            ("market_snapshots", "createdAt", {"expireAfterSeconds": 3 * 86400}),
            ("trade_outcomes", "signalId", {"unique": True, "sparse": True}),
            ("candle_history",
             [("source", ASCENDING), ("symbol", ASCENDING), ("timeframe", ASCENDING)],
             {"unique": True}),
        ]
        for coll_name, keys, opts in plans:
            try:
                db[coll_name].create_index(keys, **opts)
            except Exception:
                # Legacy (Node-era) databases hold some of these indexes under
                # different names (e.g. signal_lookup) — create_index then fails
                # with IndexOptionsConflict. Reuse the existing index instead of
                # killing the Mongo connection; one bad index must never take
                # persistence down.
                if not self._reuse_matching_index(db[coll_name], keys):
                    log.exception("index setup failed on %s", coll_name)

    @staticmethod
    def _reuse_matching_index(coll: Any, keys: object) -> bool:
        key_map = {keys: 1} if isinstance(keys, str) else dict(keys)  # type: ignore[arg-type]
        try:
            for idx in coll.list_indexes():
                if dict(idx.get("key", {})) == key_map:
                    log.warning(
                        "index on %s: reusing existing index named %s (created under a different name)",
                        coll.name, idx.get("name"),
                    )
                    return True
        except Exception:
            log.exception("list_indexes failed on %s", coll.name)
        return False

    def health(self) -> dict[str, Any]:
        if not self.enabled:
            return {"ok": True, "enabled": False, "db": None}
        start = time.time()
        try:
            db = self._db()
            if db is None:
                return {"ok": False, "enabled": True, "db": "retrying"}
            db.command("ping")
            return {"ok": True, "enabled": True, "db": self._db_name,
                    "latencyMs": round((time.time() - start) * 1000, 1)}
        except Exception as exc:
            log.warning("mongo health ping failed: %s", exc)
            return {"ok": False, "enabled": True, "db": "unreachable"}

    # -------------------------------------------------------------- signals
    def save_signal(self, doc: dict[str, Any]) -> dict[str, Any] | None:
        """Persist one signal. Only executable actions are stored."""
        if self.disable_signals:
            return None
        action = str(doc.get("action", "")).upper()
        if action not in ("BUY", "SELL", "LONG", "SHORT"):
            return None
        db = self._db()
        if db is None:
            return None
        now = _now()
        doc = dict(doc)
        doc.setdefault("createdAt", now)
        doc["expiresAt"] = _ttl_expiry(self.signal_ttl_days)
        doc["learningEligible"] = True
        try:
            db.signals.update_one(
                {"id": doc.get("id")}, {"$set": doc, "$setOnInsert": {"firstSeenAt": now}},
                upsert=True,
            )
            return doc
        except Exception:
            log.exception("save_signal failed")
            return None

    def get_signals(self, symbol: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        db = self._db()
        if db is None:
            return []
        q: dict[str, Any] = {"action": {"$in": ["BUY", "SELL", "LONG", "SHORT"]}}
        if symbol:
            q["symbol"] = symbol.upper()
        try:
            return list(db.signals.find(q, {"_id": 0}).sort("timestamp", DESCENDING).limit(max(1, min(200, limit))))
        except Exception:
            log.exception("get_signals failed")
            return []

    def save_telemetry(self, doc: dict[str, Any]) -> None:
        db = self._db()
        if db is None:
            return
        doc = dict(doc)
        doc["expiresAt"] = _ttl_expiry(self.telemetry_ttl_days)
        try:
            db.telemetry.insert_one(doc)
        except Exception:
            log.exception("save_telemetry failed")

    def get_telemetry(self, limit: int = 300) -> list[dict[str, Any]]:
        db = self._db()
        if db is None:
            return []
        try:
            return list(db.telemetry.find({}, {"_id": 0}).sort("timestamp", DESCENDING).limit(max(1, min(300, limit))))
        except Exception:
            log.exception("get_telemetry failed")
            return []

    # ---------------------------------------------------------------- users
    def upsert_telegram_user(self, user: dict[str, Any]) -> dict[str, Any] | None:
        db = self._db()
        if db is None or not user.get("id"):
            return None
        try:
            doc = db.users.find_one_and_update(
                {"telegramId": str(user["id"])},
                {"$set": {
                    "username": user.get("username"),
                    "firstName": user.get("first_name"),
                    "lastName": user.get("last_name"),
                    "languageCode": user.get("language_code"),
                    "lastSeenAt": _now(),
                }, "$setOnInsert": {"subscribed": True, "createdAt": _now()}},
                upsert=True, return_document=ReturnDocument.AFTER,
            )
            return doc
        except Exception:
            log.exception("upsert_telegram_user failed")
            return None

    def upsert_email_user(self, email: str) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.users.update_one(
                {"email": email},
                {"$set": {"lastSeenAt": _now(), "authProvider": "email"},
                 "$setOnInsert": {"telegramId": f"email:{email}", "subscribed": True, "createdAt": _now()}},
                upsert=True,
            )
        except Exception:
            log.exception("upsert_email_user failed")

    def get_subscriber_chat_ids(self) -> list[str]:
        db = self._db()
        if db is None:
            return []
        try:
            rows = db.users.find({"subscribed": {"$ne": False}, "telegramId": {"$exists": True}}, {"telegramId": 1})
            return [r["telegramId"] for r in rows if str(r.get("telegramId", "")).isdigit()]
        except Exception:
            log.exception("get_subscriber_chat_ids failed")
            return []

    # ----------------------------------------------------------------- otp
    def save_otp(self, email: str, code_hash: str, ttl_minutes: int = 10) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.email_otps.update_one(
                {"email": email},
                {"$set": {"codeHash": code_hash, "attempts": 0, "expiresAt": _now() + timedelta(minutes=ttl_minutes), "createdAt": _now()}},
                upsert=True,
            )
        except Exception:
            log.exception("save_otp failed")

    def get_otp(self, email: str) -> dict[str, Any] | None:
        db = self._db()
        if db is None:
            return None
        try:
            return db.email_otps.find_one({"email": email})
        except Exception:
            log.exception("get_otp failed")
            return None

    def increment_otp_attempts(self, email: str) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.email_otps.update_one({"email": email}, {"$inc": {"attempts": 1}})
        except Exception:
            log.exception("increment_otp_attempts failed")

    def delete_otp(self, email: str) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.email_otps.delete_one({"email": email})
        except Exception:
            log.exception("delete_otp failed")

    # ------------------------------------------------------------- sessions
    def save_session(self, token: str, email: str, ttl_days: int = 30) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.sessions.insert_one({"token": token, "email": email,
                                    "createdAt": _now(), "expiresAt": _now() + timedelta(days=ttl_days)})
        except Exception:
            log.exception("save_session failed")

    def get_session(self, token: str) -> dict[str, Any] | None:
        db = self._db()
        if db is None:
            return None
        try:
            return db.sessions.find_one({"token": token, "expiresAt": {"$gt": _now()}})
        except Exception:
            log.exception("get_session failed")
            return None

    def delete_session(self, token: str) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.sessions.delete_one({"token": token})
        except Exception:
            log.exception("delete_session failed")

    # ------------------------------------------------------------- outcomes
    def save_outcome(self, doc: dict[str, Any]) -> dict[str, Any] | None:
        db = self._db()
        if db is None:
            return None
        doc = dict(doc)
        doc["closedAt"] = doc.get("closedAt") or _now()
        try:
            q = {"signalId": doc["signalId"]} if doc.get("signalId") else {"patternKey": doc["patternKey"], "closedAt": doc["closedAt"]}
            db.trade_outcomes.update_one(q, {"$set": doc}, upsert=True)
            return doc
        except Exception:
            log.exception("save_outcome failed")
            return None

    def get_outcomes(self, limit: int = 500) -> list[dict[str, Any]]:
        db = self._db()
        if db is None:
            return []
        try:
            return list(db.trade_outcomes.find({}, {"_id": 0}).sort("closedAt", DESCENDING).limit(max(1, min(1000, limit))))
        except Exception:
            log.exception("get_outcomes failed")
            return []

    def get_learning_profile(self, pattern_key: str) -> dict[str, Any] | None:
        outcomes = self.get_outcomes(500)
        rows = [o for o in outcomes if o.get("patternKey") == pattern_key][:120]
        if not rows:
            return None
        pnls = [float(o.get("pnlR") or 0.0) for o in rows]
        wins = sum(1 for p in pnls if p > 0)
        losses = sum(1 for p in pnls if p < 0)
        breakevens = len(pnls) - wins - losses
        avg_win = sum(p for p in pnls if p > 0) / wins if wins else 0.0
        avg_loss = sum(p for p in pnls if p < 0) / losses if losses else 0.0
        return {
            "patternKey": pattern_key,
            "samples": len(rows),
            "wins": wins,
            "losses": losses,
            "breakevens": breakevens,
            "winRate": round(wins / len(rows), 4) if rows else None,
            "expectancyR": round(sum(pnls) / len(rows), 4) if rows else None,
            "avgWinR": round(avg_win, 4),
            "avgLossR": round(avg_loss, 4),
        }

    def get_learning_profiles(self) -> list[dict[str, Any]]:
        outcomes = self.get_outcomes(1000)
        by_key: dict[str, list[dict[str, Any]]] = {}
        for o in outcomes:
            key = o.get("patternKey")
            if key:
                by_key.setdefault(key, []).append(o)
        profiles = []
        for key in by_key:
            prof = self.get_learning_profile(key)
            if prof:
                profiles.append(prof)
        profiles.sort(key=lambda p: (p.get("expectancyR") or 0.0, -p.get("samples", 0)))
        return profiles[:100]

    def get_equity_curve(self, start_balance: float = 10000.0, limit: int = 1000) -> list[dict[str, Any]]:
        outcomes = self.get_outcomes(limit)
        outcomes.sort(key=lambda o: o.get("closedAt") or 0)
        balance = start_balance
        curve = [{"timestamp": None, "balance": start_balance}]
        for o in outcomes:
            pnl_pct = float(o.get("pnlPct") or 0.0)
            balance *= (1 + pnl_pct / 100.0)
            curve.append({"timestamp": o.get("closedAt"), "balance": round(balance, 2)})
        return curve

    # -------------------------------------------------------------- market
    def save_market_snapshot(self, doc: dict[str, Any]) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.market_snapshots.insert_one({**doc, "createdAt": _now()})
        except Exception:
            log.exception("save_market_snapshot failed")

    def save_candles(self, source: str, symbol: str, timeframe: str, candles: list[dict[str, Any]]) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.candle_history.update_one(
                {"source": source, "symbol": symbol, "timeframe": timeframe},
                {"$set": {"candles": candles[-MAX_STORED_CANDLES:], "updatedAt": _now()}},
                upsert=True,
            )
        except Exception:
            log.exception("save_candles failed")

    def load_candles(self, source: str, symbol: str, timeframe: str) -> list[dict[str, Any]]:
        db = self._db()
        if db is None:
            return []
        try:
            row = db.candle_history.find_one({"source": source, "symbol": symbol, "timeframe": timeframe})
            return list((row or {}).get("candles", []))
        except Exception:
            log.exception("load_candles failed")
            return []

    # ---------------------------------------------------------------- push
    def save_push_subscription(self, user_id: str, subscription: dict[str, Any]) -> None:
        db = self._db()
        if db is None:
            return
        endpoint = subscription.get("endpoint", "")
        try:
            db.web_push_subscriptions.update_one(
                {"userId": user_id, "endpoint": endpoint},
                {"$set": {"subscription": subscription, "userId": user_id, "endpoint": endpoint, "updatedAt": _now()},
                 "$setOnInsert": {"createdAt": _now()}},
                upsert=True,
            )
        except Exception:
            log.exception("save_push_subscription failed")

    def remove_push_subscription(self, user_id: str, endpoint: str) -> None:
        db = self._db()
        if db is None:
            return
        try:
            db.web_push_subscriptions.delete_one({"userId": user_id, "endpoint": endpoint})
        except Exception:
            log.exception("remove_push_subscription failed")

    def get_push_subscriptions(self, user_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        db = self._db()
        if db is None:
            return []
        try:
            q = {"userId": user_id} if user_id else {}
            return list(db.web_push_subscriptions.find(q, {"_id": 0}).limit(limit))
        except Exception:
            log.exception("get_push_subscriptions failed")
            return []

    def get_stats(self) -> dict[str, Any]:
        db = self._db()
        if db is None:
            return {}
        out: dict[str, Any] = {}
        for name in ("signals", "telemetry", "users", "trade_outcomes"):
            try:
                out[name] = db[name].count_documents({})
            except Exception:
                out[name] = None
        return out
