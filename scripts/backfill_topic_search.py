"""Plan and operate the resumable topic-search semantic backfill.

This script never creates embeddings itself. It estimates passages with the
same TypeScript chunker used by the deployed worker, and enqueues clip IDs into
the existing service-only database RPC in batches of at most 200. Provider
start/stop remains an explicit, separate operator action.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import get_settings  # noqa: E402
from src.errors import ConfigurationError, ExternalServiceError  # noqa: E402
from src.publish.supabase import SupabaseManagementClient  # noqa: E402

CHUNKS_MODULE = REPO_ROOT / "supabase/functions/_shared/search/chunks.ts"
MAX_DATABASE_BATCH = 200
DEFAULT_PAGE_SIZE = 200


@dataclass(frozen=True)
class SearchDocument:
    clip_id: str
    title: str
    transcript: str
    source_hash: str
    semantic_state: str
    completed_index_version: str | None
    has_current_chunks: bool
    queued_for_current: bool

    def is_current(self, index_version: str) -> bool:
        return (
            self.semantic_state == "current"
            and self.completed_index_version == index_version
            and self.has_current_chunks
        )


@dataclass(frozen=True)
class PassageEstimate:
    clip_id: str
    passage_count: int
    input_utf8_bytes: int
    empty_document: bool = False


class BackfillRepository(Protocol):
    def index_version(self) -> str:
        """Return the active semantic index version."""

    def fetch_documents(
        self, after_clip_id: str | None, limit: int, index_version: str
    ) -> list[SearchDocument]:
        """Return one keyset-ordered page of eligible keyword documents."""

    def enqueue(self, clip_ids: Sequence[str], *, force: bool) -> int:
        """Enqueue one bounded batch through the deployed service RPC."""

    def status(self) -> Mapping[str, Any]:
        """Return the deployed index status object."""

    def set_provider(self, *, enabled: bool) -> Mapping[str, Any]:
        """Turn the provider gate on or off and return current status."""

    def dispatch(self, workers: int) -> int:
        """Request a strictly bounded number of existing Edge workers."""


class PassageEstimator(Protocol):
    def estimate(
        self, documents: Sequence[SearchDocument], index_version: str
    ) -> list[PassageEstimate]:
        """Estimate exact passage counts and provider-input UTF-8 bytes."""


class ManagementBackfillRepository:
    """Production repository implemented through Supabase's Management API."""

    def __init__(self, client: SupabaseManagementClient) -> None:
        self._client = client

    def index_version(self) -> str:
        rows = self._rows(
            "select semantic_index_version as index_version "
            "from private.search_system_state where singleton;"
        )
        value = rows[0].get("index_version") if rows else None
        if not isinstance(value, str) or not value:
            raise ExternalServiceError("Semantic index version is not configured")
        return value

    def fetch_documents(
        self, after_clip_id: str | None, limit: int, index_version: str
    ) -> list[SearchDocument]:
        effective_limit = _bounded_integer(limit, 1, 1000, "page size")
        cursor = "true" if after_clip_id is None else (
            f"document.clip_id > {_sql_text(after_clip_id)}"
        )
        version = _sql_text(index_version)
        rows = self._rows(
            f"""
            select
              document.clip_id,
              document.title,
              document.transcript,
              document.source_hash,
              document.semantic_state,
              document.completed_index_version,
              exists (
                select 1
                from private.clip_search_chunks chunk
                where chunk.clip_id = document.clip_id
                  and chunk.source_hash = document.source_hash
                  and chunk.index_version = {version}
              ) as has_current_chunks,
              exists (
                select 1
                from pgmq.q_search_embeddings message
                where message.message ->> 'clipId' = document.clip_id
                  and message.message ->> 'sourceHash' = document.source_hash
                  and message.message ->> 'indexVersion' = {version}
              ) as queued_for_current
            from private.clip_search_documents document
            where {cursor}
            order by document.clip_id
            limit {effective_limit};
            """
        )
        return [_document_from_row(row) for row in rows]

    def enqueue(self, clip_ids: Sequence[str], *, force: bool) -> int:
        if not clip_ids or len(clip_ids) > MAX_DATABASE_BATCH:
            raise ValueError("enqueue batch must contain 1 to 200 clip IDs")
        array = "array[" + ",".join(_sql_text(value) for value in clip_ids) + "]::text[]"
        rows = self._rows(
            "select public.enqueue_search_embedding_batch("
            f"{array}, {'true' if force else 'false'}"
            ") as accepted;"
        )
        value = rows[0].get("accepted") if rows else None
        if not isinstance(value, int):
            raise ExternalServiceError("Invalid enqueue response")
        return value

    def status(self) -> Mapping[str, Any]:
        rows = self._rows("select public.search_embedding_index_status() as status;")
        value = rows[0].get("status") if rows else None
        if not isinstance(value, Mapping):
            raise ExternalServiceError("Invalid semantic index status response")
        return value

    def set_provider(self, *, enabled: bool) -> Mapping[str, Any]:
        if enabled:
            statement = (
                "update private.search_system_state set provider_enabled = true, "
                "provider_kill_switch = false, updated_at = now() where singleton;"
            )
        else:
            statement = (
                "update private.search_system_state set provider_enabled = false, "
                "provider_kill_switch = true, updated_at = now() where singleton;"
            )
        self._client.execute_sql(statement)
        return self.status()

    def dispatch(self, workers: int) -> int:
        effective_workers = _bounded_integer(workers, 1, 4, "workers")
        rows = self._rows(
            "select count(request_id)::int as dispatched from ("
            "select private.dispatch_search_embedding_worker() as request_id "
            f"from pg_catalog.generate_series(1, {effective_workers})"
            ") requested where request_id is not null;"
        )
        value = rows[0].get("dispatched") if rows else None
        if not isinstance(value, int):
            raise ExternalServiceError("Invalid worker dispatch response")
        return value

    def _rows(self, query: str) -> list[Mapping[str, Any]]:
        response = self._client.execute_sql(query)
        candidate: Any = response.get("result", response)
        if isinstance(candidate, Mapping):
            candidate = candidate.get("rows", [])
        if not isinstance(candidate, list):
            return []
        return [row for row in candidate if isinstance(row, Mapping)]


