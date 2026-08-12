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
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import get_settings  # noqa: E402
from src.errors import ExternalServiceError  # noqa: E402
from src.riksdagen.client import RiksdagenClient  # noqa: E402
from src.riksdagen.profile_sync import (  # noqa: E402
    PORTRAIT_ABSENT,
    PORTRAIT_MIRRORED,
    PORTRAIT_REUSED,
    ExistingPolitician,
    ProfileSyncRow,
    bunny_storage_from_settings,
    chunks,
    database_from_settings,
    load_politicians,
    prepare_profile_sync,
    profile_update_sql,
    retain_existing_portrait,
)
from src.riksdagen.profiles import PoliticianProfile, profile_from_person  # noqa: E402

DEFAULT_BATCH_SIZE = 25

__all__ = [
    "ExistingPolitician",
    "ProfileSyncRow",
    "bunny_storage_from_settings",
    "chunks",
    "load_politicians",
    "profile_update_sql",
    "retain_existing_portrait",
]


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
    database = database_from_settings(settings)
    riksdagen = RiksdagenClient(
        user_agent=settings.riksdagen_user_agent,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )

    existing_rows = load_politicians(database)
    if args.limit is not None:
        existing_rows = existing_rows[: args.limit]
    ids = [row.intressent_id for row in existing_rows]
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

    storage = bunny_storage_from_settings(settings)
    existing_by_id = {row.intressent_id: row for row in existing_rows}
    sync_rows: list[ProfileSyncRow] = []
    portrait_failures: list[str] = []
    absent = 0
    reused = 0
    mirrored = 0
    for index, profile in enumerate(profiles, start=1):
        existing = existing_by_id[profile.intressent_id]
        try:
            result = prepare_profile_sync(
                profile,
                existing,
                riksdagen=riksdagen,
                storage=storage,
            )
            sync_rows.append(result.row)
            if result.portrait_status == PORTRAIT_REUSED:
                reused += 1
            elif result.portrait_status == PORTRAIT_MIRRORED:
                mirrored += 1
            elif result.portrait_status == PORTRAIT_ABSENT:
                absent += 1
        except ExternalServiceError as exc:
            portrait_failures.append(profile.intressent_id)
            sync_rows.append(retain_existing_portrait(profile, existing))
            print(f"  portrait warning: {profile.intressent_id}: {exc}")
        if index % 10 == 0 or index == len(profiles):
            print(f"  portraits {index}/{len(profiles)}")

    updated = 0
    for batch in chunks(sync_rows, args.batch_size):
        database.execute_sql(profile_update_sql(batch))
        updated += len(batch)
        print(f"  updated {updated}/{len(sync_rows)}")

    print(
        f"complete: {updated} updated, {mirrored} mirrored, {reused} reused, "
        f"{absent} without portraits, {len(portrait_failures)} portrait failures, "
        f"{len(missing)} missing"
    )
    return 0 if not missing and not portrait_failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
