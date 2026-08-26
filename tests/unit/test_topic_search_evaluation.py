from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scripts.evaluate_topic_search import (
    EvaluationError,
    _capture_plan,
    _capture_sql,
    _load_json,
    _secret,
    dcg,
    evaluate,
    main,
    ndcg,
    percentile,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "search"


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
