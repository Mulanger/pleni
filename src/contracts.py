"""Shared Pydantic contracts for numbered pipeline stage artifacts.

These models are the stable interface between independent pipeline chunks. Any
future change to this file requires an ADR and a full consumer update.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, NonNegativeFloat, PositiveFloat, model_validator

MASTER_OFFSET = (
    "Float seconds relative to the master debate video start, never speech- or clip-relative."
)
MASTER_DURATION = "Duration in float seconds measured on the master debate media timeline."


class ContractModel(BaseModel):
    """Base model with strict-ish JSON-compatible serialization defaults."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class Source(ContractModel):
    """Source debate metadata from Riksdagen. `duration_s` is the master media duration."""

    dokid: str = Field(min_length=1, description="Riksdagen document id.")
    title: str = Field(min_length=1)
    debate_type: str | None = None
    debate_date: date
    source_url: str = Field(min_length=1)
    duration_s: NonNegativeFloat | None = Field(default=None, description=MASTER_DURATION)
    master_sha256: str | None = Field(default=None, min_length=64, max_length=64)


class SpeakerEntry(ContractModel):
    """Approximate Riksdagen speaker segment. `start_s` is a master-relative offset."""

    name: str = Field(min_length=1)
    party: str | None = None
    start_s: NonNegativeFloat = Field(description=MASTER_OFFSET)
    duration_s: PositiveFloat = Field(description=MASTER_DURATION)


class MediaInfo(ContractModel):
    """Technical metadata for the master media. `duration_s` is master duration in seconds."""

    width: int = Field(gt=0)
    height: int = Field(gt=0)
    fps: PositiveFloat
    duration_s: PositiveFloat = Field(description=MASTER_DURATION)
    has_audio: bool
    video_codec: str = Field(min_length=1)


class Scene(ContractModel):
    """One continuous shot between camera cuts. All time fields are master-relative seconds."""

    index: int = Field(ge=0)
    start_s: NonNegativeFloat = Field(description=MASTER_OFFSET)
    end_s: PositiveFloat = Field(description=MASTER_OFFSET)

    @model_validator(mode="after")
    def _validate_order(self) -> Scene:
        if self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        return self


class Speech(ContractModel):
    """Refined speech boundary and official text. All time fields are master-relative seconds."""

    speech_id: str = Field(min_length=1)
    dokid: str = Field(min_length=1)
    speaker_name: str = Field(min_length=1)
    party: str | None = None
    anforandetyp: str | None = None
    start_s: NonNegativeFloat = Field(description=MASTER_OFFSET)
    end_s: PositiveFloat = Field(description=MASTER_OFFSET)
    official_text: str | None = None
    alignment_confidence: float = Field(ge=0.0, le=1.0)
    needs_review: bool

    @model_validator(mode="after")
    def _validate_order(self) -> Speech:
        if self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        return self


class Word(ContractModel):
    """ASR token with word timing. All time fields are master-relative seconds."""

    text: str = Field(min_length=1)
    start_s: NonNegativeFloat = Field(description=MASTER_OFFSET)
    end_s: PositiveFloat = Field(description=MASTER_OFFSET)
    probability: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _validate_order(self) -> Word:
        if self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        return self


class Sentence(ContractModel):
    """Sentence text and word span. All time fields are master-relative seconds."""

    index: int = Field(ge=0)
    start_s: NonNegativeFloat = Field(description=MASTER_OFFSET)
    end_s: PositiveFloat = Field(description=MASTER_OFFSET)
    text: str = Field(min_length=1)
    word_indices: tuple[int, ...]

    @model_validator(mode="after")
    def _validate_order(self) -> Sentence:
        if self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        if any(index < 0 for index in self.word_indices):
            raise ValueError("word_indices must be non-negative")
        return self


class Transcript(ContractModel):
    """Word-aligned transcript for a speech. Nested word and sentence times are master-relative."""

    speech_id: str = Field(min_length=1)
    words: tuple[Word, ...]
    sentences: tuple[Sentence, ...]
    model: str = Field(min_length=1)
    language: str = Field(min_length=2)


class TimeSpan(ContractModel):
    """Generic interval. All time fields are master-relative seconds."""

    start_s: NonNegativeFloat = Field(description=MASTER_OFFSET)
    end_s: PositiveFloat = Field(description=MASTER_OFFSET)

    @model_validator(mode="after")
    def _validate_order(self) -> TimeSpan:
        if self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        return self


class AudioFeatures(ContractModel):
    """Per-speech audio features. Event and pause times are master-relative seconds."""

    speech_id: str = Field(min_length=1)
    frame_hz: PositiveFloat
    rms: tuple[float, ...]
    f0: tuple[float | None, ...]
    speech_rate_wps: tuple[float, ...]
    pauses: tuple[TimeSpan, ...]
    emphasis_events: tuple[TimeSpan, ...]

    @model_validator(mode="after")
    def _validate_frame_arrays(self) -> AudioFeatures:
        if len(self.rms) != len(self.f0) or len(self.rms) != len(self.speech_rate_wps):
            raise ValueError("rms, f0, and speech_rate_wps must have the same length")
        return self


class SentenceSpan(ContractModel):
    """Inclusive sentence index span for a candidate."""

    start_index: int = Field(ge=0)
    end_index: int = Field(ge=0)

    @model_validator(mode="after")
    def _validate_order(self) -> SentenceSpan:
        if self.end_index < self.start_index:
            raise ValueError("end_index must be greater than or equal to start_index")
        return self


