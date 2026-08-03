"""C11 stage: publish verified Bunny assets and Supabase metadata."""

from __future__ import annotations

import argparse
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from src.config import Settings, get_settings
from src.contracts import (
    CameraPlan,
    Candidate,
    PublishResult,
    SelectedClip,
    Source,
    Speech,
    Transcript,
)
from src.errors import ArtifactError, ConfigurationError, ContractValidationError
from src.logging import configure_logging, stage_logger
from src.paths import WorkPaths, work_paths
from src.publish.bunny import (
    BunnyAccountClient,
    BunnyStorageClient,
    BunnyUploadedObject,
)
from src.publish.migrations import (
    MIGRATIONS_DIR,
    apply_pending_migrations,
    discover_migrations,
)
from src.publish.supabase import (
    SupabaseManagementClient,
    SupabasePublishBatch,
    SupabasePublishClient,
    SupabaseRestClient,
)
from src.stages._io import read_json_object, read_model, read_model_list, write_json
from src.stages.render import PRIMARY_RENDITION_LABEL

THUMBNAIL_LABEL = "thumb"

# Re-exported so existing callers and tests keep importing them from the stage.
__all__ = [
    "MIGRATIONS_DIR",
    "apply_pending_migrations",
    "build_supabase_batch",
    "discover_migrations",
    "publish_dokid",
]


class BunnyUploader(Protocol):
    """Bunny upload protocol for stage-level tests."""

    def upload_file(
        self,
        local_path: Path,
        remote_path: str,
        *,
        content_type: str,
    ) -> BunnyUploadedObject:
        """Upload and verify one file."""


class SupabasePublisher(Protocol):
    """Supabase publish protocol for stage-level tests."""

    def execute_sql(self, query: str) -> Mapping[str, object]:
        """Execute one SQL statement batch."""

    def publish_batch(self, batch: SupabasePublishBatch) -> Mapping[str, object]:
        """Publish all metadata in one database call."""


def publish_dokid(
    dokid: str,
    *,
    work_dir: Path | str,
    backend: str | None = None,
    apply_migrations: bool = False,
    bunny_uploader: BunnyUploader | None = None,
    supabase_publisher: SupabasePublisher | None = None,
) -> list[Path]:
    """Publish one `11_publish/<clip_id>.json` artifact per rendered clip."""

    settings = get_settings()
    effective_backend = backend or settings.publish_backend
    paths = work_paths(dokid, root=Path(work_dir))
    selected = _read_selected_clips(dokid, Path(work_dir))
    if effective_backend == "local":
        return _publish_local(paths, selected)
    if effective_backend == "remote":
        uploader = bunny_uploader or _bunny_uploader_from_settings(settings)
        publisher = supabase_publisher or _supabase_publisher_from_settings(settings)
        return _publish_remote(
            paths,
            selected,
            uploader=uploader,
            publisher=publisher,
            apply_migrations=apply_migrations,
        )
    raise ConfigurationError(f"Unknown publish backend: {effective_backend}")


