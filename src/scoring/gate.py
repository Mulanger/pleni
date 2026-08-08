"""Absolute C7 publish gate.

Ordering scores are z-scored within a speech, but publish gating uses absolute
feature values so a weak speech does not manufacture publishable clips.
"""

from __future__ import annotations

from collections.abc import Mapping

from src.contracts import Candidate

MIN_SELF_CONTAINED = 0.50
MAX_DEAD_AIR_FRAC = 0.20
MIN_MEAN_WORD_PROBABILITY = 0.55

#: Framing gates, live only when C6v has measured the speech (ADR 013).
#:
#: `face_height_frac` was hardcoded to `1.0` by `compute_text_features` and
#: checked against a constant of `0.0`, so the framing half of this gate could
#: never fire -- for as long as C7 has existed. It now carries the measured
#: median face width over the candidate window.
#:
#: A candidate is admissible only if the expected speaker is verified on screen
#: for nearly all of it AND has no single long absence, because C8 rejects on the
#: gap rather than on the total. Selection has to be judged by the same rule it
#: will be judged by later, or it goes on proposing windows that cannot survive.
MIN_TARGET_VISIBLE_FRAC = 0.90
MAX_UNVERIFIED_GAP_S = 1.0
MIN_FACE_WIDTH_FRAC = 0.02


def apply_publish_gate(
    candidate: Candidate,
    features: Mapping[str, float],
) -> tuple[bool, str | None]:
    """Return whether a C6 candidate clears the C7 absolute publish gate."""

    if not candidate.gate_passed:
        return False, candidate.reject_reason
    if features.get("self_contained", 0.0) < MIN_SELF_CONTAINED:
        return False, "publish_gate:self_contained"
    if "target_visible_frac" in features:
        if features["target_visible_frac"] < MIN_TARGET_VISIBLE_FRAC:
            return False, "publish_gate:speaker_not_visible"
        if features.get("longest_unverified_gap_s", 0.0) > MAX_UNVERIFIED_GAP_S:
            return False, "publish_gate:unverified_gap"
        if features.get("face_height_frac", 0.0) < MIN_FACE_WIDTH_FRAC:
            return False, "publish_gate:face_too_small"
    if features.get("dead_air_frac", 1.0) > MAX_DEAD_AIR_FRAC:
        return False, "publish_gate:dead_air"
    if features.get("mean_word_probability", 0.0) < MIN_MEAN_WORD_PROBABILITY:
        return False, "publish_gate:low_asr_confidence"
    return True, None
