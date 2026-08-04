"""C12 crash-recovery acceptance.

`docs/BUILD_PLAN.md`: *"Resumption is the acceptance criterion. Kill the worker
mid-render and restart: it must continue from the last completed stage, not from
the top."* The build plan says not to soften this, so it is not softened.

These run against `FakeJobsTable`, an in-memory implementation of the four SQL
statements `JobQueue` emits. That is a real design decision worth defending under
`AGENTS.md` rule 3: the thing under test is the *orchestrator's* recovery
behaviour — does a killed worker's job come back, does it resume at the right
stage, does anything run twice — and that logic lives in `queue.py` and `cli.py`,
not in Postgres. The fake stands in for the database, which is the boundary, not
the subject.

What a fake genuinely cannot prove is that `FOR UPDATE SKIP LOCKED` serialises
two real workers. That is asserted separately in
`tests/live/test_job_queue.py` against a real Postgres, because a fake asserting
its own concurrency semantics would be worthless.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from src.errors import ExternalServiceError
from src.orchestrator.cli import Worker
from src.orchestrator.jobs import (
    STAGE_GRAPH,
    enqueue_debate,
    idempotency_key,
    stage_for,
)
from src.orchestrator.queue import JobQueue

DOKID = "HD10540"


class FakeJobsTable:
    """In-memory `public.jobs` implementing the statements `JobQueue` emits.

    Deliberately parses the emitted SQL rather than exposing a Python API, so
    the tests exercise the same strings a real database would receive. A typo in
    a column name fails here too.
    """

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.runs: list[dict[str, str]] = []
        self._next_id = 1
        self.now = datetime(2026, 8, 2, 12, 0, tzinfo=UTC)

    # -- clock ----------------------------------------------------------

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)

    # -- dispatch -------------------------------------------------------

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        collapsed = " ".join(query.split())
        if collapsed.startswith("insert into public.job_runs"):
            return self._record_run(collapsed)
        if collapsed.startswith("insert into public.jobs"):
            return self._insert(collapsed)
        if "for update skip locked" in collapsed:
            return self._claim(collapsed)
        # The reaper is checked before the state setters: both of its passes
        # start with `update ... set state = '<dead|queued>'` and are told apart
        # only by targeting `where state = 'running'` rather than an id.
        if "where state = 'running'" in collapsed:
            return self._reap(collapsed)
        if collapsed.startswith("update public.jobs set state = 'complete'"):
            return self._set_state(collapsed, "complete")
        if collapsed.startswith("update public.jobs set state = 'dead'"):
            return self._set_state(collapsed, "dead")
        if collapsed.startswith("update public.jobs set state = 'queued'"):
            return self._requeue(collapsed)
        if collapsed.startswith("select state, count(*)"):
            return self._counts()
        if "count(*)::int as n" in collapsed and "parent_id =" in collapsed:
            return self._incomplete_siblings(collapsed)
        if "where state = 'dead'" in collapsed:
            return self._dead()
        raise AssertionError(f"FakeJobsTable does not understand: {collapsed[:160]}")

    # -- statements -----------------------------------------------------

    def _record_run(self, sql: str) -> Mapping[str, Any]:
        """C13 history. Records the outcome so tests can assert on it."""

        outcome = re.search(r"'(complete|retry|dead|reaped)'", sql)
        self.runs.append({"outcome": outcome.group(1) if outcome else "?"})
        return {"result": []}

    def _insert(self, sql: str) -> Mapping[str, Any]:
        # Literal order matches the column list:
        # kind, entity_id, idempotency_key, state('queued'), pool
        values = _literals(sql)
        key = values[2]
        if any(row["idempotency_key"] == key for row in self.rows):
            return {"result": []}
        numbers = _numbers_after_values(sql)
        row = {
            "id": self._next_id,
            "kind": values[0],
            "entity_id": values[1],
            "idempotency_key": key,
            "state": "queued",
            "pool": values[4],
            "priority": numbers[0],
            "max_attempts": numbers[1],
            "attempts": 0,
            "run_after": self.now,
            "locked_at": None,
            "locked_by": None,
            "last_error": None,
            "parent_id": _parent_id(sql),
            "payload": _payload(sql),
        }
        self.rows.append(row)
        self._next_id += 1
        return {"result": [{"id": row["id"]}]}

    def _claim(self, sql: str) -> Mapping[str, Any]:
        pool = re.search(r"pool = '([a-z]+)'", sql)
        worker = re.search(r"locked_by = '([^']+)'", sql)
        assert pool and worker
        runnable = [
            row
            for row in self.rows
            if row["state"] == "queued"
            and row["pool"] == pool.group(1)
            and row["run_after"] <= self.now
        ]
        if not runnable:
            return {"result": []}
        runnable.sort(key=lambda r: (-r["priority"], r["id"]))
        row = runnable[0]
        row["state"] = "running"
        row["locked_at"] = self.now
        row["locked_by"] = worker.group(1)
        row["attempts"] += 1
        return {"result": [dict(row)]}

    def _set_state(self, sql: str, state: str) -> Mapping[str, Any]:
        row = self._by_id(sql)
        row["state"] = state
        row["locked_at"] = None
        row["locked_by"] = None
        if state == "complete":
            row["last_error"] = None
        else:
            row["last_error"] = _last_error(sql)
        return {"result": []}

    def _requeue(self, sql: str) -> Mapping[str, Any]:
        if "attempts = 0" in sql:  # retry_dead
            affected = [r for r in self.rows if r["state"] == "dead"]
            kind = re.search(r"kind = '([^']+)'", sql)
            if kind:
                affected = [r for r in affected if r["kind"] == kind.group(1)]
            for row in affected:
                row.update(state="queued", attempts=0, run_after=self.now, locked_at=None)
            return {"result": [{"id": r["id"]} for r in affected]}

        row = self._by_id(sql)
        row["state"] = "queued"
        row["locked_at"] = None
        row["locked_by"] = None
        row["last_error"] = _last_error(sql)
        delay = re.search(r"interval '(\d+) seconds'", sql)
        row["run_after"] = self.now + timedelta(seconds=int(delay.group(1)) if delay else 0)
        return {"result": []}

    def _reap(self, sql: str) -> Mapping[str, Any]:
        """One of the two reaper passes: exhausted -> dead, otherwise -> queued."""

        lease = re.search(r"interval '(\d+) seconds'", sql)
        assert lease
        cutoff = self.now - timedelta(seconds=int(lease.group(1)))
        target = "dead" if "state = 'dead'" in sql else "queued"
        exhausted = "attempts >= max_attempts" in sql

        reaped = [
            row
            for row in self.rows
            if row["state"] == "running"
            and row["locked_at"]
            and row["locked_at"] < cutoff
            and ((row["attempts"] >= row["max_attempts"]) == exhausted)
        ]
        for row in reaped:
            row["state"] = target
            row["locked_at"] = None
            row["locked_by"] = None
            row["last_error"] = row["last_error"] or "lease expired; worker presumed dead"
        return {"result": [{"id": r["id"]} for r in reaped]}

    def _incomplete_siblings(self, sql: str) -> Mapping[str, Any]:
        """C12b join barrier. `dead` counts as incomplete, as in the real query."""

        parent = re.search(r"parent_id = (\d+)", sql)
        kind = re.search(r"kind = '([^']+)'", sql)
        assert parent and kind
        n = sum(
            1
            for row in self.rows
            if row["parent_id"] == int(parent.group(1))
            and row["kind"] == kind.group(1)
            and row["state"] != "complete"
        )
        return {"result": [{"n": n}]}

    def _counts(self) -> Mapping[str, Any]:
        counts: dict[str, int] = {}
        for row in self.rows:
            counts[row["state"]] = counts.get(row["state"], 0) + 1
        return {"result": [{"state": s, "n": n} for s, n in counts.items()]}

    def _dead(self) -> Mapping[str, Any]:
        return {"result": [dict(r) for r in self.rows if r["state"] == "dead"]}

    def _by_id(self, sql: str) -> dict[str, Any]:
        match = re.search(r"where id = (\d+)", sql)
        assert match, sql
        job_id = int(match.group(1))
        for row in self.rows:
            if row["id"] == job_id:
                return row
        raise AssertionError(f"no job {job_id}")

    # -- assertions helpers ---------------------------------------------

    def state_of(self, kind: str) -> str | None:
        for row in self.rows:
            if row["kind"] == kind:
                return str(row["state"])
        return None

    @property
    def kinds(self) -> list[str]:
        return [str(row["kind"]) for row in self.rows]


def _literals(sql: str) -> list[str]:
    return re.findall(r"'((?:[^']|'')*)'", sql)


def _numbers_after_values(sql: str) -> list[int]:
    """Bare integers in the VALUES tuple: priority, then max_attempts.

    Lookahead rather than a consuming comma — matching `, 0,` would eat the
    delimiter that the next number needs, so only every other one is found.
    """

    tail = sql.split("values (", 1)[1]
    return [int(n) for n in re.findall(r",\s*(-?\d+)(?=\s*,)", tail)]


def _parent_id(sql: str) -> int | None:
    tail = sql.split("values (", 1)[1]
    match = re.search(r",\s*(\d+|null),\s*\$riket_job_", tail)
    if match is None or match.group(1) == "null":
        return None
    return int(match.group(1))


def _payload(sql: str) -> dict[str, Any]:
    import json

    match = re.search(r"(\$riket_job_\d+\$)(.*?)\1::jsonb", sql, re.DOTALL)
    return json.loads(match.group(2)) if match else {}


def _last_error(sql: str) -> str | None:
    match = re.search(r"last_error = '((?:[^']|'')*)'", sql)
    return match.group(1).replace("''", "'") if match else None


# -- fixtures ------------------------------------------------------------


class StageRecorder:
    """Stands in for the stage entrypoints and records what actually ran."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.crash_on: set[str] = set()
        self.fail_on: dict[str, int] = {}

    def run(self, kind: str) -> None:
        self.calls.append(kind)
        if kind in self.crash_on:
            raise KeyboardInterrupt(f"worker killed during {kind}")
        remaining = self.fail_on.get(kind, 0)
        if remaining:
            self.fail_on[kind] = remaining - 1
            raise RuntimeError(f"{kind} failed")


