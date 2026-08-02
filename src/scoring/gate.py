"""Absolute C7 publish gate.

Ordering scores are z-scored within a speech, but publish gating uses absolute
feature values so a weak speech does not manufacture publishable clips.
"""

from __future__ import annotations

from collections.abc import Mapping

from src.contracts import Candidate

MIN_SELF_CONTAINED = 0.50
MIN_FACE_HEIGHT_FRAC = 0.0
MAX_DEAD_AIR_FRAC = 0.20
MIN_MEAN_WORD_PROBABILITY = 0.55


def apply_publish_gate(
    candidate: Candidate,
    features: Mapping[str, float],
) -> tuple[bool, str | None]:
    """Return whether a C6 candidate clears the C7 absolute publish gate."""

    if not candidate.gate_passed:
        return False, candidate.reject_reason
    if features.get("self_contained", 0.0) < MIN_SELF_CONTAINED:
        return False, "publish_gate:self_contained"
    if features.get("face_height_frac", 1.0) < MIN_FACE_HEIGHT_FRAC:
        return False, "publish_gate:face_height_frac"
    if features.get("dead_air_frac", 1.0) > MAX_DEAD_AIR_FRAC:
        return False, "publish_gate:dead_air"
    if features.get("mean_word_probability", 0.0) < MIN_MEAN_WORD_PROBABILITY:
        return False, "publish_gate:low_asr_confidence"
    return True, None
