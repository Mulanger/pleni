"""Tests for Swedish sentence segmentation."""

from __future__ import annotations

from src.asr.sentences import split_sentences


def test_split_sentences_handles_basic_swedish_text() -> None:
    assert split_sentences("Herr talman. Detta är ett test!") == [
        "Herr talman.",
        "Detta är ett test!",
    ]


def test_split_sentences_does_not_break_common_abbreviations() -> None:
    assert split_sentences("Det gäller t.ex. skolan. Kl. 14.30 var mötet slut.") == [
        "Det gäller t.ex. skolan.",
        "Kl. 14.30 var mötet slut.",
    ]


def test_split_sentences_handles_quotes_and_decimal_commas() -> None:
    assert split_sentences('Hon sa: "Det är 3,5 procent." Sedan fortsatte hon.') == [
        'Hon sa: "Det är 3,5 procent."',
        "Sedan fortsatte hon.",
    ]
