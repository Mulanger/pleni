"""Tests for C10 render helpers."""

from __future__ import annotations

from pathlib import Path

from src.contracts import CameraKeyframe, CameraMode, CameraPlan, MediaInfo
from src.render.ffmpeg import has_faststart_moov, sendcmd_lines
from src.render.thumbnail import crop_x_at_time


def test_sendcmd_lines_are_relative_to_clip_start() -> None:
    plan = CameraPlan(
        clip_id="clip-1",
        keyframes=(
            CameraKeyframe(t=42.0, crop_x=200.4),
            CameraKeyframe(t=55.5, crop_x=300.5),
        ),
        mode=CameraMode.STATIC,
    )

    assert sendcmd_lines(plan.keyframes, clip_start_s=40.0) == (
        "2.000 crop x 200;",
        "15.500 crop x 300;",
    )


def test_crop_x_at_time_uses_last_keyframe() -> None:
    media = MediaInfo(
        width=1280, height=720, fps=50.0, duration_s=100.0, has_audio=True, video_codec="h264"
    )
    plan = CameraPlan(
        clip_id="clip-1",
        keyframes=(
            CameraKeyframe(t=10.0, crop_x=100.0),
            CameraKeyframe(t=12.0, crop_x=900.0),
        ),
        mode=CameraMode.STATIC,
    )

    assert crop_x_at_time(plan, 11.0, media_info=media, crop_width=406) == 100
    assert crop_x_at_time(plan, 13.0, media_info=media, crop_width=406) == 874


def test_has_faststart_moov_checks_atom_order(tmp_path: Path) -> None:
    fast = tmp_path / "fast.mp4"
    slow = tmp_path / "slow.mp4"
    fast.write_bytes(b"ftyp....moov....mdat")
    slow.write_bytes(b"ftyp....mdat....moov")

    assert has_faststart_moov(fast)
    assert not has_faststart_moov(slow)
