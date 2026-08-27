from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from scripts.evaluate_topic_search import (
    SMOKE_PRIVATE_DOCUMENT_FIELDS,
    SMOKE_QUERIES,
    EvaluationError,
    PublicSearchObservation,
    _capture_plan,
    _capture_sql,
    _load_json,
    _secret,
    admission_grid,
    benchmark_live,
    dcg,
    evaluate,
    latency_decision,
    main,
    ndcg,
    percentile,
    render_admission_grid_report,
    render_latency_decision_report,
    render_smoke_report,
    smoke_baseline,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "search"
EDGE_RANKING = ROOT / "supabase" / "functions" / "_shared" / "search" / "ranking.ts"
INDEX_VERSION = "openai:text-embedding-3-large:1024:v1"
ELFLYG_FALSE_POSITIVES = ("HD10398_27_c02", "HD10401_27_c02", "HD10406_27_c02")


def _complete_fixture() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    queries: list[dict[str, Any]] = []
    runs: list[dict[str, Any]] = []
    for index in range(30):
        relevant = f"clip-{index}-relevant"
        irrelevant = f"clip-{index}-irrelevant"
        query: dict[str, Any] = {
            "id": f"q{index:02d}",
            "query": f"svensk testfråga {index}",
            "category": "test",
            "reviewStatus": "manual_complete",
            "judgments": [
                {"clipId": relevant, "grade": 3},
                {"clipId": irrelevant, "grade": 0},
            ],
        }
        if index == 0:
            query["requiresExactTopThree"] = True
        queries.append(query)
        runs.append(
            {
                "queryId": query["id"],
                "retrievalEvidenceComplete": True,
                "rankings": {
                    "keyword": [irrelevant, relevant],
                    "semantic": [irrelevant, relevant],
                    "hybrid": [relevant, irrelevant],
                },
            }
        )
    documents = {
        "runs": runs,
        "corpus": {
            "eligibleDocuments": 30,
            "keywordDocuments": 30,
            "semanticCurrent": 30,
            "semanticExceptions": [],
        },
        "operations": {
            "submittedSearchLatencyMs": [100, 120, 140],
            "futureIndexLagMs": [1_000, 2_000, 3_000],
        },
    }
    judgments = {"queries": queries}
    expected = {
        "thresholds": {
            "hybridNdcgAt10": 0.75,
            "relevantTopThreeQueries": 24,
            "submittedSearchP95Ms": 1_500,
            "futureIndexLagP95Ms": 120_000,
        },
        "releaseEvidence": {
            "privatePrivilegeMatrixPassed": True,
            "actualOpenAIProjectRegionVerified": True,
            "actualOpenAIProjectRetentionVerified": True,
            "privacyCopyApproved": True,
            "rollbackRehearsed": True,
            "physicalDeviceAccepted": True,
            "ownerGoNoGoApproved": True,
        },
    }
    return documents, judgments, expected


def test_dcg_ndcg_and_nearest_rank_percentile() -> None:
    assert dcg([3]) == pytest.approx(7.0)
    assert ndcg(["best", "other"], {"best": 3, "other": 0}) == pytest.approx(1.0)
    assert ndcg(["other", "best"], {"best": 3, "other": 0}) < 1.0
    assert ndcg([], {}) == 1.0
    assert percentile([1, 5, 3, 2, 4], 0.95) == 5
    assert percentile([], 0.95) is None


def _benchmark_report(day: int, *, failure_call: int | None = None) -> dict[str, Any]:
    calls = 0

    def request_fn(
        endpoint: str,
        key: str,
        origin: str,
        query: str,
    ) -> PublicSearchObservation:
        nonlocal calls
        calls += 1
        assert endpoint == "https://example.test/functions/v1/clip-search"
        assert key == "publishable-test-key"
        assert origin == "https://pleni.se"
        assert query in SMOKE_QUERIES
        failed = calls == failure_call
        return PublicSearchObservation(
            status=503 if failed else 200,
            headers={
                "Server-Timing": (
                    "total;dur=900, preflight;dur=80, provider-budget;dur=40, "
                    "embedding;dur=600, retrieval;dur=180"
                ),
                "X-Pleni-Search-Embedding-Tokens": "5",
            },
            body=(
                {"error": "search_unavailable"}
                if failed
                else {
                    "mode": "hybrid",
                    "searchVersion": "pleni-search-v3",
                    "indexVersion": INDEX_VERSION,
                    "results": [{"clip": {"id": "public-result"}}],
                }
            ),
            total_ms=3_000.0 if calls == 1 else 1_000.0,
        )

    sleeps: list[float] = []
    report = benchmark_live(
        endpoint="https://example.test/functions/v1/clip-search",
        publishable_key="publishable-test-key",
        origin="https://pleni.se",
        price_per_million_usd=Decimal("0.13"),
        projected_monthly_queries=10_000,
        request_fn=request_fn,
        sleep_fn=sleeps.append,
        now_fn=lambda: datetime(2026, 8, day, 12, 0, tzinfo=UTC),
    )
    assert calls == 30
    assert sleeps == [7.0] * 29
    return report


def test_live_benchmark_keeps_cold_call_failures_phases_and_actual_tokens() -> None:
    report = _benchmark_report(27)

    assert report["sampleCount"] == 30
    assert report["calls"][0]["coldCandidate"] is True
    assert report["latency"] == {
        "sampleCount": 30,
        "p50Ms": 1_000.0,
        "p95Ms": 1_000.0,
        "maxMs": 3_000.0,
    }
    assert report["phases"]["embedding"]["p95Ms"] == 600.0
    assert report["embeddingUsage"]["actualPromptTokens"] == 150
    assert report["embeddingUsage"]["actualSampleCostUsd"] == "0.000020"
    assert report["embeddingUsage"]["projectedMonthlyCostUsd"] == "0.006500"
    assert report["slo"]["passed"] is True
    rendered = json.dumps(report, ensure_ascii=False)
    assert all(query not in rendered for query in SMOKE_QUERIES)
    assert "publishable-test-key" not in rendered


def test_live_benchmark_counts_an_http_failure_instead_of_discarding_it() -> None:
    report = _benchmark_report(27, failure_call=2)

    assert report["failureCount"] == 1
    assert report["calls"][1]["status"] == 503
    assert report["calls"][1]["errorCode"] == "search_unavailable"
    assert report["slo"]["passed"] is False


def test_latency_decision_requires_three_distinct_days_and_retains_large_model() -> None:
    reports = [_benchmark_report(day) for day in (27, 28, 29)]

    decision = latency_decision(reports)

    assert decision["distinctUtcDates"] == 3
    assert decision["sampleCount"] == 90
    assert decision["latencyGatePassed"] is True
    assert decision["aggregatePhaseP95Ms"] == {
        "total": 900.0,
        "preflight": 80.0,
        "provider-budget": 40.0,
        "embedding": 600.0,
        "retrieval": 180.0,
    }
    assert decision["indexDecision"] == "retain_text_embedding_3_large_1024"
    assert decision["smallModelSelected"] is False
    rendered = render_latency_decision_report(decision)
    assert "Engineering operations evidence" in rendered
    assert "elsparkcykel" not in rendered

    same_day = [_benchmark_report(27) for _ in range(3)]
    with pytest.raises(EvaluationError, match="three distinct UTC dates"):
        latency_decision(same_day)


def test_latency_decision_recomputes_failures_and_rejects_token_drift() -> None:
    reports = [_benchmark_report(day) for day in (27, 28, 29)]
    reports[0]["calls"][0]["status"] = 503
    reports[0]["calls"][0]["success"] = False
    reports[0]["failureCount"] = 0
    reports[0]["slo"]["passed"] = True

    decision = latency_decision(reports)

    assert decision["runs"][0]["failureCount"] == 1
    assert decision["runs"][0]["sloPassed"] is False
    assert decision["latencyGatePassed"] is False

    reports[0]["embeddingUsage"]["actualPromptTokens"] += 1
    with pytest.raises(EvaluationError, match="token total"):
        latency_decision(reports)


def test_live_benchmark_rejects_fast_intervals_and_cli_requires_confirmation(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(EvaluationError, match="at least seven seconds"):
        benchmark_live(
            endpoint="https://example.test",
            publishable_key="key",
            origin="https://pleni.se",
            price_per_million_usd=Decimal("0.13"),
            projected_monthly_queries=1,
            delay_seconds=6.99,
        )

    assert main(["benchmark-live"]) == 2
    assert "requires --confirm-live-requests" in capsys.readouterr().err


def test_complete_evidence_can_pass_every_release_gate() -> None:
    documents, judgments, expected = _complete_fixture()

    report = evaluate(documents, judgments, expected)

    assert report["readiness"] == "ready"
    assert report["failedGates"] == []
    assert report["modes"]["hybrid"]["meanNdcgAt10"] == 1.0
    assert report["modes"]["hybrid"]["meanNdcgAt10"] > report["modes"]["keyword"]["meanNdcgAt10"]


def test_negative_query_with_semantic_filler_fails_gate() -> None:
    documents, judgments, expected = _complete_fixture()
    judgments["queries"][1]["expectedNoResults"] = True

    report = evaluate(documents, judgments, expected)

    assert report["qualityGates"]["negativeQueriesEmpty"] is False
    assert report["negativeFailures"] == ["q01"]


def test_complete_empty_negative_capture_passes_without_fabricated_grades() -> None:
    documents, judgments, expected = _complete_fixture()
    judgments["queries"][1]["expectedNoResults"] = True
    judgments["queries"][1]["reviewStatus"] = "pending_manual"
    judgments["queries"][1]["judgments"] = []
    documents["runs"][1]["rankings"] = {
        "keyword": [],
        "semantic": [],
        "hybrid": [],
    }

    report = evaluate(documents, judgments, expected)

    assert report["qualityGates"]["negativeQueriesEmpty"] is True
    assert report["negativeFailures"] == []


def test_incomplete_rankings_are_not_reported_as_quality_scores() -> None:
    documents, judgments, expected = _complete_fixture()
    documents["runs"][0]["retrievalEvidenceComplete"] = False

    report = evaluate(documents, judgments, expected)

    assert report["readiness"] == "needs_revision"
    assert report["completeRankingEvidenceCount"] == 29
    assert report["queries"][0]["ndcgAt10"]["hybrid"] is None


def test_fixture_requires_at_least_30_unique_swedish_queries() -> None:
    documents, judgments, expected = _complete_fixture()
    judgments["queries"] = judgments["queries"][:29]
    documents["runs"] = documents["runs"][:29]

    with pytest.raises(EvaluationError, match="at least 30"):
        evaluate(documents, judgments, expected)


def test_capture_sql_is_read_only_and_pins_current_semantic_rows() -> None:
    sql = _capture_sql("barnens rättigheter", [0.125] * 1024).lower()

    assert "search_clip_candidates" in sql
    assert "semantic_state = 'current'" in sql
    assert "chunk.source_hash = document.source_hash" in sql
    assert "_evaluationsimilarity" in sql
    assert "_evaluationlexicalcoverage" in sql
    assert not any(word in sql for word in ("insert into", "update ", "delete from"))


def test_capture_plan_replays_structured_filters_and_provider_free_events() -> None:
    plan = _capture_plan(
        {
            "id": "q-event",
            "query": "debatt 2026",
            "capturePlan": {
                "topic": None,
                "dateFrom": "2026-01-01",
                "dateTo": "2026-12-31",
                "sourceIds": ["953b880d-5fe8-4dbf-8293-f3cc87cfa305"],
            },
        }
    )
    sql = _capture_sql(None, None, plan).lower()

    assert plan["topic"] is None
    assert "search_clip_candidates_v2" in sql
    assert "953b880d-5fe8-4dbf-8293-f3cc87cfa305" in sql
    assert "2026-01-01" in sql
    assert "rows as keyword, rows as semantic, rows as hybrid" in sql


def test_capture_requires_explicit_cost_confirmation(tmp_path: Path) -> None:
    judgments = tmp_path / "judgments.json"
    judgments.write_text(json.dumps(_complete_fixture()[1], ensure_ascii=False), encoding="utf-8")

    assert main(["capture-live", "--judgments", str(judgments)]) == 2


def test_explicit_env_file_wins_over_stale_process_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "stale-process-key")

    assert _secret("OPENAI_API_KEY", {"OPENAI_API_KEY": "selected-file-key"}) == (
        "selected-file-key"
    )


def test_repository_fixture_is_honestly_blocked_and_preserves_denominators() -> None:
    report = evaluate(
        _load_json(FIXTURES / "documents.json"),
        _load_json(FIXTURES / "judgments.json"),
        _load_json(FIXTURES / "expected.json"),
    )

    assert report["queryCount"] == 36
    assert report["manualQueryCount"] == 0
    assert report["completeRankingEvidenceCount"] == 36
    assert report["modes"]["hybrid"]["evaluatedQueries"] == 0
    assert report["coverage"] == {
        "eligible": 3188,
        "keywordCurrent": 3188,
        "semanticCurrent": 3188,
        "semanticExceptionCount": 0,
    }
    assert report["latency"] == {"sampleCount": 30, "p95Ms": 2027.124}
    assert report["readiness"] == "needs_revision"


# --- OPT1 lean automatic smoke baseline ---------------------------------------


def _smoke_fixtures(
    *,
    rankings: dict[str, list[str]] | None = None,
    documents_by_query: dict[str, dict[str, Any]] | None = None,
    interpretation: dict[str, dict[str, Any]] | None = None,
    broadening: dict[str, Any] | None = None,
    with_date_metadata: bool = False,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Build a synthetic capture that binds every committed smoke phrase.

    Only the smoke path is exercised; nothing the assertions check is stubbed.
    """

    rankings = rankings or {}
    documents_by_query = documents_by_query or {}
    interpretation = interpretation or {}
    broadening = broadening or {}
    queries: list[dict[str, Any]] = []
    runs: list[dict[str, Any]] = []
    searches: list[dict[str, Any]] = []
    for index, query in enumerate(SMOKE_QUERIES, 1):
        run_id = f"r{index:02d}"
        served = rankings.get(query, [] if index in (9, 10) else [f"clip-{index}"])
        queries.append({"id": run_id, "query": query, "judgments": []})
        run: dict[str, Any] = {
            "queryId": run_id,
            "retrievalEvidenceComplete": True,
            "rankings": {"keyword": [], "semantic": [], "hybrid": served},
            "documents": documents_by_query.get(query, {}),
        }
        if with_date_metadata:
            run["interpretation"] = interpretation.get(query, {"facets": []})
            run["dateBroadening"] = broadening.get(query)
        runs.append(run)
        search: dict[str, Any] = {
            "id": f"s{index:02d}",
            "query": query,
            "expectation": "empty" if index in (9, 10) else "non_empty",
            "evidence": {"kind": "offline_capture", "runId": run_id, "capturedQuery": query},
        }
        if index == 2:
            search["expectation"] = "broadened_from_empty_exact"
            search["date"] = {"from": "2026-03-30", "to": "2026-03-30", "label": "30 mars 2026"}
        if index == 3:
            search["expectation"] = "exact_date_no_broadening"
            search["date"] = {"from": "2026-06-22", "to": "2026-06-22", "label": "22 juni 2026"}
        searches.append(search)
    documents = {"indexVersion": INDEX_VERSION, "runs": runs}
    smoke = {
        "schemaVersion": 1,
        "versions": {
            "searchVersion": "pleni-search-v2",
            "rankingVersion": "pleni-search-v2",
            "indexVersion": INDEX_VERSION,
            "capturedAt": "2026-08-25T17:00:10Z",
        },
        "searches": searches,
    }
    return documents, {"queries": queries}, smoke


def _committed_smoke() -> dict[str, Any]:
    return smoke_baseline(
        _load_json(FIXTURES / "documents.json"),
        _load_json(FIXTURES / "judgments.json"),
        _load_json(FIXTURES / "smoke.json"),
    )


def _by_id(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {row["id"]: row for row in payload["searches"]}


def _walk(value: Any) -> Iterator[tuple[str | None, Any]]:
    """Yield every (key, value) pair reachable in a JSON-shaped payload."""

    if isinstance(value, dict):
        for key, child in value.items():
            yield key, child
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def test_smoke_baseline_replays_exactly_the_ten_committed_phrases() -> None:
    payload = _committed_smoke()

    assert payload["evidenceKind"] == "engineering_smoke_evidence"
    assert payload["smokeQueryCount"] == 10
    assert [row["query"] for row in payload["searches"]] == list(SMOKE_QUERIES)
    assert [row["id"] for row in payload["searches"]] == [f"s{i:02d}" for i in range(1, 11)]
    assert payload["failedSearches"] == []


def test_smoke_phrase_set_cannot_silently_drift() -> None:
    documents, judgments, smoke = _smoke_fixtures()
    smoke["searches"][4]["query"] = "en helt annan fråga"

    with pytest.raises(EvaluationError, match="not the committed phrase"):
        smoke_baseline(documents, judgments, smoke)


def test_smoke_rejects_a_phrase_bound_to_another_captured_query() -> None:
    documents, judgments, smoke = _smoke_fixtures()
    # "elsparkcykel" must never claim the captured "elsparkcyklar" evidence.
    smoke["searches"][0]["evidence"]["runId"] = "r05"

    with pytest.raises(EvaluationError, match="bound to a different captured phrase"):
        smoke_baseline(documents, judgments, smoke)


def test_smoke_negative_phrases_remain_empty() -> None:
    payload = _by_id(_committed_smoke())

    negatives = (("s09", "bananministeriet på månen"), ("s10", "kvantdatorer på varje förskola"))
    for search_id, query in negatives:
        row = payload[search_id]
        assert row["query"] == query
        assert row["expectation"] == "empty"
        assert row["status"] == "pass"
        assert row["observed"]["resultCount"] == 0
        assert row["observed"]["clipIds"] == []


def test_smoke_negative_phrase_with_any_result_fails() -> None:
    documents, judgments, smoke = _smoke_fixtures(
        rankings={"bananministeriet på månen": ["clip-filler"]}
    )

    payload = smoke_baseline(documents, judgments, smoke)

    assert payload["failedSearches"] == ["s09"]
    assert _by_id(payload)["s09"]["failures"] == ["expected an empty result, captured 1"]


def test_smoke_positive_phrases_keep_their_captured_behaviour() -> None:
    payload = _by_id(_committed_smoke())

    captured = (("s04", "q02"), ("s05", "q03"), ("s06", "q05"), ("s07", "q09"), ("s08", "q24"))
    for search_id, run_id in captured:
        row = payload[search_id]
        assert row["status"] == "pass", row
        assert row["expectation"] == "non_empty"
        assert row["observed"]["runId"] == run_id
        assert row["observed"]["resultCount"] > 0
        assert row["observed"]["retrievalEvidenceComplete"] is True


def test_smoke_descriptive_semantic_phrase_stays_non_empty() -> None:
    row = _by_id(_committed_smoke())["s04"]

    assert row["query"] == "trafiksäkerhet för små elektriska hyrfordon"
    assert row["observed"]["resultCount"] == 10
    assert row["status"] == "pass"


def test_smoke_positive_phrase_that_goes_empty_fails() -> None:
    documents, judgments, smoke = _smoke_fixtures(rankings={"barnfattigdom": []})

    payload = smoke_baseline(documents, judgments, smoke)

    assert payload["failedSearches"] == ["s05"]
    assert _by_id(payload)["s05"]["failures"] == ["expected a non-empty result, captured 0"]


def test_smoke_exact_date_phrase_stays_exact_without_a_broadening_notice() -> None:
    query = "elsparkcykel 22 juni"
    documents, judgments, smoke = _smoke_fixtures(
        with_date_metadata=True,
        rankings={query: ["clip-june"]},
        documents_by_query={query: {"clip-june": {"title": "Juni", "debateDate": "2026-06-22"}}},
        interpretation={query: {"facets": [{"kind": "date"}, {"kind": "topic"}]}},
        broadening={query: None},
    )

    row = _by_id(smoke_baseline(documents, judgments, smoke))["s03"]

    assert row["status"] == "pass"
    assert row["observed"]["dateBroadening"] is None
    assert row["observed"]["debateDates"] == ["2026-06-22"]


def test_smoke_exact_date_phrase_that_reports_broadening_fails() -> None:
    query = "elsparkcykel 22 juni"
    documents, judgments, smoke = _smoke_fixtures(
        with_date_metadata=True,
        rankings={query: ["clip-elsewhere"]},
        documents_by_query={
            query: {"clip-elsewhere": {"title": "Maj", "debateDate": "2026-05-08"}}
        },
        interpretation={query: {"facets": [{"kind": "topic"}]}},
        broadening={
            query: {
                "kind": "date",
                "label": "22 juni 2026",
                "from": "2026-06-22",
                "to": "2026-06-22",
            }
        },
    )

    row = _by_id(smoke_baseline(documents, judgments, smoke))["s03"]

    assert row["status"] == "fail"
    assert "an exact date search must not report date broadening" in row["failures"]
    assert "an exact date search must keep its date facet" in row["failures"]


def test_smoke_broadened_phrase_must_exclude_the_original_date_range() -> None:
    query = "elsparkcykel 30 mars"
    broadened = {"kind": "date", "label": "30 mars 2026", "from": "2026-03-30", "to": "2026-03-30"}
    documents, judgments, smoke = _smoke_fixtures(
        with_date_metadata=True,
        rankings={query: ["clip-june", "clip-may"]},
        documents_by_query={
            query: {
                "clip-june": {"title": "Juni", "debateDate": "2026-06-22"},
                "clip-may": {"title": "Maj", "debateDate": "2026-05-08"},
            }
        },
        interpretation={query: {"facets": [{"kind": "topic"}]}},
        broadening={query: broadened},
    )

    row = _by_id(smoke_baseline(documents, judgments, smoke))["s02"]

    assert row["status"] == "pass"
    assert row["observed"]["dateBroadening"] == broadened


def test_smoke_broadened_phrase_returning_an_excluded_date_fails() -> None:
    query = "elsparkcykel 30 mars"
    documents, judgments, smoke = _smoke_fixtures(
        with_date_metadata=True,
        rankings={query: ["clip-march", "clip-june"]},
        documents_by_query={
            query: {
                "clip-march": {"title": "Mars", "debateDate": "2026-03-30"},
                "clip-june": {"title": "Juni", "debateDate": "2026-06-22"},
            }
        },
        interpretation={query: {"facets": [{"kind": "date"}, {"kind": "topic"}]}},
        broadening={query: None},
    )

    row = _by_id(smoke_baseline(documents, judgments, smoke))["s02"]

    assert row["status"] == "fail"
    assert "a broadened search must report its removed date range" in row["failures"]
    assert "a broadened search must drop the relaxed date facet" in row["failures"]
    assert "broadened search returned 1 rows from the excluded range" in row["failures"]


def test_smoke_date_expectations_are_blocked_rather_than_guessed() -> None:
    payload = _committed_smoke()
    rows = _by_id(payload)

    assert payload["blockedSearches"] == ["s01", "s02", "s03"]
    for search_id in ("s01", "s02", "s03"):
        row = rows[search_id]
        assert row["status"] == "blocked_needs_capture"
        assert row["observed"] is None
        assert "OpenAI" in row["blockedReason"]
    # An honest blocker must never be reported as a pass.
    assert payload["passCount"] == 7
    assert payload["failCount"] == 0


def test_smoke_records_the_known_elflyg_false_positives_as_forbidden() -> None:
    payload = _committed_smoke()
    defects = payload["knownOpenDefects"]

    assert len(defects) == 1
    assert tuple(defects[0]["clipIds"]) == ELFLYG_FALSE_POSITIVES
    assert defects[0]["identifiedFrom"]["runId"] == "q01"
    assert defects[0]["ownedBy"] == "OPT2"


def test_forbidden_elflyg_ids_match_the_captured_scooter_run() -> None:
    documents = _load_json(FIXTURES / "documents.json")
    run = next(row for row in documents["runs"] if row["queryId"] == "q01")

    assert tuple(run["rankings"]["hybrid"][7:10]) == ELFLYG_FALSE_POSITIVES
    for clip_id in ELFLYG_FALSE_POSITIVES:
        assert "elflyg" in run["documents"][clip_id]["title"]
        assert run["documents"][clip_id]["matchKind"] == "context"


def test_smoke_reports_forbidden_hits_for_a_scooter_phrase() -> None:
    query = "elsparkcykel"
    documents, judgments, smoke = _smoke_fixtures(
        rankings={query: ["clip-good", ELFLYG_FALSE_POSITIVES[0]]}
    )
    smoke["forbiddenExamples"] = {
        "scooterElflygContextFiller": {
            "clipIds": list(ELFLYG_FALSE_POSITIVES),
            "currentlyPresentInCapture": True,
        }
    }
    smoke["searches"][0]["forbiddenExample"] = "scooterElflygContextFiller"

    row = _by_id(smoke_baseline(documents, judgments, smoke))["s01"]

    assert row["forbiddenExample"] == {
        "name": "scooterElflygContextFiller",
        "observedHits": [ELFLYG_FALSE_POSITIVES[0]],
    }


def test_smoke_records_search_index_and_ranking_versions() -> None:
    versions = _committed_smoke()["versions"]
    # The frozen capture was produced by v2. OPT2 shipped v3, so the baseline is
    # the before-state of that change and mirrors the rollback constant.
    # Relabelling it v3 would falsify which ranking produced the capture.
    rollback_version = re.search(
        r'SEARCH_RANKING_ROLLBACK_VERSION = "([^"]+)"',
        EDGE_RANKING.read_text(encoding="utf-8"),
    )

    assert rollback_version is not None
    assert versions["searchVersion"] == rollback_version.group(1)
    assert versions["rankingVersion"] == rollback_version.group(1)
    assert versions["indexVersion"] == INDEX_VERSION
    assert versions["capturedAt"] == "2026-08-25T17:00:10Z"
    assert versions["interpretationYearBasis"] == "2026"


def test_smoke_refuses_a_baseline_pinned_to_another_index_version() -> None:
    documents, judgments, smoke = _smoke_fixtures()
    documents["indexVersion"] = "openai:text-embedding-3-large:1024:v2"

    with pytest.raises(EvaluationError, match="indexVersion does not match"):
        smoke_baseline(documents, judgments, smoke)


def test_smoke_output_never_carries_private_scores_or_credentials() -> None:
    payload = _committed_smoke()
    rendered = json.dumps(payload, ensure_ascii=False) + render_smoke_report(payload)

    for key, _ in _walk(payload):
        assert key not in SMOKE_PRIVATE_DOCUMENT_FIELDS
        assert key not in {"embedding", "queryEmbedding", "clientAddress", "clientKey"}
    for secret in ("_evaluationSimilarity", "_evaluationLexicalCoverage", "Bearer ", "sk-", "eyJ"):
        assert secret not in rendered
    for name in ("OPENAI_API_KEY", "RIKET_SUPABASE_ACCESS_TOKEN", "RIKET_SUPABASE_PROJECT_REF"):
        assert name not in rendered


def test_smoke_output_carries_only_committed_phrases_never_a_user_query() -> None:
    payload = _committed_smoke()

    replayed = [row["query"] for row in payload["searches"]]
    assert replayed == list(SMOKE_QUERIES)
    # Every other phrase in the payload must also come from a committed fixture:
    # provenance may name the captured audit query the forbidden ids were found
    # in, but nothing outside the repository fixtures may ever appear.
    committed = set(SMOKE_QUERIES) | {
        query["query"] for query in _load_json(FIXTURES / "judgments.json")["queries"]
    }
    phrases = [value for key, value in _walk(payload) if key in {"query", "capturedQuery"}]
    assert phrases
    assert set(phrases) <= committed


def test_smoke_creates_no_grades_or_human_relevance_denominators() -> None:
    payload = _committed_smoke()

    for key, _ in _walk(payload):
        assert key not in {
            "grade",
            "grades",
            "judgments",
            "ndcgAt10",
            "meanNdcgAt10",
            "precisionAt10",
            "reviewStatus",
        }
    # The judgment fixture must stay untouched and ungraded.
    judgments = _load_json(FIXTURES / "judgments.json")
    assert all(query["judgments"] == [] for query in judgments["queries"])
    assert {query["reviewStatus"] for query in judgments["queries"]} == {"pending_manual"}


def test_smoke_report_is_labelled_engineering_evidence_and_shows_five_rows() -> None:
    report = render_smoke_report(_committed_smoke())

    assert "**Engineering smoke evidence.**" in report
    assert "human-validated relevance evidence" in report
    assert "not a topic whitelist" in report
    assert report.count("| # | Title | Excerpt |") == 5
    assert "0.489577" not in report


def test_smoke_output_and_report_are_byte_identical_for_identical_inputs(tmp_path: Path) -> None:
    first_json, second_json = tmp_path / "a.json", tmp_path / "b.json"
    first_report, second_report = tmp_path / "a.md", tmp_path / "b.md"

    for output, report in ((first_json, first_report), (second_json, second_report)):
        assert main(["smoke", "--output", str(output), "--report", str(report)]) == 0

    assert first_json.read_bytes() == second_json.read_bytes()
    assert first_report.read_bytes() == second_report.read_bytes()


def test_smoke_strict_release_passes_while_only_blocked_evidence_remains(tmp_path: Path) -> None:
    exit_code = main(
        [
            "smoke",
            "--strict-release",
            "--output",
            str(tmp_path / "smoke.json"),
            "--report",
            str(tmp_path / "smoke.md"),
        ]
    )

    assert exit_code == 0


def test_smoke_strict_release_fails_on_a_real_regression(tmp_path: Path) -> None:
    documents, judgments, smoke = _smoke_fixtures(
        rankings={"kvantdatorer på varje förskola": ["clip-filler"]}
    )
    paths = {}
    for name, payload in (("documents", documents), ("judgments", judgments), ("smoke", smoke)):
        paths[name] = tmp_path / f"{name}.json"
        paths[name].write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    exit_code = main(
        [
            "smoke",
            "--strict-release",
            "--documents",
            str(paths["documents"]),
            "--judgments",
            str(paths["judgments"]),
            "--smoke",
            str(paths["smoke"]),
            "--output",
            str(tmp_path / "out.json"),
            "--report",
            str(tmp_path / "out.md"),
        ]
    )

    assert exit_code == 1


# --- OPT2 candidate-level admission grid -------------------------------------

SELECTED_CONFIGURATION_ID = "sim0.50-lex0.67-kw1.50-sem1.00-k50"
SELECTED_CANDIDATE_SIMILARITY = 0.50
SELECTED_CANDIDATE_LEXICAL_COVERAGE = 0.67
MIGRATION_029 = ROOT / "migrations" / "029_search_candidate_admission.up.sql"
MIGRATION_029_DOWN = ROOT / "migrations" / "029_search_candidate_admission.down.sql"


def _edge_constant(name: str) -> str:
    """Read one exported constant out of ranking.ts."""

    match = re.search(rf"{name} = ([^;]+);", EDGE_RANKING.read_text(encoding="utf-8"))
    assert match is not None, f"{name} is missing from ranking.ts"
    value = match.group(1).strip().removesuffix("as const").strip()
    return value.strip('"')


def _grid_document(
    similarity: float | None,
    coverage: float | None,
    match_kind: str,
) -> dict[str, Any]:
    document: dict[str, Any] = {"matchKind": match_kind}
    if similarity is not None:
        document["semanticSimilarity"] = similarity
    if coverage is not None:
        document["lexicalCoverage"] = coverage
    return document


def _grid_fixtures(
    *,
    rankings: dict[str, list[str]] | None = None,
    documents_by_query: dict[str, dict[str, Any]] | None = None,
    forbidden_ids: tuple[str, ...] = ELFLYG_FALSE_POSITIVES,
    forbidden_query: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Build a synthetic capture the admission grid can replay."""

    documents, judgments, smoke = _smoke_fixtures(
        rankings=rankings, documents_by_query=documents_by_query
    )
    # A captured candidate always carries a matchKind. Default the phrases a
    # test does not care about to keyword-matched so they stay admitted and
    # cannot quietly move the counts the test is asserting on.
    for run in documents["runs"]:
        served = run["rankings"]["hybrid"]
        run["documents"] = {
            clip_id: run["documents"].get(clip_id, {"matchKind": "keyword"}) for clip_id in served
        }
    query = forbidden_query or SMOKE_QUERIES[0]
    run_id = next(row["id"] for row in judgments["queries"] if row["query"] == query)
    smoke["forbiddenExamples"] = {
        "scooterElflygContextFiller": {
            "clipIds": list(forbidden_ids),
            "currentlyPresentInCapture": True,
            "identifiedFrom": {"capturedQuery": query, "runId": run_id},
            "ownedBy": "OPT2",
        }
    }
    return documents, judgments, smoke


def _committed_grid() -> dict[str, Any]:
    return admission_grid(
        _load_json(FIXTURES / "documents.json"),
        _load_json(FIXTURES / "judgments.json"),
        _load_json(FIXTURES / "smoke.json"),
    )


def _by_configuration(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {row["configurationId"]: row for row in payload["configurations"]}


def test_grid_enumerates_exactly_the_documented_axes() -> None:
    payload = _committed_grid()

    assert payload["configurationCount"] == 5 * 3 * 2 * 2 * 3 == 180
    assert {row["candidateSimilarity"] for row in payload["configurations"]} == {
        0.40,
        0.45,
        0.48,
        0.50,
        0.53,
    }
    assert {row["candidateLexicalCoverage"] for row in payload["configurations"]} == {
        0.34,
        0.50,
        0.67,
    }
    assert {row["keywordWeight"] for row in payload["configurations"]} == {1.5, 2.0}
    assert {row["semanticWeight"] for row in payload["configurations"]} == {0.75, 1.0}
    assert {row["rrfK"] for row in payload["configurations"]} == {40, 50, 60}


def test_grid_selects_the_conservative_configuration() -> None:
    payload = _committed_grid()
    selected = payload["selected"]

    assert selected is not None
    assert selected["configurationId"] == SELECTED_CONFIGURATION_ID
    assert selected["candidateSimilarity"] == SELECTED_CANDIDATE_SIMILARITY
    assert selected["candidateLexicalCoverage"] == SELECTED_CANDIDATE_LEXICAL_COVERAGE
    # No fusion weight changed: only the two candidate thresholds are new.
    assert selected["keywordWeight"] == 1.5
    assert selected["semanticWeight"] == 1.0
    assert selected["rrfK"] == 50
    assert selected["usesProductionFusion"] is True
    assert all(selected["gates"].values())


def test_grid_selection_has_the_fewest_semantic_only_tail_candidates() -> None:
    payload = _committed_grid()
    survivors = [row for row in payload["configurations"] if row["passes"]]
    selected = payload["selected"]

    assert survivors
    assert selected["semanticOnlyAdmitted"] == min(row["semanticOnlyAdmitted"] for row in survivors)


def test_grid_never_claims_a_judged_metric() -> None:
    """The grid reports membership only: no metric key may appear anywhere."""

    payload = _committed_grid()

    assert payload["evidenceKind"] == "engineering_admission_grid_evidence"
    forbidden = {
        "ndcg",
        "ndcgat10",
        "precision",
        "precisionat10",
        "grade",
        "grades",
        "judgment",
        "relevance",
        "score",
        "best",
    }
    for key, _ in _walk(payload):
        if key is not None:
            assert key.lower() not in forbidden, key


def test_grid_removes_the_known_elflyg_false_positives() -> None:
    selected = _committed_grid()["selected"]

    examples = selected["forbiddenExamples"]
    assert len(examples) == 1
    assert examples[0]["observedHits"] == []
    assert examples[0]["runId"] == "q01"
    # The scooter run keeps its keyword head and one strong context candidate.
    assert examples[0]["baselineCount"] == 10
    assert examples[0]["admittedCount"] == 6


def test_grid_discards_configurations_that_keep_the_elflyg_filler() -> None:
    payload = _committed_grid()
    weak = [row for row in payload["configurations"] if row["candidateSimilarity"] == 0.40]

    assert len(weak) == 36
    for row in weak:
        assert row["gates"]["forbiddenExamplesRemoved"] is False
        assert row["passes"] is False
        assert row["forbiddenExamples"][0]["observedHits"] == list(ELFLYG_FALSE_POSITIVES)


def test_grid_discards_configurations_that_starve_a_positive_search() -> None:
    payload = _committed_grid()
    strict = [row for row in payload["configurations"] if row["candidateSimilarity"] == 0.53]

    assert len(strict) == 36
    for row in strict:
        assert row["gates"]["retainsMinimumResults"] is False
        assert row["passes"] is False


def test_grid_keeps_the_descriptive_semantic_search_non_empty() -> None:
    payload = _committed_grid()

    for row in payload["configurations"]:
        descriptive = next(item for item in row["searches"] if item["id"] == "s04")
        if row["passes"]:
            assert descriptive["admittedCount"] > 0
            assert row["gates"]["descriptiveSemanticNonEmpty"] is True


def test_grid_never_drops_a_keyword_matched_candidate() -> None:
    payload = _committed_grid()

    for row in payload["configurations"]:
        assert row["gates"]["keywordMatchedPreserved"] is True
        for search in row["searches"]:
            assert search["droppedKeywordMatched"] == []
        for example in row["forbiddenExamples"]:
            assert example["droppedKeywordMatched"] == []


def test_grid_keeps_negative_searches_empty_in_every_configuration() -> None:
    payload = _committed_grid()

    for row in payload["configurations"]:
        assert row["gates"]["negativesStayEmpty"] is True
        for search in row["searches"]:
            if search["expectation"] == "empty":
                assert search["admittedCount"] == 0


def test_grid_never_fills_a_quota() -> None:
    payload = _committed_grid()

    for row in payload["configurations"]:
        for search in row["searches"]:
            # Admission only removes. A shorter list is allowed; a longer one
            # would mean the replay invented a candidate.
            assert search["admittedCount"] <= search["baselineCount"]


def test_grid_admission_is_candidate_specific() -> None:
    """A strong candidate must not admit a weaker one in the same query."""

    query = SMOKE_QUERIES[3]
    documents, judgments, smoke = _grid_fixtures(
        rankings={query: ["strong", "weak"]},
        documents_by_query={
            query: {
                "strong": _grid_document(0.90, 0.0, "context"),
                "weak": _grid_document(0.10, 0.0, "context"),
            }
        },
    )

    payload = admission_grid(documents, judgments, smoke)
    row = next(
        item
        for item in _by_configuration(payload)[SELECTED_CONFIGURATION_ID]["searches"]
        if item["id"] == "s04"
    )

    assert row["baselineCount"] == 2
    assert row["admittedCount"] == 1


def test_grid_admits_a_semantic_only_candidate_on_lexical_coverage_alone() -> None:
    query = SMOKE_QUERIES[3]
    documents, judgments, smoke = _grid_fixtures(
        rankings={query: ["compound"]},
        documents_by_query={query: {"compound": _grid_document(0.10, 0.80, "context")}},
    )

    payload = admission_grid(documents, judgments, smoke)
    row = next(
        item
        for item in _by_configuration(payload)[SELECTED_CONFIGURATION_ID]["searches"]
        if item["id"] == "s04"
    )

    assert row["admittedCount"] == 1


def test_grid_exempts_keyword_matched_candidates_from_their_own_scores() -> None:
    query = SMOKE_QUERIES[3]
    documents, judgments, smoke = _grid_fixtures(
        rankings={query: ["keyword-only", "both-weak"]},
        documents_by_query={
            query: {
                # No captured scores at all, and a score far below every bar.
                "keyword-only": _grid_document(None, None, "keyword"),
                "both-weak": _grid_document(0.01, 0.0, "both"),
            }
        },
    )

    payload = admission_grid(documents, judgments, smoke)
    row = next(
        item
        for item in _by_configuration(payload)[SELECTED_CONFIGURATION_ID]["searches"]
        if item["id"] == "s04"
    )

    assert row["admittedCount"] == 2
    assert row["semanticOnlyAdmitted"] == 0


def test_grid_membership_is_independent_of_the_fusion_weights() -> None:
    """The fusion axes change order only, so membership must not move."""

    payload = _committed_grid()
    grouped: dict[tuple[float, float], set[int]] = {}
    for row in payload["configurations"]:
        key = (row["candidateSimilarity"], row["candidateLexicalCoverage"])
        grouped.setdefault(key, set()).add(row["semanticOnlyAdmitted"])

    assert len(grouped) == 15
    for key, tails in grouped.items():
        assert len(tails) == 1, key


def test_grid_refuses_a_semantic_only_candidate_without_captured_scores() -> None:
    query = SMOKE_QUERIES[3]
    documents, judgments, smoke = _grid_fixtures(
        rankings={query: ["unscored"]},
        documents_by_query={query: {"unscored": _grid_document(None, None, "context")}},
    )

    with pytest.raises(EvaluationError, match="has no captured scores"):
        admission_grid(documents, judgments, smoke)


def test_grid_refuses_a_forbidden_example_bound_to_another_phrase() -> None:
    documents, judgments, smoke = _grid_fixtures()
    smoke["forbiddenExamples"]["scooterElflygContextFiller"]["identifiedFrom"]["capturedQuery"] = (
        "en helt annan fras"
    )

    with pytest.raises(EvaluationError, match="bound to a different phrase"):
        admission_grid(documents, judgments, smoke)


def test_grid_reports_conflicts_when_no_configuration_passes() -> None:
    """An impossible requirement must stop, not silently pick something."""

    query = SMOKE_QUERIES[3]
    documents, judgments, smoke = _grid_fixtures(
        # The forbidden clip is also the only result the descriptive search has,
        # so removing it and keeping the search non-empty cannot both hold.
        rankings={query: ["HD10398_27_c02"]},
        documents_by_query={query: {"HD10398_27_c02": _grid_document(0.99, 1.0, "context")}},
        forbidden_query=query,
    )

    payload = admission_grid(documents, judgments, smoke)

    assert payload["selected"] is None
    assert payload["survivorCount"] == 0
    assert payload["conflicts"]


def test_grid_is_deterministic_over_the_same_fixtures() -> None:
    first = json.dumps(_committed_grid(), ensure_ascii=False, sort_keys=True)
    second = json.dumps(_committed_grid(), ensure_ascii=False, sort_keys=True)

    assert first == second


def test_grid_records_the_three_blocked_scooter_phrases() -> None:
    payload = _committed_grid()

    # OPT2 may not manufacture the capture OPT1 was forbidden from taking, so
    # these stay blocked rather than being assumed green.
    assert payload["blockedSearches"] == ["s01", "s02", "s03"]


def test_grid_strict_release_exits_zero_when_a_configuration_is_selected(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(["admission-grid", "--strict-release"])
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert payload["selected"]["configurationId"] == SELECTED_CONFIGURATION_ID


def test_selected_thresholds_match_migration_029_and_ranking_ts() -> None:
    """The selected constants must not drift between SQL and TypeScript."""

    sql = MIGRATION_029.read_text(encoding="utf-8")

    assert float(_edge_constant("SEARCH_CANDIDATE_ADMISSION_SIMILARITY")) == (
        SELECTED_CANDIDATE_SIMILARITY
    )
    assert float(_edge_constant("SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE")) == (
        SELECTED_CANDIDATE_LEXICAL_COVERAGE
    )
    assert f"candidate.similarity >= {SELECTED_CANDIDATE_SIMILARITY:.2f}" in sql
    assert f"candidate.lexical_coverage >= {SELECTED_CANDIDATE_LEXICAL_COVERAGE:.2f}" in sql
    # The v2 query-level gate is kept, not replaced.
    assert "top_similarity >= 0.53" in sql
    assert "top_lexical_coverage >= 0.67" in sql


def test_migration_029_is_additive_and_reversible() -> None:
    up = MIGRATION_029.read_text(encoding="utf-8")
    down = MIGRATION_029_DOWN.read_text(encoding="utf-8")

    assert "create or replace function public.search_clip_candidates_v3(" in up
    assert "drop function if exists public.search_clip_candidates_v3(" in down
    # v2 stays deployed for rollback and no earlier migration is rewritten.
    assert "search_clip_candidates_v2" not in down
    assert "drop function if exists public.search_clip_candidates_v2" not in up
    assert "drop table" not in down
    assert "alter table" not in up
    # No recency boost, and date stays a filter plus a deterministic tie-break.
    assert "published_at" not in up
    assert "order by\n        fused.fusion_score desc,\n        fused.debate_date desc," in up


def test_ranking_version_does_not_drift_between_sql_and_typescript() -> None:
    assert _edge_constant("SEARCH_RANKING_VERSION") == "pleni-search-v3"
    assert _edge_constant("SEARCH_RANKING_ROLLBACK_VERSION") == "pleni-search-v2"
    edge_function = (ROOT / "supabase" / "functions" / "clip-search" / "index.ts").read_text(
        encoding="utf-8"
    )

    # The Edge Function must call the version its constants describe.
    assert "search_clip_candidates_v3" in edge_function
    assert "search_clip_candidates_v2" not in edge_function


def test_earlier_search_migrations_are_untouched() -> None:
    """022-028 are immutable; OPT2 adds 029 beside them."""

    migrations = ROOT / "migrations"
    for number in range(22, 29):
        matches = sorted(migrations.glob(f"{number:03d}_*.up.sql"))
        assert len(matches) == 1
        assert "search_clip_candidates_v3" not in matches[0].read_text(encoding="utf-8")


def test_grid_never_leaks_a_private_ranking_score() -> None:
    payload = _committed_grid()
    rendered = json.dumps(payload, ensure_ascii=False)

    for key, _ in _walk(payload):
        if key is None:
            continue
        assert key not in SMOKE_PRIVATE_DOCUMENT_FIELDS
        assert key not in {"embedding", "queryEmbedding", "clientAddress", "clientKey"}
    for secret in ("Bearer ", "sk-", "eyJ"):
        assert secret not in rendered


def test_grid_before_after_shows_the_elflyg_rows_leaving_the_scooter_search() -> None:
    payload = _committed_grid()
    row = next(
        item for item in payload["beforeAfter"] if item["id"] == "scooterElflygContextFiller"
    )

    dropped = {item["clipId"] for item in row["dropped"]}
    assert set(ELFLYG_FALSE_POSITIVES) <= dropped
    assert row["beforeCount"] == 10
    assert row["afterCount"] == 6
    # The served head is untouched: every drop came from the tail.
    assert [item["clipId"] for item in row["before"]] == [item["clipId"] for item in row["after"]]


def test_grid_before_after_keeps_every_top_five_position_unchanged() -> None:
    payload = _committed_grid()

    for row in payload["beforeAfter"]:
        assert [item["clipId"] for item in row["before"]] == [
            item["clipId"] for item in row["after"]
        ], row["id"]


def test_grid_report_is_deterministic_and_labels_its_evidence() -> None:
    payload = _committed_grid()
    first = render_admission_grid_report(payload)
    second = render_admission_grid_report(payload)

    assert first == second
    assert first.endswith("\n")
    assert "Engineering evidence" in first
    assert "not" in first and "human-validated relevance evidence" in first
    assert "no relevance grade" in first
    for clip_id in ELFLYG_FALSE_POSITIVES:
        assert clip_id in first


def test_grid_report_reports_a_conflict_instead_of_inventing_a_choice() -> None:
    query = SMOKE_QUERIES[3]
    documents, judgments, smoke = _grid_fixtures(
        rankings={query: ["HD10398_27_c02"]},
        documents_by_query={query: {"HD10398_27_c02": _grid_document(0.99, 1.0, "context")}},
        forbidden_query=query,
    )

    rendered = render_admission_grid_report(admission_grid(documents, judgments, smoke))

    assert "No configuration passed the required gates" in rendered
