"""Tests for C3 confidence routing."""

from __future__ import annotations

from src.segment.confidence import ConfidenceRoute, route_confidence, score_boundary_confidence


def test_route_confidence_thresholds() -> None:
    assert route_confidence(0.86).route is ConfidenceRoute.ACCEPT
    assert not route_confidence(0.86).needs_review
    assert route_confidence(0.60).route is ConfidenceRoute.REVIEW
    assert route_confidence(0.60).needs_review
    assert route_confidence(0.59).route is ConfidenceRoute.PARK


def test_score_boundary_confidence_uses_available_evidence() -> None:
    metadata_only = score_boundary_confidence(
        official_text_present=True,
        vad_used=False,
        scene_snapped=False,
        fuzzy_score=None,
        correction_s=2.0,
    )
    supported = score_boundary_confidence(
        official_text_present=True,
        vad_used=True,
        scene_snapped=True,
        fuzzy_score=None,
        correction_s=2.0,
    )
    fuzzy = score_boundary_confidence(
        official_text_present=True,
        vad_used=False,
        scene_snapped=False,
        fuzzy_score=0.91,
        correction_s=2.0,
    )

    assert supported > metadata_only
    assert fuzzy == 0.91
