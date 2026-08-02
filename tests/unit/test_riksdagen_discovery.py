"""Tests for Riksdagen discovery and watermark logic."""

from __future__ import annotations

from datetime import datetime

from src.riksdagen.discovery import (
    DiscoveryRecord,
    filter_records_since,
    next_watermark,
    parse_document_list,
    parse_riksdagen_datetime,
)


def record(dokid: str, system_date: str) -> DiscoveryRecord:
    parsed = parse_riksdagen_datetime(system_date)
    return DiscoveryRecord(
        dokid=dokid,
        title=f"Title {dokid}",
        document_type="kam-fs",
        published_at=parsed,
        system_date=parsed,
    )


def test_parse_document_list_handles_single_and_duplicate_documents() -> None:
    payload = {
        "dokumentlista": {
            "dokument": [
                {
                    "dok_id": "A",
                    "titel": "Frågestund",
                    "doktyp": "kam-fs",
                    "publicerad": "2026-06-11",
                    "systemdatum": "2026-06-29 10:20:22",
                },
                {
                    "dok_id": "A",
                    "titel": "Frågestund",
                    "doktyp": "kam-fs",
                    "publicerad": "2026-06-11",
                    "systemdatum": "2026-06-29 10:20:23",
                },
            ]
        }
    }

    parsed = parse_document_list(payload)
    filtered = filter_records_since(parsed, None)

    assert len(filtered) == 1
    assert filtered[0].dokid == "A"
    assert filtered[0].system_date.second == 23


def test_filter_records_since_has_no_duplicates_or_gaps() -> None:
    watermark = datetime(2026, 6, 1, 0, 0, 0)
    records = [
        record("B", "2026-06-03 09:00:00"),
        record("A", "2026-06-02 09:00:00"),
        record("A", "2026-06-02 09:05:00"),
        record("OLD", "2026-05-31 09:00:00"),
    ]

    filtered = filter_records_since(records, watermark)

    assert [item.dokid for item in filtered] == ["A", "B"]
    assert filtered[0].system_date.minute == 5


def test_next_watermark_preserves_current_when_no_records() -> None:
    current = datetime(2026, 6, 1, 0, 0, 0)

    assert next_watermark([], current) == current


def test_next_watermark_advances_to_latest_record() -> None:
    current = datetime(2026, 6, 1, 0, 0, 0)

    assert next_watermark([record("A", "2026-06-02 09:00:00")], current) == datetime(
        2026, 6, 2, 9, 0, 0
    )
