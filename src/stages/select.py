"""C7 stage: score candidates and select a capped archetype portfolio."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import structlog

from src.config import get_settings
from src.contracts import AudioFeatures, Candidate, SelectedClip, Source, Speech, Transcript
from src.errors import ConfigurationError, ExternalServiceError
from src.logging import configure_logging, stage_logger
from src.paths import work_paths
from src.scoring.archetypes import score_candidates_for_speech
from src.scoring.select import select_for_speech
from src.scoring.titles import (
    OllamaTitleGenerator,
    OpenAICompatibleTitleGenerator,
    TitleGenerator,
)
from src.stages._io import read_json_object, read_model, read_model_list, write_json


def select_dokid(
    dokid: str,
    *,
    work_dir: Path | str,
    title_backend: str | None = None,
    title_model: str | None = None,
    title_generator: TitleGenerator | None = None,
) -> list[Path]:
    """Write selected clip artifacts grouped by speech id."""

    settings = get_settings()
    paths = work_paths(dokid, root=Path(work_dir))
    effective_title_backend = title_backend or settings.title_backend
    generator = title_generator or _title_generator(
        effective_title_backend,
        endpoint=settings.title_ollama_url,
        model=title_model or settings.title_model,
        timeout_s=settings.title_timeout_s,
        max_attempts=settings.title_max_attempts,
    )
    debate_title = _debate_title(paths.source_json, dokid) if generator is not None else dokid
    logger = stage_logger("C7_select", dokid=dokid)
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    written: list[Path] = []
    for speech in speeches:
        candidates_path = paths.candidates_json(speech.speech_id)
        candidates = read_model_list(candidates_path, Candidate, "C6 candidates artifact")
        transcript = read_model(
            paths.transcript_json(speech.speech_id),
            Transcript,
            "C4 transcript artifact",
        )
        audio_features = read_model(
            paths.audio_features_json(speech.speech_id),
            AudioFeatures,
            "C5 audio features artifact",
        )
        scored = score_candidates_for_speech(
            candidates,
            speech=speech,
            transcript=transcript,
            audio_features=audio_features,
            all_speeches=speeches,
            confront_weights=settings.confront_weights,
            explain_weights=settings.explain_weights,
            quotable_weights=settings.quotable_weights,
        )
        write_json(candidates_path, [candidate.model_dump(mode="json") for candidate in scored])
        selected = select_for_speech(
            speech=speech,
            transcript=transcript,
            candidates=scored,
            max_overlap_frac=settings.max_clip_overlap_frac,
        )
        if generator is not None:
            selected = _generate_titles(
                selected,
                speech=speech,
                debate_title=debate_title,
                generator=generator,
                logger=logger,
            )
        artifact = paths.selected_json(speech.speech_id)
        write_json(artifact, [clip.model_dump(mode="json") for clip in selected])
        written.append(artifact)
    return written


def main() -> None:
    """Run the C7 selection stage."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True, help="Riksdagen document id")
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    parser.add_argument(
        "--title-backend",
        choices=("fallback", "ollama", "api"),
        default=None,
        help="Title generator. Defaults to RIKET_TITLE_BACKEND.",
    )
    parser.add_argument(
        "--title-model",
        default=None,
        help="Ollama model. Defaults to RIKET_TITLE_MODEL.",
    )
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    started = time.monotonic()
    logger = stage_logger("C7_select", dokid=args.dokid)
    artifacts = select_dokid(
        args.dokid,
        work_dir=work_dir,
        title_backend=args.title_backend,
        title_model=args.title_model,
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("stage_complete", duration_ms=duration_ms, artifacts=len(artifacts))
    print("\n".join(str(path) for path in artifacts))


def read_selected_clips(dokid: str, work_dir: Path) -> list[SelectedClip]:
    """Read all C7 selected clip artifacts for a debate."""

    paths = work_paths(dokid, root=work_dir)
    speeches = read_model_list(paths.speeches_json, Speech, "C3 speeches artifact")
    clips: list[SelectedClip] = []
    for speech in speeches:
        artifact = paths.selected_json(speech.speech_id)
        if artifact.exists():
            clips.extend(read_model_list(artifact, SelectedClip, "C7 selected artifact"))
    return clips


def _title_generator(
    backend: str,
    *,
    endpoint: str,
    model: str,
    timeout_s: float,
    max_attempts: int,
) -> TitleGenerator | None:
    if backend == "fallback":
        return None
    if backend == "ollama":
        return OllamaTitleGenerator(
            endpoint=endpoint,
            model=model,
            timeout_s=timeout_s,
            max_attempts=max_attempts,
        )
    if backend == "api":
        settings = get_settings()
        if not settings.title_api_key:
            raise ConfigurationError(
                "Title backend `api` needs RIKET_TITLE_API_KEY. See .env.example."
            )
        return OpenAICompatibleTitleGenerator(
            base_url=settings.title_api_base_url,
            api_key=settings.title_api_key,
            model=model,
            timeout_s=timeout_s,
            max_attempts=max_attempts,
        )
    raise ConfigurationError(f"Unknown title backend: {backend}")


def _debate_title(source_path: Path, dokid: str) -> str:
    payload = read_json_object(source_path, "C1 source artifact")
    source = Source.model_validate(payload.get("source"))
    return source.title or dokid


def _generate_titles(
    clips: list[SelectedClip],
    *,
    speech: Speech,
    debate_title: str,
    generator: TitleGenerator,
    logger: structlog.BoundLogger,
) -> list[SelectedClip]:
    titled: list[SelectedClip] = []
    for clip in clips:
        try:
            generated = generator.generate(
                clip=clip,
                speech=speech,
                debate_title=debate_title,
            )
        except ExternalServiceError as exc:
            logger.warning(
                "title_generation_fallback",
                speech_id=speech.speech_id,
                clip_id=clip.clip_id,
                reason=str(exc),
            )
            titled.append(clip)
            continue
        logger.info(
            "title_generated",
            speech_id=speech.speech_id,
            clip_id=clip.clip_id,
            attempts=generated.attempts,
        )
        titled.append(clip.model_copy(update={"title": generated.title}))
    return titled


if __name__ == "__main__":
    main()
