"""Reliable, targeted politician-profile and portrait synchronization.

Riksdagen's person record is the source of profile metadata. Portraits are
served only after the official JPEG has passed validation and the immutable,
content-addressed Bunny object has passed the uploader's verification path.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from src.config import Settings, get_settings
from src.errors import ConfigurationError, ExternalServiceError
from src.publish.bunny import BunnyAccountClient, BunnyStorageClient
from src.publish.supabase import SupabaseManagementClient, sql_jsonb_literal
from src.riksdagen.client import RiksdagenClient, RiksdagenHTTPError
from src.riksdagen.portraits import PortraitStorage, download_portrait, upload_portrait
from src.riksdagen.profiles import PoliticianProfile, profile_from_person

PORTRAIT_MIRRORED = "mirrored"
PORTRAIT_REUSED = "reused"
PORTRAIT_ABSENT = "absent"
PortraitStorageProvider = PortraitStorage | Callable[[], PortraitStorage]


class ProfileDatabase(Protocol):
    """Database boundary required by a profile sync."""

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        """Execute one bounded SQL statement."""


class ProfileClient(Protocol):
    """Riksdagen boundaries required by a profile sync."""

    def fetch_person_by_id(self, intressent_id: str) -> Mapping[str, object] | None:
        """Fetch one complete person record."""

    def get(self, url: str, *, accept: str = "application/json") -> Any:
        """Fetch the official portrait."""


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


@dataclass(frozen=True)
class ProfileSyncResult:
    """The row and portrait disposition produced by one successful sync."""

    row: ProfileSyncRow
    portrait_status: str


def sync_politician_profile(
    intressent_id: str,
    *,
    work_dir: Path | str,
) -> None:
    """Synchronize one politician for an orchestrator profile job.

    ``work_dir`` is accepted because every orchestrator job handler shares that
    interface. Profile state is remote-only, so this handler writes no artifact.
    All transient source, upload and database failures deliberately propagate so
    the queue can retry the targeted id.
    """

    _ = work_dir
    settings = get_settings()
    database = database_from_settings(settings)
    riksdagen = RiksdagenClient(
        user_agent=settings.riksdagen_user_agent,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    sync_one_politician(
        intressent_id,
        database=database,
        riksdagen=riksdagen,
        storage=lambda: bunny_storage_from_settings(settings),
    )


def sync_one_politician(
    intressent_id: str,
    *,
    database: ProfileDatabase,
    riksdagen: ProfileClient,
    storage: PortraitStorageProvider,
) -> ProfileSyncResult:
    """Fetch, mirror and persist exactly one politician.

    This dependency-injected form is the testable core used by the public job
    handler. Expected portrait absence still writes fresh profile metadata and
    ``profile_synced_at``; it is not a failed sync.
    """

    existing = load_politician(database, intressent_id)
    person = riksdagen.fetch_person_by_id(intressent_id)
    if person is None:
        raise ExternalServiceError(
            f"Riksdagen returned no person record for {intressent_id}"
        )
    profile = profile_from_person(person, expected_intressent_id=intressent_id)
    result = prepare_profile_sync(profile, existing, riksdagen=riksdagen, storage=storage)
    database.execute_sql(profile_update_sql([result.row]))
    return result


def prepare_profile_sync(
    profile: PoliticianProfile,
    existing: ExistingPolitician,
    *,
    riksdagen: ProfileClient,
    storage: PortraitStorageProvider,
) -> ProfileSyncResult:
    """Choose a verified mirror (or expected absence) for one fetched profile."""

    if person_explicitly_has_no_portrait(profile.riksdagen_data):
        return ProfileSyncResult(
            row=retain_existing_portrait(profile, existing),
            portrait_status=PORTRAIT_ABSENT,
        )

    try:
        image = download_portrait(riksdagen, profile.avatar_url)
    except RiksdagenHTTPError as exc:
        if exc.status_code != 404:
            raise
        return ProfileSyncResult(
            row=retain_existing_portrait(profile, existing),
            portrait_status=PORTRAIT_ABSENT,
        )

    # Always use the uploader, including for an unchanged digest. It verifies
    # the content-addressed object rather than trusting stale database state.
    resolved_storage = storage() if callable(storage) else storage
    uploaded = upload_portrait(
        resolved_storage,
        intressent_id=profile.intressent_id,
        image=image,
    )
    reused = (
        existing.avatar_sha256 == uploaded.sha256
        and existing.avatar_url == uploaded.cdn_url
    )
    return ProfileSyncResult(
        row=ProfileSyncRow(
            profile=profile,
            avatar_url=uploaded.cdn_url,
            avatar_source_url=profile.avatar_url,
            avatar_sha256=uploaded.sha256,
            mirrored_now=not reused,
        ),
        portrait_status=PORTRAIT_REUSED if reused else PORTRAIT_MIRRORED,
    )


def person_explicitly_has_no_portrait(person: Mapping[str, object]) -> bool:
    """Read Riksdagen's nested ``HarBild=false`` marker when it is present.

    Unknown or malformed metadata intentionally returns ``False`` so the
    official portrait endpoint remains the authority and is still attempted.
    """

    person_details = person.get("personuppgift")
    if not isinstance(person_details, Mapping):
        return False
    raw_entries = person_details.get("uppgift")
    if isinstance(raw_entries, Mapping):
        entries: Sequence[object] = [raw_entries]
    elif isinstance(raw_entries, list):
        entries = raw_entries
    else:
        return False

    for raw_entry in entries:
        if not isinstance(raw_entry, Mapping):
            continue
        if str(raw_entry.get("kod") or "").strip().casefold() != "harbild":
            continue
        raw_value = raw_entry.get("uppgift")
        if isinstance(raw_value, list):
            values: Sequence[object] = raw_value
        else:
            values = [raw_value]
        if any(str(value).strip().casefold() == "false" for value in values):
            return True
    return False


def load_politician(
    database: ProfileDatabase,
    intressent_id: str,
) -> ExistingPolitician:
    """Read the current portrait state for exactly one politician."""

    id_json = sql_jsonb_literal(intressent_id)
    response = database.execute_sql(
        "select intressent_id, avatar_url, avatar_source_url, avatar_sha256 "
        "from public.politicians "
        f"where intressent_id = ({id_json} #>> '{{}}') "
        "limit 1;"
    )
    rows = _politicians_from_response(response)
    if not rows:
        raise ExternalServiceError(
            f"Supabase returned no politician row for {intressent_id}"
        )
    return rows[0]


def load_politicians(database: ProfileDatabase) -> list[ExistingPolitician]:
    """Read stable ids and current portrait state for every public politician."""

    response = database.execute_sql(
        "select intressent_id, avatar_url, avatar_source_url, avatar_sha256 "
        "from public.politicians "
        "where nullif(btrim(intressent_id), '') is not null "
        "order by intressent_id;"
    )
    return _politicians_from_response(response)


def _politicians_from_response(
    response: Mapping[str, Any],
) -> list[ExistingPolitician]:
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
    """Keep only a last verified mirror when a portrait cannot be refreshed."""

    verified_avatar = (
        existing.avatar_url
        if existing.avatar_sha256 is not None
        and existing.avatar_url is not None
        and not existing.avatar_url.startswith("https://data.riksdagen.se/")
        else None
    )
    verified_hash = existing.avatar_sha256 if verified_avatar is not None else None
    return ProfileSyncRow(
        profile=profile,
        avatar_url=verified_avatar,
        avatar_source_url=profile.avatar_url,
        avatar_sha256=verified_hash,
        mirrored_now=False,
    )


def database_from_settings(settings: Settings) -> SupabaseManagementClient:
    """Build the profile database client from private worker settings."""

    if not settings.supabase_project_ref or not settings.supabase_access_token:
        raise ConfigurationError(
            "Set RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN "
            "before syncing politician profiles."
        )
    return SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
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
