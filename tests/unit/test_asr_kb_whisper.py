"""Tests for C4 ASR backends that do not require model weights."""

from __future__ import annotations

import struct
import wave
from pathlib import Path

from src.asr.align import TranscriptionRequest
from src.asr.kb_whisper import OfficialTextTranscriber, write_speech_window
from src.contracts import Speech

SAMPLE_RATE = 16_000


def test_official_text_transcriber_returns_window_relative_words(tmp_path: Path) -> None:
    analysis_wav = tmp_path / "analysis.wav"
    _write_silence_wav(analysis_wav, duration_s=5.0)
    speech = _speech(official_text="Herr talman. Tack.")
    request = TranscriptionRequest(
        speech=speech,
        analysis_wav=analysis_wav,
        debate_title="Testdebatt",
        initial_prompt="Talare: Test.",
    )

    transcript = OfficialTextTranscriber().transcribe(request)

    assert transcript.model == "official-text-timing"
    assert [word.text for word in transcript.words] == ["Herr", "talman.", "Tack."]
    assert transcript.words[0].start_s == 0.0
    assert transcript.words[-1].end_s == 3.0


def test_write_speech_window_extracts_from_analysis_wav(tmp_path: Path) -> None:
    analysis_wav = tmp_path / "analysis.wav"
    output_wav = tmp_path / "speech.wav"
    _write_silence_wav(analysis_wav, duration_s=4.0)

    write_speech_window(analysis_wav, output_wav, start_s=1.0, duration_s=2.0)

    with wave.open(str(output_wav), "rb") as wav:
        assert wav.getframerate() == SAMPLE_RATE
        assert wav.getnchannels() == 1
        assert wav.getnframes() == SAMPLE_RATE * 2


def _speech(official_text: str | None) -> Speech:
    return Speech(
        speech_id="H901AU1_anf1",
        dokid="H901AU1",
        speaker_name="Test Talare",
        party="S",
        anforandetyp="Anförande",
        start_s=10.0,
        end_s=13.0,
        official_text=official_text,
        alignment_confidence=1.0,
        needs_review=False,
    )


def _write_silence_wav(path: Path, *, duration_s: float) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        for _ in range(int(duration_s * SAMPLE_RATE)):
            wav.writeframesraw(struct.pack("<h", 0))
