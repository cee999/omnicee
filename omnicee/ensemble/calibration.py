"""Turning a consensus score into an honest probability.

A raw ensemble score of 0.8 is not an 80% chance of anything. It is an
arbitrary number on an arbitrary scale. Reporting it as "confidence: 80%" is
the single most common way trading dashboards lie to their owners.

This module fits the mapping from score to realised win rate on actual closed
outcomes, using isotonic regression (monotonic, non-parametric, no
distributional assumption). Until enough outcomes exist it returns None, and
the signal carries `confidence: null` rather than a fabricated number.

`CALIBRATION_MIN_SAMPLES` is deliberately conservative. Below it, the fitted
curve is fitting noise.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)

__all__ = ["CalibrationReport", "Calibrator"]


@dataclass(frozen=True, slots=True)
class CalibrationReport:
    samples: int
    fitted: bool
    brier_score: float | None
    base_rate: float | None
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "samples": self.samples,
            "fitted": self.fitted,
            "brierScore": self.brier_score,
            "baseRate": self.base_rate,
            "reason": self.reason,
        }


class Calibrator:
    """Maps raw ensemble scores to calibrated win probabilities."""

    def __init__(self, min_samples: int = 80) -> None:
        self.min_samples = min_samples
        self._model = None
        self._report = CalibrationReport(0, False, None, None, "never fitted")

    @property
    def report(self) -> CalibrationReport:
        return self._report

    @property
    def is_fitted(self) -> bool:
        return self._model is not None

    def fit(self, scores: list[float] | np.ndarray, wins: list[int] | np.ndarray) -> CalibrationReport:
        """Fit on closed outcomes. `wins` is 1 for a win, 0 for a loss."""
        s = np.asarray(scores, dtype=np.float64).ravel()
        y = np.asarray(wins, dtype=np.float64).ravel()

        if s.size != y.size:
            raise ValueError("scores and wins must be the same length")

        mask = np.isfinite(s) & np.isfinite(y)
        s, y = s[mask], y[mask]

        if s.size < self.min_samples:
            self._model = None
            self._report = CalibrationReport(
                int(s.size), False, None,
                float(y.mean()) if y.size else None,
                f"need {self.min_samples} closed outcomes, have {s.size}",
            )
            return self._report

        if len(np.unique(y)) < 2:
            self._model = None
            self._report = CalibrationReport(
                int(s.size), False, None, float(y.mean()),
                "all outcomes identical — nothing to calibrate against",
            )
            return self._report

        try:
            from sklearn.isotonic import IsotonicRegression
        except ImportError:  # pragma: no cover - dependency is declared
            self._model = None
            self._report = CalibrationReport(
                int(s.size), False, None, float(y.mean()),
                "scikit-learn not installed",
            )
            return self._report

        model = IsotonicRegression(
            y_min=0.01, y_max=0.99, out_of_bounds="clip", increasing=True
        )
        model.fit(s, y)
        preds = model.predict(s)
        brier = float(np.mean((preds - y) ** 2))

        self._model = model
        self._report = CalibrationReport(
            int(s.size), True, round(brier, 5), round(float(y.mean()), 4), "fitted"
        )
        log.info(
            "calibration fitted",
            extra={"samples": int(s.size), "brier": brier},
        )
        return self._report

    def probability(self, score: float) -> float | None:
        """Calibrated win probability, or None when not fitted."""
        if self._model is None or not np.isfinite(score):
            return None
        p = float(self._model.predict(np.asarray([score], dtype=np.float64))[0])
        return round(min(0.99, max(0.01, p)), 4)
