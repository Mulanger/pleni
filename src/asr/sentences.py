"""Swedish sentence segmentation for C4 transcripts.

Input `Word` timestamps must already be float seconds relative to the master
debate video. Sentence `start_s` and `end_s` preserve that master-relative
timeline.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from src.contracts import Sentence, Word

TOKEN_RE = re.compile(r"\S+")
RIGHT_DOUBLE_QUOTE = chr(0x201D)
RIGHT_SINGLE_QUOTE = chr(0x2019)
RIGHT_GUILLEMET = chr(0x00BB)
TRAILING_CLOSERS = set("\"')]}") | {RIGHT_DOUBLE_QUOTE, RIGHT_SINGLE_QUOTE, RIGHT_GUILLEMET}
ABBREVIATIONS = frozenset(
    {
        "bl.a.",
        "ca.",
        "dvs.",
        "e.d.",
        "etc.",
        "fig.",
        "fr.o.m.",
        "kl.",
        "m.a.o.",
        "m.fl.",
        "m.m.",
        "nr.",
        "osv.",
        "s.",
        "t.ex.",
        "t.o.m.",
    }
)


def split_sentences(text: str) -> list[str]:
    """Split Swedish prose into sentences without breaking common abbreviations."""

    normalized = " ".join(text.split())
    if not normalized:
        return []

    sentences: list[str] = []
    start = 0
    index = 0
    while index < len(normalized):
        char = normalized[index]
        if char not in ".!?":
            index += 1
            continue

        punctuation_end = _consume_punctuation(normalized, index)
        boundary_end = _consume_trailing_closers(normalized, punctuation_end)
        if _is_sentence_boundary(normalized, index, punctuation_end):
            sentence = normalized[start:boundary_end].strip()
            if sentence:
                sentences.append(sentence)
            start = boundary_end
            while start < len(normalized) and normalized[start].isspace():
                start += 1
            index = start
            continue
        index = punctuation_end

    tail = normalized[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


def sentences_from_words(words: Sequence[Word]) -> list[Sentence]:
    """Build sentence contracts from master-relative word timings."""

    if not words:
        return []

    sentence_texts = split_sentences(" ".join(word.text for word in words))
    if not sentence_texts:
        sentence_texts = [" ".join(word.text for word in words)]

    sentences: list[Sentence] = []
    next_word_index = 0
    for sentence_index, sentence_text in enumerate(sentence_texts):
        token_count = max(1, len(TOKEN_RE.findall(sentence_text)))
        start_index = next_word_index
        if sentence_index == len(sentence_texts) - 1:
            end_index = len(words) - 1
        else:
            end_index = min(len(words) - 1, start_index + token_count - 1)
        next_word_index = min(len(words), end_index + 1)

        sentence_words = words[start_index : end_index + 1]
        sentences.append(
            Sentence(
                index=sentence_index,
                start_s=sentence_words[0].start_s,
                end_s=sentence_words[-1].end_s,
                text=sentence_text,
                word_indices=tuple(range(start_index, end_index + 1)),
            )
        )
    return sentences


def _is_sentence_boundary(text: str, punctuation_start: int, punctuation_end: int) -> bool:
    char = text[punctuation_start]
    if char in "!?":
        return True

    if _is_decimal_point(text, punctuation_start):
        return False

    prefix = text[:punctuation_end].lower()
    if any(prefix.endswith(abbreviation) for abbreviation in ABBREVIATIONS):
        return False

    token = _token_before(text, punctuation_start)
    if len(token) == 1 and token.isupper():
        return False

    next_index = punctuation_end
    while next_index < len(text) and text[next_index] in TRAILING_CLOSERS:
        next_index += 1
    while next_index < len(text) and text[next_index].isspace():
        next_index += 1
    if next_index >= len(text):
        return True
    return not text[next_index].islower()


def _is_decimal_point(text: str, index: int) -> bool:
    return (
        index > 0
        and index + 1 < len(text)
        and text[index - 1].isdigit()
        and text[index + 1].isdigit()
    )


def _token_before(text: str, index: int) -> str:
    start = index - 1
    while start >= 0 and not text[start].isspace():
        start -= 1
    return text[start + 1 : index]


def _consume_punctuation(text: str, index: int) -> int:
    while index < len(text) and text[index] in ".!?":
        index += 1
    return index


def _consume_trailing_closers(text: str, index: int) -> int:
    while index < len(text) and text[index] in TRAILING_CLOSERS:
        index += 1
    return index
