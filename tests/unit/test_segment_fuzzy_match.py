"""Tests for C3 fuzzy transcript matching."""

from __future__ import annotations

from src.segment.fuzzy_match import TimedToken, find_best_transcript_match, normalize_tokens


def test_normalize_tokens_handles_swedish_text() -> None:
    assert normalize_tokens("Herr talman: Åtgärden gäller 10 000 barn.") == [
        "herr",
        "talman",
        "åtgärden",
        "gäller",
        "10",
        "000",
        "barn",
    ]


def test_find_best_transcript_match_with_asr_noise() -> None:
    tokens = [
        TimedToken("brus", 0.0, 0.2),
        TimedToken("herr", 5.0, 5.2),
        TimedToken("talman", 5.2, 5.5),
        TimedToken("det", 5.5, 5.7),
        TimedToken("här", 5.7, 5.9),
        TimedToken("är", 5.9, 6.1),
        TimedToken("viktigt", 6.1, 6.4),
        TimedToken("idag", 6.4, 6.8),
        TimedToken("efterspel", 10.0, 10.2),
    ]

    match = find_best_transcript_match("Herr talman, det här är viktigt idag.", tokens)

    assert match is not None
    assert match.start_s == 5.0
    assert match.end_s == 6.8
    assert match.score > 0.85


def test_find_best_transcript_match_returns_none_without_tokens() -> None:
    assert find_best_transcript_match("Herr talman", []) is None
