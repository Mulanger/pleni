"""C10 stage: render no-caption 540x960 clips from camera plans."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from src.config import get_settings
from src.contracts import CameraPlan, MediaInfo, SelectedClip, Speech
from src.errors import ArtifactError
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.render.renditions import render_clip_outputs
from src.stages._io import read_model, read_model_list

PRIMARY_RENDITION_LABEL = "540x960"


def render_dokid(dokid: str, *, work_dir: Path | str) -> list[Path]:
    """Render selected clips to `10_render/<clip_id>_540x960.mp4`."""

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    if not paths.master.exists():
        raise ArtifactError(f"C2 master media is missing: {paths.master}")
    media_info = read_model(paths.media_json, MediaInfo, "C2 media artifact")
    selected = _read_selected_clips(dokid, Path(work_dir))
    rendered: list[Path] = []
    for clip in selected:
        camera_plan = read_model(paths.camera_json(clip.clip_id), CameraPlan, "C9 camera artifact")
        output = paths.render_primary_mp4(clip.clip_id)
        render_clip_outputs(
            master=paths.master,
            output_mp4=output,
            output_thumb=paths.render_thumb(clip.clip_id),
            sendcmd=paths.render_dir / f"{clip.clip_id}.sendcmd",
            clip=clip,
            camera_plan=camera_plan,
            media_info=media_info,
            output_width=settings.output_width,
            output_height=settings.output_height,
            crf=settings.render_crf,
            preset=settings.render_preset,
            thumbnail_offset_s=settings.thumbnail_offset_s,
        )
        rendered.append(output)
    return rendered


def main() -> None:
    """Run the C10 render stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C10_render", dokid=args.dokid)
    artifacts = render_dokid(args.dokid, work_dir=work_dir)
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


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
