"""Tests for grounded local title generation."""

from __future__ import annotations

import json
from collections.abc import Mapping

import pytest

from src.contracts import SelectedClip, Speech
from src.errors import ExternalServiceError
from src.scoring.titles import (
    OllamaTitleGenerator,
    OpenAICompatibleTitleGenerator,
    title_validation_errors,
)


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


# -- hosted OpenAI-compatible backend ------------------------------------


def _api_clip() -> tuple[SelectedClip, Speech]:
    speech = Speech(
        speech_id="HD1_anf1",
        dokid="HD1",
        speaker_name="Gunnar Strömmer (M)",
        party="M",
        anforandetyp="Svar",
        start_s=0.0,
        end_s=60.0,
        official_text="Antalet poliser har ökat med drygt 600 i Stockholmsregionen.",
        alignment_confidence=0.9,
        needs_review=False,
    )
    clip = SelectedClip(
        clip_id="HD1_anf1_c01",
        speech_id=speech.speech_id,
        rank=1,
        start_s=0.0,
        end_s=45.0,
        archetype="EXPLAIN",
        title="fallback",
        transcript="Antalet poliser har ökat med drygt 600 i Stockholmsregionen.",
        topic="polis",
    )
    return clip, speech


def _completion(title: str, *, usage: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "choices": [
            {
                "message": {
                    "content": json.dumps({"evidence_indices": [1], "title": title}),
                }
            }
        ],
        "usage": usage or {"prompt_tokens": 700, "completion_tokens": 30},
    }


def test_api_backend_returns_a_validated_title() -> None:
    clip, speech = _api_clip()
    calls: list[dict[str, object]] = []

    def transport(
        url: str, key: str, payload: Mapping[str, object], timeout: float
    ) -> Mapping[str, object]:
        calls.append({"url": url, "key": key, "payload": payload})
        return _completion("Strömmer: Antalet poliser har ökat med drygt 600")

    generator = OpenAICompatibleTitleGenerator(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="deepseek-chat",
        timeout_s=30.0,
        transport=transport,
    )

    result = generator.generate(clip=clip, speech=speech, debate_title="Polisdebatt")

    assert result.title == "Strömmer: Antalet poliser har ökat med drygt 600"
    assert result.attempts == 1
    assert calls[0]["url"] == "https://api.example.com/v1/chat/completions"


def test_api_backend_uses_the_same_validator_as_the_local_one() -> None:
    """The model is swappable; the fact-check is not.

    A title that invents a number must be rejected regardless of which backend
    produced it.
    """

    clip, speech = _api_clip()

    def transport(
        url: str, key: str, payload: Mapping[str, object], timeout: float
    ) -> Mapping[str, object]:
        return _completion("Strömmer: hela 9000 fler poliser i Stockholm")

    generator = OpenAICompatibleTitleGenerator(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="m",
        timeout_s=30.0,
        max_attempts=1,
        transport=transport,
    )

    with pytest.raises(ExternalServiceError):
        generator.generate(clip=clip, speech=speech, debate_title="Polisdebatt")


def test_a_too_long_title_reports_its_actual_length() -> None:
    """`invalid_json_schema:string_too_long` tells a model nothing.

    Length overshoot survived all three attempts every time in the first
    DeepSeek benchmark because the correction never said what the limit was.
    """

    clip, speech = _api_clip()
    prompts: list[str] = []

    def transport(
        url: str, key: str, payload: Mapping[str, object], timeout: float
    ) -> Mapping[str, object]:
        messages = payload["messages"]
        assert isinstance(messages, list)
        prompts.append(str(messages[-1].get("content")))
        return _completion("x" * 95)

    generator = OpenAICompatibleTitleGenerator(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="m",
        timeout_s=30.0,
        max_attempts=2,
        transport=transport,
    )

    with pytest.raises(ExternalServiceError):
        generator.generate(clip=clip, speech=speech, debate_title="Polisdebatt")

    correction = prompts[-1]
    assert "95" in correction, "the model is told how long its title actually was"
    assert "28" in correction and "60" in correction, "and what the limit is"


def test_usage_is_accumulated_across_attempts_including_cache_hits() -> None:
    clip, speech = _api_clip()

    def transport(
        url: str, key: str, payload: Mapping[str, object], timeout: float
    ) -> Mapping[str, object]:
        return _completion(
            "x" * 95,
            usage={
                "prompt_tokens": 700,
                "completion_tokens": 30,
                "prompt_cache_hit_tokens": 450,
            },
        )

    generator = OpenAICompatibleTitleGenerator(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="m",
        timeout_s=30.0,
        max_attempts=3,
        transport=transport,
    )
    with pytest.raises(ExternalServiceError):
        generator.generate(clip=clip, speech=speech, debate_title="D")

    assert generator.usage.requests == 3
    assert generator.usage.prompt_tokens == 2100
    assert generator.usage.cached_tokens == 1350
    # Cached input is billed at a fraction, so it must not be double-counted.
    cost = generator.usage.cost_usd(input_per_m=0.14, output_per_m=0.28, cached_per_m=0.014)
    assert cost == pytest.approx((750 * 0.14 + 1350 * 0.014 + 90 * 0.28) / 1_000_000)


def test_a_missing_api_key_fails_before_any_request() -> None:
    with pytest.raises(ExternalServiceError, match="API key"):
        OpenAICompatibleTitleGenerator(
            base_url="https://api.example.com/v1", api_key="", model="m", timeout_s=1.0
        )


def test_the_output_budget_leaves_room_for_a_reasoning_model() -> None:
    """Regression for a real benchmark failure.

    `deepseek-v4-pro` emits `reasoning_content` before `content`, and both are
    drawn from the same `max_tokens` budget. A 200-token cap truncated it
    mid-thought on all 16 clips, producing empty content — which is
    indistinguishable from a model that simply cannot follow instructions, and
    would have been read as "the expensive model is worse".
    """

    from src.scoring.titles import DEFAULT_MAX_TOKENS

    assert DEFAULT_MAX_TOKENS >= 2000


def test_reasoning_tokens_are_counted_because_they_are_billed_as_output() -> None:
    """On a reasoning model they dominate the bill, so hiding them hides the cost."""

    clip, speech = _api_clip()

    def transport(
        url: str, key: str, payload: Mapping[str, object], timeout: float
    ) -> Mapping[str, object]:
        return _completion(
            "Strömmer: Antalet poliser har ökat med drygt 600",
            usage={
                "prompt_tokens": 700,
                "completion_tokens": 640,
                "completion_tokens_details": {"reasoning_tokens": 600},
            },
        )

    generator = OpenAICompatibleTitleGenerator(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="reasoner",
        timeout_s=30.0,
        transport=transport,
    )
    generator.generate(clip=clip, speech=speech, debate_title="D")

    assert generator.usage.reasoning_tokens == 600
    assert generator.usage.completion_tokens == 640