class NodePassageEstimator:
    """Invoke the deployed worker's existing TypeScript passage builder."""

    def __init__(self, node_binary: str | None = None, batch_size: int = 250) -> None:
        self._node = node_binary or shutil.which("node") or ""
        if not self._node:
            raise ConfigurationError("Node.js is required for the dry-run passage estimate")
        self._batch_size = _bounded_integer(batch_size, 1, 1000, "estimator batch size")

    def estimate(
        self, documents: Sequence[SearchDocument], index_version: str
    ) -> list[PassageEstimate]:
        estimates: list[PassageEstimate] = []
        for offset in range(0, len(documents), self._batch_size):
            estimates.extend(
                self._estimate_batch(documents[offset : offset + self._batch_size], index_version)
            )
        return estimates

    def _estimate_batch(
        self, documents: Sequence[SearchDocument], index_version: str
    ) -> list[PassageEstimate]:
        module_url = json.dumps(CHUNKS_MODULE.as_uri())
        program = f"""
          import {{ buildSearchEmbeddingPassages }} from {module_url};
          let raw = '';
          for await (const chunk of process.stdin) raw += chunk;
          const input = JSON.parse(raw);
          const encoder = new TextEncoder();
          const output = [];
          for (const document of input.documents) {{
            try {{
              const passages = await buildSearchEmbeddingPassages(
                {{ title: document.title, transcript: document.transcript }},
                input.indexVersion,
              );
              output.push({{
                clipId: document.clipId,
                passageCount: passages.length,
                inputUtf8Bytes: passages.reduce(
                  (total, passage) => total + encoder.encode(passage.embeddingInput).byteLength,
                  0,
                ),
                emptyDocument: false,
              }});
            }} catch {{
              output.push({{
                clipId: document.clipId,
                passageCount: 0,
                inputUtf8Bytes: 0,
                emptyDocument: true,
              }});
            }}
          }}
          process.stdout.write(JSON.stringify(output));
        """
        payload = {
            "indexVersion": index_version,
            "documents": [
                {"clipId": row.clip_id, "title": row.title, "transcript": row.transcript}
                for row in documents
            ],
        }
        completed = subprocess.run(
            [self._node, "--input-type=module", "--eval", program],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        if completed.returncode != 0:
            detail = completed.stderr.strip().splitlines()[-1:] or ["unknown Node error"]
            raise ExternalServiceError(f"Passage estimator failed: {detail[0]}")
        try:
            values = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise ExternalServiceError("Passage estimator returned invalid JSON") from error
        if not isinstance(values, list) or len(values) != len(documents):
            raise ExternalServiceError("Passage estimator returned the wrong item count")
        return [_estimate_from_value(value) for value in values]


def load_documents(
    repository: BackfillRepository, *, page_size: int, index_version: str
) -> list[SearchDocument]:
    documents: list[SearchDocument] = []
    cursor: str | None = None
    effective_page = _bounded_integer(page_size, 1, 1000, "page size")
    while True:
        page = repository.fetch_documents(cursor, effective_page, index_version)
        if not page:
            break
        if cursor is not None and page[0].clip_id <= cursor:
            raise ExternalServiceError("Backfill document pagination did not advance")
        documents.extend(page)
        cursor = page[-1].clip_id
        if len(page) < effective_page:
            break
    return documents


def build_dry_run_report(
    repository: BackfillRepository,
    estimator: PassageEstimator,
    *,
    page_size: int,
    price_per_million_usd: Decimal,
) -> dict[str, Any]:
    if price_per_million_usd < 0:
        raise ValueError("price per million tokens must not be negative")
    index_version = repository.index_version()
    documents = load_documents(
        repository, page_size=page_size, index_version=index_version
    )
    remaining = [row for row in documents if not row.is_current(index_version)]
    estimates = estimator.estimate(remaining, index_version) if remaining else []
    input_bytes = sum(value.input_utf8_bytes for value in estimates)
    estimated_tokens = math.ceil(input_bytes / 3)
    estimated_cost = (
        Decimal(estimated_tokens) * price_per_million_usd / Decimal(1_000_000)
    )
    return {
        "dryRun": True,
        "indexVersion": index_version,
        "eligibleClips": len(documents),
        "keywordDocuments": len(documents),
        "currentSemanticDocuments": len(documents) - len(remaining),
        "remainingSemanticDocuments": len(remaining),
        "alreadyQueuedDocuments": sum(row.queued_for_current for row in remaining),
        "enqueueCandidates": sum(
            not row.queued_for_current and row.semantic_state != "failed"
            for row in remaining
        ),
        "failedDocuments": sum(row.semantic_state == "failed" for row in documents),
        "missingTitles": sum(not row.title.strip() for row in documents),
        "missingTranscripts": sum(not row.transcript.strip() for row in documents),
        "invalidSourceHashes": sum(
            len(row.source_hash) != 64
            or any(character not in "0123456789abcdef" for character in row.source_hash)
            for row in documents
        ),
        "estimatedPassages": sum(value.passage_count for value in estimates),
        "emptyDocuments": sum(value.empty_document for value in estimates),
        "embeddingInputUtf8Bytes": input_bytes,
        "estimatedProviderTokens": estimated_tokens,
        "tokenEstimateMethod": "ceil(embedding_input_utf8_bytes / 3)",
        "pricePerMillionUsd": str(price_per_million_usd),
        "estimatedCostUsd": format(estimated_cost, ".6f"),
    }


def enqueue_backfill(
    repository: BackfillRepository,
    *,
    page_size: int,
    batch_size: int,
    max_enqueue: int | None,
) -> dict[str, Any]:
    index_version = repository.index_version()
    documents = load_documents(
        repository, page_size=page_size, index_version=index_version
    )
    candidates = [
        row.clip_id
        for row in documents
        if not row.is_current(index_version)
        and not row.queued_for_current
        and row.semantic_state != "failed"
    ]
    return _enqueue_candidates(
        repository,
        candidates,
        batch_size=batch_size,
        max_enqueue=max_enqueue,
        force=False,
        operation="enqueue",
        index_version=index_version,
    )


def retry_failed(
    repository: BackfillRepository,
    *,
    page_size: int,
    batch_size: int,
    max_enqueue: int | None,
) -> dict[str, Any]:
    index_version = repository.index_version()
    documents = load_documents(
        repository, page_size=page_size, index_version=index_version
    )
    candidates = [
        row.clip_id
        for row in documents
        if row.semantic_state == "failed" and not row.queued_for_current
    ]
    return _enqueue_candidates(
        repository,
        candidates,
        batch_size=batch_size,
        max_enqueue=max_enqueue,
        force=True,
        operation="retry_failed",
        index_version=index_version,
    )


def _enqueue_candidates(
    repository: BackfillRepository,
    candidates: Sequence[str],
    *,
    batch_size: int,
    max_enqueue: int | None,
    force: bool,
    operation: str,
    index_version: str,
) -> dict[str, Any]:
    effective_batch = _bounded_integer(
        batch_size, 1, MAX_DATABASE_BATCH, "batch size"
    )
    if max_enqueue is not None and max_enqueue < 0:
        raise ValueError("max enqueue must not be negative")
    selected = list(candidates[:max_enqueue] if max_enqueue is not None else candidates)
    accepted = 0
    batches = 0
    for offset in range(0, len(selected), effective_batch):
        batch = selected[offset : offset + effective_batch]
        accepted += repository.enqueue(batch, force=force)
        batches += 1
    return {
        "operation": operation,
        "indexVersion": index_version,
        "availableCandidates": len(candidates),
        "selectedCandidates": len(selected),
        "accepted": accepted,
        "batches": batches,
        "batchSize": effective_batch,
        "noOp": len(selected) == 0,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    dry_run = subparsers.add_parser("dry-run", help="Estimate coverage and cost without writes")
    dry_run.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    dry_run.add_argument(
        "--price-per-million-usd",
        type=Decimal,
        required=True,
        help="Current official input-token price; deliberately not hardcoded",
    )
    dry_run.add_argument("--node", help="Node.js executable used for the shared chunker")

    for command, help_text in (
        ("enqueue", "Enqueue missing, non-failed documents without enabling the provider"),
        ("retry-failed", "Re-enqueue explicitly failed documents with force=true"),
    ):
        operation = subparsers.add_parser(command, help=help_text)
        operation.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
        operation.add_argument("--batch-size", type=int, default=100)
        operation.add_argument("--max-enqueue", type=int)

    subparsers.add_parser("status", help="Show queue, coverage, failures and provider gate")
    subparsers.add_parser("start", help="Enable the cron worker after explicit spend approval")
    subparsers.add_parser("stop", help="Disable the provider and turn on the kill switch")
    dispatch = subparsers.add_parser(
        "dispatch",
        help="Request 1-4 existing Edge workers; the database queue remains authoritative",
    )
    dispatch.add_argument("--workers", type=int, default=1)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repository = _production_repository()
    if args.command == "dry-run":
        output = build_dry_run_report(
            repository,
            NodePassageEstimator(args.node),
            page_size=args.page_size,
            price_per_million_usd=args.price_per_million_usd,
        )
    elif args.command == "enqueue":
        output = enqueue_backfill(
            repository,
            page_size=args.page_size,
            batch_size=args.batch_size,
            max_enqueue=args.max_enqueue,
        )
    elif args.command == "retry-failed":
        output = retry_failed(
            repository,
            page_size=args.page_size,
            batch_size=args.batch_size,
            max_enqueue=args.max_enqueue,
        )
    elif args.command == "status":
        output = dict(repository.status())
    elif args.command == "start":
        output = dict(repository.set_provider(enabled=True))
    elif args.command == "stop":
        output = dict(repository.set_provider(enabled=False))
    else:
        workers = _bounded_integer(args.workers, 1, 4, "workers")
        output = {
            "operation": "dispatch",
            "requestedWorkers": workers,
            "dispatchedWorkers": repository.dispatch(workers),
        }
    print(json.dumps(output, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


def _production_repository() -> ManagementBackfillRepository:
    settings = get_settings()
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        raise ConfigurationError(
            "Set RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN"
        )
    return ManagementBackfillRepository(
        SupabaseManagementClient(
            project_ref=settings.supabase_project_ref,
            access_token=settings.supabase_access_token,
            timeout_s=settings.http_timeout_s,
            max_retries=settings.max_http_retries,
        )
    )


def _document_from_row(row: Mapping[str, Any]) -> SearchDocument:
    required = ("clip_id", "title", "transcript", "source_hash", "semantic_state")
    if any(not isinstance(row.get(field), str) for field in required):
        raise ExternalServiceError("Invalid backfill document row")
    completed = row.get("completed_index_version")
    if completed is not None and not isinstance(completed, str):
        raise ExternalServiceError("Invalid completed index version")
    return SearchDocument(
        clip_id=str(row["clip_id"]),
        title=str(row["title"]),
        transcript=str(row["transcript"]),
        source_hash=str(row["source_hash"]),
        semantic_state=str(row["semantic_state"]),
        completed_index_version=completed,
        has_current_chunks=bool(row.get("has_current_chunks")),
        queued_for_current=bool(row.get("queued_for_current")),
    )


def _estimate_from_value(value: Any) -> PassageEstimate:
    if not isinstance(value, Mapping):
        raise ExternalServiceError("Invalid passage estimate")
    clip_id = value.get("clipId")
    passages = value.get("passageCount")
    input_bytes = value.get("inputUtf8Bytes")
    empty = value.get("emptyDocument")
    if (
        not isinstance(clip_id, str)
        or not isinstance(passages, int)
        or passages < 0
        or not isinstance(input_bytes, int)
        or input_bytes < 0
        or not isinstance(empty, bool)
    ):
        raise ExternalServiceError("Invalid passage estimate")
    return PassageEstimate(clip_id, passages, input_bytes, empty)


def _bounded_integer(value: int, minimum: int, maximum: int, label: str) -> int:
    if value < minimum or value > maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}")
    return value


def _sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


if __name__ == "__main__":
    raise SystemExit(main())
