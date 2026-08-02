"""Integration tests for the C5 audio feature stage."""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

from src.contracts import AudioFeatures, Sentence, Speech, Transcript, Word
from src.paths import work_paths
from src.stages.audio_features import extract_audio_features_dokid

SAMPLE_RATE = 16_000


def test_audio_features_stage_writes_dense_feature_arrays(tmp_path: Path) -> None:
    dokid = "audiofixture"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    speech = _speech(dokid)
    transcript = _transcript(speech)
    paths.speeches_json.write_text(
        json.dumps([speech.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    paths.transcript_json(speech.speech_id).write_text(
        transcript.model_dump_json(),
        encoding="utf-8",
    )
    _write_analysis_wav(paths.analysis_wav)

    artifacts = extract_audio_features_dokid(dokid, work_dir=tmp_path)

    assert artifacts == [paths.audio_features_json(speech.speech_id)]
    features = AudioFeatures.model_validate_json(artifacts[0].read_text(encoding="utf-8"))
    assert features.speech_id == speech.speech_id
    assert features.frame_hz == 50.0
    assert len(features.rms) == 100
    assert len(features.f0) == len(features.rms)
    assert len(features.speech_rate_wps) == len(features.rms)
    assert all(math.isfinite(value) for value in features.rms)
    assert all(value is None or math.isfinite(value) for value in features.f0)
    assert all(math.isfinite(value) for value in features.speech_rate_wps)
    assert max(features.rms) > min(features.rms)
    assert any(value is not None for value in features.f0)
    assert len(features.pauses) == 1
    assert features.pauses[0].start_s == 1.8
    assert features.pauses[0].end_s == 2.3
    assert max(features.speech_rate_wps) > 0.0


def _speech(dokid: str) -> Speech:
    return Speech(
        speech_id=f"{dokid}_anf1",
        dokid=dokid,
        speaker_name="Test Talare",
        party="S",
        anforandetyp="Anförande",
        start_s=1.0,
        end_s=3.0,
        official_text="Ett två tre fyra.",
        alignment_confidence=1.0,
        needs_review=False,
    )


def _transcript(speech: Speech) -> Transcript:
    words = (
        Word(text="Ett", start_s=1.1, end_s=1.3, probability=1.0),
        Word(text="två", start_s=1.4, end_s=1.6, probability=1.0),
        Word(text="tre", start_s=2.4, end_s=2.6, probability=1.0),
        Word(text="fyra.", start_s=2.7, end_s=2.9, probability=1.0),
    )
    return Transcript(
        speech_id=speech.speech_id,
        words=words,
        sentences=(
            Sentence(
                index=0,
                start_s=1.1,
                end_s=2.9,
                text="Ett två tre fyra.",
                word_indices=(0, 1, 2, 3),
            ),
        ),
        model="test",
        language="sv",
    )


def _write_analysis_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        _write_sine(wav, 1.0, amplitude=0)
        _write_sine(wav, 0.8, amplitude=8000)
        _write_sine(wav, 0.5, amplitude=0)
        _write_sine(wav, 0.7, amplitude=14000)
        _write_sine(wav, 1.0, amplitude=0)


def _write_sine(wav: wave.Wave_write, duration_s: float, *, amplitude: int) -> None:
    sample_count = round(duration_s * SAMPLE_RATE)
    for index in range(sample_count):
        value = 0
        if amplitude:
            value = int(amplitude * math.sin(2.0 * math.pi * 220.0 * index / SAMPLE_RATE))
        wav.writeframesraw(struct.pack("<h", value))
