"""Emphasis event detection from local energy peaks."""

from __future__ import annotations

import math
from collections.abc import Sequence

from src.contracts import TimeSpan

LOCAL_WINDOW_S = 2.0
EMPHASIS_STD_MULTIPLIER = 1.5
MIN_EMPHASIS_RMS = 0.01


def detect_emphasis_events(
    rms: Sequence[float],
    *,
    speech_start_s: float,
    speech_end_s: float,
    frame_hz: float,
    local_window_s: float = LOCAL_WINDOW_S,
    std_multiplier: float = EMPHASIS_STD_MULTIPLIER,
) -> list[TimeSpan]:
    """Detect master-relative local energy bursts."""

    if not rms:
        return []

    window_frames = max(1, round(local_window_s * frame_hz))
    half_window_frames = max(1, window_frames // 2)
    active_frames: list[bool] = []
    for index, value in enumerate(rms):
        start = max(0, index - half_window_frames)
        end = min(len(rms), index + half_window_frames + 1)
        local_values = rms[start:end]
        mean = sum(local_values) / len(local_values)
        variance = sum((sample - mean) ** 2 for sample in local_values) / len(local_values)
        std = math.sqrt(variance)
        active_frames.append(
            std > 0.0 and value >= MIN_EMPHASIS_RMS and value > mean + std_multiplier * std
        )

    return _spans_from_active_frames(
        active_frames,
        speech_start_s=speech_start_s,
        speech_end_s=speech_end_s,
        frame_hz=frame_hz,
    )


def _spans_from_active_frames(
    active_frames: Sequence[bool],
    *,
    speech_start_s: float,
    speech_end_s: float,
    frame_hz: float,
) -> list[TimeSpan]:
    spans: list[TimeSpan] = []
    run_start: int | None = None
    for index, is_active in enumerate(active_frames):
        if is_active:
            if run_start is None:
                run_start = index
            continue
        if run_start is not None:
            spans.append(_timespan(run_start, index, speech_start_s, speech_end_s, frame_hz))
            run_start = None
    if run_start is not None:
        spans.append(
            _timespan(run_start, len(active_frames), speech_start_s, speech_end_s, frame_hz)
        )
    return spans


def _timespan(
    start_index: int,
    end_index: int,
    speech_start_s: float,
    speech_end_s: float,
    frame_hz: float,
) -> TimeSpan:
    start_s = speech_start_s + start_index / frame_hz
    end_s = min(speech_end_s, speech_start_s + end_index / frame_hz)
    if end_s <= start_s:
        end_s = start_s + 1.0 / frame_hz
    return TimeSpan(start_s=start_s, end_s=end_s)
