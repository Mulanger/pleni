"""KBLab Whisper backend and deterministic C4 test backend."""

from __future__ import annotations

import importlib.util
import tempfile
import wave
from collections.abc import Iterable
from importlib import import_module
from pathlib import Path
from typing import Any, cast

from src.asr.align import (
    RawTranscript,
    TimedWord,
    TranscriptionRequest,
    align_with_whisperx,
    official_text_to_timed_words,
)
from src.errors import ArtifactError, StageExecutionError

DEFAULT_MODEL_SIZE = "large"
DEFAULT_LANGUAGE = "sv"
DEFAULT_DEVICE = "auto"
DEFAULT_COMPUTE_TYPE = "default"

MODEL_REPOSITORIES = {
    "small": "KBLab/kb-whisper-small",
    "medium": "KBLab/kb-whisper-medium",
    "large": "KBLab/kb-whisper-large",
}


class OfficialTextTranscriber:
    """Deterministic backend that times official text across the speech window."""

    def transcribe(self, request: TranscriptionRequest) -> RawTranscript:
        text = _fallback_text(request)
        words = official_text_to_timed_words(text, duration_s=request.duration_s)
        return RawTranscript(
            words=words,
            text=" ".join(word.text for word in words),
            model="official-text-timing",
            language=DEFAULT_LANGUAGE,
        )


class AutoSpeechTranscriber:
    """Use faster-whisper when installed, otherwise fall back to official text timing."""

    def __init__(
        self,
        *,
        model_size: str = DEFAULT_MODEL_SIZE,
        device: str = DEFAULT_DEVICE,
        compute_type: str = DEFAULT_COMPUTE_TYPE,
        use_whisperx: bool = True,
    ) -> None:
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type
        self._use_whisperx = use_whisperx
        self._backend: FasterWhisperTranscriber | OfficialTextTranscriber | None = None

    def transcribe(self, request: TranscriptionRequest) -> RawTranscript:
        return self._get_backend().transcribe(request)

    def _get_backend(self) -> FasterWhisperTranscriber | OfficialTextTranscriber:
        if self._backend is None:
            if faster_whisper_available():
                self._backend = FasterWhisperTranscriber(
                    model_size=self._model_size,
                    device=self._device,
                    compute_type=self._compute_type,
                    use_whisperx=self._use_whisperx,
                )
            else:
                self._backend = OfficialTextTranscriber()
        return self._backend


class FasterWhisperTranscriber:
    """Transcribe speech windows with KBLab's Swedish Whisper CTranslate2 checkpoints."""

    def __init__(
        self,
        *,
        model_size: str = DEFAULT_MODEL_SIZE,
        device: str = DEFAULT_DEVICE,
        compute_type: str = DEFAULT_COMPUTE_TYPE,
        use_whisperx: bool = True,
    ) -> None:
        if model_size not in MODEL_REPOSITORIES:
            valid = ", ".join(sorted(MODEL_REPOSITORIES))
            raise StageExecutionError(
                f"Unsupported KBLab Whisper model size {model_size!r}; use {valid}"
            )
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type
        self._use_whisperx = use_whisperx
        self._model: Any | None = None

    def transcribe(self, request: TranscriptionRequest) -> RawTranscript:
        if not request.analysis_wav.exists():
            raise ArtifactError(f"C2 analysis audio is missing: {request.analysis_wav}")

        with tempfile.TemporaryDirectory(prefix="riket-asr-") as temp_dir:
            speech_wav = Path(temp_dir) / f"{request.speech.speech_id}.wav"
            write_speech_window(
                request.analysis_wav,
                speech_wav,
                start_s=float(request.speech.start_s),
                duration_s=request.duration_s,
            )
            return self._transcribe_window(speech_wav, request.initial_prompt)

    def _transcribe_window(self, speech_wav: Path, initial_prompt: str) -> RawTranscript:
        model = self._load_model()
        try:
            segments_iterable, _info = model.transcribe(
                str(speech_wav),
                language=DEFAULT_LANGUAGE,
                word_timestamps=True,
                initial_prompt=initial_prompt,
                vad_filter=False,
                beam_size=5,
            )
        except Exception as exc:
            raise StageExecutionError(f"faster-whisper transcription failed: {exc}") from exc

        words: list[TimedWord] = []
        segments_for_alignment: list[dict[str, Any]] = []
        segment_texts: list[str] = []
        for segment in cast(Iterable[Any], segments_iterable):
            text = _optional_str(getattr(segment, "text", None))
            if text is not None:
                segment_texts.append(text)
            start_s = _optional_float(getattr(segment, "start", None))
            end_s = _optional_float(getattr(segment, "end", None))
            if text is not None and start_s is not None and end_s is not None:
                segments_for_alignment.append({"start": start_s, "end": end_s, "text": text})
            segment_words = getattr(segment, "words", None)
            if segment_words is None:
                words.extend(_words_from_segment_text(segment))
                continue
            words.extend(_words_from_segment_words(segment_words))

        if self._use_whisperx and segments_for_alignment:
            aligned_segments = align_with_whisperx(
                audio_path=speech_wav,
                segments=segments_for_alignment,
                language=DEFAULT_LANGUAGE,
                device=_whisperx_device(self._device),
            )
            aligned_words = _words_from_aligned_segments(aligned_segments)
            if aligned_words:
                words = aligned_words

        return RawTranscript(
            words=tuple(words),
            text=" ".join(segment_texts).strip(),
            model=MODEL_REPOSITORIES[self._model_size],
            language=DEFAULT_LANGUAGE,
        )

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            module = cast(Any, import_module("faster_whisper"))
            model_class = module.WhisperModel
            self._model = model_class(
                MODEL_REPOSITORIES[self._model_size],
                device=self._device,
                compute_type=self._compute_type,
            )
        except ImportError as exc:
            raise StageExecutionError("faster-whisper is not installed") from exc
        except Exception as exc:
            raise StageExecutionError(f"Could not load KBLab Whisper model: {exc}") from exc
        return self._model


