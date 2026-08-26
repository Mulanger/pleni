"""Evaluate UI16 topic-search rankings against a frozen Swedish judgment set.

The default command is offline and provider-free.  ``capture-live`` is an
explicit operator action: it reads the current production catalogue, spends a
small amount on query embeddings, and prints a candidate snapshot for review.
It never changes database state and never logs query text or credentials.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DOCUMENTS = ROOT / "tests" / "fixtures" / "search" / "documents.json"
DEFAULT_JUDGMENTS = ROOT / "tests" / "fixtures" / "search" / "judgments.json"
DEFAULT_EXPECTED = ROOT / "tests" / "fixtures" / "search" / "expected.json"
MODES = ("keyword", "semantic", "hybrid")
MAX_RANK = 10
OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
SUPABASE_MANAGEMENT_BASE = "https://api.supabase.com/v1"


class EvaluationError(ValueError):
    """Raised when an evaluation fixture is incomplete or inconsistent."""


@dataclass(frozen=True)
class ModeMetrics:
    mean_ndcg_at_10: float
    relevant_top_three: int
    evaluated_queries: int


def _load_json(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvaluationError(f"cannot read {path}: {exc}") from exc
    if not isinstance(value, Mapping):
        raise EvaluationError(f"{path} must contain a JSON object")
    return value


def _required_list(value: Mapping[str, Any], key: str) -> list[Any]:
    candidate = value.get(key)
    if not isinstance(candidate, list):
        raise EvaluationError(f"{key} must be a list")
    return candidate


def _required_string(value: Mapping[str, Any], key: str) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or not candidate.strip():
        raise EvaluationError(f"{key} must be a non-empty string")
    return candidate


def percentile(values: Sequence[float], percentile_value: float) -> float | None:
    """Return a nearest-rank percentile, or ``None`` for an empty sample."""

    if not values:
        return None
    if not 0 < percentile_value <= 1:
        raise EvaluationError("percentile must be greater than zero and at most one")
    ordered = sorted(float(value) for value in values)
    return ordered[max(0, math.ceil(percentile_value * len(ordered)) - 1)]


def dcg(grades: Sequence[int], rank: int = MAX_RANK) -> float:
    """Compute graded discounted cumulative gain with exponential gain."""

    return sum(
        ((2**grade) - 1) / math.log2(position + 2) for position, grade in enumerate(grades[:rank])
    )


def ndcg(ranked_ids: Sequence[str], grades: Mapping[str, int], rank: int = MAX_RANK) -> float:
    """Compute nDCG for one ranked list; an all-zero judgment has score 1."""

    actual = [grades.get(clip_id, 0) for clip_id in ranked_ids[:rank]]
    ideal = sorted(grades.values(), reverse=True)[:rank]
    ideal_gain = dcg(ideal, rank)
    if ideal_gain == 0:
        return 1.0 if not any(actual) else 0.0
    return dcg(actual, rank) / ideal_gain


def _validate_queries(judgments: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    query_rows = _required_list(judgments, "queries")
    by_id: dict[str, Mapping[str, Any]] = {}
    seen_text: set[str] = set()
    for raw in query_rows:
        if not isinstance(raw, Mapping):
            raise EvaluationError("every judgment query must be an object")
        query_id = _required_string(raw, "id")
        query = _required_string(raw, "query")
        if query_id in by_id:
            raise EvaluationError(f"duplicate query id: {query_id}")
        normalized = " ".join(query.casefold().split())
        if normalized in seen_text:
            raise EvaluationError(f"duplicate query text: {query}")
        if len(query) > 120:
            raise EvaluationError(f"query exceeds production limit: {query_id}")
        seen_text.add(normalized)
        by_id[query_id] = raw
    if len(by_id) < 30:
        raise EvaluationError("at least 30 Swedish evaluation queries are required")
    return by_id


def _validate_runs(
    documents: Mapping[str, Any], query_ids: set[str]
) -> dict[str, Mapping[str, Any]]:
    run_rows = _required_list(documents, "runs")
    by_id: dict[str, Mapping[str, Any]] = {}
    for raw in run_rows:
        if not isinstance(raw, Mapping):
            raise EvaluationError("every document run must be an object")
        query_id = _required_string(raw, "queryId")
        if query_id in by_id:
            raise EvaluationError(f"duplicate run: {query_id}")
        if query_id not in query_ids:
            raise EvaluationError(f"run has unknown query id: {query_id}")
        rankings = raw.get("rankings")
        if not isinstance(rankings, Mapping):
            raise EvaluationError(f"rankings missing for {query_id}")
        for mode in MODES:
            ranking = rankings.get(mode)
            if not isinstance(ranking, list) or not all(
                isinstance(clip_id, str) and clip_id for clip_id in ranking
            ):
                raise EvaluationError(f"invalid {mode} ranking for {query_id}")
            if len(ranking) > MAX_RANK or len(ranking) != len(set(ranking)):
                raise EvaluationError(f"invalid {mode} rank length/duplicates for {query_id}")
        by_id[query_id] = raw
    if set(by_id) != query_ids:
        missing = ", ".join(sorted(query_ids - set(by_id)))
        raise EvaluationError(f"document runs do not cover every query: {missing}")
    return by_id


def _judgment_grades(query: Mapping[str, Any]) -> dict[str, int]:
    rows = query.get("judgments")
    if not isinstance(rows, list):
        raise EvaluationError(f"judgments must be a list for {_required_string(query, 'id')}")
    grades: dict[str, int] = {}
    for raw in rows:
        if not isinstance(raw, Mapping):
            raise EvaluationError("each clip judgment must be an object")
        clip_id = _required_string(raw, "clipId")
        grade = raw.get("grade")
        if not isinstance(grade, int) or isinstance(grade, bool) or not 0 <= grade <= 3:
            raise EvaluationError(f"grade must be an integer from 0 to 3: {clip_id}")
        if clip_id in grades:
            raise EvaluationError(f"duplicate clip judgment: {clip_id}")
        grades[clip_id] = grade
    return grades


def evaluate(
    documents: Mapping[str, Any],
    judgments: Mapping[str, Any],
    expected: Mapping[str, Any],
) -> dict[str, Any]:
    """Validate fixtures and return quality, coverage and release-gate evidence."""

    queries = _validate_queries(judgments)
    runs = _validate_runs(documents, set(queries))
    thresholds = expected.get("thresholds")
    if not isinstance(thresholds, Mapping):
        raise EvaluationError("expected.thresholds must be an object")

    per_mode_scores: dict[str, list[float]] = {mode: [] for mode in MODES}
    per_mode_top_three: dict[str, int] = {mode: 0 for mode in MODES}
    per_query: list[dict[str, Any]] = []
    complete_pools = 0
    complete_ranking_evidence = 0
    manual_queries = 0
    exact_failures: list[str] = []
    negative_failures: list[str] = []
    exact_required = sum(bool(query.get("requiresExactTopThree")) for query in queries.values())
    negative_required = sum(bool(query.get("expectedNoResults")) for query in queries.values())
    exact_evaluated = 0
    negative_evaluated = 0

    for query_id, query in queries.items():
        run = runs[query_id]
        rankings = run["rankings"]
        assert isinstance(rankings, Mapping)
        grades = _judgment_grades(query)
        review_status = query.get("reviewStatus")
        if review_status == "manual_complete":
            manual_queries += 1
        pool = {clip_id for mode in MODES for clip_id in rankings[mode] if isinstance(clip_id, str)}
        evidence_complete = run.get("retrievalEvidenceComplete") is True
        pool_complete = pool.issubset(grades) and evidence_complete
        complete_pools += int(pool_complete and review_status == "manual_complete")
        complete_ranking_evidence += int(evidence_complete)
        eligible_for_metrics = review_status == "manual_complete" and pool_complete
        query_scores: dict[str, float | None] = {}
        for mode in MODES:
            ranking = rankings[mode]
            assert isinstance(ranking, list)
            score = ndcg(ranking, grades)
            query_scores[mode] = score if eligible_for_metrics else None
            if eligible_for_metrics:
                per_mode_scores[mode].append(score)
                if any(grades.get(clip_id, 0) >= 1 for clip_id in ranking[:3]):
                    per_mode_top_three[mode] += 1

        hybrid = rankings["hybrid"]
        assert isinstance(hybrid, list)
        if eligible_for_metrics and query.get("requiresExactTopThree"):
            exact_evaluated += 1
            if not any(grades.get(clip_id, 0) >= 2 for clip_id in hybrid[:3]):
                exact_failures.append(query_id)
        # Empty-result expectations are observable retrieval facts and do not
        # require a human relevance grade. They still require a complete live
        # capture so an absent pool cannot be mistaken for an honest empty.
        if evidence_complete and query.get("expectedNoResults"):
            negative_evaluated += 1
            if hybrid:
                negative_failures.append(query_id)
        per_query.append(
            {
                "id": query_id,
                "category": query.get("category"),
                "retrievalEvidenceComplete": evidence_complete,
                "poolComplete": pool_complete,
                "ndcgAt10": query_scores,
            }
        )

    metrics: dict[str, ModeMetrics] = {}
    for mode in MODES:
        values = per_mode_scores[mode]
        metrics[mode] = ModeMetrics(
            mean_ndcg_at_10=statistics.fmean(values) if values else 0.0,
            relevant_top_three=per_mode_top_three[mode],
            evaluated_queries=len(values),
        )

    operations = documents.get("operations")
    if not isinstance(operations, Mapping):
        operations = {}
    corpus = documents.get("corpus")
    if not isinstance(corpus, Mapping):
        corpus = {}
    eligible = int(corpus.get("eligibleDocuments", 0) or 0)
    keyword_current = int(corpus.get("keywordDocuments", 0) or 0)
    semantic_current = int(corpus.get("semanticCurrent", 0) or 0)
    semantic_exceptions = corpus.get("semanticExceptions")
    if not isinstance(semantic_exceptions, list):
        semantic_exceptions = []
    latency = operations.get("submittedSearchLatencyMs")
    index_lag = operations.get("futureIndexLagMs")
    latency_values = [float(value) for value in latency] if isinstance(latency, list) else []
    lag_values = [float(value) for value in index_lag] if isinstance(index_lag, list) else []

    hybrid = metrics["hybrid"]
    min_ndcg = float(thresholds.get("hybridNdcgAt10", 0.75))
    min_top_three = int(thresholds.get("relevantTopThreeQueries", 24))
    max_latency = float(thresholds.get("submittedSearchP95Ms", 1500))
    max_index_lag = float(thresholds.get("futureIndexLagP95Ms", 120000))
    quality_gates = {
        "manualJudgments": manual_queries >= 30,
        "completeRankingEvidence": complete_ranking_evidence == len(queries),
        "completeJudgedPools": complete_pools == len(queries),
        "hybridNdcg": hybrid.mean_ndcg_at_10 >= min_ndcg,
        "hybridTopThree": hybrid.relevant_top_three >= min_top_three,
        "hybridBeatsKeyword": hybrid.evaluated_queries >= 30
        and hybrid.mean_ndcg_at_10 >= metrics["keyword"].mean_ndcg_at_10,
        "hybridBeatsSemantic": hybrid.evaluated_queries >= 30
        and hybrid.mean_ndcg_at_10 >= metrics["semantic"].mean_ndcg_at_10,
        "exactTopThree": exact_evaluated == exact_required and not exact_failures,
        "negativeQueriesEmpty": negative_evaluated == negative_required and not negative_failures,
    }
    latency_p95 = percentile(latency_values, 0.95)
    lag_p95 = percentile(lag_values, 0.95)
    operational_gates = {
        "submittedSearchP95": latency_p95 is not None and latency_p95 < max_latency,
        "keywordCoverage": eligible > 0 and keyword_current == eligible,
        "semanticCoverage": eligible > 0
        and semantic_current + len(semantic_exceptions) == eligible,
        "futureIndexLagP95": lag_p95 is not None and lag_p95 < max_index_lag,
    }
    release = expected.get("releaseEvidence")
    if not isinstance(release, Mapping):
        release = {}
    release_gates = {
        key: release.get(key) is True
        for key in (
            "privatePrivilegeMatrixPassed",
            "actualOpenAIProjectRegionVerified",
            "actualOpenAIProjectRetentionVerified",
            "privacyCopyApproved",
            "rollbackRehearsed",
            "physicalDeviceAccepted",
            "ownerGoNoGoApproved",
        )
    }
    all_gates = {**quality_gates, **operational_gates, **release_gates}
    failed = [key for key, passed in all_gates.items() if not passed]
    readiness = (
        "ready"
        if not failed
        else ("share_with_caveats" if all(quality_gates.values()) else "needs_revision")
    )

    return {
        "schemaVersion": 1,
        "readiness": readiness,
        "queryCount": len(queries),
        "manualQueryCount": manual_queries,
        "completeRankingEvidenceCount": complete_ranking_evidence,
        "completePoolCount": complete_pools,
        "modes": {
            mode: {
                "meanNdcgAt10": round(value.mean_ndcg_at_10, 6),
                "relevantTopThree": value.relevant_top_three,
                "evaluatedQueries": value.evaluated_queries,
            }
            for mode, value in metrics.items()
        },
        "latency": {"sampleCount": len(latency_values), "p95Ms": latency_p95},
        "indexLag": {"sampleCount": len(lag_values), "p95Ms": lag_p95},
        "coverage": {
            "eligible": eligible,
            "keywordCurrent": keyword_current,
            "semanticCurrent": semantic_current,
            "semanticExceptionCount": len(semantic_exceptions),
        },
        "qualityGates": quality_gates,
        "operationalGates": operational_gates,
        "releaseGates": release_gates,
        "failedGates": failed,
        "exactFailures": exact_failures,
        "negativeFailures": negative_failures,
        "queries": per_query,
    }


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _secret(name: str, env_file: Mapping[str, str]) -> str:
    # An explicitly selected --env-file is the operator's source of truth.
    # Desktop/agent processes can retain stale inherited variables for days;
    # letting those silently override the requested file makes a successful
    # credential repair appear broken and can point evaluation at another
    # Supabase project.
    value = env_file.get(name) or os.environ.get(name)
    if not value:
        raise EvaluationError(f"missing required environment value: {name}")
    return value


def _post_json(url: str, headers: Mapping[str, str], payload: object) -> Any:
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "Pleni-Topic-Search-Evaluation/1.0",
        **dict(headers),
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=request_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise EvaluationError(f"remote request failed with HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise EvaluationError(f"remote request failed: {type(exc).__name__}") from exc


def _sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _vector_text(vector: Sequence[Any]) -> str:
    if len(vector) != 1024:
        raise EvaluationError(f"provider returned {len(vector)} dimensions, expected 1024")
    values: list[str] = []
    for raw in vector:
        value = float(raw)
        if not math.isfinite(value):
            raise EvaluationError("provider returned a non-finite embedding value")
        values.append(format(value, ".9g"))
    return "[" + ",".join(values) + "]"


def _optional_sql_text(value: object) -> str:
    return "null" if value is None else _sql_text(str(value))


def _optional_sql_uuid(value: object) -> str:
    return "null" if value is None else f"{_sql_text(str(value))}::uuid"


def _optional_sql_uuid_array(value: object) -> str:
    if value is None:
        return "null"
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise EvaluationError("capturePlan.sourceIds must be a list of UUID strings")
    return "array[" + ",".join(f"{_sql_text(item)}::uuid" for item in value) + "]::uuid[]"


def _capture_plan(query: Mapping[str, Any]) -> dict[str, Any]:
    raw = query.get("capturePlan")
    if raw is None:
        return {
            "topic": _required_string(query, "query"),
            "politicianId": None,
            "party": None,
            "dateFrom": None,
            "dateTo": None,
            "sourceIds": None,
        }
    if not isinstance(raw, Mapping):
        raise EvaluationError("capturePlan must be an object")
    topic = raw.get("topic")
    if topic is not None and (not isinstance(topic, str) or not topic.strip()):
        raise EvaluationError("capturePlan.topic must be null or a non-empty string")
    return {
        "topic": topic.strip() if isinstance(topic, str) else None,
        "politicianId": raw.get("politicianId"),
        "party": raw.get("party"),
        "dateFrom": raw.get("dateFrom"),
        "dateTo": raw.get("dateTo"),
        "sourceIds": raw.get("sourceIds"),
    }


def _capture_sql(
    topic: str | None,
    vector: Sequence[Any] | None,
    plan: Mapping[str, Any] | None = None,
) -> str:
    filters = plan or {}
    query = _optional_sql_text(topic)
    embedding = "null" if vector is None else _sql_text(_vector_text(vector))
    politician_id = _optional_sql_uuid(filters.get("politicianId"))
    party = _optional_sql_text(filters.get("party"))
    date_from = (
        "null"
        if filters.get("dateFrom") is None
        else f"{_sql_text(str(filters['dateFrom']))}::date"
    )
    date_to = (
        "null" if filters.get("dateTo") is None else f"{_sql_text(str(filters['dateTo']))}::date"
    )
    source_ids = _optional_sql_uuid_array(filters.get("sourceIds"))
    rpc_arguments = (
        f"{query}, {embedding}, 10, {politician_id}, {party}, {date_from}, {date_to}, {source_ids}"
    )
    if topic is None:
        return f"""
