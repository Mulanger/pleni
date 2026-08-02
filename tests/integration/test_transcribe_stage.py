"""Integration tests for the C4 transcription stage."""

from __future__ import annotations

import json
import struct
import wave
from datetime import date
from pathlib import Path

from src.asr.align import RawTranscript, TimedWord, TranscriptionRequest
from src.contracts import Source, Speech, Transcript
from src.paths import WorkPaths, work_paths
from src.stages.transcribe import transcribe_dokid, transcript_coverage
from tests.conftest import assert_matches_golden

SAMPLE_RATE = 16_000


class FakeSpeechTranscriber:
    def __init__(self) -> None:
        self.requests: list[TranscriptionRequest] = []

    def transcribe(self, request: TranscriptionRequest) -> RawTranscript:
        self.requests.append(request)
        return RawTranscript(
            words=(
                TimedWord(text="Herr", start_s=0.0, end_s=1.0, probability=0.9),
                TimedWord(text="talman.", start_s=1.0, end_s=2.0, probability=0.8),
                TimedWord(text="Testar", start_s=2.0, end_s=3.5, probability=0.7),
                TimedWord(text="C4.", start_s=3.5, end_s=4.0, probability=0.6),
            ),
            text="Herr talman. Testar C4.",
            model="fake-kb-whisper-small",
            language="sv",
        )


class EmptySpeechTranscriber:
    def transcribe(self, request: TranscriptionRequest) -> RawTranscript:
        return RawTranscript(words=(), text="", model="fake-empty", language="sv")


def test_transcribe_stage_writes_master_relative_transcript(tmp_path: Path) -> None:
    dokid = "transcribefixture"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    speech = _write_inputs(paths, dokid)
    transcriber = FakeSpeechTranscriber()

    artifacts = transcribe_dokid(dokid, work_dir=tmp_path, transcriber=transcriber)

    assert artifacts == [paths.transcript_json(speech.speech_id)]
    transcript = Transcript.model_validate_json(artifacts[0].read_text(encoding="utf-8"))
    assert transcript_coverage(transcript, speech) == 1.0
    assert transcript.words[0].start_s == speech.start_s
    assert transcript.words[-1].end_s == speech.end_s
    assert [sentence.text for sentence in transcript.sentences] == ["Herr talman.", "Testar C4."]
    assert transcriber.requests[0].initial_prompt == (
        "Talare: Test Talare. Parti: S. Debatt: Transcription fixture."
    )
    assert_matches_golden(
        transcript.model_dump(mode="json"),
        Path("tests/fixtures/golden/04_transcript_synthetic.json"),
    )


def test_transcribe_stage_allows_empty_silent_result(tmp_path: Path) -> None:
    dokid = "emptytranscribe"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    _write_inputs(paths, dokid)

    artifacts = transcribe_dokid(dokid, work_dir=tmp_path, transcriber=EmptySpeechTranscriber())

    transcript = Transcript.model_validate_json(artifacts[0].read_text(encoding="utf-8"))
    assert transcript.words == ()
    assert transcript.sentences == ()
    assert transcript.model == "fake-empty"


def _write_inputs(work: WorkPaths, dokid: str) -> Speech:
    source = Source(
        dokid=dokid,
        title="Transcription fixture",
        debate_type="test",
        debate_date=date(2026, 1, 1),
        source_url="https://example.test/debate",
        duration_s=12.0,
        master_sha256=None,
    )
    speech = Speech(
        speech_id=f"{dokid}_anf1",
        dokid=dokid,
        speaker_name="Test Talare",
        party="S",
        anforandetyp="Anförande",
        start_s=5.0,
        end_s=9.0,
        official_text="Herr talman. Testar C4.",
        alignment_confidence=1.0,
        needs_review=False,
    )
    work.source_json.write_text(
        json.dumps({"source": source.model_dump(mode="json")}, ensure_ascii=False),
        encoding="utf-8",
    )
    work.speeches_json.write_text(
        json.dumps([speech.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    _write_silence_wav(work.analysis_wav, duration_s=12.0)
    return speech


def _write_silence_wav(path: Path, *, duration_s: float) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        for _ in range(int(duration_s * SAMPLE_RATE)):
            wav.writeframesraw(struct.pack("<h", 0))
