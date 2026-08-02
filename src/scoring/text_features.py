"""Deterministic C7 text and structure features for Swedish debate clips."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Sequence

from src.candidates.windows import CandidateWindow, window_sentences, window_text
from src.contracts import Candidate, Speech, Transcript

TOKEN_RE = re.compile(r"[\wåäöÅÄÖ]+", re.UNICODE)
NUMBER_RE = re.compile(r"\b\d+(?:[,.]\d+)?\b|\b\d+\s*(?:procent|kronor|miljoner|miljarder)\b")
NAME_RE = re.compile(r"\b[A-ZÅÄÖ][a-zåäö]{2,}\b")
SECOND_PERSON = frozenset({"du", "dig", "din", "ditt", "dina", "ni", "er", "ert", "era"})
NEGATIONS = frozenset({"inte", "aldrig", "varken", "ingen", "inget", "inga", "ej"})
SUPERLATIVES = frozenset(
    {
        "bast",
        "samst",
        "storst",
        "storsta",
        "varst",
        "varsta",
        "minst",
        "hogst",
        "lagst",
        "historisk",
        "historiskt",
    }
)
POSITIVE_WORDS = frozenset(
    {
        "bra",
        "battre",
        "bast",
        "stark",
        "trygg",
        "frihet",
        "ansvar",
        "mojlighet",
    }
)
NEGATIVE_WORDS = frozenset(
    {
        "dalig",
        "samre",
        "samst",
        "kris",
        "problem",
        "hot",
        "oro",
        "fel",
        "misslyckats",
    }
)
REASON_MARKERS = (
    "darfor",
    "eftersom",
    "det betyder att",
    "pa grund av",
    "leder till",
    "innebar att",
)
BOILERPLATE_PHRASES = (
    "herr talman",
    "fru talman",
    "yrkar bifall",
    "jag vill borja med att tacka",
    "med detta yrkar jag",
)
DANGLING_OPENERS = frozenset(
    {"och", "men", "det", "den", "darfor", "han", "hon", "de", "dem", "hen"}
)


def compute_text_features(
    candidate: Candidate,
    speech: Speech,
    transcript: Transcript,
    all_speeches: Sequence[Speech],
) -> dict[str, float]:
    """Compute deterministic text, structure, and metadata features for one candidate."""

    text = window_text_from_candidate(candidate, transcript)
    normalized = normalize_text(text)
    tokens = tokenized(normalized)
    sentences = [
        sentence.text for sentence in window_sentences(transcript, _candidate_window(candidate))
    ]
    first_sentence = sentences[0] if sentences else text
    speech_text = " ".join(sentence.text for sentence in transcript.sentences)
    features = {
        "second_person_density": _density(tokens, SECOND_PERSON),
        "question_count": float(text.count("?")),
        "negation_density": _density(tokens, NEGATIONS),
        "superlative_count": float(_superlative_count(normalized, tokens)),
        "number_density": _number_density(text, tokens),
        "ner_density": _named_entity_density(text, tokens),
        "anaphora_score": _anaphora_score(sentences),
        "sentiment_intensity": _sentiment_intensity(tokens),
        "novelty": _novelty(normalized, speech_text),
        "boilerplate_sim": _boilerplate_similarity(normalized),
        "self_contained": _self_contained(first_sentence, text),
        "hook_density": _hook_density(tokens),
        "has_claim_and_reason": _has_claim_and_reason(normalized),
        "face_height_frac": 1.0,
        "is_replik": 1.0 if (speech.anforandetyp or "").casefold() == "replik" else 0.0,
        "names_opponent": _names_opponent(text, speech, all_speeches),
        "applause_after": 1.0 if "(appl" in normalized else 0.0,
        "talman_intervention": 1.0 if "(talmannen:" in normalized else 0.0,
    }
    return features


def window_text_from_candidate(candidate: Candidate, transcript: Transcript) -> str:
    """Return normalized display text for a candidate span."""

    return window_text(transcript, _candidate_window(candidate))


def title_from_candidate_text(text: str, *, max_chars: int = 60) -> str:
    """Return the phase-1 title fallback: first sentence truncated on a word boundary."""

    first_sentence = re.split(r"(?<=[.!?])\s+", text.strip(), maxsplit=1)[0].strip()
    if not first_sentence:
        first_sentence = text.strip()
    if len(first_sentence) <= max_chars:
        return first_sentence
    truncated = first_sentence[:max_chars].rsplit(" ", maxsplit=1)[0].strip()
    return truncated if truncated else first_sentence[:max_chars].rstrip()


def normalize_text(text: str) -> str:
    """Casefold and remove accents while preserving punctuation needed by features."""

    decomposed = unicodedata.normalize("NFKD", text.casefold())
    without_marks = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(without_marks.split())


def tokenized(normalized_text: str) -> list[str]:
    """Tokenize normalized text."""

    return TOKEN_RE.findall(normalized_text)


def _candidate_window(candidate: Candidate) -> CandidateWindow:
    return CandidateWindow(
        sentence_span=candidate.sentence_span,
        start_s=float(candidate.start_s),
        end_s=float(candidate.end_s),
    )


def _density(tokens: Sequence[str], vocabulary: frozenset[str]) -> float:
    if not tokens:
        return 0.0
    return sum(1 for token in tokens if token in vocabulary) / len(tokens)


def _superlative_count(normalized: str, tokens: Sequence[str]) -> int:
    count = sum(1 for token in tokens if token in SUPERLATIVES)
    if "aldrig tidigare" in normalized:
        count += 1
    return count


def _number_density(text: str, tokens: Sequence[str]) -> float:
    if not tokens:
        return 0.0
    return len(NUMBER_RE.findall(text.casefold())) / len(tokens)


def _named_entity_density(text: str, tokens: Sequence[str]) -> float:
    if not tokens:
        return 0.0
    names = [match.group(0) for match in NAME_RE.finditer(text)]
    filtered = [name for name in names if name not in {"Herr", "Fru", "Talman"}]
    return len(filtered) / len(tokens)


def _anaphora_score(sentences: Sequence[str]) -> float:
    prefixes: list[str] = []
    for sentence in sentences:
        for clause in re.split(r"(?<=[.!?;:])\s+", sentence):
            tokens = tokenized(normalize_text(clause))
            if len(tokens) >= 2:
                prefixes.append(" ".join(tokens[:2]))
    if len(prefixes) < 2:
        return 0.0
    counts = Counter(prefixes)
    repeated = sum(count - 1 for count in counts.values() if count > 1)
    return repeated / max(1, len(prefixes) - 1)


def _sentiment_intensity(tokens: Sequence[str]) -> float:
    if not tokens:
        return 0.0
    positive = sum(1 for token in tokens if token in POSITIVE_WORDS)
    negative = sum(1 for token in tokens if token in NEGATIVE_WORDS)
    return abs(positive - negative) / len(tokens)


def _novelty(candidate_normalized: str, speech_text: str) -> float:
    candidate_tokens = set(tokenized(candidate_normalized))
    speech_tokens = set(tokenized(normalize_text(speech_text)))
    rest_tokens = speech_tokens - candidate_tokens
    if not candidate_tokens or not rest_tokens:
        return 0.0
    overlap = len(candidate_tokens & rest_tokens) / len(candidate_tokens)
    return 1.0 - overlap


def _boilerplate_similarity(normalized: str) -> float:
    matches = sum(1 for phrase in BOILERPLATE_PHRASES if phrase in normalized)
    return min(1.0, matches / 2.0)


def _self_contained(first_sentence: str, full_text: str) -> float:
    tokens = tokenized(normalize_text(first_sentence))
    if not tokens or tokens[0] in DANGLING_OPENERS:
        return 0.0
    if not full_text.strip().endswith((".", "!", "?", ")")):
        return 0.5
    return 1.0


def _hook_density(tokens: Sequence[str]) -> float:
    hook_tokens = tokens[:10]
    if not hook_tokens:
        return 0.0
    signals = SECOND_PERSON | NEGATIONS | SUPERLATIVES
    return sum(1 for token in hook_tokens if token in signals) / len(hook_tokens)


def _has_claim_and_reason(normalized: str) -> float:
    return 1.0 if any(marker in normalized for marker in REASON_MARKERS) else 0.0


def _names_opponent(text: str, speech: Speech, all_speeches: Sequence[Speech]) -> float:
    normalized = normalize_text(text)
    speaker_name = normalize_text(speech.speaker_name)
    for other in all_speeches:
        if other.speech_id == speech.speech_id:
            continue
        other_parts = [
            part for part in tokenized(normalize_text(other.speaker_name)) if len(part) >= 4
        ]
        if (
            other_parts
            and not all(part in speaker_name for part in other_parts)
            and any(part in normalized for part in other_parts)
        ):
            return 1.0
    return 0.0
