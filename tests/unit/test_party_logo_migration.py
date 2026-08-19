"""Schema and privilege guardrails for verified public party logos."""

from __future__ import annotations

from src.publish.migrations import MIGRATIONS_DIR
from src.riksdagen.party_logos import PARTY_LOGO_SOURCES


def _sql(name: str) -> str:
    return (MIGRATIONS_DIR / name).read_text(encoding="utf-8").lower()


def test_migration_adds_verified_logo_state_for_all_eight_parties() -> None:
    sql = _sql("021_party_logos.up.sql")

    for column in ("logo_url", "logo_source_url", "logo_sha256", "logo_mirrored_at"):
        assert f"add column if not exists {column}" in sql
    for source in PARTY_LOGO_SOURCES:
        assert f"('{source.code.lower()}', '{source.url.lower()}')" in sql
    assert "alter column logo_source_url set not null" in sql
    assert "party_profiles_logo_verified_pair" in sql


def test_migration_preserves_public_read_only_access() -> None:
    sql = _sql("021_party_logos.up.sql")

    assert "grant select on public.party_profiles to anon, authenticated" in sql
    assert "revoke insert, update, delete, truncate, references, trigger" in sql
    assert "on public.party_profiles from anon, authenticated" in sql
    assert "grant all on public.party_profiles to service_role" in sql


def test_frontend_urls_are_not_seeded_before_bunny_verification() -> None:
    sql = _sql("021_party_logos.up.sql")

    assert "b-cdn.net" not in sql
    assert "set logo_source_url = source.url" in sql
    assert "set logo_url" not in sql


def test_down_migration_removes_only_the_logo_columns() -> None:
    sql = _sql("021_party_logos.down.sql")

    for column in ("logo_mirrored_at", "logo_sha256", "logo_source_url", "logo_url"):
        assert f"drop column if exists {column}" in sql
    assert "drop table" not in sql
