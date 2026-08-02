"""C7 heuristic feature aggregation and archetype scoring."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

from src.contracts import AudioFeatures, Candidate, Speech, TimeSpan, Transcript
from src.scoring.gate import apply_publish_gate
from src.scoring.text_features import compute_text_features

ARCHETYPES = ("CONFRONT", "EXPLAIN", "QUOTABLE")


def score_candidates_for_speech(
    candidates: Sequence[Candidate],
    *,
    speech: Speech,
    transcript: Transcript,
    audio_features: AudioFeatures,
    all_speeches: Sequence[Speech],
    confront_weights: Mapping[str, float],
    explain_weights: Mapping[str, float],
    quotable_weights: Mapping[str, float],
) -> list[Candidate]:
    """Return candidates with full C7 features, sub-scores, gates, and archetype scores."""

    raw_feature_maps = [
        _merged_features(candidate, speech, transcript, audio_features, all_speeches)
        for candidate in candidates
    ]
    z_feature_maps = zscore_feature_maps(raw_feature_maps)
    scored: list[Candidate] = []
    for candidate, raw_features, z_features in zip(
        candidates, raw_feature_maps, z_feature_maps, strict=True
    ):
        archetype_scores = {
            "CONFRONT": weighted_score(z_features, confront_weights),
            "EXPLAIN": weighted_score(z_features, explain_weights),
            "QUOTABLE": weighted_score(z_features, quotable_weights),
        }
        c6_reject_reason = candidate.reject_reason
        gate_passed, c7_reject_reason = apply_publish_gate(candidate, raw_features)
        reject_reason = c6_reject_reason if c6_reject_reason is not None else c7_reject_reason
        final_score = max(archetype_scores.values()) if archetype_scores else 0.0
        winning_archetype = max(archetype_scores, key=lambda key: archetype_scores[key])
        sub_scores = dict(candidate.sub_scores)
        sub_scores.update({f"z.{key}": value for key, value in z_features.items()})
        sub_scores.update({f"raw.{key}": value for key, value in raw_features.items()})
        sub_scores.update({f"archetype.{key}": value for key, value in archetype_scores.items()})
        sub_scores["final_score"] = final_score
        sub_scores[f"winning_archetype.{winning_archetype}"] = 1.0
        sub_scores["gate.publish"] = 1.0 if gate_passed else 0.0
        scored.append(
            candidate.model_copy(
                update={
                    "features": raw_features,
                    "archetype_scores": archetype_scores,
                    "sub_scores": sub_scores,
                    "gate_passed": gate_passed,
                    "reject_reason": reject_reason,
                }
            )
        )
    return scored


def zscore_feature_maps(feature_maps: Sequence[Mapping[str, float]]) -> list[dict[str, float]]:
    """Z-score every feature across one speech's candidate set."""

    keys = sorted({key for feature_map in feature_maps for key in feature_map})
    means: dict[str, float] = {}
    stds: dict[str, float] = {}
    for key in keys:
        values = [feature_map.get(key, 0.0) for feature_map in feature_maps]
        mean = sum(values) / len(values) if values else 0.0
        variance = sum((value - mean) ** 2 for value in values) / len(values) if values else 0.0
        means[key] = mean
        stds[key] = math.sqrt(variance)

    z_maps: list[dict[str, float]] = []
    for feature_map in feature_maps:
        z_maps.append(
            {
                key: 0.0
                if stds[key] == 0.0
                else (feature_map.get(key, 0.0) - means[key]) / stds[key]
                for key in keys
            }
        )
    return z_maps


def weighted_score(features: Mapping[str, float], weights: Mapping[str, float]) -> float:
    """Return a weighted feature score."""

    return sum(features.get(feature_name, 0.0) * weight for feature_name, weight in weights.items())


def candidate_final_score(candidate: Candidate) -> float:
    """Return the selector score stored in C7 sub-scores."""

    return candidate.sub_scores.get("final_score", 0.0)


def winning_archetype(candidate: Candidate) -> str:
    """Return the highest-scoring archetype for a candidate."""

    if not candidate.archetype_scores:
        return "EXPLAIN"
    return max(candidate.archetype_scores, key=lambda key: candidate.archetype_scores[key])


