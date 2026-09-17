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
    # Shared secret between the Node edge and this service. The brain is never
    # exposed to browsers directly; only Node calls it.
    BRAIN_SHARED_SECRET: str = ""

    # ---- persistence ---------------------------------------------------
    MONGODB_URI: str = ""
    MONGODB_DB: str = "omnicee"
    MONGODB_MAX_POOL: int = 5

    # ---- market universe ------------------------------------------------
    SYMBOLS: str = "EURUSD,GBPUSD,USDJPY,XAUUSD,BTCUSD,ETHUSD,UUP,USOIL"
    TIMEFRAMES: str = "M5,M15,H1,H4,D1"

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
                for name in ("BRAIN_SHARED_SECRET", "MONGODB_URI")
                if not getattr(self, name)
            ]
            if missing:
                raise ValueError(
                    "production requires these env vars to be set: "
                    + ", ".join(missing)
                )
            if len(self.BRAIN_SHARED_SECRET) < 24:
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
