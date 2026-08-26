"""Evaluate UI16 topic-search rankings against a frozen Swedish judgment set.

The default command is offline and provider-free.  ``capture-live`` is an
explicit operator action: it reads the current production catalogue, spends a
small amount on query embeddings, and prints a candidate snapshot for review.
It never changes database state and never logs query text or credentials.

``smoke`` is also offline and provider-free.  It replays ten committed Swedish
phrases against the frozen capture and reports observable retrieval behavior as
engineering smoke evidence.  It is regression testing, not model training and
not human relevance judgment: it produces no grade and no judged metric.

``admission-grid`` is offline and provider-free too.  It replays OPT2's
candidate-level admission grid against the same capture and selects one
configuration by the roadmap's conservative order, never by a judged metric.
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
DEFAULT_SMOKE = ROOT / "tests" / "fixtures" / "search" / "smoke.json"
DEFAULT_SMOKE_REPORT = ROOT / "test_outputs" / "topic_search_smoke_baseline.md"
DEFAULT_GRID_REPORT = ROOT / "test_outputs" / "topic_search_admission_before_after.md"
MODES = ("keyword", "semantic", "hybrid")
MAX_RANK = 10

# The served order is the hybrid list; keyword-only and semantic-only pools are
# diagnostics and are never what a viewer sees.
SMOKE_SERVED_MODE = "hybrid"
SMOKE_TOP_N = 5
SMOKE_EXCERPT_CHARS = 160

# Committed regression phrases.  Frozen here so the set cannot silently grow
# into a topic whitelist, a synonym table or a list of permitted searches, and
# so no logged user search can ever be substituted for one of them.
SMOKE_QUERIES = (
    "elsparkcykel",
    "elsparkcykel 30 mars",
    "elsparkcykel 22 juni",
    "trafiksäkerhet för små elektriska hyrfordon",
    "barnfattigdom",
    "äldreomsorg bemanning",
    "havsbaserad vindkraft i Kattegatt",
    "hur ska gängkriminaliteten stoppas",
    "bananministeriet på månen",
    "kvantdatorer på varje förskola",
)
SMOKE_EXPECTATIONS = (
    "non_empty",
    "empty",
    "exact_date_no_broadening",
    "broadened_from_empty_exact",
)

# Only these captured per-clip fields may leave the smoke path.  Similarity and
# lexical coverage are private ranking scores and are dropped deliberately.
SMOKE_PUBLIC_DOCUMENT_FIELDS = (
    "title",
    "sourceTitle",
    "speakerNameAtSpeech",
    "partyAtSpeech",
    "excerpt",
    "matchKind",
    "debateDate",
)
SMOKE_PRIVATE_DOCUMENT_FIELDS = ("semanticSimilarity", "lexicalCoverage")
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


def _smoke_public_document(document: Mapping[str, Any]) -> dict[str, Any]:
    """Keep only publicly explainable capture fields; drop private scores."""

    public: dict[str, Any] = {}
    for field in SMOKE_PUBLIC_DOCUMENT_FIELDS:
        value = document.get(field)
        if value is None:
            continue
        if field == "excerpt" and isinstance(value, str) and len(value) > SMOKE_EXCERPT_CHARS:
            value = value[:SMOKE_EXCERPT_CHARS].rstrip() + "..."
        public[field] = value
    return public


def _smoke_searches(smoke: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Validate that the committed phrase set is exactly the frozen ten."""

    rows = _required_list(smoke, "searches")
    if len(rows) != len(SMOKE_QUERIES):
        raise EvaluationError(f"smoke fixture must hold exactly {len(SMOKE_QUERIES)} searches")
    searches: list[Mapping[str, Any]] = []
    seen_ids: set[str] = set()
    for row, committed in zip(rows, SMOKE_QUERIES, strict=True):
        if not isinstance(row, Mapping):
            raise EvaluationError("every smoke search must be an object")
        search_id = _required_string(row, "id")
        if search_id in seen_ids:
            raise EvaluationError(f"duplicate smoke search id: {search_id}")
        seen_ids.add(search_id)
        if _required_string(row, "query") != committed:
            raise EvaluationError(f"smoke search {search_id} is not the committed phrase")
        expectation = _required_string(row, "expectation")
        if expectation not in SMOKE_EXPECTATIONS:
            raise EvaluationError(f"unknown smoke expectation for {search_id}: {expectation}")
        searches.append(row)
    return searches


