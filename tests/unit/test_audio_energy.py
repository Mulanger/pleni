"""Tests for C5 energy and speech-rate features."""

from __future__ import annotations

from array import array

from src.contracts import Word
from src.features.audio.energy import (
    FRAME_HZ,
    rms_frames,
    rolling_speech_rate_wps,
    samples_per_frame,
)


def test_rms_frames_tracks_square_envelope() -> None:
    sample_rate = 1_000
    frame_samples = samples_per_frame(sample_rate)
    samples = array("h", [1000] * frame_samples + [0] * frame_samples + [2000] * frame_samples)

    rms = rms_frames(samples, frame_samples=frame_samples, frame_count=3)

    assert rms[0] > 0.03
    assert rms[1] == 0.0
    assert rms[2] > rms[0]


def test_rolling_speech_rate_uses_master_relative_word_times() -> None:
    words = (
        Word(text="ett", start_s=10.0, end_s=10.2, probability=1.0),
        Word(text="två", start_s=11.0, end_s=11.2, probability=1.0),
        Word(text="tre", start_s=16.0, end_s=16.2, probability=1.0),
    )

    rates = rolling_speech_rate_wps(
        words,
        speech_start_s=10.0,
        speech_end_s=20.0,
        frame_count=round(10.0 * FRAME_HZ),
        window_s=5.0,
    )

    assert rates[0] > 0.0
    assert rates[round(3.0 * FRAME_HZ)] < rates[0]
    assert rates[round(6.0 * FRAME_HZ)] > 0.0
