"""F0 extraction for C5 audio features."""

from __future__ import annotations

import importlib.util
import math
from collections.abc import Sequence
from importlib import import_module
from typing import Any, cast

PITCH_FLOOR_HZ = 75.0
PITCH_CEILING_HZ = 500.0
MIN_PITCH_FRAME_AMPLITUDE = 500


def f0_frames(
    samples: Sequence[int],
    *,
    sample_rate: int,
    frame_samples: int,
    frame_count: int,
    use_parselmouth: bool = True,
) -> list[float | None]:
    """Return one F0 estimate per C5 frame."""

    if use_parselmouth and parselmouth_available():
        parselmouth_result = _f0_with_parselmouth(
            samples,
            sample_rate=sample_rate,
            frame_samples=frame_samples,
            frame_count=frame_count,
        )
        if parselmouth_result is not None:
            return parselmouth_result
    return _f0_with_zero_crossings(
        samples,
        sample_rate=sample_rate,
        frame_samples=frame_samples,
        frame_count=frame_count,
    )


def parselmouth_available() -> bool:
    """Return whether Praat-Parselmouth can be imported."""

    try:
        return importlib.util.find_spec("parselmouth") is not None
    except (ImportError, ValueError):
        return False


def _f0_with_parselmouth(
    samples: Sequence[int],
    *,
    sample_rate: int,
    frame_samples: int,
    frame_count: int,
) -> list[float | None] | None:
    if not samples:
        return [None] * frame_count

    try:
        parselmouth = cast(Any, import_module("parselmouth"))
        values = [float(sample) / 32768.0 for sample in samples]
        sound = parselmouth.Sound(values, sampling_frequency=sample_rate)
        pitch = sound.to_pitch(
            time_step=frame_samples / sample_rate,
            pitch_floor=PITCH_FLOOR_HZ,
            pitch_ceiling=PITCH_CEILING_HZ,
        )
        duration_s = len(samples) / sample_rate
        result: list[float | None] = []
        for frame_index in range(frame_count):
            t_s = min(duration_s, (frame_index + 0.5) * frame_samples / sample_rate)
            value = float(pitch.get_value_at_time(t_s))
            result.append(value if math.isfinite(value) and value > 0.0 else None)
        return result
    except Exception:
        return None


def _f0_with_zero_crossings(
    samples: Sequence[int],
    *,
    sample_rate: int,
    frame_samples: int,
    frame_count: int,
) -> list[float | None]:
    estimates: list[float | None] = []
    for frame_index in range(frame_count):
        start = frame_index * frame_samples
        end = min(len(samples), start + frame_samples)
        estimates.append(_estimate_frame_zero_crossing(samples[start:end], sample_rate=sample_rate))
    return estimates


def _estimate_frame_zero_crossing(frame: Sequence[int], *, sample_rate: int) -> float | None:
    if len(frame) < 2:
        return None

    max_abs = max(abs(sample) for sample in frame)
    if max_abs < MIN_PITCH_FRAME_AMPLITUDE:
        return None

    threshold = max(MIN_PITCH_FRAME_AMPLITUDE, round(max_abs * 0.05))
    previous_sign = _sign_with_threshold(frame[0], threshold)
    crossings = 0
    for sample in frame[1:]:
        sign = _sign_with_threshold(sample, threshold)
        if sign == 0:
            continue
        if previous_sign != 0 and sign != previous_sign:
            crossings += 1
        previous_sign = sign

    if crossings < 2:
        return None
    f0_hz = crossings * sample_rate / (2.0 * (len(frame) - 1))
    if PITCH_FLOOR_HZ <= f0_hz <= PITCH_CEILING_HZ:
        return f0_hz
    return None


def _sign_with_threshold(value: int, threshold: int) -> int:
    if value > threshold:
        return 1
    if value < -threshold:
        return -1
    return 0
