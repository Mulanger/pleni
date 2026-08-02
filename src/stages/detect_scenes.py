"""C2 stage: detect camera-cut scenes from extracted analysis frames."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from pydantic import ValidationError

from src.config import get_settings
from src.contracts import MediaInfo
from src.errors import ArtifactError, ContractValidationError
from src.logging import configure_logging, stage_logger
from src.media.scenes import detect_scenes_from_frames, scenes_to_json
from src.paths import work_paths


def detect_scenes_dokid(dokid: str, *, work_dir: Path | str) -> Path:
    """Detect scenes for a debate with existing C2 media and frame artifacts."""

    paths = work_paths(dokid, root=Path(work_dir))
    media_info = _read_media_info(paths.media_json)
    scenes = detect_scenes_from_frames(paths.frames_dir, media_info)
    paths.scenes_json.write_text(
        json.dumps(scenes_to_json(scenes), indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return paths.scenes_json


def main() -> None:
    """Run the C2 scene detection stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C2_detect_scenes", dokid=args.dokid)
    artifact = detect_scenes_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifact=str(artifact))
    print(artifact)


def _read_media_info(media_json: Path) -> MediaInfo:
    if not media_json.exists():
        raise ArtifactError(f"C2 media artifact is missing: {media_json}")
    try:
        return MediaInfo.model_validate_json(media_json.read_text(encoding="utf-8"))
    except ValidationError as exc:
        raise ContractValidationError(f"C2 media artifact failed validation: {exc}") from exc


if __name__ == "__main__":
    main()
