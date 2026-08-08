"""Face detection over C2 analysis frames for C8.

Detection runs on 480px-wide analysis frames, then boxes are scaled back to
master-video pixel coordinates before downstream camera planning uses them.
Frame timestamps remain float seconds relative to the master debate video.

The detector is YuNet, run by OpenCV itself from a checksum-pinned ONNX under
`models/`. It replaced a Haar frontal cascade that returned **no confidence**,
which forced this module to synthesise a score from box area and distance from
frame centre. Measured over the live catalogue, that arrangement selected a
non-face — a torso, a seated bystander's lap, rows of empty chamber seats — as
the speaker in 24.9% of published clips, because the invented score *promoted*
large central false positives instead of suppressing them. Swapping the detector
removed every such box in the Phase 1 sample and raised track coverage from 0.58
to 0.86. See `docs/CLIPPING_V2_DESIGN.md` §6.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, Protocol, cast

from src.contracts import MediaInfo
from src.errors import ArtifactError, ConfigurationError, StageExecutionError

MODEL_DIR = Path(__file__).parent / "models"
YUNET_MODEL_NAME = "face_detection_yunet_2023mar.onnx"
YUNET_MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"


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
    """A detected face box in pixels for one image coordinate system.

    Internal to `src.vision` — not a contract, so it may carry detector detail
    that has no business being serialized into every artifact.
    """

    x: float
    y: float
    w: float
    h: float
    score: float
    #: YuNet's five landmarks (right eye, left eye, nose, mouth corners) in the
    #: same coordinate system as the box. `FaceRecognizerSF.alignCrop` needs
    #: them, and they are only valid before the box is scaled to master pixels.
    landmarks: tuple[float, ...] = ()
    #: Cosine similarity to the enrolled portrait, when this face was sampled
    #: for identity. `None` means "not measured", never "did not match".
    similarity: float | None = None

    def with_similarity(self, similarity: float) -> DetectedFace:
        """Return a copy carrying an identity measurement."""

        return DetectedFace(
            x=self.x,
            y=self.y,
            w=self.w,
            h=self.h,
            score=self.score,
            landmarks=self.landmarks,
            similarity=similarity,
        )

    def detection_row(self) -> tuple[float, ...]:
        """The `[x, y, w, h, *landmarks, score]` row `alignCrop` expects."""

        return (self.x, self.y, self.w, self.h, *self.landmarks, self.score)

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


class FaceDetector(Protocol):
    """A source of face observations for one analysis frame.

    Implementations must return boxes in analysis-frame coordinates and must
    return an empty tuple when they find nothing. Absence of evidence is
    represented as absence — never as a guess. See ADR 010.
    """

    def detect(
        self,
        frame_path: Path,
        *,
        min_size_frac: float,
        inset: SignLanguageInset | None = None,
    ) -> tuple[ImageSize, tuple[DetectedFace, ...]]:
        """Detect faces in one analysis frame on disk."""

    def detect_image(
        self,
        image: Any,
        *,
        min_size_frac: float,
        inset: SignLanguageInset | None = None,
    ) -> tuple[DetectedFace, ...]:
        """Detect faces in an already-decoded image."""


class YuNetFaceDetector:
    """OpenCV YuNet, the C8 detector. Reports the model's own confidence.

    The score on every returned box is the detector's, untransformed. Nothing
    here derives a score from geometry: ranking a detection by how big and how
    central it is is what let chamber furniture win the active-speaker vote, and
    size and centrality are already weighed — deliberately and visibly — by
    `src.vision.track.relative_scores`.
    """

    def __init__(
        self,
        *,
        score_threshold: float = 0.70,
        nms_threshold: float = 0.30,
        top_k: int = 500,
        model_path: Path | None = None,
    ) -> None:
        cv2 = cast(Any, import_module("cv2"))
        path = model_path or MODEL_DIR / YUNET_MODEL_NAME
        verify_model_checksum(path, expected_sha256=YUNET_MODEL_SHA256)
        try:
            detector = cv2.FaceDetectorYN.create(
                str(path), "", (320, 320), score_threshold, nms_threshold, top_k
            )
        except Exception as exc:  # pragma: no cover - depends on the OpenCV build
            raise ConfigurationError(f"Could not load YuNet model {path}: {exc}") from exc
        self._cv2 = cv2
        self._detector = detector

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

        **A miss returns an empty tuple.** A detector failure must not enter the
        tracker as an observation; 56% of the first published clips' face
        samples were once a single fabricated constant. See ADR 010.
        """

        image = self._cv2.imread(str(frame_path))
        if image is None:
            raise ArtifactError(f"Could not read analysis frame: {frame_path}")
        image_size = ImageSize(width=int(image.shape[1]), height=int(image.shape[0]))
        return image_size, self.detect_image(image, min_size_frac=min_size_frac, inset=inset)

    def detect_image(
        self,
        image: Any,
        *,
        min_size_frac: float,
        inset: SignLanguageInset | None = None,
    ) -> tuple[DetectedFace, ...]:
        """Detect faces in an already-decoded image.

        Boxes and landmarks are in that image's own coordinate system, which is
        what `FaceRecognizerSF.alignCrop` needs. Oversized images must be
        downscaled by the caller first — a face filling most of the frame is
        outside YuNet's anchor range and detects as nothing.
        """

        height = int(image.shape[0])
        width = int(image.shape[1])
        image_size = ImageSize(width=width, height=height)
        self._detector.setInputSize((width, height))
        _result, raw_faces = self._detector.detect(image)
        faces = _faces_from_yunet_rows(
            cast(Any, raw_faces), image_size, min_size_frac=min_size_frac
        )
        if inset is not None:
            faces = tuple(face for face in faces if not intersects_inset(face, inset))
        return faces