def _merged_features(
    candidate: Candidate,
    speech: Speech,
    transcript: Transcript,
    audio_features: AudioFeatures,
    all_speeches: Sequence[Speech],
) -> dict[str, float]:
    features = dict(candidate.features)
    features.update(_delivery_features(candidate, speech, audio_features))
    features.update(compute_text_features(candidate, speech, transcript, all_speeches))
    return {key: _finite(value) for key, value in features.items()}


def _delivery_features(
    candidate: Candidate,
    speech: Speech,
    audio_features: AudioFeatures,
) -> dict[str, float]:
    start_index, end_index = _frame_slice(candidate, speech, audio_features)
    rms = list(audio_features.rms[start_index:end_index])
    f0 = [value for value in audio_features.f0[start_index:end_index] if value is not None]
    speech_rate = list(audio_features.speech_rate_wps[start_index:end_index])
    duration_s = float(candidate.end_s - candidate.start_s)
    return {
        "energy_p90": _percentile(rms, 0.90),
        "energy_var": _variance(rms),
        "pitch_range": max(f0) - min(f0) if f0 else 0.0,
        "rate_var": _variance(speech_rate),
        "emphasis_count": _event_rate(
            audio_features.emphasis_events,
            start_s=float(candidate.start_s),
            end_s=float(candidate.end_s),
        ),
        "pause_before_punchline": _pause_before_punchline(
            audio_features.pauses,
            start_s=float(candidate.start_s),
            end_s=float(candidate.end_s),
        ),
        "end_intensity_slope": _end_intensity_slope(rms),
        "dead_air_frac": _pause_fraction(
            audio_features.pauses,
            start_s=float(candidate.start_s),
            end_s=float(candidate.end_s),
            duration_s=duration_s,
        ),
    }


def _frame_slice(
    candidate: Candidate,
    speech: Speech,
    audio_features: AudioFeatures,
) -> tuple[int, int]:
    start_index = max(
        0, math.floor((float(candidate.start_s) - float(speech.start_s)) * audio_features.frame_hz)
    )
    end_index = min(
        len(audio_features.rms),
        max(
            start_index + 1,
            math.ceil((float(candidate.end_s) - float(speech.start_s)) * audio_features.frame_hz),
        ),
    )
    return start_index, end_index


def _percentile(values: Sequence[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * quantile)))
    return ordered[index]


def _variance(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return sum((value - mean) ** 2 for value in values) / len(values)


def _event_rate(events: Sequence[TimeSpan], *, start_s: float, end_s: float) -> float:
    duration_s = end_s - start_s
    if duration_s <= 0.0:
        return 0.0
    count = sum(1 for event in events if _overlap_s(event, start_s=start_s, end_s=end_s) > 0.0)
    return count / duration_s


def _pause_before_punchline(events: Sequence[TimeSpan], *, start_s: float, end_s: float) -> float:
    duration_s = end_s - start_s
    if duration_s <= 0.0:
        return 0.0
    best = 0.0
    for event in events:
        overlap_s = _overlap_s(event, start_s=start_s, end_s=end_s)
        if overlap_s <= 0.0:
            continue
        center_s = (max(float(event.start_s), start_s) + min(float(event.end_s), end_s)) / 2.0
        position_weight = (center_s - start_s) / duration_s
        best = max(best, overlap_s * position_weight)
    return best


def _end_intensity_slope(rms: Sequence[float]) -> float:
    if len(rms) < 2:
        return 0.0
    segment_len = max(1, len(rms) // 5)
    start_mean = sum(rms[:segment_len]) / segment_len
    end_mean = sum(rms[-segment_len:]) / segment_len
    denominator = max(max(rms), 1e-9)
    return (end_mean - start_mean) / denominator


def _pause_fraction(
    pauses: Sequence[TimeSpan],
    *,
    start_s: float,
    end_s: float,
    duration_s: float,
) -> float:
    if duration_s <= 0.0:
        return 1.0
    pause_s = sum(_overlap_s(pause, start_s=start_s, end_s=end_s) for pause in pauses)
    return min(1.0, max(0.0, pause_s / duration_s))


def _overlap_s(span: TimeSpan, *, start_s: float, end_s: float) -> float:
    return max(0.0, min(float(span.end_s), end_s) - max(float(span.start_s), start_s))


def _finite(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return float(value)
