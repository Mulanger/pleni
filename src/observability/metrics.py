"""C13 metrics: is the pipeline healthy, is it fresh, and who is it showing?

Four question families, each a prerequisite in its own right:

- `stage_timings()`     — P1-3. Where does the time go, and is it drifting?
- `stage_failures()`    — P1-3. What breaks, how often, with what error?
- `freshness()`         — P1-5. Debate happened → clip watchable. The SLO.
- `party_distribution()` — P1-4. Clips per party over a trailing window.

The last one is built now, while it is cheap, because it is the guardrail the
recommender will need later and it is much easier to add before there is a
ranker to blame. `docs/ARCHITECTURE.md` §R5 asks for it regardless of whether
anyone acts on the number, and that is the right instinct: measuring exposure is
not the same as engineering it.

Everything is a read-only SQL query returning plain dataclasses. Nothing here
mutates, so it is safe to point at production, which is the only place the
numbers mean anything.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol


class SqlExecutor(Protocol):
    """Anything that can run one SQL statement batch against the project."""

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        """Execute SQL and return the decoded response."""


@dataclass(frozen=True)
class StageTiming:
    """How long one stage takes, over a trailing window."""

    kind: str
    runs: int
    p50_ms: int
    p95_ms: int
    max_ms: int

    @property
    def p95_s(self) -> float:
        return round(self.p95_ms / 1000, 1)


@dataclass(frozen=True)
class StageFailure:
    """How often one stage fails, and the most recent reason."""

    kind: str
    runs: int
    failures: int
    dead: int
    last_error: str | None

    @property
    def failure_rate(self) -> float:
        """Share of attempts that did not complete, 0.0-1.0."""

        return round(self.failures / self.runs, 3) if self.runs else 0.0


@dataclass(frozen=True)
class FreshnessSample:
    """One debate's journey from happening to being watchable."""

    dokid: str
    title: str
    debate_date: str
    first_published_at: str | None
    lag_hours: float | None


@dataclass(frozen=True)
class FreshnessSLO:
    """P1-5. Until this number exists, `fresh` is not something a ranker can reason about."""

    debates: int
    published: int
    p50_lag_hours: float | None
    p95_lag_hours: float | None
    worst_lag_hours: float | None
    slowest: Sequence[FreshnessSample]

    @property
    def publish_rate(self) -> float:
        """Share of known debates that produced at least one clip."""

        return round(self.published / self.debates, 3) if self.debates else 0.0


@dataclass(frozen=True)
class PartyShare:
    """Exposure for one party over the window."""

    party: str
    clips: int
    speakers: int
    share: float


def stage_timings(executor: SqlExecutor, *, days: int = 7) -> list[StageTiming]:
    """Per-stage duration percentiles over a trailing window (P1-3).

    Only completed runs: a job that died after 3 seconds would otherwise drag
    the median down and make a broken stage look fast.
    """

    rows = _rows(
        executor.execute_sql(
            "select kind, count(*)::int as runs, "
            "  percentile_disc(0.5) within group (order by duration_ms)::bigint as p50, "
            "  percentile_disc(0.95) within group (order by duration_ms)::bigint as p95, "
            "  max(duration_ms)::bigint as worst "
            "from public.job_runs "
            f"where outcome = 'complete' and duration_ms is not null "
            f"  and finished_at > now() - interval '{int(days)} days' "
            "group by kind order by p95 desc nulls last;"
        )
    )
    return [
        StageTiming(
            kind=str(row["kind"]),
            runs=_int(row.get("runs")),
            p50_ms=_int(row.get("p50")),
            p95_ms=_int(row.get("p95")),
            max_ms=_int(row.get("worst")),
        )
        for row in rows
    ]


def stage_failures(executor: SqlExecutor, *, days: int = 7) -> list[StageFailure]:
    """Failure rate per stage over a trailing window (P1-3).

    `reaped` counts as a failure. A worker that died mid-job did not succeed,
    and excluding it would hide exactly the failures nobody reported.
    """

    rows = _rows(
        executor.execute_sql(
            "select kind, count(*)::int as runs, "
            "  count(*) filter (where outcome <> 'complete')::int as failures, "
            "  count(*) filter (where outcome = 'dead')::int as dead, "
            "  (array_agg(error order by finished_at desc) "
            "     filter (where error is not null))[1] as last_error "
            "from public.job_runs "
            f"where finished_at > now() - interval '{int(days)} days' "
            "group by kind order by failures desc, kind;"
        )
    )
    return [
        StageFailure(
            kind=str(row["kind"]),
            runs=_int(row.get("runs")),
            failures=_int(row.get("failures")),
            dead=_int(row.get("dead")),
            last_error=_optional_str(row.get("last_error")),
        )
        for row in rows
    ]


