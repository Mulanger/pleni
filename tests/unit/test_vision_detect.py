"""Tests for C8 face detection helpers."""

from __future__ import annotations

import inspect
from pathlib import Path

import numpy as np
import pytest

from src.contracts import MediaInfo
from src.errors import ConfigurationError
from src.vision import detect as detect_module
from src.vision.detect import (
    MODEL_DIR,
    YUNET_MODEL_NAME,
    YUNET_MODEL_SHA256,
    DetectedFace,
    ImageSize,
    SignLanguageInset,
    YuNetFaceDetector,
    build_face_detector,
    intersects_inset,
    scale_detections_to_media,
    verify_model_checksum,
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
    the defect. The old fallback returned a constant box whenever the detector
    found nothing, and 56% of the face samples in the 16 published clips were
    that one rectangle. See ADR 010.
    """

    blank = tmp_path / "blank.jpg"
    cv2 = pytest.importorskip("cv2")
    cv2.imwrite(str(blank), np.zeros((270, 480, 3), dtype=np.uint8))

    image_size, faces = YuNetFaceDetector().detect(blank, min_size_frac=0.045)

    assert faces == (), "a frame with no face must yield no observations"
    assert image_size == ImageSize(width=480, height=270)


def test_the_synthetic_face_fallback_cannot_be_reintroduced() -> None:
    """Structural guard, not a behavioural one.

    The fabrication was invisible precisely because every metric downstream
    counted it as a real, well-framed face. Its absence has to be enforced by
    the test suite rather than by a reviewer noticing.
    """

    assert not hasattr(detect_module, "estimate_speaker_proxy")
    assert "fallback" not in inspect.signature(YuNetFaceDetector.detect).parameters
    source = inspect.getsource(detect_module)
    assert "estimate_speaker_proxy" not in source
    assert "proxy" not in source.casefold()


def test_detector_score_is_the_models_own_not_derived_from_geometry() -> None:
    """The Haar cascade reported no confidence, so this module invented one from
    box area and distance from frame centre. That is what promoted a torso, a
    bystander's lap and rows of empty chamber seats over the real speaker in
    24.9% of published clips: the invented score *rewarded* exactly the property
    a large central false positive has. Size and centrality are still weighed,
    but in `track.relative_scores`, where the weights are visible and tunable.
    """

    source = inspect.getsource(detect_module)
    assert "center_bonus" not in source
    assert "area_score" not in source

    rows = [[10.0, 20.0, 40.0, 40.0] + [0.0] * 10 + [0.83]]
    faces = detect_module._faces_from_yunet_rows(
        rows, ImageSize(width=480, height=270), min_size_frac=0.045
    )

    assert len(faces) == 1
    assert faces[0].score == pytest.approx(0.83), "the model's confidence, carried through"


def test_out_of_frame_boxes_are_clamped_not_dropped() -> None:
    """YuNet returns a box extending past the edge for a face at the border.
    `FaceSample.x`/`y` are NonNegativeFloat, so an unclamped box raises
    ValidationError on the way into the tracker rather than being tracked.
    """

    rows = [
        [-12.0, -8.0, 40.0, 40.0] + [0.0] * 10 + [0.91],   # over the top-left edge
        [470.0, 10.0, 40.0, 40.0] + [0.0] * 10 + [0.88],   # over the right edge
        [479.5, 10.0, 40.0, 40.0] + [0.0] * 10 + [0.88],   # degenerate, must vanish
    ]

    faces = detect_module._faces_from_yunet_rows(
        rows, ImageSize(width=480, height=270), min_size_frac=0.001
    )

    assert len(faces) == 2
    assert all(face.x >= 0.0 and face.y >= 0.0 for face in faces)
    assert all(face.x + face.w <= 480.0 and face.y + face.h <= 270.0 for face in faces)


def test_faces_below_the_minimum_size_are_dropped() -> None:
    rows = [
        [10.0, 20.0, 40.0, 40.0] + [0.0] * 10 + [0.90],
        [10.0, 20.0, 4.0, 4.0] + [0.0] * 10 + [0.95],
    ]

    faces = detect_module._faces_from_yunet_rows(
        rows, ImageSize(width=480, height=270), min_size_frac=0.045
    )

    assert [face.w for face in faces] == [40.0], "a high score cannot rescue a 4px face"


def test_no_detections_returns_empty_rather_than_raising() -> None:
    assert (
        detect_module._faces_from_yunet_rows(
            None, ImageSize(width=480, height=270), min_size_frac=0.045
        )
        == ()
    )


def test_the_vendored_model_matches_its_pinned_checksum() -> None:
    """A model swapped underneath the pipeline changes what it believes it saw,
    silently. That is the ADR 010 failure class, so it is asserted rather than
    trusted."""

    verify_model_checksum(MODEL_DIR / YUNET_MODEL_NAME, expected_sha256=YUNET_MODEL_SHA256)


def test_a_wrong_or_missing_model_fails_loudly(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="missing"):
        verify_model_checksum(tmp_path / "absent.onnx", expected_sha256=YUNET_MODEL_SHA256)

    tampered = tmp_path / "tampered.onnx"
    tampered.write_bytes(b"not the pinned model")
    with pytest.raises(ConfigurationError, match="checksum mismatch"):
        verify_model_checksum(tampered, expected_sha256=YUNET_MODEL_SHA256)


def test_unknown_detector_backend_is_rejected() -> None:
    with pytest.raises(ConfigurationError, match="Unsupported face detector backend"):
        build_face_detector("haar")