class Candidate(ContractModel):
    """Clip candidate. `start_s` and `end_s` are absolute offsets into the master file."""

    speech_id: str = Field(min_length=1)
    start_s: NonNegativeFloat = Field(description=MASTER_OFFSET)
    end_s: PositiveFloat = Field(description=MASTER_OFFSET)
    sentence_span: SentenceSpan
    features: dict[str, float]
    archetype_scores: dict[str, float]
    sub_scores: dict[str, float] = Field(
        default_factory=dict,
        description="Open score map for heuristic, gate, and future LLM judge scores.",
    )
    gate_passed: bool
    reject_reason: str | None = None

    @model_validator(mode="after")
    def _validate_order(self) -> Candidate:
        if self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        if self.gate_passed and self.reject_reason is not None:
            raise ValueError("passing candidates cannot have reject_reason")
        if not self.gate_passed and self.reject_reason is None:
            raise ValueError("rejected candidates must have reject_reason")
        return self


class SelectedClip(ContractModel):
    """Chosen candidate for rendering. `start_s` and `end_s` are master-relative seconds."""

    clip_id: str = Field(min_length=1)
    speech_id: str = Field(min_length=1)
    rank: int = Field(ge=1)
    start_s: NonNegativeFloat = Field(description=MASTER_OFFSET)
    end_s: PositiveFloat = Field(description=MASTER_OFFSET)
    archetype: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=120)
    transcript: str = Field(min_length=1)
    topic: str | None = None

    @model_validator(mode="after")
    def _validate_order(self) -> SelectedClip:
        if self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        return self


class ObservationSource(str, Enum):
    """Where a face sample came from.

    Interpolation is camera support, never evidence: an interpolated sample may
    steer the crop between two real observations, but it must not count toward
    coverage, identity or any acceptance threshold. See ADR 012.
    """

    DETECTED = "detected"
    INTERPOLATED = "interpolated"


class FaceSample(ContractModel):
    """Face box sample at a master-relative timestamp."""

    t: NonNegativeFloat = Field(description=MASTER_OFFSET)
    x: NonNegativeFloat
    y: NonNegativeFloat
    w: PositiveFloat
    h: PositiveFloat
    score: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Detector confidence, the model's own. Never derived from geometry.",
    )
    source: ObservationSource = ObservationSource.DETECTED


class IdentityEvidence(ContractModel):
    """Why C8 believes a track is the politician the byline names.

    Aggregate by construction. A single portrait-to-frame match is not enough to
    accept: the portrait is lit and frontal, the frame is compressed, angled and
    small. See ADR 012.
    """

    intressent_id: str | None = None
    portrait_sha256: str | None = None
    embedding_count: int = Field(default=0, ge=0)
    median_similarity: float = 0.0
    p20_similarity: float = 0.0
    competitor_margin: float = Field(
        default=0.0,
        description="Median similarity minus the best competing face's. Separates "
        "better than absolute similarity on this footage.",
    )


class VerificationDecision(str, Enum):
    """Whether a clip's framing may be published. Only `ACCEPTED` may."""

    ACCEPTED = "accepted"
    REJECTED_NO_EVIDENCE = "rejected_no_evidence"
    REJECTED_NO_PORTRAIT = "rejected_no_portrait"
    REJECTED_IDENTITY_MISMATCH = "rejected_identity_mismatch"
    REJECTED_AMBIGUOUS = "rejected_ambiguous"


class FaceTrack(ContractModel):
    """Tracked face samples for a clip. Sample timestamps are master-relative seconds."""

    clip_id: str = Field(min_length=1)
    track_id: str = Field(min_length=1)
    samples: tuple[FaceSample, ...]
    decision: VerificationDecision = VerificationDecision.ACCEPTED
    identity: IdentityEvidence | None = None
    unsupported_spans: tuple[TimeSpan, ...] = Field(
        default=(),
        description="Master-relative spans inside the clip with no verified target. "
        "C9 must not hold a crop across these.",
    )
    reasons: tuple[str, ...] = ()


class CameraMode(str, Enum):
    """Supported virtual camera behaviours."""

    STATIC = "static"
    PAN = "pan"


class CameraKeyframe(ContractModel):
    """Camera crop position at a master-relative timestamp."""

    t: NonNegativeFloat = Field(description=MASTER_OFFSET)
    crop_x: NonNegativeFloat


class CameraPlan(ContractModel):
    """Virtual camera plan for a clip. Keyframe timestamps are master-relative seconds."""

    clip_id: str = Field(min_length=1)
    keyframes: tuple[CameraKeyframe, ...]
    mode: CameraMode


class RenderedPaths(ContractModel):
    """Filesystem paths for rendered outputs.

    Primary video is the decided full-bleed 9:16 mobile rendition. Any future
    extra rendition should be additive and named explicitly.
    """

    mp4_540x960: Path
    mp4_360x640: Path | None = None
    thumb: Path
    vtt: Path


class RenderedClip(ContractModel):
    """Rendered clip metadata. `duration_s` is clip duration derived from master offsets."""

    clip_id: str = Field(min_length=1)
    paths: RenderedPaths
    duration_s: PositiveFloat = Field(description=MASTER_DURATION)
    bytes: int = Field(ge=0)


class PublishResult(ContractModel):
    """Publication result. The clip id points back to master-relative render metadata."""

    clip_id: str = Field(min_length=1)
    cdn_urls: dict[str, str]
    supabase_row_id: str = Field(min_length=1)
    published_at: datetime
