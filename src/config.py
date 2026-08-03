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
    face_detector_backend: str = Field(default="haar")
    face_min_size_frac: float = Field(default=0.045, gt=0.0, lt=1.0)
    face_track_iou_threshold: float = Field(default=0.18, ge=0.0, le=1.0)
    face_track_max_gap_s: float = Field(default=1.0, gt=0.0)
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