with result as (
  select public.search_clip_candidates_v2({rpc_arguments})->'results' as rows
)
select rows as keyword, rows as semantic, rows as hybrid,
  (select semantic_index_version from private.search_system_state where singleton)
    as index_version
from result;
"""
    assert vector is not None
    return f"""
with state as (
  select semantic_index_version as version
  from private.search_system_state where singleton
), query_terms as (
  select pg_catalog.tsvector_to_array(
    pg_catalog.to_tsvector('pg_catalog.swedish'::regconfig, {query})
  ) as lexemes
), semantic_passages as (
  select document.clip_id, chunk.chunk_no, chunk.passage,
    (1 - (
      chunk.embedding operator(extensions.<=>)
      {embedding}::extensions.halfvec(1024)
    ))::real as similarity,
    case
      when pg_catalog.cardinality(query_terms.lexemes) = 0 then 0::real
      else (
        pg_catalog.cardinality(array(
          select lexeme
          from pg_catalog.unnest(
            pg_catalog.tsvector_to_array(document.search_vector)
          ) as document_lexemes(lexeme)
          intersect
          select lexeme
          from pg_catalog.unnest(query_terms.lexemes) as query_lexemes(lexeme)
        ))::real / pg_catalog.cardinality(query_terms.lexemes)
      )
    end as lexical_coverage,
    document.debate_date, catalogue.rank_in_speech
  from private.clip_search_documents document
  join public.feed_clip_catalogue catalogue on catalogue.id = document.clip_id
  join private.clip_search_chunks chunk on chunk.clip_id = document.clip_id
  cross join state
  cross join query_terms
  where document.semantic_state = 'current'
    and document.completed_index_version = state.version
    and chunk.index_version = state.version
    and chunk.source_hash = document.source_hash
    and ({politician_id} is null or document.politician_id = {politician_id})
    and ({party} is null or coalesce(document.party_at_speech, 'NONE') = {party})
    and ({date_from} is null or document.debate_date >= {date_from})
    and ({date_to} is null or document.debate_date <= {date_to})
    and ({source_ids} is null or document.source_id = any({source_ids}))
    and (1 - (
      chunk.embedding operator(extensions.<=>)
      {embedding}::extensions.halfvec(1024)
    )) >= 0.35
), semantic_best as (
  select ranked.* from (
    select passage.*, row_number() over (
      partition by passage.clip_id order by passage.similarity desc, passage.chunk_no
    ) as clip_passage_rank
    from semantic_passages passage
  ) ranked where ranked.clip_passage_rank = 1
), semantic_top as (
  select * from semantic_best
  order by similarity desc, debate_date desc, rank_in_speech, clip_id
  limit 10
)
select
  public.search_clip_candidates_v2(
    {query}, null, 10, {politician_id}, {party}, {date_from}, {date_to}, {source_ids}
  )->'results' as keyword,
  coalesce((select jsonb_agg(
    private.search_clip_result(clip_id, passage, 'context')
      || pg_catalog.jsonb_build_object(
        '_evaluationSimilarity', pg_catalog.round(similarity::numeric, 6),
        '_evaluationLexicalCoverage', pg_catalog.round(lexical_coverage::numeric, 6)
      )
    order by similarity desc, debate_date desc, rank_in_speech, clip_id
  ) from semantic_top), '[]'::jsonb) as semantic,
  public.search_clip_candidates_v2(
    {rpc_arguments}
  )->'results' as hybrid,
  (select version from state) as index_version;
