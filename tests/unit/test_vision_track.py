"""Tests for C8 face tracking and verified-speaker selection."""

from __future__ import annotations

from src.contracts import FaceSample, ObservationSource, VerificationDecision
from src.vision.detect import DetectedFace, FrameDetections
from src.vision.identity import IdentityThresholds
from src.vision.track import (
    build_face_tracks,
    iou,
    merge_fragmented_tracks,
    select_verified_track,
    verified_face_track,
)

THRESHOLDS = IdentityThresholds()
PORTRAIT = "a" * 64


def test_tracking_keeps_identity_across_short_occlusion_gap() -> None:
    frames = (
        FrameDetections(t=0.0, faces=(_face(100.0),)),
        FrameDetections(t=0.2, faces=(_face(104.0),)),
        FrameDetections(t=0.4, faces=()),
        FrameDetections(t=0.6, faces=()),
        FrameDetections(t=0.8, faces=(_face(112.0),)),
    )

    tracks = build_face_tracks(frames, iou_threshold=0.2, max_gap_s=1.0)
    track = verified_face_track(
        "clip-1",
        _selection(tracks, times=(0.0, 0.8)),
        expected_times=tuple(frame.t for frame in frames),
        max_gap_s=1.0,
    )

    assert len(tracks) == 1
    assert len(track.samples) == 5
    assert {sample.t for sample in track.samples} == {0.0, 0.2, 0.4, 0.6, 0.8}


def test_interpolated_samples_are_marked_and_detected_ones_are_not() -> None:
    """Interpolation is camera support, never evidence. A filled sample may steer
    the crop between two real observations but must not be counted as having seen
    anything -- otherwise coverage and identity thresholds measure themselves.
    """

    frames = (
        FrameDetections(t=0.0, faces=(_face(100.0),)),
        FrameDetections(t=0.2, faces=()),
        FrameDetections(t=0.4, faces=(_face(108.0),)),
    )
    tracks = build_face_tracks(frames, iou_threshold=0.2, max_gap_s=1.0)

    track = verified_face_track(
        "clip-1",
        _selection(tracks, times=(0.0, 0.4)),
        expected_times=(0.0, 0.2, 0.4),
        max_gap_s=1.0,
    )

    by_t = {sample.t: sample for sample in track.samples}
    assert by_t[0.0].source is ObservationSource.DETECTED
    assert by_t[0.2].source is ObservationSource.INTERPOLATED
    assert by_t[0.4].source is ObservationSource.DETECTED


def test_a_track_never_spans_a_scene_cut() -> None:
    """The `HD10392_ebe6af7e...` defect: two speakers used the same lectern, so
    the box barely moved across the cut and the tracker fused them into one
    person. A cut is a hard boundary; only identity may rejoin shots.
    """

    frames = tuple(
        FrameDetections(t=index * 0.2, faces=(_face(500.0),)) for index in range(10)
    )

    without_cut = build_face_tracks(frames, iou_threshold=0.2, max_gap_s=1.0)
    with_cut = build_face_tracks(frames, iou_threshold=0.2, max_gap_s=1.0, cuts=(1.0,))

    assert len(without_cut) == 1, "identical boxes track as one person in one shot"
    assert len(with_cut) == 2, "the same boxes must not be joined across a cut"
    assert {track.shot_index for track in with_cut} == {0, 1}


def test_a_bigger_longer_wrong_face_loses_to_the_verified_speaker() -> None:
    """The whole point of ADR 012.

    Geometry said this clip belongs to the large, centred, fully-tracked face.
    Identity says that face is somebody else. Identity wins.
    """

    speaker = _track_with(x=560.0, size=90.0, count=20, similarity=0.62)
    bystander = _track_with(x=640.0, size=200.0, count=40, similarity=0.11)

    selection = select_verified_track(
        (bystander, speaker),
        shot_bounds={0: (0.0, 8.0)},
        shot_frame_counts={0: 40},
        intressent_id="123",
        portrait_sha256=PORTRAIT,
        thresholds=THRESHOLDS,
        min_verified_frac=0.0,
        max_unsupported_gap_s=1.0,
    )

    assert selection.decision is VerificationDecision.ACCEPTED
    assert selection.samples[0].w == 90.0, "the verified speaker, not the bigger face"


def test_an_ambiguous_margin_is_rejected_even_when_similarity_clears_the_floor() -> None:
    """Two faces that both look like the portrait is not a match, it is a doubt.
    Measured on this footage the margin separates far better than the absolute
    score, so a thin margin rejects regardless of how high both scores are.
    """

    first = _track_with(x=500.0, size=90.0, count=20, similarity=0.55)
    second = _track_with(x=700.0, size=90.0, count=20, similarity=0.54)

    selection = select_verified_track(
        (first, second),
        shot_bounds={0: (0.0, 8.0)},
        shot_frame_counts={0: 20},
        intressent_id="123",
        portrait_sha256=PORTRAIT,
        thresholds=THRESHOLDS,
        min_verified_frac=0.0,
        max_unsupported_gap_s=1.0,
    )

    assert selection.decision is VerificationDecision.REJECTED_AMBIGUOUS


def test_no_portrait_means_unverifiable_not_a_guess() -> None:
    speaker = _track_with(x=560.0, size=90.0, count=20, similarity=0.62)

    selection = select_verified_track(
        (speaker,),
        shot_bounds={0: (0.0, 8.0)},
        shot_frame_counts={0: 20},
        intressent_id=None,
        portrait_sha256=None,
        thresholds=THRESHOLDS,
        min_verified_frac=0.0,
        max_unsupported_gap_s=1.0,
    )

    assert selection.decision is VerificationDecision.REJECTED_NO_PORTRAIT
    assert selection.samples == ()


