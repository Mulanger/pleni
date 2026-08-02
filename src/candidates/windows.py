"""Sentence-boundary candidate windows for C6.

All window times are float seconds relative to the master debate video, never
relative to a speech or clip.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from src.contracts import Sentence, SentenceSpan, Transcript, Word


@dataclass(frozen=True)
class CandidateWindow:
    """Candidate sentence span with master-relative start and end times."""

    sentence_span: SentenceSpan
    start_s: float
    end_s: float

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s


def generate_sentence_windows(
    sentences: Sequence[Sentence],
    *,
    min_duration_s: float,
    max_duration_s: float,
) -> list[CandidateWindow]:
    """Generate overlapping windows that start and end on sentence boundaries."""

    windows: list[CandidateWindow] = []
    for start_index, start_sentence in enumerate(sentences):
        for end_index in range(start_index, len(sentences)):
            end_sentence = sentences[end_index]
            duration_s = float(end_sentence.end_s - start_sentence.start_s)
            if duration_s > max_duration_s:
                break
            if duration_s < min_duration_s:
                continue
            windows.append(
                CandidateWindow(
                    sentence_span=SentenceSpan(start_index=start_index, end_index=end_index),
                    start_s=float(start_sentence.start_s),
                    end_s=float(end_sentence.end_s),
                )
            )
    return windows


def window_sentences(transcript: Transcript, window: CandidateWindow) -> tuple[Sentence, ...]:
    """Return transcript sentences covered by a candidate window."""

    return transcript.sentences[
        window.sentence_span.start_index : window.sentence_span.end_index + 1
    ]


def window_words(transcript: Transcript, window: CandidateWindow) -> tuple[Word, ...]:
    """Return transcript words covered by a candidate window."""

    words: list[Word] = []
    for sentence in window_sentences(transcript, window):
        for index in sentence.word_indices:
            if 0 <= index < len(transcript.words):
                words.append(transcript.words[index])
    if words:
        return tuple(words)
    return tuple(
        word
        for word in transcript.words
        if window.start_s <= word.start_s and word.end_s <= window.end_s
    )


def window_text(transcript: Transcript, window: CandidateWindow) -> str:
    """Return normalized text for a candidate window."""

    return " ".join(
        sentence.text.strip() for sentence in window_sentences(transcript, window)
    ).strip()