"""


def _result_summary(result: Any) -> tuple[list[str], dict[str, dict[str, Any]]]:
    if not isinstance(result, list):
        raise EvaluationError("ranking response must be a list")
    ranking: list[str] = []
    documents: dict[str, dict[str, Any]] = {}
    for raw in result:
        if not isinstance(raw, Mapping) or not isinstance(raw.get("clip"), Mapping):
            raise EvaluationError("ranking response contains an invalid result")
        clip = raw["clip"]
        clip_id = _required_string(clip, "id")
        ranking.append(clip_id)
        documents[clip_id] = {
            "title": clip.get("title"),
            "sourceTitle": clip.get("sourceTitle"),
            "speakerNameAtSpeech": raw.get("speakerNameAtSpeech"),
            "partyAtSpeech": raw.get("partyAtSpeech"),
            "excerpt": raw.get("matchExcerpt"),
            "matchKind": raw.get("matchKind"),
            "semanticSimilarity": raw.get("_evaluationSimilarity"),
            "lexicalCoverage": raw.get("_evaluationLexicalCoverage"),
        }
    return ranking, documents


def capture_live(judgments: Mapping[str, Any], env_path: Path) -> dict[str, Any]:
    """Capture three read-only ranking modes for the judgment query set."""

    queries = _validate_queries(judgments)
    env_file = _read_env_file(env_path)
    openai_key = _secret("OPENAI_API_KEY", env_file)
    project_ref = _secret("RIKET_SUPABASE_PROJECT_REF", env_file)
    access_token = _secret("RIKET_SUPABASE_ACCESS_TOKEN", env_file)
    query_rows = list(queries.values())
    plans = [_capture_plan(row) for row in query_rows]
    provider_inputs = [str(plan["topic"]) for plan in plans if isinstance(plan.get("topic"), str)]
    provider_started = time.perf_counter()
    provider = _post_json(
        OPENAI_EMBEDDINGS_URL,
        {"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
        {"model": "text-embedding-3-large", "dimensions": 1024, "input": provider_inputs},
    )
    provider_ms = round((time.perf_counter() - provider_started) * 1000, 3)
    if not isinstance(provider, Mapping) or not isinstance(provider.get("data"), list):
        raise EvaluationError("provider returned an invalid embedding envelope")
    provider_rows = provider["data"]
    if len(provider_rows) != len(provider_inputs):
        raise EvaluationError("provider returned the wrong embedding count")
    provider_embeddings: dict[int, Sequence[Any]] = {}
    for row in provider_rows:
        if not isinstance(row, Mapping) or not isinstance(row.get("index"), int):
            raise EvaluationError("provider returned an invalid embedding item")
        vector = row.get("embedding")
        if not isinstance(vector, list):
            raise EvaluationError("provider embedding must be a list")
        provider_embeddings[int(row["index"])] = vector

    embeddings: dict[int, Sequence[Any]] = {}
    provider_index = 0
    for query_index, plan in enumerate(plans):
        if isinstance(plan.get("topic"), str):
            if provider_index not in provider_embeddings:
                raise EvaluationError("provider omitted an embedding item")
            embeddings[query_index] = provider_embeddings[provider_index]
            provider_index += 1

    runs: list[dict[str, Any]] = []
    index_versions: set[str] = set()
    management_url = f"{SUPABASE_MANAGEMENT_BASE}/projects/{project_ref}/database/query"
    for index, query_row in enumerate(query_rows):
        started = time.perf_counter()
        response = _post_json(
            management_url,
            {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            {
                "query": _capture_sql(
                    plans[index].get("topic"),
                    embeddings.get(index),
                    plans[index],
                )
            },
        )
        retrieval_ms = round((time.perf_counter() - started) * 1000, 3)
        rows = response.get("result", response) if isinstance(response, Mapping) else response
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping):
            raise EvaluationError("Supabase returned an invalid evaluation row")
        row = rows[0]
        rankings: dict[str, list[str]] = {}
        document_map: dict[str, dict[str, Any]] = {}
        for mode in MODES:
            ranking, mode_documents = _result_summary(row.get(mode))
            rankings[mode] = ranking
            for clip_id, details in mode_documents.items():
                current = document_map.setdefault(clip_id, {})
                current.update({key: value for key, value in details.items() if value is not None})
        version = _required_string(row, "index_version")
        index_versions.add(version)
        runs.append(
            {
                "queryId": _required_string(query_row, "id"),
                "captureStatus": "three_mode_complete",
                "retrievalEvidenceComplete": True,
                "rankings": rankings,
                "documents": document_map,
                "captureRetrievalMs": retrieval_ms,
            }
        )

    corpus_response = _post_json(
        management_url,
        {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        {
            "query": """
