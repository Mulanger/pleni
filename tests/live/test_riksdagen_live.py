"""Live schema tests for Riksdagen API drift."""

from __future__ import annotations

import pytest

from src.riksdagen.client import RiksdagenClient
from src.riksdagen.parser import parse_video_response


@pytest.mark.live
def test_live_riksdagen_video_schema_still_has_speaker_offsets() -> None:
    client = RiksdagenClient(
        user_agent="riket-pipeline/0.1 live-test",
        timeout_s=30.0,
        max_retries=2,
        min_interval_s=0.0,
    )

    payload = client.fetch_video_metadata_payload("hdc120260305fs")
    metadata = parse_video_response(payload)

    assert metadata.source.dokid == "HDC120260305fs"
    assert len(metadata.speaker_entries) > 1
    assert all(speaker.start_s >= 0 for speaker in metadata.speaker_entries)
