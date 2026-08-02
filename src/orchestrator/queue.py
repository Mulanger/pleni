"""Postgres-backed work queue over `public.jobs`.

See `docs/adr/009-python-native-job-queue.md` for why this is hand-written rather
than pg-boss or Celery.

**Every operation is exactly one SQL statement.** The worker reaches Postgres over
a stateless HTTPS SQL endpoint, so no transaction can be held open across round
trips — a design needing `BEGIN; SELECT ... FOR UPDATE; COMMIT;` would not work at
all. Claiming therefore puts `FOR UPDATE SKIP LOCKED` inside the subquery of a
single `UPDATE ... RETURNING`, which is atomic on its own.

The other consequence of that transport is that a request can time out *after* its
statement committed. A worker can hold a job it will never hear about. That is why
claims are leases with an expiry rather than plain locks: `reap_expired_leases()`
returns abandoned work to the queue. Without it, a dropped connection would lose a
job permanently.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from src.errors import ConfigurationError

#: Job pools. A worker claims only from its own pool, so a render never lands on
#: the machine holding the GPU. Concurrency is how many workers you run.
POOLS = ("gpu", "cpu", "io")

#: Terminal and non-terminal states. There is deliberately no `failed` resting
#: state — a failure is either retryable or `dead`. See migration 006.
STATES = ("queued", "running", "complete", "dead")

#: How long a claim is valid before the reaper may take it back. Must exceed the
#: longest plausible stage runtime; rendering a 60s clip dominates and the
#: architecture budgets 2-4h for 400 of them, so a single clip is minutes.
DEFAULT_LEASE_S = 3600

#: Retry backoff in seconds, indexed by attempt number. Deliberately a table
#: rather than a formula: the values are a policy decision and this way they are
#: readable and testable without arithmetic.
BACKOFF_SCHEDULE_S = (60, 300, 1800)


@dataclass(frozen=True)
class ReapResult:
    """What one reaper pass recovered."""

    requeued: int
    dead: int

    @property
    def total(self) -> int:
        """Rows the reaper touched, whichever way they went."""

        return self.requeued + self.dead

    def __str__(self) -> str:
        return f"{self.requeued} requeued, {self.dead} dead-lettered"


@dataclass(frozen=True)
class Job:
    """One row of `public.jobs`."""

    id: int
    kind: str
    entity_id: str
    idempotency_key: str
    state: str
    pool: str
    attempts: int
    max_attempts: int
    payload: Mapping[str, Any]
    last_error: str | None = None
    parent_id: int | None = None

    @property
    def attempts_remaining(self) -> int:
        """Attempts left before this job dead-letters."""

        return max(0, self.max_attempts - self.attempts)


class SqlExecutor(Protocol):
    """Anything that can run one SQL statement batch against the project."""

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        """Execute SQL and return the decoded response."""


class JobQueue:
    """A work queue over `public.jobs`.

    Stateless: holds no connection and no in-memory job state, so several
    workers on different machines are simply several instances.
    """

    def __init__(
        self,
        executor: SqlExecutor,
        *,
        worker_id: str,
        lease_s: int = DEFAULT_LEASE_S,
    ) -> None:
        self.executor = executor
        self.worker_id = worker_id
        self.lease_s = lease_s

    # -- writing ---------------------------------------------------------

    def enqueue(
        self,
        *,
        kind: str,
        entity_id: str,
        idempotency_key: str,
        pool: str = "cpu",
        payload: Mapping[str, Any] | None = None,
        priority: int = 0,
        max_attempts: int = 3,
        run_after: datetime | None = None,
        parent_id: int | None = None,
    ) -> bool:
        """Add a job. Returns False if `idempotency_key` already exists.

        Enqueuing the same work twice is a no-op rather than an error, because
        the discovery cron re-enqueues everything it finds on every pass and
        most of it is already known.
        """

        if pool not in POOLS:
            raise ConfigurationError(f"Unknown pool {pool!r}; expected one of {POOLS}")

        response = self.executor.execute_sql(
            "insert into public.jobs "
            "(kind, entity_id, idempotency_key, state, pool, priority, "
            " max_attempts, run_after, parent_id, payload) "
            "values ("
            f"{_text(kind)}, {_text(entity_id)}, {_text(idempotency_key)}, 'queued', "
            f"{_text(pool)}, {int(priority)}, {int(max_attempts)}, "
            f"{_timestamp(run_after)}, {_int_or_null(parent_id)}, "
            f"{_jsonb(payload or {})}) "
            "on conflict (idempotency_key) do nothing "
            "returning id;"
        )
        return len(_rows(response)) == 1

    def claim(self, *, pool: str) -> Job | None:
        """Atomically take the next runnable job from `pool`, or None.

        `FOR UPDATE SKIP LOCKED` inside the subquery makes concurrent workers
        take different rows instead of blocking on each other.

        `attempts` increments here rather than on failure. A worker that dies
        without reporting anything still burns an attempt, so a job that
        reliably kills its worker dead-letters instead of looping forever.
        """

        if pool not in POOLS:
            raise ConfigurationError(f"Unknown pool {pool!r}; expected one of {POOLS}")

        response = self.executor.execute_sql(
            "update public.jobs set "
            "state = 'running', "
            f"locked_at = now(), locked_by = {_text(self.worker_id)}, "
            "attempts = attempts + 1, updated_at = now() "
            "where id = ("
            "  select id from public.jobs "
            f"  where state = 'queued' and run_after <= now() and pool = {_text(pool)} "
            "  order by priority desc, id "
            "  for update skip locked "
            "  limit 1"
            ") "
            "returning id, kind, entity_id, idempotency_key, state, pool, "
            "attempts, max_attempts, payload, last_error, parent_id;"
        )
        rows = _rows(response)
        return _to_job(rows[0]) if rows else None

    def complete(self, job: Job) -> None:
        """Mark a job done. Terminal."""

        self.executor.execute_sql(
            "update public.jobs set "
            "state = 'complete', locked_at = null, locked_by = null, "
            "last_error = null, updated_at = now() "
            f"where id = {int(job.id)};"
        )

    def fail(self, job: Job, error: str) -> str:
        """Record a failure. Returns the resulting state.

        Retryable while attempts remain: back to `queued` with `run_after`
        pushed out by the backoff schedule. Otherwise `dead`, with the error
        preserved. A dead job is never claimed again and never silently retried
        — recovering it is a deliberate `retry_dead()` call.
        """

        if job.attempts_remaining > 0:
            delay = backoff_seconds(job.attempts)
            self.executor.execute_sql(
                "update public.jobs set "
                "state = 'queued', locked_at = null, locked_by = null, "
                f"last_error = {_text(_truncate(error))}, "
                f"run_after = now() + interval '{int(delay)} seconds', "
                "updated_at = now() "
                f"where id = {int(job.id)};"
            )
            return "queued"

        self.executor.execute_sql(
            "update public.jobs set "
            "state = 'dead', locked_at = null, locked_by = null, "
            f"last_error = {_text(_truncate(error))}, updated_at = now() "
            f"where id = {int(job.id)};"
        )
        return "dead"

    def reap_expired_leases(self) -> ReapResult:
        """Recover jobs whose worker died. Requeues, or dead-letters if exhausted.

        This is the mechanism behind C12's crash-recovery acceptance. A worker
        killed mid-render leaves its row in `running` forever; nothing else
        notices, because there is no connection whose loss could signal it.

        **Exhausted jobs must dead-letter here, not just in `fail()`.** A job
        that reliably kills its worker never reaches `fail()` — the process is
        gone. If the reaper requeued unconditionally, that job would be claimed
        again every time its lease expired, forever, and `attempts` would climb
        past `max_attempts` with nothing looking at it. That is precisely the
        poison-job loop the retry limit exists to prevent, arriving through the
        one path that skips the limit.

        Two statements rather than one `CASE`, so each remains a plain single
        statement over the stateless transport (ADR 009).
        """

        lease = f"locked_at < now() - interval '{int(self.lease_s)} seconds'"
        reason = "'lease expired; worker presumed dead'"

        dead = self.executor.execute_sql(
            "update public.jobs set "
            "state = 'dead', locked_at = null, locked_by = null, "
            f"last_error = coalesce(last_error, {reason}), updated_at = now() "
            f"where state = 'running' and {lease} and attempts >= max_attempts "
            "returning id;"
        )
        requeued = self.executor.execute_sql(
            "update public.jobs set "
            "state = 'queued', locked_at = null, locked_by = null, "
            f"last_error = coalesce(last_error, {reason}), updated_at = now() "
            f"where state = 'running' and {lease} and attempts < max_attempts "
            "returning id;"
        )
        return ReapResult(requeued=len(_rows(requeued)), dead=len(_rows(dead)))

    def retry_dead(self, *, kind: str | None = None, entity_id: str | None = None) -> int:
        """Requeue dead jobs, resetting their attempt count. Returns how many.

        Deliberately manual. Automatic dead-letter retry is how a poison job
        becomes an infinite loop nobody notices.
        """

        filters = ["state = 'dead'"]
        if kind is not None:
            filters.append(f"kind = {_text(kind)}")
        if entity_id is not None:
            filters.append(f"entity_id = {_text(entity_id)}")

        response = self.executor.execute_sql(
            "update public.jobs set "
            "state = 'queued', attempts = 0, run_after = now(), "
            "locked_at = null, locked_by = null, updated_at = now() "
            f"where {' and '.join(filters)} "
            "returning id;"
        )
        return len(_rows(response))

    # -- reading ---------------------------------------------------------

    def counts_by_state(self, *, entity_id: str | None = None) -> dict[str, int]:
        """Job counts per state, for `pipeline status`."""

        where = f"where entity_id = {_text(entity_id)} " if entity_id else ""
        response = self.executor.execute_sql(
            f"select state, count(*)::int as n from public.jobs {where}group by state;"
        )
        counts = {state: 0 for state in STATES}
        for row in _rows(response):
            state = row.get("state")
            if isinstance(state, str):
                counts[state] = int(row.get("n") or 0)
        return counts

    def dead_jobs(self, *, limit: int = 50) -> list[Job]:
        """Dead-lettered jobs, newest first. The first thing to look at."""

        response = self.executor.execute_sql(
            "select id, kind, entity_id, idempotency_key, state, pool, "
            "attempts, max_attempts, payload, last_error, parent_id "
            "from public.jobs where state = 'dead' "
            f"order by updated_at desc limit {int(limit)};"
        )
        return [_to_job(row) for row in _rows(response)]


def backoff_seconds(attempt: int) -> int:
    """Delay before retrying after `attempt` failed attempts.

    Clamps to the last entry rather than growing without bound, so a job cannot
    schedule itself past the point where anyone is still watching.
    """

    index = max(0, min(attempt - 1, len(BACKOFF_SCHEDULE_S) - 1))
    return BACKOFF_SCHEDULE_S[index]


# -- SQL literal helpers -------------------------------------------------
#
# The transport takes a SQL string, not bound parameters, so every value is
# rendered here and nowhere else. Keeping them in one place is what makes
# "is this quoted correctly?" a question with a single answer.


def _text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _jsonb(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    tag_index = 0
    while True:
        tag = f"$riket_job_{tag_index}$"
        if tag not in raw:
            return f"{tag}{raw}{tag}::jsonb"
        tag_index += 1


def _timestamp(value: datetime | None) -> str:
    if value is None:
        return "now()"
    return f"{_text(value.astimezone(UTC).isoformat())}::timestamptz"


def _int_or_null(value: int | None) -> str:
    return "null" if value is None else str(int(value))


def _truncate(error: str, limit: int = 2000) -> str:
    compact = " ".join(error.split())
    return compact[:limit]


def _rows(response: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    candidate: Any = response.get("result", response)
    if isinstance(candidate, Mapping):
        candidate = candidate.get("rows", [])
    if not isinstance(candidate, Sequence) or isinstance(candidate, str | bytes):
        return []
    return [row for row in candidate if isinstance(row, Mapping)]


def _to_job(row: Mapping[str, Any]) -> Job:
    payload = row.get("payload")
    if isinstance(payload, str):
        payload = json.loads(payload or "{}")
    if not isinstance(payload, Mapping):
        payload = {}
    return Job(
        id=int(row["id"]),
        kind=str(row["kind"]),
        entity_id=str(row["entity_id"]),
        idempotency_key=str(row["idempotency_key"]),
        state=str(row["state"]),
        pool=str(row.get("pool") or "cpu"),
        attempts=int(row.get("attempts") or 0),
        max_attempts=int(row.get("max_attempts") or 3),
        payload=payload,
        last_error=_optional_str(row.get("last_error")),
        parent_id=int(row["parent_id"]) if row.get("parent_id") is not None else None,
    )


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
