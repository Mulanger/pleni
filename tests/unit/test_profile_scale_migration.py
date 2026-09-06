"""Regression coverage for profile catalogue scale indexes."""

from __future__ import annotations

from src.stages.publish import MIGRATIONS_DIR


def test_profile_scale_migration_indexes_filter_and_chronology_paths() -> None:
    sql = (MIGRATIONS_DIR / "032_profile_page_scale_indexes.up.sql").read_text(
        encoding="utf-8"
    ).lower()

    assert "on public.speeches (politician_id, source_id)" in sql
    assert "where politician_id is not null" in sql
    assert "on public.speeches (party, source_id)" in sql
    assert "on public.sources (debate_date desc, id)" in sql
    assert "on public.clips (speech_id, published_at desc, id)" in sql
    assert "moderation <> 'rejected'" in sql
    assert "url_540x960 <> ''" in sql


def test_profile_scale_down_migration_removes_only_its_indexes() -> None:
    sql = (MIGRATIONS_DIR / "032_profile_page_scale_indexes.down.sql").read_text(
        encoding="utf-8"
    ).lower()

    for index in (
        "clips_profile_catalogue_idx",
        "sources_debate_date_id_idx",
        "speeches_party_source_idx",
        "speeches_politician_source_idx",
    ):
        assert f"drop index if exists public.{index}" in sql
    assert "drop table" not in sql
