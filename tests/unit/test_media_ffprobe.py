"""Tests for C2 media probing."""

from __future__ import annotations

from pathlib import Path

from src.contracts import MediaInfo
from src.media.ffprobe import probe_media


def test_probe_synthetic_fixture() -> None:
    info = probe_media(Path("tests/fixtures/synthetic/hard_cut_20s.mp4"))

    assert info == MediaInfo(
        width=1920,
        height=1080,
        fps=25.0,
        duration_s=20.0,
        has_audio=True,
        video_codec="h264",
    )


def test_probe_betankande_fixture() -> None:
    info = probe_media(Path("tests/fixtures/debates/betankande/master.mp4"))

    assert info.width == 854
    assert info.height == 480
    assert info.fps == 25.0
    assert info.duration_s == 180.0
    assert info.has_audio is True
    assert info.video_codec == "h264"
