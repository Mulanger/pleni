"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

OUTPUT_WIDTH = 540
OUTPUT_HEIGHT = 960
CROP_WIDTH = 406
CROP_HEIGHT = 720


class Settings(BaseSettings):
    """Application settings shared by stage entrypoints."""

    model_config = SettingsConfigDict(env_prefix="RIKET_", env_file=".env", extra="ignore")

    work_dir: Path = Field(default=Path("work"))
    log_level: str = Field(default="INFO")
    riksdagen_user_agent: str = Field(default="riket-pipeline/0.1")
    http_timeout_s: float = Field(default=30.0, gt=0.0)
    max_http_retries: int = Field(default=3, ge=0)

    min_candidate_s: float = Field(default=38.0, gt=0.0)
    max_candidate_s: float = Field(default=62.0, gt=0.0)
    max_clip_overlap_frac: float = Field(default=0.20, ge=0.0, le=1.0)
    # `fallback` (deterministic first sentence), `ollama` (local), or `api`
    # (any OpenAI-compatible provider — DeepSeek, MiniMax, z.ai, ...).
    title_backend: str = Field(default="fallback")
    title_model: str = Field(default="qwen3:8b")
    title_ollama_url: str = Field(default="http://127.0.0.1:11434")
    title_api_base_url: str = Field(default="https://api.deepseek.com/v1")
    # SECRET. Server-side only; never a VITE_ variable.
    title_api_key: str | None = Field(default=None)
    # Published prices, USD per million tokens, for cost reporting only.
    title_api_input_per_m: float = Field(default=0.14, ge=0.0)
    title_api_cached_per_m: float = Field(default=0.014, ge=0.0)
    title_api_output_per_m: float = Field(default=0.28, ge=0.0)
    title_timeout_s: float = Field(default=240.0, gt=0.0)
    title_max_attempts: int = Field(default=3, ge=1, le=3)
    # Titles are independent HTTP calls, so they run concurrently. A
    # reasoning model spends ~44s per clip; serially that is 44 minutes for a
    # 60-clip debate. Kept modest to stay a polite API client.
    title_concurrency: int = Field(default=4, ge=1, le=16)
    output_width: int = Field(default=OUTPUT_WIDTH, gt=0)
    output_height: int = Field(default=OUTPUT_HEIGHT, gt=0)
    crop_width: int = Field(default=CROP_WIDTH, gt=0)
    crop_height: int = Field(default=CROP_HEIGHT, gt=0)
    face_detector_backend: str = Field(default="yunet")
    face_min_size_frac: float = Field(default=0.045, gt=0.0, lt=1.0)
    # YuNet's own confidence, not a derived one. On Riksdagen podium footage a
    # speaker's face scores 0.89-0.95 and a background face 0.75-0.92, so 0.70
    # admits real faces generously and leaves "which of them is the speaker" to
    # the tracker rather than to a detection threshold.
    face_score_threshold: float = Field(default=0.70, gt=0.0, le=1.0)
    face_nms_threshold: float = Field(default=0.30, gt=0.0, le=1.0)
    face_top_k: int = Field(default=500, gt=0)
    # Speaker identity (ADR 012). Thresholds are a first calibration from the
    # 30-clip closed-set probe, not a tuned result: a verified correct match
    # landed at 0.366 absolute while beating the runner-up by +0.299, so the
    # absolute floors are permissive and the margin does the discriminating.
    # OpenCV's documented 0.363 LFW figure is a smoke test, not a gate.
    identity_min_embeddings: int = Field(default=3, ge=1)
    identity_min_median_similarity: float = Field(default=0.28, ge=0.0, le=1.0)
    identity_min_p20_similarity: float = Field(default=0.20, ge=0.0, le=1.0)
    identity_min_competitor_margin: float = Field(default=0.08, ge=0.0, le=1.0)
    # Share of a clip's sampled frames that must carry a verified target for the
    # clip to be publishable. Below this it is rejected rather than rendered with
    # the crop held over footage the speaker is not in.
    identity_min_verified_frac: float = Field(default=0.85, ge=0.0, le=1.0)
    # Riksdagen's feed cuts constantly. A cutaway shorter than this is tolerated
    # -- holding the crop across half a second is invisible -- while a longer
    # absence of the verified speaker disqualifies the clip.
    identity_max_unsupported_gap_s: float = Field(default=1.0, gt=0.0)
    identity_embeddings_per_second: float = Field(default=1.0, gt=0.0)
    portrait_cache_dirname: str = Field(default="_portraits")
    face_track_iou_threshold: float = Field(default=0.18, ge=0.0, le=1.0)
    face_track_max_gap_s: float = Field(default=1.0, gt=0.0)
    # Track stitching. A speaker who turns their head stops being detected for
    # longer than `face_track_max_gap_s`, which opens a new track and splits one
    # person into fragments. These two rejoin them: 4 s covers a normal glance
    # down at notes, and requiring 0.30 IoU at the seam means a cut to a
    # different shot is not stitched in, because a new framing moves the box.
    face_track_merge_gap_s: float = Field(default=4.0, gt=0.0)
    face_track_merge_iou: float = Field(default=0.30, ge=0.0, le=1.0)
    sign_language_inset_x_frac: float | None = Field(default=None, ge=0.0, le=1.0)
    sign_language_inset_y_frac: float | None = Field(default=None, ge=0.0, le=1.0)
    sign_language_inset_w_frac: float | None = Field(default=None, ge=0.0, le=1.0)
    sign_language_inset_h_frac: float | None = Field(default=None, ge=0.0, le=1.0)
    camera_dead_zone_frac: float = Field(default=0.12, gt=0.0, lt=1.0)
    camera_max_pan_px_s_1080: float = Field(default=60.0, gt=0.0)
    thumbnail_offset_s: float = Field(default=1.5, ge=0.0)
    render_crf: int = Field(default=20, ge=0, le=51)
    render_preset: str = Field(default="medium")
    publish_backend: str = Field(default="local")
    bunny_api_key: str | None = Field(default=None)
    bunny_storage_zone_name: str = Field(default="riketclips")
    bunny_pull_zone_name: str = Field(default="riketclips")
    bunny_storage_region: str = Field(default="DE")
    bunny_storage_hostname: str | None = Field(default=None)
    bunny_storage_access_key: str | None = Field(default=None)
    bunny_cdn_base_url: str | None = Field(default=None)
    supabase_project_ref: str | None = Field(default=None)
    supabase_access_token: str | None = Field(default=None)
    supabase_secret_key: str | None = Field(default=None)
    supabase_publishable_key: str | None = Field(default=None)

    confront_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "second_person_density": 0.30,
            "names_opponent": 0.20,
            "energy_p90": 0.15,
            "negation_density": 0.15,
            "is_replik": 0.10,
            "pitch_range": 0.10,
        }
    )
    explain_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "has_claim_and_reason": 0.30,
            "number_density": 0.25,
            "self_contained": 0.20,
            "novelty": 0.15,
            "rate_var": -0.10,
        }
    )
    quotable_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "anaphora_score": 0.30,
            "superlative_count": 0.25,
            "pause_before_punchline": 0.20,
            "sentiment_intensity": 0.15,
            "end_intensity_slope": 0.10,
        }
    )


def get_settings() -> Settings:
    """Load settings from the current environment."""

    return Settings()
