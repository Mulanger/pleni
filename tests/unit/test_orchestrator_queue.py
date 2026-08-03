"""Unit tests for the C12 job queue.

Scope note, because `AGENTS.md` rule 3 matters here: these test the queue's
*logic* — state transitions, backoff, literal escaping — and the SQL it emits.
They deliberately do not claim to test that `FOR UPDATE SKIP LOCKED` actually
serialises concurrent workers, because a fake executor proving that would be a
fake proving itself. That belongs in `tests/live/test_job_queue.py` against a
real Postgres.

What these tests are good for is the failure that is easy to introduce and
invisible in review: a claim that stops being one statement, a retry that
dead-letters early, an apostrophe in a debate title breaking the SQL.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest

from src.errors import ConfigurationError
from src.orchestrator.queue import (
    BACKOFF_SCHEDULE_S,
    Job,
    JobQueue,
    backoff_seconds,
)


class RecordingExecutor:
    """Captures emitted SQL and replays a scripted response per call."""

    def __init__(self, responses: list[Mapping[str, Any]] | None = None) -> None:
        self.statements: list[str] = []
        self.responses = responses or []

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        self.statements.append(query)
        if self.responses:
            return self.responses.pop(0)
        return {"result": []}

    @property
    def last(self) -> str:
        return self.statements[-1]


def _queue(responses: list[Mapping[str, Any]] | None = None) -> tuple[JobQueue, RecordingExecutor]:
    executor = RecordingExecutor(responses)
    return JobQueue(executor, worker_id="worker-1"), executor


def _quoted_literals(sql: str) -> list[str]:
    """Decode every single-quoted SQL literal, undoing `''` escaping.

    A plain scan, because splitting on `'` gets doubled quotes wrong in a way
    that is easy to write and hard to notice. Dollar-quoted sections are removed
    first: apostrophes inside them are not SQL-escaped.
    """

    import re

    stripped = re.sub(r"(\$riket_job_\d+\$).*?\1", "''", sql, flags=re.DOTALL)

    literals: list[str] = []
    index = 0
    while index < len(stripped):
        if stripped[index] != "'":
            index += 1
            continue
        index += 1
        buffer: list[str] = []
        while index < len(stripped):
            if stripped[index] == "'":
                if index + 1 < len(stripped) and stripped[index + 1] == "'":
                    buffer.append("'")
                    index += 2
                    continue
                index += 1
                break
            buffer.append(stripped[index])
            index += 1
        literals.append("".join(buffer))
    return literals


def _dollar_quoted_json(sql: str) -> Any:
    """Extract and decode the `$riket_job_N$...$riket_job_N$::jsonb` literal."""

    import json as _json
    import re

    match = re.search(r"(\$riket_job_\d+\$)(.*?)\1::jsonb", sql, re.DOTALL)
    assert match is not None, f"no dollar-quoted payload in: {sql[:200]}"
    return _json.loads(match.group(2))


def _job(**overrides: Any) -> Job:
    base: dict[str, Any] = {
        "id": 7,
        "kind": "render",
        "entity_id": "HD10540",
        "idempotency_key": "render:HD10540_c01:v1",
        "state": "running",
        "pool": "cpu",
        "attempts": 1,
        "max_attempts": 3,
        "payload": {},
    }
    base.update(overrides)
    return Job(**base)


# -- backoff -------------------------------------------------------------


def test_backoff_follows_the_schedule() -> None:
    assert backoff_seconds(1) == BACKOFF_SCHEDULE_S[0]
    assert backoff_seconds(2) == BACKOFF_SCHEDULE_S[1]
    assert backoff_seconds(3) == BACKOFF_SCHEDULE_S[2]


def test_backoff_clamps_instead_of_growing_without_bound() -> None:
    """A job must not be able to schedule itself past anyone's attention span."""

    assert backoff_seconds(99) == BACKOFF_SCHEDULE_S[-1]
    assert backoff_seconds(0) == BACKOFF_SCHEDULE_S[0]


# -- claiming ------------------------------------------------------------


def test_claim_is_a_single_atomic_statement() -> None:
    """The transport cannot hold a transaction open across round trips.

    If this ever becomes two statements, two workers can claim the same job and
    the whole queue silently loses its exclusion guarantee.
    """

    queue, executor = _queue()
    queue.claim(pool="cpu")

    sql = executor.last.lower()
    assert "for update skip locked" in sql
    assert sql.startswith("update public.jobs")
    # One statement: exactly one terminating semicolon, at the very end.
    assert sql.rstrip().count(";") == 1
    assert "begin" not in sql and "commit" not in sql


