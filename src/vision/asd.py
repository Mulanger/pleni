"""Active-speaker backend seam for C8.

The default backend is deliberately heuristic: in Riksdagen's directed feed, the
largest centered face is usually the speaker. A future TalkNet backend can
implement the same protocol without changing C8 artifacts.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from src.contracts import FaceTrack
from src.vision.track import TrackCandidate, active_face_track


class ActiveSpeakerBackend(Protocol):
    """Select one active speaker track from tracked face candidates."""

    def select(
        self,
        clip_id: str,
        tracks: Sequence[TrackCandidate],
        *,
        frame_width: float,
        frame_height: float,
        expected_times: Sequence[float],
        max_gap_s: float,
    ) -> FaceTrack:
        """Return the active speaker track for one clip."""


class HeuristicActiveSpeakerBackend:
    """Default C8 active-speaker selector."""

    def select(
        self,
        clip_id: str,
        tracks: Sequence[TrackCandidate],
        *,
        frame_width: float,
        frame_height: float,
        expected_times: Sequence[float],
        max_gap_s: float,
    ) -> FaceTrack:
        """Select by persistence, size, and frame centrality."""

        return active_face_track(
            clip_id,
            tracks,
            frame_width=frame_width,
            frame_height=frame_height,
            expected_times=expected_times,
            max_gap_s=max_gap_s,
        )
