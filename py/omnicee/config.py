"""Central configuration.

Every setting the Python service uses is declared here and validated once at
boot. Nothing anywhere else in the package reads os.environ directly.

Design rules:
  * No silent defaults for anything that affects money. Risk limits must be
    explicit or the service refuses to start in production.
  * Env names are shared with the Node service where the meaning is identical,
    so a single Render env group configures both.
  * Validation failure is fatal at boot, never a surprise at 3am mid-signal.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Env = Literal["development", "test", "staging", "production"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    # ---- runtime -------------------------------------------------------
    NODE_ENV: Env = "development"
    PORT: int = 8000
    LOG_LEVEL: Literal["debug", "info", "warn", "error"] = "info"
    SERVICE_NAME: str = "omnicee-brain"

    # ---- auth ----------------------------------------------------------
    # Shared secret for internal /v1/* analysis endpoints. Optional: when the
    # whole backend is one service these routes are loopback-only.
    BRAIN_SHARED_SECRET: str = ""
    # Browser/API surface.
    APP_ACCESS_TOKEN: str = ""
    EA_SECRET: str = ""
    TRADINGVIEW_WEBHOOK_SECRET: str = ""
    PUBLIC_DASHBOARD_READ: bool = True
    EMAIL_AUTH_REQUIRED: bool = True
    CORS_ORIGIN: str = ""
    API_RATE_LIMIT_PER_MIN: int = Field(default=120, ge=1)
    EA_RATE_LIMIT_PER_MIN: int = Field(default=300, ge=1)

    # ---- email OTP ------------------------------------------------------
    OTP_PEPPER: str = "omnicee-local-dev-otp"
    BREVO_API_KEY: str = ""
    EMAIL_FROM: str = "OMNICEE <noreply@omnicee.app>"
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_SECURE: bool = False
    SMTP_USER: str = ""
    SMTP_PASS: str = ""
    ALLOW_DEV_OTP: bool = False
    LOGIN_PASSWORD: str = ""

    # ---- telegram / alerts ----------------------------------------------
    TELEGRAM_BOT_TOKEN: str = ""
    TELEGRAM_CHAT_IDS: str = ""
    TELEGRAM_ALLOWED_USER_IDS: str = ""
    GRADE_A_CHANNEL_ID: str = ""
    WEB_PUSH_SUBJECT: str = ""
    WEB_PUSH_PUBLIC_KEY: str = ""
    WEB_PUSH_PRIVATE_KEY: str = ""

    # ---- persistence ----------------------------------------------------
    MONGODB_URI: str = ""
    MONGODB_DB: str = "omnicee"
    MONGODB_MAX_POOL: int = 5
    MONGODB_SIGNAL_TTL_DAYS: int = Field(default=45, ge=1)
    MONGODB_TELEMETRY_TTL_DAYS: int = Field(default=7, ge=1)
    DISABLE_MONGO_SIGNALS: bool = False
    CANDLE_PERSIST_INTERVAL_MS: int = Field(default=15_000, ge=1_000)

    # ---- market universe ------------------------------------------------
    SYMBOLS: str = "BTCUSDT,ETHUSDT,XAUUSD,USOIL,UUP,EURUSD,GBPUSD,USDJPY"
    TIMEFRAMES: str = "M15,H1,H4,D1"

    # ---- engine loop -----------------------------------------------------
    DISABLE_ENGINE: bool = False
    MIN_SIGNAL_SCORE: float = Field(default=75.0, ge=0.0, le=100.0)
    GOLD_MIN_SCORE: float = Field(default=52.0, ge=0.0, le=100.0)
    ANALYSIS_INTERVAL_MS: int = Field(default=45_000, ge=1_000)
    ADAPTIVE_THROTTLE: bool = True
    SIGNAL_SOFT_GATES: bool = True
    REQUIRE_KILLZONE: bool = False
    DXY_SYMBOL: str = "UUP"
    EQUITY_INDEX_SYMBOL: str = "SPY"
    BOOT_GRACE_MS: int = Field(default=60_000, ge=0)
    BROKER_PRICE_HOLD_MS: int = Field(default=15_000, ge=0)

    # ---- validation engines ----------------------------------------------
    BAYES_PRIOR: float = Field(default=0.50, ge=0.0, le=1.0)
    BAYES_MIN_POSTERIOR: float = Field(default=0.52, ge=0.0, le=1.0)
    MC_SIMULATIONS: int = Field(default=5000, ge=100)
    MC_MIN_WIN_PROB: float = Field(default=0.55, ge=0.0, le=1.0)
    MC_MIN_EXPECTED_R: float = Field(default=0.3, ge=0.0)
    STAT_MIN_TESTS: int = Field(default=5, ge=1)
    STAT_SIGNIFICANCE: float = Field(default=0.05, gt=0.0, lt=1.0)
    WF_MIN_SAMPLES: int = Field(default=20, ge=5)
    WF_MIN_WFE: float = Field(default=0.35, ge=0.0)
    ENSEMBLE_MIN_SCORE: float = Field(default=60.0, ge=0.0, le=100.0)
    LEARNING_MIN_SAMPLES: int = Field(default=6, ge=1)
    LEARNING_WARN_WIN_RATE: float = Field(default=0.42, ge=0.0, le=1.0)
    LEARNING_BLOCK_WIN_RATE: float = Field(default=0.28, ge=0.0, le=1.0)

    # ---- feed keys -------------------------------------------------------
    FINNHUB_API_KEY: str = ""
    FMP_API_KEY: str = ""
    ALPHA_VANTAGE_API_KEY: str = ""
    TWELVE_DATA_API_KEY: str = ""
    TIINGO_API_KEY: str = ""
    EODHD_API_TOKEN: str = ""
    STOCKDATA_API_TOKEN: str = ""
    ALETHEIA_API_KEY: str = ""
    FRED_API_KEY: str = ""
    PARSE_API_KEY: str = ""
    DERIV_APP_ID: str = "1089"
    MYFXBOOK_EMAIL: str = ""
    MYFXBOOK_PASSWORD: str = ""
    DISABLE_DERIV: bool = False
    DISABLE_EXCHANGERATE: bool = False
    DISABLE_TREASURY: bool = False
    DISABLE_YAHOO_QUOTES: bool = False
    DISABLE_TRADINGVIEW: bool = False
    DISABLE_BIQUOTE: bool = False
    DISABLE_FRANKFURTER: bool = False

    # ---- analysis tuning -------------------------------------------------
    MIN_BARS_FOR_ANALYSIS: int = Field(default=120, ge=30)
    ANALYSIS_TIMEOUT_MS: int = Field(default=4000, ge=250)
    AGENT_TIMEOUT_MS: int = Field(default=1500, ge=100)

    # ---- ensemble --------------------------------------------------------
    ENSEMBLE_MIN_CONFIDENCE: float = Field(default=0.62, ge=0.0, le=1.0)
    ENSEMBLE_MIN_AGENTS: int = Field(default=3, ge=1)
    CALIBRATION_MIN_SAMPLES: int = Field(default=80, ge=20)

    # ---- risk ------------------------------------------------------------
    ACCOUNT_BALANCE: float = Field(default=0.0, ge=0.0)
    RISK_PCT_PER_TRADE: float = Field(default=0.5, gt=0.0, le=5.0)
    MAX_DAILY_LOSS_PCT: float = Field(default=3.0, gt=0.0, le=100.0)
    MAX_DRAWDOWN_PCT: float = Field(default=10.0, gt=0.0, le=100.0)
    MAX_CONSEC_LOSS: int = Field(default=4, ge=1)
    MAX_TRADES_PER_DAY: int = Field(default=8, ge=1)
    KELLY_FRACTION_CAP: float = Field(default=0.25, gt=0.0, le=1.0)

    # ---- staleness -------------------------------------------------------
    # A price older than this is not a price. Never analyse on stale data.
    MAX_PRICE_AGE_MS: int = Field(default=90_000, ge=1_000)

    @field_validator("SYMBOLS", "TIMEFRAMES")
    @classmethod
    def _non_empty_csv(cls, v: str) -> str:
        cleaned = ",".join(p.strip().upper() for p in v.split(",") if p.strip())
        if not cleaned:
            raise ValueError("must contain at least one entry")
        return cleaned

    @field_validator("MONGODB_URI", "BRAIN_SHARED_SECRET", mode="before")
    @classmethod
    def _trim(cls, v: object) -> object:
        # Pasted env values routinely carry trailing whitespace/newlines.
        # This exact class of bug has bitten this project before.
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _production_requirements(self) -> Settings:
        if self.NODE_ENV == "production":
            missing = [
                name
                for name in ("EA_SECRET", "MONGODB_URI")
                if not getattr(self, name)
            ]
            if missing:
                raise ValueError(
                    "production requires these env vars to be set: "
                    + ", ".join(missing)
                )
            if self.BRAIN_SHARED_SECRET and len(self.BRAIN_SHARED_SECRET) < 24:
                raise ValueError("BRAIN_SHARED_SECRET must be >= 24 characters")
        return self

    # ---- derived ---------------------------------------------------------
    @property
    def symbols(self) -> list[str]:
        return self.SYMBOLS.split(",")

    @property
    def timeframes(self) -> list[str]:
        return self.TIMEFRAMES.split(",")

    @property
    def is_production(self) -> bool:
        return self.NODE_ENV == "production"

    @property
    def mongo_enabled(self) -> bool:
        return bool(self.MONGODB_URI)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached singleton. Call this, never construct Settings() directly."""
    return Settings()


def reset_settings_cache() -> None:
    """Test helper: drop the cache so env changes take effect."""
    get_settings.cache_clear()


__all__ = ["Env", "Settings", "get_settings", "os", "reset_settings_cache"]
