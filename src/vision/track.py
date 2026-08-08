"""Face tracking and verified-speaker selection for C8.

Tracks are built **within a shot** and never across one, then the expected
politician's track is chosen in each shot by identity. Geometry no longer
selects: the previous scorer ranked candidates by size, coverage and centring,
which describes framing rather than identity, and on a debate two-shot where
both people are tracked in ~100% of frames it decides nothing. Its own history
is the argument — it began as a raw persistence vote that handed clips to a
motionless face in the gallery, was reweighted toward size, and then handed them
to chamber furniture instead. See ADR 012.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from src.contracts import (
    FaceSample,
    FaceTrack,
    IdentityEvidence,
    ObservationSource,
    TimeSpan,
    VerificationDecision,
)
from src.vision.detect import DetectedFace, FrameDetections
from src.vision.identity import IdentityThresholds, build_evidence, decide

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
    shot_index: int = 0
    #: Cosine similarities to the enrolled portrait for the sampled subset of
    #: this track's faces. Empty means identity was never measured -- which is
    #: not the same as "did not match", and is treated as no evidence.
    similarities: tuple[float, ...] = ()

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
    similarities: list[float]

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
    cuts: Sequence[float] = (),
    merge_gap_s: float = 4.0,
    merge_iou: float = 0.30,
) -> tuple[TrackCandidate, ...]:
    """Track face detections over master-relative frame timestamps.

    `cuts` are master-relative scene-cut times, and every one of them is a hard
    boundary: no track may span a cut. A cut can put a different person at the
    same screen position, so geometric continuity across one is not evidence of
    identity — measured on `HD10392_ebe6af7e...`, where two speakers who used the
    same lectern were being tracked as one person. Re-associating a speaker
    across shots is `src.vision.identity`'s job, not the tracker's.
    """

    if cuts:
        return _tracks_per_shot(
            frames,
            iou_threshold=iou_threshold,
            max_gap_s=max_gap_s,
            cuts=cuts,
            merge_gap_s=merge_gap_s,
            merge_iou=merge_iou,
        )
    return _tracks_in_one_shot(
        frames,
        iou_threshold=iou_threshold,
        max_gap_s=max_gap_s,
        merge_gap_s=merge_gap_s,
        merge_iou=merge_iou,
    )


def _tracks_per_shot(
    frames: Sequence[FrameDetections],
    *,
    iou_threshold: float,
    max_gap_s: float,
    cuts: Sequence[float],
    merge_gap_s: float,
    merge_iou: float,
) -> tuple[TrackCandidate, ...]:
    boundaries = sorted({float(cut) for cut in cuts})
    shots: dict[int, list[FrameDetections]] = {}
    for frame in frames:
        index = bisect_right(boundaries, float(frame.t))
        shots.setdefault(index, []).append(frame)

    tracks: list[TrackCandidate] = []
    for shot_index in sorted(shots):
        for track in _tracks_in_one_shot(
            shots[shot_index],
            iou_threshold=iou_threshold,
            max_gap_s=max_gap_s,
            merge_gap_s=merge_gap_s,
            merge_iou=merge_iou,
        ):
            tracks.append(
                TrackCandidate(
                    track_id=f"shot-{shot_index:03d}-{track.track_id}",
                    samples=track.samples,
                    mean_score=track.mean_score,
                    shot_index=shot_index,
                    similarities=track.similarities,
                )
            )
    return tuple(tracks)


def _tracks_in_one_shot(
    frames: Sequence[FrameDetections],
    *,
    iou_threshold: float,
    max_gap_s: float,
    merge_gap_s: float = 4.0,
    merge_iou: float = 0.30,
) -> tuple[TrackCandidate, ...]:
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
            sample = _sample_from_face(frame.t, face)
            if best_state is None or iou(best_state.last_sample, sample) < iou_threshold:
                state = _TrackState(
                    track_id=f"track-{len(states) + 1:03d}",
                    samples=[sample],
                    scores=[face.score],
                    similarities=[face.similarity] if face.similarity is not None else [],
                )
                states.append(state)
                assigned_tracks.add(state.track_id)
            else:
                best_state.samples.append(sample)
                best_state.scores.append(face.score)
                if face.similarity is not None:
                    best_state.similarities.append(face.similarity)
                assigned_tracks.add(best_state.track_id)

    built = tuple(
        TrackCandidate(
            track_id=state.track_id,
            samples=tuple(state.samples),
            mean_score=sum(state.scores) / len(state.scores),
            similarities=tuple(state.similarities),
        )
        for state in states
        if state.samples
    )
    # Rejoining a speaker who looked away is safe here in a way it never was
    # before: this runs inside a single shot, so there is no cut for it to stitch
    # across and no chance of fusing two people who used the same lectern.
    return merge_fragmented_tracks(built, max_gap_s=merge_gap_s, min_iou=merge_iou)


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
        remaining = [track for index, track in enumerate(merged) if index not in (first, second)]
        remaining.append(_concatenate(merged[first], merged[second]))
        merged = sorted(remaining, key=lambda track: track.start_t)


@dataclass(frozen=True)
class VerifiedSelection:
    """The clip's speaker timeline, assembled from per-shot identity decisions."""

    samples: tuple[FaceSample, ...]
    track_id: str
    evidence: IdentityEvidence | None
    decision: VerificationDecision
    reasons: tuple[str, ...]
    unsupported_spans: tuple[TimeSpan, ...]
    verified_frac: float