def main() -> None:
    """Run the C11 publish stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    parser.add_argument(
        "--backend",
        choices=("local", "remote"),
        default=None,
        help="Publish backend. Defaults to RIKET_PUBLISH_BACKEND.",
    )
    parser.add_argument(
        "--apply-migrations",
        action="store_true",
        help="Apply the committed Supabase publish schema before writing metadata.",
    )
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C11_publish", dokid=args.dokid)
    artifacts = publish_dokid(
        args.dokid,
        work_dir=work_dir,
        backend=args.backend,
        apply_migrations=args.apply_migrations,
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


def _publishable(paths: WorkPaths, selected: list[SelectedClip]) -> list[SelectedClip]:
    """Drop clips C8 could not attribute to a speaker.

    A clip whose C9 plan has no keyframes is unsupported: C8 found no face it
    would call the speaker, so publishing it would put a centre crop of the
    chamber under a named politician's byline. Rejection is a normal outcome
    here and must not read as a pipeline failure — a *missing* render for a clip
    that does have evidence still raises, because that is a real fault. See
    ADR 010.
    """

    logger = stage_logger("C11_publish", dokid="")
    publishable: list[SelectedClip] = []
    for clip in selected:
        plan_path = paths.camera_json(clip.clip_id)
        if not plan_path.exists():
            raise ArtifactError(f"C9 camera artifact is missing: {plan_path}")
        plan = read_model(plan_path, CameraPlan, "C9 camera artifact")
        if not plan.keyframes:
            logger.info(
                "clip_rejected_not_published",
                clip_id=clip.clip_id,
                reason="no_verified_speaker_evidence",
            )
            continue
        publishable.append(clip)
    return publishable


def _publish_local(paths: WorkPaths, selected: list[SelectedClip]) -> list[Path]:
    written: list[Path] = []
    for clip in _publishable(paths, selected):
        rendered_path = paths.render_primary_mp4(clip.clip_id)
        if not rendered_path.exists():
            raise ArtifactError(f"C10 render output is missing: {rendered_path}")
        result = _build_local_publish_result(paths, clip, rendered_path)
        artifact = paths.publish_json(clip.clip_id)
        write_json(artifact, result.model_dump(mode="json"))
        written.append(artifact)
    return written


def _publish_remote(
    paths: WorkPaths,
    selected: list[SelectedClip],
    *,
    uploader: BunnyUploader,
    publisher: SupabasePublisher,
    apply_migrations: bool,
) -> list[Path]:
    if apply_migrations:
        apply_pending_migrations(publisher)

    source_payload = read_json_object(paths.source_json, "C1 source artifact")
    source = Source.model_validate(source_payload.get("source"))
    published_at = datetime.now(tz=UTC)
    publishable = _publishable(paths, selected)
    uploaded_urls: dict[str, dict[str, str]] = {}
    for clip in publishable:
        uploaded_urls[clip.clip_id] = _upload_clip_assets(paths, source, clip, uploader)

    batch = build_supabase_batch(
        paths,
        source_payload=source_payload,
        source=source,
        selected=publishable,
        uploaded_urls=uploaded_urls,
        published_at=published_at,
    )
    publisher.publish_batch(batch)

    written: list[Path] = []
    for clip in publishable:
        result = PublishResult(
            clip_id=clip.clip_id,
            cdn_urls=uploaded_urls[clip.clip_id],
            supabase_row_id=clip.clip_id,
            published_at=published_at,
        )
        artifact = paths.publish_json(clip.clip_id)
        write_json(artifact, result.model_dump(mode="json"))
        written.append(artifact)
    return written


def build_supabase_batch(
    paths: WorkPaths,
    *,
    source_payload: Mapping[str, object],
    source: Source,
    selected: list[SelectedClip],
    uploaded_urls: Mapping[str, Mapping[str, str]],
    published_at: datetime,
) -> SupabasePublishBatch:
    """Build the metadata-only Supabase payload from numbered artifacts."""

    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    candidates = _read_all_candidates(paths, speeches)
    candidate_by_key = {_candidate_key(candidate): candidate for candidate in candidates}
    selected_by_key = {_clip_key(clip): clip for clip in selected}
    official_by_anforande_id = _official_speeches_by_anforande_id(source_payload)
    transcript_by_speech = _transcripts_by_speech(paths, speeches)
    selected_speech_ids = {clip.speech_id for clip in selected}

    return SupabasePublishBatch(
        source=_source_row(source),
        politicians=_politician_rows(official_by_anforande_id),
        speeches=[
            _speech_row(
                speech,
                official_by_anforande_id=official_by_anforande_id,
                transcript=transcript_by_speech.get(speech.speech_id),
                is_published=speech.speech_id in selected_speech_ids,
            )
            for speech in speeches
        ],
        clips=[
            _clip_row(
                clip,
                uploaded_urls=uploaded_urls[clip.clip_id],
                candidate=candidate_by_key.get(_clip_key(clip)),
                published_at=published_at,
            )
            for clip in selected
        ],
        clip_features=[
            _feature_row(candidate, selected_by_key=selected_by_key) for candidate in candidates
        ],
        pipeline_run={
            "kind": "publish",
            "entity_id": source.dokid,
            "idempotency_key": f"publish:{source.dokid}:v1",
            "status": "complete",
            "published_at": published_at.isoformat(),
            "clip_count": len(selected),
            "candidate_count": len(candidates),
        },
    )


def _upload_clip_assets(
    paths: WorkPaths,
    source: Source,
    clip: SelectedClip,
    uploader: BunnyUploader,
) -> dict[str, str]:
    date_prefix = source.debate_date.strftime("%Y/%m")
    rendered_path = paths.render_primary_mp4(clip.clip_id)
    thumbnail_path = paths.render_thumb(clip.clip_id)
    if not rendered_path.exists():
        raise ArtifactError(f"C10 render output is missing: {rendered_path}")
    if not thumbnail_path.exists():
        raise ArtifactError(f"C10 thumbnail output is missing: {thumbnail_path}")

    video = uploader.upload_file(
        rendered_path,
        f"clips/{date_prefix}/{clip.clip_id}_{PRIMARY_RENDITION_LABEL}.mp4",
        content_type="video/mp4",
    )
    thumb = uploader.upload_file(
        thumbnail_path,
        f"thumbs/{date_prefix}/{clip.clip_id}.webp",
        content_type="image/webp",
    )
    return {
        PRIMARY_RENDITION_LABEL: video.public_url,
        THUMBNAIL_LABEL: thumb.public_url,
    }


def _bunny_uploader_from_settings(settings: Settings) -> BunnyStorageClient:
    if settings.bunny_storage_access_key and settings.bunny_cdn_base_url:
        storage_hostname = settings.bunny_storage_hostname or "storage.bunnycdn.com"
        return BunnyStorageClient(
            storage_zone_name=settings.bunny_storage_zone_name,
            access_key=settings.bunny_storage_access_key,
            cdn_base_url=settings.bunny_cdn_base_url,
            storage_hostname=storage_hostname,
            timeout_s=settings.http_timeout_s,
            max_retries=settings.max_http_retries,
        )
    if not settings.bunny_api_key:
        raise ConfigurationError(
            "Remote publish requires RIKET_BUNNY_API_KEY, or direct Bunny storage settings."
        )
    account = BunnyAccountClient(
        api_key=settings.bunny_api_key,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    target = account.provision_storage_target(
        storage_zone_name=settings.bunny_storage_zone_name,
        pull_zone_name=settings.bunny_pull_zone_name,
        region=settings.bunny_storage_region,
    )
    return BunnyStorageClient(
        storage_zone_name=target.storage_zone_name,
        access_key=target.storage_access_key,
        cdn_base_url=target.cdn_base_url,
        storage_hostname=target.storage_hostname,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )


def _supabase_publisher_from_settings(
    settings: Settings,
) -> SupabaseManagementClient | SupabasePublishClient:
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        raise ConfigurationError(
            "Remote publish requires RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN."
        )
    management = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    if settings.supabase_secret_key is None:
        return management
    return SupabasePublishClient(
        management=management,
        rest=SupabaseRestClient(
            project_ref=settings.supabase_project_ref,
            api_key=settings.supabase_secret_key,
            timeout_s=settings.http_timeout_s,
            max_retries=settings.max_http_retries,
        ),
    )


def _build_local_publish_result(
    paths: WorkPaths,
    clip: SelectedClip,
    rendered_path: Path,
) -> PublishResult:
    urls = {PRIMARY_RENDITION_LABEL: rendered_path.resolve().as_uri()}
    thumb_path = paths.render_thumb(clip.clip_id)
    if thumb_path.exists():
        urls[THUMBNAIL_LABEL] = thumb_path.resolve().as_uri()
    return PublishResult(
        clip_id=clip.clip_id,
        cdn_urls=urls,
        supabase_row_id=f"local-{clip.clip_id}",
        published_at=datetime.now(tz=UTC),
    )


def _read_selected_clips(dokid: str, work_dir: Path) -> list[SelectedClip]:
    paths = work_paths(dokid, root=work_dir)
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    clips: list[SelectedClip] = []
    for speech in speeches:
        artifact = paths.selected_json(speech.speech_id)
        if artifact.exists():
            clips.extend(read_model_list(artifact, SelectedClip, "C7 selected artifact"))
    return clips


def _read_all_candidates(paths: WorkPaths, speeches: list[Speech]) -> list[Candidate]:
    candidates: list[Candidate] = []
    for speech in speeches:
        artifact = paths.candidates_json(speech.speech_id)
        if artifact.exists():
            candidates.extend(read_model_list(artifact, Candidate, "C6 candidates artifact"))
    return candidates


def _transcripts_by_speech(paths: WorkPaths, speeches: list[Speech]) -> dict[str, Transcript]:
    transcripts: dict[str, Transcript] = {}
    for speech in speeches:
        artifact = paths.transcript_json(speech.speech_id)
        if artifact.exists():
            transcripts[speech.speech_id] = read_model(
                artifact, Transcript, "C4 transcript artifact"
            )
    return transcripts


def _source_row(source: Source) -> dict[str, object]:
    return {
        "dokid": source.dokid,
        "title": source.title,
        "debate_type": source.debate_type,
        "debate_date": source.debate_date.isoformat(),
        "source_url": source.source_url,
        "duration_s": float(source.duration_s) if source.duration_s is not None else None,
        "master_path": None,
        "master_sha256": source.master_sha256,
        "status": "published",
    }


def _politician_rows(
    official_by_anforande_id: Mapping[str, Mapping[str, object]],
) -> list[dict[str, object]]:
    by_intressent: dict[str, dict[str, object]] = {}
    for official in official_by_anforande_id.values():
        intressent_id = _optional_str(official.get("intressent_id"))
        if intressent_id is None:
            continue
        by_intressent[intressent_id] = {
            "intressent_id": intressent_id,
            "name": _optional_str(official.get("speaker_name"))
            or _optional_str(official.get("talare"))
            or "Okand talare",
            "party": _optional_str(official.get("party")) or _optional_str(official.get("parti")),
            "constituency": None,
            "role": _role_from_speaker(_optional_str(official.get("speaker_name"))),
            "avatar_url": None,
        }
    return list(by_intressent.values())


def _speech_row(
    speech: Speech,
    *,
    official_by_anforande_id: Mapping[str, Mapping[str, object]],
    transcript: Transcript | None,
    is_published: bool,
) -> dict[str, object]:
    anforande_id = _anforande_id_from_speech_id(speech)
    official = official_by_anforande_id.get(anforande_id, {})
    words = None
    asr_text = None
    if transcript is not None:
        words = [word.model_dump(mode="json") for word in transcript.words]
        asr_text = " ".join(word.text for word in transcript.words)
    return {
        "id": speech.speech_id,
        "anforande_id": anforande_id,
        "intressent_id": _optional_str(official.get("intressent_id")),
        "speaker_name": speech.speaker_name,
        "party": speech.party,
        "anforandetyp": speech.anforandetyp,
        "start_s": float(speech.start_s),
        "end_s": float(speech.end_s),
        "official_text": speech.official_text,
        "asr_text": asr_text,
        "words": words,
        "alignment_confidence": float(speech.alignment_confidence),
        "status": "published" if is_published else "processed",
        "needs_review": speech.needs_review,
    }


def _clip_row(
    clip: SelectedClip,
    *,
    uploaded_urls: Mapping[str, str],
    candidate: Candidate | None,
    published_at: datetime,
) -> dict[str, object]:
    return {
        "id": clip.clip_id,
        "speech_id": clip.speech_id,
        "rank_in_speech": clip.rank,
        "start_s": float(clip.start_s),
        "end_s": float(clip.end_s),
        "duration_s": float(clip.end_s - clip.start_s),
        "title": clip.title,
        "hook_text": _hook_text(clip.transcript),
        "transcript": clip.transcript,
        "topic": clip.topic,
        "archetype": clip.archetype,
        "final_score": _final_score(candidate),
        "sub_scores": candidate.sub_scores if candidate is not None else {},
        "url_540x960": uploaded_urls[PRIMARY_RENDITION_LABEL],
        "url_360x640": None,
        "thumb_url": uploaded_urls[THUMBNAIL_LABEL],
        "vtt_url": None,
        "moderation": "auto",
        "published_at": published_at.isoformat(),
    }


def _feature_row(
    candidate: Candidate,
    *,
    selected_by_key: Mapping[tuple[str, float, float], SelectedClip],
) -> dict[str, object]:
    selected_clip = selected_by_key.get(_candidate_key(candidate))
    return {
        "speech_id": candidate.speech_id,
        "selected_clip_id": selected_clip.clip_id if selected_clip is not None else None,
        "start_s": float(candidate.start_s),
        "end_s": float(candidate.end_s),
        "features": candidate.features,
        "archetype_scores": candidate.archetype_scores,
        "sub_scores": candidate.sub_scores,
        "llm_scores": None,
        "final_score": _final_score(candidate),
        "gate_passed": candidate.gate_passed,
        "reject_reason": candidate.reject_reason,
        "was_selected": selected_clip is not None,
        "was_explore": False,
    }


def _official_speeches_by_anforande_id(
    source_payload: Mapping[str, object],
) -> dict[str, Mapping[str, object]]:
    raw_items = source_payload.get("anforanden")
    if not isinstance(raw_items, list):
        return {}
    result: dict[str, Mapping[str, object]] = {}
    for raw_item in raw_items:
        if not isinstance(raw_item, Mapping):
            raise ContractValidationError("C1 anforanden entry is not a JSON object")
        item = dict(raw_item)
        anforande_id = _optional_str(item.get("anforande_id"))
        if anforande_id is not None:
            result[anforande_id] = item
    return result


def _anforande_id_from_speech_id(speech: Speech) -> str:
    prefix = f"{speech.dokid}_"
    if speech.speech_id.startswith(prefix):
        return speech.speech_id[len(prefix) :]
    return speech.speech_id


def _clip_key(clip: SelectedClip) -> tuple[str, float, float]:
    return (clip.speech_id, round(float(clip.start_s), 6), round(float(clip.end_s), 6))


def _candidate_key(candidate: Candidate) -> tuple[str, float, float]:
    return (
        candidate.speech_id,
        round(float(candidate.start_s), 6),
        round(float(candidate.end_s), 6),
    )


def _final_score(candidate: Candidate | None) -> float | None:
    if candidate is None:
        return None
    return candidate.sub_scores.get("final_score")


def _hook_text(transcript: str) -> str:
    compact = " ".join(transcript.split())
    return compact[:280]


def _role_from_speaker(speaker_name: str | None) -> str | None:
    if speaker_name is None:
        return None
    lowered = speaker_name.casefold()
    if "talmannen" in lowered:
        return "talman"
    if "minister" in lowered or "statsråd" in lowered or "statsrad" in lowered:
        return "minister"
    return "ledamot"


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


if __name__ == "__main__":
    main()
