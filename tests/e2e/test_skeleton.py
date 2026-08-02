"""End-to-end test for the S1 walking skeleton."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.config import OUTPUT_HEIGHT, OUTPUT_WIDTH
from src.contracts import PublishResult
from src.media.ffprobe import probe_media
from src.stages.run_fixture import run_fixture
from tests.conftest import assert_matches_golden


@pytest.mark.slow
def test_walking_skeleton_produces_vertical_clip(tmp_path: Path, fixtures_dir: Path) -> None:
    result = run_fixture(work_dir=tmp_path)

    assert len(result.rendered_clips) >= 1
    rendered = result.rendered_clips[0]
    assert rendered.exists()

    media_info = probe_media(rendered)
    assert media_info.width == OUTPUT_WIDTH
    assert media_info.height == OUTPUT_HEIGHT
    assert media_info.has_audio
    assert media_info.duration_s > 0

    assert len(result.publish_artifacts) == len(result.rendered_clips)
    for artifact in result.publish_artifacts:
        PublishResult.model_validate_json(artifact.read_text(encoding="utf-8"))

    selected_ids = {
        artifact.name: [
            item["clip_id"]
            for item in json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(item, dict)
        ]
        for artifact in sorted(result.paths.selected_dir.glob("*.json"))
    }
    assert_matches_golden(selected_ids, fixtures_dir / "golden" / "07_selected_fixture_ids.json")

    track_summary = {
        artifact.name: _track_summary(json.loads(artifact.read_text(encoding="utf-8")))
        for artifact in sorted(result.paths.track_dir.glob("*.json"))
    }
    assert_matches_golden(track_summary, fixtures_dir / "golden" / "08_track_fixture_summary.json")


def _track_summary(payload: object) -> dict[str, object]:
    assert isinstance(payload, dict)
    samples = payload.get("samples")
    assert isinstance(samples, list)
    return {
        "track_id": payload.get("track_id"),
        "sample_count": len(samples),
        "first": _sample_summary(samples[0]) if samples else None,
        "last": _sample_summary(samples[-1]) if samples else None,
    }


def _sample_summary(sample: object) -> dict[str, object]:
    assert isinstance(sample, dict)
    return {
        "t": round(float(sample["t"]), 3),
        "x": round(float(sample["x"]), 3),
        "y": round(float(sample["y"]), 3),
        "w": round(float(sample["w"]), 3),
        "h": round(float(sample["h"]), 3),
        "is_speaking": sample["is_speaking"],
    }