def select_verified_track(
    tracks: Sequence[TrackCandidate],
    *,
    shot_bounds: Mapping[int, tuple[float, float]],
    shot_frame_counts: Mapping[int, int],
    intressent_id: str | None,
    portrait_sha256: str | None,
    thresholds: IdentityThresholds,
    min_verified_frac: float,
    max_unsupported_gap_s: float,
) -> VerifiedSelection:
    """Choose the expected politician's track in every shot, and say so honestly.

    Tracks terminate at scene cuts, so one speaker arrives as one track *per
    shot*. Selection therefore runs per shot and the accepted shots are unioned
    into the clip's timeline; a shot with no verified target becomes an
    unsupported span rather than a stretch of held-over crop pointed at where the
    speaker used to stand.

    Identity decides which track, not geometry. The geometric selector this
    replaced — largest, most-covered, most-centred — is a statement about
    framing, and on a debate two-shot where both people are tracked in ~100% of
    frames it carries no information at all about who is speaking.
    """

    if portrait_sha256 is None:
        return _rejected(
            VerificationDecision.REJECTED_NO_PORTRAIT,
            ("no_official_portrait_for_expected_speaker",),
            shot_bounds,
        )

    accepted: list[TrackCandidate] = []
    unsupported: list[TimeSpan] = []
    reasons: list[str] = []
    best_evidence: IdentityEvidence | None = None
    best_median = -1.0

    for shot_index in sorted(shot_bounds):
        in_shot = [track for track in tracks if track.shot_index == shot_index]
        eligible = _long_enough_to_be_a_speaker(
            in_shot, total_frames=shot_frame_counts.get(shot_index)
        )
        with_evidence = [
            (track, [float(value) for value in track.similarities])
            for track in eligible
            if track.similarities
        ]
        if not with_evidence:
            _record_unverified(
                shot_bounds[shot_index],
                unsupported,
                reasons,
                shot_index=shot_index,
                reason="no_quality_embeddings",
                max_unsupported_gap_s=max_unsupported_gap_s,
            )
            continue

        ranked = sorted(with_evidence, key=lambda item: _quantile_of(item[1], 0.5), reverse=True)
        winner, winner_sims = ranked[0]
        competitor_median = _quantile_of(ranked[1][1], 0.5) if len(ranked) > 1 else 0.0
        evidence = build_evidence(
            winner_sims,
            intressent_id=intressent_id,
            portrait_sha256=portrait_sha256,
            competitor_median=competitor_median,
        )
        reason = thresholds.evaluate(evidence, has_competitor=len(ranked) > 1)
        if reason is not None:
            _record_unverified(
                shot_bounds[shot_index],
                unsupported,
                reasons,
                shot_index=shot_index,
                reason=reason,
                max_unsupported_gap_s=max_unsupported_gap_s,
            )
            continue

        accepted.append(winner)
        if evidence.median_similarity > best_median:
            best_median = evidence.median_similarity
            best_evidence = evidence

    verified_frac = _verified_fraction(accepted, shot_frame_counts)
    if not accepted:
        first = reasons[0].split(":", 1)[1] if reasons else None
        return _rejected(
            decide(first) if first else VerificationDecision.REJECTED_NO_EVIDENCE,
            tuple(reasons) or ("no_verified_target_in_any_shot",),
            shot_bounds,
        )
    # Any span that survived `_record_unverified` is longer than the tolerated
    # cutaway, and C9 will not plan a camera across one. Accepting the clip here
    # anyway made `decision` disagree with what actually got rendered: on
    # HD10342, C8 reported 15 accepted and C10 emitted 8, with the other 7
    # vanishing silently. An artifact that says "accepted" about a clip nothing
    # will render is the same defect class this pipeline was rebuilt to remove,
    # so the long gap decides and `min_verified_frac` is only a backstop for
    # tolerated ones accumulating.
    if unsupported:
        reasons.append(f"unsupported_span_exceeds_{max_unsupported_gap_s:.1f}s")
        return _unrenderable(reasons, unsupported, best_evidence, verified_frac)
    if verified_frac < min_verified_frac:
        reasons.append(f"verified_only_{verified_frac:.2f}_of_clip")
        return _unrenderable(reasons, unsupported, best_evidence, verified_frac)

    samples = tuple(
        sorted(
            (sample for track in accepted for sample in track.samples),
            key=lambda sample: sample.t,
        )
    )
    return VerifiedSelection(
        samples=samples,
        track_id="+".join(track.track_id for track in accepted),
        evidence=best_evidence,
        decision=VerificationDecision.ACCEPTED,
        reasons=tuple(reasons),
        unsupported_spans=tuple(unsupported),
        verified_frac=verified_frac,
    )


