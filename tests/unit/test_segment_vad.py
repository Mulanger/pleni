"""Tests for C3 lightweight VAD."""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

from src.segment.vad import detect_voice_activity

SAMPLE_RATE = 16_000


def test_detect_voice_activity_finds_tone_region(tmp_path: Path) -> None:
    wav_path = tmp_path / "analysis.wav"
    _write_wav(
        wav_path,
        [
            (0.5, 0),
            (1.0, 5000),
            (0.5, 0),
        ],
    )

    segments = detect_voice_activity(wav_path)

    assert len(segments) == 1
    assert 0.45 <= segments[0].start_s <= 0.55
    assert 1.45 <= segments[0].end_s <= 1.55


def _write_wav(path: Path, spans: list[tuple[float, int]]) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        for duration_s, amplitude in spans:
            samples = int(duration_s * SAMPLE_RATE)
            for index in range(samples):
                value = 0
                if amplitude:
                    value = int(amplitude * math.sin(2.0 * math.pi * 440.0 * index / SAMPLE_RATE))
                wav.writeframesraw(struct.pack("<h", value))
