"""C10 rendition orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from src.contracts import CameraPlan, MediaInfo, SelectedClip
from src.render.ffmpeg import render_primary_clip
from src.render.thumbnail import write_thumbnail


@dataclass(frozen=True)
class RenderOutputs:
    """Filesystem outputs produced for one selected clip."""

    mp4_540x960: Path
    thumb: Path


def render_clip_outputs(
    *,
    master: Path,
    output_mp4: Path,
    output_thumb: Path,
    sendcmd: Path,
    clip: SelectedClip,
    camera_plan: CameraPlan,
    media_info: MediaInfo,
    output_width: int,
    output_height: int,
    crf: int,
    preset: str,
    thumbnail_offset_s: float,
) -> RenderOutputs:
    """Render the primary no-caption MP4 and vertical thumbnail for one clip."""

    render_primary_clip(
        master=master,
        output=output_mp4,
        sendcmd=sendcmd,
        clip=clip,
        camera_plan=camera_plan,
        media_info=media_info,
        output_width=output_width,
        output_height=output_height,
        crf=crf,
        preset=preset,
    )
    write_thumbnail(
        master=master,
        output=output_thumb,
        clip=clip,
        camera_plan=camera_plan,
        media_info=media_info,
        output_width=output_width,
        output_height=output_height,
        offset_s=thumbnail_offset_s,
    )
    return RenderOutputs(mp4_540x960=output_mp4, thumb=output_thumb)
