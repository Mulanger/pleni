"""C3 stage: refine Riksdagen speaker metadata into speech boundaries."""

from __future__ import annotations

import argparse
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

from pydantic import ValidationError

from src.config import get_settings
from src.contracts import MediaInfo, Scene, Source, SpeakerEntry, Speech
from src.errors import ArtifactError, ContractValidationError
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.segment.pairing import pair_official_speeches
from src.segment.refine import MetadataSpeech, RefinedBoundary, refine_boundaries
from src.segment.vad import detect_voice_activity
from src.stages._io import read_json_object, read_model, read_model_list, write_json


def segment_dokid(dokid: str, *, work_dir: Path | str) -> Path:
    """Write `03_speeches.json` from C1 source plus C2 media/scene artifacts."""

    paths = work_paths(dokid, root=Path(work_dir))
    payload = read_json_object(paths.source_json, "C1 source artifact")
    source = Source.model_validate(payload.get("source"))
    speakers = _read_speaker_entries(payload)
    official = _read_official_speeches(payload)
    media_info = read_model(paths.media_json, MediaInfo, "C2 media artifact")
    scenes = _read_scenes(paths.scenes_json)
    if not paths.analysis_wav.exists():
        raise ArtifactError(f"C2 analysis WAV is missing: {paths.analysis_wav}")

    metadata_speeches = _metadata_speeches(source, speakers, official)
    vad_segments = detect_voice_activity(paths.analysis_wav)
    refined = refine_boundaries(
        metadata_speeches,
        vad_segments=vad_segments,
        scenes=scenes,
        media_duration_s=float(media_info.duration_s),
    )
    speeches_out = [_speech_from_boundary(source, boundary) for boundary in refined]
    write_json(paths.speeches_json, [speech.model_dump(mode="json") for speech in speeches_out])
    return paths.speeches_json


def main() -> None:
    """Run C3 speech-boundary refinement."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C3_segment", dokid=args.dokid)
    artifact = segment_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifact=str(artifact))
    print(artifact)


def _metadata_speeches(
    source: Source,
    speakers: list[SpeakerEntry],
    official_speeches: list[Mapping[str, Any]],
) -> list[MetadataSpeech]:
    metadata: list[MetadataSpeech] = []
    # Aligned by name, not by index. The official record can carry an entry with
    # no video segment -- a chair announcement -- and zipping by index then
    # shifted every later speech onto the wrong speaker. See src/segment/pairing.
    paired = pair_official_speeches(speakers, official_speeches)
    for index, (speaker, matched) in enumerate(zip(speakers, paired, strict=True)):
        official: Mapping[str, Any] = matched or {}
        anforande_id = _optional_str(official.get("anforande_id")) or f"{index + 1:04d}"
        official_text = _optional_str(official.get("official_text"))
        # The video metadata's name is the fallback, never the loser of a guess:
        # an unmatched segment keeps the name and party that describe the person
        # actually on screen, and simply has no official transcript.
        speaker_name = _optional_str(official.get("speaker_name")) or speaker.name
        party = (
            _optional_str(official.get("party"))
            or _optional_str(official.get("parti"))
            or speaker.party
        )
        metadata.append(
            MetadataSpeech(
                anforande_id=anforande_id,
                speaker_name=speaker_name,
                party=party,
                anforandetyp=_optional_str(official.get("anforandetyp")),
                official_text=official_text,
                start_s=float(speaker.start_s),
                end_s=float(speaker.start_s + speaker.duration_s),
            )
        )
    return metadata


def _speech_from_boundary(source: Source, boundary: RefinedBoundary) -> Speech:
    metadata = boundary.metadata
    return Speech(
        speech_id=f"{source.dokid}_{metadata.anforande_id}",
        dokid=source.dokid,
        speaker_name=metadata.speaker_name,
        party=metadata.party,
        anforandetyp=metadata.anforandetyp,
        start_s=boundary.start_s,
        end_s=boundary.end_s,
        official_text=metadata.official_text,
        alignment_confidence=boundary.confidence.confidence,
        needs_review=boundary.confidence.needs_review,
    )


def _read_speaker_entries(payload: Mapping[str, Any]) -> list[SpeakerEntry]:
    raw_speakers = payload.get("speaker_entries")
    if not isinstance(raw_speakers, list):
        raise ContractValidationError("C1 source artifact is missing speaker_entries array")
    try:
        return [SpeakerEntry.model_validate(item) for item in raw_speakers]
    except ValidationError as exc:
        raise ContractValidationError(f"C1 speaker_entries failed validation: {exc}") from exc


def _read_official_speeches(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw_speeches = payload.get("anforanden")
    if raw_speeches is None:
        return []
    if not isinstance(raw_speeches, list):
        raise ContractValidationError("C1 source artifact anforanden must be an array")
    official_speeches: list[Mapping[str, Any]] = []
    for item in raw_speeches:
        if not isinstance(item, Mapping):
            raise ContractValidationError("C1 source artifact anforanden entries must be objects")
        official_speeches.append(cast(Mapping[str, Any], item))
    return official_speeches


def _read_scenes(path: Path) -> list[Scene]:
    return read_model_list(path, Scene, "C2 scenes artifact")


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


if __name__ == "__main__":
    main()
