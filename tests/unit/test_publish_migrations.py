"""Unit tests for ordered migration discovery and the P0 privilege migration.

These guard two regressions that are easy to reintroduce:

1. Applying only ``001_publish_schema.up.sql`` because the path was hardcoded,
   which would silently skip every later migration including the security fix.
2. Shipping a ``SECURITY DEFINER`` function without revoking the Postgres
   default ``PUBLIC`` execute grant.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from src.errors import ArtifactError
from src.stages.publish import MIGRATIONS_DIR, discover_migrations

MIGRATION_NAME = re.compile(r"^\d{3}_[a-z0-9_]+\.up\.sql$")


def test_discovers_every_forward_migration_in_order() -> None:
    migrations = discover_migrations()

    names = [path.name for path in migrations]
    assert names == sorted(names), "migrations must apply in numeric order"
    assert "001_publish_schema.up.sql" in names
    assert "002_security_hardening.up.sql" in names
    assert all(MIGRATION_NAME.match(name) for name in names), names


def test_down_migrations_are_never_applied() -> None:
    names = [path.name for path in discover_migrations()]

    assert not any(name.endswith(".down.sql") for name in names)


def test_every_up_migration_has_a_down_migration() -> None:
    for migration in discover_migrations():
        down = migration.with_name(migration.name.replace(".up.sql", ".down.sql"))
        assert down.is_file(), f"missing down migration for {migration.name}"


def test_missing_directory_raises(tmp_path: Path) -> None:
    with pytest.raises(ArtifactError):
        discover_migrations(tmp_path / "nope")


def test_empty_directory_raises(tmp_path: Path) -> None:
    with pytest.raises(ArtifactError):
        discover_migrations(tmp_path)


def test_ordering_is_numeric_not_creation_time(tmp_path: Path) -> None:
    # Written newest-first on purpose: sorting must not depend on mtime.
    for name in ("010_late.up.sql", "002_middle.up.sql", "001_first.up.sql"):
        (tmp_path / name).write_text("select 1;", encoding="utf-8")

    names = [path.name for path in discover_migrations(tmp_path)]

    assert names == ["001_first.up.sql", "002_middle.up.sql", "010_late.up.sql"]


def _security_migration() -> str:
    return (MIGRATIONS_DIR / "002_security_hardening.up.sql").read_text(encoding="utf-8")


def test_security_migration_revokes_public_execute_on_publish_rpc() -> None:
    sql = _security_migration().lower()

    assert "revoke all on function public.publish_clip_batch(jsonb) from public" in sql
    assert "revoke all on function public.publish_clip_batch(jsonb) from anon" in sql
    assert "revoke all on function public.publish_clip_batch(jsonb) from authenticated" in sql
    assert "grant execute on function public.publish_clip_batch(jsonb) to service_role" in sql


def test_security_migration_stops_exposing_discovered_sources() -> None:
    sql = _security_migration().lower()

    policy = sql[sql.index("create policy sources_public_read") :]
    assert "'discovered'" not in policy.split(";")[0]


def test_no_migration_grants_publish_rpc_to_public_roles() -> None:
    """A later migration must not undo 002. The `.down.sql` files are exempt."""

    for migration in discover_migrations():
        sql = migration.read_text(encoding="utf-8").lower()
        for role in ("anon", "authenticated"):
            grant = f"grant execute on function public.publish_clip_batch(jsonb) to {role}"
            assert grant not in sql


def test_politician_profile_migration_retains_raw_data_and_defaults_portraits() -> None:
    path = MIGRATIONS_DIR / "009_politician_profiles.up.sql"
    sql = path.read_text(encoding="utf-8").lower()

    assert "riksdagen_data jsonb" in sql
    assert "profile_synced_at timestamptz" in sql
    assert "before insert or update of intressent_id, avatar_url" in sql
    assert "data.riksdagen.se/filarkiv/bilder/ledamot/%s_192.jpg" in sql
    assert (
        "revoke all on function public.set_politician_avatar_url() from public, anon, authenticated"
    ) in sql
