"""Tests for C8 face tracking and active-speaker selection."""

from __future__ import annotations

from src.contracts import FaceSample
from src.vision.detect import DetectedFace, FrameDetections
from src.vision.track import active_face_track, build_face_tracks, iou, select_active_track


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
