"""Settings must trim whitespace off every pasted env value.

Regression test for a bug class that has already broken this project three
times (MongoDB URI, APP_ACCESS_TOKEN, then BREVO_API_KEY) — each time
because one specific field was hand-added to a trim list instead of trimming
being the default for all string settings. See config.py::_trim_all_strings.
"""

from __future__ import annotations

import os

import pytest

from config import Settings

PASTED_WITH_WHITESPACE = {
    "MONGODB_URI": "  mongodb://user:pass@host/db\n",
    "APP_ACCESS_TOKEN": "abc123\r\n",
    "BREVO_API_KEY": "xkeysib-xxxx\n",
    "EMAIL_FROM": " OMNICEE <noreply@omnicee.app> \n",
    "FINNHUB_API_KEY": "\tsome-key\t",
}


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch):
    for key in list(os.environ):
        if key in PASTED_WITH_WHITESPACE or key in Settings.model_fields:
            monkeypatch.delenv(key, raising=False)
    yield monkeypatch


def test_pasted_env_values_are_trimmed(clean_env: pytest.MonkeyPatch) -> None:
    for key, value in PASTED_WITH_WHITESPACE.items():
        clean_env.setenv(key, value)

    settings = Settings()

    assert settings.MONGODB_URI == "mongodb://user:pass@host/db"
    assert settings.APP_ACCESS_TOKEN == "abc123"
    assert settings.BREVO_API_KEY == "xkeysib-xxxx"
    assert settings.EMAIL_FROM == "OMNICEE <noreply@omnicee.app>"
    assert settings.FINNHUB_API_KEY == "some-key"


def test_non_string_env_values_survive_trim(clean_env: pytest.MonkeyPatch) -> None:
    # Booleans/ints arrive as strings from the environment too, but the
    # trim step must not corrupt them before pydantic's own coercion runs.
    clean_env.setenv("PORT", "8000")
    clean_env.setenv("DISABLE_ENGINE", "true")

    settings = Settings()

    assert settings.PORT == 8000
    assert settings.DISABLE_ENGINE is True