def test_claim_increments_attempts_so_a_worker_killing_job_cannot_loop() -> None:
    queue, executor = _queue()
    queue.claim(pool="gpu")

    assert "attempts = attempts + 1" in executor.last


def test_claim_only_takes_runnable_jobs_from_its_own_pool() -> None:
    queue, executor = _queue()
    queue.claim(pool="io")

    sql = executor.last
    assert "state = 'queued'" in sql
    assert "run_after <= now()" in sql
    assert "pool = 'io'" in sql


def test_claim_returns_none_when_the_queue_is_empty() -> None:
    queue, _ = _queue()

    assert queue.claim(pool="cpu") is None


def test_claim_parses_the_returned_row() -> None:
    queue, _ = _queue([
        {
            "result": [
                {
                    "id": 42,
                    "kind": "render",
                    "entity_id": "HD10540",
                    "idempotency_key": "render:HD10540_c01:v1",
                    "state": "running",
                    "pool": "cpu",
                    "attempts": 1,
                    "max_attempts": 3,
                    "payload": {"clip_id": "HD10540_c01"},
                    "last_error": None,
                    "parent_id": 41,
                }
            ]
        }
    ])

    job = queue.claim(pool="cpu")

    assert job is not None
    assert job.id == 42
    assert job.payload["clip_id"] == "HD10540_c01"
    assert job.parent_id == 41
    assert job.attempts_remaining == 2


def test_claim_accepts_a_json_encoded_payload_string() -> None:
    """Some SQL transports return jsonb as text rather than a decoded object."""

    queue, _ = _queue([
        {
            "result": [
                {
                    "id": 1,
                    "kind": "render",
                    "entity_id": "X",
                    "idempotency_key": "k",
                    "state": "running",
                    "pool": "cpu",
                    "attempts": 1,
                    "max_attempts": 3,
                    "payload": '{"clip_id": "X_c01"}',
                }
            ]
        }
    ])

    job = queue.claim(pool="cpu")

    assert job is not None
    assert job.payload == {"clip_id": "X_c01"}


def test_unknown_pool_is_rejected_rather_than_silently_matching_nothing() -> None:
    queue, _ = _queue()

    with pytest.raises(ConfigurationError, match="Unknown pool"):
        queue.claim(pool="quantum")
    with pytest.raises(ConfigurationError, match="Unknown pool"):
        queue.enqueue(kind="k", entity_id="e", idempotency_key="i", pool="quantum")


# -- failure and retry ---------------------------------------------------


def test_failure_with_attempts_left_requeues_with_backoff() -> None:
    queue, executor = _queue()

    state = queue.fail(_job(attempts=1, max_attempts=3), "ffmpeg exited 1")

    assert state == "queued"
    sql = executor.last
    assert "state = 'queued'" in sql
    assert f"interval '{BACKOFF_SCHEDULE_S[0]} seconds'" in sql
    assert "ffmpeg exited 1" in sql


def test_failure_on_the_last_attempt_dead_letters_with_the_error() -> None:
    queue, executor = _queue()

    state = queue.fail(_job(attempts=3, max_attempts=3), "ffmpeg exited 1")

    assert state == "dead"
    sql = executor.last
    assert "state = 'dead'" in sql
    assert "ffmpeg exited 1" in sql
    assert "interval" not in sql


def test_a_long_error_is_truncated_and_flattened() -> None:
    queue, executor = _queue()

    queue.fail(_job(attempts=3, max_attempts=3), "line one\nline two\n" + "x" * 5000)

    sql = executor.last
    assert "\n" not in sql.split("last_error = ")[1].split(",")[0]
    assert len(sql) < 4000


def test_completing_clears_the_lease_and_the_error() -> None:
    queue, executor = _queue()

    queue.complete(_job())

    sql = executor.last
    assert "state = 'complete'" in sql
    assert "locked_by = null" in sql
    assert "last_error = null" in sql


# -- lease reaping -------------------------------------------------------


