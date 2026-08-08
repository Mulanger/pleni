"""Per-speech speaker-visibility timeline, computed once and consumed by C7.

The pipeline used to decide *what* to clip from text and audio alone, then find
out from C8 whether the picture supported it. There were only two outcomes for a
bad picture: publish it mis-framed, or lose the clip. Measured over 319 clips,
the second one costs 50.5% of them — and it is avoidable, because a six-minute
speech contains hundreds of admissible windows and only some of them straddle a
cutaway.

This module answers, for a whole speech at once, "where is the expected speaker
actually on screen?" so C7 can choose a window that is both well spoken and well
shot. The vision pass is per speech rather than per candidate, so asking the
question for 300 candidate windows costs the same as asking it for one.

C8 still re-verifies the chosen window independently and remains the authority on
what may be published. This only stops C7 proposing windows that were never going
to survive.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise

from src.vision.identity import IdentityThresholds, build_evidence
from src.vision.track import TrackCandidate, _long_enough_to_be_a_speaker


@dataclass(frozen=True)
class ShotVisibility:
    """Whether the expected speaker was verified in one shot of a speech."""

    shot_index: int
    start_s: float
    end_s: float
    verified: bool
    reason: str | None
    median_similarity: float
    #: Median face width as a fraction of frame width across the verified track.
    #: This is the real value for `face_height_frac`, which C7's publish gate has
    #: carried as a hardcoded `1.0` since it shipped.
    face_width_frac: float

    @property
    def duration_s(self) -> float:
        return max(0.0, self.end_s - self.start_s)


@dataclass(frozen=True)
class SpeechVisibility:
    """Verified-visibility timeline for one speech."""

    speech_id: str
    shots: tuple[ShotVisibility, ...]

    def verified_fraction(self, start_s: float, end_s: float) -> float:
        """Share of a window's duration where the speaker is verified on screen."""

        duration = end_s - start_s
        if duration <= 0.0:
            return 0.0
        verified = sum(
            _overlap(shot.start_s, shot.end_s, start_s, end_s)
            for shot in self.shots
            if shot.verified
        )
        return min(1.0, max(0.0, verified / duration))

    def longest_unverified_gap_s(self, start_s: float, end_s: float) -> float:
        """Longest continuous stretch inside a window with no verified speaker.

        A window's total unverified time can look acceptable while hiding one
        long absence, which is the shape C8 rejects. Selection has to see the
        same thing C8 will.
        """

        longest = 0.0
        run = 0.0
        for shot in sorted(self.shots, key=lambda item: item.start_s):
            overlap = _overlap(shot.start_s, shot.end_s, start_s, end_s)
            if overlap <= 0.0:
                continue
            if shot.verified:
                run = 0.0
            else:
                run += overlap
                longest = max(longest, run)
        return longest

    def median_face_width_frac(self, start_s: float, end_s: float) -> float:
        """Apparent speaker size across a window, 0.0 when never verified."""

        values = [
            shot.face_width_frac
            for shot in self.shots
            if shot.verified and _overlap(shot.start_s, shot.end_s, start_s, end_s) > 0.0
        ]
        if not values:
            return 0.0
        ordered = sorted(values)
        return ordered[len(ordered) // 2]


def build_speech_visibility(
    speech_id: str,
    tracks: Sequence[TrackCandidate],
    *,
    shot_bounds: dict[int, tuple[float, float]],
    shot_frame_counts: dict[int, int],
    frame_width: float,
    thresholds: IdentityThresholds,
    has_portrait: bool,
) -> SpeechVisibility:
    """Reduce per-shot tracks and identity scores to a visibility timeline.

    Deliberately the *same* per-shot rule C8 applies, so the two stages cannot
    drift into disagreeing about which windows are usable.
    """

    shots: list[ShotVisibility] = []
    for shot_index in sorted(shot_bounds):
        start_s, end_s = shot_bounds[shot_index]
        if not has_portrait:
            shots.append(
                _unverified(shot_index, start_s, end_s, "no_official_portrait")
            )
            continue
        in_shot = [track for track in tracks if track.shot_index == shot_index]
        eligible = _long_enough_to_be_a_speaker(
            in_shot, total_frames=shot_frame_counts.get(shot_index)
        )
        scored = [
            (track, [float(value) for value in track.similarities])
            for track in eligible
            if track.similarities
        ]
        if not scored:
            shots.append(
                _unverified(shot_index, start_s, end_s, "no_quality_embeddings")
            )
            continue
        ranked = sorted(scored, key=lambda item: _median(item[1]), reverse=True)
        winner, winner_similarities = ranked[0]
        competitor = _median(ranked[1][1]) if len(ranked) > 1 else 0.0
        evidence = build_evidence(
            winner_similarities,
            intressent_id=None,
            portrait_sha256=None,
            competitor_median=competitor,
        )
        reason = thresholds.evaluate(evidence, has_competitor=len(ranked) > 1)
        if reason is not None:
            shots.append(_unverified(shot_index, start_s, end_s, reason))
            continue
        widths = sorted(float(sample.w) for sample in winner.samples)
        shots.append(
            ShotVisibility(
                shot_index=shot_index,
                start_s=start_s,
                end_s=end_s,
                verified=True,
                reason=None,
                median_similarity=evidence.median_similarity,
                face_width_frac=(
                    widths[len(widths) // 2] / frame_width if widths and frame_width else 0.0
                ),
            )
        )
    return SpeechVisibility(speech_id=speech_id, shots=tuple(shots))


def visibility_from_payload(payload: dict[str, object]) -> SpeechVisibility:
    """Rebuild a timeline from its `06_vision` artifact."""

    raw_shots = payload.get("shots")
    shots: list[ShotVisibility] = []
    if isinstance(raw_shots, list):
        for raw in raw_shots:
            if not isinstance(raw, dict):
                continue
            shots.append(
                ShotVisibility(
                    shot_index=int(raw.get("shot_index", 0)),
                    start_s=float(raw.get("start_s", 0.0)),
                    end_s=float(raw.get("end_s", 0.0)),
                    verified=bool(raw.get("verified", False)),
                    reason=raw.get("reason") if isinstance(raw.get("reason"), str) else None,
                    median_similarity=float(raw.get("median_similarity", 0.0)),
                    face_width_frac=float(raw.get("face_width_frac", 0.0)),
                )
            )
    return SpeechVisibility(speech_id=str(payload.get("speech_id", "")), shots=tuple(shots))


def visibility_payload(visibility: SpeechVisibility) -> dict[str, object]:
    """Serialize a timeline for `06_vision/<speech_id>.json`."""

    return {
        "speech_id": visibility.speech_id,
        "shots": [
            {
                "shot_index": shot.shot_index,
                "start_s": round(shot.start_s, 3),
                "end_s": round(shot.end_s, 3),
                "verified": shot.verified,
                "reason": shot.reason,
                "median_similarity": round(shot.median_similarity, 4),
                "face_width_frac": round(shot.face_width_frac, 4),
            }
            for shot in visibility.shots
        ],
    }


def shot_bounds_for_span(start_s: float, end_s: float, cuts: Sequence[float]) -> dict[
    int, tuple[float, float]
]:
    """Shot windows inside a span, split at each scene cut."""

    edges = [start_s, *sorted(float(cut) for cut in cuts if start_s < cut < end_s), end_s]
    return {
        index: (lo, hi)
        for index, (lo, hi) in enumerate(pairwise(edges))
        if hi > lo
    }


def shot_index_for(t: float, cuts: Sequence[float]) -> int:
    """Which shot a master-relative timestamp falls in."""

    return bisect_right(sorted(float(cut) for cut in cuts), float(t))


def _unverified(
    shot_index: int, start_s: float, end_s: float, reason: str
) -> ShotVisibility:
    return ShotVisibility(
        shot_index=shot_index,
        start_s=start_s,
        end_s=end_s,
        verified=False,
        reason=reason,
        median_similarity=0.0,
        face_width_frac=0.0,
    )


def _median(values: Sequence[float]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[len(ordered) // 2]


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))
