"""C1 stage: discover one Riksdagen webb-tv document and write `00_source.json`."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from src.config import get_settings
from src.errors import ExternalServiceError
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.riksdagen.client import RiksdagenClient
from src.riksdagen.parser import (
    RiksdagenParseError,
    metadata_with_official_anforanden,
    parse_video_response,
    source_artifact,
)


def discover_dokid(dokid: str, *, work_dir: Path | str) -> Path:
    """Fetch one dokid and write the C1 source artifact."""

    settings = get_settings()
    client = RiksdagenClient(
        user_agent=settings.riksdagen_user_agent,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    payload = client.fetch_video_metadata_payload(dokid)
    metadata = parse_video_response(payload)
    try:
        official_anforanden = client.fetch_official_anforanden(
            dokid=metadata.source.dokid,
            debate_date=metadata.source.debate_date,
        )
    except (ExternalServiceError, RiksdagenParseError):
        official_anforanden = ()
    if official_anforanden:
        metadata = metadata_with_official_anforanden(
            metadata,
            official_anforanden,
            source="open_data_anforandelista+xml",
        )

    paths = work_paths(metadata.source.dokid, root=Path(work_dir))
    paths.ensure_directories()
    artifact_path = paths.source_json
    artifact_path.write_text(
        json.dumps(source_artifact(metadata), indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return artifact_path


def main() -> None:
    """Run the C1 discover stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dokid",
        required=True,
        help="Riksdagen document id, for example HDC120260305fs",
    )
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C1_discover", dokid=args.dokid)
    artifact_path = discover_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifact=str(artifact_path))
    print(artifact_path)


if __name__ == "__main__":
    main()