def test_reaping_returns_expired_leases_to_the_queue() -> None:
    """C12's crash-recovery acceptance depends on this.

    A killed worker leaves its row in `running` forever — there is no
    connection whose loss could signal otherwise.
    """

    # Three statements now: the C13 history insert, then the dead-letter
    # pass, then the requeue pass.
    executor = RecordingExecutor([
        {"result": []},
        {"result": [{"id": 9}]},
        {"result": [{"id": 1}, {"id": 2}]},
    ])
    queue = JobQueue(executor, worker_id="reaper", lease_s=900)

    reaped = queue.reap_expired_leases()

    assert (reaped.requeued, reaped.dead, reaped.total) == (2, 1, 3)
    sql = executor.last
    assert "state = 'queued'" in sql
    assert "where state = 'running'" in sql
    assert "interval '900 seconds'" in sql
    assert "attempts < max_attempts" in sql


def test_reaping_does_not_overwrite_an_existing_error() -> None:
    queue, executor = _queue()

    queue.reap_expired_leases()

    assert "coalesce(last_error," in executor.last


# -- dead letters --------------------------------------------------------


def test_dead_jobs_are_only_retried_deliberately() -> None:
    """Automatic dead-letter retry is how a poison job becomes an infinite loop."""

    executor = RecordingExecutor([{"result": [{"id": 1}]}])
    queue = JobQueue(executor, worker_id="w")

    assert queue.retry_dead(kind="render") == 1
    sql = executor.last
    assert "state = 'dead'" in sql
    assert "kind = 'render'" in sql
    assert "attempts = 0" in sql


def test_retry_dead_can_be_scoped_to_one_debate() -> None:
    queue, executor = _queue()

    queue.retry_dead(entity_id="HD10540")

    assert "entity_id = 'HD10540'" in executor.last


# -- enqueue -------------------------------------------------------------


def test_enqueue_is_idempotent_on_the_key() -> None:
    queue, executor = _queue([{"result": []}])

    created = queue.enqueue(kind="render", entity_id="HD10540", idempotency_key="render:x:v1")

    assert created is False
    assert "on conflict (idempotency_key) do nothing" in executor.last


def test_enqueue_reports_a_new_job() -> None:
    queue, _ = _queue([{"result": [{"id": 9}]}])

    assert queue.enqueue(kind="render", entity_id="X", idempotency_key="k") is True


def test_enqueue_accepts_an_explicit_run_after() -> None:
    queue, executor = _queue()

    queue.enqueue(
        kind="discover",
        entity_id="X",
        idempotency_key="k",
        run_after=datetime(2026, 8, 3, 6, 0, tzinfo=UTC),
    )

    assert "2026-08-03T06:00:00+00:00" in executor.last


# -- literal safety ------------------------------------------------------


def test_an_apostrophe_in_a_value_cannot_break_out_of_the_statement() -> None:
    """Riksdagen debate titles contain apostrophes. This is not hypothetical.

    Asserts the real invariant rather than a substring: every value must survive
    a round trip through the literal encoding, and the hostile text must sit
    wholly inside one quoted literal instead of terminating it.
    """

    queue, executor = _queue()
    hostile = "HD'; drop table public.jobs; --"

    queue.enqueue(kind="render", entity_id=hostile, idempotency_key="k'1")

    literals = _quoted_literals(executor.last)
    assert hostile in literals, literals
    assert "k'1" in literals
    # The apostrophe is doubled, so `drop table` never escapes into statement
    # position — it is payload of a literal, not SQL.
    assert f"'{hostile.replace(chr(39), chr(39) * 2)}'" in executor.last


def test_payload_survives_swedish_characters_and_quotes() -> None:
    queue, executor = _queue()
    payload = {"speaker": "Gunnar Strömmer", "note": 'han sa "nej"', "apostrof": "O'Brien"}

    queue.enqueue(kind="render", entity_id="X", idempotency_key="k", payload=payload)

    assert _dollar_quoted_json(executor.last) == payload


def test_counts_by_state_always_reports_every_state() -> None:
    """A missing key in a status dashboard reads as zero anyway; make it explicit."""

    executor = RecordingExecutor([{"result": [{"state": "queued", "n": 3}]}])
    queue = JobQueue(executor, worker_id="w")

    counts = queue.counts_by_state(entity_id="HD10540")

    assert counts == {"queued": 3, "running": 0, "complete": 0, "dead": 0}
    assert "entity_id = 'HD10540'" in executor.last
