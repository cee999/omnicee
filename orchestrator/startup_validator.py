"""Startup validation that reports actionable configuration problems.

Validation is deliberately non-destructive: local/stateless development may run
without MongoDB, while production configuration errors remain visible and can
be made fatal by the application bootstrap policy.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from config import Settings
from services.db import Database

log = logging.getLogger(__name__)


class StartupValidator:
    """Run inexpensive readiness checks before the live backend starts."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.issues: list[str] = []
        self.warnings: list[str] = []
        self.checks_run: dict[str, bool] = {}

    def validate_configuration(self) -> bool:
        if self.settings.is_production and not self.settings.MONGODB_URI:
            self.issues.append("MONGODB_URI not configured in production")
        if self.settings.is_production and not self.settings.EA_SECRET:
            self.issues.append("EA_SECRET not configured in production")
        if not self.settings.symbols:
            self.issues.append("SYMBOLS list is empty")
        if not self.settings.timeframes:
            self.issues.append("TIMEFRAMES list is empty")

        if not self.settings.MONGODB_URI:
            self.warnings.append("MongoDB is disabled; persistence and learning are unavailable")
        if self.settings.MAX_DAILY_LOSS_PCT > 10:
            self.warnings.append(f"Aggressive daily loss limit: {self.settings.MAX_DAILY_LOSS_PCT}%")
        if self.settings.RISK_PCT_PER_TRADE > 2:
            self.warnings.append(f"Aggressive risk per trade: {self.settings.RISK_PCT_PER_TRADE}%")
        if self.settings.AGENT_TIMEOUT_MS < 500:
            self.warnings.append(f"Short agent timeout: {self.settings.AGENT_TIMEOUT_MS}ms")

        self.checks_run["configuration"] = not self.issues
        return not self.issues

    async def validate_database(self) -> bool:
        """Ping synchronous PyMongo off the event loop when Mongo is enabled."""
        if not self.settings.MONGODB_URI:
            self.checks_run["database"] = True
            return True

        db = Database(
            self.settings.MONGODB_URI,
            self.settings.MONGODB_DB,
            self.settings.MONGODB_MAX_POOL,
            self.settings.MONGODB_SIGNAL_TTL_DAYS,
            self.settings.MONGODB_TELEMETRY_TTL_DAYS,
            self.settings.DISABLE_MONGO_SIGNALS,
        )
        try:
            health = await asyncio.wait_for(asyncio.to_thread(db.health), timeout=5.0)
        except asyncio.TimeoutError:
            self.issues.append("Database health check timed out after 5 seconds")
            self.checks_run["database"] = False
            return False
        if not health.get("ok"):
            self.issues.append("Database is configured but unreachable")
            self.checks_run["database"] = False
            return False
        self.checks_run["database"] = True
        return True

    def validate_feed_configuration(self) -> bool:
        optional_keys = {
            "FINNHUB": self.settings.FINNHUB_API_KEY,
            "FMP": self.settings.FMP_API_KEY,
            "ALPHA_VANTAGE": self.settings.ALPHA_VANTAGE_API_KEY,
        }
        missing = [name for name, value in optional_keys.items() if not value]
        if missing:
            self.warnings.append(f"Optional feeds without API keys: {', '.join(missing)}")
        if self.settings.is_production and not self.settings.TELEGRAM_BOT_TOKEN:
            self.warnings.append("Telegram alerts are disabled")
        self.checks_run["feed_config"] = True
        return True

    def validate_settings_consistency(self) -> bool:
        if self.settings.ENSEMBLE_MIN_CONFIDENCE < 0.5:
            self.warnings.append("Low ensemble confidence threshold")
        if self.settings.MIN_SIGNAL_SCORE > 90:
            self.warnings.append("High minimum signal score may produce few signals")
        if self.settings.MIN_BARS_FOR_ANALYSIS < 60:
            self.warnings.append("Analysis bar threshold is below the engine minimum")
        self.checks_run["consistency"] = True
        return True

    async def run_all_checks(self) -> dict[str, Any]:
        self.validate_configuration()
        await self.validate_database()
        self.validate_feed_configuration()
        self.validate_settings_consistency()
        result = {
            "passed": not self.issues,
            "checks_run": dict(self.checks_run),
            "checks_passed": sum(self.checks_run.values()),
            "checks_total": len(self.checks_run),
            "critical_issues": list(self.issues),
            "warnings": list(self.warnings),
        }
        if self.issues:
            log.error("startup validation failed: %s", self.issues)
        elif self.warnings:
            log.warning("startup validation passed with warnings: %s", self.warnings)
        else:
            log.info("startup validation passed")
        return result


__all__ = ["StartupValidator"]
