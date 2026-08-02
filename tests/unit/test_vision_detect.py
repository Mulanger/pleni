"""Tests for C8 face detection helpers."""

from __future__ import annotations

from src.contracts import MediaInfo
from src.vision.detect import (
    DetectedFace,
    ImageSize,
    SignLanguageInset,
    estimate_speaker_proxy,
    intersects_inset,
    scale_detections_to_media,
)


def test_scale_detections_to_media_coordinates() -> None:
    faces = scale_detections_to_media(
        (DetectedFace(x=120.0, y=40.0, w=60.0, h=80.0, score=1.0),),
        image_size=ImageSize(width=480, height=270),
        media_info=MediaInfo(
            width=1280,
            height=720,
            fps=50.0,
            duration_s=100.0,
            has_audio=True,
            video_codec="h264",
        ),
    )

    assert faces[0].x == 320.0
    assert faces[0].y == 106.66666666666666
    assert faces[0].w == 160.0


def test_inset_intersection_rejects_overlapping_face() -> None:
    face = DetectedFace(x=410.0, y=20.0, w=50.0, h=50.0, score=1.0)
    inset = SignLanguageInset(x=400.0, y=0.0, w=80.0, h=100.0)

    assert intersects_inset(face, inset)
    assert not intersects_inset(
        DetectedFace(x=100.0, y=20.0, w=50.0, h=50.0, score=1.0),
        inset,
    )


def test_speaker_proxy_is_centered_and_positive() -> None:
    proxy = estimate_speaker_proxy(ImageSize(width=480, height=270))

    assert proxy.w > 0.0
    assert proxy.h > 0.0
    assert proxy.center_x == 240.0