def freshness(executor: SqlExecutor, *, days: int = 30, slowest: int = 5) -> FreshnessSLO:
    """The freshness SLO: debate date → first clip published (P1-5).

    **Caveat that belongs in the number, not a footnote.** `sources.debate_date`
    is a DATE, so the lag is measured from midnight on the day of the debate,
    not from when the video actually became downloadable. That systematically
    overstates lag by up to a day and cannot be fixed by arithmetic — it needs
    Riksdagen's publication timestamp captured at C1. Until then, treat this as
    an upper bound and compare it against itself over time rather than against
    an absolute target.

    Backfilled debates are excluded: a 2024 debate published today would report
    a two-year lag and destroy the percentile. `Q-4` makes the same distinction
    for ranking — `debate_date` is the age of the politics, `published_at` is
    only availability.
    """

    window = f"s.debate_date > (now() - interval '{int(days)} days')::date"
    rows = _rows(
        executor.execute_sql(
            "with first_clip as ("
            "  select sp.source_id, min(c.published_at) as published_at "
            "  from public.clips c "
            "  join public.speeches sp on sp.id = c.speech_id "
            "  where c.published_at is not null "
            "  group by sp.source_id"
            ") "
            "select count(*)::int as debates, "
            "  count(f.published_at)::int as published, "
            "  percentile_disc(0.5) within group ("
            "    order by extract(epoch from (f.published_at - s.debate_date)) / 3600"
            "  ) as p50, "
            "  percentile_disc(0.95) within group ("
            "    order by extract(epoch from (f.published_at - s.debate_date)) / 3600"
            "  ) as p95, "
            "  max(extract(epoch from (f.published_at - s.debate_date)) / 3600) as worst "
            "from public.sources s "
            "left join first_clip f on f.source_id = s.id "
            f"where {window};"
        )
    )
    row = rows[0] if rows else {}

    samples = _rows(
        executor.execute_sql(
            "with first_clip as ("
            "  select sp.source_id, min(c.published_at) as published_at "
            "  from public.clips c "
            "  join public.speeches sp on sp.id = c.speech_id "
            "  where c.published_at is not null "
            "  group by sp.source_id"
            ") "
            "select s.dokid, s.title, s.debate_date::text as debate_date, "
            "  f.published_at::text as published_at, "
            "  extract(epoch from (f.published_at - s.debate_date)) / 3600 as lag_hours "
            "from public.sources s "
            "left join first_clip f on f.source_id = s.id "
            f"where {window} "
            "order by lag_hours desc nulls first "
            f"limit {int(slowest)};"
        )
    )

    return FreshnessSLO(
        debates=_int(row.get("debates")),
        published=_int(row.get("published")),
        p50_lag_hours=_round(row.get("p50")),
        p95_lag_hours=_round(row.get("p95")),
        worst_lag_hours=_round(row.get("worst")),
        slowest=[
            FreshnessSample(
                dokid=str(sample.get("dokid")),
                title=str(sample.get("title") or ""),
                debate_date=str(sample.get("debate_date") or ""),
                first_published_at=_optional_str(sample.get("published_at")),
                lag_hours=_round(sample.get("lag_hours")),
            )
            for sample in samples
        ],
    )


def party_distribution(executor: SqlExecutor, *, days: int = 7) -> list[PartyShare]:
    """Clips per party over a trailing window (P1-4, ARCHITECTURE §R5).

    Reported, not enforced. Whether the goal is equal exposure, proportional
    exposure, user-controlled or measurement only is `F0-13`, and it is a
    product decision rather than something to bury in a scoring function.
    Having the number first is what makes that decision an informed one.
    """

    rows = _rows(
        executor.execute_sql(
            "select coalesce(nullif(sp.party, ''), 'okänt') as party, "
            "  count(*)::int as clips, "
            "  count(distinct sp.speaker_name)::int as speakers "
            "from public.clips c "
            "join public.speeches sp on sp.id = c.speech_id "
            "where c.published_at is not null "
            f"  and c.published_at > now() - interval '{int(days)} days' "
            "group by 1 order by clips desc;"
        )
    )
    total = sum(_int(row.get("clips")) for row in rows)
    return [
        PartyShare(
            party=str(row["party"]),
            clips=_int(row.get("clips")),
            speakers=_int(row.get("speakers")),
            share=round(_int(row.get("clips")) / total, 3) if total else 0.0,
        )
        for row in rows
    ]


def inventory(executor: SqlExecutor) -> Mapping[str, int]:
    """Catalogue size. `Q-1` is a BLOCKER measured in exactly these numbers."""

    rows = _rows(
        executor.execute_sql(
            "select "
            "  (select count(*) from public.sources)::int as debates, "
            "  (select count(*) from public.speeches)::int as speeches, "
            "  (select count(*) from public.clips where published_at is not null)::int "
            "    as published_clips, "
            "  (select count(distinct party) from public.speeches "
            "     where party is not null and party <> '')::int as parties;"
        )
    )
    row = rows[0] if rows else {}
    keys = ("debates", "speeches", "published_clips", "parties")
    return {key: _int(row.get(key)) for key in keys}


# -- helpers -------------------------------------------------------------


def _rows(response: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    candidate: Any = response.get("result", response)
    if isinstance(candidate, Mapping):
        candidate = candidate.get("rows", [])
    if not isinstance(candidate, Sequence) or isinstance(candidate, str | bytes):
        return []
    return [row for row in candidate if isinstance(row, Mapping)]


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _round(value: Any) -> float | None:
    try:
        return round(float(value), 1)
    except (TypeError, ValueError):
        return None


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
