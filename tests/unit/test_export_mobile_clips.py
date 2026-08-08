"""Tests for local mobile clip review exports."""

from __future__ import annotations

import json
from pathlib import Path

from scripts.export_mobile_clips import export_mobile_clips
from src.contracts import (
    FaceTrack,
    MediaInfo,
    SelectedClip,
    Speech,
    TimeSpan,
    VerificationDecision,
)
from src.paths import work_paths


def test_export_mobile_clips_manifest_includes_speaker_metadata(tmp_path: Path) -> None:
    dokid = "exportfixture"
    work_root = tmp_path / "work"
    output_dir = tmp_path / "review"
    paths = work_paths(dokid, root=work_root)
    paths.ensure_directories()
    speech = Speech(
        speech_id=f"{dokid}_anf1",
        dokid=dokid,
        speaker_name="Justitieministern Gunnar Strömmer",
        party="M",
        anforandetyp="Svar",
        start_s=10.0,
        end_s=80.0,
        official_text="Detta är ett test.",
        alignment_confidence=1.0,
        needs_review=False,
    )
    clip = SelectedClip(
        clip_id=f"{speech.speech_id}_c01",
        speech_id=speech.speech_id,
        rank=1,
        start_s=20.0,
        end_s=60.0,
        archetype="CONFRONT",
        title="En testtitel",
        transcript="Detta är ett test.",
        topic=None,
    )
    paths.speeches_json.write_text(
        json.dumps([speech.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    paths.selected_json(speech.speech_id).write_text(
        json.dumps([clip.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    paths.render_primary_mp4(clip.clip_id).write_bytes(b"fake mp4")
    paths.render_thumb(clip.clip_id).write_bytes(b"fake webp")

    exported = export_mobile_clips(
        dokid,
        work_dir=work_root,
        output_dir=output_dir,
        probe=lambda _path: MediaInfo(
            width=540,
            height=960,
            fps=50.0,
            duration_s=40.0,
            has_audio=True,
            video_codec="h264",
        ),
        faststart_probe=lambda _path: True,
    )

    manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
    assert len(exported) == 1
    accepted = manifest["accepted"]
    assert accepted[0]["speaker_name"] == "Justitieministern Gunnar Strömmer"
    assert accepted[0]["party"] == "M"
    assert accepted[0]["anforandetyp"] == "Svar"
    assert accepted[0]["speech_id"] == speech.speech_id
    assert manifest["rejected"] == []


def test_a_clip_c8_refused_is_listed_with_its_reason_not_silently_dropped(
    tmp_path: Path,
) -> None:
    """Exporting only what rendered hides half of what the pipeline decided.

    A reviewer needs to see that a clip was selected on text and then refused on
    identity, and why -- those are the clips the old pipeline published
    mis-framed, so they are the most informative rows in the sheet.
    """

    dokid = "rejectfixture"
    work_root = tmp_path / "work"
    output_dir = tmp_path / "review"
    paths = work_paths(dokid, root=work_root)
    paths.ensure_directories()
    speech = Speech(
        speech_id=f"{dokid}_anf1",
        dokid=dokid,
        speaker_name="Anna Tenje",
        party="M",
        anforandetyp="Svar",
        start_s=10.0,
        end_s=80.0,
        official_text="Detta är ett test.",
        alignment_confidence=1.0,
        needs_review=False,
    )
    clip = SelectedClip(
        clip_id=f"{speech.speech_id}_c01",
        speech_id=speech.speech_id,
        rank=1,
        start_s=20.0,
        end_s=60.0,
        archetype="EXPLAIN",
        title="En testtitel",
        transcript="Detta är ett test.",
        topic=None,
    )
    paths.speeches_json.write_text(
        json.dumps([speech.model_dump(mode="json")], ensure_ascii=False), encoding="utf-8"
    )
    paths.selected_json(speech.speech_id).write_text(
        json.dumps([clip.model_dump(mode="json")], ensure_ascii=False), encoding="utf-8"
    )
    # No rendered MP4: C8 refused this clip.
    paths.track_json(clip.clip_id).write_text(
        FaceTrack(
            clip_id=clip.clip_id,
            track_id="unverified",
            samples=(),
            decision=VerificationDecision.REJECTED_NO_EVIDENCE,
            unsupported_spans=(TimeSpan(start_s=30.0, end_s=42.0),),
            reasons=("shot_1:median_similarity_below_floor",),
        ).model_dump_json(),
        encoding="utf-8",
    )

    exported = export_mobile_clips(dokid, work_dir=work_root, output_dir=output_dir)

    assert exported == []
    manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["accepted"] == []
    (row,) = manifest["rejected"]
    assert row["speaker_name"] == "Anna Tenje"
    assert row["decision"] == "rejected_no_evidence"
    assert row["unverified_s"] == 12.0
    assert "median_similarity_below_floor" in row["reasons"][0]

    readme = (output_dir / "README.md").read_text(encoding="utf-8")
    assert "Rejected, and why" in readme
    assert "Anna Tenje" in readme
