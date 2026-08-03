"""Poll Riksdagen for new debates and enqueue them.

C12's last missing piece. Until this existed, "unattended" meant "unattended
once a human typed `enqueue`", and nothing accumulated while nobody was looking.

**This runs on a workstation, not in the cloud**, because the pipeline needs the
local GPU and ffmpeg. That is not an implementation detail — it is the single
constraint that shapes this module:

- **The machine is not always on.** It sleeps, reboots, and gets closed for the
  weekend. A tick-based cron ("look at the last 30 minutes") would silently lose
  every debate that happened while the lid was shut.
- So discovery is **catch-up, not tick-based**. It asks "what is newer than the
  last thing I saw?" via a stored watermark. Off for a week, the next run
  collects the week.
- **The watermark is an optimisation, not the correctness mechanism.** Delete it
  and the worst case is re-offering debates that are already known; every
  enqueue is idempotent on `discover:<dokid>:v1`, so duplicates cannot be
  created. Correctness lives in the unique constraint, which is where it should
  live.

One genuine failure mode is handled explicitly: Riksdagen's document list is
paginated, and a long enough outage can push older debates off the end of the
first page. When the oldest record returned is *still* newer than the watermark,
the page did not reach far enough back and there may be a gap. That is reported
rather than guessed at, because a silent gap in a political archive is worse than
a loud one.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from src.orchestrator.jobs import Enqueuer, enqueue_debate
from src.riksdagen.client import RiksdagenClient
from src.riksdagen.discovery import (
    DEFAULT_DISCOVERY_DOKTYPES,
    DiscoveryRecord,
    discover_since,
    next_watermark,
    read_watermark,
    write_watermark,
)

#: Safety valve. A lost watermark makes the first run offer everything the
#: document list returns; without a cap that could be a hundred debates at once,
#: each of which is hours of GPU time on one workstation.
DEFAULT_MAX_ENQUEUE = 25

#: Where the watermark lives, relative to the work dir. Alongside the artifacts
#: rather than in the database: it is local scheduling state for a local
#: machine, and losing it costs nothing.
WATERMARK_FILENAME = "discovery_watermark.txt"


@dataclass
class DiscoveryResult:
    """What one discovery pass found and did."""

    found: int = 0
    enqueued: list[str] = field(default_factory=list)
    already_known: list[str] = field(default_factory=list)
    skipped_over_cap: list[str] = field(default_factory=list)
    watermark: datetime | None = None
    possible_gap: bool = False

    def summary(self) -> str:
        """One line for a log or a console."""

        parts = [f"found {self.found}", f"enqueued {len(self.enqueued)}"]
        if self.already_known:
            parts.append(f"known {len(self.already_known)}")
        if self.skipped_over_cap:
            parts.append(f"deferred {len(self.skipped_over_cap)}")
        if self.possible_gap:
            parts.append("POSSIBLE GAP — see logs")
        return ", ".join(parts)


def watermark_path(work_dir: Path) -> Path:
    """Where the discovery watermark is stored for this work dir."""

    return Path(work_dir) / WATERMARK_FILENAME


def seed_watermark(work_dir: Path, since: datetime) -> Path:
    """Set the watermark so discovery ignores everything published before `since`.

    Without this, the first run on a fresh machine sees Riksdagen's whole
    document list — currently ~50 Frågestund debates going back to 2024 — and
    starts working through the archive. That is a legitimate thing to want:
    back catalogue is the fastest route to the `Q-1` inventory threshold, and
    the freshness SLO already excludes old debates by filtering on
    `debate_date`, so backfill cannot make the pipeline look fast.

    It is also hours of GPU time per debate on one workstation, so it should be
    a decision somebody made rather than the default that happened.
    """

    path = watermark_path(work_dir)
    write_watermark(path, since)
    return path


def discover_and_enqueue(
    client: RiksdagenClient,
    enqueuer: Enqueuer,
    *,
    work_dir: Path,
    doktypes: Sequence[str] = DEFAULT_DISCOVERY_DOKTYPES,
    max_enqueue: int = DEFAULT_MAX_ENQUEUE,
    page_size: int = 100,
    dry_run: bool = False,
) -> DiscoveryResult:
    """Run one discovery pass: find new debates, enqueue them, advance the watermark.

    Idempotent. Running it twice in a row enqueues nothing the second time, both
    because the watermark has advanced and, independently, because the
    idempotency key already exists.
    """

    path = watermark_path(work_dir)
    watermark = read_watermark(path)
    records = discover_since(client, watermark, doktypes=doktypes, page_size=page_size)

    result = DiscoveryResult(found=len(records), watermark=watermark)
    result.possible_gap = _page_may_have_missed_older_debates(records, watermark, page_size)

    for record in records[:max_enqueue]:
        if dry_run:
            result.enqueued.append(record.dokid)
            continue
        created = enqueue_debate(
            enqueuer,
            record.dokid,
            payload={"title": record.title, "document_type": record.document_type},
        )
        (result.enqueued if created else result.already_known).append(record.dokid)

    result.skipped_over_cap = [record.dokid for record in records[max_enqueue:]]

    if dry_run:
        return result

    # Only advance past what was actually offered. A debate deferred by the cap
    # must still be found on the next pass, or the cap would quietly become a
    # permanent skip.
    processed = records[: max_enqueue if result.skipped_over_cap else len(records)]
    result.watermark = next_watermark(processed, watermark)
    write_watermark(path, result.watermark)
    return result


def build_client(
    *,
    user_agent: str,
    timeout_s: float,
    max_retries: int,
    min_interval_s: float = 1.0,
) -> RiksdagenClient:
    """Construct a deliberately polite Riksdagen client.

    `min_interval_s` defaults to a full second. Discovery runs unattended against
    a public service funded by the people it is about; being a rude client is
    both bad manners and the fastest way to get blocked.
    """

    return RiksdagenClient(
        user_agent=user_agent,
        timeout_s=timeout_s,
        max_retries=max_retries,
        min_interval_s=min_interval_s,
    )


def _page_may_have_missed_older_debates(
    records: Sequence[DiscoveryRecord],
    watermark: datetime | None,
    page_size: int,
) -> bool:
    """True when the document list may not have reached back to the watermark.

    `discover_since` fetches one page per doktype. If it came back full *and*
    every record on it is newer than the watermark, then older-but-still-unseen
    debates may sit on a page nobody asked for.
    """

    if watermark is None or not records:
        return False
    if len(records) < page_size:
        return False
    return min(record.system_date for record in records) > watermark
