"""Startup validation to detect configuration and initialization issues early.

Prevents silent failures at boot by:
- Validating all required environment variables
- Testing database connectivity
- Checking feed manager initialization
- Verifying configuration consistency
- Reporting actionable startup errors
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from config import Settings
from services.db import Database

log = logging.getLogger(__name__)


class StartupValidator:
    """Validates system readiness at boot."""
    
    def __init__(self, settings: Settings):
        self.settings = settings
        self.issues: list[str] = []
        self.warnings: list[str] = []
        self.checks_run: dict[str, bool] = {}
    
    def validate_configuration(self) -> bool:
        """Check configuration for obvious errors."""
        log.info("validating configuration...")
        
        # Critical settings
        if not self.settings.MONGODB_URI:
            self.issues.append("MONGODB_URI not configured - signals cannot persist")
        
        if not self.settings.EA_SECRET and self.settings.is_production:
            self.issues.append("EA_SECRET not set in production - MT5 EA cannot authenticate")
        
        if not self.settings.symbols:
            self.issues.append("SYMBOLS list is empty - no assets to trade")
        
        if not self.settings.timeframes:
            self.issues.append("TIMEFRAMES list is empty")
        
        # Warn on suspicious settings
        if self.settings.MAX_DAILY_LOSS_PCT > 10:
            self.warnings.append(f"Aggressive daily loss limit: {self.settings.MAX_DAILY_LOSS_PCT}%")
        
        if self.settings.MAX_CONSEC_LOSS < 2:
            self.warnings.append(f"Low consecutive loss threshold: {self.settings.MAX_CONSEC_LOSS}")
        
        if self.settings.AGENT_TIMEOUT_MS < 500:
            self.warnings.append(f"Very short agent timeout: {self.settings.AGENT_TIMEOUT_MS}ms")
        
        if self.settings.ANALYSIS_INTERVAL_MS < 10_000:
            self.warnings.append(f"Very frequent analysis: {self.settings.ANALYSIS_INTERVAL_MS}ms intervals")
        
        self.checks_run["configuration"] = len(self.issues) == 0
        return len(self.issues) == 0
    
    async def validate_database(self) -> bool:
        """Test database connectivity."""
        log.info("validating database connectivity...")
        
        if not self.settings.MONGODB_URI:
            log.warning("skipping database validation - no MONGODB_URI configured")
            return True
        
        try:
            db = Database(
                self.settings.MONGODB_URI,
                self.settings.MONGODB_DB,
                self.settings.MONGODB_MAX_POOL,
                self.settings.MONGODB_SIGNAL_TTL_DAYS,
                self.settings.MONGODB_TELEMETRY_TTL_DAYS,
                self.settings.DISABLE_MONGO_SIGNALS,
            )
            
            # Attempt a simple connection
            await asyncio.wait_for(
                db.client.admin.command("ping"),
                timeout=5.0
            )
            
            log.info("database connection successful")
            self.checks_run["database"] = True
            return True
        except asyncio.TimeoutError:
            self.issues.append("Database connection timeout (>5s) - check MONGODB_URI and network")
        except Exception as e:
            self.issues.append(f"Database connection failed: {str(e)[:100]}")
        
        self.checks_run["database"] = False
        return False
    
    def validate_feed_configuration(self) -> bool:
        """Validate feed settings."""
        log.info("validating feed configuration...")
        
        # Check feed API keys if used
        feeds_requiring_keys = {
            "FINNHUB": self.settings.FINNHUB_API_KEY,
            "FMP": self.settings.FMP_API_KEY,
            "ALPHA_VANTAGE": self.settings.ALPHA_VANTAGE_API_KEY,
        }
        
        disabled_feeds = 0
        for name, key in feeds_requiring_keys.items():
            if not key:
                self.warnings.append(f"{name} API key not configured - feed disabled")
                disabled_feeds += 1
        
        if disabled_feeds >= 2:
            self.warnings.append("Multiple data feeds disabled - consider adding API keys for redundancy")
        
        # Check Telegram/alerts
        if not self.settings.TELEGRAM_BOT_TOKEN and self.settings.is_production:
            self.warnings.append("TELEGRAM_BOT_TOKEN not set - alerts disabled")
        
        self.checks_run["feed_config"] = True
        return True
    
    def validate_settings_consistency(self) -> bool:
        """Check for logically inconsistent settings."""
        log.info("validating settings consistency...")
        
        # Min confidence gates
        if self.settings.ENSEMBLE_MIN_CONFIDENCE < 0.5:
            self.warnings.append("Very low min confidence threshold - may produce marginal signals")
        
        if self.settings.MIN_SIGNAL_SCORE > 90:
            self.warnings.append("Very high min score requirement - few signals may pass")
        
        # Risk settings
        if self.settings.RISK_PCT_PER_TRADE > 2.0:
            self.warnings.append(f"Aggressive risk per trade: {self.settings.RISK_PCT_PER_TRADE}%")
        
        # Timeframe and bar count
        if self.settings.MIN_BARS_FOR_ANALYSIS < 60:
            self.warnings.append("Low min bar count - may analyze on insufficient data")
        
        self.checks_run["consistency"] = True
        return True
    
    async def run_all_checks(self) -> dict[str, Any]:
        """Run all startup validations."""
        log.info("=" * 60)
        log.info("🔍 STARTUP VALIDATION")
        log.info("=" * 60)
        
        self.validate_configuration()
        await self.validate_database()
        self.validate_feed_configuration()
        self.validate_settings_consistency()
        
        # Summary
        passed = sum(1 for v in self.checks_run.values() if v)
        total = len(self.checks_run)
        
        result = {
            "passed": len(self.issues) == 0,
            "checks_run": self.checks_run,
            "checks_passed": passed,
            "checks_total": total,
            "critical_issues": self.issues,
            "warnings": self.warnings,
        }
        
        # Log summary
        if self.issues:
            log.error("=" * 60)
            log.error("❌ STARTUP VALIDATION FAILED")
            for issue in self.issues:
                log.error(f"  - {issue}")
            log.error("=" * 60)
        elif self.warnings:
            log.warning("=" * 60)
            log.warning("⚠️  STARTUP VALIDATION PASSED WITH WARNINGS")
            for warning in self.warnings:
                log.warning(f"  - {warning}")
            log.warning("=" * 60)
        else:
            log.info("=" * 60)
            log.info("✅ STARTUP VALIDATION PASSED")
            log.info("=" * 60)
        
        return result


__all__ = ["StartupValidator"]
