"""One-pass extraction of C2 analysis audio and frame assets."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from src.errors import ArtifactError, StageExecutionError
from src.media.ffprobe import ffmpeg_executable, ffmpeg_thread_args

ANALYSIS_SAMPLE_RATE_HZ = 16_000
ANALYSIS_AUDIO_CHANNELS = 1
ANALYSIS_FRAME_FPS = 5.0
ANALYSIS_FRAME_WIDTH_PX = 480
JPEG_QUALITY = 4


@dataclass(frozen=True)
class ExtractionResult:
    """Paths and counts for C2 analysis assets."""

    analysis_wav: Path
    frames_dir: Path
    frame_count: int


def extract_analysis_assets(
    master_path: Path | str,
    analysis_wav_path: Path | str,
    frame_pattern: Path | str,
    *,
    ffmpeg_path: str | None = None,
    frame_fps: float = ANALYSIS_FRAME_FPS,
    frame_width_px: int = ANALYSIS_FRAME_WIDTH_PX,
) -> ExtractionResult:
    """Extract 16 kHz mono WAV and 5 fps 480px-wide frames in a single ffmpeg run."""

    master = Path(master_path)
    analysis_wav = Path(analysis_wav_path)
    pattern = Path(frame_pattern)
    frames_dir = pattern.parent
    if not master.exists():
        raise ArtifactError(f"Master media does not exist: {master}")

    analysis_wav.parent.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)
    _clear_existing_frames(frames_dir)

    command = [
        ffmpeg_path or ffmpeg_executable(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        *ffmpeg_thread_args(),
        "-i",
        str(master),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        str(ANALYSIS_AUDIO_CHANNELS),
        "-ar",
        str(ANALYSIS_SAMPLE_RATE_HZ),
        "-c:a",
        "pcm_s16le",
        str(analysis_wav),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        f"fps={frame_fps},scale={frame_width_px}:-2",
        "-q:v",
        str(JPEG_QUALITY),
        str(pattern),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise StageExecutionError(f"ffmpeg extraction failed: {detail}")

    frame_count = len(list(frames_dir.glob("*.jpg")))
    if not analysis_wav.exists() or analysis_wav.stat().st_size == 0:
        raise ArtifactError(f"ffmpeg did not write analysis audio: {analysis_wav}")
    if frame_count == 0:
        raise ArtifactError(f"ffmpeg did not write analysis frames: {frames_dir}")

    return ExtractionResult(
        analysis_wav=analysis_wav,
        frames_dir=frames_dir,
        frame_count=frame_count,
    )


def _clear_existing_frames(frames_dir: Path) -> None:
    for frame_path in frames_dir.glob("*.jpg"):
        frame_path.unlink()
