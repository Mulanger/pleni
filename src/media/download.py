"""Download and remux helpers for C2 media acquisition."""

from __future__ import annotations

import hashlib
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from src.errors import ArtifactError, ExternalServiceError, StageExecutionError
from src.media.ffprobe import ffmpeg_executable

DEFAULT_CHUNK_SIZE = 1024 * 1024
DEFAULT_BACKOFF_BASE_S = 0.5


@dataclass(frozen=True)
class DownloadResult:
    """Result metadata for a completed or skipped media download."""

    url: str
    path: Path
    bytes_written: int
    sha256: str
    resumed: bool
    skipped: bool


def sha256_file(path: Path | str) -> str:
    """Return the hex SHA-256 digest for a local file."""

    digest = hashlib.sha256()
    with Path(path).open("rb") as file:
        for chunk in iter(lambda: file.read(DEFAULT_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_hls_url(url: str) -> bool:
    """Return true when a media URL points at an HLS playlist."""

    return url.split("?", maxsplit=1)[0].lower().endswith(".m3u8")


def download_with_resume(
    url: str,
    target_path: Path | str,
    *,
    expected_sha256: str | None = None,
    user_agent: str,
    timeout_s: float,
    max_retries: int,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> DownloadResult:
    """Stream an HTTP(S) media file to disk, resuming from `<target>.part` when possible."""

    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() and target.stat().st_size > 0:
        digest = sha256_file(target)
        if expected_sha256 is None or digest == expected_sha256:
            return DownloadResult(
                url=url,
                path=target,
                bytes_written=target.stat().st_size,
                sha256=digest,
                resumed=False,
                skipped=True,
            )
        raise ArtifactError(f"Existing file checksum mismatch for {target}")

    part_path = target.with_name(f"{target.name}.part")
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            resumed = _download_attempt(
                url=url,
                target=target,
                part_path=part_path,
                user_agent=user_agent,
                timeout_s=timeout_s,
                chunk_size=chunk_size,
            )
            digest = sha256_file(target)
            if expected_sha256 is not None and digest != expected_sha256:
                raise ArtifactError(f"Downloaded file checksum mismatch for {target}")
            return DownloadResult(
                url=url,
                path=target,
                bytes_written=target.stat().st_size,
                sha256=digest,
                resumed=resumed,
                skipped=False,
            )
        except (ExternalServiceError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if attempt >= max_retries:
                break
            sleep_fn(DEFAULT_BACKOFF_BASE_S * (2**attempt))
    raise ExternalServiceError(f"Download failed after {max_retries + 1} attempts: {last_error}")


def remux_hls_to_mp4(
    url: str,
    target_path: Path | str,
    *,
    user_agent: str,
    ffmpeg_path: str | None = None,
) -> DownloadResult:
    """Remux an HLS stream into MP4 with stream copy and return the final checksum."""

    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        digest = sha256_file(target)
        return DownloadResult(
            url=url,
            path=target,
            bytes_written=target.stat().st_size,
            sha256=digest,
            resumed=False,
            skipped=True,
        )

    temp_path = target.with_name(f"{target.name}.part")
    command = [
        ffmpeg_path or ffmpeg_executable(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-user_agent",
        user_agent,
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
        "-i",
        url,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(temp_path),
    ]
    completed = _run_process(command)
    if completed != 0:
        raise StageExecutionError(f"ffmpeg HLS remux failed for {url}")

    temp_path.replace(target)
    digest = sha256_file(target)
    return DownloadResult(
        url=url,
        path=target,
        bytes_written=target.stat().st_size,
        sha256=digest,
        resumed=False,
        skipped=False,
    )


def _download_attempt(
    *,
    url: str,
    target: Path,
    part_path: Path,
    user_agent: str,
    timeout_s: float,
    chunk_size: int,
) -> bool:
    existing_bytes = part_path.stat().st_size if part_path.exists() else 0
    headers = {"User-Agent": user_agent}
    if existing_bytes > 0:
        headers["Range"] = f"bytes={existing_bytes}-"

    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        status_code = response.status
        if status_code >= 400:
            raise ExternalServiceError(f"Download returned HTTP {status_code} for {url}")

        resumed = existing_bytes > 0 and status_code == 206
        mode = "ab" if resumed else "wb"
        if existing_bytes > 0 and not resumed:
            existing_bytes = 0

        with part_path.open(mode + "") as file:
            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                file.write(chunk)

    if existing_bytes == 0 and part_path.stat().st_size == 0:
        raise ExternalServiceError(f"Download wrote no bytes for {url}")
    part_path.replace(target)
    return resumed


def _run_process(command: list[str]) -> int:
    import subprocess

    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode == 0:
        return 0
    detail = completed.stderr.strip() or completed.stdout.strip()
    raise StageExecutionError(f"Command failed ({completed.returncode}): {detail}")
