"""C8 stage: verify and track the expected speaker's face for selected clips."""

from __future__ import annotations

import argparse
import json
import time
from bisect import bisect_right
from collections.abc import Sequence
from importlib import import_module
from itertools import pairwise
from pathlib import Path
from typing import Any, Protocol, cast

from src.config import Settings, get_settings
from src.contracts import FaceTrack, MediaInfo, Scene, SelectedClip, Speech
from src.errors import ArtifactError
from src.logging import configure_logging, stage_logger
from src.media.extract import ANALYSIS_FRAME_FPS
from src.paths import work_paths
from src.riksdagen.client import RiksdagenClient
from src.stages._io import read_model, read_model_list, write_json
from src.vision.asd import IdentityVerifiedBackend
from src.vision.detect import (
    DetectedFace,
    FaceDetector,
    FrameDetections,
    SignLanguageInset,
    build_face_detector,
    inset_from_fractions,
    intersects_inset,
    scale_detections_to_media,
)
from src.vision.identity import (
    EnrolledPortrait,
    EnrolmentCache,
    FaceEmbedder,
    IdentityThresholds,
    PortraitSource,
    RiksdagenPortraitSource,
    cosine_similarity,
    roster_from_source,
)
from src.vision.track import build_face_tracks, frame_times


def track_dokid(
    dokid: str,
    *,
    work_dir: Path | str,
    portraits: PortraitSource | None = None,
) -> list[Path]:
    """Write one `08_track/<clip_id>.json` artifact per selected clip.

    `portraits` is an injection seam matching C4's transcriber: tests supply a
    local enrolment image so the identity path runs without the network.
    """

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    media_info = read_model(paths.media_json, MediaInfo, "C2 media artifact")
    scenes = read_model_list(paths.scenes_json, Scene, "C2 scenes artifact")
    selected = _read_selected_clips(dokid, Path(work_dir))
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
    backend = IdentityVerifiedBackend(
        thresholds=IdentityThresholds(
            min_embeddings=settings.identity_min_embeddings,
            min_median_similarity=settings.identity_min_median_similarity,
            min_p20_similarity=settings.identity_min_p20_similarity,
            min_competitor_margin=settings.identity_min_competitor_margin,
        ),
        min_verified_frac=settings.identity_min_verified_frac,
        max_unsupported_gap_s=settings.identity_max_unsupported_gap_s,
    )

    written: list[Path] = []
    for clip in selected:
        track = build_track_for_clip(
            clip,
            frames_dir=paths.frames_dir,
            media_info=media_info,
            scenes=scenes,
            detector=detector,
            embedder=embedder,
            gallery=gallery,
            backend=backend,
            intressent_id=roster.get(_anforande_id(clip.speech_id)),
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
    scenes: Sequence[Scene],
    detector: FaceDetector,
    embedder: FaceEmbedder,
    gallery: EnrolmentCache,
    backend: IdentityVerifiedBackend,
    intressent_id: str | None,
    settings: Settings,
) -> FaceTrack:
    """Build the C8 verified speaker track for one clip."""

    portrait = gallery.feature_for(intressent_id)
    cuts = _cuts_inside_clip(clip, scenes)
    frames = _frame_detections_for_clip(
        clip,
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
    return backend.select(
        clip.clip_id,
        tracks,
        shot_bounds=_shot_bounds(clip, cuts),
        shot_frame_counts=_shot_frame_counts(frames, cuts),
        intressent_id=intressent_id,
        portrait_sha256=portrait.digest if portrait is not None else None,
        expected_times=frame_times(frames),
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


def _portrait_source(settings: Settings, work_dir: Path) -> PortraitSource:
    client = RiksdagenClient(
        user_agent=settings.riksdagen_user_agent,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    return RiksdagenPortraitSource(client, work_dir / settings.portrait_cache_dirname)


class ClipWindow(Protocol):
    """The minimum a frame reader needs: a named master-relative interval.

    C6v hands whole speeches to the same reader C8 hands clips to, so that both
    stages see identical frames through an identical detector rather than two
    copies of the loop drifting apart.
    """

    @property
    def clip_id(self) -> str:
        """Name used in error messages and artifact paths."""

    @property
    def start_s(self) -> float:
        """Master-relative start."""

    @property
    def end_s(self) -> float:
        """Master-relative end."""


def _frame_detections_for_clip(
    clip: ClipWindow,
    *,
    frames_dir: Path,
    media_info: MediaInfo,
    detector: FaceDetector,
    embedder: FaceEmbedder,
    portrait: EnrolledPortrait | None,
    cuts: Sequence[float],
    settings: Settings,
) -> tuple[FrameDetections, ...]:
    """Detect faces, and measure identity on a spread subset of frames.

    Identity is measured **here**, before boxes are scaled to master pixels,
    because `alignCrop` needs YuNet's landmarks in the coordinate system of the
    image it is given. Doing it later would mean re-detecting to recover them.

    SFace runs on roughly `identity_embeddings_per_second` frames rather than all
    of them: consecutive 5 fps frames of someone at a lectern are near-duplicates,
    so independent evidence comes from spacing samples out, not taking more.
    """

    cv2 = cast(Any, import_module("cv2"))
    frame_paths = _frame_paths_for_clip(clip, frames_dir)
    stride = max(1, round(ANALYSIS_FRAME_FPS / max(settings.identity_embeddings_per_second, 1e-6)))
    # The grid alone can skip a short shot entirely, which then reads as "no
    # identity evidence" when the truth is "never asked". Every shot's first and
    # last frame are sampled regardless of stride.
    edges = _shot_edge_indices([_frame_time_s(path) for path in frame_paths], cuts)
    detections: list[FrameDetections] = []
    # Every analysis frame comes from one ffmpeg `scale` and so has the same
    # dimensions. The inset is derived from those dimensions alone, so it is
    # resolved from the first frame and reused: detecting twice per frame just
    # to learn the image size doubled the detector cost of the whole stage.
    inset: SignLanguageInset | None = None
    inset_resolved = False
    for index, frame_path in enumerate(frame_paths):
        image_size, faces = detector.detect(
            frame_path,
            min_size_frac=settings.face_min_size_frac,
            inset=inset,
        )
        if not inset_resolved:
            inset = inset_from_fractions(
                image_size,
                x_frac=settings.sign_language_inset_x_frac,
                y_frac=settings.sign_language_inset_y_frac,
                w_frac=settings.sign_language_inset_w_frac,
                h_frac=settings.sign_language_inset_h_frac,
            )
            inset_resolved = True
            if inset is not None:
                faces = tuple(face for face in faces if not intersects_inset(face, inset))
        if portrait is not None and faces and (index % stride == 0 or index in edges):
            image = cv2.imread(str(frame_path))
            if image is not None:
                faces = _measure_identity(faces, image, embedder, portrait)
        detections.append(
            FrameDetections(
                t=_frame_time_s(frame_path),
                faces=scale_detections_to_media(
                    faces,
                    image_size=image_size,
                    media_info=media_info,
                ),
            )
        )
    return tuple(detections)


def _measure_identity(
    faces: Sequence[DetectedFace],
    image: Any,
    embedder: FaceEmbedder,
    portrait: EnrolledPortrait,
) -> tuple[DetectedFace, ...]:
    measured: list[DetectedFace] = []
    for face in faces:
        feature = embedder.embed(image, face.detection_row())
        if feature is None:
            measured.append(face)
            continue
        measured.append(face.with_similarity(cosine_similarity(feature, portrait.feature)))
    return tuple(measured)


def _shot_edge_indices(times: Sequence[float], cuts: Sequence[float]) -> set[int]:
    """Frame indices that open or close a shot inside the clip."""

    boundaries = sorted(float(cut) for cut in cuts)
    by_shot: dict[int, list[int]] = {}
    for index, t in enumerate(times):
        by_shot.setdefault(bisect_right(boundaries, float(t)), []).append(index)
    edges: set[int] = set()
    for indices in by_shot.values():
        edges.add(indices[0])
        edges.add(indices[-1])
    return edges


def _cuts_inside_clip(clip: SelectedClip, scenes: Sequence[Scene]) -> tuple[float, ...]:
    return tuple(
        float(scene.start_s)
        for scene in scenes
        if scene.index > 0 and float(clip.start_s) < float(scene.start_s) < float(clip.end_s)
    )


def _shot_bounds(clip: SelectedClip, cuts: Sequence[float]) -> dict[int, tuple[float, float]]:
    edges = [float(clip.start_s), *sorted(cuts), float(clip.end_s)]
    return {
        index: (start, end) for index, (start, end) in enumerate(pairwise(edges)) if end > start
    }


def _shot_frame_counts(frames: Sequence[FrameDetections], cuts: Sequence[float]) -> dict[int, int]:
    boundaries = sorted(float(cut) for cut in cuts)
    counts: dict[int, int] = {}
    for frame in frames:
        index = bisect_right(boundaries, float(frame.t))
        counts[index] = counts.get(index, 0) + 1
    return counts


def _frame_paths_for_clip(clip: ClipWindow, frames_dir: Path) -> tuple[Path, ...]:
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


def _anforande_id(speech_id: str) -> str:
    _dokid, _sep, anforande_id = speech_id.partition("_")
    return anforande_id


def _read_roster(source_json: Path) -> dict[str, str]:
    """`anforande_id` -> `intressent_id` from C1 output.

    Absent or unreadable is not fatal: every clip then lacks a portrait and is
    rejected as unverifiable, which is the correct fail-closed outcome.
    """

    if not source_json.exists():
        return {}
    try:
        payload = json.loads(source_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return roster_from_source(payload) if isinstance(payload, dict) else {}


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
