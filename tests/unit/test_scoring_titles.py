"""Tests for grounded local title generation."""

from __future__ import annotations

import json
from collections.abc import Mapping

import pytest

from src.contracts import SelectedClip, Speech
from src.errors import ExternalServiceError
from src.scoring.titles import OllamaTitleGenerator, title_validation_errors


def test_title_validation_accepts_exact_grounded_title() -> None:
    transcript = "Detta innebär att Sverige riskerar att hamna i EU:s underskottsförfarande."

    assert (
        title_validation_errors(
            "Tegnér: Sverige riskerar EU:s underskottsförfarande",
            transcript,
            transcript=transcript,
            speaker_name="Mathias Tegnér (S)",
            archetype="EXPLAIN",
        )
        == ()
    )


def test_title_validation_rejects_ungrounded_or_corrupt_output() -> None:
    errors = title_validation_errors(
        "Strömmer: Polistillväxten chockhöjs med 20 000 人",
        "Polistillväxten väntas fortsätta.",
        transcript="Polistillväxten väntas fortsätta. Regeringen har 3 000 poliser.",
        speaker_name="Gunnar Strömmer (M)",
        archetype="CONFRONT",
    )

    assert "supporting_span_not_exact" not in errors
    assert any(error.startswith("invalid_title_characters:") for error in errors)
    assert "unsupported_numbers:20" in errors
    assert any(error.startswith("ungrounded_title_words:") for error in errors)
    assert "missing_qualifiers:vantas" in errors


def test_title_validation_rejects_reordered_claim_roles() -> None:
    evidence = (
        "Under åren 2023\u20132028 beräknas anslagen till polisen öka från 37 till "
        "53 miljarder, det vill säga en ökning med 43 procent."
    )

    errors = title_validation_errors(
        "Strömmer: Polisen beräknas öka anslagen med 43 procent",
        evidence,
        transcript=evidence,
        speaker_name="Gunnar Strömmer (M)",
        archetype="EXPLAIN",
    )

    assert "title_words_out_of_evidence_order" in errors


def test_ollama_generator_retries_validation_failure() -> None:
    responses = iter(
        (
            _ollama_response(
                evidence_indices=[1],
                title="Andersson: Regeringen skapade 20 000 nya poliser",
            ),
            _ollama_response(
                evidence_indices=[1],
                title="Andersson: Regeringen har anställt 3 000 nya poliser",
            ),
        )
    )
    payloads: list[Mapping[str, object]] = []

    def transport(
        _url: str,
        payload: Mapping[str, object],
        _timeout_s: float,
    ) -> Mapping[str, object]:
        payloads.append(payload)
        return next(responses)

    result = OllamaTitleGenerator(
        endpoint="http://127.0.0.1:11434",
        model="test-model",
        timeout_s=1.0,
        max_attempts=2,
        transport=transport,
    ).generate(
        clip=_clip(),
        speech=_speech(),
        debate_title="Testdebatt",
    )

    assert result.title == "Andersson: Regeringen har anställt 3 000 nya poliser"
    assert result.attempts == 2
    assert len(payloads) == 2
    second_messages = payloads[1]["messages"]
    assert isinstance(second_messages, list)
    assert "unsupported_numbers" in str(second_messages[-1])


def test_ollama_generator_raises_after_invalid_attempts() -> None:
    def transport(
        _url: str,
        _payload: Mapping[str, object],
        _timeout_s: float,
    ) -> Mapping[str, object]:
        return _ollama_response(
            evidence_indices=[2],
            title="Andersson: En helt påhittad rubrik utan stöd",
        )

    generator = OllamaTitleGenerator(
        endpoint="http://127.0.0.1:11434",
        model="test-model",
        timeout_s=1.0,
        max_attempts=2,
        transport=transport,
    )

    with pytest.raises(ExternalServiceError, match="no grounded title"):
        generator.generate(clip=_clip(), speech=_speech(), debate_title="Testdebatt")


def _ollama_response(*, evidence_indices: list[int], title: str) -> Mapping[str, object]:
    return {
        "message": {
            "content": json.dumps(
                {"evidence_indices": evidence_indices, "title": title},
                ensure_ascii=False,
            )
        }
    }


def _clip() -> SelectedClip:
    return SelectedClip(
        clip_id="speech-1_c01",
        speech_id="speech-1",
        rank=1,
        start_s=0.0,
        end_s=40.0,
        archetype="CONFRONT",
        title="Regeringen har anställt 3 000 nya poliser.",
        transcript="Regeringen har anställt 3 000 nya poliser.",
        topic=None,
    )


def _speech() -> Speech:
    return Speech(
        speech_id="speech-1",
        dokid="dok",
        speaker_name="Anna Andersson",
        party="S",
        anforandetyp="Replik",
        start_s=0.0,
        end_s=40.0,
        official_text=None,
        alignment_confidence=1.0,
        needs_review=False,
    )
