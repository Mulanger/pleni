"""C6 stage: generate sentence-aligned candidates and apply hard filters."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from src.candidates.filters import (
    CandidateFilterContext,
    apply_hard_filters,
    candidate_filter_features,
)
from src.candidates.windows import CandidateWindow, generate_sentence_windows
from src.config import get_settings
from src.contracts import AudioFeatures, Candidate, Scene, Speech, Transcript
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.stages._io import read_model, read_model_list, write_json


def generate_candidates_dokid(dokid: str, *, work_dir: Path | str) -> list[Path]:
    """Write one `06_candidates/<speech_id>.json` artifact per speech."""

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    scenes = read_model_list(paths.scenes_json, Scene, "C2 scenes artifact")
    written: list[Path] = []
    for speech in speeches:
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
        candidates = build_candidates_for_speech(
            speech,
            transcript,
            audio_features,
            scenes,
            min_duration_s=settings.min_candidate_s,
            max_duration_s=settings.max_candidate_s,
            max_snap_s=settings.cut_snap_max_s,
            lead_in_s=settings.cut_lead_in_s,
            tail_s=settings.cut_tail_s,
        )
        artifact = paths.candidates_json(speech.speech_id)
        write_json(artifact, [candidate.model_dump(mode="json") for candidate in candidates])
        written.append(artifact)
    return written


def build_candidates_for_speech(
    speech: Speech,
    transcript: Transcript,
    audio_features: AudioFeatures,
    scenes: list[Scene],
    *,
    min_duration_s: float,
    max_duration_s: float,
    max_snap_s: float = 0.0,
    lead_in_s: float = 0.0,
    tail_s: float = 0.0,
) -> list[Candidate]:
    """Build C6 candidates for one speech from sentence-boundary windows.

    `audio_features.pauses` come from the waveform, so they are the only
    evidence available here about when anyone actually stopped talking; the
    sentence times are interpolated. See `src.candidates.windows`.
    """

    windows = generate_sentence_windows(
        transcript.sentences,
        min_duration_s=min_duration_s,
        max_duration_s=max_duration_s,
        pauses=audio_features.pauses,
        max_snap_s=max_snap_s,
        lead_in_s=lead_in_s,
        tail_s=tail_s,
    )
    return [
        _candidate_from_window(
            speech,
            transcript,
            audio_features,
            scenes,
            window,
        )
        for window in windows
    ]


def main() -> None:
    """Run the C6 candidate generation stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C6_candidates", dokid=args.dokid)
    artifacts = generate_candidates_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


def _candidate_from_window(
    speech: Speech,
    transcript: Transcript,
    audio_features: AudioFeatures,
    scenes: list[Scene],
    window: CandidateWindow,
) -> Candidate:
    context = CandidateFilterContext(
        speech=speech,
        transcript=transcript,
        audio_features=audio_features,
        scenes=scenes,
        window=window,
    )
    reject_reason = apply_hard_filters(context)
    features = candidate_filter_features(context)
    return Candidate(
        speech_id=speech.speech_id,
        start_s=window.start_s,
        end_s=window.end_s,
        sentence_span=window.sentence_span,
        features=features,
        archetype_scores={},
        sub_scores={
            "filter.dead_air_frac": features["dead_air_frac"],
            "filter.mean_word_probability": features["mean_word_probability"],
        },
        gate_passed=reject_reason is None,
        reject_reason=reject_reason,
    )


if __name__ == "__main__":
    main()
