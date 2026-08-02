"""Tests for the canonical work artifact layout."""

from __future__ import annotations

from pathlib import Path

from src.paths import work_paths


def test_work_paths_match_contract_layout() -> None:
    paths = work_paths("H901AU1", root=Path("work"))

    assert paths.master == Path("work/H901AU1/master.mp4")
    assert paths.analysis_wav == Path("work/H901AU1/analysis.wav")
    assert paths.frame_pattern == Path("work/H901AU1/frames/%06d.jpg")
    assert paths.source_json == Path("work/H901AU1/00_source.json")
    assert paths.media_json == Path("work/H901AU1/01_media.json")
    assert paths.scenes_json == Path("work/H901AU1/02_scenes.json")
    assert paths.speeches_json == Path("work/H901AU1/03_speeches.json")
    assert paths.transcript_json("speech-1") == Path("work/H901AU1/04_transcript/speech-1.json")
    assert paths.audio_features_json("speech-1") == Path(
        "work/H901AU1/05_audio_features/speech-1.json"
    )
    assert paths.candidates_json("speech-1") == Path("work/H901AU1/06_candidates/speech-1.json")
    assert paths.selected_json("speech-1") == Path("work/H901AU1/07_selected/speech-1.json")
    assert paths.track_json("clip-1") == Path("work/H901AU1/08_track/clip-1.json")
    assert paths.camera_json("clip-1") == Path("work/H901AU1/09_camera/clip-1.json")
    assert paths.render_primary_mp4("clip-1") == Path("work/H901AU1/10_render/clip-1_540x960.mp4")
    assert paths.render_low_mp4("clip-1") == Path("work/H901AU1/10_render/clip-1_360x640.mp4")
    assert paths.render_thumb("clip-1") == Path("work/H901AU1/10_render/clip-1.webp")
    assert paths.render_vtt("clip-1") == Path("work/H901AU1/10_render/clip-1.vtt")
    assert paths.publish_json("clip-1") == Path("work/H901AU1/11_publish/clip-1.json")


def test_ensure_directories(tmp_path: Path) -> None:
    paths = work_paths("H901AU1", root=tmp_path)

    paths.ensure_directories()

    assert paths.debate_dir.is_dir()
    assert paths.frames_dir.is_dir()
    assert paths.transcript_dir.is_dir()
    assert paths.audio_features_dir.is_dir()
    assert paths.candidates_dir.is_dir()
    assert paths.selected_dir.is_dir()
    assert paths.track_dir.is_dir()
    assert paths.camera_dir.is_dir()
    assert paths.render_dir.is_dir()
    assert paths.publish_dir.is_dir()
