"""C6v stage: where is the expected speaker on screen, for a whole speech.

Runs between C6 and C7 so that selection can prefer a window the speaker is
actually visible in. See `src/vision/timeline.py` for why this is per speech
rather than per candidate, and ADR 013 for the decision.
"""

from __future__ import annotations

import argparse
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from src.config import Settings, get_settings
from src.contracts import MediaInfo, Scene, Speech
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.stages._io import read_model, read_model_list, write_json
from src.stages.track import (
    _anforande_id,
    _frame_detections_for_clip,
    _portrait_source,
    _read_roster,
    _shot_frame_counts,
)
from src.vision.detect import FaceDetector, build_face_detector
from src.vision.identity import (
    EnrolledPortrait,
    EnrolmentCache,
    FaceEmbedder,
    IdentityThresholds,
    PortraitSource,
)
from src.vision.timeline import (
    SpeechVisibility,
    build_speech_visibility,
    shot_bounds_for_span,
    visibility_payload,
)
from src.vision.track import build_face_tracks


def vision_dokid(
    dokid: str,
    *,
    work_dir: Path | str,
    portraits: PortraitSource | None = None,
) -> list[Path]:
    """Write one `06_vision/<speech_id>.json` timeline per speech."""

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    media_info = read_model(paths.media_json, MediaInfo, "C2 media artifact")
    scenes = read_model_list(paths.scenes_json, Scene, "C2 scenes artifact")
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    roster = _read_roster(paths.source_json)

    detector = build_face_detector(
        settings.face_detector_backend,
        score_threshold=settings.face_score_threshold,
        nms_threshold=settings.face_nms_threshold,
        top_k=settings.face_top_k,
    )
    embedder = FaceEmbedder()
    gallery = EnrolmentCache(
        portraits=portraits or _portrait_source(settings, Path(work_dir)),
        detector=detector,
        embedder=embedder,
    )

    written: list[Path] = []
    for speech in speeches:
        visibility = build_visibility_for_speech(
            speech,
            frames_dir=paths.frames_dir,
            media_info=media_info,
            scenes=scenes,
            detector=detector,
            embedder=embedder,
            portrait=gallery.feature_for(roster.get(_anforande_id(speech.speech_id))),
            settings=settings,
        )
        artifact = paths.vision_json(speech.speech_id)
        write_json(artifact, visibility_payload(visibility))
        written.append(artifact)
    return written


def build_visibility_for_speech(
    speech: Speech,
    *,
    frames_dir: Path,
    media_info: MediaInfo,
    scenes: Sequence[Scene],
    detector: FaceDetector,
    embedder: FaceEmbedder,
    portrait: EnrolledPortrait | None,
    settings: Settings,
) -> SpeechVisibility:
    """Detect, identify and reduce one speech to a visibility timeline."""

    cuts = tuple(
        float(scene.start_s)
        for scene in scenes
        if scene.index > 0 and float(speech.start_s) < float(scene.start_s) < float(speech.end_s)
    )
    frames = _frame_detections_for_clip(
        _SpeechWindow.of(speech),
        frames_dir=frames_dir,
        media_info=media_info,
        detector=detector,
        embedder=embedder,
        portrait=portrait,
        cuts=cuts,
        settings=settings,
    )
    tracks = build_face_tracks(
        frames,
        iou_threshold=settings.face_track_iou_threshold,
        max_gap_s=settings.face_track_max_gap_s,
        cuts=cuts,
        merge_gap_s=settings.face_track_merge_gap_s,
        merge_iou=settings.face_track_merge_iou,
    )
    return build_speech_visibility(
        speech.speech_id,
        tracks,
        shot_bounds=shot_bounds_for_span(float(speech.start_s), float(speech.end_s), cuts),
        shot_frame_counts=_shot_frame_counts(frames, cuts),
        frame_width=float(media_info.width),
        thresholds=IdentityThresholds(
            min_embeddings=settings.identity_min_embeddings,
            min_median_similarity=settings.identity_min_median_similarity,
            min_p20_similarity=settings.identity_min_p20_similarity,
            min_competitor_margin=settings.identity_min_competitor_margin,
        ),
        has_portrait=portrait is not None,
    )


@dataclass
class _SpeechWindow:
    """A `Speech` seen through the `ClipWindow` interface the frame reader takes.

    Both stages must read the same frames through the same detector, so C6v
    reuses C8's loop rather than keeping a second copy that can drift.
    """

    clip_id: str
    start_s: float
    end_s: float

    @classmethod
    def of(cls, speech: Speech) -> _SpeechWindow:
        return cls(
            clip_id=speech.speech_id,
            start_s=float(speech.start_s),
            end_s=float(speech.end_s),
        )


def main() -> None:
    """Run the C6v speaker-visibility stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C6v_vision", dokid=args.dokid)
    artifacts = vision_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


if __name__ == "__main__":
    main()
