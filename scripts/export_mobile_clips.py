"""Export rendered mobile clips into a review folder with joined speaker metadata."""

from __future__ import annotations

import argparse
import json
import shutil
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from src.contracts import MediaInfo, SelectedClip, Speech
from src.media.ffprobe import probe_media
from src.paths import work_paths
from src.render.ffmpeg import has_faststart_moov
from src.stages._io import read_model_list


@dataclass(frozen=True)
class ExportedClip:
    """One copied review clip and its manifest metadata."""

    manifest_entry: dict[str, object]
    mp4_path: Path


MediaProbe = Callable[[Path], MediaInfo]
FaststartProbe = Callable[[Path], bool]


def export_mobile_clips(
    dokid: str,
    *,
    work_dir: Path | str,
    output_dir: Path | str,
    probe: MediaProbe = probe_media,
    faststart_probe: FaststartProbe = has_faststart_moov,
) -> list[ExportedClip]:
    """Copy rendered clips and write a manifest that includes speaker metadata."""

    paths = work_paths(dokid, root=Path(work_dir))
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    _clear_files(destination)

    speeches = {
        speech.speech_id: speech
        for speech in read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    }
    clips = _read_selected_clips(dokid, Path(work_dir))

    exported: list[ExportedClip] = []
    manifest: list[dict[str, object]] = []
    for index, clip in enumerate(
        sorted(clips, key=lambda item: (item.start_s, item.rank)), start=1
    ):
        source_mp4 = paths.render_primary_mp4(clip.clip_id)
        if not source_mp4.exists():
            continue
        speech = speeches.get(clip.speech_id)
        mp4_name = _review_mp4_name(index, clip)
        thumb_name = _review_thumb_name(index, clip)
        copied_mp4 = destination / mp4_name
        copied_thumb = destination / thumb_name
        shutil.copy2(source_mp4, copied_mp4)
        source_thumb = paths.render_thumb(clip.clip_id)
        if source_thumb.exists():
            shutil.copy2(source_thumb, copied_thumb)
        media_info = probe(copied_mp4)
        entry = _manifest_entry(
            index=index,
            clip=clip,
            speech=speech,
            media_info=media_info,
            mp4_name=mp4_name,
            thumb_name=thumb_name if copied_thumb.exists() else None,
            faststart=faststart_probe(copied_mp4),
            bytes_size=copied_mp4.stat().st_size,
        )
        manifest.append(entry)
        exported.append(ExportedClip(manifest_entry=entry, mp4_path=copied_mp4))

    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (destination / "README.md").write_text(
        f"# {dokid} mobile clip test\n\n"
        f"Generated {len(manifest)} no-caption 540x960 mobile MP4 clips from local "
        "pipeline artifacts.\n"
        "The manifest joins selected clips back to speeches, so every row includes "
        "speaker metadata.\n",
        encoding="utf-8",
    )
    return exported


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint for local review exports."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=Path("work"), help="Pipeline work root")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Review output folder. Defaults to test_outputs/<dokid>_mobile_clips",
    )
    args = parser.parse_args(argv)
    output_dir = args.output_dir or Path("test_outputs") / f"{args.dokid}_mobile_clips"
    exported = export_mobile_clips(args.dokid, work_dir=args.work_dir, output_dir=output_dir)
    print(output_dir.resolve())
    print(f"clips {len(exported)}")
    return 0


def _read_selected_clips(dokid: str, work_dir: Path) -> list[SelectedClip]:
    paths = work_paths(dokid, root=work_dir)
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    clips: list[SelectedClip] = []
    for speech in speeches:
        artifact = paths.selected_json(speech.speech_id)
        if artifact.exists():
            clips.extend(read_model_list(artifact, SelectedClip, "C7 selected artifact"))
    return clips


def _manifest_entry(
    *,
    index: int,
    clip: SelectedClip,
    speech: Speech | None,
    media_info: MediaInfo,
    mp4_name: str,
    thumb_name: str | None,
    faststart: bool,
    bytes_size: int,
) -> dict[str, object]:
    return {
        "index": index,
        "clip_id": clip.clip_id,
        "speech_id": clip.speech_id,
        "speaker_name": speech.speaker_name if speech is not None else None,
        "party": speech.party if speech is not None else None,
        "anforandetyp": speech.anforandetyp if speech is not None else None,
        "archetype": clip.archetype,
        "title": clip.title,
        "start_s": round(float(clip.start_s), 3),
        "end_s": round(float(clip.end_s), 3),
        "duration_s": round(float(media_info.duration_s), 3),
        "width": media_info.width,
        "height": media_info.height,
        "has_audio": media_info.has_audio,
        "faststart": faststart,
        "bytes": bytes_size,
        "mp4": mp4_name,
        "thumbnail": thumb_name,
    }


def _review_mp4_name(index: int, clip: SelectedClip) -> str:
    return f"{index:02d}_{clip.archetype.casefold()}_{clip.clip_id}_540x960.mp4"


def _review_thumb_name(index: int, clip: SelectedClip) -> str:
    return f"{index:02d}_{clip.archetype.casefold()}_{clip.clip_id}.webp"


def _clear_files(directory: Path) -> None:
    for path in directory.iterdir():
        if path.is_file():
            path.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
