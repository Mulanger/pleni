"""Speaker identity verification for C8.

The pipeline already knows who is supposed to be speaking: `00_source.json`
carries an `intressent_id` per anförande, and Riksdagen publishes an official
portrait for it. This module enrols that portrait and asks, of each candidate
face track, *is this that person* — a question geometry cannot answer and which
`select_active_track` had been answering with "largest, most central" instead.

All similarity is SFace cosine. Two properties of this footage, measured on a
30-clip closed-set probe before any of this was written (ADR 012):

- **Margin beats absolute similarity.** A correct match landed at 0.366, on top
  of OpenCV's documented 0.363 LFW threshold, while beating the runner-up by
  +0.299. The absolute floor here is deliberately permissive and the margin does
  the discriminating.
- **480x270 analysis frames are enough.** All 30 succeeded on ~46 px faces.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, Protocol, cast

from src.contracts import IdentityEvidence, VerificationDecision
from src.errors import ConfigurationError, ExternalServiceError
from src.vision.detect import MODEL_DIR, DetectedFace, verify_model_checksum

SFACE_MODEL_NAME = "face_recognition_sface_2021dec.onnx"
SFACE_MODEL_SHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"

PORTRAIT_URL = "https://data.riksdagen.se/filarkiv/bilder/ledamot/{intressent_id}_max.jpg"

#: A Riksdagen portrait is ~1800x2400 with the face filling half the frame,
#: which is outside YuNet's anchor range -- it returns nothing at all. At an
#: 800 px long side the same face detects at 0.94-0.96.
PORTRAIT_LONG_SIDE = 800


@dataclass(frozen=True)
class IdentityThresholds:
    """Acceptance rule for a candidate track.

    Structural, not tuned: the numbers are a first calibration from the probe in
    ADR 012 and are expected to move once a labelled audit set exists. What must
    not change without evidence is that all of them are required together.
    """

    min_embeddings: int = 3
    min_median_similarity: float = 0.28
    min_p20_similarity: float = 0.20
    min_competitor_margin: float = 0.08

    def evaluate(self, evidence: IdentityEvidence, *, has_competitor: bool) -> str | None:
        """Return a rejection reason, or `None` when the track is accepted."""

        if evidence.embedding_count < self.min_embeddings:
            return "too_few_quality_embeddings"
        if evidence.median_similarity < self.min_median_similarity:
            return "median_similarity_below_floor"
        if evidence.p20_similarity < self.min_p20_similarity:
            return "p20_similarity_below_floor"
        if has_competitor and evidence.competitor_margin < self.min_competitor_margin:
            return "margin_over_competing_face_too_small"
        return None


class PortraitSource(Protocol):
    """Fetches an official portrait by `intressent_id`. Injectable for tests."""

    def fetch(self, intressent_id: str) -> bytes | None:
        """Return portrait bytes, or `None` when none is published."""


class RiksdagenPortraitSource:
    """Portrait fetcher with an on-disk cache.

    Cached by `intressent_id` so a debate re-run and every clip inside one debate
    cost a single request per politician.
    """

    def __init__(self, client: Any, cache_dir: Path) -> None:
        self._client = client
        self._cache_dir = cache_dir

    def fetch(self, intressent_id: str) -> bytes | None:
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        cached = self._cache_dir / f"{intressent_id}.jpg"
        miss = self._cache_dir / f"{intressent_id}.missing"
        if cached.exists():
            return cached.read_bytes() or None
        if miss.exists():
            return None
        try:
            response = self._client.get(
                PORTRAIT_URL.format(intressent_id=intressent_id), accept="image/jpeg"
            )
        except ExternalServiceError:
            # A portrait that cannot be fetched is unverifiable, not a pipeline
            # fault. It is not cached as missing, so a transient outage does not
            # permanently mark a politician unenrollable.
            return None
        body = bytes(response.body)
        if not body:
            miss.write_bytes(b"")
            return None
        cached.write_bytes(body)
        return body


class FaceEmbedder:
    """SFace feature extraction, aligned with YuNet's five landmarks."""

    def __init__(self, *, model_path: Path | None = None) -> None:
        cv2 = cast(Any, import_module("cv2"))
        path = model_path or MODEL_DIR / SFACE_MODEL_NAME
        verify_model_checksum(path, expected_sha256=SFACE_MODEL_SHA256)
        try:
            recognizer = cv2.FaceRecognizerSF.create(str(path), "")
        except Exception as exc:  # pragma: no cover - depends on the OpenCV build
            raise ConfigurationError(f"Could not load SFace model {path}: {exc}") from exc
        self._cv2 = cv2
        self._recognizer = recognizer

    def embed(self, image: Any, detection_row: Sequence[float]) -> tuple[float, ...] | None:
        """Return a unit-comparable feature for one detected face, or `None`."""

        try:
            numpy = cast(Any, import_module("numpy"))
            aligned = self._recognizer.alignCrop(image, numpy.asarray(detection_row, "float32"))
            feature = self._recognizer.feature(aligned)
        except Exception:  # pragma: no cover - malformed crop at a frame border
            return None
        return tuple(float(value) for value in feature.flatten())