def _unrenderable(
    reasons: Sequence[str],
    unsupported: Sequence[TimeSpan],
    evidence: IdentityEvidence | None,
    verified_frac: float,
) -> VerifiedSelection:
    """A clip with real identity evidence that still cannot be framed."""

    return VerifiedSelection(
        samples=(),
        track_id="unverified",
        evidence=evidence,
        decision=VerificationDecision.REJECTED_NO_EVIDENCE,
        reasons=tuple(reasons),
        unsupported_spans=tuple(unsupported),
        verified_frac=verified_frac,
    )


def _record_unverified(
    bounds: tuple[float, float],
    unsupported: list[TimeSpan],
    reasons: list[str],
    *,
    shot_index: int,
    reason: str,
    max_unsupported_gap_s: float,
) -> None:
    """Record a shot the speaker could not be verified in.

    A shot shorter than `max_unsupported_gap_s` is noted but **not** made an
    unsupported span. Riksdagen's feed cuts constantly, and a sub-second cutaway
    is not the defect being fixed here — holding the crop across half a second is
    invisible, while rejecting every clip containing one would reject nearly all
    of them. A long absence is the real failure and still disqualifies the clip.
    """

    duration_s = bounds[1] - bounds[0]
    if duration_s < max_unsupported_gap_s:
        reasons.append(f"shot_{shot_index}:{reason}:tolerated_{duration_s:.2f}s")
        return
    unsupported.append(_span(bounds))
    reasons.append(f"shot_{shot_index}:{reason}")


def _rejected(
    decision: VerificationDecision,
    reasons: tuple[str, ...],
    shot_bounds: Mapping[int, tuple[float, float]],
) -> VerifiedSelection:
    return VerifiedSelection(
        samples=(),
        track_id="no-face",
        evidence=None,
        decision=decision,
        reasons=reasons,
        unsupported_spans=tuple(_span(shot_bounds[index]) for index in sorted(shot_bounds)),
        verified_frac=0.0,
    )


def _span(bounds: tuple[float, float]) -> TimeSpan:
    start_s, end_s = bounds
    return TimeSpan(start_s=start_s, end_s=max(end_s, start_s + 1e-3))


def _verified_fraction(
    accepted: Sequence[TrackCandidate],
    shot_frame_counts: Mapping[int, int],
) -> float:
    total = sum(shot_frame_counts.values())
    if total <= 0:
        return 0.0
    covered = sum(
        1
        for track in accepted
        for sample in track.samples
        if sample.source is ObservationSource.DETECTED
    )
    return min(1.0, covered / total)


def _quantile_of(values: Sequence[float], quantile: float) -> float:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * quantile)))
    return ordered[index]


def verified_face_track(
    clip_id: str,
    selection: VerifiedSelection,
    *,
    expected_times: Sequence[float],
    max_gap_s: float,
) -> FaceTrack:
    """Serialize one clip's verified speaker timeline as a `FaceTrack`.

    Interpolation happens here and only here, and it never crosses an
    unsupported span: filling across a shot where the target was absent would
    manufacture a smooth path through footage the speaker is not in, which is the
    stale-crop defect wearing a different hat. See ADR 012.
    """

    if not selection.samples:
        return FaceTrack(
            clip_id=clip_id,
            track_id=selection.track_id,
            samples=(),
            decision=selection.decision,
            identity=selection.evidence,
            unsupported_spans=selection.unsupported_spans,
            reasons=selection.reasons,
        )
    supported_times = tuple(
        t
        for t in expected_times
        if not any(
            float(span.start_s) <= float(t) < float(span.end_s)
            for span in selection.unsupported_spans
        )
    )
    filled = interpolate_missing_samples(
        selection.samples,
        expected_times=supported_times,
        max_gap_s=max_gap_s,
    )
    return FaceTrack(
        clip_id=clip_id,
        track_id=selection.track_id,
        samples=filled,
        decision=selection.decision,
        identity=selection.evidence,
        unsupported_spans=selection.unsupported_spans,
        reasons=selection.reasons,
    )


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
    sample = _sample_from_face(frame_t, face)
    candidates = [
        state
        for state in states
        if state.track_id not in assigned_tracks and 0.0 <= frame_t - state.last_t <= max_gap_s
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda state: iou(state.last_sample, sample))


def _sample_from_face(t: float, face: DetectedFace) -> FaceSample:
    return FaceSample(
        t=t,
        x=face.x,
        y=face.y,
        w=face.w,
        h=face.h,
        score=min(1.0, max(0.0, float(face.score))),
        source=ObservationSource.DETECTED,
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
        mean_score=(earlier.mean_score * earlier.coverage + later.mean_score * later.coverage)
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
        score=min(float(before.score), float(after.score)),
        source=ObservationSource.INTERPOLATED,
    )


def _lerp(start: float, end: float, ratio: float) -> float:
    return start + (end - start) * ratio


def frame_times(frames: Iterable[FrameDetections]) -> tuple[float, ...]:
    """Return sorted master-relative frame times from detection frames."""

    return tuple(sorted(frame.t for frame in frames))
