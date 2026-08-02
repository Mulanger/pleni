"""Worker loop and `pipeline` CLI for C12 orchestration.

    python -m src.orchestrator.cli enqueue --dokid HD10540
    python -m src.orchestrator.cli run --pool cpu
    python -m src.orchestrator.cli status --dokid HD10540
    python -m src.orchestrator.cli retry --kind render
    python -m src.orchestrator.cli reap

A worker claims only from its own pool, so concurrency is how many processes you
start rather than a number in a config file. That keeps the GPU pool honest: it is
bounded by the hardware that exists, not by a setting somebody can raise.
"""

from __future__ import annotations

import argparse
import time
from dataclasses import dataclass
from pathlib import Path

from src.config import Settings, get_settings
from src.errors import ConfigurationError, PipelineError
from src.logging import configure_logging, stage_logger
from src.orchestrator.jobs import (
    MAX_LEASE_S,
    STAGE_GRAPH,
    enqueue_debate,
    enqueue_successor,
    stage_for,
)
from src.orchestrator.queue import Job, JobQueue
from src.publish.supabase import SupabaseManagementClient

#: How long a worker waits before polling again when the queue is empty.
#: `LISTEN/NOTIFY` is unavailable over the stateless transport (ADR 009), and at
#: one debate every few hours this cadence is irrelevant.
IDLE_POLL_S = 5.0


@dataclass
class WorkerResult:
    """What one `run_once` call did. Returned so tests can assert on it."""

    claimed: bool = False
    kind: str | None = None
    entity_id: str | None = None
    outcome: str | None = None
    successor: str | None = None
    error: str | None = None


