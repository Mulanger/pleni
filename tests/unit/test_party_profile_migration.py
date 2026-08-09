"""Schema and privilege guardrails for public political party profiles."""

from __future__ import annotations

from src.publish.migrations import MIGRATIONS_DIR


def _sql(name: str) -> str:
    return (MIGRATIONS_DIR / name).read_text(encoding="utf-8").lower()


def test_party_profiles_seed_all_riksdag_parties_without_stale_totals() -> None:
    sql = _sql("014_party_profiles.up.sql")

    assert "create table if not exists public.party_profiles" in sql
    for code in ("s", "m", "sd", "c", "v", "kd", "mp", "l"):
        assert f"('{code}'," in sql
    assert "clip_count" not in sql
    assert "politician_count" not in sql


def test_party_profiles_are_publicly_readable_but_browser_read_only() -> None:
    sql = _sql("014_party_profiles.up.sql")

    assert "alter table public.party_profiles enable row level security" in sql
    assert "create policy party_profiles_public_read" in sql
    assert "grant select on public.party_profiles to anon, authenticated" in sql
    assert "revoke insert, update, delete, truncate, references, trigger" in sql
    assert "on public.party_profiles from anon, authenticated" in sql
    assert "grant all on public.party_profiles to service_role" in sql


def test_party_affiliation_has_an_index_and_down_migration_is_complete() -> None:
    up = _sql("014_party_profiles.up.sql")
    down = _sql("014_party_profiles.down.sql")

    assert "politicians_party_idx on public.politicians (party)" in up
    assert "drop table if exists public.party_profiles" in down
    assert "drop index if exists public.politicians_party_idx" in down
