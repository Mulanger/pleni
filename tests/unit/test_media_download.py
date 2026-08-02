"""Tests for resumable C2 media downloads."""

from __future__ import annotations

import hashlib
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from src.media.download import download_with_resume


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


@contextmanager
def range_server(body: bytes) -> Iterator[tuple[str, list[str | None]]]:
    requests: list[str | None] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append(self.headers.get("Range"))
            range_header = self.headers.get("Range")
            start = _range_start(range_header)
            payload = body[start:]
            if start > 0:
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
            else:
                self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/media.mp4", requests
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_checksum_dedupe_skips_existing_download(tmp_path: Path) -> None:
    body = b"same media bytes" * 1024
    target = tmp_path / "master.mp4"

    with range_server(body) as (url, requests):
        first = download_with_resume(
            url,
            target,
            expected_sha256=digest(body),
            user_agent="test-agent",
            timeout_s=5.0,
            max_retries=0,
        )
        second = download_with_resume(
            url,
            target,
            expected_sha256=digest(body),
            user_agent="test-agent",
            timeout_s=5.0,
            max_retries=0,
        )

    assert first.skipped is False
    assert second.skipped is True
    assert target.read_bytes() == body
    assert len(requests) == 1


def test_resume_after_partial_download(tmp_path: Path) -> None:
    body = b"resume media bytes" * 2048
    target = tmp_path / "master.mp4"
    part = target.with_name("master.mp4.part")
    existing = body[:4096]
    part.write_bytes(existing)

    with range_server(body) as (url, requests):
        result = download_with_resume(
            url,
            target,
            expected_sha256=digest(body),
            user_agent="test-agent",
            timeout_s=5.0,
            max_retries=0,
        )

    assert result.resumed is True
    assert target.read_bytes() == body
    assert requests == [f"bytes={len(existing)}-"]


def _range_start(range_header: str | None) -> int:
    if range_header is None:
        return 0
    prefix = "bytes="
    assert range_header.startswith(prefix)
    start, _, _ = range_header.removeprefix(prefix).partition("-")
    return int(start)
