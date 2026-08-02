"""Speech-boundary refinement from metadata, VAD, fuzzy scores, and scene cuts."""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum

from src.contracts import Scene
from src.segment.confidence import ConfidenceDecision, route_confidence, score_boundary_confidence
from src.segment.vad import SpeechActivity

SEARCH_MARGIN_S = 15.0
SCENE_SNAP_TOLERANCE_S = 2.0
START_METADATA_BIAS_S = 2.0
END_METADATA_BIAS_S = 1.7
MIN_REFINED_DURATION_S = 0.25
MAX_VAD_BOUNDARY_CORRECTION_S = 8.0


class BoundarySource(str, Enum):
    """Primary source of a refined boundary."""

    METADATA = "metadata"
    VAD = "vad"


@dataclass(frozen=True)
class MetadataSpeech:
    """One C1 metadata speech interval. Times are master-relative seconds."""

    anforande_id: str
    speaker_name: str
    party: str | None
    anforandetyp: str | None
    official_text: str | None
    start_s: float
    end_s: float


@dataclass(frozen=True)
class RefinedBoundary:
    """Refined speech interval. Times are master-relative seconds."""

    metadata: MetadataSpeech
    start_s: float
    end_s: float
    confidence: ConfidenceDecision
    source: BoundarySource
    scene_snapped: bool


def refine_boundaries(
    speeches: list[MetadataSpeech],
    *,
    vad_segments: list[SpeechActivity],
    scenes: list[Scene],
    media_duration_s: float | None,
) -> list[RefinedBoundary]:
    """Refine all speech boundaries without changing their order."""

    cut_points = scene_cut_points(scenes)
    refined = [
        _refine_one(
            speech,
            vad_segments=vad_segments,
            cut_points=cut_points,
            media_duration_s=media_duration_s,
        )
        for speech in speeches
    ]
    return _resolve_overlaps(refined)


def scene_cut_points(scenes: list[Scene]) -> list[float]:
    """Return internal scene boundaries as master-relative cut points."""

    points: set[float] = set()
    for scene in scenes:
        if scene.index > 0:
            points.add(float(scene.start_s))
    return sorted(points)


def snap_to_nearest_cut(
    boundary_s: float,
    cut_points: list[float],
    *,
    tolerance_s: float = SCENE_SNAP_TOLERANCE_S,
) -> tuple[float, bool]:
    """Snap one boundary to the nearest camera cut within tolerance."""

    if not cut_points:
        return boundary_s, False
    nearest = min(cut_points, key=lambda point: abs(point - boundary_s))
    if abs(nearest - boundary_s) <= tolerance_s:
        return nearest, True
    return boundary_s, False


def metadata_biased_interval(speech: MetadataSpeech) -> tuple[float, float]:
    """Apply the C3 metadata bias prior observed in KBLab's modern reference data."""

    start_s = speech.start_s + START_METADATA_BIAS_S
    end_s = speech.end_s - END_METADATA_BIAS_S
    if end_s - start_s < MIN_REFINED_DURATION_S:
        return speech.start_s, speech.end_s
    return start_s, end_s


def _refine_one(
    speech: MetadataSpeech,
    *,
    vad_segments: list[SpeechActivity],
    cut_points: list[float],
    media_duration_s: float | None,
) -> RefinedBoundary:
    start_s, end_s = metadata_biased_interval(speech)
    source = BoundarySource.METADATA
    vad_interval = _vad_interval_for_speech(speech, vad_segments)
    if vad_interval is not None:
        vad_start_s, vad_end_s = vad_interval
        if abs(vad_start_s - start_s) <= MAX_VAD_BOUNDARY_CORRECTION_S:
            start_s = vad_start_s
            source = BoundarySource.VAD
        if abs(vad_end_s - end_s) <= MAX_VAD_BOUNDARY_CORRECTION_S:
            end_s = vad_end_s
            source = BoundarySource.VAD

    start_s, start_snapped = snap_to_nearest_cut(start_s, cut_points)
    end_s, end_snapped = snap_to_nearest_cut(end_s, cut_points)
    start_s, end_s = _clamp_interval(start_s, end_s, media_duration_s)
    scene_snapped = start_snapped or end_snapped
    correction_s = max(abs(start_s - speech.start_s), abs(end_s - speech.end_s))
    confidence = route_confidence(
        score_boundary_confidence(
            official_text_present=bool(speech.official_text),
            vad_used=source is BoundarySource.VAD,
            scene_snapped=scene_snapped,
            fuzzy_score=None,
            correction_s=correction_s,
        )
    )
    return RefinedBoundary(
        metadata=speech,
        start_s=start_s,
        end_s=end_s,
        confidence=confidence,
        source=source,
        scene_snapped=scene_snapped,
    )


def _vad_interval_for_speech(
    speech: MetadataSpeech,
    vad_segments: list[SpeechActivity],
) -> tuple[float, float] | None:
    search_start = max(0.0, speech.start_s - SEARCH_MARGIN_S)
    search_end = speech.end_s + SEARCH_MARGIN_S
    overlapping = [
        segment
        for segment in vad_segments
        if segment.end_s > search_start
        and segment.start_s < search_end
        and _overlaps(segment.start_s, segment.end_s, speech.start_s, speech.end_s)
    ]
    if not overlapping:
        return None
    return overlapping[0].start_s, overlapping[-1].end_s


def _overlaps(left_start: float, left_end: float, right_start: float, right_end: float) -> bool:
    return left_start < right_end and left_end > right_start


def _clamp_interval(
    start_s: float,
    end_s: float,
    media_duration_s: float | None,
) -> tuple[float, float]:
    clamped_start = max(0.0, start_s)
    clamped_end = end_s
    if media_duration_s is not None:
        clamped_end = min(media_duration_s, clamped_end)
    if clamped_end - clamped_start < MIN_REFINED_DURATION_S:
        clamped_end = clamped_start + MIN_REFINED_DURATION_S
        if media_duration_s is not None and clamped_end > media_duration_s:
            clamped_end = media_duration_s
            clamped_start = max(0.0, clamped_end - MIN_REFINED_DURATION_S)
    return clamped_start, clamped_end


def _resolve_overlaps(boundaries: list[RefinedBoundary]) -> list[RefinedBoundary]:
    if len(boundaries) < 2:
        return boundaries
    resolved = list(boundaries)
    for index in range(len(resolved) - 1):
        current = resolved[index]
        following = resolved[index + 1]
        if current.end_s <= following.start_s:
            continue
        split_s = (current.end_s + following.start_s) / 2.0
        current_end = max(current.start_s + MIN_REFINED_DURATION_S, split_s)
        following_start = min(following.end_s - MIN_REFINED_DURATION_S, split_s)
        resolved[index] = replace(current, end_s=current_end)
        resolved[index + 1] = replace(following, start_s=following_start)
    return resolved
