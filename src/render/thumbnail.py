"""Thumbnail extraction for C10."""

from __future__ import annotations

import subprocess
from pathlib import Path

from src.camera.plan import crop_size_for_media
from src.contracts import CameraPlan, MediaInfo, SelectedClip
from src.errors import ArtifactError, StageExecutionError
from src.media.ffprobe import ffmpeg_executable


def write_thumbnail(
    *,
    master: Path,
    output: Path,
    clip: SelectedClip,
    camera_plan: CameraPlan,
    media_info: MediaInfo,
    output_width: int,
    output_height: int,
    offset_s: float,
    ffmpeg_path: str | None = None,
) -> None:
    """Write a vertical WebP thumbnail inside the selected clip range."""

    if not master.exists():
        raise ArtifactError(f"C2 master media is missing: {master}")
    output.parent.mkdir(parents=True, exist_ok=True)
    seek_s = min(
        max(float(clip.start_s), float(clip.start_s) + offset_s),
        max(float(clip.start_s), float(clip.end_s) - 0.1),
    )
    crop_width, crop_height = crop_size_for_media(media_info)
    crop_x = crop_x_at_time(camera_plan, seek_s, media_info=media_info, crop_width=crop_width)
    filter_chain = (
        f"crop={crop_width}:{crop_height}:{crop_x}:0,"
        f"scale={output_width}:{output_height}:flags=lanczos,"
        "unsharp=5:5:0.8:3:3:0.4"
    )
    command = [
        ffmpeg_path or ffmpeg_executable(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{seek_s:.3f}",
        "-i",
        str(master.resolve()),
        "-frames:v",
        "1",
        "-vf",
        filter_chain,
        "-an",
        "-c:v",
        "libwebp",
        "-quality",
        "82",
        str(output.resolve()),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise StageExecutionError(f"ffmpeg thumbnail failed for {clip.clip_id}: {detail}")
    if not output.exists() or output.stat().st_size == 0:
        raise ArtifactError(f"ffmpeg did not write thumbnail: {output}")


def crop_x_at_time(
    camera_plan: CameraPlan,
    t: float,
    *,
    media_info: MediaInfo,
    crop_width: int,
) -> int:
    """Return the last planned crop x at or before a master-relative timestamp."""

    if not camera_plan.keyframes:
        return round((float(media_info.width) - crop_width) / 2.0)
    candidates = [
        keyframe
        for keyframe in sorted(camera_plan.keyframes, key=lambda item: item.t)
        if keyframe.t <= t
    ]
    keyframe = candidates[-1] if candidates else camera_plan.keyframes[0]
    max_x = max(0.0, float(media_info.width - crop_width))
    return round(min(max(0.0, float(keyframe.crop_x)), max_x))
