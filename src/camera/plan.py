"""Deterministic virtual-camera planning for C9.

Input face samples and scene cuts use master-relative timestamps. Output
keyframes also use master-relative timestamps and crop positions in source
master-video pixels.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from statistics import median

from src.camera.smooth import collapse_stable_targets, rate_limit_targets
from src.contracts import (
    CameraKeyframe,
    CameraMode,
    CameraPlan,
    FaceSample,
    FaceTrack,
    MediaInfo,
    Scene,
    SelectedClip,
)


@dataclass(frozen=True)
class ShotWindow:
    """A scene interval clipped to one selected clip."""

    start_s: float
    end_s: float


def plan_camera_for_clip(
    clip: SelectedClip,
    face_track: FaceTrack,
    scenes: Sequence[Scene],
    media_info: MediaInfo,
    *,
    dead_zone_frac: float,
    max_pan_px_s_1080: float,
) -> CameraPlan:
    """Build a C9 camera plan for one selected clip."""

    crop_width, _crop_height = crop_size_for_media(media_info)
    center_crop_x = clamp_crop_x(
        (float(media_info.width) - crop_width) / 2.0, media_info, crop_width
    )
    max_pan_velocity = max_pan_px_s_1080 * (float(media_info.height) / 1080.0)
    keyframes: list[tuple[float, float]] = []
    mode = CameraMode.STATIC
    last_crop_x = center_crop_x

    for shot in shot_windows_for_clip(clip, scenes):
        samples = _samples_in_window(face_track.samples, shot)
        if not samples:
            keyframes.append((shot.start_s, last_crop_x))
            continue
        shot_targets = _shot_targets(
            samples,
            shot_start_s=shot.start_s,
            media_info=media_info,
            crop_width=crop_width,
        )
        crop_values = [target_x for _t, target_x in shot_targets]
        drift_px = max(crop_values) - min(crop_values) if crop_values else 0.0
        if drift_px <= float(media_info.width) * dead_zone_frac:
            last_crop_x = clamp_crop_x(median(crop_values), media_info, crop_width)
            keyframes.append((shot.start_s, last_crop_x))
            continue

        mode = CameraMode.PAN
        limited = rate_limit_targets(shot_targets, max_velocity_px_s=max_pan_velocity)
        for t, crop_x in collapse_stable_targets(limited):
            last_crop_x = clamp_crop_x(crop_x, media_info, crop_width)
            keyframes.append((t, last_crop_x))

    if not keyframes:
        keyframes.append((float(clip.start_s), center_crop_x))

    return CameraPlan(
        clip_id=clip.clip_id,
        keyframes=tuple(
            CameraKeyframe(
                t=max(float(clip.start_s), t), crop_x=clamp_crop_x(x, media_info, crop_width)
            )
            for t, x in _dedupe_keyframes(keyframes)
        ),
        mode=mode,
    )


def crop_size_for_media(media_info: MediaInfo) -> tuple[int, int]:
    """Return the largest even 9:16 crop that fits the source media."""

    crop_height = int(media_info.height) // 2 * 2
    crop_width = _nearest_even(crop_height * 9.0 / 16.0, max_value=int(media_info.width))
    if crop_width <= media_info.width:
        return max(2, crop_width), max(2, crop_height)
    crop_width = int(media_info.width) // 2 * 2
    crop_height = _nearest_even(crop_width * 16.0 / 9.0, max_value=int(media_info.height))
    return max(2, crop_width), max(2, crop_height)


def clamp_crop_x(crop_x: float, media_info: MediaInfo, crop_width: int) -> float:
    """Clamp a crop x-position so it cannot leave the source frame."""

    max_x = max(0.0, float(media_info.width - crop_width))
    return min(max(0.0, crop_x), max_x)


def shot_windows_for_clip(clip: SelectedClip, scenes: Sequence[Scene]) -> tuple[ShotWindow, ...]:
    """Return scene windows intersected with a clip's master-relative interval."""

    clip_start = float(clip.start_s)
    clip_end = float(clip.end_s)
    windows = [
        ShotWindow(
            start_s=max(clip_start, float(scene.start_s)),
            end_s=min(clip_end, float(scene.end_s)),
        )
        for scene in scenes
        if float(scene.end_s) > clip_start and float(scene.start_s) < clip_end
    ]
    if not windows:
        return (ShotWindow(start_s=clip_start, end_s=clip_end),)
    return tuple(window for window in windows if window.end_s > window.start_s)


def crop_x_for_face(sample: FaceSample, media_info: MediaInfo, crop_width: int) -> float:
    """Center the horizontal crop on the active face sample."""

    face_center_x = float(sample.x + sample.w / 2.0)
    return clamp_crop_x(face_center_x - crop_width / 2.0, media_info, crop_width)


def _shot_targets(
    samples: Sequence[FaceSample],
    *,
    shot_start_s: float,
    media_info: MediaInfo,
    crop_width: int,
) -> tuple[tuple[float, float], ...]:
    targets = [
        (float(sample.t), crop_x_for_face(sample, media_info, crop_width)) for sample in samples
    ]
    if not targets:
        return ()
    first_t, first_x = targets[0]
    if first_t > shot_start_s:
        targets.insert(0, (shot_start_s, first_x))
    else:
        targets[0] = (shot_start_s, first_x)
    return tuple(targets)


def _samples_in_window(samples: Sequence[FaceSample], shot: ShotWindow) -> tuple[FaceSample, ...]:
    return tuple(
        sample
        for sample in sorted(samples, key=lambda item: item.t)
        if shot.start_s <= float(sample.t) < shot.end_s
    )


def _dedupe_keyframes(keyframes: Sequence[tuple[float, float]]) -> tuple[tuple[float, float], ...]:
    output: list[tuple[float, float]] = []
    for t, x in sorted(keyframes, key=lambda item: item[0]):
        if output and abs(output[-1][0] - t) < 1e-6:
            output[-1] = (t, x)
            continue
        output.append((t, x))
    return tuple(output)


def _nearest_even(value: float, *, max_value: int) -> int:
    rounded = round(value)
    if rounded % 2 == 0:
        return min(rounded, max_value // 2 * 2)
    higher = rounded + 1
    if higher <= max_value:
        return higher
    return max(2, rounded - 1)
