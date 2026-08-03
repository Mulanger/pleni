"""Integration tests for C8, C9, and C10 stages."""

from __future__ import annotations

import json
import shutil
from importlib import import_module
from pathlib import Path
from typing import Any, cast

import pytest

from src.camera.plan import crop_size_for_media
from src.contracts import (
    CameraKeyframe,
    CameraMode,
    CameraPlan,
    MediaInfo,
    Scene,
    SelectedClip,
    Speech,
)
from src.media.extract import extract_analysis_assets
from src.media.ffprobe import probe_media
from src.paths import work_paths
from src.stages.camera import plan_camera_dokid
from src.stages.render import render_clip, render_dokid
from src.stages.track import track_dokid


def test_featureless_frames_yield_no_face_and_no_camera_plan(tmp_path: Path) -> None:
    """The analysis frames here are flat grey with two rectangles on them.

    Haar has never detected a face in this fixture. Until ADR 010 the test
    asserted `len(samples) >= 18` and `all(is_speaking)` and passed anyway,
    because `estimate_speaker_proxy()` fabricated one box per frame — so the
    assertion was checking that the placeholder was working, and the C8/C9
    integration path had no genuine coverage at all. It now asserts what these
    frames actually support: nothing.

    The positive path is covered by
    `test_real_debate_footage_tracks_a_detected_face`, which uses committed
    footage of an actual debate.
    """

    dokid = "phase4fixture"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    media = MediaInfo(
        width=854, height=480, fps=25.0, duration_s=8.0, has_audio=True, video_codec="h264"
    )
    clip = _clip(start_s=1.0, end_s=5.0)
    _write_common_selected_inputs(paths, media, clip)
    _write_analysis_frames(paths.frames_dir, count=30)
    paths.scenes_json.write_text(
        json.dumps(
            [
                Scene(index=0, start_s=0.0, end_s=3.0).model_dump(mode="json"),
                Scene(index=1, start_s=3.0, end_s=8.0).model_dump(mode="json"),
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    track_paths = track_dokid(dokid, work_dir=tmp_path)
    camera_paths = plan_camera_dokid(dokid, work_dir=tmp_path)

    assert track_paths == [paths.track_json(clip.clip_id)]
    track_payload = json.loads(track_paths[0].read_text(encoding="utf-8"))
    assert track_payload["track_id"] == "no-face"
    assert track_payload["samples"] == []

    assert camera_paths == [paths.camera_json(clip.clip_id)]
    camera_plan = CameraPlan.model_validate_json(camera_paths[0].read_text(encoding="utf-8"))
    assert camera_plan.keyframes == (), "an unsupported clip gets no plan, not a centre crop"


def test_real_debate_footage_tracks_a_detected_face(tmp_path: Path) -> None:
    """Positive path, on committed footage of a real debate.

    Haar finds a face in roughly 77% of sampled frames here, so this exercises
    detection, tracking and camera planning on genuine evidence rather than on a
    synthesised box.
    """

    dokid = "realfixture"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    master = Path("tests/fixtures/debates/betankande/master.mp4")
    media = probe_media(master)
    clip = _clip(start_s=1.0, end_s=9.0)
    _write_common_selected_inputs(paths, media, clip)
    extract_analysis_assets(
        master,
        paths.analysis_wav,
        paths.frames_dir / "%06d.jpg",
    )
    paths.scenes_json.write_text(
        json.dumps(
            [Scene(index=0, start_s=0.0, end_s=12.0).model_dump(mode="json")],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    track_dokid(dokid, work_dir=tmp_path)
    plan_camera_dokid(dokid, work_dir=tmp_path)

    track_payload = json.loads(paths.track_json(clip.clip_id).read_text(encoding="utf-8"))
    assert track_payload["track_id"] != "no-face"
    assert len(track_payload["samples"]) >= 10

    camera_plan = CameraPlan.model_validate_json(
        paths.camera_json(clip.clip_id).read_text(encoding="utf-8")
    )
    assert camera_plan.keyframes
    crop_width, _crop_height = crop_size_for_media(media)
    assert all(
        0.0 <= keyframe.crop_x <= media.width - crop_width for keyframe in camera_plan.keyframes
    )


def test_render_refuses_an_unsupported_clip(tmp_path: Path) -> None:
    """An empty camera plan means C8 found no speaker. Rendering it anyway would
    emit a centre crop of the chamber under a named politician's byline, so C10
    declines and returns None (ADR 010)."""

    dokid = "unsupportedfixture"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    shutil.copyfile(Path("tests/fixtures/synthetic/hard_cut_20s.mp4"), paths.master)
    media = probe_media(paths.master)
    clip = _clip(start_s=1.0, end_s=3.0)
    _write_common_selected_inputs(paths, media, clip)
    paths.camera_json(clip.clip_id).write_text(
        CameraPlan(clip_id=clip.clip_id, keyframes=(), mode=CameraMode.STATIC).model_dump_json(),
        encoding="utf-8",
    )

    assert render_clip(dokid, clip.clip_id, work_dir=tmp_path) is None
    assert not paths.render_primary_mp4(clip.clip_id).exists()
    assert render_dokid(dokid, work_dir=tmp_path) == []


def test_render_stage_outputs_no_caption_vertical_assets(tmp_path: Path) -> None:
    dokid = "renderfixture"
    paths = work_paths(dokid, root=tmp_path)
    paths.ensure_directories()
    shutil.copyfile(Path("tests/fixtures/synthetic/hard_cut_20s.mp4"), paths.master)
    media = probe_media(paths.master)
    clip = _clip(start_s=1.0, end_s=3.0)
    _write_common_selected_inputs(paths, media, clip)
    crop_width, _crop_height = crop_size_for_media(media)
    paths.camera_json(clip.clip_id).write_text(
        CameraPlan(
            clip_id=clip.clip_id,
            keyframes=(CameraKeyframe(t=clip.start_s, crop_x=(media.width - crop_width) / 2.0),),
            mode=CameraMode.STATIC,
        ).model_dump_json(),
        encoding="utf-8",
    )

    rendered = render_dokid(dokid, work_dir=tmp_path)

    assert rendered == [paths.render_primary_mp4(clip.clip_id)]
    output_info = probe_media(rendered[0])
    assert output_info.width == 540
    assert output_info.height == 960
    assert output_info.duration_s == pytest.approx(2.0, abs=0.2)
    assert paths.render_thumb(clip.clip_id).exists()
    assert not paths.render_vtt(clip.clip_id).exists()
    assert not any(paths.render_dir.glob("*.ass"))


def _write_common_selected_inputs(paths: Any, media: MediaInfo, clip: SelectedClip) -> None:
    speech = Speech(
        speech_id=clip.speech_id,
        dokid=paths.dokid,
        speaker_name="Test Talare",
        party="S",
        anforandetyp="Anförande",
        start_s=0.0,
        end_s=max(clip.end_s + 1.0, 6.0),
        official_text="Detta är ett test.",
        alignment_confidence=1.0,
        needs_review=False,
    )
    paths.media_json.write_text(media.model_dump_json(), encoding="utf-8")
    paths.speeches_json.write_text(
        json.dumps([speech.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    paths.selected_json(clip.speech_id).write_text(
        json.dumps([clip.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )


def _write_analysis_frames(frames_dir: Path, *, count: int) -> None:
    cv2 = cast(Any, import_module("cv2"))
    frames_dir.mkdir(parents=True, exist_ok=True)
    for index in range(1, count + 1):
        image = _blank_image(cv2)
        cv2.imwrite(str(frames_dir / f"{index:06d}.jpg"), image)


def _blank_image(cv2: Any) -> Any:
    numpy = cast(Any, import_module("numpy"))
    image = numpy.full((270, 480, 3), 180, dtype=numpy.uint8)
    cv2.rectangle(image, (215, 55), (265, 105), (90, 80, 70), thickness=-1)
    cv2.rectangle(image, (190, 105), (290, 245), (70, 70, 90), thickness=-1)
    return image


def _clip(*, start_s: float, end_s: float) -> SelectedClip:
    return SelectedClip(
        clip_id="phase4_anf1_c01",
        speech_id="phase4_anf1",
        rank=1,
        start_s=start_s,
        end_s=end_s,
        archetype="EXPLAIN",
        title="Testtitel",
        transcript="Detta är ett test.",
        topic=None,
    )
