"""C9 stage: plan source-frame crop keyframes from active face tracks."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from src.camera.plan import plan_camera_for_clip
from src.config import get_settings
from src.contracts import CameraPlan, FaceTrack, MediaInfo, Scene, SelectedClip, Speech
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.stages._io import read_model, read_model_list, write_json


def plan_camera_dokid(dokid: str, *, work_dir: Path | str) -> list[Path]:
    """Write one `09_camera/<clip_id>.json` artifact per selected clip."""

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    media_info = read_model(paths.media_json, MediaInfo, "C2 media artifact")
    scenes = read_model_list(paths.scenes_json, Scene, "C2 scenes artifact")
    selected = _read_selected_clips(dokid, Path(work_dir))
    written: list[Path] = []
    for clip in selected:
        face_track = read_model(paths.track_json(clip.clip_id), FaceTrack, "C8 track artifact")
        plan = plan_camera_for_clip(
            clip,
            face_track,
            scenes,
            media_info,
            dead_zone_frac=settings.camera_dead_zone_frac,
            max_pan_px_s_1080=settings.camera_max_pan_px_s_1080,
        )
        artifact = paths.camera_json(clip.clip_id)
        write_json(artifact, plan.model_dump(mode="json"))
        written.append(artifact)
    return written


def main() -> None:
    """Run the C9 camera planning stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C9_camera", dokid=args.dokid)
    artifacts = plan_camera_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


def read_camera_plans(dokid: str, work_dir: Path) -> list[CameraPlan]:
    """Read all C9 camera plan artifacts for a debate."""

    paths = work_paths(dokid, root=work_dir)
    selected = _read_selected_clips(dokid, work_dir)
    plans: list[CameraPlan] = []
    for clip in selected:
        artifact = paths.camera_json(clip.clip_id)
        if artifact.exists():
            plans.append(read_model(artifact, CameraPlan, "C9 camera artifact"))
    return plans


def _read_selected_clips(dokid: str, work_dir: Path) -> list[SelectedClip]:
    paths = work_paths(dokid, root=work_dir)
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    clips: list[SelectedClip] = []
    for speech in speeches:
        artifact = paths.selected_json(speech.speech_id)
        if artifact.exists():
            clips.extend(read_model_list(artifact, SelectedClip, "C7 selected artifact"))
    return clips


if __name__ == "__main__":
    main()
