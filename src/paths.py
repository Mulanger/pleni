"""Single source of truth for the `work/<dokid>/` artifact layout."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WorkPaths:
    """Path helper for one debate workspace."""

    root: Path
    dokid: str

    @property
    def debate_dir(self) -> Path:
        return self.root / self.dokid

    @property
    def master(self) -> Path:
        return self.debate_dir / "master.mp4"

    @property
    def analysis_wav(self) -> Path:
        return self.debate_dir / "analysis.wav"

    @property
    def frames_dir(self) -> Path:
        return self.debate_dir / "frames"

    @property
    def frame_pattern(self) -> Path:
        return self.frames_dir / "%06d.jpg"

    @property
    def source_json(self) -> Path:
        return self.debate_dir / "00_source.json"

    @property
    def media_json(self) -> Path:
        return self.debate_dir / "01_media.json"

    @property
    def scenes_json(self) -> Path:
        return self.debate_dir / "02_scenes.json"

    @property
    def speeches_json(self) -> Path:
        return self.debate_dir / "03_speeches.json"

    @property
    def transcript_dir(self) -> Path:
        return self.debate_dir / "04_transcript"

    def transcript_json(self, speech_id: str) -> Path:
        return self.transcript_dir / f"{speech_id}.json"

    @property
    def audio_features_dir(self) -> Path:
        return self.debate_dir / "05_audio_features"

    def audio_features_json(self, speech_id: str) -> Path:
        return self.audio_features_dir / f"{speech_id}.json"

    @property
    def candidates_dir(self) -> Path:
        return self.debate_dir / "06_candidates"

    def candidates_json(self, speech_id: str) -> Path:
        return self.candidates_dir / f"{speech_id}.json"

    @property
    def selected_dir(self) -> Path:
        return self.debate_dir / "07_selected"

    def selected_json(self, speech_id: str) -> Path:
        return self.selected_dir / f"{speech_id}.json"

    @property
    def track_dir(self) -> Path:
        return self.debate_dir / "08_track"

    def track_json(self, clip_id: str) -> Path:
        return self.track_dir / f"{clip_id}.json"

    @property
    def camera_dir(self) -> Path:
        return self.debate_dir / "09_camera"

    def camera_json(self, clip_id: str) -> Path:
        return self.camera_dir / f"{clip_id}.json"

    @property
    def render_dir(self) -> Path:
        return self.debate_dir / "10_render"

    def render_mp4(self, clip_id: str, rendition: str) -> Path:
        return self.render_dir / f"{clip_id}_{rendition}.mp4"

    def render_primary_mp4(self, clip_id: str) -> Path:
        return self.render_mp4(clip_id, "540x960")

    def render_low_mp4(self, clip_id: str) -> Path:
        return self.render_mp4(clip_id, "360x640")

    def render_thumb(self, clip_id: str) -> Path:
        return self.render_dir / f"{clip_id}.webp"

    def render_vtt(self, clip_id: str) -> Path:
        return self.render_dir / f"{clip_id}.vtt"

    @property
    def publish_dir(self) -> Path:
        return self.debate_dir / "11_publish"

    def publish_json(self, clip_id: str) -> Path:
        return self.publish_dir / f"{clip_id}.json"

    def ensure_directories(self) -> None:
        """Create all fixed directories for this debate workspace."""

        for directory in (
            self.debate_dir,
            self.frames_dir,
            self.transcript_dir,
            self.audio_features_dir,
            self.candidates_dir,
            self.selected_dir,
            self.track_dir,
            self.camera_dir,
            self.render_dir,
            self.publish_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)


def work_paths(dokid: str, root: Path | str = "work") -> WorkPaths:
    """Build path helpers for a Riksdagen document id."""

    return WorkPaths(root=Path(root), dokid=dokid)
