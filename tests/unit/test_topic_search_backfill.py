"""UI16.5 dry-run, resume, retry and provider-gate tests."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

from scripts.backfill_topic_search import (
    PassageEstimate,
    SearchDocument,
    build_dry_run_report,
    enqueue_backfill,
    load_documents,
    retry_failed,
)

INDEX_VERSION = "openai:text-embedding-3-large:1024:v1"


class FakeRepository:
    def __init__(self, documents: Sequence[SearchDocument]) -> None:
        self.documents = list(documents)
        self.enqueued: list[tuple[list[str], bool]] = []
        self.provider_enabled = False
        self.dispatched: list[int] = []

    def index_version(self) -> str:
        return INDEX_VERSION

    def fetch_documents(
        self, after_clip_id: str | None, limit: int, index_version: str
    ) -> list[SearchDocument]:
        assert index_version == INDEX_VERSION
        candidates = [
            row for row in self.documents if after_clip_id is None or row.clip_id > after_clip_id
        ]
        return candidates[:limit]

    def enqueue(self, clip_ids: Sequence[str], *, force: bool) -> int:
        self.enqueued.append((list(clip_ids), force))
        return len(clip_ids)

    def status(self) -> Mapping[str, Any]:
        return {"providerEnabled": self.provider_enabled, "killSwitch": not self.provider_enabled}

    def set_provider(self, *, enabled: bool) -> Mapping[str, Any]:
        self.provider_enabled = enabled
        return self.status()

    def dispatch(self, workers: int) -> int:
        self.dispatched.append(workers)
        return workers if self.provider_enabled else 0


class FakeEstimator:
    def __init__(self, values: Mapping[str, PassageEstimate]) -> None:
        self.values = values
        self.calls: list[list[str]] = []

    def estimate(
        self, documents: Sequence[SearchDocument], index_version: str
    ) -> list[PassageEstimate]:
        assert index_version == INDEX_VERSION
        self.calls.append([row.clip_id for row in documents])
        return [self.values[row.clip_id] for row in documents]


def document(
    clip_id: str,
    *,
    state: str = "pending",
    current: bool = False,
    queued: bool = False,
    title: str = "Titel",
    transcript: str = "Ett svenskt tal.",
) -> SearchDocument:
    return SearchDocument(
        clip_id=clip_id,
        title=title,
        transcript=transcript,
        source_hash="a" * 64,
        semantic_state="current" if current else state,
        completed_index_version=INDEX_VERSION if current else None,
        has_current_chunks=current,
        queued_for_current=queued,
    )


def test_dry_run_reports_coverage_passages_conservative_tokens_and_cost() -> None:
    repository = FakeRepository(
        [
            document("clip-a", current=True),
            document("clip-b", queued=True, transcript=""),
            document("clip-c", state="failed", title=""),
        ]
    )
    estimator = FakeEstimator(
        {
            "clip-b": PassageEstimate("clip-b", 2, 3000),
            "clip-c": PassageEstimate("clip-c", 1, 1500),
        }
    )

    report = build_dry_run_report(
        repository,
        estimator,
        page_size=2,
        price_per_million_usd=Decimal("0.13"),
    )

    assert report == {
        "dryRun": True,
        "indexVersion": INDEX_VERSION,
        "eligibleClips": 3,
        "keywordDocuments": 3,
        "currentSemanticDocuments": 1,
        "remainingSemanticDocuments": 2,
        "alreadyQueuedDocuments": 1,
        "enqueueCandidates": 0,
        "failedDocuments": 1,
        "missingTitles": 1,
        "missingTranscripts": 1,
        "invalidSourceHashes": 0,
        "estimatedPassages": 3,
        "emptyDocuments": 0,
        "embeddingInputUtf8Bytes": 4500,
        "estimatedProviderTokens": 1500,
        "tokenEstimateMethod": "ceil(embedding_input_utf8_bytes / 3)",
        "pricePerMillionUsd": "0.13",
        "estimatedCostUsd": "0.000195",
    }
    assert estimator.calls == [["clip-b", "clip-c"]]
    assert repository.enqueued == []


def test_enqueue_is_bounded_skips_current_queued_and_failed_and_resumes() -> None:
    repository = FakeRepository(
        [
            document("clip-a"),
            document("clip-b"),
            document("clip-c", queued=True),
            document("clip-d", state="failed"),
            document("clip-e", current=True),
        ]
    )

    result = enqueue_backfill(
        repository,
        page_size=2,
        batch_size=1,
        max_enqueue=1,
    )

    assert result["availableCandidates"] == 2
    assert result["selectedCandidates"] == 1
    assert result["accepted"] == 1
    assert result["batches"] == 1
    assert result["noOp"] is False
    assert repository.enqueued == [(["clip-a"], False)]


def test_retry_failed_uses_force_and_obeys_database_batch_ceiling() -> None:
    repository = FakeRepository(
        [document(f"clip-{index:03}", state="failed") for index in range(205)]
    )

    result = retry_failed(
        repository,
        page_size=100,
        batch_size=200,
        max_enqueue=None,
    )

    assert result["accepted"] == 205
    assert [len(batch) for batch, _force in repository.enqueued] == [200, 5]
    assert all(force for _batch, force in repository.enqueued)


def test_complete_catalogue_rerun_is_a_no_op_without_estimation_or_enqueue() -> None:
    repository = FakeRepository([document("clip-a", current=True)])
    estimator = FakeEstimator({})

    report = build_dry_run_report(
        repository,
        estimator,
        page_size=100,
        price_per_million_usd=Decimal("0.13"),
    )
    enqueue_result = enqueue_backfill(
        repository,
        page_size=100,
        batch_size=100,
        max_enqueue=None,
    )

    assert report["remainingSemanticDocuments"] == 0
    assert report["estimatedCostUsd"] == "0.000000"
    assert estimator.calls == []
    assert enqueue_result["noOp"] is True
    assert repository.enqueued == []


def test_keyset_pagination_collects_every_document_once() -> None:
    repository = FakeRepository(
        [document("clip-a"), document("clip-b"), document("clip-c")]
    )

    result = load_documents(repository, page_size=2, index_version=INDEX_VERSION)

    assert [row.clip_id for row in result] == ["clip-a", "clip-b", "clip-c"]


def test_start_and_stop_are_explicit_and_status_is_observable() -> None:
    repository = FakeRepository([])

    started = repository.set_provider(enabled=True)
    stopped = repository.set_provider(enabled=False)

    assert started == {"providerEnabled": True, "killSwitch": False}
    assert stopped == {"providerEnabled": False, "killSwitch": True}


def test_worker_dispatch_is_explicit_and_bounded_by_the_repository_contract() -> None:
    repository = FakeRepository([])

    assert repository.dispatch(4) == 0
    repository.set_provider(enabled=True)
    assert repository.dispatch(2) == 2

    assert repository.dispatched == [4, 2]
