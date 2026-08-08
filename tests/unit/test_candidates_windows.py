"""Tests for C6 sentence-boundary window generation."""

from __future__ import annotations

import pytest

from src.candidates.windows import (
    CandidateWindow,
    generate_sentence_windows,
    snap_window_to_pauses,
)
from src.contracts import Sentence, SentenceSpan, TimeSpan


def test_generate_sentence_windows_uses_sentence_boundaries() -> None:
    sentences = tuple(
        Sentence(
            index=index,
            start_s=index * 10.0,
            end_s=(index + 1) * 10.0,
            text=f"S{index}.",
            word_indices=(index,),
        )
        for index in range(7)
    )

    windows = generate_sentence_windows(sentences, min_duration_s=38.0, max_duration_s=62.0)

    assert windows[0].start_s == 0.0
    assert windows[0].end_s == 40.0
    assert windows[0].sentence_span.start_index == 0
    assert windows[0].sentence_span.end_index == 3
    assert all(38.0 <= window.duration_s <= 62.0 for window in windows)


def test_generate_sentence_windows_returns_none_for_short_speech() -> None:
    sentences = (Sentence(index=0, start_s=0.0, end_s=20.0, text="Kort.", word_indices=(0,)),)

    assert generate_sentence_windows(sentences, min_duration_s=38.0, max_duration_s=62.0) == []


def test_generate_sentence_windows_accepts_exact_max_duration() -> None:
    sentences = (Sentence(index=0, start_s=0.0, end_s=60.0, text="Exakt.", word_indices=(0,)),)

    windows = generate_sentence_windows(sentences, min_duration_s=38.0, max_duration_s=60.0)

    assert len(windows) == 1
    assert windows[0].duration_s == 60.0


def test_generate_sentence_windows_rejects_single_overlong_sentence() -> None:
    sentences = (Sentence(index=0, start_s=0.0, end_s=90.0, text="För lång.", word_indices=(0,)),)

    assert generate_sentence_windows(sentences, min_duration_s=38.0, max_duration_s=62.0) == []


def _sentence(index: int, start: float, end: float) -> Sentence:
    return Sentence(
        index=index, start_s=start, end_s=end, text=f"Mening {index}.", word_indices=(index,)
    )


def test_edges_snap_onto_measured_silence() -> None:
    """The defect this exists for.

    C4 spreads the official transcript's words evenly across the speech (ADR
    011), so a "sentence boundary" is an interpolation. Measured over 517
    published clips, 61% of ends landed at more than half of normal speaking
    loudness -- cut mid-utterance -- and only 11% inside a real pause. C5's
    pauses come from the waveform, so they are the evidence.
    """

    sentences = [_sentence(0, 10.0, 30.0), _sentence(1, 30.0, 51.0)]
    pauses = (TimeSpan(start_s=8.4, end_s=9.2), TimeSpan(start_s=52.3, end_s=53.1))

    (window,) = generate_sentence_windows(
        sentences, min_duration_s=38.0, max_duration_s=62.0, pauses=pauses, max_snap_s=2.0
    )

    assert window.start_s == 9.2, "starts when speech resumes, i.e. the pause's end"
    assert window.end_s == 52.3, "ends when speech stops, i.e. the pause's start"


def test_a_pause_beyond_reach_leaves_the_edge_alone() -> None:
    sentences = [_sentence(0, 10.0, 30.0), _sentence(1, 30.0, 50.0)]
    pauses = (TimeSpan(start_s=1.0, end_s=2.0), TimeSpan(start_s=80.0, end_s=81.0))

    (window,) = generate_sentence_windows(
        sentences, min_duration_s=38.0, max_duration_s=62.0, pauses=pauses, max_snap_s=2.0
    )

    assert (window.start_s, window.end_s) == (10.0, 50.0)


def test_snapping_is_off_by_default_so_older_behaviour_is_unchanged() -> None:
    sentences = [_sentence(0, 10.0, 30.0), _sentence(1, 30.0, 50.0)]
    pauses = (TimeSpan(start_s=9.0, end_s=9.5),)

    (window,) = generate_sentence_windows(
        sentences, min_duration_s=38.0, max_duration_s=62.0, pauses=pauses
    )

    assert (window.start_s, window.end_s) == (10.0, 50.0)


def test_duration_limits_are_applied_to_the_snapped_window_not_the_raw_one() -> None:
    """Snapping happens first, so a window is admitted or rejected on the length
    it will actually be rendered at."""

    sentences = [_sentence(0, 10.0, 30.0), _sentence(1, 30.0, 47.0)]
    # raw span is 37s (under the 38s floor); snapping widens it to 39.6s
    pauses = (TimeSpan(start_s=7.5, end_s=8.6), TimeSpan(start_s=48.2, end_s=49.0))

    windows = generate_sentence_windows(
        sentences, min_duration_s=38.0, max_duration_s=62.0, pauses=pauses, max_snap_s=2.0
    )

    assert len(windows) == 1
    assert windows[0].duration_s == pytest.approx(39.6)


def test_snapping_never_inverts_a_window() -> None:
    window = CandidateWindow(
        sentence_span=SentenceSpan(start_index=0, end_index=0), start_s=40.0, end_s=41.0
    )
    pauses = (TimeSpan(start_s=39.0, end_s=41.5),)

    snapped = snap_window_to_pauses(window, pauses, max_snap_s=2.0)

    assert snapped.end_s > snapped.start_s


def test_padding_opens_before_speech_and_closes_after_it() -> None:
    """Snapping alone lands the start on the first phoneme, which clips it, and
    the end on the last, which sounds abrupt. A fraction of a second of the
    surrounding silence is what makes a cut sound deliberate."""

    window = CandidateWindow(
        sentence_span=SentenceSpan(start_index=0, end_index=0), start_s=10.0, end_s=50.0
    )
    pauses = (TimeSpan(start_s=8.0, end_s=9.6), TimeSpan(start_s=50.4, end_s=52.0))

    snapped = snap_window_to_pauses(
        window, pauses, max_snap_s=2.0, lead_in_s=0.20, tail_s=0.30
    )

    assert snapped.start_s == pytest.approx(9.4), "0.2s of run-up before speech resumes"
    assert snapped.end_s == pytest.approx(50.7), "0.3s of room after speech stops"


def test_padding_never_reaches_into_the_neighbouring_sentence() -> None:
    """A pause shorter than the requested padding must clamp to the pause, or the
    clip would open on the tail of the previous sentence."""

    window = CandidateWindow(
        sentence_span=SentenceSpan(start_index=0, end_index=0), start_s=10.0, end_s=50.0
    )
    pauses = (TimeSpan(start_s=9.55, end_s=9.6), TimeSpan(start_s=50.4, end_s=50.45))

    snapped = snap_window_to_pauses(
        window, pauses, max_snap_s=2.0, lead_in_s=1.0, tail_s=1.0
    )

    assert snapped.start_s == pytest.approx(9.55), "clamped to the pause, not 1s earlier"
    assert snapped.end_s == pytest.approx(50.45), "clamped to the pause, not 1s later"
