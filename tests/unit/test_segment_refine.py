"""Tests for C3 boundary refinement."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from src.contracts import Scene
from src.segment.refine import (
    BoundarySource,
    MetadataSpeech,
    metadata_biased_interval,
    refine_boundaries,
    snap_to_nearest_cut,
)
from src.segment.vad import SpeechActivity


def test_metadata_bias_trims_modern_riksdagen_boundaries() -> None:
    speech = MetadataSpeech(
        anforande_id="1",
        speaker_name="Speaker",
        party=None,
        anforandetyp="Anförande",
        official_text="Text",
        start_s=10.0,
        end_s=110.0,
    )

    assert metadata_biased_interval(speech) == (12.0, 108.3)


def test_snap_to_nearest_cut_inside_tolerance() -> None:
    assert snap_to_nearest_cut(9.2, [4.0, 10.0, 20.0]) == (10.0, True)
    assert snap_to_nearest_cut(12.5, [4.0, 10.0, 20.0]) == (12.5, False)


def test_refine_uses_vad_and_scene_snapping() -> None:
    speech = MetadataSpeech(
        anforande_id="1",
        speaker_name="Speaker",
        party=None,
        anforandetyp="Anförande",
        official_text="Herr talman",
        start_s=8.0,
        end_s=30.0,
    )
    scenes = [Scene(index=0, start_s=0.0, end_s=10.0), Scene(index=1, start_s=10.0, end_s=40.0)]

    refined = refine_boundaries(
        [speech],
        vad_segments=[SpeechActivity(start_s=9.7, end_s=27.8)],
        scenes=scenes,
        media_duration_s=40.0,
    )

    assert len(refined) == 1
    assert refined[0].source is BoundarySource.VAD
    assert refined[0].start_s == 10.0
    assert refined[0].end_s == 27.8
    assert refined[0].scene_snapped


def test_refine_resolves_overlapping_adjacent_speeches() -> None:
    speeches = [
        MetadataSpeech("1", "A", "S", "Anförande", "Text", 0.0, 12.0),
        MetadataSpeech("2", "B", "M", "Anförande", "Text", 10.0, 22.0),
    ]

    refined = refine_boundaries(
        speeches,
        vad_segments=[],
        scenes=[],
        media_duration_s=30.0,
    )

    assert refined[0].end_s <= refined[1].start_s
    assert refined[0].end_s > refined[0].start_s
    assert refined[1].end_s > refined[1].start_s


def test_kblab_reference_sample_lands_within_two_seconds() -> None:
    payload = json.loads(
        Path("tests/fixtures/debates/kblab_ref/metadata_sample.json").read_text(encoding="utf-8")
    )
    debates = cast(list[dict[str, Any]], payload["debates"])
    for debate in debates:
        rows = cast(list[dict[str, Any]], debate["speeches"])
        speeches = [
            MetadataSpeech(
                anforande_id=str(row["anforande_nummer"]),
                speaker_name=str(row["speaker"]),
                party=str(row["party"]),
                anforandetyp="Anförande",
                official_text=str(row["speaker"]),
                start_s=float(row["start_s"]),
                end_s=float(row["end_s"]),
            )
            for row in rows
        ]

        refined = refine_boundaries(
            speeches,
            vad_segments=[],
            scenes=[],
            media_duration_s=None,
        )

        for boundary, row in zip(refined, rows, strict=True):
            assert abs(boundary.start_s - float(row["start_adjusted_s"])) <= 2.0
            assert abs(boundary.end_s - float(row["end_adjusted_s"])) <= 2.0
