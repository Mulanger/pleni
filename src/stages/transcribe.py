"""C4 stage: transcribe C3 speech windows into word-timed transcripts."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from src.asr.align import (
    RawTranscript,
    SpeechTranscriber,
    TranscriptionRequest,
    project_official_text_to_asr_timing,
    timing_coverage,
    to_master_words,
)
from src.asr.kb_whisper import (
    DEFAULT_COMPUTE_TYPE,
    DEFAULT_DEVICE,
    DEFAULT_MODEL_SIZE,
    MODEL_REPOSITORIES,
    OfficialTextTranscriber,
    build_transcriber,
)
from src.asr.sentences import sentences_from_words
from src.config import get_settings
from src.contracts import Source, Speech, Transcript, Word
from src.errors import ArtifactError, ContractValidationError, StageExecutionError
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.stages._io import read_json_object, read_model_list, write_json


def transcribe_dokid(
    dokid: str,
    *,
    work_dir: Path | str,
    transcriber: SpeechTranscriber | None = None,
    prefer_official_text: bool = False,
) -> list[Path]:
    """Write one `04_transcript/<speech_id>.json` artifact per C3 speech."""

    paths = work_paths(dokid, root=Path(work_dir))
    if not paths.analysis_wav.exists():
        raise ArtifactError(f"C2 analysis audio is missing: {paths.analysis_wav}")

    source = _read_source(paths.source_json)
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    active_transcriber = transcriber or OfficialTextTranscriber()
    written: list[Path] = []
    for speech in speeches:
        transcript = transcribe_speech(
            speech,
            analysis_wav=paths.analysis_wav,
            debate_title=source.title,
            transcriber=active_transcriber,
            prefer_official_text=prefer_official_text,
        )
        artifact = paths.transcript_json(speech.speech_id)
        write_json(artifact, transcript.model_dump(mode="json"))
        written.append(artifact)
    return written


def transcribe_speech(
    speech: Speech,
    *,
    analysis_wav: Path,
    debate_title: str,
    transcriber: SpeechTranscriber,
    prefer_official_text: bool = False,
) -> Transcript:
    """Transcribe one speech and return master-relative word and sentence timings."""

    request = TranscriptionRequest(
        speech=speech,
        analysis_wav=analysis_wav,
        debate_title=debate_title,
        initial_prompt=_initial_prompt(speech, debate_title),
    )
    raw_transcript = transcriber.transcribe(request)
    words = _contract_words(raw_transcript, speech, prefer_official_text=prefer_official_text)
    sentences = sentences_from_words(words)
    return Transcript(
        speech_id=speech.speech_id,
        words=tuple(words),
        sentences=tuple(sentences),
        model=raw_transcript.model,
        language=raw_transcript.language,
    )


def main() -> None:
    """Run the C4 transcribe stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    parser.add_argument(
        "--backend",
        choices=("auto", "faster-whisper", "official"),
        default="auto",
        help="ASR backend. 'official' is deterministic and model-free.",
    )
    parser.add_argument(
        "--model-size",
        choices=tuple(sorted(MODEL_REPOSITORIES)),
        default=DEFAULT_MODEL_SIZE,
        help="KBLab Whisper model size for model backends.",
    )
    parser.add_argument("--device", default=DEFAULT_DEVICE, help="Model device for faster-whisper")
    parser.add_argument(
        "--compute-type",
        default=DEFAULT_COMPUTE_TYPE,
        help="CTranslate2 compute type for faster-whisper",
    )
    parser.add_argument(
        "--prefer-official-text",
        action="store_true",
        help="Use official protocol text projected onto ASR timings.",
    )
    parser.add_argument(
        "--no-whisperx-align",
        action="store_true",
        help="Disable WhisperX forced alignment for faster-whisper backends.",
    )
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C4_transcribe", dokid=args.dokid)
    transcriber = build_transcriber(
        args.backend,
        model_size=args.model_size,
        device=args.device,
        compute_type=args.compute_type,
        use_whisperx=not args.no_whisperx_align,
    )
    artifacts = transcribe_dokid(
        args.dokid,
        work_dir=work_dir,
        transcriber=transcriber,
        prefer_official_text=args.prefer_official_text,
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print(paths_as_text(artifacts))


def _contract_words(
    raw_transcript: RawTranscript,
    speech: Speech,
    *,
    prefer_official_text: bool,
) -> list[Word]:
    words = to_master_words(
        raw_transcript.words,
        speech_start_s=float(speech.start_s),
        speech_end_s=float(speech.end_s),
    )
    if prefer_official_text and speech.official_text is not None:
        words = project_official_text_to_asr_timing(
            speech.official_text,
            words,
            speech_start_s=float(speech.start_s),
            speech_end_s=float(speech.end_s),
        )
    _validate_words(words, speech)
    return words


def _validate_words(words: list[Word], speech: Speech) -> None:
    previous_end_s = float(speech.start_s)
    for word in words:
        if word.start_s < speech.start_s or word.end_s > speech.end_s:
            raise StageExecutionError(f"Word timing is outside speech bounds: {speech.speech_id}")
        if word.start_s < previous_end_s:
            raise StageExecutionError(f"Word timings are not monotonic: {speech.speech_id}")
        previous_end_s = float(word.end_s)


def _read_source(path: Path) -> Source:
    payload = read_json_object(path, "C1 source artifact")
    source_payload = payload.get("source")
    if source_payload is None:
        raise ContractValidationError(f"C1 source artifact is missing source: {path}")
    return Source.model_validate(source_payload)


def _initial_prompt(speech: Speech, debate_title: str) -> str:
    parts = [f"Talare: {speech.speaker_name}."]
    if speech.party is not None:
        parts.append(f"Parti: {speech.party}.")
    parts.append(f"Debatt: {debate_title}.")
    return " ".join(parts)


def transcript_coverage(transcript: Transcript, speech: Speech) -> float:
    """Return transcript coverage as a fraction of the C3 speech interval."""

    return timing_coverage(list(transcript.words), speech)


def paths_as_text(paths: list[Path]) -> str:
    """Return newline-separated paths for CLI output."""

    return "\n".join(str(path) for path in paths)


if __name__ == "__main__":
    main()