def faster_whisper_available() -> bool:
    """Return whether faster-whisper can be imported without loading a model."""

    try:
        return importlib.util.find_spec("faster_whisper") is not None
    except (ImportError, ValueError):
        return False


def build_transcriber(
    backend: str,
    *,
    model_size: str = DEFAULT_MODEL_SIZE,
    device: str = DEFAULT_DEVICE,
    compute_type: str = DEFAULT_COMPUTE_TYPE,
    use_whisperx: bool = True,
) -> AutoSpeechTranscriber | FasterWhisperTranscriber | OfficialTextTranscriber:
    """Construct a speech transcriber from a CLI backend name."""

    if backend == "auto":
        return AutoSpeechTranscriber(
            model_size=model_size,
            device=device,
            compute_type=compute_type,
            use_whisperx=use_whisperx,
        )
    if backend == "faster-whisper":
        return FasterWhisperTranscriber(
            model_size=model_size,
            device=device,
            compute_type=compute_type,
            use_whisperx=use_whisperx,
        )
    if backend == "official":
        return OfficialTextTranscriber()
    raise StageExecutionError(f"Unsupported transcription backend: {backend}")


def write_speech_window(
    analysis_wav: Path,
    output_wav: Path,
    *,
    start_s: float,
    duration_s: float,
) -> None:
    """Write one speech window from C2's analysis WAV without touching the master MP4."""

    if duration_s <= 0.0:
        raise StageExecutionError("Speech duration must be positive")
    if not analysis_wav.exists():
        raise ArtifactError(f"C2 analysis audio is missing: {analysis_wav}")

    output_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(analysis_wav), "rb") as source:
        sample_rate = source.getframerate()
        start_frame = max(0, round(start_s * sample_rate))
        frame_count = max(1, round(duration_s * sample_rate))
        source.setpos(min(start_frame, source.getnframes()))
        frames = source.readframes(frame_count)
        if not frames:
            raise StageExecutionError(
                f"No audio frames available for speech window in {analysis_wav}"
            )

        with wave.open(str(output_wav), "wb") as target:
            target.setnchannels(source.getnchannels())
            target.setsampwidth(source.getsampwidth())
            target.setframerate(sample_rate)
            target.writeframes(frames)


def _words_from_segment_words(segment_words: Iterable[Any]) -> list[TimedWord]:
    words: list[TimedWord] = []
    for raw_word in segment_words:
        text = _optional_str(getattr(raw_word, "word", None))
        start_s = _optional_float(getattr(raw_word, "start", None))
        end_s = _optional_float(getattr(raw_word, "end", None))
        if text is None or start_s is None or end_s is None:
            continue
        probability = _optional_float(getattr(raw_word, "probability", None)) or 0.0
        words.append(TimedWord(text=text, start_s=start_s, end_s=end_s, probability=probability))
    return words


def _words_from_aligned_segments(segments: Iterable[dict[str, Any]]) -> list[TimedWord]:
    words: list[TimedWord] = []
    for segment in segments:
        segment_words = segment.get("words")
        if not isinstance(segment_words, list):
            continue
        for raw_word in segment_words:
            if not isinstance(raw_word, dict):
                continue
            text = _optional_str(raw_word.get("word")) or _optional_str(raw_word.get("text"))
            start_s = _optional_float(raw_word.get("start"))
            end_s = _optional_float(raw_word.get("end"))
            if text is None or start_s is None or end_s is None:
                continue
            probability = _optional_float(raw_word.get("score")) or 0.0
            words.append(
                TimedWord(text=text, start_s=start_s, end_s=end_s, probability=probability)
            )
    return words


def _words_from_segment_text(segment: Any) -> list[TimedWord]:
    text = _optional_str(getattr(segment, "text", None))
    start_s = _optional_float(getattr(segment, "start", None))
    end_s = _optional_float(getattr(segment, "end", None))
    if text is None or start_s is None or end_s is None or end_s <= start_s:
        return []

    tokens = text.split()
    if not tokens:
        return []
    duration_s = end_s - start_s
    step_s = duration_s / len(tokens)
    return [
        TimedWord(
            text=token,
            start_s=start_s + step_s * index,
            end_s=end_s if index == len(tokens) - 1 else start_s + step_s * (index + 1),
            probability=0.0,
        )
        for index, token in enumerate(tokens)
    ]


def _fallback_text(request: TranscriptionRequest) -> str:
    official_text = request.speech.official_text
    if official_text is not None and official_text.strip():
        return official_text
    return request.speech.speaker_name


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _optional_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _whisperx_device(device: str) -> str:
    if device != "auto":
        return device
    try:
        torch = cast(Any, import_module("torch"))
    except ImportError:
        return "cpu"
    return "cuda" if bool(torch.cuda.is_available()) else "cpu"
