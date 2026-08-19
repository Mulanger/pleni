"""Mirror all eight official Riksdag party logos into Pleni's verified CDN.

Usage:

    python scripts/sync_party_logos.py --dry-run
    python scripts/sync_party_logos.py
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import get_settings  # noqa: E402
from src.errors import ExternalServiceError  # noqa: E402
from src.publish.supabase import sql_jsonb_literal  # noqa: E402
from src.riksdagen.client import RiksdagenClient  # noqa: E402
from src.riksdagen.party_logos import (  # noqa: E402
    PARTY_LOGO_SOURCES,
    MirroredPartyLogo,
    PartyLogoImage,
    download_party_logo,
    upload_party_logo,
)
from src.riksdagen.profile_sync import (  # noqa: E402
    bunny_storage_from_settings,
    database_from_settings,
)


class PartyLogoDatabase(Protocol):
    """Database boundary required by the party-logo sync."""

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        """Execute one bounded SQL statement."""


def party_logo_update_sql(logos: Sequence[MirroredPartyLogo]) -> str:
    """Build one atomic update after every CDN object has verified."""

    payload = [
        {
            "code": logo.code,
            "logo_url": logo.cdn_url,
            "logo_source_url": logo.source_url,
            "logo_sha256": logo.sha256,
        }
        for logo in logos
    ]
    return f"""
with incoming as (
  select *
  from jsonb_to_recordset({sql_jsonb_literal(payload)}) as p(
    code text,
    logo_url text,
    logo_source_url text,
    logo_sha256 text
  )
), updated as (
  update public.party_profiles as party
  set
    logo_url = incoming.logo_url,
    logo_source_url = incoming.logo_source_url,
    logo_sha256 = incoming.logo_sha256,
    logo_mirrored_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
  from incoming
  where party.code = incoming.code
  returning party.code
)
select count(*)::integer as updated_count from updated;
""".strip()


def require_complete_update(response: Mapping[str, Any], *, expected: int) -> None:
    """Refuse to report success unless the atomic update touched every party."""

    rows = response.get("result")
    if not isinstance(rows, list) or len(rows) != 1:
        raise ExternalServiceError("Supabase party-logo update returned no count")
    row = rows[0]
    if not isinstance(row, Mapping) or row.get("updated_count") != expected:
        raise ExternalServiceError(
            f"Supabase updated {row.get('updated_count') if isinstance(row, Mapping) else 0} "
            f"party logos; expected {expected}"
        )


def main(argv: list[str] | None = None) -> int:
    """Validate every source, then mirror and persist the complete set."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Download and validate every source without uploading or writing.",
    )
    args = parser.parse_args(argv)

    settings = get_settings()
    riksdagen = RiksdagenClient(
        user_agent=settings.riksdagen_user_agent,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )

    images: list[PartyLogoImage] = []
    for source in PARTY_LOGO_SOURCES:
        image = download_party_logo(riksdagen, source)
        images.append(image)
        print(
            f"validated {source.code}: {image.width}x{image.height}, "
            f"{len(image.body)} bytes, sha256={image.sha256}"
        )

    if args.dry_run:
        print(f"complete: {len(images)} validated, uploads: 0, writes: 0")
        return 0

    storage = bunny_storage_from_settings(settings)
    mirrored = [upload_party_logo(storage, image) for image in images]
    if len(mirrored) != len(PARTY_LOGO_SOURCES):
        raise RuntimeError("Party logo sync did not verify all canonical sources")

    database = database_from_settings(settings)
    response = database.execute_sql(party_logo_update_sql(mirrored))
    require_complete_update(response, expected=len(PARTY_LOGO_SOURCES))
    for logo in mirrored:
        print(f"mirrored {logo.code}: {logo.cdn_url}")
    print(f"complete: {len(mirrored)} mirrored and persisted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
