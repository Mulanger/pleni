"""Speaker-selection backend seam for C8.

The default backend answers "which of these tracked faces is the politician the
byline names?" from identity evidence. It used to answer a different question —
"which face is largest and most central?" — which is a statement about framing,
and on a debate two-shot where both people are tracked in ~100% of frames it has
no information at all. See ADR 012.

A future TalkNet backend can implement the same protocol to add *is this person
currently speaking* on top; identity remains a mandatory gate regardless.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Protocol

from src.contracts import FaceTrack
from src.vision.identity import IdentityThresholds
from src.vision.track import TrackCandidate, select_verified_track, verified_face_track


class SpeakerSelectionBackend(Protocol):
    """Select the expected speaker's timeline from tracked face candidates."""

    def select(
        self,
        clip_id: str,
        tracks: Sequence[TrackCandidate],
        *,
        shot_bounds: Mapping[int, tuple[float, float]],
        shot_frame_counts: Mapping[int, int],
        intressent_id: str | None,
        portrait_sha256: str | None,
        expected_times: Sequence[float],
        max_gap_s: float,
    ) -> FaceTrack:
        """Return the verified speaker track for one clip."""


class IdentityVerifiedBackend:
    """Default C8 backend: per-shot identity verification against the portrait."""

    def __init__(
        self,
        *,
        thresholds: IdentityThresholds,
        min_verified_frac: float,
        max_unsupported_gap_s: float,
    ) -> None:
        self._thresholds = thresholds
        self._min_verified_frac = min_verified_frac
        self._max_unsupported_gap_s = max_unsupported_gap_s

    def select(
        self,
        clip_id: str,
        tracks: Sequence[TrackCandidate],
        *,
        shot_bounds: Mapping[int, tuple[float, float]],
        shot_frame_counts: Mapping[int, int],
        intressent_id: str | None,
        portrait_sha256: str | None,
        expected_times: Sequence[float],
        max_gap_s: float,
    ) -> FaceTrack:
        """Verify identity per shot, then serialize the accepted timeline."""

        selection = select_verified_track(
            tracks,
            shot_bounds=shot_bounds,
            shot_frame_counts=shot_frame_counts,
            intressent_id=intressent_id,
            portrait_sha256=portrait_sha256,
            thresholds=self._thresholds,
            min_verified_frac=self._min_verified_frac,
            max_unsupported_gap_s=self._max_unsupported_gap_s,
        )
        return verified_face_track(
            clip_id,
            selection,
            expected_times=expected_times,
            max_gap_s=max_gap_s,
        )
