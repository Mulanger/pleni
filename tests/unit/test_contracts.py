"""Serialization tests for all shared contracts."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path
from typing import TypeVar

from src.contracts import (
    AudioFeatures,
    CameraKeyframe,
    CameraMode,
    CameraPlan,
    Candidate,
    ContractModel,
    FaceSample,
    FaceTrack,
    MediaInfo,
    PublishResult,
    RenderedClip,
    RenderedPaths,
    Scene,
    SelectedClip,
    Sentence,
    SentenceSpan,
    Source,
    SpeakerEntry,
    Speech,
    TimeSpan,
    Transcript,
    Word,
)

T = TypeVar("T", bound=ContractModel)


def round_trip(model: T) -> T:
    payload = model.model_dump_json()
    loaded = type(model).model_validate_json(payload)
    assert json.loads(payload) == json.loads(loaded.model_dump_json())
    return loaded


def test_source_round_trip() -> None:
    assert (
        round_trip(
            Source(
                dokid="H901AU1",
                title="Debatt om test",
                debate_type="interpellation",
                debate_date=date(2026, 1, 15),
                source_url="https://www.riksdagen.se/",
                duration_s=1200.5,
                master_sha256="a" * 64,
            )
        ).dokid
        == "H901AU1"
    )


def test_speaker_entry_round_trip() -> None:
    assert round_trip(SpeakerEntry(name="Anna Andersson", party="S", start_s=10.0, duration_s=95.0))


def test_media_info_round_trip() -> None:
    assert round_trip(
        MediaInfo(
            width=1920, height=1080, fps=25.0, duration_s=20.0, has_audio=True, video_codec="h264"
        )
    )


def test_scene_round_trip() -> None:
    assert round_trip(Scene(index=0, start_s=0.0, end_s=10.0))


def test_speech_round_trip() -> None:
    assert round_trip(
        Speech(
            speech_id="H901AU1_anf1",
            dokid="H901AU1",
            speaker_name="Anna Andersson",
            party="S",
            anforandetyp="Anförande",
            start_s=12.5,
            end_s=70.0,
            official_text="Detta är ett testanförande.",
            alignment_confidence=0.91,
            needs_review=False,
        )
    )


def test_word_round_trip() -> None:
    assert round_trip(Word(text="test", start_s=12.5, end_s=12.9, probability=0.99))


def test_sentence_round_trip() -> None:
    assert round_trip(
        Sentence(
            index=0, start_s=12.5, end_s=17.0, text="Detta är ett test.", word_indices=(0, 1, 2, 3)
        )
    )


def test_transcript_round_trip() -> None:
    assert round_trip(
        Transcript(
            speech_id="H901AU1_anf1",
            words=(Word(text="Test", start_s=12.5, end_s=12.8, probability=0.95),),
            sentences=(
                Sentence(index=0, start_s=12.5, end_s=12.8, text="Test.", word_indices=(0,)),
            ),
            model="kb-whisper-small",
            language="sv",
        )
    )


def test_audio_features_round_trip() -> None:
    assert round_trip(
        AudioFeatures(
            speech_id="H901AU1_anf1",
            frame_hz=50.0,
            rms=(0.1, 0.2),
            f0=(120.0, None),
            speech_rate_wps=(2.0, 2.4),
            pauses=(TimeSpan(start_s=18.0, end_s=18.6),),
            emphasis_events=(TimeSpan(start_s=22.0, end_s=22.2),),
        )
    )


def test_candidate_round_trip() -> None:
    assert round_trip(
        Candidate(
            speech_id="H901AU1_anf1",
            start_s=20.0,
            end_s=65.0,
            sentence_span=SentenceSpan(start_index=1, end_index=4),
            features={"number_density": 0.4},
            archetype_scores={"EXPLAIN": 1.2},
            sub_scores={"gate.self_contained": 1.0},
            gate_passed=True,
        )
    )


def test_selected_clip_round_trip() -> None:
    assert round_trip(
        SelectedClip(
            clip_id="H901AU1_anf1_c01",
            speech_id="H901AU1_anf1",
            rank=1,
            start_s=20.0,
            end_s=65.0,
            archetype="EXPLAIN",
            title="En testtitel",
            transcript="Detta är transcript.",
            topic="test",
        )
    )


def test_face_track_round_trip() -> None:
    assert round_trip(
        FaceTrack(
            clip_id="H901AU1_anf1_c01",
            track_id="track-1",
            samples=(FaceSample(t=20.0, x=500.0, y=100.0, w=160.0, h=220.0, is_speaking=True),),
        )
    )


def test_camera_plan_round_trip() -> None:
    assert round_trip(
        CameraPlan(
            clip_id="H901AU1_anf1_c01",
            keyframes=(CameraKeyframe(t=20.0, crop_x=620.0),),
            mode=CameraMode.STATIC,
        )
    )


def test_rendered_clip_round_trip() -> None:
    assert round_trip(
        RenderedClip(
            clip_id="H901AU1_anf1_c01",
            paths=RenderedPaths(
                mp4_540x960=Path("work/H901AU1/10_render/H901AU1_anf1_c01_540x960.mp4"),
                mp4_360x640=Path("work/H901AU1/10_render/H901AU1_anf1_c01_360x640.mp4"),
                thumb=Path("work/H901AU1/10_render/H901AU1_anf1_c01.webp"),
                vtt=Path("work/H901AU1/10_render/H901AU1_anf1_c01.vtt"),
            ),
            duration_s=45.0,
            bytes=123456,
        )
    )


def test_publish_result_round_trip() -> None:
    assert round_trip(
        PublishResult(
            clip_id="H901AU1_anf1_c01",
            cdn_urls={"540x960": "https://cdn.example/clip.mp4"},
            supabase_row_id="row-1",
            published_at=datetime(2026, 1, 15, 12, 0, tzinfo=UTC),
        )
    )
