"""Word-timing alignment helpers for C4.

Internal ASR timestamps are relative to the extracted speech audio window.
Every `Word` emitted from this module is converted back to float seconds
relative to the master debate video, never speech- or clip-relative.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, Protocol, cast

from src.contracts import Speech, Word
from src.errors import StageExecutionError

MIN_WORD_DURATION_S = 0.001
TOKEN_RE = re.compile(r"\S+")


@dataclass(frozen=True)
class TimedWord:
    """ASR word timing relative to the speech audio window, not the master file."""

    text: str
    start_s: float
    end_s: float
    probability: float = 1.0


@dataclass(frozen=True)
class RawTranscript:
    """ASR output with timestamps relative to the requested speech audio window."""

    words: tuple[TimedWord, ...]
    text: str
    model: str
    language: str = "sv"


class SpeechTranscriber(Protocol):
    """Backend that transcribes one speech window into window-relative timings."""

    def transcribe(self, request: TranscriptionRequest) -> RawTranscript:
        """Return raw ASR words relative to `request.speech.start_s`."""


@dataclass(frozen=True)
class TranscriptionRequest:
    """One speech transcription request over C2's analysis audio."""

    speech: Speech
    analysis_wav: Path
    debate_title: str
    initial_prompt: str

    @property
    def duration_s(self) -> float:
        return float(self.speech.end_s - self.speech.start_s)


def to_master_words(
    raw_words: tuple[TimedWord, ...],
    *,
    speech_start_s: float,
    speech_end_s: float,
) -> list[Word]:
    """Convert window-relative raw words to master-relative contract words."""

    if speech_end_s <= speech_start_s:
        raise StageExecutionError("Speech end must be greater than start")

    words: list[Word] = []
    previous_end_s = float(speech_start_s)
    for raw_word in raw_words:
        text = raw_word.text.strip()
        if not text:
            continue

        raw_start_s = max(0.0, float(raw_word.start_s))
        raw_end_s = max(raw_start_s + MIN_WORD_DURATION_S, float(raw_word.end_s))
        start_s = max(float(speech_start_s) + raw_start_s, previous_end_s)
        end_s = min(float(speech_start_s) + raw_end_s, float(speech_end_s))
        if end_s <= start_s:
            if start_s + MIN_WORD_DURATION_S > speech_end_s:
                continue
            end_s = start_s + MIN_WORD_DURATION_S

        probability = min(1.0, max(0.0, float(raw_word.probability)))
        words.append(Word(text=text, start_s=start_s, end_s=end_s, probability=probability))
        previous_end_s = end_s
    return words


def timing_coverage(words: list[Word] | tuple[Word, ...], speech: Speech) -> float:
    """Return transcript coverage as a fraction of the speech interval."""

    duration_s = float(speech.end_s - speech.start_s)
    if duration_s <= 0.0:
        return 0.0
    if not words:
        return 0.0
    covered_s = float(words[-1].end_s - words[0].start_s)
    return min(1.0, max(0.0, covered_s / duration_s))


def official_text_to_timed_words(text: str, *, duration_s: float) -> tuple[TimedWord, ...]:
    """Distribute official transcript words across a speech window.

    This deterministic path is used for tests, local fixtures, and optional
    official-protocol timing. It emits window-relative timestamps; callers must
    pass the result through `to_master_words`.
    """

    tokens = _tokens(text)
    if not tokens:
        return ()
    safe_duration_s = max(duration_s, len(tokens) * MIN_WORD_DURATION_S)
    step_s = safe_duration_s / len(tokens)
    words: list[TimedWord] = []
    for index, token in enumerate(tokens):
        start_s = step_s * index
        end_s = safe_duration_s if index == len(tokens) - 1 else step_s * (index + 1)
        words.append(TimedWord(text=token, start_s=start_s, end_s=end_s, probability=1.0))
    return tuple(words)


def project_official_text_to_asr_timing(
    official_text: str,
    asr_words: list[Word] | tuple[Word, ...],
    *,
    speech_start_s: float,
    speech_end_s: float,
) -> list[Word]:
    """Project official transcript tokens onto an existing master-relative timing span."""

    tokens = _tokens(official_text)
    if not tokens:
        return list(asr_words)

    if asr_words:
        start_s = float(asr_words[0].start_s)
        end_s = float(asr_words[-1].end_s)
    else:
        start_s = float(speech_start_s)
        end_s = float(speech_end_s)

    duration_s = max(end_s - start_s, len(tokens) * MIN_WORD_DURATION_S)
    raw_words = official_text_to_timed_words(" ".join(tokens), duration_s=duration_s)
    return to_master_words(raw_words, speech_start_s=start_s, speech_end_s=start_s + duration_s)


def whisperx_align_available() -> bool:
    """Return whether the optional WhisperX package can be imported."""

    try:
        import importlib.util

        return importlib.util.find_spec("whisperx") is not None
    except (ImportError, ValueError):
        return False


def align_with_whisperx(
    *,
    audio_path: Path,
    segments: list[dict[str, Any]],
    language: str,
    device: str,
) -> list[dict[str, Any]]:
    """Run WhisperX forced alignment and return aligned segment dictionaries.

    This wrapper keeps WhisperX as a runtime dependency of the model path only.
    Unit tests exercise the pure alignment functions above; live/model tests can
    cover this wrapper when model assets are available.
    """

    try:
        whisperx = cast(Any, import_module("whisperx"))
    except ImportError as exc:
        raise StageExecutionError("whisperx is not installed") from exc

    try:
        audio = whisperx.load_audio(str(audio_path))
        align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
        aligned = whisperx.align(
            segments,
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
    except Exception as exc:
        raise StageExecutionError(f"WhisperX alignment failed: {exc}") from exc

    word_segments = cast(dict[str, Any], aligned).get("segments")
    if not isinstance(word_segments, list):
        raise StageExecutionError("WhisperX alignment returned no segments")
    return [cast(dict[str, Any], segment) for segment in word_segments if isinstance(segment, dict)]


def _tokens(text: str) -> list[str]:
    return [match.group(0) for match in TOKEN_RE.finditer(" ".join(text.split()))]
