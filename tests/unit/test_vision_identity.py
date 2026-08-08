"""Tests for C8 speaker identity verification."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.contracts import IdentityEvidence, VerificationDecision
from src.errors import ExternalServiceError
from src.vision.identity import (
    SFACE_MODEL_NAME,
    SFACE_MODEL_SHA256,
    EnrolmentCache,
    IdentityThresholds,
    RiksdagenPortraitSource,
    build_evidence,
    cosine_similarity,
    decide,
    portrait_digest,
    roster_from_source,
)


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self.body = body


class _FakeClient:
    """Records calls so caching can be asserted rather than assumed."""

    def __init__(self, body: bytes = b"jpeg-bytes", fail: bool = False) -> None:
        self.body = body
        self.fail = fail
        self.calls: list[str] = []

    def get(self, url: str, *, accept: str = "application/json") -> _FakeResponse:
        self.calls.append(url)
        if self.fail:
            raise ExternalServiceError("boom")
        return _FakeResponse(self.body)


def test_cosine_similarity_matches_hand_computed_values() -> None:
    assert cosine_similarity((1.0, 0.0), (1.0, 0.0)) == pytest.approx(1.0)
    assert cosine_similarity((1.0, 0.0), (0.0, 1.0)) == pytest.approx(0.0)
    assert cosine_similarity((1.0, 0.0), (-1.0, 0.0)) == pytest.approx(-1.0)
    assert cosine_similarity((), (1.0,)) == 0.0
    assert cosine_similarity((0.0, 0.0), (1.0, 1.0)) == 0.0


def test_evidence_uses_robust_summaries_not_the_best_frame() -> None:
    """One lucky frame must not carry a track that is otherwise a poor match, so
    the track is described by its median and 20th percentile."""

    evidence = build_evidence(
        (0.05, 0.06, 0.07, 0.08, 0.95),
        intressent_id="123",
        portrait_sha256="abc",
        competitor_median=0.02,
    )

    assert evidence.embedding_count == 5
    assert evidence.median_similarity == pytest.approx(0.07)
    assert evidence.p20_similarity == pytest.approx(0.06)
    assert evidence.competitor_margin == pytest.approx(0.05)


def test_evidence_with_no_samples_is_empty_not_zero_confidence() -> None:
    evidence = build_evidence((), intressent_id="1", portrait_sha256="a", competitor_median=0.0)

    assert evidence.embedding_count == 0
    assert evidence.median_similarity == 0.0


def test_each_threshold_rejects_for_its_own_reason() -> None:
    thresholds = IdentityThresholds()
    base = {"intressent_id": "1", "portrait_sha256": "a"}

    too_few = IdentityEvidence(
        **base, embedding_count=1, median_similarity=0.9, p20_similarity=0.9,
        competitor_margin=0.9,
    )
    low_median = IdentityEvidence(
        **base, embedding_count=9, median_similarity=0.10, p20_similarity=0.9,
        competitor_margin=0.9,
    )
    low_p20 = IdentityEvidence(
        **base, embedding_count=9, median_similarity=0.9, p20_similarity=0.01,
        competitor_margin=0.9,
    )
    thin_margin = IdentityEvidence(
        **base, embedding_count=9, median_similarity=0.9, p20_similarity=0.9,
        competitor_margin=0.01,
    )

    assert thresholds.evaluate(too_few, has_competitor=False) == "too_few_quality_embeddings"
    assert thresholds.evaluate(low_median, has_competitor=False) == "median_similarity_below_floor"
    assert thresholds.evaluate(low_p20, has_competitor=False) == "p20_similarity_below_floor"
    assert thresholds.evaluate(thin_margin, has_competitor=True) == (
        "margin_over_competing_face_too_small"
    )
    assert thresholds.evaluate(thin_margin, has_competitor=False) is None, (
        "a thin margin against nobody is not ambiguity"
    )


def test_a_correct_match_at_the_lfw_threshold_is_still_accepted() -> None:
    """Measured on real footage: a verified correct match landed at 0.366 --
    essentially on top of OpenCV's documented 0.363 LFW figure -- while beating
    the runner-up by +0.299. Gating on the published absolute threshold would
    have thrown this away. The margin is what discriminates here.
    """

    evidence = build_evidence(
        (0.366, 0.372, 0.361, 0.380),
        intressent_id="1",
        portrait_sha256="a",
        competitor_median=0.067,
    )

    assert IdentityThresholds().evaluate(evidence, has_competitor=True) is None


def test_decide_maps_reasons_onto_contract_decisions() -> None:
    assert decide(None) is VerificationDecision.ACCEPTED
    assert decide("margin_over_competing_face_too_small") is VerificationDecision.REJECTED_AMBIGUOUS
    assert decide("median_similarity_below_floor") is (
        VerificationDecision.REJECTED_IDENTITY_MISMATCH
    )
    assert decide("p20_similarity_below_floor") is VerificationDecision.REJECTED_IDENTITY_MISMATCH
    assert decide("too_few_quality_embeddings") is VerificationDecision.REJECTED_NO_EVIDENCE


def test_portraits_are_fetched_once_and_cached_on_disk(tmp_path: Path) -> None:
    client = _FakeClient()
    source = RiksdagenPortraitSource(client, tmp_path)

    assert source.fetch("123") == b"jpeg-bytes"
    assert source.fetch("123") == b"jpeg-bytes"

    assert len(client.calls) == 1, "a debate's clips share speakers; fetch once"
    assert "123_max.jpg" in client.calls[0]


def test_a_transient_outage_does_not_permanently_mark_a_politician_unenrollable(
    tmp_path: Path,
) -> None:
    failing = _FakeClient(fail=True)
    source = RiksdagenPortraitSource(failing, tmp_path)

    assert source.fetch("123") is None
    assert not (tmp_path / "123.missing").exists()

    working = RiksdagenPortraitSource(_FakeClient(), tmp_path)
    assert working.fetch("123") == b"jpeg-bytes"


def test_an_empty_body_is_remembered_as_missing(tmp_path: Path) -> None:
    client = _FakeClient(body=b"")
    source = RiksdagenPortraitSource(client, tmp_path)

    assert source.fetch("123") is None
    assert source.fetch("123") is None
    assert len(client.calls) == 1


def test_enrolment_returns_none_when_no_portrait_exists() -> None:
    class _NoPortrait:
        def fetch(self, intressent_id: str) -> bytes | None:
            return None

    cache = EnrolmentCache(portraits=_NoPortrait(), detector=None, embedder=None)

    assert cache.feature_for("123") is None
    assert cache.feature_for(None) is None


def test_roster_maps_anforande_to_intressent_id() -> None:
    payload = {
        "anforanden": [
            {"anforande_id": "a1", "intressent_id": "111"},
            {"anforande_id": "a2", "intressent_id": None},
            {"anforande_id": "a3", "intressent_id": "333"},
            "not-a-mapping",
        ]
    }

    assert roster_from_source(payload) == {"a1": "111", "a3": "333"}
    assert roster_from_source({}) == {}


def test_portrait_digest_is_stable_and_content_addressed() -> None:
    assert portrait_digest(b"abc") == portrait_digest(b"abc")
    assert portrait_digest(b"abc") != portrait_digest(b"abd")
    assert len(portrait_digest(b"abc")) == 64


def test_the_vendored_recognition_model_matches_its_pinned_checksum() -> None:
    from src.vision.detect import MODEL_DIR, verify_model_checksum

    verify_model_checksum(MODEL_DIR / SFACE_MODEL_NAME, expected_sha256=SFACE_MODEL_SHA256)