class Worker:
    """Claims jobs from one pool and runs the matching stage."""

    def __init__(
        self,
        queue: JobQueue,
        *,
        pool: str,
        work_dir: Path,
    ) -> None:
        self.queue = queue
        self.pool = pool
        self.work_dir = work_dir
        self.logger = stage_logger("C12_worker", pool=pool, worker=queue.worker_id)

    def run_once(self) -> WorkerResult:
        """Claim and run at most one job."""

        job = self.queue.claim(pool=self.pool)
        if job is None:
            return WorkerResult()

        result = WorkerResult(
            claimed=True, kind=job.kind, entity_id=job.entity_id
        )
        started = time.monotonic()
        self.logger.info(
            "job_claimed",
            job_id=job.id,
            kind=job.kind,
            dokid=job.entity_id,
            attempt=job.attempts,
        )

        try:
            self._execute(job)
        except PipelineError as error:
            # Expected pipeline failures: retryable, and the message is useful.
            result.outcome = self.queue.fail(job, f"{type(error).__name__}: {error}")
            result.error = str(error)
            self.logger.warning(
                "job_failed",
                job_id=job.id,
                kind=job.kind,
                dokid=job.entity_id,
                outcome=result.outcome,
                error=str(error),
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            return result
        except Exception as error:
            # A worker must never die because one job did.
            # Unexpected: still record it rather than losing the job to a
            # crashed process. The lease would eventually reap it, but an hour
            # later and without the traceback.
            result.outcome = self.queue.fail(job, f"{type(error).__name__}: {error}")
            result.error = str(error)
            self.logger.error(
                "job_crashed",
                job_id=job.id,
                kind=job.kind,
                dokid=job.entity_id,
                outcome=result.outcome,
                error=str(error),
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            return result

        self.queue.complete(job)
        result.outcome = "complete"
        result.successor = enqueue_successor(
            self.queue,
            kind=job.kind,
            entity_id=job.entity_id,
            parent_id=job.id,
            payload=job.payload,
        )
        self.logger.info(
            "job_complete",
            job_id=job.id,
            kind=job.kind,
            dokid=job.entity_id,
            successor=result.successor,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return result

    def run_forever(self, *, max_iterations: int | None = None) -> int:
        """Poll until interrupted. Returns how many jobs were run."""

        completed = 0
        iterations = 0
        while max_iterations is None or iterations < max_iterations:
            iterations += 1
            result = self.run_once()
            if result.claimed:
                completed += 1
                continue
            if max_iterations is not None:
                break
            time.sleep(IDLE_POLL_S)
        return completed

    def _execute(self, job: Job) -> None:
        stage = stage_for(job.kind)
        entrypoint = stage.resolve()
        entrypoint(job.entity_id, work_dir=self.work_dir)


def build_queue(settings: Settings, *, worker_id: str, lease_s: int = MAX_LEASE_S) -> JobQueue:
    """Construct a queue against the configured Supabase project."""

    if not settings.supabase_project_ref or not settings.supabase_access_token:
        raise ConfigurationError(
            "Orchestration requires RIKET_SUPABASE_PROJECT_REF and "
            "RIKET_SUPABASE_ACCESS_TOKEN. See .env.example."
        )
    client = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    return JobQueue(client, worker_id=worker_id, lease_s=lease_s)


def main(argv: list[str] | None = None) -> int:
    """Entry point for the `pipeline` CLI."""

    parser = argparse.ArgumentParser(prog="pipeline", description=__doc__)
    parser.add_argument("--work-dir", type=Path, default=None, help="Override RIKET_WORK_DIR")
    parser.add_argument("--worker-id", default=None, help="Defaults to host:pid")
    subparsers = parser.add_subparsers(dest="command", required=True)

    enqueue_parser = subparsers.add_parser("enqueue", help="Start a debate through the pipeline")
    enqueue_parser.add_argument("--dokid", required=True)
    enqueue_parser.add_argument("--priority", type=int, default=0)

    run_parser = subparsers.add_parser("run", help="Run a worker")
    run_parser.add_argument("--pool", required=True, choices=("gpu", "cpu", "io"))
    run_parser.add_argument(
        "--once", action="store_true", help="Run at most one job, then exit."
    )

    status_parser = subparsers.add_parser("status", help="Job counts by state")
    status_parser.add_argument("--dokid", default=None)

    retry_parser = subparsers.add_parser("retry", help="Requeue dead-lettered jobs")
    retry_parser.add_argument("--kind", default=None)
    retry_parser.add_argument("--dokid", default=None)

    subparsers.add_parser("reap", help="Return expired leases to the queue")
    subparsers.add_parser("graph", help="Print the stage graph")

    args = parser.parse_args(argv)

    if args.command == "graph":
        for index, stage in enumerate(STAGE_GRAPH, start=1):
            print(
                f"{index:2}. {stage.kind:<16} pool={stage.pool:<3} "
                f"lease={stage.lease_s:>6}s  {stage.description}"
            )
        return 0

    settings = get_settings()
    configure_logging(settings.log_level)
    work_dir = args.work_dir or settings.work_dir
    worker_id = args.worker_id or _default_worker_id()
    queue = build_queue(settings, worker_id=worker_id)

    if args.command == "enqueue":
        created = enqueue_debate(queue, args.dokid, priority=args.priority)
        print(f"{'enqueued' if created else 'already queued'}: {args.dokid}")
        return 0

    if args.command == "run":
        worker = Worker(queue, pool=args.pool, work_dir=Path(work_dir))
        # Reap before claiming: a worker starting up is often a worker that just
        # crashed, and its own abandoned job is the most likely thing waiting.
        reaped = queue.reap_expired_leases()
        if reaped.total:
            print(f"recovered expired leases: {reaped}")
        if args.once:
            result = worker.run_once()
            print(_describe(result))
            return 0
        worker.run_forever()
        return 0

    if args.command == "status":
        counts = queue.counts_by_state(entity_id=args.dokid)
        for state, count in counts.items():
            print(f"{state:<10} {count}")
        dead = queue.dead_jobs(limit=10)
        if dead:
            print("\ndead jobs:")
            for job in dead:
                print(f"  {job.kind:<16} {job.entity_id:<16} {job.last_error}")
        return 0

    if args.command == "retry":
        requeued = queue.retry_dead(kind=args.kind, entity_id=args.dokid)
        print(f"requeued {requeued} dead job(s)")
        return 0

    if args.command == "reap":
        print(f"recovered expired leases: {queue.reap_expired_leases()}")
        return 0

    raise ConfigurationError(f"Unhandled command {args.command!r}")


def _describe(result: WorkerResult) -> str:
    if not result.claimed:
        return "no work available"
    line = f"{result.kind} {result.entity_id} -> {result.outcome}"
    if result.successor:
        line += f" (next: {result.successor})"
    if result.error:
        line += f"  error: {result.error}"
    return line


def _default_worker_id() -> str:
    import os
    import socket

    return f"{socket.gethostname()}:{os.getpid()}"


if __name__ == "__main__":
    raise SystemExit(main())
