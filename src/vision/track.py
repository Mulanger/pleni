"""IoU tracking utilities for C8 face tracks."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from statistics import median

from src.contracts import FaceSample, FaceTrack
from src.vision.detect import DetectedFace, FrameDetections

#: Weights for active-speaker selection. Every component is normalised to
#: `[0, 1]` against the best candidate in the *same clip*, so these are
#: comparable and sum to 1.0.
#:
#: The previous formula was `coverage * 2.0 + area_frac * 100.0 + centre * 3.0`
#: with `coverage` as a raw frame count. On a 48-second clip that is ~480 points
#: for coverage against 2.2 for size and 3.0 for centring — about 99% of the
#: decision was "which face was detected in the most frames". Haar loses the
#: speaker every time they turn their head or look at their notes, while a
#: static face up in the chamber is never lost, so the crowd won the vote.
#:
#: Size leads now because Riksdagen's feed is directed: the vision mixer frames
#: whoever is speaking large and everyone else small. Coverage still matters,
#: but it can no longer outvote a face twice the size on its own.
AREA_WEIGHT = 0.45
COVERAGE_WEIGHT = 0.30
CENTER_WEIGHT = 0.20
DETECTOR_WEIGHT = 0.05

#: A face visible in less than this fraction of a clip's frames is not that
#: clip's speaker, whatever else it scores.
#:
#: This floor is not decoration. Haar fires on torsos, desks and chamber
#: fittings for a frame or two, and those false positives are *large* — 19% to
#: 27% of frame width against the podium's steady 11%. Weighting size without a
#: coverage floor simply swaps one failure for another: on HD10540 a single
#: 27%-wide detection appearing in 1 frame of 242 outscored the real speaker,
#: who was tracked in 226. Measured across the five worst clips, every genuine
#: podium track sits at 19% coverage or above and every artifact below 11%.
MIN_COVERAGE_FRAC = 0.15


@dataclass(frozen=True)
class TrackCandidate:
    """Internal candidate face track before active-speaker selection."""

    track_id: str
    samples: tuple[FaceSample, ...]
    mean_score: float

    @property
    def coverage(self) -> int:
        return len(self.samples)

    @property
    def start_t(self) -> float:
        return float(self.samples[0].t)

    @property
    def end_t(self) -> float:
        return float(self.samples[-1].t)


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
    total_frames: int | None = None,
) -> TrackCandidate | None:
    """Pick the face most likely to be the speaker: large, centred, persistent.

    Candidates too brief to be a speaker are discarded first (`MIN_COVERAGE_FRAC`),
    then the survivors are scored *relative to each other*. That is the question
    actually being asked — not "is this face big" but "is this the biggest face
    here" — and it means no reference size has to be tuned per debate type or
    per camera framing.

    `total_frames` is the clip's frame count. Without it the floor falls back to
    the longest candidate, which is weaker but never wrong-by-construction.
    """

    if not tracks:
        return None
    eligible = _long_enough_to_be_a_speaker(tracks, total_frames=total_frames)
    if not eligible:
        return None
    scores = relative_scores(eligible, frame_width=frame_width, frame_height=frame_height)
    best = max(
        range(len(eligible)),
        key=lambda index: (scores[index], eligible[index].track_id),
    )
    return eligible[best]


def merge_fragmented_tracks(
    tracks: Sequence[TrackCandidate],
    *,
    max_gap_s: float,
    min_iou: float,
) -> tuple[TrackCandidate, ...]:
    """Stitch tracks that are the same face separated by a detection dropout.

    Haar is a frontal-face detector. A speaker who turns to address the chamber,
    looks down at notes or gestures across their face simply stops being
    detected, and any dropout longer than `face_track_max_gap_s` opens a *new*
    track. One speaker therefore arrives here as several short fragments while a
    motionless face in the gallery arrives as a single long one — which is how
    the gallery used to win on coverage.

    Two fragments merge when they do not overlap in time, the gap between them
    is short, and the box at the seam barely moved. Requiring real overlap at
    the seam is what stops a cut to a different shot being stitched into the
    speaker's track: a new framing moves the box far enough that IoU collapses.
    """

    if not tracks:
        return ()
    merged = sorted(tracks, key=lambda track: track.start_t)
    while True:
        pair = _best_merge_pair(merged, max_gap_s=max_gap_s, min_iou=min_iou)
        if pair is None:
            return tuple(merged)
        first, second = pair
        remaining = [
            track for index, track in enumerate(merged) if index not in (first, second)
        ]
        remaining.append(_concatenate(merged[first], merged[second]))
        merged = sorted(remaining, key=lambda track: track.start_t)


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

    selected = select_active_track(
        tracks,
        frame_width=frame_width,
        frame_height=frame_height,
        total_frames=len(expected_times),
    )
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


def relative_scores(
    tracks: Sequence[TrackCandidate],
    *,
    frame_width: float,
    frame_height: float,
) -> tuple[float, ...]:
    """Score every candidate in `[0, 1]`, normalised against the best of them.

    Returned positionally, not keyed by `track_id`: ids are only unique within
    one `build_face_tracks` call, so a dict keyed on them silently collapses two
    candidates into one.
    """

    if not tracks:
        return ()
    areas = [_median_area(track) for track in tracks]
    best_area = max(areas) or 1.0
    best_coverage = float(max(track.coverage for track in tracks)) or 1.0
    best_detector = max(track.mean_score for track in tracks) or 1.0
    return tuple(
        AREA_WEIGHT * (area / best_area)
        + COVERAGE_WEIGHT * (track.coverage / best_coverage)
        + CENTER_WEIGHT * _center_score(track, frame_width=frame_width)
        + DETECTOR_WEIGHT * (track.mean_score / best_detector)
        for track, area in zip(tracks, areas, strict=True)
    )


def _long_enough_to_be_a_speaker(
    tracks: Sequence[TrackCandidate],
    *,
    total_frames: int | None,
) -> tuple[TrackCandidate, ...]:
    """Drop candidates too brief to be the clip's speaker.

    **Returns nothing when nothing qualifies.** An earlier version fell back to
    the full candidate set so a badly tracked clip would still get a face. That
    is the wrong default for this product: a guessed speaker published over a
    real politician's face is worse than no clip, and source material is
    abundant enough to reject. See ADR 010.
    """

    denominator = total_frames or max(track.coverage for track in tracks)
    floor = MIN_COVERAGE_FRAC * max(denominator, 1)
    return tuple(track for track in tracks if track.coverage >= floor)


def _median_area(track: TrackCandidate) -> float:
    return median(float(sample.w * sample.h) for sample in track.samples)


def _center_score(track: TrackCandidate, *, frame_width: float) -> float:
    centers = [float(sample.x + sample.w / 2.0) for sample in track.samples]
    distance = abs(median(centers) - frame_width / 2.0) / max(frame_width / 2.0, 1.0)
    return 1.0 - min(1.0, distance)


def _best_merge_pair(
    tracks: Sequence[TrackCandidate],
    *,
    max_gap_s: float,
    min_iou: float,
) -> tuple[int, int] | None:
    """Indices of the closest-matching stitchable pair, or None."""

    best: tuple[int, int] | None = None
    best_overlap = min_iou
    for first, earlier in enumerate(tracks):
        for second, later in enumerate(tracks):
            if first == second or later.start_t <= earlier.end_t:
                continue
            if later.start_t - earlier.end_t > max_gap_s:
                continue
            overlap = iou(earlier.samples[-1], later.samples[0])
            if overlap >= best_overlap:
                best_overlap = overlap
                best = (first, second)
    return best


def _concatenate(earlier: TrackCandidate, later: TrackCandidate) -> TrackCandidate:
    samples = tuple(sorted(earlier.samples + later.samples, key=lambda sample: sample.t))
    total = earlier.coverage + later.coverage
    return TrackCandidate(
        track_id=earlier.track_id,
        samples=samples,
        mean_score=(
            earlier.mean_score * earlier.coverage + later.mean_score * later.coverage
        )
        / max(total, 1),
    )


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
