"""IoU tracking utilities for C8 face tracks."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from statistics import median

from src.contracts import FaceSample, FaceTrack
from src.vision.detect import DetectedFace, FrameDetections


@dataclass(frozen=True)
class TrackCandidate:
    """Internal candidate face track before active-speaker selection."""

    track_id: str
    samples: tuple[FaceSample, ...]
    mean_score: float

    @property
    def coverage(self) -> int:
        return len(self.samples)


@dataclass
class _TrackState:
    track_id: str
    samples: list[FaceSample]
    scores: list[float]

    @property
    def last_sample(self) -> FaceSample:
        return self.samples[-1]

    @property
    def last_t(self) -> float:
        return float(self.last_sample.t)


def build_face_tracks(
    frames: Sequence[FrameDetections],
    *,
    iou_threshold: float,
    max_gap_s: float,
) -> tuple[TrackCandidate, ...]:
    """Track face detections over master-relative frame timestamps."""

    states: list[_TrackState] = []
    for frame in sorted(frames, key=lambda item: item.t):
        detections = sorted(frame.faces, key=lambda face: face.score, reverse=True)
        assigned_tracks: set[str] = set()
        for face in detections:
            best_state = _best_matching_track(
                face,
                states,
                frame_t=frame.t,
                assigned_tracks=assigned_tracks,
                max_gap_s=max_gap_s,
            )
            sample = _sample_from_face(frame.t, face, is_speaking=False)
            if best_state is None or iou(best_state.last_sample, sample) < iou_threshold:
                state = _TrackState(
                    track_id=f"track-{len(states) + 1:03d}",
                    samples=[sample],
                    scores=[face.score],
                )
                states.append(state)
                assigned_tracks.add(state.track_id)
            else:
                best_state.samples.append(sample)
                best_state.scores.append(face.score)
                assigned_tracks.add(best_state.track_id)

    return tuple(
        TrackCandidate(
            track_id=state.track_id,
            samples=tuple(state.samples),
            mean_score=sum(state.scores) / len(state.scores),
        )
        for state in states
        if state.samples
    )


def select_active_track(
    tracks: Sequence[TrackCandidate],
    *,
    frame_width: float,
    frame_height: float,
) -> TrackCandidate | None:
    """Pick the largest, most centered, most persistent face track."""

    if not tracks:
        return None
    return max(
        tracks,
        key=lambda track: (
            _track_score(track, frame_width=frame_width, frame_height=frame_height),
            track.track_id,
        ),
    )


def active_face_track(
    clip_id: str,
    tracks: Sequence[TrackCandidate],
    *,
    frame_width: float,
    frame_height: float,
    expected_times: Sequence[float],
    max_gap_s: float,
) -> FaceTrack:
    """Build the serializable active-speaker `FaceTrack` for one clip."""

    selected = select_active_track(tracks, frame_width=frame_width, frame_height=frame_height)
    if selected is None:
        return FaceTrack(clip_id=clip_id, track_id="no-face", samples=())
    filled = interpolate_missing_samples(
        selected.samples,
        expected_times=expected_times,
        max_gap_s=max_gap_s,
    )
    speaking_samples = tuple(
        FaceSample(
            t=sample.t,
            x=sample.x,
            y=sample.y,
            w=sample.w,
            h=sample.h,
            is_speaking=True,
        )
        for sample in filled
    )
    return FaceTrack(clip_id=clip_id, track_id=selected.track_id, samples=speaking_samples)


def interpolate_missing_samples(
    samples: Sequence[FaceSample],
    *,
    expected_times: Sequence[float],
    max_gap_s: float,
) -> tuple[FaceSample, ...]:
    """Fill short occlusion gaps on the C2 frame grid."""

    if not samples:
        return ()
    by_time = {round(float(sample.t), 6): sample for sample in samples}
    ordered = sorted(samples, key=lambda sample: sample.t)
    output: list[FaceSample] = []
    for frame_t in expected_times:
        rounded_t = round(float(frame_t), 6)
        existing = by_time.get(rounded_t)
        if existing is not None:
            output.append(existing)
            continue
        before = _last_before(ordered, frame_t)
        after = _first_after(ordered, frame_t)
        if before is None or after is None:
            continue
        gap_s = float(after.t - before.t)
        if gap_s <= 0.0 or gap_s > max_gap_s:
            continue
        ratio = (frame_t - float(before.t)) / gap_s
        output.append(_interpolated_sample(frame_t, before, after, ratio))
    return tuple(sorted(output, key=lambda sample: sample.t))


def iou(first: FaceSample, second: FaceSample) -> float:
    """Intersection-over-union for two face boxes."""

    overlap_w = max(
        0.0,
        min(float(first.x + first.w), float(second.x + second.w))
        - max(float(first.x), float(second.x)),
    )
    overlap_h = max(
        0.0,
        min(float(first.y + first.h), float(second.y + second.h))
        - max(float(first.y), float(second.y)),
    )
    overlap = overlap_w * overlap_h
    union = float(first.w * first.h + second.w * second.h) - overlap
    if union <= 0.0:
        return 0.0
    return overlap / union


def _best_matching_track(
    face: DetectedFace,
    states: Sequence[_TrackState],
    *,
    frame_t: float,
    assigned_tracks: set[str],
    max_gap_s: float,
) -> _TrackState | None:
    sample = _sample_from_face(frame_t, face, is_speaking=False)
    candidates = [
        state
        for state in states
        if state.track_id not in assigned_tracks and 0.0 <= frame_t - state.last_t <= max_gap_s
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda state: iou(state.last_sample, sample))


def _sample_from_face(t: float, face: DetectedFace, *, is_speaking: bool) -> FaceSample:
    return FaceSample(t=t, x=face.x, y=face.y, w=face.w, h=face.h, is_speaking=is_speaking)


def _track_score(track: TrackCandidate, *, frame_width: float, frame_height: float) -> float:
    areas = [float(sample.w * sample.h) for sample in track.samples]
    centers = [float(sample.x + sample.w / 2.0) for sample in track.samples]
    area_frac = median(areas) / max(frame_width * frame_height, 1.0)
    center_distance = abs(median(centers) - frame_width / 2.0) / max(frame_width / 2.0, 1.0)
    center_score = 1.0 - min(1.0, center_distance)
    persistence = float(track.coverage)
    return persistence * 2.0 + area_frac * 100.0 + center_score * 3.0 + track.mean_score


def _last_before(samples: Sequence[FaceSample], t: float) -> FaceSample | None:
    before = [sample for sample in samples if float(sample.t) < t]
    return before[-1] if before else None


def _first_after(samples: Sequence[FaceSample], t: float) -> FaceSample | None:
    for sample in samples:
        if float(sample.t) > t:
            return sample
    return None


def _interpolated_sample(
    t: float,
    before: FaceSample,
    after: FaceSample,
    ratio: float,
) -> FaceSample:
    return FaceSample(
        t=t,
        x=_lerp(float(before.x), float(after.x), ratio),
        y=_lerp(float(before.y), float(after.y), ratio),
        w=_lerp(float(before.w), float(after.w), ratio),
        h=_lerp(float(before.h), float(after.h), ratio),
        is_speaking=False,
    )


def _lerp(start: float, end: float, ratio: float) -> float:
    return start + (end - start) * ratio


def frame_times(frames: Iterable[FrameDetections]) -> tuple[float, ...]:
    """Return sorted master-relative frame times from detection frames."""

    return tuple(sorted(frame.t for frame in frames))
