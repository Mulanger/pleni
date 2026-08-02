"""Tests for C9 camera planning."""

from __future__ import annotations

from itertools import pairwise

from src.camera.plan import crop_size_for_media, plan_camera_for_clip
from src.contracts import FaceSample, FaceTrack, MediaInfo, Scene, SelectedClip


def test_crop_size_uses_decided_720p_geometry() -> None:
    assert crop_size_for_media(_media()) == (406, 720)
    assert crop_size_for_media(
        MediaInfo(
            width=854, height=480, fps=25.0, duration_s=100.0, has_audio=True, video_codec="h264"
        )
    ) == (270, 480)


def test_static_speaker_produces_single_clamped_keyframe() -> None:
    plan = plan_camera_for_clip(
        _clip(),
        _track(
            FaceSample(t=1.0, x=590.0, y=80.0, w=100.0, h=100.0, is_speaking=True),
            FaceSample(t=2.0, x=594.0, y=80.0, w=100.0, h=100.0, is_speaking=True),
        ),
        (Scene(index=0, start_s=0.0, end_s=20.0),),
        _media(),
        dead_zone_frac=0.12,
        max_pan_px_s_1080=60.0,
    )

    assert len(plan.keyframes) == 1
    assert plan.keyframes[0].t == 0.0
    assert 430.0 <= plan.keyframes[0].crop_x <= 445.0


def test_scene_cut_produces_discontinuous_jump_between_shots() -> None:
    plan = plan_camera_for_clip(
        _clip(),
        _track(
            FaceSample(t=1.0, x=180.0, y=80.0, w=100.0, h=100.0, is_speaking=True),
            FaceSample(t=11.0, x=900.0, y=80.0, w=100.0, h=100.0, is_speaking=True),
        ),
        (
            Scene(index=0, start_s=0.0, end_s=10.0),
            Scene(index=1, start_s=10.0, end_s=20.0),
        ),
        _media(),
        dead_zone_frac=0.12,
        max_pan_px_s_1080=60.0,
    )

    assert [keyframe.t for keyframe in plan.keyframes] == [0.0, 10.0]
    assert plan.keyframes[0].crop_x != plan.keyframes[1].crop_x


def test_crossing_dead_zone_uses_bounded_velocity_pan() -> None:
    plan = plan_camera_for_clip(
        _clip(end_s=5.0),
        _track(
            FaceSample(t=0.0, x=100.0, y=80.0, w=100.0, h=100.0, is_speaking=True),
            FaceSample(t=1.0, x=700.0, y=80.0, w=100.0, h=100.0, is_speaking=True),
            FaceSample(t=2.0, x=900.0, y=80.0, w=100.0, h=100.0, is_speaking=True),
        ),
        (Scene(index=0, start_s=0.0, end_s=5.0),),
        _media(),
        dead_zone_frac=0.12,
        max_pan_px_s_1080=60.0,
    )

    assert plan.mode == "pan"
    for prev, current in pairwise(plan.keyframes):
        dt = current.t - prev.t
        assert current.crop_x - prev.crop_x <= 40.0 * dt


def test_missing_face_holds_center_crop() -> None:
    plan = plan_camera_for_clip(
        _clip(),
        FaceTrack(clip_id="clip-1", track_id="no-face", samples=()),
        (Scene(index=0, start_s=0.0, end_s=20.0),),
        _media(),
        dead_zone_frac=0.12,
        max_pan_px_s_1080=60.0,
    )

    assert len(plan.keyframes) == 1
    assert plan.keyframes[0].crop_x == (1280 - 406) / 2


def _media() -> MediaInfo:
    return MediaInfo(
        width=1280,
        height=720,
        fps=50.0,
        duration_s=100.0,
        has_audio=True,
        video_codec="h264",
    )


def _clip(*, end_s: float = 20.0) -> SelectedClip:
    return SelectedClip(
        clip_id="clip-1",
        speech_id="speech-1",
        rank=1,
        start_s=0.0,
        end_s=end_s,
        archetype="EXPLAIN",
        title="Titel",
        transcript="Detta är ett test.",
        topic=None,
    )


def _track(*samples: FaceSample) -> FaceTrack:
    return FaceTrack(clip_id="clip-1", track_id="track-1", samples=samples)
