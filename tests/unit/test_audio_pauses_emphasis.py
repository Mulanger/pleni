"""Tests for C5 pause and emphasis event detection."""

from __future__ import annotations

import pytest

from src.features.audio.emphasis import detect_emphasis_events
from src.features.audio.pauses import detect_pauses


def test_detect_pauses_finds_known_silence_gap() -> None:
    frame_hz = 50.0
    rms = [0.2] * 50 + [0.0] * 25 + [0.2] * 50

    pauses = detect_pauses(rms, speech_start_s=100.0, speech_end_s=102.5, frame_hz=frame_hz)

    assert len(pauses) == 1
    assert pauses[0].start_s == pytest.approx(101.0)
    assert pauses[0].end_s == pytest.approx(101.5)


def test_detect_pauses_ignores_short_gaps() -> None:
    rms = [0.2] * 10 + [0.0] * 10 + [0.2] * 10

    assert detect_pauses(rms, speech_start_s=0.0, speech_end_s=0.6, frame_hz=50.0) == []


def test_detect_emphasis_events_finds_local_energy_burst() -> None:
    rms = [0.1] * 40 + [0.6] * 4 + [0.1] * 40

    events = detect_emphasis_events(rms, speech_start_s=30.0, speech_end_s=31.68, frame_hz=50.0)

    assert len(events) == 1
    assert events[0].start_s == pytest.approx(30.8)
    assert events[0].end_s == pytest.approx(30.88)