def verify_model_checksum(path: Path, *, expected_sha256: str) -> None:
    """Fail loudly when a vendored model is missing or is not the pinned file."""

    if not path.exists():
        raise ConfigurationError(
            f"Vendored vision model is missing: {path}. "
            "It is committed to the repository; see src/vision/models/MODELS.md."
        )
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise ConfigurationError(
            f"Vision model checksum mismatch for {path}: "
            f"expected {expected_sha256}, found {digest}."
        )


def build_face_detector(
    backend: str,
    *,
    score_threshold: float = 0.70,
    nms_threshold: float = 0.30,
    top_k: int = 500,
) -> FaceDetector:
    """Build the configured C8 face detector backend."""

    normalized = backend.casefold().strip()
    if normalized == "yunet":
        return YuNetFaceDetector(
            score_threshold=score_threshold,
            nms_threshold=nms_threshold,
            top_k=top_k,
        )
    raise ConfigurationError(f"Unsupported face detector backend: {backend}")


def scale_detections_to_media(
    faces: Sequence[DetectedFace],
    *,
    image_size: ImageSize,
    media_info: MediaInfo,
) -> tuple[DetectedFace, ...]:
    """Scale analysis-frame detections to master-video pixel coordinates.

    Clamped to the master frame: `FaceSample.x`/`y` are `NonNegativeFloat`, so a
    box the detector places partly outside the frame would fail contract
    validation on the way into the tracker.
    """

    if image_size.width <= 0 or image_size.height <= 0:
        raise StageExecutionError("Image dimensions must be positive for face scaling")
    scale_x = float(media_info.width) / float(image_size.width)
    scale_y = float(media_info.height) / float(image_size.height)
    return _clamped(
        (
            DetectedFace(
                x=face.x * scale_x,
                y=face.y * scale_y,
                w=face.w * scale_x,
                h=face.h * scale_y,
                score=face.score,
                # Landmarks are dropped deliberately: they are only meaningful in
                # the analysis-frame system `alignCrop` is called against, and
                # identity is measured before scaling.
                similarity=face.similarity,
            )
            for face in faces
        ),
        width=float(media_info.width),
        height=float(media_info.height),
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


def _faces_from_yunet_rows(
    raw_faces: Any,
    image_size: ImageSize,
    *,
    min_size_frac: float,
) -> tuple[DetectedFace, ...]:
    """Map YuNet output rows to clamped `DetectedFace` boxes.

    Each row is `[x, y, w, h, 10 landmark coordinates, score]`. The trailing
    score is the model's own confidence and is carried through untouched.
    """

    if raw_faces is None:
        return ()
    rows = raw_faces.tolist() if hasattr(raw_faces, "tolist") else list(raw_faces)
    min_size = max(2.0, min(image_size.width, image_size.height) * min_size_frac)
    faces: list[DetectedFace] = []
    for raw_row in rows:
        if not isinstance(raw_row, Sequence) or len(raw_row) < 5:
            continue
        x, y, w, h = (float(raw_row[index]) for index in range(4))
        if w < min_size or h < min_size:
            continue
        faces.append(
            DetectedFace(
                x=x,
                y=y,
                w=w,
                h=h,
                score=float(raw_row[-1]),
                landmarks=tuple(float(value) for value in raw_row[4:-1]),
            )
        )
    clamped = _clamped(faces, width=float(image_size.width), height=float(image_size.height))
    return tuple(sorted(clamped, key=lambda face: face.score, reverse=True))


def _clamped(
    faces: Any,
    *,
    width: float,
    height: float,
) -> tuple[DetectedFace, ...]:
    """Clip boxes into the frame and drop any that degenerate to nothing."""

    kept: list[DetectedFace] = []
    for face in faces:
        left = min(max(0.0, float(face.x)), width)
        top = min(max(0.0, float(face.y)), height)
        right = min(max(0.0, float(face.x + face.w)), width)
        bottom = min(max(0.0, float(face.y + face.h)), height)
        if right - left <= 1.0 or bottom - top <= 1.0:
            continue
        kept.append(
            DetectedFace(
                x=left,
                y=top,
                w=right - left,
                h=bottom - top,
                score=face.score,
                landmarks=face.landmarks,
                similarity=face.similarity,
            )
        )
    return tuple(kept)
