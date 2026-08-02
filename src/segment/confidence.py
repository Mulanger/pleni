"""Confidence scoring and routing for C3 speech-boundary refinement."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

ACCEPT_THRESHOLD = 0.85
REVIEW_THRESHOLD = 0.60


class ConfidenceRoute(str, Enum):
    """Routing outcome for a refined speech boundary."""

    ACCEPT = "accept"
    REVIEW = "review"
    PARK = "park"


@dataclass(frozen=True)
class ConfidenceDecision:
    """Confidence score and routing action for one speech boundary."""

    confidence: float
    route: ConfidenceRoute
    needs_review: bool


def route_confidence(confidence: float) -> ConfidenceDecision:
    """Route a normalized boundary confidence score."""

    score = _clamp01(confidence)
    if score > ACCEPT_THRESHOLD:
        return ConfidenceDecision(score, ConfidenceRoute.ACCEPT, needs_review=False)
    if score >= REVIEW_THRESHOLD:
        return ConfidenceDecision(score, ConfidenceRoute.REVIEW, needs_review=True)
    return ConfidenceDecision(score, ConfidenceRoute.PARK, needs_review=True)


def score_boundary_confidence(
    *,
    official_text_present: bool,
    vad_used: bool,
    scene_snapped: bool,
    fuzzy_score: float | None,
    correction_s: float,
) -> float:
    """Compute a bounded confidence score from available C3 evidence."""

    if fuzzy_score is not None:
        base = fuzzy_score
    elif official_text_present:
        base = 0.72
    else:
        base = 0.50

    if vad_used:
        base += 0.08
    if scene_snapped:
        base += 0.04

    correction_penalty = max(0.0, correction_s - 5.0) * 0.01
    return _clamp01(base - min(0.25, correction_penalty))


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))
