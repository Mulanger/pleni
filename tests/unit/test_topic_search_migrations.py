"""Static safety and lifecycle guardrails for UI16 topic-search migrations."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from src.publish.migrations import MIGRATIONS_DIR, discover_migrations

UP = MIGRATIONS_DIR / "022_search_foundation.up.sql"
DOWN = MIGRATIONS_DIR / "022_search_foundation.down.sql"
RELEVANCE_UP = MIGRATIONS_DIR / "027_search_relevance_latency.up.sql"
RELEVANCE_DOWN = MIGRATIONS_DIR / "027_search_relevance_latency.down.sql"
CACHE_UP = MIGRATIONS_DIR / "028_search_catalog_cache.up.sql"
CACHE_DOWN = MIGRATIONS_DIR / "028_search_catalog_cache.down.sql"

DEPLOYED_PREREQUISITE_HASHES = {
    "020_recommendation_launch_controls.up.sql": (
        "685f57dcbc3b41711879db9555b94b5b25ea877b71b3422a1a5ebb56a9cc7337"
    ),
    "020_recommendation_launch_controls.down.sql": (
        "34f3d64cf82a794ee1484678f7536b9bcbfd2f2adc617780a4b2247bb7cc1734"
    ),
    "021_party_logos.up.sql": ("3055ae49a345647f30897dbe20f2d376c767362e9cc21a5c533d2d099b98d98d"),
    "021_party_logos.down.sql": (
        "b6bb942c0c4b2b912b08c5c1d569cd36523d9434a7e79c94938494050bc6b132"
    ),
}


def _sql(path: Path) -> str:
    return path.read_text(encoding="utf-8").lower()


def _table_block(sql: str, table: str) -> str:
    start = sql.index(f"create table if not exists private.{table}")
    end = sql.index(";", start)
    return sql[start : end + 1]


def test_deployed_prerequisite_migrations_are_restored_byte_for_byte() -> None:
    for name, expected in DEPLOYED_PREREQUISITE_HASHES.items():
        path = MIGRATIONS_DIR / name
        assert path.is_file(), f"missing deployed migration file {name}"
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected


def test_search_foundation_is_the_next_discovered_migration() -> None:
    names = [path.name for path in discover_migrations()]
    start = names.index("020_recommendation_launch_controls.up.sql")

    assert names[start : start + 3] == [
        "020_recommendation_launch_controls.up.sql",
        "021_party_logos.up.sql",
        "022_search_foundation.up.sql",
    ]


def test_keyword_foundation_uses_built_in_swedish_fts_without_provider_extensions() -> None:
    sql = _sql(UP)

    assert "pg_catalog.swedish" in sql
    assert "generated always as" in sql
    assert "to_tsvector('pg_catalog.swedish'::regconfig, title)" in sql
    assert "to_tsvector('pg_catalog.swedish'::regconfig, transcript)" in sql
    assert "'a'" in sql
    assert "'b'" in sql
    assert "using gin (search_vector)" in sql
    assert "create extension" not in sql
    assert "does not call openai" in sql
    assert "http://" not in sql
    assert "https://" not in sql
    assert "pg_net" not in sql


def test_search_document_has_stable_filter_metadata_and_semantic_handoff_state() -> None:
    block = _table_block(_sql(UP), "clip_search_documents")

    for field in (
        "clip_id text primary key references public.clips(id) on delete cascade",
        "speech_id text not null",
        "source_id uuid not null",
        "politician_id uuid",
        "speaker_name_at_speech text not null",
        "party_at_speech text",
        "debate_date date not null",
        "title text not null",
        "transcript text not null",
        "source_hash text not null",
        "keyword_indexed_at timestamptz not null",
        "semantic_state text not null default 'pending'",
        "requested_index_version text",
        "completed_index_version text",
        "semantic_last_error text",
    ):
        assert field in block

    assert "sha256" in _sql(UP)
    assert "clip-search-document-v1" in _sql(UP)
    assert "source_hash ~ '^[0-9a-f]{64}$'" in block


def test_keyword_projection_matches_exact_public_eligibility_and_backfills() -> None:
    sql = _sql(UP)

    source_function = sql[
        sql.index("create or replace function private.clip_search_document_input") : sql.index(
            "create or replace function private.refresh_clip_search_document"
        )
    ]
    assert "c.published_at is not null" in source_function
    assert "c.moderation <> 'rejected'" in source_function
    assert "join public.speeches" in source_function
    assert "join public.sources" in source_function
    assert "when pg_catalog.btrim(s.party) in" in source_function
    assert "else null" in source_function
    assert "from private.clip_search_document_input(null) input" in sql
    assert "delete from private.clip_search_documents document" in sql


def test_public_catalogue_triggers_cover_future_publish_and_metadata_changes() -> None:
    sql = _sql(UP)

    assert "create trigger clips_sync_search_document" in sql
    assert "after insert or delete or update of" in sql
    for field in ("speech_id", "title", "transcript", "moderation", "published_at"):
        assert re.search(rf"\b{field}\b", sql)
    assert "create trigger speeches_sync_search_documents" in sql
    assert "create trigger sources_sync_search_documents" in sql
    assert "perform private.refresh_clip_search_document" in sql
    assert "delete from private.clip_search_documents where clip_id = p_clip_id" in sql
    assert "semantic_state = case" in sql
    assert "then 'pending'" in sql


def test_entity_rate_limit_and_operator_tables_are_private_and_minimal() -> None:
    sql = _sql(UP)
    tables = (
        "clip_search_documents",
        "search_events",
        "search_event_sources",
        "search_event_aliases",
        "search_person_aliases",
        "search_rate_limit_buckets",
        "search_system_state",
    )

    for table in tables:
        assert f"create table if not exists private.{table}" in sql
        assert f"alter table private.{table} enable row level security" in sql
        assert f"revoke all on private.{table} from public, anon, authenticated" in sql
        assert f"grant all on private.{table} to service_role" in sql
        assert f"grant select on private.{table} to anon" not in sql

    rate_limit = _table_block(sql, "search_rate_limit_buckets")
    assert "key_hash ~ '^[0-9a-f]{64}$'" in rate_limit
    assert "query" not in rate_limit
    assert "address" not in rate_limit
    assert "ip_" not in rate_limit
    assert "provider_kill_switch boolean not null default true" in sql
    assert "provider_enabled boolean not null default false" in sql
    assert "revoke all on sequence private.search_event_aliases_id_seq" in sql
    assert "revoke all on sequence private.search_person_aliases_id_seq" in sql


def test_keyword_rpc_is_service_only_pinned_filtered_and_deterministic() -> None:
    sql = _sql(UP)
    start = sql.index("create or replace function public.search_clip_keywords")
    function = sql[start:]

    assert "security definer" in function
    assert "set search_path = ''" in function
    assert "websearch_to_tsquery" in function
    assert "query_must_be_2_to_120_characters" in function
    assert "least(coalesce(p_limit, 120), 120)" in function
    assert "clip.published_at is not null" in function
    assert "clip.moderation <> 'rejected'" in function
    assert "btrim(clip.url_540x960)" in function
    assert "document.politician_id = p_politician_id" in function
    assert "document.party_at_speech" in function
    assert "document.debate_date >= p_date_from" in function
    assert "document.source_id = any(p_source_ids)" in function
    assert "order by keyword_rank desc, document.debate_date desc, document.clip_id asc" in function
    assert "from public, anon, authenticated" in function
    assert "to service_role" in function


def test_private_helpers_revoke_default_public_execute() -> None:
    sql = _sql(UP)
    for signature in (
        "private.clip_search_document_input(text)",
        "private.refresh_clip_search_document(text)",
        "private.sync_clip_search_document_trigger()",
        "private.sync_speech_search_documents_trigger()",
        "private.sync_source_search_documents_trigger()",
    ):
        assert f"revoke all on function {signature}" in sql


def test_down_migration_removes_only_search_objects() -> None:
    sql = _sql(DOWN)

    for trigger in (
        "sources_sync_search_documents",
        "speeches_sync_search_documents",
        "clips_sync_search_document",
    ):
        assert f"drop trigger if exists {trigger}" in sql
    for table in (
        "search_system_state",
        "search_rate_limit_buckets",
        "search_person_aliases",
        "search_event_aliases",
        "search_event_sources",
        "search_events",
        "clip_search_documents",
    ):
        assert f"drop table if exists private.{table}" in sql

    assert "drop schema" not in sql
    assert "drop table if exists public." not in sql
    assert "delete from public." not in sql


def test_ui169_relevance_migration_is_additive_private_and_calibrated() -> None:
    up = _sql(RELEVANCE_UP)
    down = _sql(RELEVANCE_DOWN)

    assert "create or replace function public.prepare_clip_search_request" in up
    assert "create or replace function public.search_clip_candidates_v2" in up
    assert "top_similarity >= 0.53" in up
    assert "top_lexical_coverage >= 0.67" in up
    assert "tsvector_to_array" in up
    assert "has_keyword_anchor" in up
    assert "operator(extensions.<=>)" in up
    assert "chunk.source_hash = document.source_hash" in up
    assert "from public, anon, authenticated" in up
    assert "to service_role" in up
    assert "_evaluationsimilarity" not in up
    assert "drop function if exists public.search_clip_candidates_v2" in down
    assert "drop function if exists public.prepare_clip_search_request" in down
    assert "drop function if exists public.search_clip_candidates(" not in down
    assert "drop table" not in down


def test_ui169_catalog_cache_refreshes_from_entities_and_rolls_back_cleanly() -> None:
    up = _sql(CACHE_UP)
    down = _sql(CACHE_DOWN)

    assert "add column if not exists entity_catalog jsonb" in up
    assert "public.load_search_entity_catalog_cached()" in up
    assert "select private.refresh_search_entity_catalog_cache()" in up
    for table in (
        "search_person_aliases",
        "search_events",
        "search_event_sources",
        "search_event_aliases",
    ):
        assert f"on private.{table}" in up
    assert "for each statement" in up
    assert "catalog := public.load_search_entity_catalog_cached()" in up
    assert "from public, anon, authenticated" in up
    assert "catalog := public.load_search_entity_catalog()" in down
    assert "drop column if exists entity_catalog" in down
    assert "drop table" not in down