def _smoke_evidence(
    search: Mapping[str, Any],
    runs: Mapping[str, Mapping[str, Any]],
    query_text: Mapping[str, str],
) -> tuple[Mapping[str, Any] | None, str | None]:
    """Resolve one search to its captured run, or to an honest blocked reason."""

    search_id = _required_string(search, "id")
    evidence = search.get("evidence")
    if not isinstance(evidence, Mapping):
        raise EvaluationError(f"smoke search {search_id} needs an evidence object")
    kind = _required_string(evidence, "kind")
    if kind == "not_captured_offline":
        return None, _required_string(evidence, "reason")
    if kind != "offline_capture":
        raise EvaluationError(f"unknown smoke evidence kind for {search_id}: {kind}")
    run_id = _required_string(evidence, "runId")
    run = runs.get(run_id)
    if run is None:
        raise EvaluationError(f"smoke search {search_id} references unknown run {run_id}")
    # Guard against silently attributing one phrase's capture to another.
    captured_query = _required_string(evidence, "capturedQuery")
    actual = query_text.get(run_id)
    if actual != captured_query or actual != _required_string(search, "query"):
        raise EvaluationError(f"smoke search {search_id} is bound to a different captured phrase")
    return run, None


def _smoke_observed(run: Mapping[str, Any]) -> dict[str, Any]:
    """Summarise one captured run as served order, ids, dates and facets."""

    run_id = _required_string(run, "queryId")
    rankings = run.get("rankings")
    if not isinstance(rankings, Mapping):
        raise EvaluationError(f"rankings missing for {run_id}")
    served = rankings.get(SMOKE_SERVED_MODE)
    if not isinstance(served, list) or not all(
        isinstance(clip_id, str) and clip_id for clip_id in served
    ):
        raise EvaluationError(f"invalid served ranking for {run_id}")
    raw_documents = run.get("documents")
    documents = raw_documents if isinstance(raw_documents, Mapping) else {}
    rows: list[dict[str, Any]] = []
    dates: list[str | None] = []
    for clip_id in served:
        raw = documents.get(clip_id)
        document = _smoke_public_document(raw if isinstance(raw, Mapping) else {})
        dates.append(document.get("debateDate"))
        rows.append({"clipId": clip_id, **document})
    interpretation = run.get("interpretation")
    return {
        "runId": run_id,
        "retrievalEvidenceComplete": run.get("retrievalEvidenceComplete") is True,
        "resultCount": len(served),
        "clipIds": list(served),
        "debateDates": dates,
        "debateDatesCaptured": bool(dates) and all(isinstance(value, str) for value in dates),
        "interpretation": interpretation if isinstance(interpretation, Mapping) else None,
        "dateBroadening": run.get("dateBroadening"),
        "dateMetadataCaptured": "dateBroadening" in run and "interpretation" in run,
        "topResults": rows[:SMOKE_TOP_N],
    }


def _smoke_facet_kinds(observed: Mapping[str, Any]) -> list[str]:
    interpretation = observed.get("interpretation")
    if not isinstance(interpretation, Mapping):
        return []
    facets = interpretation.get("facets")
    if not isinstance(facets, list):
        return []
    return [
        facet["kind"]
        for facet in facets
        if isinstance(facet, Mapping) and isinstance(facet.get("kind"), str)
    ]


def _smoke_date_range(search: Mapping[str, Any]) -> tuple[str, str]:
    date = search.get("date")
    if not isinstance(date, Mapping):
        raise EvaluationError(f"smoke search {_required_string(search, 'id')} needs a date range")
    return _required_string(date, "from"), _required_string(date, "to")


def _smoke_check(
    search: Mapping[str, Any], observed: Mapping[str, Any]
) -> tuple[str, list[str], str | None]:
    """Return status, failure notes and any blocked reason for one expectation."""

    expectation = _required_string(search, "expectation")
    failures: list[str] = []
    count = int(observed["resultCount"])

    if expectation == "empty":
        if count:
            failures.append(f"expected an empty result, captured {count}")
        return ("fail" if failures else "pass"), failures, None

    if count == 0:
        failures.append("expected a non-empty result, captured 0")
    if expectation == "non_empty":
        return ("fail" if failures else "pass"), failures, None

    # Both date expectations need the interpretation and broadening metadata
    # that the current capture format does not record.
    if not observed["dateMetadataCaptured"]:
        return (
            "blocked_needs_capture",
            failures,
            "the bound capture records no interpretation or date-broadening metadata",
        )
    date_from, date_to = _smoke_date_range(search)
    broadening = observed.get("dateBroadening")
    dates = [value for value in observed["debateDates"] if isinstance(value, str)]

    if expectation == "exact_date_no_broadening":
        if broadening is not None:
            failures.append("an exact date search must not report date broadening")
        if "date" not in _smoke_facet_kinds(observed):
            failures.append("an exact date search must keep its date facet")
        outside = [value for value in dates if value < date_from or value > date_to]
        if outside:
            failures.append(f"exact date search returned {len(outside)} rows outside its range")
        return ("fail" if failures else "pass"), failures, None

    # broadened_from_empty_exact
    if not isinstance(broadening, Mapping):
        failures.append("a broadened search must report its removed date range")
    elif broadening.get("from") != date_from or broadening.get("to") != date_to:
        failures.append("broadening metadata must name the original requested range")
    if "date" in _smoke_facet_kinds(observed):
        failures.append("a broadened search must drop the relaxed date facet")
    inside = [value for value in dates if date_from <= value <= date_to]
    if inside:
        failures.append(f"broadened search returned {len(inside)} rows from the excluded range")
    return ("fail" if failures else "pass"), failures, None


