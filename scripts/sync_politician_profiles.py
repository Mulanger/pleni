"""Sync complete Riksdagen person records into `public.politicians`.

The video pipeline only needs a stable `intressent_id`; this operator command
enriches those rows independently so profile UI work never becomes a dependency
of rendering or publishing clips.

Usage:

    python scripts/sync_politician_profiles.py --dry-run --limit 3
    python scripts/sync_politician_profiles.py
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import get_settings  # noqa: E402
from src.errors import ConfigurationError, ExternalServiceError  # noqa: E402
from src.publish.supabase import SupabaseManagementClient, sql_jsonb_literal  # noqa: E402
from src.riksdagen.client import RiksdagenClient  # noqa: E402
from src.riksdagen.profiles import PoliticianProfile, profile_from_person  # noqa: E402

DEFAULT_BATCH_SIZE = 25


def main(argv: list[str] | None = None) -> int:
    """Fetch every known politician and persist their complete public record."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and validate profiles without writing to Supabase.",
    )
    parser.add_argument("--limit", type=int, help="Process only the first N ids.")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help="Profiles per Supabase update statement.",
    )
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.batch_size < 1:
        parser.error("--batch-size must be positive")

    settings = get_settings()
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        raise ConfigurationError(
            "Set RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN "
            "in the root .env before syncing politician profiles."
        )

    database = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    riksdagen = RiksdagenClient(
        user_agent=settings.riksdagen_user_agent,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )

    ids = load_politician_ids(database)
    if args.limit is not None:
        ids = ids[: args.limit]
    print(f"politicians: {len(ids)}")

    profiles: list[PoliticianProfile] = []
    missing: list[str] = []
    for index, intressent_id in enumerate(ids, start=1):
        try:
            person = riksdagen.fetch_person_by_id(intressent_id)
            if person is None:
                missing.append(intressent_id)
            else:
                profiles.append(profile_from_person(person, expected_intressent_id=intressent_id))
        except ExternalServiceError as exc:
            missing.append(intressent_id)
            print(f"  warning: {intressent_id}: {exc}")
        if index % 10 == 0 or index == len(ids):
            print(f"  fetched {index}/{len(ids)}")

    if args.dry_run:
        print(f"validated: {len(profiles)}, missing: {len(missing)}, writes: 0")
        return 0 if not missing else 2

    updated = 0
    for batch in chunks(profiles, args.batch_size):
        database.execute_sql(profile_update_sql(batch))
        updated += len(batch)
        print(f"  updated {updated}/{len(profiles)}")

    print(f"complete: {updated} updated, {len(missing)} missing")
    return 0 if not missing else 2


def load_politician_ids(database: SupabaseManagementClient) -> list[str]:
    """Read stable Riksdagen ids already linked to published speech rows."""

    response = database.execute_sql(
        "select intressent_id from public.politicians "
        "where nullif(btrim(intressent_id), '') is not null "
        "order by intressent_id;"
    )
    rows = response.get("result")
    if not isinstance(rows, list):
        raise ExternalServiceError("Supabase politician id query returned no result rows")
    return [
        value
        for row in rows
        if isinstance(row, Mapping)
        if (value := str(row.get("intressent_id") or "").strip())
    ]


def profile_update_sql(profiles: Sequence[PoliticianProfile]) -> str:
    """One bounded, JSON-backed update statement for a profile batch."""

    payload = [profile.database_row() for profile in profiles]
    return f"""
with incoming as (
  select *
  from jsonb_to_recordset({sql_jsonb_literal(payload)}) as p(
    intressent_id text,
    name text,
    party text,
    constituency text,
    role text,
    avatar_url text,
    riksdagen_data jsonb
  )
)
update public.politicians as politician
set
  name = incoming.name,
  party = incoming.party,
  constituency = incoming.constituency,
  role = incoming.role,
  avatar_url = incoming.avatar_url,
  riksdagen_data = incoming.riksdagen_data,
  profile_synced_at = pg_catalog.now()
from incoming
where politician.intressent_id = incoming.intressent_id;
""".strip()


def chunks(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    """Yield bounded slices without copying the complete input again."""

    for start in range(0, len(items), size):
        yield items[start : start + size]


if __name__ == "__main__":
    raise SystemExit(main())
