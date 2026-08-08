"""Run the S1 walking skeleton over the committed trimmed debate fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from src.config import get_settings
from src.contracts import MediaInfo, Source
from src.errors import ContractValidationError
from src.logging import configure_logging, stage_logger
from src.media.extract import extract_analysis_assets
from src.media.ffprobe import probe_media
from src.media.scenes import detect_scenes_from_frames, scenes_to_json
from src.paths import WorkPaths, work_paths
from src.stages._io import write_json
from src.stages.audio_features import extract_audio_features_dokid
from src.stages.camera import plan_camera_dokid
from src.stages.candidates import generate_candidates_dokid
from src.stages.publish import publish_dokid
from src.stages.render import render_dokid
from src.stages.segment import segment_dokid
from src.stages.select import select_dokid
from src.stages.track import track_dokid
from src.stages.transcribe import transcribe_dokid

FIXTURE_DOKID = "HD01SfU35"
REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_SOURCE = REPO_ROOT / "tests" / "fixtures" / "debates" / "betankande" / "00_source.json"
FIXTURE_MASTER = REPO_ROOT / "tests" / "fixtures" / "debates" / "betankande" / "master.mp4"
FIXTURE_TRIM_START_S = 500.0


@dataclass(frozen=True)
class SkeletonResult:
    """Artifacts produced by the S1 fixture runner."""

    paths: WorkPaths
    media_info: MediaInfo
    rendered_clips: tuple[Path, ...]
    publish_artifacts: tuple[Path, ...]


def run_fixture(
    *,
    work_dir: Path | str | None = None,
    portraits: object | None = None,
) -> SkeletonResult:
    """Run the S1 skeleton over a local fixture without network access.

    **Publishing is pinned to `local` and must stay that way.** `publish_dokid`
    otherwise falls through to `settings.publish_backend`, and a working `.env`
    sets that to `remote` — so running this fixture, or the slow e2e that calls
    it, uploaded the trimmed 854x480 test clips of `HD01SfU35` to the live Bunny
    zone and wrote them into the public `clips` table. That happened on
    2026-08-07. A fixture runner must not be able to reach production.
    """

    settings = get_settings()
    root = Path(work_dir) if work_dir is not None else settings.work_dir / "s1_fixture"
    paths = work_paths(FIXTURE_DOKID, root=root)
    paths.ensure_directories()

    shutil.copyfile(FIXTURE_MASTER, paths.master)
    media_info = probe_media(paths.master)
    write_json(paths.media_json, media_info.model_dump(mode="json"))
    _write_trimmed_source(paths, media_info)

    extract_analysis_assets(paths.master, paths.analysis_wav, paths.frame_pattern)
    scenes = detect_scenes_from_frames(paths.frames_dir, media_info)
    write_json(paths.scenes_json, scenes_to_json(scenes))

    segment_dokid(FIXTURE_DOKID, work_dir=root)
    transcribe_dokid(FIXTURE_DOKID, work_dir=root)
    extract_audio_features_dokid(FIXTURE_DOKID, work_dir=root)
    generate_candidates_dokid(FIXTURE_DOKID, work_dir=root)
    select_dokid(FIXTURE_DOKID, work_dir=root)
    track_dokid(FIXTURE_DOKID, work_dir=root, portraits=portraits)  # type: ignore[arg-type]
    plan_camera_dokid(FIXTURE_DOKID, work_dir=root)
    rendered = tuple(render_dokid(FIXTURE_DOKID, work_dir=root))
    published = tuple(publish_dokid(FIXTURE_DOKID, work_dir=root, backend="local"))
    return SkeletonResult(
        paths=paths,
        media_info=media_info,
        rendered_clips=rendered,
        publish_artifacts=published,
    )


def main() -> None:
    """Run the walking skeleton fixture."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, default=None, help="Output root for fixture work")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    started = time.monotonic()
    logger = stage_logger("S1_run_fixture", dokid=FIXTURE_DOKID)
    result = run_fixture(work_dir=args.work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info(
        "stage_complete",
        duration_ms=duration_ms,
        rendered=len(result.rendered_clips),
        published=len(result.publish_artifacts),
        work_dir=str(result.paths.debate_dir),
    )
    for clip_path in result.rendered_clips:
        print(clip_path)


def _write_trimmed_source(paths: WorkPaths, media_info: MediaInfo) -> None:
    raw_payload = json.loads(FIXTURE_SOURCE.read_text(encoding="utf-8"))
    if not isinstance(raw_payload, Mapping):
        raise ContractValidationError(f"Fixture source is not a JSON object: {FIXTURE_SOURCE}")
    source = Source.model_validate(raw_payload.get("source"))
    speakers = _required_list(raw_payload.get("speaker_entries"), "speaker_entries")
    official_speeches = _required_list(raw_payload.get("anforanden"), "anforanden")

    trimmed_speakers: list[dict[str, object]] = []
    trimmed_official: list[dict[str, object]] = []
    trim_end_s = FIXTURE_TRIM_START_S + media_info.duration_s
    for index, raw_speaker in enumerate(speakers):
        speaker = _required_mapping(raw_speaker, f"speaker_entries[{index}]")
        start_s = _required_float(speaker.get("start_s"), f"speaker_entries[{index}].start_s")
        duration_s = _required_float(
            speaker.get("duration_s"),
            f"speaker_entries[{index}].duration_s",
        )
        end_s = start_s + duration_s
        if end_s <= FIXTURE_TRIM_START_S or start_s >= trim_end_s:
            continue

        adjusted_start_s = max(0.0, start_s - FIXTURE_TRIM_START_S)
        adjusted_end_s = min(float(media_info.duration_s), end_s - FIXTURE_TRIM_START_S)
        adjusted_duration_s = adjusted_end_s - adjusted_start_s
        if adjusted_duration_s <= 0.0:
            continue

        trimmed_speakers.append(
            {
                "name": _required_str(speaker.get("name"), f"speaker_entries[{index}].name"),
                "party": _optional_str(speaker.get("party")),
                "start_s": adjusted_start_s,
                "duration_s": adjusted_duration_s,
            }
        )

        if index < len(official_speeches):
            official = dict(_required_mapping(official_speeches[index], f"anforanden[{index}]"))
            official["start_s"] = adjusted_start_s
            official["duration_s"] = adjusted_duration_s
            trimmed_official.append(official)

    master_sha256 = hashlib.sha256(paths.master.read_bytes()).hexdigest()
    trimmed_source = source.model_copy(
        update={
            "duration_s": float(media_info.duration_s),
            "master_sha256": master_sha256,
        }
    )
    write_json(
        paths.source_json,
        {
            "source": trimmed_source.model_dump(mode="json"),
            "speaker_entries": trimmed_speakers,
            "anforanden": trimmed_official,
            "official_speech_source": "trimmed fixture from tests/fixtures/debates/betankande",
            "media_urls": {
                "stream_url": None,
                "download_url": paths.master.resolve().as_uri(),
                "audio_url": None,
                "poster_url": None,
            },
        },
    )


def _required_list(value: object, context: str) -> list[object]:
    if not isinstance(value, list):
        raise ContractValidationError(f"Expected array at {context}")
    return value


def _required_mapping(value: object, context: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError(f"Expected object at {context}")
    return cast(Mapping[str, Any], value)


def _required_float(value: object, context: str) -> float:
    if isinstance(value, bool):
        raise ContractValidationError(f"Expected number at {context}")
    if isinstance(value, int | float):
        return float(value)
    raise ContractValidationError(f"Expected number at {context}")


def _required_str(value: object, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractValidationError(f"Expected non-empty string at {context}")
    return value.strip()


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


if __name__ == "__main__":
    main()
