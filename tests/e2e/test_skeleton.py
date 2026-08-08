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


class _FixturePortrait:
    """Offline enrolment for the e2e.

    The fixture's speakers have real `intressent_id`s, so the production portrait
    source would fetch from Riksdagen — and this test runs in CI, where a test
    must not need the network. The enrolment image is cropped from the fixture's
    own footage, which adds no personal data the committed `master.mp4` does not
    already contain. Identity *accuracy* is covered by the unit and integration
    tests; what this asserts is that the chain runs end to end and stays stable.
    """

    def fetch(self, intressent_id: str) -> bytes | None:
        return Path("tests/fixtures/debates/betankande/speaker_enrolment.jpg").read_bytes()


@pytest.mark.slow
def test_walking_skeleton_produces_vertical_clip(tmp_path: Path, fixtures_dir: Path) -> None:
    result = run_fixture(work_dir=tmp_path, portraits=_FixturePortrait())

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
        "decision": payload.get("decision"),
        "sample_count": len(samples),
        "detected_count": sum(
            1
            for sample in samples
            if isinstance(sample, dict) and sample.get("source") == "detected"
        ),
        "unsupported_spans": len(payload.get("unsupported_spans") or []),
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
        "source": sample["source"],
    }


@pytest.mark.slow
def test_the_fixture_runner_cannot_publish_to_production(tmp_path: Path) -> None:
    """A regression guard with an incident behind it.

    `publish_dokid` falls through to `settings.publish_backend` when given no
    backend, and a working `.env` sets that to `remote`. So every run of this
    fixture -- including the slow e2e above -- uploaded the trimmed 854x480 test
    clips of HD01SfU35 to the live Bunny zone and inserted them into the public
    `clips` table, alongside 1,762 real ones. Two clips reached pleni.se on
    2026-08-07 before anyone noticed.

    The fixture runner now pins `backend="local"`. This asserts the published
    artifacts carry `file://` URLs, which no remote publish can produce.
    """

    result = run_fixture(work_dir=tmp_path, portraits=_FixturePortrait())

    assert result.publish_artifacts, "the fixture should still publish locally"
    for artifact in result.publish_artifacts:
        published = PublishResult.model_validate_json(artifact.read_text(encoding="utf-8"))
        for rendition, url in published.cdn_urls.items():
            assert url.startswith("file://"), (
                f"{rendition} points at {url} -- the fixture reached a remote backend"
            )