select
  (select count(*)::int from public.clips
   where published_at is not null and moderation <> 'rejected')
    as eligible_documents,
  (select count(*)::int from private.clip_search_documents) as keyword_documents,
  (select count(*)::int from private.clip_search_documents
   where semantic_state = 'current') as semantic_current,
  (select count(*)::int from private.clip_search_chunks) as semantic_chunks,
  (select count(*)::int from private.clip_search_documents
   where semantic_state = 'failed') as semantic_failed;
"""
        },
    )
    corpus_rows = (
        corpus_response.get("result", corpus_response)
        if isinstance(corpus_response, Mapping)
        else corpus_response
    )
    if not isinstance(corpus_rows, list) or len(corpus_rows) != 1:
        raise EvaluationError("Supabase returned invalid corpus counts")
    counts = corpus_rows[0]
    usage = provider.get("usage") if isinstance(provider.get("usage"), Mapping) else {}
    return {
        "schemaVersion": 1,
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "captureKind": "read-only production candidate pool; requires manual judgment",
        "indexVersion": next(iter(index_versions)) if len(index_versions) == 1 else "mixed",
        "provider": {
            "model": "text-embedding-3-large",
            "dimensions": 1024,
            "batchLatencyMs": provider_ms,
            "promptTokens": usage.get("prompt_tokens"),
            "totalTokens": usage.get("total_tokens"),
        },
        "corpus": {
            "eligibleDocuments": counts.get("eligible_documents"),
            "keywordDocuments": counts.get("keyword_documents"),
            "semanticCurrent": counts.get("semantic_current"),
            "semanticChunks": counts.get("semantic_chunks"),
            "semanticExceptions": (
                [] if counts.get("semantic_failed") == 0 else ["review-failed-rows"]
            ),
        },
        "operations": {
            "submittedSearchLatencyMs": [],
            "futureIndexLagMs": [],
            "note": (
                "Capture timings are management-path diagnostics, not "
                "submitted-search load evidence."
            ),
        },
        "runs": runs,
    }


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("evaluate", "capture-live"),
        nargs="?",
        default="evaluate",
    )
    parser.add_argument("--documents", type=Path, default=DEFAULT_DOCUMENTS)
    parser.add_argument("--judgments", type=Path, default=DEFAULT_JUDGMENTS)
    parser.add_argument("--expected", type=Path, default=DEFAULT_EXPECTED)
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--confirm-provider-cost", action="store_true")
    parser.add_argument("--strict-release", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        judgments = _load_json(args.judgments)
        if args.command == "capture-live":
            if not args.confirm_provider_cost:
                raise EvaluationError("capture-live requires --confirm-provider-cost")
            payload = capture_live(judgments, args.env_file)
        else:
            payload = evaluate(_load_json(args.documents), judgments, _load_json(args.expected))
    except EvaluationError as exc:
        print(f"topic-search evaluation error: {exc}", file=sys.stderr)
        return 2
    rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    if args.strict_release and payload.get("readiness") != "ready":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
