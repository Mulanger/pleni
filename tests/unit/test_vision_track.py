"""Tests for C8 face tracking and active-speaker selection."""

from __future__ import annotations

from src.contracts import FaceSample
from src.vision.detect import DetectedFace, FrameDetections
from src.vision.track import (
    active_face_track,
    build_face_tracks,
    iou,
    merge_fragmented_tracks,
    select_active_track,
)


def test_tracking_keeps_identity_across_short_occlusion_gap() -> None:
    frames = (
        FrameDetections(t=0.0, faces=(_face(100.0),)),
        FrameDetections(t=0.2, faces=(_face(104.0),)),
        FrameDetections(t=0.4, faces=()),
        FrameDetections(t=0.6, faces=()),
        FrameDetections(t=0.8, faces=(_face(112.0),)),
    )

    tracks = build_face_tracks(frames, iou_threshold=0.2, max_gap_s=1.0)
    active = active_face_track(
        "clip-1",
        tracks,
        frame_width=1000.0,
        frame_height=500.0,
        expected_times=tuple(frame.t for frame in frames),
        max_gap_s=1.0,
    )

    assert len(tracks) == 1
    assert len(active.samples) == 5
    assert all(sample.is_speaking for sample in active.samples)
    assert {sample.t for sample in active.samples} == {0.0, 0.2, 0.4, 0.6, 0.8}


