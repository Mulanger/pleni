"""Tests for C4 word timing alignment helpers."""

from __future__ import annotations

from src.asr.align import (
    TimedWord,
    official_text_to_timed_words,
    project_official_text_to_asr_timing,
    to_master_words,
)
from src.contracts import Word


def test_to_master_words_clamps_and_orders_timings() -> None:
    words = to_master_words(
        (
            TimedWord(text="första", start_s=0.2, end_s=0.6, probability=0.9),
            TimedWord(text="andra", start_s=0.5, end_s=1.2, probability=1.2),
            TimedWord(text="tredje", start_s=3.0, end_s=4.0, probability=-1.0),
        ),
        speech_start_s=10.0,
        speech_end_s=12.5,
    )

    assert [word.text for word in words] == ["första", "andra"]
    assert words[0].start_s == 10.2
    assert words[1].start_s >= words[0].end_s
    assert words[1].end_s <= 12.5
    assert words[1].probability == 1.0


def test_official_text_to_timed_words_covers_window() -> None:
    words = official_text_to_timed_words("Herr talman!", duration_s=4.0)

    assert len(words) == 2
    assert words[0].start_s == 0.0
    assert words[-1].end_s == 4.0


def test_project_official_text_to_asr_timing_preserves_official_words() -> None:
    projected = project_official_text_to_asr_timing(
        "Herr talman!",
        (
            Word(text="Här", start_s=20.5, end_s=21.0, probability=0.7),
            Word(text="talman", start_s=21.0, end_s=22.5, probability=0.7),
        ),
        speech_start_s=20.0,
        speech_end_s=24.0,
    )

    assert [word.text for word in projected] == ["Herr", "talman!"]
    assert projected[0].start_s == 20.5
    assert projected[-1].end_s == 22.5
