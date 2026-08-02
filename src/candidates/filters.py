"""Hard candidate filters for C6.

Candidate and scene times are float seconds relative to the master debate
video, never relative to a speech or clip.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from src.candidates.windows import CandidateWindow, window_sentences, window_text, window_words
from src.contracts import AudioFeatures, Scene, Speech, TimeSpan, Transcript, Word

LOW_ASR_CONFIDENCE_THRESHOLD = 0.55
MAX_DEAD_AIR_FRACTION = 0.20
CUT_COLLISION_S = 0.40
CONTENT_NOUN_HINTS = frozenset(
    {
        "beslut",
        "fraga",
        "forslag",
        "forslaget",
        "lag",
        "problem",
        "reform",
        "skola",
        "skolan",
        "situation",
        "system",
        "arende",
    }
)
DANGLING_OPENERS = frozenset({"och", "men", "det", "den", "darfor"})
BARE_PRONOUN_OPENERS = frozenset({"han", "hon", "de", "dem", "hen", "vi", "ni"})
UNBOUND_PRONOUNS = frozenset({"han", "hon", "de", "dem", "hen"})
DEMONSTRATIVE_OPENERS = ("det har", "den har", "detta", "sadana")
EXTERNAL_REFERENCE_PHRASES = (
    "som jag sa",
    "som jag sade",
    "som ledamoten namnde",
    "i ljuset av detta",
    "enligt forslaget",
)
PROCEDURAL_PHRASES = (
    "herr talman",
    "fru talman",
    "yrkar bifall",
    "jag vill borja med att tacka",
    "med detta yrkar jag",
)
RESERVATION_RE = re.compile(r"\breservation(?:en|er)?\s+\d+\b")
COMMITTEE_REPORT_RE = re.compile(r"\b(?:betankande|utlatande)\s+\d{4}/\d{2}:\w+\d+\b")
TOKEN_RE = re.compile(r"[\wåäöÅÄÖ]+", re.UNICODE)
NAME_RE = re.compile(r"\b[A-ZÅÄÖ][a-zåäö]{2,}\b")


@dataclass(frozen=True)
class CandidateFilterContext:
    """C6 filter inputs for one candidate window."""

    speech: Speech
    transcript: Transcript
    audio_features: AudioFeatures
    scenes: Sequence[Scene]
    window: CandidateWindow

    @property
    def text(self) -> str:
        return window_text(self.transcript, self.window)

    @property
    def first_sentence(self) -> str:
        sentences = window_sentences(self.transcript, self.window)
        return sentences[0].text if sentences else ""

    @property
    def words(self) -> tuple[Word, ...]:
        return window_words(self.transcript, self.window)


FilterPredicate = Callable[[CandidateFilterContext], tuple[bool, str | None]]


def apply_hard_filters(context: CandidateFilterContext) -> str | None:
    """Return the first rejection reason, or `None` when the candidate passes."""

    for predicate in HARD_FILTERS:
        passed, reason = predicate(context)
        if not passed:
            return reason
    return None


def candidate_filter_features(context: CandidateFilterContext) -> dict[str, float]:
    """Return cheap absolute features computed during C6 filtering."""

    duration_s = context.window.duration_s
    words = context.words
    nearest_cut_s = nearest_cut_distance_s(context.scenes, context.window.start_s)
    return {
        "duration_s": duration_s,
        "sentence_count": float(
            context.window.sentence_span.end_index - context.window.sentence_span.start_index + 1
        ),
        "word_count": float(len(words)),
        "mean_word_probability": mean_word_probability(words),
        "dead_air_frac": dead_air_fraction(
            context.audio_features.pauses,
            start_s=context.window.start_s,
            end_s=context.window.end_s,
        ),
        "nearest_cut_distance_s": nearest_cut_s if math.isfinite(nearest_cut_s) else 1_000_000.0,
    }


def passes_dangling_opener(context: CandidateFilterContext) -> tuple[bool, str | None]:
    first = _normalized_text(context.first_sentence)
    tokens = _tokens(first)
    if not tokens:
        return False, "dangling_opener"
    if first.startswith("som sagt"):
        return False, "dangling_opener"
    if tokens[0] in DANGLING_OPENERS or tokens[0] in BARE_PRONOUN_OPENERS:
        return False, "dangling_opener"
    return True, None


def passes_procedural_boilerplate(context: CandidateFilterContext) -> tuple[bool, str | None]:
    first = _normalized_text(context.first_sentence)
    if any(phrase in first for phrase in PROCEDURAL_PHRASES):
        return False, "procedural_boilerplate"
    if RESERVATION_RE.search(first) or COMMITTEE_REPORT_RE.search(first):
        return False, "procedural_boilerplate"
    return True, None


def passes_dead_air(context: CandidateFilterContext) -> tuple[bool, str | None]:
    fraction = dead_air_fraction(
        context.audio_features.pauses,
        start_s=context.window.start_s,
        end_s=context.window.end_s,
    )
    if fraction > MAX_DEAD_AIR_FRACTION:
        return False, "dead_air"
    return True, None


def passes_cut_collision(context: CandidateFilterContext) -> tuple[bool, str | None]:
    distance_s = nearest_cut_distance_s(context.scenes, context.window.start_s)
    if distance_s < CUT_COLLISION_S:
        return False, "cut_collision"
    return True, None


def passes_asr_confidence(context: CandidateFilterContext) -> tuple[bool, str | None]:
    if mean_word_probability(context.words) < LOW_ASR_CONFIDENCE_THRESHOLD:
        return False, "low_asr_confidence"
    return True, None


def passes_orphan_demonstrative(context: CandidateFilterContext) -> tuple[bool, str | None]:
    first = _normalized_text(context.first_sentence)
    if not first.startswith(DEMONSTRATIVE_OPENERS):
        return True, None
    tokens = set(_tokens(_normalized_text(context.text)))
    if tokens & CONTENT_NOUN_HINTS:
        return True, None
    return False, "orphan_demonstrative"


def passes_unbound_pronoun(context: CandidateFilterContext) -> tuple[bool, str | None]:
    tokens = _tokens(_normalized_text(context.first_sentence))
    for index, token in enumerate(tokens[:8]):
        if token in UNBOUND_PRONOUNS:
            if _contains_name_before_pronoun(context.first_sentence, index):
                return True, None
            return False, "unbound_pronoun"
    return True, None


def passes_external_reference(context: CandidateFilterContext) -> tuple[bool, str | None]:
    first = _normalized_text(context.first_sentence)
    if "enligt forslaget" in first:
        rest = _normalized_text(context.text[len(context.first_sentence) :])
        if not (set(_tokens(first)) & CONTENT_NOUN_HINTS) and not (
            set(_tokens(rest)) & CONTENT_NOUN_HINTS
        ):
            return False, "external_reference"
    if any(
        phrase in first for phrase in EXTERNAL_REFERENCE_PHRASES if phrase != "enligt forslaget"
    ):
        return False, "external_reference"
    return True, None


def dead_air_fraction(pauses: Sequence[TimeSpan], *, start_s: float, end_s: float) -> float:
    """Return pause overlap fraction inside a master-relative window."""

    duration_s = end_s - start_s
    if duration_s <= 0.0:
        return 1.0
    dead_air_s = sum(
        max(0.0, min(float(pause.end_s), end_s) - max(float(pause.start_s), start_s))
        for pause in pauses
    )
    return min(1.0, max(0.0, dead_air_s / duration_s))


def mean_word_probability(words: Sequence[Word]) -> float:
    """Return mean ASR word probability for a candidate window."""

    if not words:
        return 0.0
    return sum(float(word.probability) for word in words) / len(words)


def nearest_cut_distance_s(scenes: Sequence[Scene], start_s: float) -> float:
    """Return distance from `start_s` to the nearest internal scene cut."""

    cuts = [float(scene.start_s) for scene in scenes if scene.index > 0]
    if not cuts:
        return math.inf
    return min(abs(start_s - cut_s) for cut_s in cuts)


def _contains_name_before_pronoun(first_sentence: str, pronoun_index: int) -> bool:
    raw_tokens = TOKEN_RE.findall(first_sentence)
    prefix = " ".join(raw_tokens[:pronoun_index])
    return NAME_RE.search(prefix) is not None


def _normalized_text(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    without_marks = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(without_marks.split())


def _tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text)


HARD_FILTERS: tuple[FilterPredicate, ...] = (
    passes_dangling_opener,
    passes_procedural_boilerplate,
    passes_dead_air,
    passes_cut_collision,
    passes_asr_confidence,
    passes_orphan_demonstrative,
    passes_unbound_pronoun,
    passes_external_reference,
)
