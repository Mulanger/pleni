"""Sentence-boundary candidate windows for C6.

All window times are float seconds relative to the master debate video, never
relative to a speech or clip.

## Why the sentence boundaries need correcting

A window is built from sentence start and end times, which sounds exact and is
not. C4 has never run speech recognition (ADR 011): it takes Riksdagen's
authoritative transcript and **distributes the words evenly** across the speech
window, every word in `HD10367` landing exactly 0.4119 s after the last. Sentence
boundaries derived from that are linear interpolations, not observations of when
anybody stopped talking, and real speech does not keep a metronome.

Measured over 517 published clips: **61% of clip ends land at more than half of
that speech's normal speaking loudness** — cut mid-utterance — and only 11% fall
inside an actual pause. Median distance from a clip end to the nearest real pause
is 1.35 s.

C5's pauses come from the waveform rather than from metadata, so they are
evidence. Snapping to them replaces a derived guess with a measurement, which is
the same move `src/segment/refine.py` already makes when it snaps speech
boundaries to scene cuts.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from src.contracts import Sentence, SentenceSpan, TimeSpan, Transcript, Word


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
    pauses: Sequence[TimeSpan] = (),
    max_snap_s: float = 0.0,
    lead_in_s: float = 0.0,
    tail_s: float = 0.0,
) -> list[CandidateWindow]:
    """Generate overlapping windows that start and end on sentence boundaries.

    With `pauses` and a positive `max_snap_s`, each window's edges are moved to
    the nearest measured silence, so a clip begins when speech begins and ends
    when it stops rather than wherever interpolation happened to fall. Snapping
    is applied *before* the duration filters, so a snapped window is admitted on
    its real length.
    """

    windows: list[CandidateWindow] = []
    for start_index, start_sentence in enumerate(sentences):
        for end_index in range(start_index, len(sentences)):
            end_sentence = sentences[end_index]
            if float(end_sentence.end_s - start_sentence.start_s) > max_duration_s + max_snap_s:
                break
            window = snap_window_to_pauses(
                CandidateWindow(
                    sentence_span=SentenceSpan(start_index=start_index, end_index=end_index),
                    start_s=float(start_sentence.start_s),
                    end_s=float(end_sentence.end_s),
                ),
                pauses,
                max_snap_s=max_snap_s,
                lead_in_s=lead_in_s,
                tail_s=tail_s,
            )
            if not min_duration_s <= window.duration_s <= max_duration_s:
                continue
            windows.append(window)
    return windows


def snap_window_to_pauses(
    window: CandidateWindow,
    pauses: Sequence[TimeSpan],
    *,
    max_snap_s: float,
    lead_in_s: float = 0.0,
    tail_s: float = 0.0,
) -> CandidateWindow:
    """Move a window's edges onto measured silence, when one is close enough.

    A clip should open as the speaker starts and close as they stop, so the start
    snaps to the **end** of a nearby pause and the end snaps to the **start** of
    one. Each edge moves independently, neither moves further than `max_snap_s`,
    and a window whose edges would cross is left alone.

    `lead_in_s` and `tail_s` then back each edge a little way *into* that silence.
    Landing exactly on the first phoneme clips it and sounds abrupt, and ending on
    the last one is equally sudden; a fraction of a second of room either side is
    what makes a cut sound deliberate. The padding is clamped inside the pause it
    came from, so it never reaches back into the neighbouring sentence.
    """

    if max_snap_s <= 0.0 or not pauses:
        return window

    start_s = window.start_s
    opening = _nearest_pause(window.start_s, pauses, edge="end", max_snap_s=max_snap_s)
    if opening is not None:
        start_s = max(float(opening.start_s), float(opening.end_s) - lead_in_s)

    end_s = window.end_s
    closing = _nearest_pause(window.end_s, pauses, edge="start", max_snap_s=max_snap_s)
    if closing is not None:
        end_s = min(float(closing.end_s), float(closing.start_s) + tail_s)

    if end_s - start_s <= 0.0:
        return window
    return CandidateWindow(
        sentence_span=window.sentence_span, start_s=start_s, end_s=end_s
    )


def _nearest_pause(
    t: float, pauses: Sequence[TimeSpan], *, edge: str, max_snap_s: float
) -> TimeSpan | None:
    """The closest pause whose chosen edge is within reach of `t`."""

    best: TimeSpan | None = None
    best_distance = max_snap_s
    for pause in pauses:
        value = float(pause.end_s) if edge == "end" else float(pause.start_s)
        distance = abs(value - t)
        if distance <= best_distance:
            best_distance = distance
            best = pause
    return best


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
