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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import Settings, get_settings  # noqa: E402
from src.errors import ConfigurationError, ExternalServiceError  # noqa: E402
from src.publish.bunny import BunnyAccountClient, BunnyStorageClient  # noqa: E402
from src.publish.supabase import SupabaseManagementClient, sql_jsonb_literal  # noqa: E402
from src.riksdagen.client import RiksdagenClient  # noqa: E402
from src.riksdagen.portraits import download_portrait, upload_portrait  # noqa: E402
from src.riksdagen.profiles import PoliticianProfile, profile_from_person  # noqa: E402

DEFAULT_BATCH_SIZE = 25


@dataclass(frozen=True)
class ExistingPolitician:
    """Portrait state already stored for one public politician row."""

    intressent_id: str
    avatar_url: str | None
    avatar_source_url: str | None
    avatar_sha256: str | None


@dataclass(frozen=True)
class ProfileSyncRow:
    """Complete profile metadata plus the safe portrait URL chosen for writing."""

    profile: PoliticianProfile
    avatar_url: str | None
    avatar_source_url: str
    avatar_sha256: str | None
    mirrored_now: bool

    def database_row(self) -> dict[str, object]:
        """JSON-compatible row consumed by the bounded profile update SQL."""

        row = self.profile.database_row()
        row.update(
            {
                "avatar_url": self.avatar_url,
                "avatar_source_url": self.avatar_source_url,
                "avatar_sha256": self.avatar_sha256,
                "mirrored_now": self.mirrored_now,
            }
        )
        return row


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
    reused = 0
    mirrored = 0
    for index, profile in enumerate(profiles, start=1):
        existing = existing_by_id[profile.intressent_id]
        source_url = profile.avatar_url
        try:
            image = download_portrait(riksdagen, source_url)
            if (
                existing.avatar_sha256 == image.sha256
                and existing.avatar_url is not None
                and not existing.avatar_url.startswith("https://data.riksdagen.se/")
            ):
                sync_rows.append(
                    ProfileSyncRow(
                        profile=profile,
                        avatar_url=existing.avatar_url,
                        avatar_source_url=source_url,
                        avatar_sha256=image.sha256,
                        mirrored_now=False,
                    )
                )
                reused += 1
            else:
                uploaded = upload_portrait(
                    storage,
                    intressent_id=profile.intressent_id,
                    image=image,
                )
                sync_rows.append(
                    ProfileSyncRow(
                        profile=profile,
                        avatar_url=uploaded.cdn_url,
                        avatar_source_url=source_url,
                        avatar_sha256=uploaded.sha256,
                        mirrored_now=True,
                    )
                )
                mirrored += 1
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
        f"{len(portrait_failures)} portrait failures, {len(missing)} missing"
    )
    return 0 if not missing and not portrait_failures else 2


def load_politicians(database: SupabaseManagementClient) -> list[ExistingPolitician]:
    """Read stable ids and current portrait state for every public politician."""

    response = database.execute_sql(
        "select intressent_id, avatar_url, avatar_source_url, avatar_sha256 "
        "from public.politicians "
        "where nullif(btrim(intressent_id), '') is not null "
        "order by intressent_id;"
    )
    rows = response.get("result")
    if not isinstance(rows, list):
        raise ExternalServiceError("Supabase politician id query returned no result rows")
    politicians: list[ExistingPolitician] = []
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        intressent_id = _optional_text(row.get("intressent_id"))
        if intressent_id is None:
            continue
        politicians.append(
            ExistingPolitician(
                intressent_id=intressent_id,
                avatar_url=_optional_text(row.get("avatar_url")),
                avatar_source_url=_optional_text(row.get("avatar_source_url")),
                avatar_sha256=_optional_text(row.get("avatar_sha256")),
            )
        )
    return politicians


def profile_update_sql(profiles: Sequence[ProfileSyncRow]) -> str:
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
    avatar_source_url text,
    avatar_sha256 text,
    mirrored_now boolean,
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
  avatar_source_url = incoming.avatar_source_url,
  avatar_sha256 = incoming.avatar_sha256,
  avatar_mirrored_at = case
    when incoming.mirrored_now then pg_catalog.now()
    else politician.avatar_mirrored_at
  end,
  riksdagen_data = incoming.riksdagen_data,
  profile_synced_at = pg_catalog.now()
from incoming
where politician.intressent_id = incoming.intressent_id;
""".strip()


def retain_existing_portrait(
    profile: PoliticianProfile,
    existing: ExistingPolitician,
) -> ProfileSyncRow:
    """Keep only a last verified mirror when a source refresh fails.

    A Riksdagen source URL is provenance, not a safe public fallback: the
    failure may be a permanent 404. Returning ``None`` lets the frontend show
    its initials fallback without first making a guaranteed-broken request.
    """

    verified_avatar = (
        existing.avatar_url
        if existing.avatar_sha256 is not None
        and existing.avatar_url is not None
        and not existing.avatar_url.startswith("https://data.riksdagen.se/")
        else None
    )

    return ProfileSyncRow(
        profile=profile,
        avatar_url=verified_avatar,
        avatar_source_url=profile.avatar_url,
        avatar_sha256=existing.avatar_sha256,
        mirrored_now=False,
    )


def bunny_storage_from_settings(settings: Settings) -> BunnyStorageClient:
    """Resolve the same verified Bunny target used by remote clip publishing."""

    if settings.bunny_storage_access_key and settings.bunny_cdn_base_url:
        return BunnyStorageClient(
            storage_zone_name=settings.bunny_storage_zone_name,
            access_key=settings.bunny_storage_access_key,
            cdn_base_url=settings.bunny_cdn_base_url,
            storage_hostname=settings.bunny_storage_hostname or "storage.bunnycdn.com",
            timeout_s=settings.http_timeout_s,
            max_retries=settings.max_http_retries,
        )
    if not settings.bunny_api_key:
        raise ConfigurationError(
            "Portrait mirroring requires RIKET_BUNNY_API_KEY, or direct Bunny "
            "storage access and CDN settings."
        )
    account = BunnyAccountClient(
        api_key=settings.bunny_api_key,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    target = account.provision_storage_target(
        storage_zone_name=settings.bunny_storage_zone_name,
        pull_zone_name=settings.bunny_pull_zone_name,
        region=settings.bunny_storage_region,
    )
    return BunnyStorageClient(
        storage_zone_name=target.storage_zone_name,
        access_key=target.storage_access_key,
        cdn_base_url=target.cdn_base_url,
        storage_hostname=target.storage_hostname,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def chunks(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    """Yield bounded slices without copying the complete input again."""

    for start in range(0, len(items), size):
        yield items[start : start + size]


if __name__ == "__main__":
    raise SystemExit(main())
