"""Live C13 metrics against real Postgres.

The unit tests assert the arithmetic and the query invariants against canned
rows. They cannot catch a SQL syntax error, a column that does not exist, or an
aggregate Postgres will not accept — and these queries lean on CTEs,
`percentile_disc ... within group`, and `count(*) filter (where ...)`, none of
which a string comparison validates.

Read-only. Nothing here writes, so it is safe against production.
"""

from __future__ import annotations

import pytest

from src.config import get_settings
from src.observability.metrics import (
    freshness,
    inventory,
    party_distribution,
    stage_failures,
    stage_timings,
)
from src.publish.supabase import SupabaseManagementClient

pytestmark = pytest.mark.live


@pytest.fixture(scope="module")
def client() -> SupabaseManagementClient:
    settings = get_settings()
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        pytest.skip("Set RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN")
    return SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )


def test_inventory_reflects_the_real_catalogue(client: SupabaseManagementClient) -> None:
    counts = inventory(client)

    assert counts["debates"] >= 1
    assert counts["published_clips"] >= 1
    # Q-1 is a BLOCKER measured in exactly this number. If it ever passes 2000,
    # the pool-based ranker becomes something other than a shuffle.
    assert counts["published_clips"] < 100000


def test_stage_timing_query_executes(client: SupabaseManagementClient) -> None:
    """`percentile_disc ... within group` over a possibly-empty table."""

    timings = stage_timings(client, days=7)

    for timing in timings:
        assert timing.p50_ms <= timing.p95_ms <= timing.max_ms


def test_stage_failure_query_executes(client: SupabaseManagementClient) -> None:
    """`count(*) filter (...)` plus `array_agg ... filter (...)` indexing."""

    failures = stage_failures(client, days=7)

    for failure in failures:
        assert failure.failures <= failure.runs
        assert 0.0 <= failure.failure_rate <= 1.0


def test_freshness_query_executes_and_is_internally_consistent(
    client: SupabaseManagementClient,
) -> None:
    slo = freshness(client, days=3650)

    assert slo.debates >= 1
    assert slo.published <= slo.debates
    assert 0.0 <= slo.publish_rate <= 1.0
    if slo.p50_lag_hours is not None and slo.p95_lag_hours is not None:
        assert slo.p50_lag_hours <= slo.p95_lag_hours
    for sample in slo.slowest:
        assert sample.dokid


def test_party_distribution_shares_are_a_partition(
    client: SupabaseManagementClient,
) -> None:
    """Shares must account for the whole window, or the exposure report
    understates somebody."""

    shares = party_distribution(client, days=3650)

    assert shares, "no published clips at all"
    assert abs(sum(share.share for share in shares) - 1.0) < 0.01
    assert all(share.clips > 0 for share in shares)


def test_job_runs_table_exists_with_the_expected_shape(
    client: SupabaseManagementClient,
) -> None:
    """Migration 007. The metrics are meaningless without it."""

    response = client.execute_sql(
        "select column_name from information_schema.columns "
        "where table_schema = 'public' and table_name = 'job_runs';"
    )
    rows = response.get("result", response)
    columns = {row["column_name"] for row in rows} if isinstance(rows, list) else set()

    assert {"kind", "outcome", "duration_ms", "finished_at", "attempt"} <= columns
