"""Static privacy and serving guardrails for recommendation migrations."""

from __future__ import annotations

from src.publish.migrations import MIGRATIONS_DIR


def _sql(name: str) -> str:
    return (MIGRATIONS_DIR / name).read_text(encoding="utf-8").lower()


def test_special_category_preferences_are_private_and_service_only() -> None:
    sql = _sql("018_recommendation_identity.up.sql")

    assert "create schema if not exists private" in sql
    assert "revoke all on schema private from public, anon, authenticated" in sql
    for table in (
        "consent_notice_versions",
        "consent_records",
        "viewer_preferences",
        "data_subject_requests",
    ):
        assert f"alter table private.{table} enable row level security" in sql
    assert "grant select on private." not in sql
    assert "source in ('explicit', 'follow', 'inferred')" in sql


def test_consent_is_append_only_and_withdrawal_removes_preferences() -> None:
    sql = _sql("018_recommendation_identity.up.sql")

    assert "insert into private.consent_records" in sql
    assert "update private.consent_records" not in sql
    assert "article_6_basis" in sql
    assert "article_9_condition" in sql
    assert "notice_version" in sql
    assert "delete from private.viewer_preferences" in sql


def test_browser_roles_cannot_execute_private_profile_rpcs() -> None:
    sql = _sql("018_recommendation_identity.up.sql")

    for function in (
        "get_recommendation_profile(text)",
        "set_recommendation_consent(",
        "sync_recommendation_preferences(",
    ):
        start = sql.index(f"revoke all on function public.{function}")
        assert "anon" in sql[start : start + 240]
        assert "authenticated" in sql[start : start + 240]
    assert "to service_role" in sql


def test_feed_records_served_denominator_without_playback_surveillance() -> None:
    sql = _sql("019_rule_based_feed.up.sql")

    assert "create table if not exists private.feed_requests" in sql
    assert "create table if not exists private.feed_items" in sql
    assert "unique (clerk_user_id, client_request_id)" in sql
    assert "exploration_probability numeric not null default 0" in sql
    assert "playback_events" not in sql
    assert "watch_history" not in sql


def test_catalogue_and_slate_use_content_date_and_publication_guards() -> None:
    sql = _sql("019_rule_based_feed.up.sql")

    assert "src.debate_date" in sql
    assert "c.published_at is not null" in sql
    assert "c.moderation <> 'rejected'" in sql
    assert "c.url_540x960 <> ''" in sql
    assert "jsonb_typeof(p_items) <> 'array'" in sql
    assert "item_count > 60" in sql


def test_recommendation_functions_are_service_only_and_pin_search_path() -> None:
    sql = _sql("019_rule_based_feed.up.sql")

    assert sql.count("security definer") == 3
    assert sql.count("set search_path = ''") == 3
    for function in (
        "get_recommendation_context(text)",
        "record_recommendation_slate(text, uuid, text, jsonb)",
        "delete_recommendation_subject(text)",
    ):
        assert f"revoke all on function public.{function}" in sql
        assert f"grant execute on function public.{function}" in sql


def test_launch_controls_fix_retention_and_subject_rights() -> None:
    sql = _sql("020_recommendation_launch_controls.up.sql")

    assert "personalization-2026-08-14-v2" in sql
    assert "export_recommendation_subject_data" in sql
    assert "reset_recommendation_subject" in sql
    assert "purge_expired_recommendation_data" in sql
    assert "interval '30 days'" in sql
    assert "interval '730 days'" in sql
    assert "pleni-recommendation-retention-v1" in sql
    assert "cron.schedule" in sql
    assert "playback_events" not in sql
    assert "watch_history" not in sql

    for function in (
        "export_recommendation_subject_data(text)",
        "reset_recommendation_subject(text)",
        "purge_expired_recommendation_data()",
    ):
        assert f"revoke all on function public.{function}" in sql
