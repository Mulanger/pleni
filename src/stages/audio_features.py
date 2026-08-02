"""C5 stage: extract frame-level audio delivery features."""

from __future__ import annotations

import argparse
import math
import time
from collections.abc import Sequence
from pathlib import Path

from src.config import get_settings
from src.contracts import AudioFeatures, Speech, Transcript
from src.errors import StageExecutionError
from src.features.audio.emphasis import detect_emphasis_events
from src.features.audio.energy import (
    FRAME_HZ,
    AudioBuffer,
    frame_count_for_speech,
    read_analysis_wav,
    rms_frames,
    rolling_speech_rate_wps,
    samples_per_frame,
)
from src.features.audio.pauses import detect_pauses
from src.features.audio.pitch import f0_frames
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.stages._io import read_model, read_model_list, write_json


def extract_audio_features_dokid(dokid: str, *, work_dir: Path | str) -> list[Path]:
    """Write one `05_audio_features/<speech_id>.json` artifact per speech."""

    paths = work_paths(dokid, root=Path(work_dir))
    audio = read_analysis_wav(paths.analysis_wav)
    frame_samples = samples_per_frame(audio.sample_rate)
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    written: list[Path] = []
    for speech in speeches:
        transcript = read_model(
            paths.transcript_json(speech.speech_id),
            Transcript,
            "C4 transcript artifact",
        )
        features = extract_audio_features_for_speech(
            audio,
            speech,
            transcript,
            frame_samples=frame_samples,
        )
        artifact = paths.audio_features_json(speech.speech_id)
        write_json(artifact, features.model_dump(mode="json"))
        written.append(artifact)
    return written


def extract_audio_features_for_speech(
    audio: AudioBuffer,
    speech: Speech,
    transcript: Transcript,
    *,
    frame_samples: int | None = None,
) -> AudioFeatures:
    """Extract C5 features for one C3 speech interval."""

    if transcript.speech_id != speech.speech_id:
        raise StageExecutionError(
            f"Transcript {transcript.speech_id} does not match speech {speech.speech_id}"
        )

    active_frame_samples = frame_samples or samples_per_frame(audio.sample_rate)
    frame_count = frame_count_for_speech(speech)
    speech_samples = audio.slice_samples(float(speech.start_s), float(speech.end_s))
    rms = rms_frames(
        speech_samples,
        frame_samples=active_frame_samples,
        frame_count=frame_count,
    )
    f0 = _fit_length(
        f0_frames(
            speech_samples,
            sample_rate=audio.sample_rate,
            frame_samples=active_frame_samples,
            frame_count=frame_count,
        ),
        frame_count,
        fill=None,
    )
    speech_rate = _fit_length(
        rolling_speech_rate_wps(
            transcript.words,
            speech_start_s=float(speech.start_s),
            speech_end_s=float(speech.end_s),
            frame_count=frame_count,
        ),
        frame_count,
        fill=0.0,
    )
    pauses = detect_pauses(
        rms,
        speech_start_s=float(speech.start_s),
        speech_end_s=float(speech.end_s),
        frame_hz=FRAME_HZ,
    )
    emphasis_events = detect_emphasis_events(
        rms,
        speech_start_s=float(speech.start_s),
        speech_end_s=float(speech.end_s),
        frame_hz=FRAME_HZ,
    )
    return AudioFeatures(
        speech_id=speech.speech_id,
        frame_hz=FRAME_HZ,
        rms=tuple(_finite_float(value) for value in rms),
        f0=tuple(_finite_optional_float(value) for value in f0),
        speech_rate_wps=tuple(_finite_float(value) for value in speech_rate),
        pauses=tuple(pauses),
        emphasis_events=tuple(emphasis_events),
    )


def main() -> None:
    """Run the C5 audio feature stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C5_audio_features", dokid=args.dokid)
    artifacts = extract_audio_features_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


def _fit_length(
    values: Sequence[float | None],
    expected_length: int,
    *,
    fill: float | None,
) -> list[float | None]:
    fitted = list(values[:expected_length])
    while len(fitted) < expected_length:
        fitted.append(fill)
    return fitted


def _finite_float(value: float | None) -> float:
    if value is None or not math.isfinite(value):
        return 0.0
    return float(value)


def _finite_optional_float(value: float | None) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return float(value)


if __name__ == "__main__":
    main()
