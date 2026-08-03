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


def selected_clip_ids(dokid: str, work_dir: Path | str) -> list[str]:
    """Clip IDs C7 selected for this debate, in order.

    The orchestrator fans out over exactly this list (C12b), so it lives here
    rather than being re-derived from artifact paths by something that does not
    own the C7 contract.
    """

    return [clip.clip_id for clip in _read_selected_clips(dokid, Path(work_dir))]


def render_clip(
    dokid: str, clip_id: str, *, work_dir: Path | str, force: bool = False
) -> Path | None:
    """Render one clip. The unit the orchestrator parallelises over (C12b).

    Returns `None` when the clip is unsupported — C9 produced no keyframes
    because C8 found no face it would call the speaker. That is a normal
    outcome, not a failure: rendering it anyway would emit a centre crop of the
    chamber and present it as a clip of a named politician. See ADR 010.

    Skips an encode whose output already exists unless `force`. That makes a
    retry cheap: before this, a crash at clip 399 of 400 re-encoded all 400,
    and three failed attempts could burn twelve hours of CPU producing nothing.
    """

    settings = get_settings()
    root = Path(work_dir)
    paths = work_paths(dokid, root=root)
    output = paths.render_primary_mp4(clip_id)
    thumb = paths.render_thumb(clip_id)

    if not force and output.exists() and thumb.exists() and output.stat().st_size > 0:
        return output

    if not paths.master.exists():
        raise ArtifactError(f"C2 master media is missing: {paths.master}")
    media_info = read_model(paths.media_json, MediaInfo, "C2 media artifact")

    clip = next((c for c in _read_selected_clips(dokid, root) if c.clip_id == clip_id), None)
    if clip is None:
        raise ArtifactError(f"C7 did not select clip {clip_id} for {dokid}")

    camera_plan = read_model(paths.camera_json(clip_id), CameraPlan, "C9 camera artifact")
    if not camera_plan.keyframes:
        stage_logger("C10_render", dokid=dokid).info(
            "clip_unsupported_not_rendered",
            clip_id=clip_id,
            reason="no_verified_speaker_evidence",
        )
        return None

    render_clip_outputs(
        master=paths.master,
        output_mp4=output,
        output_thumb=thumb,
        sendcmd=paths.render_dir / f"{clip_id}.sendcmd",
        clip=clip,
        camera_plan=camera_plan,
        media_info=media_info,
        output_width=settings.output_width,
        output_height=settings.output_height,
        crf=settings.render_crf,
        preset=settings.render_preset,
        thumbnail_offset_s=settings.thumbnail_offset_s,
    )
    return output


def render_dokid(dokid: str, *, work_dir: Path | str) -> list[Path]:
    """Render every selected clip to `10_render/<clip_id>_540x960.mp4`.

    Retained for `run-fixture` and for running a debate on one machine without
    the orchestrator. Under C12 the queue fans out over `render_clip` instead,
    so these 400 encodes run in parallel rather than in this loop.
    """

    root = Path(work_dir)
    rendered = (
        render_clip(dokid, clip_id, work_dir=root) for clip_id in selected_clip_ids(dokid, root)
    )
    return [output for output in rendered if output is not None]


def main() -> None:
    """Run the C10 render stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    parser.add_argument(
        "--clip-id",
        default=None,
        help="Render one clip instead of all of them. The orchestrator's unit of work.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-encode even when the output already exists.",
    )
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C10_render", dokid=args.dokid)
    if args.clip_id:
        one = render_clip(args.dokid, args.clip_id, work_dir=work_dir, force=args.force)
        artifacts = [one] if one is not None else []
    else:
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
