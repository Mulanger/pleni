"""Tests for C6 sentence-boundary window generation."""

from __future__ import annotations

from src.candidates.windows import generate_sentence_windows
from src.contracts import Sentence


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
