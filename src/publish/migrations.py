"""Ordered migration discovery and the `schema_migrations` ledger.

Prerequisite P0-3 in `docs/RECOMMENDATION_PREREQUISITES.md`.

Two separate failures live here, and only the first one was closed earlier:

1. `src/stages/publish.py` used to hardcode `001_publish_schema.up.sql`, so
   `002` and everything after it silently never ran. `discover_migrations()`
   fixes that.
2. Without a ledger, "apply the migrations" means "re-run every file every
   time". That is fine while every migration is idempotent, and a live incident
   the first time one is not. It also cannot detect a migration that was edited
   after it was applied, which is how two environments quietly diverge.

`apply_pending_migrations()` closes the second one: each file is applied at most
once, keyed by filename, with a SHA-256 of its bytes recorded alongside. A file
whose checksum no longer matches the ledger fails loudly rather than being
skipped, because at that point nobody knows what the database actually contains.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from src.errors import ArtifactError, ExternalServiceError

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"

#: Created here rather than assumed, so a fresh database can be migrated from
#: zero without 002 having run first. Mirrors the DDL in
#: `migrations/002_security_hardening.up.sql`; keep the two in step.
LEDGER_DDL = """
create table if not exists public.schema_migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from public, anon, authenticated;
grant all on public.schema_migrations to service_role;
"""


class SqlExecutor(Protocol):
    """Anything that can run one SQL statement batch against the project."""

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        """Execute SQL and return the decoded response."""


@dataclass(frozen=True)
class MigrationApplication:
    """One migration's outcome for a single `apply_pending_migrations()` run."""

    filename: str
    checksum: str
    applied: bool

    @property
    def status(self) -> str:
        """Human-readable outcome for logs and the CLI."""

        return "applied" if self.applied else "already-applied"


def discover_migrations(migrations_dir: Path | None = None) -> list[Path]:
    """Return every forward migration in lexicographic (numbered) order.

    Migrations are named ``NNN_description.up.sql``; the zero-padded prefix makes
    a plain sort the apply order. Down migrations are excluded.
    """

    directory = migrations_dir or MIGRATIONS_DIR
    if not directory.is_dir():
        raise ArtifactError(f"Migrations directory not found: {directory}")

    migrations = sorted(path for path in directory.glob("*.up.sql") if path.is_file())
    if not migrations:
        raise ArtifactError(f"No *.up.sql migrations found in {directory}")
    return migrations


def migration_checksum(migration_path: Path) -> str:
    """Return the SHA-256 of a migration file's bytes.

    Hashes bytes rather than decoded text so a line-ending or encoding change is
    treated as the edit it is.
    """

    return hashlib.sha256(migration_path.read_bytes()).hexdigest()


def apply_pending_migrations(
    executor: SqlExecutor,
    *,
    migrations_dir: Path | None = None,
) -> list[MigrationApplication]:
    """Apply every migration not yet recorded in `public.schema_migrations`.

    Idempotent: applying twice is a no-op the second time. Raises
    `ExternalServiceError` if a file's checksum differs from the recorded one,
    because a migration that was edited after it was applied means the database
    schema and the repository have diverged in an unknown way.
    """

    executor.execute_sql(LEDGER_DDL)
    recorded = _recorded_checksums(executor)

    results: list[MigrationApplication] = []
    for migration_path in discover_migrations(migrations_dir):
        filename = migration_path.name
        checksum = migration_checksum(migration_path)
        previous = recorded.get(filename)

        if previous == checksum:
            results.append(MigrationApplication(filename, checksum, applied=False))
            continue

        if previous is not None:
            raise ExternalServiceError(
                f"Migration {filename} was edited after it was applied "
                f"(recorded checksum {previous[:12]}…, file is {checksum[:12]}…). "
                "Add a new migration instead of editing an applied one."
            )

        executor.execute_sql(migration_path.read_text(encoding="utf-8"))
        executor.execute_sql(
            "insert into public.schema_migrations (filename, checksum) "
            f"values ({_sql_text_literal(filename)}, {_sql_text_literal(checksum)}) "
            "on conflict (filename) do update set "
            "checksum = excluded.checksum, applied_at = now();"
        )
        results.append(MigrationApplication(filename, checksum, applied=True))

    return results


def _recorded_checksums(executor: SqlExecutor) -> dict[str, str]:
    response = executor.execute_sql(
        "select filename, checksum from public.schema_migrations;"
    )
    recorded: dict[str, str] = {}
    for row in _rows(response):
        filename = row.get("filename")
        checksum = row.get("checksum")
        if isinstance(filename, str) and isinstance(checksum, str):
            recorded[filename] = checksum
    return recorded


def _rows(response: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Extract result rows from a Management API response.

    The API returns a bare JSON array, which `SupabaseManagementClient` wraps as
    ``{"result": [...]}``. Tolerate both shapes so a fake in tests can return
    either.
    """

    candidate: Any = response.get("result", response)
    if isinstance(candidate, Mapping):
        candidate = candidate.get("rows", [])
    if not isinstance(candidate, list):
        return []
    return [row for row in candidate if isinstance(row, Mapping)]


def _sql_text_literal(value: str) -> str:
    """Render a Python string as a single-quoted SQL literal."""

    escaped = value.replace("'", "''")
    return f"'{escaped}'"
