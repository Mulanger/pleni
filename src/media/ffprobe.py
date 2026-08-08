"""Media metadata probing for the C2 acquisition stage."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from importlib import import_module
from pathlib import Path
from typing import Any, cast

from src.contracts import MediaInfo
from src.errors import ArtifactError, StageExecutionError

FFMPEG_HEADER_RE = re.compile(
    r"Duration:\s*(?P<hours>\d{2}):(?P<minutes>\d{2}):(?P<seconds>\d{2}(?:\.\d+)?)"
)
VIDEO_STREAM_RE = re.compile(
    r"Video:\s*(?P<codec>[^,\s]+).*?,\s*(?P<width>\d{2,5})x(?P<height>\d{2,5})"
    r".*?(?P<fps>\d+(?:\.\d+)?)\s*fps",
    re.DOTALL,
)
AUDIO_STREAM_RE = re.compile(r"Audio:\s*[^,\s]+")


def ffmpeg_thread_args() -> list[str]:
    """`-threads` arguments for an ffmpeg invocation, or nothing.

    Empty by default, so ffmpeg decides for itself exactly as before. See
    `Settings.ffmpeg_threads` for why the cap exists.
    """

    from src.config import get_settings

    threads = get_settings().ffmpeg_threads
    return [] if threads <= 0 else ["-threads", str(threads)]


def ffmpeg_executable() -> str:
    """Return a usable ffmpeg executable path.

    The project uses `imageio-ffmpeg` as a pinned fallback because developer and
    CI machines are not guaranteed to have ffmpeg on PATH.
    """

    configured = shutil.which("ffmpeg")
    if configured is not None:
        return configured

    module = cast(Any, import_module("imageio_ffmpeg"))
    return str(module.get_ffmpeg_exe())


def ffprobe_executable() -> str | None:
    """Return a usable ffprobe path if the host or bundled ffmpeg package has one."""

    configured = shutil.which("ffprobe")
    if configured is not None:
        return configured

    ffmpeg_path = Path(ffmpeg_executable())
    suffixes = (".exe", "") if ffmpeg_path.suffix.lower() == ".exe" else ("", ".exe")
    for suffix in suffixes:
        candidate = ffmpeg_path.with_name(f"ffprobe{suffix}")
        if candidate.exists():
            return str(candidate)
    for candidate in ffmpeg_path.parent.glob("ffprobe*"):
        if candidate.is_file():
            return str(candidate)
    return None


def probe_media(
    media_path: Path | str, *, ffprobe_path: str | None = None, ffmpeg_path: str | None = None
) -> MediaInfo:
    """Probe master media and return the frozen C0 `MediaInfo` contract."""

    path = Path(media_path)
    if not path.exists():
        raise ArtifactError(f"Media file does not exist: {path}")

    executable = ffprobe_path if ffprobe_path is not None else ffprobe_executable()
    if executable is not None:
        return _probe_with_ffprobe(path, executable)
    return _probe_with_ffmpeg_header(path, ffmpeg_path or ffmpeg_executable())


def _probe_with_ffprobe(path: Path, executable: str) -> MediaInfo:
    command = [
        executable,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise StageExecutionError(_command_error("ffprobe failed", completed))
    payload = json.loads(completed.stdout)
    if not isinstance(payload, dict):
        raise StageExecutionError("ffprobe returned a non-object JSON payload")
    return _media_info_from_ffprobe_payload(cast(dict[str, Any], payload))


def _probe_with_ffmpeg_header(path: Path, executable: str) -> MediaInfo:
    command = [executable, "-hide_banner", "-i", str(path)]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    header = completed.stderr
    duration_match = FFMPEG_HEADER_RE.search(header)
    video_match = VIDEO_STREAM_RE.search(header)
    if duration_match is None or video_match is None:
        raise StageExecutionError(_command_error("Could not parse ffmpeg media header", completed))

    hours = int(duration_match.group("hours"))
    minutes = int(duration_match.group("minutes"))
    seconds = float(duration_match.group("seconds"))
    duration_s = hours * 3600.0 + minutes * 60.0 + seconds

    return MediaInfo(
        width=int(video_match.group("width")),
        height=int(video_match.group("height")),
        fps=float(video_match.group("fps")),
        duration_s=duration_s,
        has_audio=AUDIO_STREAM_RE.search(header) is not None,
        video_codec=video_match.group("codec"),
    )


def _media_info_from_ffprobe_payload(payload: dict[str, Any]) -> MediaInfo:
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise StageExecutionError("ffprobe payload is missing streams")

    video_stream = _first_stream(streams, "video")
    if video_stream is None:
        raise StageExecutionError("ffprobe payload is missing a video stream")
    has_audio = _first_stream(streams, "audio") is not None
    format_payload = payload.get("format")
    format_duration = (
        _optional_float(format_payload.get("duration"))
        if isinstance(format_payload, dict)
        else None
    )
    duration_s = (
        _optional_float(video_stream.get("duration"))
        or format_duration
        or _duration_from_tags(video_stream)
    )
    if duration_s is None or duration_s <= 0:
        raise StageExecutionError("ffprobe payload is missing a positive duration")

    fps = _parse_rate(_optional_str(video_stream.get("avg_frame_rate"))) or _parse_rate(
        _optional_str(video_stream.get("r_frame_rate"))
    )
    if fps is None or fps <= 0:
        raise StageExecutionError("ffprobe payload is missing a positive frame rate")

    width = _optional_int(video_stream.get("width"))
    height = _optional_int(video_stream.get("height"))
    codec = _optional_str(video_stream.get("codec_name"))
    if width is None or height is None or codec is None:
        raise StageExecutionError("ffprobe payload is missing required video metadata")

    return MediaInfo(
        width=width,
        height=height,
        fps=fps,
        duration_s=duration_s,
        has_audio=has_audio,
        video_codec=codec,
    )


def _first_stream(streams: list[Any], codec_type: str) -> dict[str, Any] | None:
    for raw_stream in streams:
        if isinstance(raw_stream, dict) and raw_stream.get("codec_type") == codec_type:
            return cast(dict[str, Any], raw_stream)
    return None


def _duration_from_tags(stream: dict[str, Any]) -> float | None:
    tags = stream.get("tags")
    if not isinstance(tags, dict):
        return None
    return _optional_float(tags.get("DURATION"))


def _parse_rate(raw: str | None) -> float | None:
    if raw is None or raw == "0/0":
        return None
    if "/" not in raw:
        return _optional_float(raw)
    numerator, denominator = raw.split("/", maxsplit=1)
    numerator_value = _optional_float(numerator)
    denominator_value = _optional_float(denominator)
    if numerator_value is None or denominator_value is None or denominator_value == 0:
        return None
    return numerator_value / denominator_value


def _optional_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str) and value.strip():
        normalized = value.strip()
        if normalized.count(":") == 2:
            hours, minutes, seconds = normalized.split(":")
            return float(hours) * 3600.0 + float(minutes) * 60.0 + float(seconds)
        try:
            return float(normalized)
        except ValueError:
            return None
    return None


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value)
    return None


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _command_error(prefix: str, completed: subprocess.CompletedProcess[str]) -> str:
    detail = completed.stderr.strip() or completed.stdout.strip()
    return f"{prefix}: {detail}"
