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
from datetime import UTC, date, datetime
from pathlib import Path

from src.config import Settings, get_settings
from src.errors import ConfigurationError, NotClippableError, PipelineError
from src.logging import configure_logging, stage_logger
from src.orchestrator.discovery import (
    DEFAULT_MAX_ENQUEUE,
    DiscoveryResult,
    backfill_window,
    build_client,
    discover_and_enqueue,
    seed_watermark,
)
from src.orchestrator.jobs import (
    MAX_LEASE_S,
    STAGE_GRAPH,
    advance_after,
    enqueue_debate,
    stage_for,
)
from src.orchestrator.queue import Job, JobQueue
from src.publish.supabase import SupabaseManagementClient

#: How often the daemon looks for new debates. Riksdagen publishes a handful of
#: videos a day, so anything under ~15 minutes is polling a public service for
#: no reason.
DEFAULT_DISCOVERY_INTERVAL_S = 1800

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
        except NotClippableError as error:
            # Nothing to do, and no amount of retrying will change that.
            self.queue.skip(job, str(error))
            result.outcome = "skipped"
            self.logger.info(
                "job_skipped",
                job_id=job.id,
                kind=job.kind,
                dokid=job.entity_id,
                reason=str(error),
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            return result
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
        # Complete first, then decide what is next: the join barrier counts this
        # job as done, so the last sibling through sees zero outstanding.
        result.successor = advance_after(
            self.queue,
            self.queue,
            kind=job.kind,
            entity_id=job.entity_id,
            job_id=job.id,
            parent_id=job.parent_id,
            payload=job.payload,
            work_dir=self.work_dir,
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

        if stage.fans_out_to is not None:
            # A fan-out job runs no stage of its own; `advance_after` enqueues
            # its children once this returns.
            return

        entrypoint = stage.resolve()
        if stage.joins_siblings:
            # A per-unit job: its entity_id is the unit, and the debate it
            # belongs to travels in the payload.
            dokid = job.payload.get("dokid")
            if not isinstance(dokid, str) or not dokid:
                raise ConfigurationError(
                    f"{job.kind} job {job.id} has no dokid in its payload"
                )
            entrypoint(dokid, job.entity_id, work_dir=self.work_dir)
            return

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

    discover_parser = subparsers.add_parser(
        "discover", help="Poll Riksdagen for new debates and enqueue them"
    )
    discover_parser.add_argument(
        "--max-enqueue", type=int, default=DEFAULT_MAX_ENQUEUE,
        help="Safety cap per pass. Deferred debates are found again next time.",
    )
    discover_parser.add_argument(
        "--dry-run", action="store_true",
        help="Report what would be enqueued without enqueuing or moving the watermark.",
    )
    discover_parser.add_argument(
        "--since", default=None, metavar="YYYY-MM-DD",
        help=(
            "Seed the watermark, then discover. Use `now` to ignore the back "
            "catalogue and only process debates published from here on. Without "
            "this, a fresh machine starts working through Riksdagen's archive."
        ),
    )

    daemon_parser = subparsers.add_parser(
        "daemon", help="Discover on an interval and work every pool. One workstation, one process."
    )
    daemon_parser.add_argument(
        "--interval", type=int, default=DEFAULT_DISCOVERY_INTERVAL_S,
        help="Seconds between discovery passes.",
    )
    daemon_parser.add_argument(
        "--pools", default="io,cpu,gpu",
        help="Comma-separated pools this machine serves.",
    )
    daemon_parser.add_argument(
        "--max-enqueue", type=int, default=DEFAULT_MAX_ENQUEUE,
    )

    backfill_parser = subparsers.add_parser(
        "backfill", help="Enqueue a bounded historical window. Does not touch the watermark."
    )
    backfill_parser.add_argument("--from", dest="from_date", required=True, metavar="YYYY-MM-DD")
    backfill_parser.add_argument("--to", dest="to_date", required=True, metavar="YYYY-MM-DD")
    backfill_parser.add_argument("--max-enqueue", type=int, default=500)
    backfill_parser.add_argument("--dry-run", action="store_true")

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

    if args.command == "discover":
        if args.since:
            since = (
                datetime.now(tz=UTC)
                if args.since.lower() == "now"
                else datetime.fromisoformat(args.since).replace(tzinfo=UTC)
            )
            seed_watermark(Path(work_dir), since)
            print(f"watermark seeded to {since.isoformat()}")
        discovered = _discover(settings, queue, Path(work_dir), args.max_enqueue, args.dry_run)
        print(discovered.summary())
        for dokid in discovered.enqueued:
            print(f"  enqueued  {dokid}")
        for dokid in discovered.skipped_over_cap:
            print(f"  deferred  {dokid}  (over --max-enqueue; found again next pass)")
        return 0

    if args.command == "backfill":
        client = build_client(
            user_agent=settings.riksdagen_user_agent,
            timeout_s=settings.http_timeout_s,
            max_retries=settings.max_http_retries,
        )
        window = backfill_window(
            client,
            queue,
            since=date.fromisoformat(args.from_date),
            until=date.fromisoformat(args.to_date),
            max_enqueue=args.max_enqueue,
            dry_run=args.dry_run,
        )
        print(f"{args.from_date} .. {args.to_date}: {window.summary()}")
        for dokid in window.enqueued:
            print(f"  enqueued  {dokid}")
        if window.skipped_over_cap:
            print(f"  {len(window.skipped_over_cap)} over --max-enqueue; narrow the window")
        return 0

    if args.command == "daemon":
        return _run_daemon(
            settings,
            queue,
            work_dir=Path(work_dir),
            pools=[pool.strip() for pool in args.pools.split(",") if pool.strip()],
            interval_s=args.interval,
            max_enqueue=args.max_enqueue,
        )

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


def _discover(
    settings: Settings,
    queue: JobQueue,
    work_dir: Path,
    max_enqueue: int,
    dry_run: bool,
) -> DiscoveryResult:
    """One discovery pass against Riksdagen."""

    client = build_client(
        user_agent=settings.riksdagen_user_agent,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )
    return discover_and_enqueue(
        client,
        queue,
        work_dir=work_dir,
        max_enqueue=max_enqueue,
        dry_run=dry_run,
    )


def _run_daemon(
    settings: Settings,
    queue: JobQueue,
    *,
    work_dir: Path,
    pools: list[str],
    interval_s: int,
    max_enqueue: int,
) -> int:
    """Discover on an interval and work every pool, in one process.

    Deliberately not three processes. This runs on one workstation with one GPU
    and one set of cores, so pool separation would buy nothing but three
    terminals to forget about. Split them when there is a second machine.

    Ordering matters: work is drained before discovering more. A machine that is
    only on for a few hours should finish what it started rather than collecting
    a backlog it will never process.
    """

    logger = stage_logger("C12_daemon", pools=",".join(pools))
    workers = [Worker(queue, pool=pool, work_dir=work_dir) for pool in pools]

    reaped = queue.reap_expired_leases()
    if reaped.total:
        logger.info("leases_recovered", requeued=reaped.requeued, dead=reaped.dead)

    last_discovery = 0.0
    logger.info("daemon_started", interval_s=interval_s, work_dir=str(work_dir))

    while True:
        now = time.monotonic()
        if now - last_discovery >= interval_s:
            last_discovery = now
            try:
                result = _discover(settings, queue, work_dir, max_enqueue, dry_run=False)
                logger.info(
                    "discovery_pass",
                    found=result.found,
                    enqueued=len(result.enqueued),
                    deferred=len(result.skipped_over_cap),
                    possible_gap=result.possible_gap,
                )
                if result.possible_gap:
                    logger.warning(
                        "discovery_possible_gap",
                        detail=(
                            "the document list page did not reach back to the watermark; "
                            "older debates may have been missed"
                        ),
                    )
            except Exception as error:
                # Riksdagen being unreachable must not stop the worker loop.
                # There may be hours of queued work that has nothing to do with
                # discovery.
                logger.error("discovery_failed", error=str(error))

        worked = any(worker.run_once().claimed for worker in workers)
        if not worked:
            # Nothing to do. Sleep briefly rather than spinning, but stay well
            # under the discovery interval so new work is picked up promptly.
            time.sleep(IDLE_POLL_S)
            queue.reap_expired_leases()


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
