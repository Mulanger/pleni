"""C2 stage: acquire master media, probe it, and extract reusable analysis assets."""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from pydantic import ValidationError

from src.config import get_settings
from src.contracts import MediaInfo, Source
from src.errors import ArtifactError, ContractValidationError
from src.logging import configure_logging, stage_logger
from src.media.download import DownloadResult, download_with_resume, is_hls_url, remux_hls_to_mp4
from src.media.extract import extract_analysis_assets
from src.media.ffprobe import probe_media
from src.media.scenes import detect_scenes_from_frames, scenes_to_json
from src.paths import work_paths


@dataclass(frozen=True)
class SourceMedia:
    """Validated media references carried by the C1 source artifact."""

    source: Source
    download_url: str | None
    stream_url: str | None


@dataclass(frozen=True)
class AcquireResult:
    """Artifacts written by C2 acquisition."""

    media_json: Path
    scenes_json: Path
    download: DownloadResult
    media_info: MediaInfo


def acquire_dokid(dokid: str, *, work_dir: Path | str) -> AcquireResult:
    """Run C2 acquisition for a debate that already has C1 `00_source.json`."""

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    paths.ensure_directories()
    source_media = _read_source_media(paths.source_json)
    media_url = _select_media_url(source_media)

    if is_hls_url(media_url):
        download = remux_hls_to_mp4(
            media_url,
            paths.master,
            user_agent=settings.riksdagen_user_agent,
        )
    else:
        download = download_with_resume(
            media_url,
            paths.master,
            expected_sha256=source_media.source.master_sha256,
            user_agent=settings.riksdagen_user_agent,
            timeout_s=settings.http_timeout_s,
            max_retries=settings.max_http_retries,
        )

    media_info = probe_media(paths.master)
    _write_json(paths.media_json, media_info.model_dump(mode="json"))

    extract_analysis_assets(paths.master, paths.analysis_wav, paths.frame_pattern)
    scenes = detect_scenes_from_frames(paths.frames_dir, media_info)
    _write_json(paths.scenes_json, scenes_to_json(scenes))

    return AcquireResult(
        media_json=paths.media_json,
        scenes_json=paths.scenes_json,
        download=download,
        media_info=media_info,
    )


def main() -> None:
    """Run the C2 acquisition stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C2_acquire", dokid=args.dokid)
    result = acquire_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info(
        "stage_complete",
        duration_ms=duration_ms,
        master=str(result.download.path),
        media=str(result.media_json),
        scenes=str(result.scenes_json),
        bytes=result.download.bytes_written,
        sha256=result.download.sha256,
    )
    print(result.media_json)


def _read_source_media(source_json: Path) -> SourceMedia:
    if not source_json.exists():
        raise ArtifactError(f"C1 source artifact is missing: {source_json}")
    payload = json.loads(source_json.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ContractValidationError(f"C1 source artifact is not a JSON object: {source_json}")
    try:
        source = Source.model_validate(payload.get("source"))
    except ValidationError as exc:
        raise ContractValidationError(
            f"C1 source artifact failed Source validation: {exc}"
        ) from exc

    media_urls = _required_mapping(payload.get("media_urls"), "media_urls")
    return SourceMedia(
        source=source,
        download_url=_optional_str(media_urls.get("download_url")),
        stream_url=_optional_str(media_urls.get("stream_url")),
    )


def _select_media_url(source_media: SourceMedia) -> str:
    media_url = source_media.download_url or source_media.stream_url
    if media_url is None:
        raise ArtifactError(f"C1 source artifact has no media URL for {source_media.source.dokid}")
    return media_url


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _required_mapping(value: object, context: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError(f"Expected object at {context}")
    return cast(Mapping[str, Any], value)


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


if __name__ == "__main__":
    main()
