"""Tests for C8 face detection helpers."""

from __future__ import annotations

import inspect
from pathlib import Path

import numpy as np
import pytest

from src.contracts import MediaInfo
from src.vision import detect as detect_module
from src.vision.detect import (
    DetectedFace,
    HaarFaceDetector,
    ImageSize,
    SignLanguageInset,
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


def test_a_detector_miss_returns_no_faces(tmp_path: Path) -> None:
    """A miss is missing evidence, never a synthesised box.

    This replaces `test_speaker_proxy_is_centered_and_positive`, which asserted
    that the fabricated fallback was centred and positive — i.e. it locked in
    the defect. `estimate_speaker_proxy()` returned a constant box whenever Haar
    found nothing, and 56% of the face samples in the 16 published clips were
    that one rectangle. See ADR 010.
    """

    blank = tmp_path / "blank.jpg"
    cv2 = pytest.importorskip("cv2")
    cv2.imwrite(str(blank), np.zeros((270, 480, 3), dtype=np.uint8))

    image_size, faces = HaarFaceDetector().detect(blank, min_size_frac=0.045)

    assert faces == (), "a frame with no face must yield no observations"
    assert image_size == ImageSize(width=480, height=270)


def test_the_synthetic_face_fallback_cannot_be_reintroduced() -> None:
    """Structural guard, not a behavioural one.

    The fabrication was invisible precisely because every metric downstream
    counted it as a real, well-framed face. Its absence has to be enforced by
    the test suite rather than by a reviewer noticing.
    """

    assert not hasattr(detect_module, "estimate_speaker_proxy")
    assert "fallback" not in inspect.signature(HaarFaceDetector.detect).parameters
    source = inspect.getsource(detect_module)
    assert "estimate_speaker_proxy" not in source
    assert "proxy" not in source.casefold()