def test_active_speaker_heuristic_prefers_persistent_centered_track() -> None:
    side_track = build_face_tracks(
        (
            FrameDetections(t=0.0, faces=(DetectedFace(850.0, 100.0, 120.0, 120.0, 1.0),)),
            FrameDetections(t=0.2, faces=(DetectedFace(852.0, 100.0, 120.0, 120.0, 1.0),)),
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]
    center_track = build_face_tracks(
        (
            FrameDetections(t=0.0, faces=(DetectedFace(450.0, 100.0, 95.0, 95.0, 1.0),)),
            FrameDetections(t=0.2, faces=(DetectedFace(452.0, 100.0, 95.0, 95.0, 1.0),)),
            FrameDetections(t=0.4, faces=(DetectedFace(454.0, 100.0, 95.0, 95.0, 1.0),)),
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]

    assert (
        select_active_track(
            (side_track, center_track),
            frame_width=1000.0,
            frame_height=500.0,
        )
        == center_track
    )


def test_active_face_track_handles_no_faces() -> None:
    track = active_face_track(
        "clip-1",
        (),
        frame_width=1000.0,
        frame_height=500.0,
        expected_times=(0.0, 0.2),
        max_gap_s=1.0,
    )

    assert track.track_id == "no-face"
    assert track.samples == ()


def test_iou_returns_expected_overlap() -> None:
    first = FaceSample(t=0.0, x=0.0, y=0.0, w=100.0, h=100.0, is_speaking=False)
    second = FaceSample(t=0.0, x=50.0, y=0.0, w=100.0, h=100.0, is_speaking=False)

    assert round(iou(first, second), 3) == 0.333


def _face(x: float) -> DetectedFace:
    return DetectedFace(x=x, y=100.0, w=80.0, h=80.0, score=1.0)


def test_a_big_centred_speaker_beats_a_small_persistent_face_in_the_gallery() -> None:
    """The bug this scoring change exists for.

    Under the old formula coverage was a raw frame count worth 2.0 each, so a
    face detected 20 times scored 40 while size contributed about 2 and centring
    3. A motionless face up in the chamber therefore beat the speaker, who Haar
    keeps losing. Measured on HD10540: two of sixteen published clips tracked a
    face half the normal size, far off to the left.
    """

    speaker = build_face_tracks(
        tuple(
            FrameDetections(
                t=index * 0.2,
                faces=(DetectedFace(600.0 + index, 300.0, 150.0, 150.0, 1.0),),
            )
            for index in range(6)
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]
    gallery = build_face_tracks(
        tuple(
            FrameDetections(
                t=index * 0.2,
                faces=(DetectedFace(120.0, 80.0, 55.0, 55.0, 1.0),),
            )
            for index in range(20)
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]

    assert gallery.coverage > speaker.coverage, "the wrong face is on screen longer"
    assert (
        select_active_track((gallery, speaker), frame_width=1280.0, frame_height=720.0)
        is speaker
    )


def test_merging_rejoins_a_speaker_who_looked_away() -> None:
    """A 2.4 s dropout used to split one speaker into two competing fragments."""

    before = build_face_tracks(
        tuple(
            FrameDetections(t=index * 0.2, faces=(_face(500.0 + index),))
            for index in range(5)
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]
    after = build_face_tracks(
        tuple(
            FrameDetections(t=3.2 + index * 0.2, faces=(_face(506.0 + index),))
            for index in range(5)
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]

    merged = merge_fragmented_tracks((before, after), max_gap_s=4.0, min_iou=0.30)

    assert len(merged) == 1
    assert merged[0].coverage == 10
    assert [sample.t for sample in merged[0].samples] == sorted(
        sample.t for sample in merged[0].samples
    )


def test_merging_does_not_stitch_across_a_shot_change() -> None:
    """A cut moves the box, so IoU at the seam collapses and the tracks stay apart."""

    podium = build_face_tracks(
        tuple(
            FrameDetections(t=index * 0.2, faces=(_face(500.0),))
            for index in range(5)
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]
    elsewhere = build_face_tracks(
        tuple(
            FrameDetections(t=2.0 + index * 0.2, faces=(_face(120.0),))
            for index in range(5)
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]

    assert len(merge_fragmented_tracks((podium, elsewhere), max_gap_s=4.0, min_iou=0.30)) == 2


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


def test_a_one_frame_false_positive_cannot_win_on_size() -> None:
    """Measured on HD10540 clip 1 before the coverage floor existed.

    Haar fired once on something 27% of frame width — a torso or a fitting, not
    a head. Relative area scoring handed it the clip over a speaker tracked in
    226 of 242 frames. Size has to be earned over time.
    """

    speaker = build_face_tracks(
        tuple(
            FrameDetections(t=index * 0.2, faces=(DetectedFace(560.0, 180.0, 143.0, 144.0, 1.0),))
            for index in range(226)
        ),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]
    artifact = build_face_tracks(
        (FrameDetections(t=0.0, faces=(DetectedFace(560.0, 180.0, 352.0, 352.0, 1.0),)),),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]

    selected = select_active_track(
        (artifact, speaker),
        frame_width=1280.0,
        frame_height=720.0,
        total_frames=242,
    )

    assert selected is speaker


def test_nothing_clears_the_floor_selects_nothing() -> None:
    """Fail closed. This assertion was the other way round until ADR 010.

    Falling back to a best guess meant a clip with one stray detection still got
    a "speaker", and that guess was published under a named politician's byline.
    Source material is abundant enough to reject instead.
    """

    brief = build_face_tracks(
        (FrameDetections(t=0.0, faces=(DetectedFace(560.0, 180.0, 143.0, 144.0, 1.0),)),),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]

    assert (
        select_active_track(
            (brief,), frame_width=1280.0, frame_height=720.0, total_frames=242
        )
        is None
    )


def test_a_clip_with_no_eligible_track_reports_no_face() -> None:
    brief = build_face_tracks(
        (FrameDetections(t=0.0, faces=(DetectedFace(560.0, 180.0, 143.0, 144.0, 1.0),)),),
        iou_threshold=0.2,
        max_gap_s=1.0,
    )[0]

    track = active_face_track(
        "clip-1",
        (brief,),
        frame_width=1280.0,
        frame_height=720.0,
        expected_times=tuple(index * 0.2 for index in range(242)),
        max_gap_s=1.0,
    )

    assert track.track_id == "no-face"
    assert track.samples == ()
