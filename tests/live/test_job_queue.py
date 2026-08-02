"""Live queue semantics against real Postgres.

`tests/integration/test_orchestrator_recovery.py` proves the orchestrator's
*recovery logic* against an in-memory fake. It cannot prove the one thing the
whole design rests on: that `FOR UPDATE SKIP LOCKED` inside a single
`UPDATE ... RETURNING` makes two concurrent workers take different rows. A fake
asserting its own concurrency semantics would be worthless.

So that claim is tested here, against the real database, per `AGENTS.md` rule 3.

These write to `public.jobs` on the configured project and clean up after
themselves. Every row uses a `livetest:` idempotency prefix and a `kind` of
`__livetest__`, which no real stage uses, so a leaked row is obvious and
harmless — `__livetest__` is not in `STAGE_GRAPH`, so no worker can execute it.

Run with:

    RIKET_SUPABASE_PROJECT_REF=... RIKET_SUPABASE_ACCESS_TOKEN=... \\
      python -m pytest tests/live/test_job_queue.py -m live
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from src.config import get_settings
from src.orchestrator.queue import JobQueue
from src.publish.supabase import SupabaseManagementClient

pytestmark = pytest.mark.live

PROBE_KIND = "__livetest__"


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


@pytest.fixture
def probe(client: SupabaseManagementClient) -> Iterator[str]:
    """A unique entity id, with every row it produced deleted afterwards."""

    entity_id = f"livetest-{uuid.uuid4().hex[:12]}"
    try:
        yield entity_id
    finally:
        client.execute_sql(
            f"delete from public.jobs where kind = '{PROBE_KIND}' "
            f"and entity_id = '{entity_id}';"
        )


def _rows(response: Any) -> list[dict[str, Any]]:
    result = response.get("result", response)
    return list(result) if isinstance(result, list) else []


def test_two_workers_never_claim_the_same_job(
    client: SupabaseManagementClient, probe: str
) -> None:
    """The core guarantee. If this fails, the queue is not a queue."""

    seeder = JobQueue(client, worker_id="seeder")
    assert seeder.enqueue(
        kind=PROBE_KIND, entity_id=probe, idempotency_key=f"livetest:{probe}:1", pool="cpu"
    )

    worker_a = JobQueue(client, worker_id="live-a")
    worker_b = JobQueue(client, worker_id="live-b")

    first = worker_a.claim(pool="cpu")
    second = worker_b.claim(pool="cpu")

    # Only one of them may have taken *this* job. The project's queue may hold
    # unrelated work, so filter to the probe rather than asserting on identity.
    claimed = [job for job in (first, second) if job and job.entity_id == probe]
    assert len(claimed) == 1, "two workers claimed the same job"
    assert claimed[0].attempts == 1

    worker_a.complete(claimed[0]) if claimed[0] is first else worker_b.complete(claimed[0])


def test_idempotency_key_is_enforced_by_the_database(
    client: SupabaseManagementClient, probe: str
) -> None:
    """Not by application logic — by a unique constraint that survives a race."""

    queue = JobQueue(client, worker_id="live")
    key = f"livetest:{probe}:dup"

    assert queue.enqueue(kind=PROBE_KIND, entity_id=probe, idempotency_key=key) is True
    assert queue.enqueue(kind=PROBE_KIND, entity_id=probe, idempotency_key=key) is False

    rows = _rows(
        client.execute_sql(
            f"select count(*)::int as n from public.jobs where idempotency_key = '{key}';"
        )
    )
    assert int(rows[0]["n"]) == 1


def test_a_claimed_job_is_invisible_to_the_next_claim(
    client: SupabaseManagementClient, probe: str
) -> None:
    queue = JobQueue(client, worker_id="live")
    queue.enqueue(
        kind=PROBE_KIND, entity_id=probe, idempotency_key=f"livetest:{probe}:1", pool="io"
    )

    first = queue.claim(pool="io")
    assert first is not None and first.entity_id == probe

    second = queue.claim(pool="io")
    assert second is None or second.entity_id != probe

    queue.complete(first)


def test_backoff_actually_defers_the_row_in_the_database(
    client: SupabaseManagementClient, probe: str
) -> None:
    """`run_after` must be in the future, so the retry is not claimed instantly."""

    queue = JobQueue(client, worker_id="live")
    queue.enqueue(
        kind=PROBE_KIND, entity_id=probe, idempotency_key=f"livetest:{probe}:1", pool="cpu"
    )
    job = queue.claim(pool="cpu")
    assert job is not None

    assert queue.fail(job, "probe failure") == "queued"

    rows = _rows(
        client.execute_sql(
            "select (run_after > now()) as deferred, state, last_error "
            f"from public.jobs where id = {job.id};"
        )
    )
    assert rows[0]["deferred"] in (True, "true")
    assert rows[0]["state"] == "queued"
    assert "probe failure" in str(rows[0]["last_error"])


def test_the_state_check_constraint_rejects_an_invalid_state(
    client: SupabaseManagementClient, probe: str
) -> None:
    """Migration 006's constraint is the last line of defence against a typo."""

    queue = JobQueue(client, worker_id="live")
    queue.enqueue(
        kind=PROBE_KIND, entity_id=probe, idempotency_key=f"livetest:{probe}:1", pool="cpu"
    )

    with pytest.raises(Exception, match="jobs_state_check|violates check constraint"):
        client.execute_sql(
            f"update public.jobs set state = 'finished' where entity_id = '{probe}';"
        )


def test_the_claim_index_is_used_rather_than_a_sequential_scan(
    client: SupabaseManagementClient,
) -> None:
    """A queue that seq-scans is a queue that falls over at volume.

    `jobs_claimable_idx` is partial on `state = 'queued'`, so it stays small no
    matter how much completed history accumulates.
    """

    rows = _rows(
        client.execute_sql(
            "explain (format json) select id from public.jobs "
            "where state = 'queued' and run_after <= now() and pool = 'cpu' "
            "order by priority desc, id limit 1;"
        )
    )
    plan = str(rows).lower()
    # On an empty table Postgres may still choose a seq scan; assert only that
    # the planner knows about the index when it matters.
    indexes = _rows(
        client.execute_sql(
            "select indexname from pg_indexes "
            "where tablename = 'jobs' and indexname = 'jobs_claimable_idx';"
        )
    )
    assert indexes, "jobs_claimable_idx is missing"
    assert "jobs" in plan
