"""Lightweight VAD over C2's 16 kHz mono analysis WAV."""

from __future__ import annotations

import audioop
import wave
from dataclasses import dataclass
from pathlib import Path

from src.errors import ArtifactError

FRAME_MS = 30.0
ENERGY_FLOOR = 80.0
PEAK_FRACTION = 0.08
NOISE_MULTIPLIER = 3.0
MIN_SPEECH_S = 0.18
MERGE_GAP_S = 0.35


@dataclass(frozen=True)
class SpeechActivity:
    """Detected speech activity span with master-relative times."""

    start_s: float
    end_s: float


def detect_voice_activity(
    wav_path: Path | str,
    *,
    start_s: float = 0.0,
    end_s: float | None = None,
    frame_ms: float = FRAME_MS,
    min_speech_s: float = MIN_SPEECH_S,
    merge_gap_s: float = MERGE_GAP_S,
) -> list[SpeechActivity]:
    """Detect speech-like audio regions in `analysis.wav` using frame RMS energy."""

    path = Path(wav_path)
    if not path.exists():
        raise ArtifactError(f"Analysis WAV is missing: {path}")
    if start_s < 0.0:
        raise ValueError("start_s must be non-negative")
    if end_s is not None and end_s <= start_s:
        raise ValueError("end_s must be greater than start_s")

    with wave.open(str(path), "rb") as wav:
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        channels = wav.getnchannels()
        total_frames = wav.getnframes()
        if sample_width <= 0 or sample_rate <= 0 or channels <= 0:
            raise ArtifactError(f"Invalid WAV metadata: {path}")

        start_frame = min(total_frames, int(start_s * sample_rate))
        end_frame = total_frames if end_s is None else min(total_frames, int(end_s * sample_rate))
        frame_samples = max(1, int(sample_rate * frame_ms / 1000.0))
        wav.setpos(start_frame)

        rms_values: list[tuple[float, float, float]] = []
        current_frame = start_frame
        while current_frame < end_frame:
            frames_to_read = min(frame_samples, end_frame - current_frame)
            fragment = wav.readframes(frames_to_read)
            if not fragment:
                break
            mono_fragment = (
                audioop.tomono(fragment, sample_width, 0.5, 0.5) if channels > 1 else fragment
            )
            rms = float(audioop.rms(mono_fragment, sample_width))
            frame_start_s = current_frame / sample_rate
            frame_end_s = (current_frame + frames_to_read) / sample_rate
            rms_values.append((frame_start_s, frame_end_s, rms))
            current_frame += frames_to_read

    if not rms_values:
        return []
    threshold = _adaptive_threshold([rms for _, _, rms in rms_values])
    raw_segments = _voiced_segments(rms_values, threshold)
    merged = _merge_segments(raw_segments, merge_gap_s=merge_gap_s)
    return [segment for segment in merged if segment.end_s - segment.start_s >= min_speech_s]


def _adaptive_threshold(rms_values: list[float]) -> float:
    peak = max(rms_values)
    floor_index = min(len(rms_values) - 1, max(0, int(len(rms_values) * 0.20)))
    noise_floor = sorted(rms_values)[floor_index]
    return max(ENERGY_FLOOR, noise_floor * NOISE_MULTIPLIER, peak * PEAK_FRACTION)


def _voiced_segments(
    rms_values: list[tuple[float, float, float]],
    threshold: float,
) -> list[SpeechActivity]:
    segments: list[SpeechActivity] = []
    active_start: float | None = None
    active_end = 0.0
    for frame_start_s, frame_end_s, rms in rms_values:
        if rms >= threshold:
            if active_start is None:
                active_start = frame_start_s
            active_end = frame_end_s
        elif active_start is not None:
            segments.append(SpeechActivity(active_start, active_end))
            active_start = None
    if active_start is not None:
        segments.append(SpeechActivity(active_start, active_end))
    return segments


def _merge_segments(
    segments: list[SpeechActivity],
    *,
    merge_gap_s: float,
) -> list[SpeechActivity]:
    if not segments:
        return []
    merged = [segments[0]]
    for segment in segments[1:]:
        previous = merged[-1]
        if segment.start_s - previous.end_s <= merge_gap_s:
            merged[-1] = SpeechActivity(previous.start_s, segment.end_s)
        else:
            merged.append(segment)
    return merged
