"""Integration tests for the C11 publish stage."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import date
from pathlib import Path

from src.contracts import Candidate, PublishResult, SelectedClip, SentenceSpan, Source, Speech, Word
from src.paths import work_paths
from src.publish.bunny import BunnyUploadedObject
from src.publish.migrations import discover_migrations
from src.publish.supabase import SupabasePublishBatch
from src.stages.publish import publish_dokid


class FakeBunnyUploader:
    def __init__(self) -> None:
        self.uploads: list[tuple[Path, str, str]] = []

    def upload_file(
        self,
        local_path: Path,
        remote_path: str,
        *,
        content_type: str,
    ) -> BunnyUploadedObject:
        self.uploads.append((local_path, remote_path, content_type))
        return BunnyUploadedObject(
            remote_path=remote_path,
            public_url=f"https://cdn.example/{remote_path}",
            bytes=local_path.stat().st_size,
        )


class FakeSupabasePublisher:
    """Stands in for the Management API with an empty migration ledger."""

    def __init__(self) -> None:
        self.statements: list[str] = []
        self.batches: list[SupabasePublishBatch] = []

    def execute_sql(self, query: str) -> Mapping[str, object]:
        self.statements.append(query)
        if "from public.schema_migrations" in query:
            return {"result": []}
        return {}

    def publish_batch(self, batch: SupabasePublishBatch) -> Mapping[str, object]:
        self.batches.append(batch)
        return {"ok": True}


def test_remote_publish_uploads_then_writes_metadata(tmp_path: Path) -> None:
    dokid = "HDTEST"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    source = Source(
        dokid=dokid,
        title="Debatt om lokal polis",
        debate_type="interpellationsdebatt",
        debate_date=date(2026, 8, 2),
        source_url="https://www.riksdagen.se/video",
        duration_s=100.0,
        master_sha256="a" * 64,
    )
    speech = Speech(
        speech_id=f"{dokid}_anf1",
        dokid=dokid,
        speaker_name="Test Speaker (S)",
        party="S",
        anforandetyp="Anförande",
        start_s=10.0,
        end_s=80.0,
        official_text="Detta är ett test.",
        alignment_confidence=0.9,
        needs_review=False,
    )
    selected = SelectedClip(
        clip_id=f"{speech.speech_id}_c01",
        speech_id=speech.speech_id,
        rank=1,
        start_s=20.0,
        end_s=60.0,
        archetype="EXPLAIN",
        title="Test title",
        transcript="Detta är ett test.",
        topic="polis",
    )
    candidate = Candidate(
        speech_id=speech.speech_id,
        start_s=selected.start_s,
        end_s=selected.end_s,
        sentence_span=SentenceSpan(start_index=0, end_index=1),
        features={"self_contained": 1.0},
        archetype_scores={"EXPLAIN": 2.0},
        sub_scores={"final_score": 2.0},
        gate_passed=True,
        reject_reason=None,
    )
    rejected = Candidate(
        speech_id=speech.speech_id,
        start_s=61.0,
        end_s=99.0,
        sentence_span=SentenceSpan(start_index=2, end_index=3),
        features={"self_contained": 0.0},
        archetype_scores={},
        sub_scores={"final_score": -1.0},
        gate_passed=False,
        reject_reason="dangling_opener",
    )
    paths.source_json.write_text(
        json.dumps(
            {
                "source": source.model_dump(mode="json"),
                "anforanden": [
                    {
                        "anforande_id": "anf1",
                        "intressent_id": "12345",
                        "speaker_name": speech.speaker_name,
                        "party": speech.party,
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    paths.speeches_json.write_text(
        json.dumps([speech.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    paths.selected_json(speech.speech_id).write_text(
        json.dumps([selected.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    paths.candidates_json(speech.speech_id).write_text(
        json.dumps(
            [candidate.model_dump(mode="json"), rejected.model_dump(mode="json")],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    transcript_payload = {
        "speech_id": speech.speech_id,
        "words": [
            Word(text="Detta", start_s=20.0, end_s=20.5, probability=1.0).model_dump(mode="json")
        ],
        "sentences": [],
        "model": "test",
        "language": "sv",
    }
    paths.transcript_json(speech.speech_id).write_text(
        json.dumps(transcript_payload, ensure_ascii=False),
        encoding="utf-8",
    )
    paths.render_primary_mp4(selected.clip_id).write_bytes(b"mp4")
    paths.render_thumb(selected.clip_id).write_bytes(b"webp")
    bunny = FakeBunnyUploader()
    supabase = FakeSupabasePublisher()

    artifacts = publish_dokid(
        dokid,
        work_dir=tmp_path,
        backend="remote",
        apply_migrations=True,
        bunny_uploader=bunny,
        supabase_publisher=supabase,
    )

    assert artifacts == [paths.publish_json(selected.clip_id)]
    assert [upload[1] for upload in bunny.uploads] == [
        f"clips/2026/08/{selected.clip_id}_540x960.mp4",
        f"thumbs/2026/08/{selected.clip_id}.webp",
    ]
    # Every committed migration was applied against an empty ledger, and each
    # one recorded a ledger row. Derived from the directory rather than a
    # hardcoded list so adding migration 005 does not fail this test.
    expected = discover_migrations()
    ledger_writes = [s for s in supabase.statements if "insert into public.schema_migrations" in s]
    assert len(ledger_writes) == len(expected)
    for path in expected:
        assert any(path.name in statement for statement in ledger_writes), path.name
    payload = supabase.batches[0].to_payload()
    assert payload["pipeline_run"]["idempotency_key"] == f"publish:{dokid}:v1"
    assert payload["politicians"] == [
        {
            "intressent_id": "12345",
            "name": speech.speaker_name,
            "party": speech.party,
            "constituency": None,
            "role": "ledamot",
            "avatar_url": None,
        }
    ]
    assert len(payload["clip_features"]) == 2
    clip_row = payload["clips"][0]
    assert isinstance(clip_row, dict)
    assert clip_row["url_540x960"].endswith("_540x960.mp4")
    assert clip_row["thumb_url"].endswith(".webp")
    assert clip_row["vtt_url"] is None
    result = PublishResult.model_validate_json(artifacts[0].read_text(encoding="utf-8"))
    assert result.supabase_row_id == selected.clip_id
    assert result.cdn_urls["540x960"].startswith("https://cdn.example/")
