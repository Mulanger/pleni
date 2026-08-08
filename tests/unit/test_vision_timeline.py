"""Tests for the per-speech speaker-visibility timeline consumed by C7."""

from __future__ import annotations

from src.scoring.gate import apply_publish_gate
from src.vision.timeline import (
    ShotVisibility,
    SpeechVisibility,
    shot_bounds_for_span,
    visibility_from_payload,
    visibility_payload,
)


def _shot(index: int, start: float, end: float, verified: bool, width: float = 0.11):
    return ShotVisibility(
        shot_index=index,
        start_s=start,
        end_s=end,
        verified=verified,
        reason=None if verified else "median_similarity_below_floor",
        median_similarity=0.55 if verified else 0.0,
        face_width_frac=width if verified else 0.0,
    )


def _timeline(*shots: ShotVisibility) -> SpeechVisibility:
    return SpeechVisibility(speech_id="s1", shots=shots)


def test_verified_fraction_is_measured_against_the_window_not_the_speech() -> None:
    timeline = _timeline(
        _shot(0, 0.0, 100.0, True),
        _shot(1, 100.0, 110.0, False),
        _shot(2, 110.0, 200.0, True),
    )

    assert timeline.verified_fraction(0.0, 100.0) == 1.0
    assert timeline.verified_fraction(95.0, 115.0) == 0.5
    assert timeline.verified_fraction(100.0, 110.0) == 0.0


def test_one_long_absence_is_visible_even_when_the_total_looks_fine() -> None:
    """A window can be 90% verified and still be unusable, because C8 rejects on
    the longest single gap rather than the total. Selection has to see the same
    shape or it keeps proposing windows that cannot survive."""

    timeline = _timeline(
        _shot(0, 0.0, 45.0, True),
        _shot(1, 45.0, 50.0, False),
        _shot(2, 50.0, 95.0, True),
    )

    assert timeline.verified_fraction(0.0, 95.0) > 0.89
    assert timeline.longest_unverified_gap_s(0.0, 95.0) == 5.0


def test_consecutive_unverified_shots_count_as_one_gap() -> None:
    timeline = _timeline(
        _shot(0, 0.0, 10.0, True),
        _shot(1, 10.0, 13.0, False),
        _shot(2, 13.0, 17.0, False),
        _shot(3, 17.0, 30.0, True),
    )

    assert timeline.longest_unverified_gap_s(0.0, 30.0) == 7.0


def test_face_width_is_zero_when_the_speaker_was_never_verified() -> None:
    timeline = _timeline(_shot(0, 0.0, 40.0, False))

    assert timeline.median_face_width_frac(0.0, 40.0) == 0.0


def test_the_timeline_round_trips_through_its_artifact() -> None:
    timeline = _timeline(_shot(0, 0.0, 10.0, True), _shot(1, 10.0, 20.0, False))

    restored = visibility_from_payload(visibility_payload(timeline))

    assert restored.speech_id == timeline.speech_id
    assert [s.verified for s in restored.shots] == [True, False]
    assert restored.shots[1].reason == "median_similarity_below_floor"


def test_shot_bounds_split_a_span_at_each_cut_inside_it() -> None:
    bounds = shot_bounds_for_span(10.0, 40.0, cuts=(5.0, 20.0, 30.0, 90.0))

    assert bounds == {0: (10.0, 20.0), 1: (20.0, 30.0), 2: (30.0, 40.0)}


def test_the_framing_gate_was_dead_and_now_fires() -> None:
    """`face_height_frac` was hardcoded to 1.0 and compared against 0.0, so the
    framing half of the publish gate could never reject anything for as long as
    C7 has existed."""

    from src.contracts import Candidate, SentenceSpan

    candidate = Candidate(
        speech_id="s1",
        start_s=0.0,
        end_s=45.0,
        sentence_span=SentenceSpan(start_index=0, end_index=3),
        features={},
        archetype_scores={},
        gate_passed=True,
    )
    base = {
        "self_contained": 1.0,
        "dead_air_frac": 0.0,
        "mean_word_probability": 1.0,
    }

    clean = {**base, "target_visible_frac": 1.0, "longest_unverified_gap_s": 0.0,
             "face_height_frac": 0.11}
    absent = {**base, "target_visible_frac": 0.40, "longest_unverified_gap_s": 20.0,
              "face_height_frac": 0.11}
    gapped = {**base, "target_visible_frac": 0.95, "longest_unverified_gap_s": 6.0,
              "face_height_frac": 0.11}
    tiny = {**base, "target_visible_frac": 1.0, "longest_unverified_gap_s": 0.0,
            "face_height_frac": 0.004}

    assert apply_publish_gate(candidate, clean) == (True, None)
    assert apply_publish_gate(candidate, absent) == (False, "publish_gate:speaker_not_visible")
    assert apply_publish_gate(candidate, gapped) == (False, "publish_gate:unverified_gap")
    assert apply_publish_gate(candidate, tiny) == (False, "publish_gate:face_too_small")


def test_without_a_timeline_selection_behaves_exactly_as_before() -> None:
    """C6v is additive: an older work dir, or the fixture runner, must still
    select clips rather than rejecting everything for lack of vision data."""

    from src.contracts import Candidate, SentenceSpan

    candidate = Candidate(
        speech_id="s1",
        start_s=0.0,
        end_s=45.0,
        sentence_span=SentenceSpan(start_index=0, end_index=3),
        features={},
        archetype_scores={},
        gate_passed=True,
    )

    assert apply_publish_gate(
        candidate,
        {"self_contained": 1.0, "dead_air_frac": 0.0, "mean_word_probability": 1.0},
    ) == (True, None)
