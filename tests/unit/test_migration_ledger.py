"""Unit tests for the `schema_migrations` ledger (prerequisite P0-3).

The ledger's stated acceptance is: applying twice is a no-op, a mutated
checksum fails loudly, and a fresh database converges to the same schema.
These cover the first two; the third needs a real Postgres (`tests/live`).
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from src.errors import ExternalServiceError
from src.publish.migrations import (
    apply_pending_migrations,
    migration_checksum,
)


class FakeDatabase:
    """A Management-API-shaped executor with a real in-memory ledger."""

    def __init__(self) -> None:
        self.ledger: dict[str, str] = {}
        self.executed: list[str] = []

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        self.executed.append(query)

        if "from public.schema_migrations" in query:
            return {
                "result": [
                    {"filename": name, "checksum": checksum}
                    for name, checksum in sorted(self.ledger.items())
                ]
            }

        if "insert into public.schema_migrations" in query:
            filename, checksum = _parse_ledger_insert(query)
            self.ledger[filename] = checksum
            return {}

        return {}

    @property
    def migration_bodies(self) -> list[str]:
        """Statements that were neither ledger reads nor ledger writes."""

        return [
            statement
            for statement in self.executed
            if "public.schema_migrations" not in statement
        ]


def _parse_ledger_insert(query: str) -> tuple[str, str]:
    """Decode the two SQL literals, undoing the `''` escaping the writer applies."""

    values = query.split("values (", 1)[1].split(") on conflict", 1)[0]
    filename, checksum = (
        part.strip().removeprefix("'").removesuffix("'").replace("''", "'")
        for part in values.rsplit(",", 1)
    )
    return filename, checksum


def _write_migration(directory: Path, name: str, body: str) -> Path:
    path = directory / name
    path.write_text(body, encoding="utf-8")
    (directory / name.replace(".up.sql", ".down.sql")).write_text("select 1;", encoding="utf-8")
    return path


def test_applies_every_migration_in_order_on_a_fresh_database(tmp_path: Path) -> None:
    _write_migration(tmp_path, "002_second.up.sql", "create table b();")
    _write_migration(tmp_path, "001_first.up.sql", "create table a();")
    database = FakeDatabase()

    results = apply_pending_migrations(database, migrations_dir=tmp_path)

    assert [result.filename for result in results] == ["001_first.up.sql", "002_second.up.sql"]
    assert all(result.applied for result in results)
    assert database.migration_bodies == ["create table a();", "create table b();"]


def test_second_run_applies_nothing(tmp_path: Path) -> None:
    _write_migration(tmp_path, "001_first.up.sql", "create table a();")
    database = FakeDatabase()
    apply_pending_migrations(database, migrations_dir=tmp_path)
    bodies_after_first_run = len(database.migration_bodies)

    results = apply_pending_migrations(database, migrations_dir=tmp_path)

    assert [result.applied for result in results] == [False]
    assert results[0].status == "already-applied"
    assert len(database.migration_bodies) == bodies_after_first_run


def test_editing_an_applied_migration_fails_loudly(tmp_path: Path) -> None:
    path = _write_migration(tmp_path, "001_first.up.sql", "create table a();")
    database = FakeDatabase()
    apply_pending_migrations(database, migrations_dir=tmp_path)

    path.write_text("create table a(); drop table users;", encoding="utf-8")

    with pytest.raises(ExternalServiceError, match="edited after it was applied"):
        apply_pending_migrations(database, migrations_dir=tmp_path)


def test_a_new_migration_applies_without_replaying_the_old_ones(tmp_path: Path) -> None:
    _write_migration(tmp_path, "001_first.up.sql", "create table a();")
    database = FakeDatabase()
    apply_pending_migrations(database, migrations_dir=tmp_path)
    _write_migration(tmp_path, "002_second.up.sql", "create table b();")

    results = apply_pending_migrations(database, migrations_dir=tmp_path)

    assert [(r.filename, r.applied) for r in results] == [
        ("001_first.up.sql", False),
        ("002_second.up.sql", True),
    ]
    assert database.migration_bodies == ["create table a();", "create table b();"]


def test_checksum_hashes_bytes_so_a_line_ending_change_is_detected(tmp_path: Path) -> None:
    unix = tmp_path / "unix.sql"
    windows = tmp_path / "windows.sql"
    unix.write_bytes(b"select 1;\nselect 2;\n")
    windows.write_bytes(b"select 1;\r\nselect 2;\r\n")

    assert migration_checksum(unix) != migration_checksum(windows)


def test_filenames_with_quotes_cannot_break_out_of_the_ledger_insert(tmp_path: Path) -> None:
    _write_migration(tmp_path, "001_o'brien.up.sql", "select 1;")
    database = FakeDatabase()

    apply_pending_migrations(database, migrations_dir=tmp_path)

    assert "001_o'brien.up.sql" in database.ledger
