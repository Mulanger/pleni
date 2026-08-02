"""Integration tests for the C3 segmentation stage."""

from __future__ import annotations

import json
import math
import struct
import wave
from datetime import date
from pathlib import Path

from src.contracts import MediaInfo, Scene, Source, Speech
from src.paths import work_paths
from src.stages.segment import segment_dokid

SAMPLE_RATE = 16_000


def test_segment_stage_writes_refined_speeches(tmp_path: Path) -> None:
    dokid = "segfixture"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    _write_source(paths.source_json, dokid)
    _write_analysis_wav(paths.analysis_wav)
    paths.media_json.write_text(
        MediaInfo(
            width=1280,
            height=720,
            fps=25.0,
            duration_s=20.0,
            has_audio=True,
            video_codec="h264",
        ).model_dump_json(),
        encoding="utf-8",
    )
    paths.scenes_json.write_text(
        json.dumps(
            [
                Scene(index=0, start_s=0.0, end_s=10.0).model_dump(mode="json"),
                Scene(index=1, start_s=10.0, end_s=20.0).model_dump(mode="json"),
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    artifact = segment_dokid(dokid, work_dir=tmp_path)

    speeches = [
        Speech.model_validate(item) for item in json.loads(artifact.read_text(encoding="utf-8"))
    ]
    assert len(speeches) == 2
    assert speeches[0].speech_id == f"{dokid}_anf1"
    assert speeches[0].official_text == "Herr talman. Första texten."
    assert speeches[0].alignment_confidence > 0.70
    assert speeches[1].start_s == 10.0
    assert speeches[0].end_s <= speeches[1].start_s


def _write_source(path: Path, dokid: str) -> None:
    source = Source(
        dokid=dokid,
        title="Segment fixture",
        debate_type="test",
        debate_date=date(2026, 1, 1),
        source_url="https://example.test/debate",
        duration_s=20.0,
        master_sha256=None,
    )
    payload = {
        "source": source.model_dump(mode="json"),
        "speaker_entries": [
            {"name": "A", "party": "S", "start_s": 0.0, "duration_s": 10.0},
            {"name": "B", "party": "M", "start_s": 10.0, "duration_s": 10.0},
        ],
        "anforanden": [
            {
                "anforande_id": "anf1",
                "speaker_name": "A (S)",
                "party": "S",
                "anforandetyp": "Anförande",
                "official_text": "Herr talman. Första texten.",
            },
            {
                "anforande_id": "anf2",
                "speaker_name": "B (M)",
                "party": "M",
                "anforandetyp": "Replik",
                "official_text": "Herr talman. Andra texten.",
            },
        ],
        "media_urls": {
            "stream_url": None,
            "download_url": None,
            "audio_url": None,
            "poster_url": None,
        },
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _write_analysis_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        _write_span(wav, 0.2, 0)
        _write_span(wav, 9.4, 5000)
        _write_span(wav, 0.8, 0)
        _write_span(wav, 9.0, 5000)
        _write_span(wav, 0.6, 0)


def _write_span(wav: wave.Wave_write, duration_s: float, amplitude: int) -> None:
    samples = int(duration_s * SAMPLE_RATE)
    for index in range(samples):
        value = 0
        if amplitude:
            value = int(amplitude * math.sin(2.0 * math.pi * 440.0 * index / SAMPLE_RATE))
        wav.writeframesraw(struct.pack("<h", value))
