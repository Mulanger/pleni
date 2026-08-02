"""RMS energy and frame-grid helpers for C5 audio features."""

from __future__ import annotations

import math
import sys
import wave
from array import array
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from src.contracts import Speech, Word
from src.errors import ArtifactError, ContractValidationError

FRAME_DURATION_S = 0.020
FRAME_HZ = 1.0 / FRAME_DURATION_S
PCM16_MAX = 32768.0
ROLLING_SPEECH_RATE_WINDOW_S = 5.0


@dataclass(frozen=True)
class AudioBuffer:
    """In-memory view of C2's mono 16-bit analysis audio."""

    sample_rate: int
    samples: array[int]

    @property
    def duration_s(self) -> float:
        return len(self.samples) / self.sample_rate

    def slice_samples(self, start_s: float, end_s: float) -> array[int]:
        """Return samples for a master-relative time span."""

        start_index = max(0, round(start_s * self.sample_rate))
        end_index = min(len(self.samples), max(start_index, round(end_s * self.sample_rate)))
        return self.samples[start_index:end_index]


def read_analysis_wav(path: Path) -> AudioBuffer:
    """Read C2's analysis WAV once as mono PCM16 samples."""

    if not path.exists():
        raise ArtifactError(f"C2 analysis audio is missing: {path}")

    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1:
            raise ContractValidationError(f"Expected mono analysis WAV, got {wav.getnchannels()}")
        if wav.getsampwidth() != 2:
            raise ContractValidationError(
                f"Expected PCM16 analysis WAV, got {wav.getsampwidth()} bytes"
            )
        sample_rate = wav.getframerate()
        raw_frames = wav.readframes(wav.getnframes())

    samples = array("h")
    samples.frombytes(raw_frames)
    if sys.byteorder != "little":
        samples.byteswap()
    return AudioBuffer(sample_rate=sample_rate, samples=samples)


def frame_count_for_speech(speech: Speech, *, frame_hz: float = FRAME_HZ) -> int:
    """Return dense frame count for a C3 speech interval."""

    duration_s = float(speech.end_s - speech.start_s)
    return max(1, math.ceil(duration_s * frame_hz))


def samples_per_frame(sample_rate: int, *, frame_duration_s: float = FRAME_DURATION_S) -> int:
    """Return the sample count for one C5 analysis frame."""

    return max(1, round(sample_rate * frame_duration_s))


def rms_frames(
    samples: Sequence[int],
    *,
    frame_samples: int,
    frame_count: int,
) -> list[float]:
    """Compute normalized RMS energy per frame."""

    rms: list[float] = []
    for frame_index in range(frame_count):
        start = frame_index * frame_samples
        end = min(len(samples), start + frame_samples)
        frame = samples[start:end]
        if not frame:
            rms.append(0.0)
            continue
        square_sum = sum(float(sample) * float(sample) for sample in frame)
        rms.append(math.sqrt(square_sum / len(frame)) / PCM16_MAX)
    return rms


def rolling_speech_rate_wps(
    words: Sequence[Word],
    *,
    speech_start_s: float,
    speech_end_s: float,
    frame_count: int,
    frame_hz: float = FRAME_HZ,
    window_s: float = ROLLING_SPEECH_RATE_WINDOW_S,
) -> list[float]:
    """Compute words per second over a centered rolling window for each frame."""

    if frame_count <= 0:
        return []
    if speech_end_s <= speech_start_s:
        return [0.0] * frame_count

    word_midpoints = [float(word.start_s + word.end_s) / 2.0 for word in words]
    half_window_s = window_s / 2.0
    rates: list[float] = []
    for frame_index in range(frame_count):
        center_s = speech_start_s + (frame_index + 0.5) / frame_hz
        window_start_s = max(speech_start_s, center_s - half_window_s)
        window_end_s = min(speech_end_s, center_s + half_window_s)
        denominator_s = window_end_s - window_start_s
        if denominator_s <= 0.0:
            rates.append(0.0)
            continue
        word_count = sum(
            1 for midpoint_s in word_midpoints if window_start_s <= midpoint_s < window_end_s
        )
        rates.append(word_count / denominator_s)
    return rates
