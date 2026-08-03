"""Unit tests for the C13 metrics queries.

These cover the arithmetic and the query invariants that are easy to break and
hard to notice — a timing that silently includes failed runs, a failure rate
that quietly excludes crashed workers, a freshness number contaminated by
backfill. The numbers themselves are only meaningful against real data, which
`tests/live/test_observability.py` exercises.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from src.observability.metrics import (
    StageFailure,
    freshness,
    inventory,
    party_distribution,
    stage_failures,
    stage_timings,
)


class CannedExecutor:
    """Returns scripted rows and records the SQL that asked for them."""

    def __init__(self, *responses: list[Mapping[str, Any]]) -> None:
        self.statements: list[str] = []
        self.responses = list(responses)

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        self.statements.append(" ".join(query.split()))
        return {"result": self.responses.pop(0) if self.responses else []}

    @property
    def last(self) -> str:
        return self.statements[-1]


# -- stage timings -------------------------------------------------------


def test_timings_only_count_completed_runs() -> None:
    """A job that died after 3 seconds would drag the median down and make a
    broken stage look fast."""

    executor = CannedExecutor([])
    stage_timings(executor, days=7)

    assert "outcome = 'complete'" in executor.last
    assert "duration_ms is not null" in executor.last


def test_timings_report_percentiles_not_averages() -> None:
    """A mean hides the tail, and the tail is what breaks a lease."""

    executor = CannedExecutor(
        [{"kind": "render", "runs": 40, "p50": 30000, "p95": 92000, "worst": 180000}]
    )

    timings = stage_timings(executor)

    assert "percentile_disc(0.95)" in executor.statements[0]
    assert "avg(" not in executor.statements[0]
    assert timings[0].p95_s == 92.0
    assert timings[0].max_ms == 180000


def test_timing_window_is_applied() -> None:
    executor = CannedExecutor([])
    stage_timings(executor, days=30)

    assert "interval '30 days'" in executor.last


# -- stage failures ------------------------------------------------------


def test_a_reaped_run_counts_as_a_failure() -> None:
    """A worker that died mid-job did not succeed.

    Excluding `reaped` would hide exactly the failures nobody reported, which
    are the ones worth knowing about.
    """

    executor = CannedExecutor([])
    stage_failures(executor)

    assert "outcome <> 'complete'" in executor.last


def test_failure_rate_is_computed_over_all_attempts() -> None:
    executor = CannedExecutor(
        [{"kind": "render", "runs": 10, "failures": 3, "dead": 1, "last_error": "ffmpeg exited 1"}]
    )

    failures = stage_failures(executor)

    assert failures[0].failure_rate == 0.3
    assert failures[0].dead == 1
    assert failures[0].last_error == "ffmpeg exited 1"


def test_failure_rate_of_a_stage_that_never_ran_is_zero_not_a_crash() -> None:
    never_ran = StageFailure(kind="render", runs=0, failures=0, dead=0, last_error=None)
    assert never_ran.failure_rate == 0.0


# -- freshness -----------------------------------------------------------


def test_freshness_measures_from_debate_date_not_published_at() -> None:
    """`Q-4`: `debate_date` is the age of the politics; `published_at` is only
    availability. Measuring from the latter would make every backfill look
    instant."""

    executor = CannedExecutor([], [])
    freshness(executor)

    sql = executor.statements[0]
    assert "f.published_at - s.debate_date" in sql
    assert "min(c.published_at)" in sql


def test_freshness_excludes_backfilled_old_debates() -> None:
    """A 2024 debate published today would report a two-year lag and destroy
    the percentile."""

    executor = CannedExecutor([], [])
    freshness(executor, days=30)

    assert "s.debate_date > (now() - interval '30 days')::date" in executor.statements[0]


def test_freshness_counts_unpublished_debates_in_the_denominator() -> None:
    """A debate that produced nothing is the worst possible freshness outcome.

    A LEFT JOIN keeps it in `debates` while leaving its lag null, so
    `publish_rate` falls rather than the percentile silently improving.
    """

    executor = CannedExecutor(
        [{"debates": 10, "published": 7, "p50": 20.0, "p95": 40.0, "worst": 55.0}],
        [],
    )

    slo = freshness(executor)

    assert "left join first_clip" in executor.statements[0]
    assert slo.debates == 10
    assert slo.published == 7
    assert slo.publish_rate == 0.7
    assert slo.p95_lag_hours == 40.0


def test_freshness_handles_an_empty_project_without_dividing_by_zero() -> None:
    executor = CannedExecutor([{"debates": 0, "published": 0}], [])

    slo = freshness(executor)

    assert slo.publish_rate == 0.0
    assert slo.p50_lag_hours is None
    assert slo.slowest == []


# -- party distribution --------------------------------------------------


def test_party_shares_sum_to_one() -> None:
    executor = CannedExecutor(
        [
            {"party": "M", "clips": 13, "speakers": 1},
            {"party": "S", "clips": 3, "speakers": 1},
        ]
    )

    shares = party_distribution(executor)

    assert [p.party for p in shares] == ["M", "S"]
    assert shares[0].share == 0.812
    assert round(sum(p.share for p in shares), 2) == 1.0


def test_party_distribution_only_counts_published_clips() -> None:
    executor = CannedExecutor([])
    party_distribution(executor, days=7)

    sql = executor.last
    assert "c.published_at is not null" in sql
    assert "interval '7 days'" in sql


def test_a_missing_party_is_labelled_rather_than_dropped() -> None:
    """Dropping unattributed clips would make the shares add to less than the
    catalogue and quietly misstate exposure."""

    executor = CannedExecutor([])
    party_distribution(executor)

    assert "coalesce(nullif(sp.party, ''), 'okänt')" in executor.last


def test_empty_distribution_does_not_divide_by_zero() -> None:
    assert party_distribution(CannedExecutor([])) == []


# -- inventory -----------------------------------------------------------


def test_inventory_reports_every_key_even_when_empty() -> None:
    counts = inventory(CannedExecutor([]))

    assert set(counts) == {"debates", "speeches", "published_clips", "parties"}
    assert all(value == 0 for value in counts.values())


def test_inventory_counts_only_published_clips() -> None:
    executor = CannedExecutor([{"debates": 1, "speeches": 7, "published_clips": 16, "parties": 2}])

    counts = inventory(executor)

    assert "where published_at is not null" in executor.last
    assert counts["published_clips"] == 16