def test_a_long_shot_without_the_speaker_makes_the_clip_unsupported() -> None:
    """C9 used to hold the previous crop through exactly this, which points the
    camera at where the speaker stood in the *last* shot. Half the published
    catalogue hit it."""

    verified = _track_with(x=560.0, size=90.0, count=20, similarity=0.62, shot=0)
    stranger = _track_with(x=560.0, size=90.0, count=20, similarity=0.05, shot=1)

    selection = select_verified_track(
        (verified, stranger),
        shot_bounds={0: (0.0, 8.0), 1: (8.0, 16.0)},
        shot_frame_counts={0: 20, 1: 20},
        intressent_id="123",
        portrait_sha256=PORTRAIT,
        thresholds=THRESHOLDS,
        min_verified_frac=0.0,
        max_unsupported_gap_s=1.0,
    )

    assert len(selection.unsupported_spans) == 1
    assert selection.unsupported_spans[0].start_s == 8.0


def test_a_sub_second_cutaway_is_tolerated() -> None:
    """Riksdagen's feed cuts constantly. Holding the crop across half a second is
    invisible; rejecting every clip containing one would reject nearly all of
    them. The long absence is the defect, not the existence of a cut.
    """

    verified = _track_with(x=560.0, size=90.0, count=20, similarity=0.62, shot=0)
    blip = _track_with(x=560.0, size=90.0, count=2, similarity=0.05, shot=1)

    selection = select_verified_track(
        (verified, blip),
        shot_bounds={0: (0.0, 8.0), 1: (8.0, 8.4)},
        shot_frame_counts={0: 20, 1: 2},
        intressent_id="123",
        portrait_sha256=PORTRAIT,
        thresholds=THRESHOLDS,
        min_verified_frac=0.0,
        max_unsupported_gap_s=1.0,
    )

    assert selection.unsupported_spans == ()
    assert any("tolerated" in reason for reason in selection.reasons)


def test_interpolation_never_bridges_an_unsupported_span() -> None:
    """Filling across a shot the speaker is absent from would manufacture a
    smooth camera path over footage they are not in -- the stale-crop defect
    wearing a different hat."""

    verified = _track_with(x=560.0, size=90.0, count=5, similarity=0.62, shot=0)
    stranger = _track_with(x=560.0, size=90.0, count=5, similarity=0.05, shot=1, t0=4.0)

    selection = select_verified_track(
        (verified, stranger),
        shot_bounds={0: (0.0, 2.0), 1: (2.0, 6.0)},
        shot_frame_counts={0: 5, 1: 5},
        intressent_id="123",
        portrait_sha256=PORTRAIT,
        thresholds=THRESHOLDS,
        min_verified_frac=0.0,
        max_unsupported_gap_s=1.0,
    )
    track = verified_face_track(
        "clip-1",
        selection,
        expected_times=tuple(index * 0.2 for index in range(30)),
        max_gap_s=10.0,
    )

    assert all(float(sample.t) < 2.0 for sample in track.samples)


def test_iou_returns_expected_overlap() -> None:
    first = FaceSample(t=0.0, x=0.0, y=0.0, w=100.0, h=100.0)
    second = FaceSample(t=0.0, x=50.0, y=0.0, w=100.0, h=100.0)

    assert round(iou(first, second), 3) == 0.333


def test_merging_rejoins_a_speaker_who_looked_away() -> None:
    """A 2.4 s dropout used to split one speaker into two competing fragments."""

    frames = tuple(
        FrameDetections(t=index * 0.2, faces=(_face(500.0 + index),)) for index in range(5)
    ) + tuple(
        FrameDetections(t=3.2 + index * 0.2, faces=(_face(506.0 + index),))
        for index in range(5)
    )

    tracks = build_face_tracks(
        frames, iou_threshold=0.2, max_gap_s=1.0, merge_gap_s=4.0, merge_iou=0.30
    )

    assert len(tracks) == 1
    assert tracks[0].coverage == 10


def test_merging_never_joins_faces_visible_at_the_same_time() -> None:
    """Two people on screen together are two people, however close the boxes."""

    left = build_face_tracks(
        tuple(FrameDetections(t=index * 0.2, faces=(_face(500.0),)) for index in range(5)),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]
    right = build_face_tracks(
        tuple(FrameDetections(t=index * 0.2, faces=(_face(504.0),)) for index in range(5)),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]

    assert len(merge_fragmented_tracks((left, right), max_gap_s=4.0, min_iou=0.30)) == 2


def _face(x: float) -> DetectedFace:
    return DetectedFace(x=x, y=100.0, w=80.0, h=80.0, score=0.9)


def _track_with(
    *,
    x: float,
    size: float,
    count: int,
    similarity: float,
    shot: int = 0,
    t0: float = 0.0,
) -> object:
    from src.vision.track import TrackCandidate

    samples = tuple(
        FaceSample(
            t=t0 + index * 0.2,
            x=x,
            y=100.0,
            w=size,
            h=size,
            score=0.9,
            source=ObservationSource.DETECTED,
        )
        for index in range(count)
    )
    return TrackCandidate(
        track_id=f"shot-{shot:03d}-track-{int(x)}",
        samples=samples,
        mean_score=0.9,
        shot_index=shot,
        similarities=(similarity,) * max(3, count // 4),
    )


def _selection(tracks: tuple, *, times: tuple[float, float]) -> object:
    """Wrap plain tracks as an accepted single-shot selection."""

    from src.vision.track import VerifiedSelection

    return VerifiedSelection(
        samples=tuple(sample for track in tracks for sample in track.samples),
        track_id="test",
        evidence=None,
        decision=VerificationDecision.ACCEPTED,
        reasons=(),
        unsupported_spans=(),
        verified_frac=1.0,
    )
