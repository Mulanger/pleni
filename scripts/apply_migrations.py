"""Apply pending Supabase migrations through the Management API.

Prerequisite P0-3. Applying migrations used to be a side effect of
`python -m src.stages.publish --apply-migrations`, which meant schema work was
coupled to publishing clips. Migration 003 has nothing to do with publishing.

Reads credentials from the environment or a gitignored `.env` at the repo root
(see `.env.example`):

    RIKET_SUPABASE_PROJECT_REF
    RIKET_SUPABASE_ACCESS_TOKEN

Usage:

    python scripts/apply_migrations.py --dry-run
    python scripts/apply_migrations.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import get_settings  # noqa: E402
from src.errors import ConfigurationError  # noqa: E402
from src.publish.migrations import (  # noqa: E402
    apply_pending_migrations,
    discover_migrations,
    migration_checksum,
)
from src.publish.supabase import SupabaseManagementClient  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    """Apply every migration not yet recorded in `public.schema_migrations`."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List the migrations that would run without touching the database.",
    )
    args = parser.parse_args(argv)

    if args.dry_run:
        for path in discover_migrations():
            print(f"{path.name}  sha256={migration_checksum(path)[:12]}…")
        return 0

    settings = get_settings()
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        raise ConfigurationError(
            "Set RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN "
            "(environment or .env at the repo root). See .env.example."
        )

    client = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )

    print(f"project: {settings.supabase_project_ref}")
    for result in apply_pending_migrations(client):
        print(f"  {result.status:>15}  {result.filename}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