CLIP_IDS = [f"{DOKID}_anf1_c{i:02d}" for i in range(1, 4)]


@pytest.fixture
def table() -> FakeJobsTable:
    return FakeJobsTable()


@pytest.fixture(autouse=True)
def stub_fan_out_units(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fan out over three clips without needing C7 artifacts on disk.

    The unit list is C7's business and is tested there; what matters here is
    that the orchestrator fans out over it and joins correctly afterwards.
    """

    monkeypatch.setattr(
        "src.stages.render.selected_clip_ids",
        lambda dokid, work_dir: list(CLIP_IDS),
    )


def _worker(
    table: FakeJobsTable,
    recorder: StageRecorder,
    *,
    pool: str,
    worker_id: str = "w1",
    tmp_path: Path | None = None,
) -> Worker:
    queue = JobQueue(table, worker_id=worker_id, lease_s=3600)
    worker = Worker(queue, pool=pool, work_dir=tmp_path or Path("work"))

    def execute(job: Any) -> None:
        # Mirror the real _execute: a fan-out job runs no stage of its own.
        if stage_for(job.kind).fans_out_to is not None:
            return
        recorder.run(job.kind)

    worker._execute = execute  # type: ignore[method-assign]
    return worker


def _drain(table: FakeJobsTable, recorder: StageRecorder, *, rounds: int = 60) -> None:
    """Run every pool to a standstill, the way three worker processes would."""

    workers = {pool: _worker(table, recorder, pool=pool) for pool in ("io", "cpu", "gpu")}
    for _ in range(rounds):
        if not any(workers[pool].run_once().claimed for pool in ("io", "cpu", "gpu")):
            return


# -- the happy path ------------------------------------------------------


def test_a_debate_walks_the_whole_graph_exactly_once(table: FakeJobsTable) -> None:
    recorder = StageRecorder()
    queue = JobQueue(table, worker_id="seed")
    enqueue_debate(queue, DOKID)

    _drain(table, recorder)

    # `render` fans out and runs no stage itself; `render_clip` runs once per clip.
    expected = []
    for stage in STAGE_GRAPH:
        if stage.fans_out_to is not None:
            continue
        if stage.kind == "render_clip":
            expected.extend([stage.kind] * len(CLIP_IDS))
        else:
            expected.append(stage.kind)
    assert recorder.calls == expected
    assert all(row["state"] == "complete" for row in table.rows)
    assert table.kinds.count("render_clip") == len(CLIP_IDS)


def test_enqueuing_the_same_debate_twice_is_a_no_op(table: FakeJobsTable) -> None:
    """The discovery cron re-offers everything it finds on every pass."""

    queue = JobQueue(table, worker_id="seed")

    assert enqueue_debate(queue, DOKID) is True
    assert enqueue_debate(queue, DOKID) is False
    assert len(table.rows) == 1


# -- crash recovery: the acceptance criterion ----------------------------


def test_worker_killed_mid_render_resumes_at_render_not_from_the_top(
    table: FakeJobsTable,
) -> None:
    """C12's stated acceptance, verbatim.

    The first worker dies inside `render` — no exception reaches the queue,
    exactly as a `kill -9` would leave things. The row stays `running` forever
    until its lease expires, because there is no connection whose loss could
    signal otherwise.
    """

    recorder = StageRecorder()
    recorder.crash_on = {"render_clip"}
    queue = JobQueue(table, worker_id="seed")
    enqueue_debate(queue, DOKID)

    # Run until the first per-clip render kills its worker.
    with pytest.raises(KeyboardInterrupt):
        _drain(table, recorder)

    completed_before_crash = list(recorder.calls)
    assert completed_before_crash[-1] == "render_clip"

    held = [row for row in table.rows if row["kind"] == "render_clip" and row["state"] == "running"]
    assert len(held) == 1, "the dead worker still holds exactly one clip's lease"
    held_clip = held[0]["entity_id"]

    # A second worker may take the *other* clips immediately — that is the
    # parallelism this fan-out exists for — but it must not steal the live
    # lease on the clip the dead worker held.
    recorder.crash_on = set()
    recovery = _worker(table, recorder, pool="cpu", worker_id="w2")
    assert recovery.queue.reap_expired_leases().total == 0

    claimed_before_expiry = []
    while True:
        outcome = recovery.run_once()
        if not outcome.claimed:
            break
        claimed_before_expiry.append(outcome.entity_id)

    assert held_clip not in claimed_before_expiry, "stole a live lease"
    assert sorted(claimed_before_expiry) == sorted(set(CLIP_IDS) - {held_clip})
    assert "publish" not in table.kinds, "the barrier held: one clip is still outstanding"

    # Once the lease expires, the abandoned clip comes back — and only it.
    table.advance(3601)
    assert recovery.queue.reap_expired_leases().requeued == 1

    _drain(table, recorder)

    replayed = recorder.calls[len(completed_before_crash) :]
    assert replayed == ["render_clip"] * (len(CLIP_IDS) - 1) + ["render_clip", "publish"]
    assert recorder.calls.count("render_clip") == len(CLIP_IDS) + 1, (
        "only the abandoned clip was rendered twice"
    )
    assert recorder.calls.count("transcribe") == 1
    assert recorder.calls.count("acquire") == 1
    assert all(row["state"] == "complete" for row in table.rows)


def test_a_reaped_job_keeps_burning_attempts_so_a_poison_job_terminates(
    table: FakeJobsTable,
) -> None:
    """A job that reliably kills its worker must dead-letter, not loop forever.

    This is why `attempts` increments on claim rather than on failure.
    """

    recorder = StageRecorder()
    recorder.crash_on = {"acquire"}
    queue = JobQueue(table, worker_id="seed")
    enqueue_debate(queue, DOKID)

    worker = _worker(table, recorder, pool="io")
    worker.run_once()  # discover

    # Six chances to run, but the retry limit must bite first.
    for _ in range(6):
        # The worker process dies; nothing reports the failure to the queue.
        with suppress(KeyboardInterrupt):
            worker.run_once()
        table.advance(3601)
        worker.queue.reap_expired_leases()

    acquire = next(row for row in table.rows if row["kind"] == "acquire")
    assert acquire["state"] == "dead", "the reaper must dead-letter, not requeue forever"
    assert acquire["attempts"] == acquire["max_attempts"]
    assert recorder.calls.count("acquire") == 3, recorder.calls
    assert "segment" not in table.kinds, "the chain must not advance past a dead job"


# -- retries and dead-lettering -----------------------------------------


def test_a_transient_failure_retries_after_backoff_then_succeeds(
    table: FakeJobsTable,
) -> None:
    recorder = StageRecorder()
    recorder.fail_on = {"segment": 1}
    queue = JobQueue(table, worker_id="seed")
    enqueue_debate(queue, DOKID)

    _drain(table, recorder)
    assert table.state_of("segment") == "queued", "waiting out the backoff"

    table.advance(120)
    _drain(table, recorder)

    assert recorder.calls.count("segment") == 2
    assert all(row["state"] == "complete" for row in table.rows)


def test_a_permanent_failure_dead_letters_and_stops_the_chain(
    table: FakeJobsTable,
) -> None:
    recorder = StageRecorder()
    recorder.fail_on = {"select": 99}
    queue = JobQueue(table, worker_id="seed")
    enqueue_debate(queue, DOKID)

    for _ in range(6):
        _drain(table, recorder)
        table.advance(1801)

    assert table.state_of("select") == "dead"
    # Downstream never ran: the successor is only enqueued on success.
    assert "render" not in table.kinds
    assert "publish" not in table.kinds
    assert queue.counts_by_state()["dead"] == 1


def test_dead_jobs_are_recoverable_by_hand(table: FakeJobsTable) -> None:
    recorder = StageRecorder()
    recorder.fail_on = {"camera": 99}
    queue = JobQueue(table, worker_id="seed")
    enqueue_debate(queue, DOKID)
    for _ in range(6):
        _drain(table, recorder)
        table.advance(1801)
    assert table.state_of("camera") == "dead"

    recorder.fail_on = {}
    assert queue.retry_dead(kind="camera") == 1
    _drain(table, recorder)

    assert table.state_of("camera") == "complete"
    assert table.state_of("publish") == "complete"


# -- pools ---------------------------------------------------------------


def test_a_worker_never_claims_another_pools_work(table: FakeJobsTable) -> None:
    """The GPU pool is bounded by hardware. An IO worker must not take a render."""

    recorder = StageRecorder()
    queue = JobQueue(table, worker_id="seed")
    enqueue_debate(queue, DOKID)

    io_worker = _worker(table, recorder, pool="io")
    gpu_worker = _worker(table, recorder, pool="gpu")

    assert io_worker.run_once().kind == "discover"
    assert io_worker.run_once().kind == "acquire"
    # `segment` is CPU work: neither of these workers may take it.
    assert io_worker.run_once().claimed is False
    assert gpu_worker.run_once().claimed is False
    assert table.state_of("segment") == "queued"


def test_idempotency_keys_follow_the_documented_scheme() -> None:
    assert idempotency_key("render", "HD10540_c01") == "render:HD10540_c01:v1"
    assert idempotency_key("render", "x", version="v2") == "render:x:v2"


def test_a_transient_queue_poll_failure_does_not_kill_the_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The queue is an HTTP API, so polling it can fail for reasons unrelated to work.

    On 2026-08-03 all three workers died on an idle `claim()` — a 30 s curl
    timeout against Supabase — minutes after finishing a debate cleanly. Over a
    64-debate backfill that means returning to a stalled queue with no obvious
    cause. A failed poll must back off and retry; only a failed *job* counts
    against the job.
    """

    table = FakeJobsTable()
    recorder = StageRecorder()
    worker = _worker(table, recorder, pool="cpu")

    calls = {"n": 0}
    real_run_once = worker.run_once

    def flaky_run_once() -> Any:
        calls["n"] += 1
        if calls["n"] <= 3:
            raise ExternalServiceError("curl: (28) Operation timed out")
        return real_run_once()

    monkeypatch.setattr(worker, "run_once", flaky_run_once)
    monkeypatch.setattr("src.orchestrator.cli.time.sleep", lambda _s: None)

    # Unbounded mode is the one that must survive; stop it after a few polls.
    stop = {"n": 0}

    def counting_sleep(_s: float) -> None:
        stop["n"] += 1
        if stop["n"] > 6:
            raise KeyboardInterrupt

    monkeypatch.setattr("src.orchestrator.cli.time.sleep", counting_sleep)
    with suppress(KeyboardInterrupt):
        worker.run_forever()

    assert calls["n"] > 3, "the worker kept polling after the transport failures"


def test_a_timeout_while_recording_success_does_not_lose_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The stage already ran. Giving up here throws away completed work.

    On the March 2026 backfill a clip rendered its MP4 and thumbnail, then the
    `complete` call timed out. The row stayed `running` behind a 20-minute
    lease, and because the render fan-out has a join barrier, that one clip held
    back its whole debate with no error anywhere.
    """

    table = FakeJobsTable()
    recorder = StageRecorder()
    enqueue_debate(JobQueue(table, worker_id="seed"), DOKID)
    worker = _worker(table, recorder, pool="io")

    real_complete = worker.queue.complete
    calls = {"n": 0}

    def flaky_complete(job: Any) -> None:
        calls["n"] += 1
        if calls["n"] <= 2:
            raise ExternalServiceError("curl: (28) Operation timed out")
        real_complete(job)

    monkeypatch.setattr(worker.queue, "complete", flaky_complete)
    monkeypatch.setattr("src.orchestrator.cli.time.sleep", lambda _s: None)

    result = worker.run_once()

    assert result.outcome == "complete", "the retry recorded the finished job"
    assert calls["n"] == 3, "it retried rather than abandoning completed work"
    assert not [r for r in table.rows if r["state"] == "running"], "no orphaned lease"
