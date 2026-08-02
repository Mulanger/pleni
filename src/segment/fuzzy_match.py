"""Fuzzy transcript matching utilities for C3."""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from math import ceil, floor
from typing import Final

TOKEN_RE: Final[re.Pattern[str]] = re.compile(r"[0-9A-Za-zÅÄÖåäö]+")
MIN_WINDOW_FRAC = 0.70
MAX_WINDOW_FRAC = 1.30


@dataclass(frozen=True)
class TimedToken:
    """One token with master-relative timing."""

    text: str
    start_s: float
    end_s: float


@dataclass(frozen=True)
class FuzzyMatch:
    """Best fuzzy match of official text in a timed token stream."""

    start_s: float
    end_s: float
    score: float
    token_start_index: int
    token_end_index: int


def normalize_tokens(text: str) -> list[str]:
    """Normalize Swedish text into lowercase alphanumeric tokens."""

    return [match.group(0).casefold() for match in TOKEN_RE.finditer(text)]


def find_best_transcript_match(
    official_text: str,
    asr_tokens: list[TimedToken],
) -> FuzzyMatch | None:
    """Find the highest-similarity contiguous ASR token span for official text."""

    official_tokens = normalize_tokens(official_text)
    indexed_asr = [
        (index, normalized)
        for index, token in enumerate(asr_tokens)
        if (normalized := _first_token(token.text)) is not None
    ]
    if not official_tokens or not indexed_asr:
        return None
    normalized_asr = [normalized for _, normalized in indexed_asr]

    target_len = len(official_tokens)
    min_len = max(1, floor(target_len * MIN_WINDOW_FRAC))
    max_len = min(len(normalized_asr), max(min_len, ceil(target_len * MAX_WINDOW_FRAC)))

    best_score = -1.0
    best_start = 0
    best_end = 0
    for window_len in range(min_len, max_len + 1):
        for start_index in range(0, len(normalized_asr) - window_len + 1):
            end_index = start_index + window_len
            score = _ratio(official_tokens, normalized_asr[start_index:end_index])
            if score > best_score:
                best_score = score
                best_start = indexed_asr[start_index][0]
                best_end = indexed_asr[end_index - 1][0]

    return FuzzyMatch(
        start_s=asr_tokens[best_start].start_s,
        end_s=asr_tokens[best_end].end_s,
        score=max(0.0, best_score),
        token_start_index=best_start,
        token_end_index=best_end,
    )


def _first_token(text: str) -> str | None:
    match = TOKEN_RE.search(text)
    if match is None:
        return None
    return match.group(0).casefold()


def _ratio(left: list[str], right: list[str]) -> float:
    return SequenceMatcher(None, left, right, autojunk=False).ratio()