def _smoke_forbidden(smoke: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    examples = smoke.get("forbiddenExamples")
    if examples is None:
        return {}
    if not isinstance(examples, Mapping):
        raise EvaluationError("forbiddenExamples must be an object")
    resolved: dict[str, Mapping[str, Any]] = {}
    for name, raw in examples.items():
        if not isinstance(raw, Mapping):
            raise EvaluationError(f"forbidden example {name} must be an object")
        clip_ids = _required_list(raw, "clipIds")
        if not clip_ids or not all(isinstance(value, str) and value for value in clip_ids):
            raise EvaluationError(f"forbidden example {name} needs non-empty clip ids")
        resolved[name] = raw
    return resolved


def smoke_baseline(
    documents: Mapping[str, Any],
    judgments: Mapping[str, Any],
    smoke: Mapping[str, Any],
) -> dict[str, Any]:
    """Replay the committed phrases against the frozen offline capture.

    The result is engineering smoke evidence: observable retrieval behavior
    only.  It carries no relevance grade, no judged metric, no credential, no
    client address, no embedding and no private ranking score.
    """

    searches = _smoke_searches(smoke)
    forbidden = _smoke_forbidden(smoke)
    runs = {
        _required_string(raw, "queryId"): raw
        for raw in _required_list(documents, "runs")
        if isinstance(raw, Mapping)
    }
    query_text = {
        _required_string(raw, "id"): _required_string(raw, "query")
        for raw in _required_list(judgments, "queries")
        if isinstance(raw, Mapping)
    }

    rows: list[dict[str, Any]] = []
    failed: list[str] = []
    blocked: list[str] = []
    for search in searches:
        search_id = _required_string(search, "id")
        run, blocked_reason = _smoke_evidence(search, runs, query_text)
        row: dict[str, Any] = {
            "id": search_id,
            "query": _required_string(search, "query"),
            "expectation": _required_string(search, "expectation"),
        }
        if run is None:
            row["status"] = "blocked_needs_capture"
            row["blockedReason"] = blocked_reason
            row["observed"] = None
            blocked.append(search_id)
            rows.append(row)
            continue
        observed = _smoke_observed(run)
        status, failures, reason = _smoke_check(search, observed)
        name = search.get("forbiddenExample")
        if isinstance(name, str):
            if name not in forbidden:
                raise EvaluationError(f"smoke search {search_id} names unknown example {name}")
            banned = set(forbidden[name]["clipIds"])
            hits = [clip_id for clip_id in observed["clipIds"] if clip_id in banned]
            row["forbiddenExample"] = {"name": name, "observedHits": hits}
        row["status"] = status
        row["observed"] = observed
        if failures:
            row["failures"] = failures
        if status == "fail":
            failed.append(search_id)
        elif status == "blocked_needs_capture":
            row["blockedReason"] = reason
            blocked.append(search_id)
        rows.append(row)

    open_defects = [
        {
            "name": name,
            "clipIds": list(example["clipIds"]),
            "reason": example.get("reason"),
            "identifiedFrom": example.get("identifiedFrom"),
            "ownedBy": example.get("ownedBy"),
        }
        for name, example in sorted(forbidden.items())
        if example.get("currentlyPresentInCapture") is True
    ]
    raw_versions = smoke.get("versions")
    versions = dict(raw_versions) if isinstance(raw_versions, Mapping) else {}
    for key in ("searchVersion", "rankingVersion", "indexVersion", "capturedAt"):
        if not isinstance(versions.get(key), str) or not versions[key].strip():
            raise EvaluationError(f"smoke versions.{key} must be a non-empty string")
    captured_index = documents.get("indexVersion")
    if isinstance(captured_index, str) and versions["indexVersion"] != captured_index:
        raise EvaluationError("smoke indexVersion does not match the bound capture")

    return {
        "schemaVersion": 1,
        "evidenceKind": "engineering_smoke_evidence",
        "evidenceNote": smoke.get("evidenceNote"),
        "purposeNote": smoke.get("purposeNote"),
        "versions": versions,
        "smokeQueryCount": len(rows),
        "passCount": sum(1 for row in rows if row["status"] == "pass"),
        "failCount": len(failed),
        "blockedCount": len(blocked),
        "failedSearches": failed,
        "blockedSearches": blocked,
        "knownOpenDefects": open_defects,
        "searches": rows,
    }


def render_smoke_report(payload: Mapping[str, Any]) -> str:
    """Render the compact top-five title/excerpt report for agent inspection."""

    raw_versions = payload.get("versions")
    versions = raw_versions if isinstance(raw_versions, Mapping) else {}
    lines = [
        "# Topic search smoke baseline",
        "",
        "**Engineering smoke evidence.** Produced automatically from frozen offline",
        "fixtures. It records observable retrieval behavior only. It is **not**",
        "human-validated relevance evidence: it contains no relevance grade, no",
        "nDCG, no precision and no private ranking score.",
        "",
        "The ten phrases below are committed regression test data. They are never",
        "derived from logged user searches, the live endpoint never reads them, and",
        "they are not a topic whitelist, a synonym table or a ranking input.",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Search version | `{versions.get('searchVersion')}` |",
        f"| Ranking version | `{versions.get('rankingVersion')}` |",
        f"| Index version | `{versions.get('indexVersion')}` |",
        f"| Capture source | `{versions.get('captureSource')}` |",
        f"| Capture date | {versions.get('capturedAt')} |",
        "",
        f"Pass {payload.get('passCount')} / fail {payload.get('failCount')} / "
        f"blocked {payload.get('blockedCount')} of {payload.get('smokeQueryCount')}.",
        "",
    ]
    raw_searches = payload.get("searches")
    for search in raw_searches if isinstance(raw_searches, list) else []:
        if not isinstance(search, Mapping):
            continue
        lines.append(f"## {search.get('id')} - {search.get('query')}")
        lines.append("")
        lines.append(f"- Expectation: `{search.get('expectation')}`")
        lines.append(f"- Status: **{search.get('status')}**")
        observed = search.get("observed")
        if not isinstance(observed, Mapping):
            lines.append(f"- Blocked: {search.get('blockedReason')}")
            lines.append("")
            continue
        lines.append(
            f"- Results: {observed.get('resultCount')} (captured run `{observed.get('runId')}`)"
        )
        example = search.get("forbiddenExample")
        if isinstance(example, Mapping):
            raw_hits = example.get("observedHits")
            hits = raw_hits if isinstance(raw_hits, list) else []
            summary = ", ".join(f"`{value}`" for value in hits) if hits else "none observed"
            lines.append(f"- Forbidden `{example.get('name')}`: {summary}")
        failures = search.get("failures")
        if isinstance(failures, list):
            lines.extend(f"- Failure: {failure}" for failure in failures)
        raw_rows = observed.get("topResults")
        rows = raw_rows if isinstance(raw_rows, list) else []
        lines.append("")
        if not rows:
            lines.append("_No results captured._")
            lines.append("")
            continue
        lines.append("| # | Title | Excerpt |")
        lines.append("|---|---|---|")
        for position, row in enumerate(rows, 1):
            if not isinstance(row, Mapping):
                continue
            title = str(row.get("title") or "").replace("|", r"\|")
            excerpt = str(row.get("excerpt") or "").replace("|", r"\|")
            lines.append(f"| {position} | {title} | {excerpt} |")
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


# --- OPT2 candidate-level admission grid -------------------------------------
#
# The grid is offline and provider-free.  It replays candidate-level admission
# over the frozen capture and applies the roadmap's deterministic conservative
# gates.  It produces no relevance grade and no judged metric: every gate below
# is an observable membership fact, never a quality claim.

CANDIDATE_SIMILARITY_GRID = (0.40, 0.45, 0.48, 0.50, 0.53)
CANDIDATE_LEXICAL_GRID = (0.34, 0.50, 0.67)
KEYWORD_WEIGHT_GRID = (1.5, 2.0)
SEMANTIC_WEIGHT_GRID = (0.75, 1.0)
RRF_K_GRID = (40, 50, 60)

# The constants migration 027 deployed.  Rule 7's final tie-break resolves to
# these: they are the only fusion weights the frozen capture can evidence.
PRODUCTION_KEYWORD_WEIGHT = 1.5
PRODUCTION_SEMANTIC_WEIGHT = 1.0
PRODUCTION_RRF_K = 50

# A candidate carrying a keyword match is never subject to candidate admission.
KEYWORD_MATCH_KINDS = ("keyword", "both")
SEMANTIC_ONLY_MATCH_KIND = "context"
MINIMUM_RETAINED_RESULTS = 5
DESCRIPTIVE_SEMANTIC_SEARCH_ID = "s04"


@dataclass(frozen=True)
class GridConfiguration:
    """One point in the roadmap's threshold grid."""

    candidate_similarity: float
    candidate_lexical_coverage: float
    keyword_weight: float
    semantic_weight: float
    rrf_k: int

    @property
    def configuration_id(self) -> str:
        return (
            f"sim{self.candidate_similarity:.2f}"
            f"-lex{self.candidate_lexical_coverage:.2f}"
            f"-kw{self.keyword_weight:.2f}"
            f"-sem{self.semantic_weight:.2f}"
            f"-k{self.rrf_k}"
        )

    @property
    def uses_production_fusion(self) -> bool:
        return (
            self.keyword_weight == PRODUCTION_KEYWORD_WEIGHT
            and self.semantic_weight == PRODUCTION_SEMANTIC_WEIGHT
            and self.rrf_k == PRODUCTION_RRF_K
        )


def _grid_configurations() -> list[GridConfiguration]:
    return [
        GridConfiguration(similarity, lexical, keyword_weight, semantic_weight, rrf_k)
        for similarity in CANDIDATE_SIMILARITY_GRID
        for lexical in CANDIDATE_LEXICAL_GRID
        for keyword_weight in KEYWORD_WEIGHT_GRID
        for semantic_weight in SEMANTIC_WEIGHT_GRID
        for rrf_k in RRF_K_GRID
    ]


def _grid_candidates(run: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return the captured served order annotated with its admission inputs."""

    run_id = _required_string(run, "queryId")
    rankings = run.get("rankings")
    if not isinstance(rankings, Mapping):
        raise EvaluationError(f"rankings missing for {run_id}")
    served = rankings.get(SMOKE_SERVED_MODE)
    if not isinstance(served, list):
        raise EvaluationError(f"invalid served ranking for {run_id}")
    raw_documents = run.get("documents")
    documents = raw_documents if isinstance(raw_documents, Mapping) else {}
    candidates: list[dict[str, Any]] = []
    for clip_id in served:
        if not isinstance(clip_id, str) or not clip_id:
            raise EvaluationError(f"invalid served ranking for {run_id}")
        raw = documents.get(clip_id)
        document = raw if isinstance(raw, Mapping) else {}
        match_kind = document.get("matchKind")
        if match_kind not in (*KEYWORD_MATCH_KINDS, SEMANTIC_ONLY_MATCH_KIND):
            raise EvaluationError(f"run {run_id} candidate {clip_id} has no usable matchKind")
        keyword_matched = match_kind in KEYWORD_MATCH_KINDS
        similarity = document.get("semanticSimilarity")
        coverage = document.get("lexicalCoverage")
        scored = isinstance(similarity, int | float) and isinstance(coverage, int | float)
        if not keyword_matched and not scored:
            # A semantic-only candidate without its own scores cannot be judged
            # offline.  Inventing one would manufacture missing evidence.
            raise EvaluationError(
                f"run {run_id} semantic-only candidate {clip_id} has no captured scores"
            )
        candidates.append(
            {
                "clipId": clip_id,
                "keywordMatched": keyword_matched,
                "similarity": float(similarity) if isinstance(similarity, int | float) else None,
                "lexicalCoverage": float(coverage) if isinstance(coverage, int | float) else None,
            }
        )
    return candidates


def _admit(candidate: Mapping[str, Any], configuration: GridConfiguration) -> bool:
    """Apply candidate-level admission to exactly one candidate.

    A strong candidate elsewhere in the query is deliberately not an input:
    admission reads only this candidate's own evidence.
    """

    if candidate["keywordMatched"] is True:
        return True
    similarity = candidate["similarity"]
    coverage = candidate["lexicalCoverage"]
    meets_similarity = isinstance(similarity, float) and (
        similarity >= configuration.candidate_similarity
    )
    meets_coverage = isinstance(coverage, float) and (
        coverage >= configuration.candidate_lexical_coverage
    )
    return meets_similarity or meets_coverage


def _grid_runs(
    documents: Mapping[str, Any],
    judgments: Mapping[str, Any],
    smoke: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], list[str], dict[str, dict[str, Any]]]:
    """Bind smoke searches and the forbidden-example source to captured runs."""

    searches = _smoke_searches(smoke)
    forbidden = _smoke_forbidden(smoke)
    runs = {
        _required_string(raw, "queryId"): raw
        for raw in _required_list(documents, "runs")
        if isinstance(raw, Mapping)
    }
    query_text = {
        _required_string(raw, "id"): _required_string(raw, "query")
        for raw in _required_list(judgments, "queries")
        if isinstance(raw, Mapping)
    }

    bound: list[dict[str, Any]] = []
    blocked: list[str] = []
    for search in searches:
        search_id = _required_string(search, "id")
        run, _ = _smoke_evidence(search, runs, query_text)
        if run is None:
            blocked.append(search_id)
            continue
        bound.append(
            {
                "id": search_id,
                "query": _required_string(search, "query"),
                "expectation": _required_string(search, "expectation"),
                "runId": _required_string(run, "queryId"),
                "candidates": _grid_candidates(run),
            }
        )

    # The scooter false positives were identified from a captured run of their
    # own.  It is the only scooter search the frozen capture can evidence, so it
    # carries gate 5 while the three `elsparkcykel` phrases stay blocked.
    scooter: dict[str, dict[str, Any]] = {}
    for name, example in sorted(forbidden.items()):
        identified = example.get("identifiedFrom")
        if not isinstance(identified, Mapping):
            raise EvaluationError(f"forbidden example {name} needs identifiedFrom")
        run_id = _required_string(identified, "runId")
        run = runs.get(run_id)
        if run is None:
            raise EvaluationError(f"forbidden example {name} references unknown run {run_id}")
        captured_query = _required_string(identified, "capturedQuery")
        if query_text.get(run_id) != captured_query:
            raise EvaluationError(f"forbidden example {name} is bound to a different phrase")
        scooter[name] = {
            "name": name,
            "runId": run_id,
            "query": captured_query,
            "clipIds": list(example["clipIds"]),
            "candidates": _grid_candidates(run),
        }
    return bound, blocked, scooter


def _admission_outcome(
    candidates: Sequence[Mapping[str, Any]], configuration: GridConfiguration
) -> tuple[list[Mapping[str, Any]], list[str], int]:
    """Split one captured run into admitted rows, dropped keyword rows and tail."""

    admitted = [row for row in candidates if _admit(row, configuration)]
    admitted_ids = {str(row["clipId"]) for row in admitted}
    dropped_keyword = [
        str(row["clipId"])
        for row in candidates
        if row["keywordMatched"] is True and str(row["clipId"]) not in admitted_ids
    ]
    tail = sum(1 for row in admitted if row["keywordMatched"] is not True)
    return admitted, dropped_keyword, tail


def _evaluate_configuration(
    configuration: GridConfiguration,
    bound: Sequence[Mapping[str, Any]],
    scooter: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Apply the roadmap's gates to one configuration and return its evidence."""

    searches: list[dict[str, Any]] = []
    negatives_empty = True
    retains_minimum = True
    keyword_preserved = True
    semantic_only_admitted = 0

    for search in bound:
        candidates = search["candidates"]
        assert isinstance(candidates, list)
        admitted, dropped_keyword, tail = _admission_outcome(candidates, configuration)
        baseline_count = len(candidates)
        required = min(MINIMUM_RETAINED_RESULTS, baseline_count)
        semantic_only_admitted += tail
        if search["expectation"] == "empty" and admitted:
            negatives_empty = False
        if search["expectation"] != "empty" and len(admitted) < required:
            retains_minimum = False
        if dropped_keyword:
            keyword_preserved = False
        searches.append(
            {
                "id": search["id"],
                "runId": search["runId"],
                "expectation": search["expectation"],
                "baselineCount": baseline_count,
                "admittedCount": len(admitted),
                "requiredMinimum": required,
                "semanticOnlyAdmitted": tail,
                "droppedKeywordMatched": dropped_keyword,
            }
        )

    # Gate 4 names the descriptive semantic-only scooter search explicitly, so
    # it is checked by id rather than folded into the shared minimum.
    descriptive = next(
        (row for row in searches if row["id"] == DESCRIPTIVE_SEMANTIC_SEARCH_ID),
        None,
    )
    descriptive_non_empty = descriptive is not None and descriptive["admittedCount"] > 0

    forbidden_rows: list[dict[str, Any]] = []
    forbidden_removed = True
    for name, example in sorted(scooter.items()):
        candidates = example["candidates"]
        assert isinstance(candidates, list)
        admitted, dropped_keyword, tail = _admission_outcome(candidates, configuration)
        banned = set(example["clipIds"])
        hits = [str(row["clipId"]) for row in admitted if str(row["clipId"]) in banned]
        semantic_only_admitted += tail
        if hits:
            forbidden_removed = False
        if dropped_keyword:
            keyword_preserved = False
        forbidden_rows.append(
            {
                "name": name,
                "runId": example["runId"],
                "baselineCount": len(candidates),
                "admittedCount": len(admitted),
                "observedHits": hits,
                "droppedKeywordMatched": dropped_keyword,
            }
        )

    gates = {
        "negativesStayEmpty": negatives_empty,
        "retainsMinimumResults": retains_minimum,
        "descriptiveSemanticNonEmpty": descriptive_non_empty,
        "forbiddenExamplesRemoved": forbidden_removed,
        "keywordMatchedPreserved": keyword_preserved,
    }
    return {
        "configurationId": configuration.configuration_id,
        "candidateSimilarity": configuration.candidate_similarity,
        "candidateLexicalCoverage": configuration.candidate_lexical_coverage,
        "keywordWeight": configuration.keyword_weight,
        "semanticWeight": configuration.semantic_weight,
        "rrfK": configuration.rrf_k,
        "usesProductionFusion": configuration.uses_production_fusion,
        "gates": gates,
        "passes": all(gates.values()),
        "semanticOnlyAdmitted": semantic_only_admitted,
        "searches": searches,
        "forbiddenExamples": forbidden_rows,
    }


def _selection_key(row: Mapping[str, Any]) -> tuple[int, float, float, bool, str]:
    """Rule 7, as a total order.

    Fewer semantic-only tail candidates, then the higher candidate similarity
    threshold, then the higher lexical threshold, then the deployed fusion
    weights, then the deterministic configuration id.
    """

    return (
        int(row["semanticOnlyAdmitted"]),
        -float(row["candidateSimilarity"]),
        -float(row["candidateLexicalCoverage"]),
        not bool(row["usesProductionFusion"]),
        str(row["configurationId"]),
    )


def admission_grid(
    documents: Mapping[str, Any],
    judgments: Mapping[str, Any],
    smoke: Mapping[str, Any],
) -> dict[str, Any]:
    """Replay the OPT2 threshold grid offline and select one configuration.

    There is no human-judged denominator here, so no configuration is called
    "best" and no nDCG or precision is produced.  Selection is the roadmap's
    deterministic conservative order applied to observable membership only.
    """

    bound, blocked, scooter = _grid_runs(documents, judgments, smoke)
    if not scooter:
        raise EvaluationError("the grid needs at least one forbidden example to verify")
    results = [
        _evaluate_configuration(configuration, bound, scooter)
        for configuration in _grid_configurations()
    ]
    survivors = [row for row in results if row["passes"]]
    selected = min(survivors, key=_selection_key) if survivors else None

    before_after: list[dict[str, Any]] = []
    if selected is not None:
        chosen = GridConfiguration(
            float(selected["candidateSimilarity"]),
            float(selected["candidateLexicalCoverage"]),
            float(selected["keywordWeight"]),
            float(selected["semanticWeight"]),
            int(selected["rrfK"]),
        )
        runs = {
            _required_string(raw, "queryId"): raw
            for raw in _required_list(documents, "runs")
            if isinstance(raw, Mapping)
        }
        for search in bound:
            before_after.append(
                _before_after_rows(
                    str(search["id"]),
                    str(search["query"]),
                    runs[str(search["runId"])],
                    search["candidates"],
                    chosen,
                )
            )
        for name, example in sorted(scooter.items()):
            before_after.append(
                _before_after_rows(
                    name,
                    str(example["query"]),
                    runs[str(example["runId"])],
                    example["candidates"],
                    chosen,
                )
            )

    conflicts: list[str] = []
    if not survivors:
        for gate in (
            "negativesStayEmpty",
            "retainsMinimumResults",
            "descriptiveSemanticNonEmpty",
            "forbiddenExamplesRemoved",
            "keywordMatchedPreserved",
        ):
            failing = [row["configurationId"] for row in results if not row["gates"][gate]]
            if failing:
                conflicts.append(
                    f"{gate} fails for {len(failing)} of {len(results)} configurations"
                )

    return {
        "schemaVersion": 1,
        "evidenceKind": "engineering_admission_grid_evidence",
        "evidenceNote": (
            "Offline replay of candidate-level admission over the frozen capture. It records "
            "observable membership only: which candidates each threshold pair admits. It "
            "carries no relevance grade and must never be reported as nDCG, precision or "
            "judged quality, and no configuration here is called best."
        ),
        "fusionNote": (
            "Keyword weight, semantic weight and RRF k change result order, never candidate "
            "admission. The frozen capture preserves only the top-N that the deployed weights "
            "produced, so a different weighting cannot be replayed against it honestly. They "
            "are enumerated for completeness and resolved to the deployed constants."
        ),
        "blockedSearches": blocked,
        "configurationCount": len(results),
        "survivorCount": len(survivors),
        "selected": selected,
        "beforeAfter": before_after,
        "conflicts": conflicts,
        "configurations": results,
    }


def _before_after_rows(
    label: str,
    query: str,
    run: Mapping[str, Any],
    candidates: Sequence[Mapping[str, Any]],
    configuration: GridConfiguration,
) -> dict[str, Any]:
    """Compare one captured run before and after candidate-level admission."""

    raw_documents = run.get("documents")
    documents = raw_documents if isinstance(raw_documents, Mapping) else {}

    def public(clip_id: str) -> dict[str, Any]:
        raw = documents.get(clip_id)
        return _smoke_public_document(raw if isinstance(raw, Mapping) else {})

    admitted = [row for row in candidates if _admit(row, configuration)]
    admitted_ids = {str(row["clipId"]) for row in admitted}
    dropped = [row for row in candidates if str(row["clipId"]) not in admitted_ids]
    return {
        "id": label,
        "query": query,
        "runId": _required_string(run, "queryId"),
        "beforeCount": len(candidates),
        "afterCount": len(admitted),
        "before": [
            {"clipId": str(row["clipId"]), **public(str(row["clipId"]))}
            for row in candidates[:SMOKE_TOP_N]
        ],
        "after": [
            {"clipId": str(row["clipId"]), **public(str(row["clipId"]))}
            for row in admitted[:SMOKE_TOP_N]
        ],
        "dropped": [
            {"clipId": str(row["clipId"]), **public(str(row["clipId"]))} for row in dropped
        ],
    }


def render_admission_grid_report(payload: Mapping[str, Any]) -> str:
    """Render the compact top-five before/after report for the handoff."""

    selected = payload.get("selected")
    lines = [
        "# Topic search candidate-admission before/after",
        "",
        "**Engineering evidence.** Produced automatically from the frozen offline",
        "capture. It records observable retrieval membership only. It is **not**",
        "human-validated relevance evidence: it contains no relevance grade, no",
        "nDCG and no precision, and no configuration here is called best.",
        "",
        "Private ranking scores are deliberately absent from this report and from",
        "the public search response.",
        "",
    ]
    if not isinstance(selected, Mapping):
        conflicts = payload.get("conflicts")
        lines.append("**No configuration passed the required gates.**")
        lines.append("")
        for conflict in conflicts if isinstance(conflicts, list) else []:
            lines.append(f"- {conflict}")
        return "\n".join(lines).rstrip("\n") + "\n"

    lines.extend(
        [
            "| Field | Value |",
            "|---|---|",
            f"| Configuration | `{selected.get('configurationId')}` |",
            f"| Candidate similarity | {selected.get('candidateSimilarity')} |",
            f"| Candidate lexical coverage | {selected.get('candidateLexicalCoverage')} |",
            f"| Keyword RRF weight | {selected.get('keywordWeight')} (unchanged) |",
            f"| Semantic RRF weight | {selected.get('semanticWeight')} (unchanged) |",
            f"| RRF k | {selected.get('rrfK')} (unchanged) |",
            f"| Configurations evaluated | {payload.get('configurationCount')} |",
            f"| Configurations passing every gate | {payload.get('survivorCount')} |",
            "",
        ]
    )
    blocked = payload.get("blockedSearches")
    if isinstance(blocked, list) and blocked:
        lines.append(
            "Blocked without an offline capture, and left unproven rather than "
            f"assumed green: {', '.join(f'`{value}`' for value in blocked)}."
        )
        lines.append("")

    raw_rows = payload.get("beforeAfter")
    for row in raw_rows if isinstance(raw_rows, list) else []:
        if not isinstance(row, Mapping):
            continue
        lines.append(f"## {row.get('id')} - {row.get('query')}")
        lines.append("")
        lines.append(
            f"- Results: {row.get('beforeCount')} before, {row.get('afterCount')} after "
            f"(captured run `{row.get('runId')}`)"
        )
        raw_dropped = row.get("dropped")
        dropped = raw_dropped if isinstance(raw_dropped, list) else []
        if dropped:
            lines.append(f"- Dropped {len(dropped)} semantic-only candidate(s):")
            for item in dropped:
                if isinstance(item, Mapping):
                    lines.append(f"  - `{item.get('clipId')}` - {item.get('title')}")
        else:
            lines.append("- Dropped nothing.")
        lines.append("")
        lines.append("| # | Before | After |")
        lines.append("|---|---|---|")
        raw_before = row.get("before")
        raw_after = row.get("after")
        before = raw_before if isinstance(raw_before, list) else []
        after = raw_after if isinstance(raw_after, list) else []
        for position in range(max(len(before), len(after))):
            left = before[position] if position < len(before) else None
            right = after[position] if position < len(after) else None
            lines.append(f"| {position + 1} | {_report_cell(left)} | {_report_cell(right)} |")
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def _report_cell(row: Any) -> str:
    if not isinstance(row, Mapping):
        return "_(absent)_"
    title = str(row.get("title") or row.get("clipId") or "").replace("|", r"\|")
    return title


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
            # The debate date is already in the RPC envelope (migration 026).
            # Capturing it is what lets a later offline smoke run verify exact
            # and broadened date behavior without another provider call.
            "debateDate": clip.get("debateDate"),
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
        choices=("evaluate", "capture-live", "smoke", "admission-grid"),
        nargs="?",
        default="evaluate",
    )
    parser.add_argument("--documents", type=Path, default=DEFAULT_DOCUMENTS)
    parser.add_argument("--judgments", type=Path, default=DEFAULT_JUDGMENTS)
    parser.add_argument("--expected", type=Path, default=DEFAULT_EXPECTED)
    parser.add_argument("--smoke", type=Path, default=DEFAULT_SMOKE)
    parser.add_argument("--report", type=Path, default=DEFAULT_SMOKE_REPORT)
    parser.add_argument("--grid-report", type=Path, default=DEFAULT_GRID_REPORT)
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
        elif args.command == "admission-grid":
            payload = admission_grid(_load_json(args.documents), judgments, _load_json(args.smoke))
            report = args.grid_report
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(render_admission_grid_report(payload), encoding="utf-8", newline="\n")
        elif args.command == "smoke":
            payload = smoke_baseline(_load_json(args.documents), judgments, _load_json(args.smoke))
            report = args.report
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(render_smoke_report(payload), encoding="utf-8", newline="\n")
        else:
            payload = evaluate(_load_json(args.documents), judgments, _load_json(args.expected))
    except EvaluationError as exc:
        print(f"topic-search evaluation error: {exc}", file=sys.stderr)
        return 2
    rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(rendered)
    if args.strict_release:
        # A blocked search is honest missing evidence, not a regression: OPT1 is
        # forbidden from manufacturing the capture that would resolve it.
        if args.command == "smoke":
            return 1 if payload.get("failedSearches") else 0
        if args.command == "admission-grid":
            return 0 if payload.get("selected") else 1
        if payload.get("readiness") != "ready":
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
