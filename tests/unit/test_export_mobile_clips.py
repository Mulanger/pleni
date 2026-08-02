"""Tests for local mobile clip review exports."""

from __future__ import annotations

import json
from pathlib import Path

from scripts.export_mobile_clips import export_mobile_clips
from src.contracts import MediaInfo, SelectedClip, Speech
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
    assert manifest[0]["speaker_name"] == "Justitieministern Gunnar Strömmer"
    assert manifest[0]["party"] == "M"
    assert manifest[0]["anforandetyp"] == "Svar"
    assert manifest[0]["speech_id"] == speech.speech_id
