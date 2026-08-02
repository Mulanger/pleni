"""C7 stage: score candidates and select a capped archetype portfolio."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from src.config import get_settings
from src.contracts import AudioFeatures, Candidate, SelectedClip, Speech, Transcript
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.scoring.archetypes import score_candidates_for_speech
from src.scoring.select import select_for_speech
from src.stages._io import read_model, read_model_list, write_json


def select_dokid(dokid: str, *, work_dir: Path | str) -> list[Path]:
    """Write selected clip artifacts grouped by speech id."""

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    written: list[Path] = []
    for speech in speeches:
        candidates_path = paths.candidates_json(speech.speech_id)
        candidates = read_model_list(candidates_path, Candidate, "C6 candidates artifact")
        transcript = read_model(
            paths.transcript_json(speech.speech_id),
            Transcript,
            "C4 transcript artifact",
        )
        audio_features = read_model(
            paths.audio_features_json(speech.speech_id),
            AudioFeatures,
            "C5 audio features artifact",
        )
        scored = score_candidates_for_speech(
            candidates,
            speech=speech,
            transcript=transcript,
            audio_features=audio_features,
            all_speeches=speeches,
            confront_weights=settings.confront_weights,
            explain_weights=settings.explain_weights,
            quotable_weights=settings.quotable_weights,
        )
        write_json(candidates_path, [candidate.model_dump(mode="json") for candidate in scored])
        selected = select_for_speech(
            speech=speech,
            transcript=transcript,
            candidates=scored,
            max_overlap_frac=settings.max_clip_overlap_frac,
        )
        artifact = paths.selected_json(speech.speech_id)
        write_json(artifact, [clip.model_dump(mode="json") for clip in selected])
        written.append(artifact)
    return written


def main() -> None:
    """Run the C7 selection stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C7_select", dokid=args.dokid)
    artifacts = select_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


def read_selected_clips(dokid: str, work_dir: Path) -> list[SelectedClip]:
    """Read all C7 selected clip artifacts for a debate."""

    paths = work_paths(dokid, root=work_dir)
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    clips: list[SelectedClip] = []
    for speech in speeches:
        artifact = paths.selected_json(speech.speech_id)
        if artifact.exists():
            clips.extend(read_model_list(artifact, SelectedClip, "C7 selected artifact"))
    return clips


if __name__ == "__main__":
    main()