def cosine_similarity(first: Sequence[float], second: Sequence[float]) -> float:
    """Cosine similarity between two SFace features."""

    if not first or not second or len(first) != len(second):
        return 0.0
    dot = sum(a * b for a, b in zip(first, second, strict=True))
    norm = math.sqrt(sum(a * a for a in first)) * math.sqrt(sum(b * b for b in second))
    if norm <= 0.0:
        return 0.0
    return dot / norm


def portrait_digest(portrait_bytes: bytes) -> str:
    """Stable identifier for the enrolled portrait, recorded on the evidence."""

    return hashlib.sha256(portrait_bytes).hexdigest()


def build_evidence(
    similarities: Sequence[float],
    *,
    intressent_id: str | None,
    portrait_sha256: str | None,
    competitor_median: float,
) -> IdentityEvidence:
    """Summarise one track's similarity samples into contract evidence.

    Robust summaries on purpose: a track is described by its median and its 20th
    percentile so that one lucky frame cannot carry a track that is otherwise a
    poor match.
    """

    ordered = sorted(float(value) for value in similarities)
    if not ordered:
        return IdentityEvidence(
            intressent_id=intressent_id,
            portrait_sha256=portrait_sha256,
            embedding_count=0,
        )
    median = _quantile(ordered, 0.50)
    return IdentityEvidence(
        intressent_id=intressent_id,
        portrait_sha256=portrait_sha256,
        embedding_count=len(ordered),
        median_similarity=median,
        p20_similarity=_quantile(ordered, 0.20),
        competitor_margin=median - competitor_median,
    )


def decide(reason: str | None) -> VerificationDecision:
    """Map an acceptance-rule reason onto the contract decision."""

    if reason is None:
        return VerificationDecision.ACCEPTED
    if reason == "margin_over_competing_face_too_small":
        return VerificationDecision.REJECTED_AMBIGUOUS
    if reason in {"median_similarity_below_floor", "p20_similarity_below_floor"}:
        return VerificationDecision.REJECTED_IDENTITY_MISMATCH
    return VerificationDecision.REJECTED_NO_EVIDENCE


@dataclass(frozen=True)
class EnrolledPortrait:
    """One politician's enrolled portrait feature and its provenance hash."""

    digest: str
    feature: tuple[float, ...]


class EnrolmentCache:
    """Enrols each politician's portrait once per stage run.

    A debate's clips share a handful of speakers, so without this the same
    portrait would be fetched and embedded once per clip.
    """

    def __init__(
        self,
        *,
        portraits: PortraitSource,
        detector: Any,
        embedder: FaceEmbedder,
    ) -> None:
        self._portraits = portraits
        self._detector = detector
        self._embedder = embedder
        self._cache: dict[str, EnrolledPortrait | None] = {}

    def feature_for(self, intressent_id: str | None) -> EnrolledPortrait | None:
        """Enrolled portrait for a politician, or `None` when unenrollable."""

        if intressent_id is None:
            return None
        if intressent_id not in self._cache:
            self._cache[intressent_id] = self._enrol(intressent_id)
        return self._cache[intressent_id]

    def _enrol(self, intressent_id: str) -> EnrolledPortrait | None:
        payload = self._portraits.fetch(intressent_id)
        if not payload:
            return None
        cv2 = cast(Any, import_module("cv2"))
        numpy = cast(Any, import_module("numpy"))
        image = cv2.imdecode(numpy.frombuffer(payload, numpy.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return None
        image = fit_for_detection(image)
        faces = self._detector.detect_image(image, min_size_frac=0.0)
        subject = largest_face(faces)
        if subject is None:
            return None
        feature = self._embedder.embed(image, subject.detection_row())
        if feature is None:
            return None
        return EnrolledPortrait(digest=portrait_digest(payload), feature=feature)


def fit_for_detection(image: Any, long_side: int = PORTRAIT_LONG_SIDE) -> Any:
    """Downscale an oversized image before detection.

    A Riksdagen portrait is ~1800x2400 with the face filling half the frame,
    which is outside YuNet's anchor range: it returns **nothing at all**. At an
    800 px long side the same face detects at 0.94-0.96.
    """

    cv2 = cast(Any, import_module("cv2"))
    height, width = image.shape[:2]
    if max(width, height) <= long_side:
        return image
    scale = long_side / max(width, height)
    return cv2.resize(
        image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA
    )


def largest_face(faces: Sequence[DetectedFace]) -> DetectedFace | None:
    """The biggest box in a frame, used only to enrol a single-subject portrait."""

    if not faces:
        return None
    return max(faces, key=lambda face: face.w * face.h)


def _quantile(ordered: Sequence[float], quantile: float) -> float:
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * quantile)))
    return float(ordered[index])


def roster_from_source(source_payload: Mapping[str, Any]) -> dict[str, str]:
    """Map `speech_id` suffix (`anforande_id`) to `intressent_id` from C1 output.

    `Speech` does not carry `intressent_id`, and adding it would be a second
    contract change for something C11 already reads out of `00_source.json`.
    """

    roster: dict[str, str] = {}
    anforanden = source_payload.get("anforanden")
    if not isinstance(anforanden, list):
        return roster
    for entry in anforanden:
        if not isinstance(entry, Mapping):
            continue
        anforande_id = entry.get("anforande_id")
        intressent_id = entry.get("intressent_id")
        if anforande_id and intressent_id:
            roster[str(anforande_id)] = str(intressent_id)
    return roster
