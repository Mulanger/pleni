"""Pause detection from C5 frame-level energy."""

from __future__ import annotations

import math
from collections.abc import Sequence

from src.contracts import TimeSpan

MIN_PAUSE_S = 0.400
MIN_SILENCE_THRESHOLD = 0.005
ACTIVE_ENERGY_FRACTION = 0.08


def detect_pauses(
    rms: Sequence[float],
    *,
    speech_start_s: float,
    speech_end_s: float,
    frame_hz: float,
    min_pause_s: float = MIN_PAUSE_S,
    threshold: float | None = None,
) -> list[TimeSpan]:
    """Detect master-relative silence gaps longer than `min_pause_s`."""

    if not rms:
        return []

    silence_threshold = _silence_threshold(rms) if threshold is None else threshold
    min_frames = max(1, math.ceil(min_pause_s * frame_hz))
    pauses: list[TimeSpan] = []
    run_start: int | None = None

    for index, value in enumerate(rms):
        if value <= silence_threshold:
            if run_start is None:
                run_start = index
            continue
        if run_start is not None:
            _append_pause(
                pauses,
                run_start,
                index,
                min_frames=min_frames,
                speech_start_s=speech_start_s,
                speech_end_s=speech_end_s,
                frame_hz=frame_hz,
            )
            run_start = None

    if run_start is not None:
        _append_pause(
            pauses,
            run_start,
            len(rms),
            min_frames=min_frames,
            speech_start_s=speech_start_s,
            speech_end_s=speech_end_s,
            frame_hz=frame_hz,
        )
    return pauses


def _append_pause(
    pauses: list[TimeSpan],
    start_index: int,
    end_index: int,
    *,
    min_frames: int,
    speech_start_s: float,
    speech_end_s: float,
    frame_hz: float,
) -> None:
    if end_index - start_index < min_frames:
        return
    start_s = speech_start_s + start_index / frame_hz
    end_s = min(speech_end_s, speech_start_s + end_index / frame_hz)
    if end_s > start_s:
        pauses.append(TimeSpan(start_s=start_s, end_s=end_s))


def _silence_threshold(rms: Sequence[float]) -> float:
    active_reference = max(rms) if rms else 0.0
    return max(MIN_SILENCE_THRESHOLD, active_reference * ACTIVE_ENERGY_FRACTION)
