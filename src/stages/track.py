"""C8 stage: detect and track the active speaker face for selected clips."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from src.config import Settings, get_settings
from src.contracts import FaceTrack, MediaInfo, SelectedClip, Speech
from src.errors import ArtifactError
from src.logging import configure_logging, stage_logger
from src.media.extract import ANALYSIS_FRAME_FPS
from src.paths import work_paths
from src.stages._io import read_model, read_model_list, write_json
from src.vision.asd import HeuristicActiveSpeakerBackend
from src.vision.detect import (
    FrameDetections,
    HaarFaceDetector,
    build_face_detector,
    inset_from_fractions,
    scale_detections_to_media,
)
from src.vision.track import build_face_tracks, frame_times


def track_dokid(dokid: str, *, work_dir: Path | str) -> list[Path]:
    """Write one `08_track/<clip_id>.json` artifact per selected clip."""

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    media_info = read_model(paths.media_json, MediaInfo, "C2 media artifact")
    selected = _read_selected_clips(dokid, Path(work_dir))
    detector = build_face_detector(settings.face_detector_backend)
    written: list[Path] = []
    for clip in selected:
        track = build_track_for_clip(
            clip,
            frames_dir=paths.frames_dir,
            media_info=media_info,
            detector=detector,
            settings=settings,
        )
        artifact = paths.track_json(clip.clip_id)
        write_json(artifact, track.model_dump(mode="json"))
        written.append(artifact)
    return written


def build_track_for_clip(
    clip: SelectedClip,
    *,
    frames_dir: Path,
    media_info: MediaInfo,
    detector: HaarFaceDetector,
    settings: Settings,
) -> FaceTrack:
    """Build the C8 active face track for one selected clip."""

    detections = _frame_detections_for_clip(
        clip,
        frames_dir=frames_dir,
        media_info=media_info,
        detector=detector,
        settings=settings,
    )
    tracks = build_face_tracks(
        detections,
        iou_threshold=settings.face_track_iou_threshold,
        max_gap_s=settings.face_track_max_gap_s,
    )
    return HeuristicActiveSpeakerBackend().select(
        clip.clip_id,
        tracks,
        frame_width=float(media_info.width),
        frame_height=float(media_info.height),
        expected_times=frame_times(detections),
        max_gap_s=settings.face_track_max_gap_s,
    )


def main() -> None:
    """Run the C8 face tracking stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C8_track", dokid=args.dokid)
    artifacts = track_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


def _frame_detections_for_clip(
    clip: SelectedClip,
    *,
    frames_dir: Path,
    media_info: MediaInfo,
    detector: HaarFaceDetector,
    settings: Settings,
) -> tuple[FrameDetections, ...]:
    frame_paths = _frame_paths_for_clip(clip, frames_dir)
    detections: list[FrameDetections] = []
    for frame_path in frame_paths:
        t = _frame_time_s(frame_path)
        image_size, faces = detector.detect(
            frame_path,
            min_size_frac=settings.face_min_size_frac,
            inset=None,
            fallback=True,
        )
        inset = inset_from_fractions(
            image_size,
            x_frac=settings.sign_language_inset_x_frac,
            y_frac=settings.sign_language_inset_y_frac,
            w_frac=settings.sign_language_inset_w_frac,
            h_frac=settings.sign_language_inset_h_frac,
        )
        if inset is not None:
            image_size, faces = detector.detect(
                frame_path,
                min_size_frac=settings.face_min_size_frac,
                inset=inset,
                fallback=True,
            )
        detections.append(
            FrameDetections(
                t=t,
                faces=scale_detections_to_media(
                    faces,
                    image_size=image_size,
                    media_info=media_info,
                ),
            )
        )
    return tuple(detections)


def _frame_paths_for_clip(clip: SelectedClip, frames_dir: Path) -> tuple[Path, ...]:
    if not frames_dir.exists():
        raise ArtifactError(f"C2 analysis frames directory is missing: {frames_dir}")
    frame_paths = tuple(
        path
        for path in sorted(frames_dir.glob("*.jpg"))
        if float(clip.start_s) <= _frame_time_s(path) < float(clip.end_s)
    )
    if not frame_paths:
        raise ArtifactError(f"No C2 analysis frames overlap selected clip: {clip.clip_id}")
    return frame_paths


def _frame_time_s(frame_path: Path) -> float:
    frame_number = int(frame_path.stem)
    return (frame_number - 1) / ANALYSIS_FRAME_FPS


def _read_selected_clips(dokid: str, work_dir: Path) -> list[SelectedClip]:
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
