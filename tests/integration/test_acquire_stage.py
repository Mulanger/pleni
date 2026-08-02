"""Integration tests for the C2 acquisition stage."""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from src.contracts import MediaInfo, Scene, Source
from src.paths import work_paths
from src.stages.acquire import acquire_dokid
from tests.conftest import assert_matches_golden


@contextmanager
def media_server(body: bytes) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/master.mp4"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_acquire_stage_writes_c2_artifacts(tmp_path: Path) -> None:
    dokid = "fixture"
    body = Path("tests/fixtures/synthetic/hard_cut_20s.mp4").read_bytes()

    with media_server(body) as media_url:
        paths = work_paths(dokid, root=tmp_path)
        paths.ensure_directories()
        source = Source(
            dokid=dokid,
            title="Synthetic debate",
            debate_type="test",
            debate_date=date(2026, 1, 1),
            source_url="https://example.test/synthetic",
            duration_s=20.0,
            master_sha256=hashlib.sha256(body).hexdigest(),
        )
        paths.source_json.write_text(
            json.dumps(
                {
                    "source": source.model_dump(mode="json"),
                    "speaker_entries": [],
                    "anforanden": [],
                    "media_urls": {
                        "stream_url": None,
                        "download_url": media_url,
                        "audio_url": None,
                        "poster_url": None,
                    },
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

        result = acquire_dokid(dokid, work_dir=tmp_path)

    assert result.media_json == paths.media_json
    assert paths.master.read_bytes() == body
    assert paths.analysis_wav.exists()
    assert len(list(paths.frames_dir.glob("*.jpg"))) == 100
    assert MediaInfo.model_validate_json(paths.media_json.read_text(encoding="utf-8"))
    scenes_payload = json.loads(paths.scenes_json.read_text(encoding="utf-8"))
    for raw_scene in scenes_payload:
        Scene.model_validate(raw_scene)
    assert_matches_golden(scenes_payload, Path("tests/fixtures/golden/02_scenes_synthetic.json"))
