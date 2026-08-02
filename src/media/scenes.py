"""Scene detection over C2 analysis frames."""

from __future__ import annotations

from collections.abc import Iterable
from importlib import import_module
from itertools import pairwise
from pathlib import Path
from typing import Any, cast

from src.contracts import MediaInfo, Scene
from src.errors import ArtifactError, StageExecutionError
from src.media.extract import ANALYSIS_FRAME_FPS

DEFAULT_CONTENT_THRESHOLD = 27.0
DEFAULT_MIN_SCENE_LEN_S = 1.0


def detect_scenes_from_frames(
    frames_dir: Path | str,
    media_info: MediaInfo,
    *,
    frame_fps: float = ANALYSIS_FRAME_FPS,
    threshold: float = DEFAULT_CONTENT_THRESHOLD,
    min_scene_len_s: float = DEFAULT_MIN_SCENE_LEN_S,
) -> tuple[Scene, ...]:
    """Detect continuous camera shots from extracted frames.

    Returned `Scene.start_s` and `Scene.end_s` are float seconds relative to the
    master video start, matching every time-carrying C0 contract.
    """

    directory = Path(frames_dir)
    frame_paths = tuple(sorted(directory.glob("*.jpg")))
    if not frame_paths:
        raise ArtifactError(f"No extracted frames found for scene detection: {directory}")
    if frame_fps <= 0:
        raise StageExecutionError("Frame fps must be positive for scene detection")

    cv2 = cast(Any, import_module("cv2"))
    detectors = cast(Any, import_module("scenedetect.detectors"))
    detector_class = cast(type[Any], detectors.ContentDetector)
    detector = detector_class(
        threshold=threshold,
        min_scene_len=max(1, round(min_scene_len_s * frame_fps)),
    )

    cut_frames: list[int] = []
    for frame_num, frame_path in enumerate(frame_paths):
        image = cv2.imread(str(frame_path))
        if image is None:
            raise ArtifactError(f"Could not read frame image: {frame_path}")
        cut_frames.extend(_as_ints(detector.process_frame(frame_num, image)))
    cut_frames.extend(_as_ints(detector.post_process(len(frame_paths) - 1)))

    return _scenes_from_cut_frames(cut_frames, media_info.duration_s, frame_fps)


def scenes_to_json(scenes: Iterable[Scene]) -> list[dict[str, object]]:
    """Serialize scene contracts for `02_scenes.json`."""

    return [scene.model_dump(mode="json") for scene in scenes]


def _scenes_from_cut_frames(
    cut_frames: Iterable[int], duration_s: float, frame_fps: float
) -> tuple[Scene, ...]:
    cut_times = sorted(
        {
            round(frame_num / frame_fps, 6)
            for frame_num in cut_frames
            if 0.0 < frame_num / frame_fps < duration_s
        }
    )
    boundaries = [0.0, *cut_times, duration_s]

    scenes: list[Scene] = []
    for index, (start_s, end_s) in enumerate(pairwise(boundaries)):
        if end_s <= start_s:
            continue
        scenes.append(Scene(index=index, start_s=start_s, end_s=end_s))
    return tuple(scenes)


def _as_ints(values: object) -> list[int]:
    if not isinstance(values, Iterable):
        raise StageExecutionError("Scene detector returned a non-iterable cut list")
    return [int(value) for value in values]
