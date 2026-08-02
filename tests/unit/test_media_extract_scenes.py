"""Tests for C2 analysis extraction and scene detection."""

from __future__ import annotations

from pathlib import Path

from src.media.extract import ANALYSIS_FRAME_FPS, extract_analysis_assets
from src.media.ffprobe import probe_media
from src.media.scenes import detect_scenes_from_frames, scenes_to_json
from tests.conftest import assert_matches_golden


def test_extract_analysis_assets_writes_audio_and_frames(tmp_path: Path) -> None:
    result = extract_analysis_assets(
        Path("tests/fixtures/synthetic/hard_cut_20s.mp4"),
        tmp_path / "analysis.wav",
        tmp_path / "frames" / "%06d.jpg",
    )

    assert result.analysis_wav.exists()
    assert result.analysis_wav.stat().st_size > 0
    assert result.frame_count == 100


def test_detect_scenes_against_synthetic_golden(tmp_path: Path) -> None:
    media_info = probe_media(Path("tests/fixtures/synthetic/hard_cut_20s.mp4"))
    extract_analysis_assets(
        Path("tests/fixtures/synthetic/hard_cut_20s.mp4"),
        tmp_path / "analysis.wav",
        tmp_path / "frames" / "%06d.jpg",
    )

    scenes = detect_scenes_from_frames(
        tmp_path / "frames",
        media_info,
        frame_fps=ANALYSIS_FRAME_FPS,
    )

    assert len(scenes) == 2
    assert_matches_golden(
        scenes_to_json(scenes),
        Path("tests/fixtures/golden/02_scenes_synthetic.json"),
    )
