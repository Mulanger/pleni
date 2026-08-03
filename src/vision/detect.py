"""Face detection over C2 analysis frames for C8.

Detection runs on 480px-wide analysis frames, then boxes are scaled back to
master-video pixel coordinates before downstream camera planning uses them.
Frame timestamps remain float seconds relative to the master debate video.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, cast

from src.contracts import MediaInfo
from src.errors import ArtifactError, ConfigurationError, StageExecutionError


@dataclass(frozen=True)
class ImageSize:
    """Image dimensions in pixels."""

    width: int
    height: int


@dataclass(frozen=True)
class SignLanguageInset:
    """Optional frame-space rectangle to exclude from face detections."""

    x: float
    y: float
    w: float
    h: float


@dataclass(frozen=True)
class DetectedFace:
    """A detected or estimated face box in pixels for one image coordinate system."""

    x: float
    y: float
    w: float
    h: float
    score: float

    @property
    def area(self) -> float:
        return self.w * self.h

    @property
    def center_x(self) -> float:
        return self.x + self.w / 2.0

    @property
    def center_y(self) -> float:
        return self.y + self.h / 2.0


@dataclass(frozen=True)
class FrameDetections:
    """All detections for one master-relative frame timestamp."""

    t: float
    faces: tuple[DetectedFace, ...]


class HaarFaceDetector:
    """Small OpenCV Haar detector used as the default local C8 backend."""

    def __init__(self, *, cascade_name: str = "haarcascade_frontalface_default.xml") -> None:
        cv2 = cast(Any, import_module("cv2"))
        cascade_path = Path(str(cv2.data.haarcascades)) / cascade_name
        cascade = cv2.CascadeClassifier(str(cascade_path))
        if bool(cascade.empty()):
            raise ConfigurationError(f"Could not load OpenCV Haar cascade: {cascade_path}")
        self._cv2 = cv2
        self._cascade = cascade

    def detect(
        self,
        frame_path: Path,
        *,
        min_size_frac: float,
        inset: SignLanguageInset | None = None,
    ) -> tuple[ImageSize, tuple[DetectedFace, ...]]:
        """Detect faces in one analysis frame.

        Returned boxes are in analysis-frame coordinates. Use
        `scale_detections_to_media` before writing C8 contracts.

        **A miss returns an empty tuple.** This used to synthesise a centred box
        instead, which meant a detector failure entered the tracker as a stable,
        centred, positive observation — 56% of the published clips' face samples
        were that one constant. No downstream heuristic can recover the
        distinction once fabricated observations are mixed in, so absence of
        evidence is represented as absence. See ADR 010.
        """

        image = self._cv2.imread(str(frame_path))
        if image is None:
            raise ArtifactError(f"Could not read analysis frame: {frame_path}")
        height = int(image.shape[0])
        width = int(image.shape[1])
        image_size = ImageSize(width=width, height=height)
        gray = self._cv2.cvtColor(image, self._cv2.COLOR_BGR2GRAY)
        min_size = max(12, round(min(width, height) * min_size_frac))
        raw_faces = self._cascade.detectMultiScale(
            gray,
            scaleFactor=1.05,
            minNeighbors=3,
            minSize=(min_size, min_size),
        )
        faces = _faces_from_cv_rows(cast(Any, raw_faces), image_size)
        if inset is not None:
            faces = tuple(face for face in faces if not intersects_inset(face, inset))
        return image_size, faces


def build_face_detector(backend: str) -> HaarFaceDetector:
    """Build the configured C8 face detector backend."""

    normalized = backend.casefold().strip()
    if normalized == "haar":
        return HaarFaceDetector()
    raise ConfigurationError(f"Unsupported face detector backend: {backend}")


def scale_detections_to_media(
    faces: Sequence[DetectedFace],
    *,
    image_size: ImageSize,
    media_info: MediaInfo,
) -> tuple[DetectedFace, ...]:
    """Scale analysis-frame detections to master-video pixel coordinates."""

    if image_size.width <= 0 or image_size.height <= 0:
        raise StageExecutionError("Image dimensions must be positive for face scaling")
    scale_x = float(media_info.width) / float(image_size.width)
    scale_y = float(media_info.height) / float(image_size.height)
    return tuple(
        DetectedFace(
            x=face.x * scale_x,
            y=face.y * scale_y,
            w=face.w * scale_x,
            h=face.h * scale_y,
            score=face.score,
        )
        for face in faces
    )


def inset_from_fractions(
    image_size: ImageSize,
    *,
    x_frac: float | None,
    y_frac: float | None,
    w_frac: float | None,
    h_frac: float | None,
) -> SignLanguageInset | None:
    """Build an optional inset rectangle from config fractions."""

    values = (x_frac, y_frac, w_frac, h_frac)
    if all(value is None for value in values):
        return None
    if any(value is None for value in values):
        raise ConfigurationError("Sign-language inset config must set x, y, w, and h together")
    x_value, y_value, w_value, h_value = cast(tuple[float, float, float, float], values)
    return SignLanguageInset(
        x=x_value * image_size.width,
        y=y_value * image_size.height,
        w=w_value * image_size.width,
        h=h_value * image_size.height,
    )


def intersects_inset(face: DetectedFace, inset: SignLanguageInset) -> bool:
    """Return whether a face overlaps the configured sign-language inset."""

    overlap_w = max(0.0, min(face.x + face.w, inset.x + inset.w) - max(face.x, inset.x))
    overlap_h = max(0.0, min(face.y + face.h, inset.y + inset.h) - max(face.y, inset.y))
    overlap_area = overlap_w * overlap_h
    return overlap_area / max(face.area, 1.0) > 0.25


def _faces_from_cv_rows(raw_faces: Any, image_size: ImageSize) -> tuple[DetectedFace, ...]:
    rows = raw_faces.tolist() if hasattr(raw_faces, "tolist") else list(raw_faces)
    faces: list[DetectedFace] = []
    for raw_row in rows:
        if not isinstance(raw_row, Sequence) or len(raw_row) < 4:
            continue
        x, y, w, h = (float(raw_row[index]) for index in range(4))
        if w <= 0.0 or h <= 0.0:
            continue
        center_bonus = 1.0 - min(
            1.0, abs((x + w / 2.0) - image_size.width / 2.0) / image_size.width
        )
        area_score = min(
            1.0, (w * h) / max(float(image_size.width * image_size.height), 1.0) * 20.0
        )
        faces.append(DetectedFace(x=x, y=y, w=w, h=h, score=area_score + center_bonus))
    return tuple(sorted(faces, key=lambda face: face.score, reverse=True))
