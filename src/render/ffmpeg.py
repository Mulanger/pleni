"""ffmpeg command helpers for C10 no-caption rendering."""

from __future__ import annotations

import subprocess
from pathlib import Path

from src.camera.plan import crop_size_for_media
from src.contracts import CameraKeyframe, CameraPlan, MediaInfo, SelectedClip
from src.errors import ArtifactError, StageExecutionError
from src.media.ffprobe import ffmpeg_executable, ffmpeg_thread_args


def write_sendcmd_file(path: Path, camera_plan: CameraPlan, clip: SelectedClip) -> None:
    """Write crop-x commands using times relative to the selected clip start."""

    path.parent.mkdir(parents=True, exist_ok=True)
    commands = sendcmd_lines(camera_plan.keyframes, clip_start_s=float(clip.start_s))
    path.write_text("\n".join(commands) + "\n", encoding="utf-8")


def sendcmd_lines(
    keyframes: tuple[CameraKeyframe, ...],
    *,
    clip_start_s: float,
) -> tuple[str, ...]:
    """Return ffmpeg `sendcmd` lines for camera keyframes."""

    if not keyframes:
        return ()
    lines: list[str] = []
    for keyframe in sorted(keyframes, key=lambda item: item.t):
        relative_t = max(0.0, float(keyframe.t) - clip_start_s)
        lines.append(f"{relative_t:.3f} crop x {round(float(keyframe.crop_x))};")
    return tuple(lines)


def render_primary_clip(
    *,
    master: Path,
    output: Path,
    sendcmd: Path,
    clip: SelectedClip,
    camera_plan: CameraPlan,
    media_info: MediaInfo,
    output_width: int,
    output_height: int,
    crf: int,
    preset: str,
    ffmpeg_path: str | None = None,
) -> None:
    """Encode one 540x960 MP4 by seeking directly into the master media."""

    if not master.exists():
        raise ArtifactError(f"C2 master media is missing: {master}")
    output.parent.mkdir(parents=True, exist_ok=True)
    crop_width, crop_height = crop_size_for_media(media_info)
    first_crop_x = _initial_crop_x(camera_plan, media_info, crop_width)
    write_sendcmd_file(sendcmd, camera_plan, clip)
    duration_s = float(clip.end_s - clip.start_s)
    if duration_s <= 0.0:
        raise StageExecutionError(f"Selected clip has non-positive duration: {clip.clip_id}")

    filter_chain = (
        f"sendcmd=f={sendcmd.name},"
        f"crop={crop_width}:{crop_height}:{first_crop_x}:0,"
        f"scale={output_width}:{output_height}:flags=lanczos,"
        "unsharp=5:5:0.8:3:3:0.4"
    )
    gop = max(1, round(float(media_info.fps) * 4.0))
    command = [
        ffmpeg_path or ffmpeg_executable(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        *ffmpeg_thread_args(),
        "-ss",
        f"{float(clip.start_s):.3f}",
        "-i",
        str(master.resolve()),
        "-t",
        f"{duration_s:.3f}",
        "-vf",
        filter_chain,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-g",
        str(gop),
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ac",
        "1",
        "-movflags",
        "+faststart",
        # again before the output: the first occurrence caps decoding, this one
        # caps libx264, which is what actually saturates the machine.
        *ffmpeg_thread_args(),
        str(output.resolve()),
    ]
    completed = subprocess.run(
        command,
        cwd=output.parent,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise StageExecutionError(f"ffmpeg render failed for {clip.clip_id}: {detail}")
    if not output.exists() or output.stat().st_size == 0:
        raise ArtifactError(f"ffmpeg did not write render output: {output}")


def has_faststart_moov(mp4_path: Path) -> bool:
    """Return whether the MP4 `moov` atom appears before `mdat`."""

    data = mp4_path.read_bytes()[:1_000_000]
    moov_index = data.find(b"moov")
    mdat_index = data.find(b"mdat")
    return moov_index != -1 and (mdat_index == -1 or moov_index < mdat_index)


def _initial_crop_x(camera_plan: CameraPlan, media_info: MediaInfo, crop_width: int) -> int:
    if camera_plan.keyframes:
        raw_crop_x = float(camera_plan.keyframes[0].crop_x)
    else:
        raw_crop_x = (float(media_info.width) - crop_width) / 2.0
    max_x = max(0.0, float(media_info.width - crop_width))
    return round(min(max(0.0, raw_crop_x), max_x))
