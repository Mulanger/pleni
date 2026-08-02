"""Tests for C5 F0 extraction."""

from __future__ import annotations

import math
from array import array

import pytest

from src.features.audio.energy import samples_per_frame
from src.features.audio.pitch import f0_frames


def test_zero_crossing_pitch_estimates_fixed_sine() -> None:
    sample_rate = 16_000
    duration_s = 0.2
    frequency_hz = 220.0
    samples = array(
        "h",
        [
            int(12_000 * math.sin(2.0 * math.pi * frequency_hz * index / sample_rate))
            for index in range(round(duration_s * sample_rate))
        ],
    )

    f0 = f0_frames(
        samples,
        sample_rate=sample_rate,
        frame_samples=samples_per_frame(sample_rate),
        frame_count=round(duration_s * 50.0),
        use_parselmouth=False,
    )

    voiced = [value for value in f0 if value is not None]
    assert len(voiced) >= 8
    assert sum(voiced) / len(voiced) == pytest.approx(frequency_hz, abs=35.0)
