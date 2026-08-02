"""Generate the deterministic C0 synthetic video fixture with ffmpeg."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

OUTPUT = Path("tests/fixtures/synthetic/hard_cut_20s.mp4")


def find_ffmpeg() -> str | None:
    """Return a system ffmpeg or the pinned dev dependency fallback."""

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg is not None:
        return system_ffmpeg

    try:
        import imageio_ffmpeg
    except ImportError:
        return None

    return imageio_ffmpeg.get_ffmpeg_exe()


def main() -> None:
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise SystemExit("ffmpeg is required to generate the synthetic fixture but was not found")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1920x1080:rate=25:duration=10",
        "-f",
        "lavfi",
        "-i",
        "smptebars=size=1920x1080:rate=25:duration=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=20",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-map",
        "2:a",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        str(OUTPUT),
    ]
    subprocess.run(command, check=True)
    print(OUTPUT)


if __name__ == "__main__":
    main()
