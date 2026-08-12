"""Regression tests for the single-process orchestrator daemon."""

from __future__ import annotations

from src.orchestrator.cli import WorkerResult, _poll_workers_once


class RecordingWorker:
    def __init__(self, *, claimed: bool) -> None:
        self.claimed = claimed
        self.calls = 0

    def run_once(self) -> WorkerResult:
        self.calls += 1
        return WorkerResult(claimed=self.claimed)


def test_daemon_polls_every_pool_when_the_first_pool_claims_work() -> None:
    workers = [
        RecordingWorker(claimed=True),
        RecordingWorker(claimed=False),
        RecordingWorker(claimed=False),
    ]

    worked = _poll_workers_once(workers)  # type: ignore[arg-type]

    assert worked is True
    assert [worker.calls for worker in workers] == [1, 1, 1]


def test_daemon_reports_idle_only_when_every_pool_is_idle() -> None:
    workers = [RecordingWorker(claimed=False), RecordingWorker(claimed=False)]

    worked = _poll_workers_once(workers)  # type: ignore[arg-type]

    assert worked is False
    assert [worker.calls for worker in workers] == [1, 1]
