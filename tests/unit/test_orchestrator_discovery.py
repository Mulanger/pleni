"""Unit tests for catch-up discovery.

The behaviour under test is the one the local-workstation constraint creates:
the machine is not always on, so discovery must collect everything since it last
looked rather than everything in the last N minutes. A tick-based cron would
lose every debate that happened while the lid was shut, silently.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from src.orchestrator.discovery import (
    discover_and_enqueue,
    watermark_path,
)
from src.riksdagen.discovery import read_watermark

BASE = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)


class FakeRiksdagen:
    """Returns a canned `dokumentlista` payload."""

    def __init__(self, records: Sequence[tuple[str, datetime]]) -> None:
        self.records = records
        self.requests: list[Mapping[str, str]] = []

    def fetch_document_list(self, params: Mapping[str, str]) -> Mapping[str, Any]:
        self.requests.append(dict(params))
        return {
            "dokumentlista": {
                "dokument": [
                    {
                        "dok_id": dokid,
                        "titel": f"Debatt {dokid}",
                        "doktyp": "kam-fs",
                        "publicerad": when.isoformat(),
                        "systemdatum": when.isoformat(),
                    }
                    for dokid, when in self.records
                ]
            }
        }


class RecordingEnqueuer:
    """Accepts jobs and enforces idempotency the way the real queue does."""

    def __init__(self) -> None:
        self.keys: set[str] = set()
        self.calls: list[dict[str, Any]] = []

    def enqueue(self, **kwargs: Any) -> bool:
        self.calls.append(kwargs)
        key = str(kwargs["idempotency_key"])
        if key in self.keys:
            return False
        self.keys.add(key)
        return True

    @property
    def dokids(self) -> list[str]:
        return [str(call["entity_id"]) for call in self.calls]


def _records(
    count: int, *, start: datetime = BASE, offset: int = 0
) -> list[tuple[str, datetime]]:
    """`offset` keeps a later batch's dokids distinct from an earlier one's."""

    return [
        (f"HD{offset + i:04d}", start + timedelta(hours=i)) for i in range(count)
    ]


def test_first_run_enqueues_everything_it_finds(tmp_path: Path) -> None:
    client = FakeRiksdagen(_records(3))
    enqueuer = RecordingEnqueuer()

    result = discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    assert result.found == 3
    assert len(result.enqueued) == 3
    assert enqueuer.dokids == ["HD0000", "HD0001", "HD0002"]


def test_second_run_finds_nothing_new(tmp_path: Path) -> None:
    client = FakeRiksdagen(_records(3))
    enqueuer = RecordingEnqueuer()
    discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    result = discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    assert result.found == 0
    assert result.enqueued == []


def test_a_week_offline_is_collected_on_the_next_run(tmp_path: Path) -> None:
    """The whole point of a watermark over a tick.

    The machine sleeps. Whatever appeared meanwhile must still be found, not
    missed because it fell outside a 30-minute window nobody was awake for.
    """

    client = FakeRiksdagen(_records(2))
    enqueuer = RecordingEnqueuer()
    discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    # Seven days pass with the machine off; Riksdagen publishes five more.
    client.records = _records(2) + _records(5, start=BASE + timedelta(days=7), offset=100)

    result = discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    assert result.found == 5
    assert len(result.enqueued) == 5


def test_losing_the_watermark_cannot_create_duplicates(tmp_path: Path) -> None:
    """The watermark is an optimisation; the idempotency key is the guarantee."""

    client = FakeRiksdagen(_records(3))
    enqueuer = RecordingEnqueuer()
    discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    watermark_path(tmp_path).unlink()
    result = discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    assert result.found == 3
    assert result.enqueued == [], "nothing new was created"
    assert len(result.already_known) == 3


def test_the_cap_defers_rather_than_skips(tmp_path: Path) -> None:
    """A deferred debate must be found again, or the cap becomes a silent skip."""

    client = FakeRiksdagen(_records(10))
    enqueuer = RecordingEnqueuer()

    first = discover_and_enqueue(client, enqueuer, work_dir=tmp_path, max_enqueue=4)  # type: ignore[arg-type]
    assert len(first.enqueued) == 4
    assert len(first.skipped_over_cap) == 6

    second = discover_and_enqueue(client, enqueuer, work_dir=tmp_path, max_enqueue=4)  # type: ignore[arg-type]

    assert len(second.enqueued) == 4, "the deferred debates came back"
    assert enqueuer.dokids[:8] == [f"HD{i:04d}" for i in range(8)]


def test_the_watermark_never_advances_past_deferred_work(tmp_path: Path) -> None:
    client = FakeRiksdagen(_records(10))
    enqueuer = RecordingEnqueuer()

    discover_and_enqueue(client, enqueuer, work_dir=tmp_path, max_enqueue=4)  # type: ignore[arg-type]

    stored = read_watermark(watermark_path(tmp_path))
    assert stored == BASE + timedelta(hours=3), "advanced only to the last offered debate"


def test_dry_run_changes_nothing(tmp_path: Path) -> None:
    client = FakeRiksdagen(_records(3))
    enqueuer = RecordingEnqueuer()

    result = discover_and_enqueue(client, enqueuer, work_dir=tmp_path, dry_run=True)  # type: ignore[arg-type]

    assert len(result.enqueued) == 3
    assert enqueuer.calls == []
    assert not watermark_path(tmp_path).exists()


def test_a_full_page_of_all_new_records_flags_a_possible_gap(tmp_path: Path) -> None:
    """A long outage can push older debates off the end of the first page.

    Reported rather than guessed at: a silent gap in a political archive is
    worse than a loud one.
    """

    client = FakeRiksdagen(_records(2))
    enqueuer = RecordingEnqueuer()
    discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    # A full page, every record newer than the watermark.
    client.records = _records(5, start=BASE + timedelta(days=30), offset=100)
    result = discover_and_enqueue(  # type: ignore[arg-type]
        client, enqueuer, work_dir=tmp_path, page_size=5, max_enqueue=99
    )

    assert result.possible_gap is True
    assert "POSSIBLE GAP" in result.summary()


def test_a_partial_page_is_not_a_gap(tmp_path: Path) -> None:
    client = FakeRiksdagen(_records(2))
    enqueuer = RecordingEnqueuer()
    discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    client.records = _records(2) + _records(1, start=BASE + timedelta(days=1), offset=100)
    result = discover_and_enqueue(  # type: ignore[arg-type]
        client, enqueuer, work_dir=tmp_path, page_size=100
    )

    assert result.possible_gap is False


def test_enqueued_jobs_carry_the_debate_title(tmp_path: Path) -> None:
    """So `pipeline status` is readable without joining back to Riksdagen."""

    client = FakeRiksdagen(_records(1))
    enqueuer = RecordingEnqueuer()

    discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    payload = enqueuer.calls[0]["payload"]
    assert payload["title"] == "Debatt HD0000"
    assert payload["document_type"] == "kam-fs"


def test_discovery_starts_the_chain_at_the_first_stage(tmp_path: Path) -> None:
    client = FakeRiksdagen(_records(1))
    enqueuer = RecordingEnqueuer()

    discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]

    call = enqueuer.calls[0]
    assert call["kind"] == "discover"
    assert call["idempotency_key"] == "discover:HD0000:v1"
    assert call["pool"] == "io"


# -- bounded historical backfill -----------------------------------------


class WindowRiksdagen(FakeRiksdagen):
    """Records the query params so the date window can be asserted."""

    def fetch_document_list(self, params: Mapping[str, str]) -> Mapping[str, Any]:
        self.requests.append(dict(params))
        return super().fetch_document_list(params)


def test_backfill_never_touches_the_watermark(tmp_path: Path) -> None:
    """Backfill is bounded and historical; discovery is the forward loop.

    Sharing state is how backfilling January silently makes the daemon skip
    August.
    """

    from datetime import date

    from src.orchestrator.discovery import backfill_window

    client = WindowRiksdagen(_records(3))
    enqueuer = RecordingEnqueuer()
    discover_and_enqueue(client, enqueuer, work_dir=tmp_path)  # type: ignore[arg-type]
    before = read_watermark(watermark_path(tmp_path))

    backfill_window(  # type: ignore[arg-type]
        client, enqueuer, since=date(2024, 1, 1), until=date(2024, 2, 1)
    )

    assert read_watermark(watermark_path(tmp_path)) == before


def test_backfill_asks_for_a_half_open_window(tmp_path: Path) -> None:
    """`--to` is exclusive, so consecutive months cannot double-count a day."""

    from datetime import date

    from src.orchestrator.discovery import backfill_window

    client = WindowRiksdagen([])
    backfill_window(  # type: ignore[arg-type]
        client, RecordingEnqueuer(), since=date(2026, 3, 1), until=date(2026, 4, 1)
    )

    assert client.requests[0]["from"] == "2026-03-01"
    assert client.requests[0]["tom"] == "2026-03-31"


def test_backfill_queues_behind_fresh_work(tmp_path: Path) -> None:
    """A debate from this morning must outrank an archive of 2024."""

    from datetime import date

    from src.orchestrator.discovery import backfill_window

    enqueuer = RecordingEnqueuer()
    backfill_window(  # type: ignore[arg-type]
        WindowRiksdagen(_records(2)), enqueuer, since=date(2024, 1, 1), until=date(2024, 2, 1)
    )

    assert all(call["priority"] < 0 for call in enqueuer.calls)
    assert all(call["payload"]["backfill"] is True for call in enqueuer.calls)


def test_overlapping_backfill_windows_cannot_double_process(tmp_path: Path) -> None:
    from datetime import date

    from src.orchestrator.discovery import backfill_window

    client = WindowRiksdagen(_records(3))
    enqueuer = RecordingEnqueuer()

    first = backfill_window(  # type: ignore[arg-type]
        client, enqueuer, since=date(2026, 1, 1), until=date(2026, 2, 1)
    )
    second = backfill_window(  # type: ignore[arg-type]
        client, enqueuer, since=date(2026, 1, 15), until=date(2026, 2, 15)
    )

    assert len(first.enqueued) == 3
    assert second.enqueued == []
    assert len(second.already_known) == 3


def test_backfill_covers_every_chosen_doktype() -> None:
    """The whitelist decided on 2026-08-03, verified clippable through C1."""

    from src.riksdagen.discovery import DEFAULT_DISCOVERY_DOKTYPES

    assert set(DEFAULT_DISCOVERY_DOKTYPES) == {"ip", "kam-fs", "kam-sd", "kam-ad"}
    # kam-vo is 8,047 voting sessions with nothing to clip; kam-ip and kam-al
    # are session-level wrappers with no speaker list.
    assert "kam-vo" not in DEFAULT_DISCOVERY_DOKTYPES
    assert "kam-ip" not in DEFAULT_DISCOVERY_DOKTYPES
