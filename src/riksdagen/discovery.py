"""Discovery helpers for Riksdagen video documents."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import cast

from src.riksdagen.client import RiksdagenClient
from src.riksdagen.parser import RiksdagenParseError

DEFAULT_DISCOVERY_DOKTYPES = ("kam-fs",)


@dataclass(frozen=True)
class DiscoveryRecord:
    """One candidate Riksdagen video document discovered from open data."""

    dokid: str
    title: str
    document_type: str
    published_at: datetime
    system_date: datetime


def discover_since(
    client: RiksdagenClient,
    watermark: datetime | None,
    *,
    doktypes: Sequence[str] = DEFAULT_DISCOVERY_DOKTYPES,
    page_size: int = 100,
) -> tuple[DiscoveryRecord, ...]:
    """Discover documents newer than a stored watermark."""

    records: list[DiscoveryRecord] = []
    for doktyp in doktypes:
        payload = client.fetch_document_list(
            {"doktyp": doktyp, "utformat": "json", "sz": str(page_size)}
        )
        records.extend(parse_document_list(payload))
    return filter_records_since(records, watermark)


def parse_document_list(payload: Mapping[str, object]) -> tuple[DiscoveryRecord, ...]:
    """Parse a `dokumentlista` response."""

    container = payload.get("dokumentlista")
    if not isinstance(container, Mapping):
        raise RiksdagenParseError("Document list response is missing dokumentlista")
    raw_documents = _listify(container.get("dokument"))
    records: list[DiscoveryRecord] = []
    for raw_document in raw_documents:
        if not isinstance(raw_document, Mapping):
            continue
        document = cast(Mapping[str, object], raw_document)
        dokid = _optional_str(document.get("dok_id"))
        title = _optional_str(document.get("titel"))
        document_type = _optional_str(document.get("doktyp"))
        published = _optional_str(document.get("publicerad")) or _optional_str(
            document.get("datum")
        )
        system_date = _optional_str(document.get("systemdatum")) or published
        if (
            dokid is None
            or title is None
            or document_type is None
            or published is None
            or system_date is None
        ):
            continue
        records.append(
            DiscoveryRecord(
                dokid=dokid,
                title=title,
                document_type=document_type,
                published_at=parse_riksdagen_datetime(published),
                system_date=parse_riksdagen_datetime(system_date),
            )
        )
    return tuple(records)


def filter_records_since(
    records: Iterable[DiscoveryRecord], watermark: datetime | None
) -> tuple[DiscoveryRecord, ...]:
    """Deduplicate records and return every item strictly newer than `watermark`."""

    deduped: dict[str, DiscoveryRecord] = {}
    for record in records:
        existing = deduped.get(record.dokid)
        if existing is None or record.system_date > existing.system_date:
            deduped[record.dokid] = record

    filtered = [
        record for record in deduped.values() if watermark is None or record.system_date > watermark
    ]
    return tuple(sorted(filtered, key=lambda record: (record.system_date, record.dokid)))


def next_watermark(records: Iterable[DiscoveryRecord], current: datetime | None) -> datetime | None:
    """Return the watermark to store after processing discovered records."""

    watermark = current
    for record in records:
        if watermark is None or record.system_date > watermark:
            watermark = record.system_date
    return watermark


def read_watermark(path: Path) -> datetime | None:
    """Read an ISO-8601 watermark file if it exists."""

    if not path.exists():
        return None
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        return None
    return parse_riksdagen_datetime(value)


def write_watermark(path: Path, watermark: datetime | None) -> None:
    """Write an ISO-8601 watermark file."""

    if watermark is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(watermark.isoformat() + "\n", encoding="utf-8")


def parse_riksdagen_datetime(value: str) -> datetime:
    """Parse date strings used by Riksdagen open-data endpoints."""

    normalized = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        pass

    if len(value) >= 19:
        try:
            return datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
    if len(value) >= 10:
        try:
            return datetime.strptime(value[:10], "%Y-%m-%d")
        except ValueError:
            pass
    raise RiksdagenParseError(f"Invalid Riksdagen datetime: {value}")


def _listify(value: object) -> tuple[object, ...]:
    if value is None:
        return ()
    if isinstance(value, Mapping):
        return (value,)
    if isinstance(value, Sequence) and not isinstance(value, str | bytes):
        return tuple(value)
    return ()


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
