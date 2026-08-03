"""Grounded local-LLM title generation for selected Swedish clips."""

from __future__ import annotations

import json
import re
import threading
import unicodedata
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from src.contracts import SelectedClip, Speech
from src.errors import ExternalServiceError

MIN_TITLE_CHARS = 28
MAX_TITLE_CHARS = 60
DEFAULT_MAX_ATTEMPTS = 3
#: Output budget per request. A title is ~40 tokens, but a reasoning model
#: spends its thinking in the same budget and emits `content` only afterwards.
#: Capping this at 200 made deepseek-v4-pro return empty content on all 16
#: benchmark clips, and 3,000 still truncated 11 of them — reasoning length
#: varies from ~900 to well past 3,000 tokens on the same task. Truncation
#: looks exactly like a model that cannot follow instructions, so the budget
#: is set well clear of it. This is a ceiling, not an allocation: a
#: non-reasoning model stops after ~40 tokens and is billed for those.
DEFAULT_MAX_TOKENS = 16000
TOKEN_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
NUMBER_RE = re.compile(r"\d+(?:[,.]\d+)?")
ALLOWED_PUNCTUATION = frozenset(" -\u2013\u2014:,.%()'\u2019")
STOP_WORDS = frozenset(
    {
        "alla",
        "att",
        "av",
        "den",
        "det",
        "ett",
        "far",
        "for",
        "fran",
        "har",
        "hon",
        "i",
        "inte",
        "med",
        "mot",
        "och",
        "om",
        "pa",
        "sig",
        "ska",
        "som",
        "till",
        "under",
        "ur",
        "var",
        "vi",
    }
)
ALLOWED_ATTRIBUTION_WORDS = frozenset(
    {
        "anklagar",
        "fragar",
        "havdar",
        "kritiserar",
        "kraver",
        "lovar",
        "menar",
        "sager",
        "varnar",
    }
)
CLAIM_QUALIFIERS = frozenset(
    {
        "beraknas",
        "prognos",
        "prognosen",
        "prognoser",
        "riskerar",
        "troligen",
        "vantas",
    }
)
NUMBER_QUALIFIERS = frozenset({"cirka", "drygt", "minst", "nastan", "over"})
DANGLING_TITLE_ENDINGS = frozenset(
    {
        "att",
        "av",
        "den",
        "det",
        "en",
        "ett",
        "for",
        "fran",
        "i",
        "med",
        "och",
        "om",
        "pa",
        "som",
        "till",
    }
)

TITLE_SYSTEM_PROMPT = """Du är en noggrann svensk rubrikredaktör för videoklipp från Sveriges riksdag.
Arbeta i denna ordning:
1. Välj EN numrerad mening som bevis för rubriken. Returnera dess nummer i evidence_indices.
2. Skriv EN engagerande, saklig rubrik som stöds helt av den valda meningen.

RUBRIKREGLER:
- 28-60 tecken. Normal svensk meningskapitalisering.
- Välj den starkaste konkreta konflikten, konsekvensen, siffran eller formuleringen i hela klippet.
- Rubrikens innehållsord ska finnas exakt i de valda meningarna. Endast talarens namn och neutrala attributord som säger, menar, varnar, kräver och frågar får läggas till.
- Lägg aldrig till eller förstärk uppgifter. Bevara kan, väntas, beräknas, riskerar, nästan, över och andra viktiga förbehåll.
- Tillskriv anklagelser, prognoser och politiska värderingar med talarens efternamn och kolon.
- Ingen punkt mitt i rubriken. Rubriken ska vara en enda komplett fras och får inte sluta med en preposition eller konjunktion.
- Ingen all caps, emoji, vag lockfras, onödig partibeteckning eller avhugget ord.
- För CONFRONT: prioritera den specifika motsättningen.
- För EXPLAIN: prioritera den tydligaste konkreta konsekvensen eller siffran.
- För QUOTABLE: prioritera en kort slagkraftig formulering.
- Returnera endast JSON enligt schemat.

EXEMPEL:
[1] Kommunerna får 12 miljarder kronor extra till vården.
evidence_indices: [1]
title: "Kommunerna får 12 miljarder extra till vården"

[1] Däremot ägnar ministern sig åt siffertrixande.
evidence_indices: [1]
title: "Andersson: Ministern ägnar sig åt siffertrixande"""  # noqa: E501


class _TitleResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidence_indices: list[int] = Field(min_length=1, max_length=1)
    title: str = Field(min_length=MIN_TITLE_CHARS, max_length=MAX_TITLE_CHARS)


@dataclass(frozen=True)
class GeneratedTitle:
    """Validated title output and the evidence that grounded it."""

    title: str
    supporting_span: str
    attempts: int


class TitleGenerator(Protocol):
    """Title-generation boundary used by C7."""

    def generate(
        self,
        *,
        clip: SelectedClip,
        speech: Speech,
        debate_title: str,
    ) -> GeneratedTitle:
        """Generate one validated title or raise an expected pipeline error."""


JsonTransport = Callable[[str, Mapping[str, object], float], Mapping[str, object]]
AuthedJsonTransport = Callable[[str, str, Mapping[str, object], float], Mapping[str, object]]


class OllamaTitleGenerator:
    """Generate grounded titles through Ollama's local structured-output API."""

    def __init__(
        self,
        *,
        endpoint: str,
        model: str,
        timeout_s: float,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        transport: JsonTransport | None = None,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._url = f"{endpoint.rstrip('/')}/api/chat"
        self._model = model
        self._timeout_s = timeout_s
        self._max_attempts = max_attempts
        self._transport = transport or _post_json

    def generate(
        self,
        *,
        clip: SelectedClip,
        speech: Speech,
        debate_title: str,
    ) -> GeneratedTitle:
        evidence_sentences = _title_sentences(clip.transcript)
        messages = [
            {"role": "system", "content": TITLE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": _title_user_prompt(
                    clip=clip,
                    speech=speech,
                    debate_title=debate_title,
                    evidence_sentences=evidence_sentences,
                ),
            },
        ]
        last_errors: tuple[str, ...] = ("unknown_validation_error",)
        for attempt_number in range(1, self._max_attempts + 1):
            response = self._transport(
                self._url,
                {
                    "model": self._model,
                    "stream": False,
                    "think": False,
                    "messages": messages,
                    "format": _TitleResponse.model_json_schema(),
                    "keep_alive": "10m",
                    "options": {
                        "temperature": 0.15,
                        "seed": 42,
                        "num_ctx": 4096,
                    },
                },
                self._timeout_s,
            )
            raw_content = _message_content(response)
            try:
                candidate = _TitleResponse.model_validate_json(raw_content)
            except ValidationError as exc:
                last_errors = (f"invalid_json_schema:{exc.errors()[0]['type']}",)
            else:
                supporting_span = ""
                invalid_indices = sorted(
                    {
                        index
                        for index in candidate.evidence_indices
                        if index < 1 or index > len(evidence_sentences)
                    }
                )
                ordered_indices = sorted(set(candidate.evidence_indices))
                valid_sequence = ordered_indices == candidate.evidence_indices
                if invalid_indices or not valid_sequence:
                    last_errors = (
                        "invalid_evidence_indices:choose_exactly_one_valid_index",
                    )
                else:
                    supporting_span = " ".join(
                        evidence_sentences[index - 1] for index in candidate.evidence_indices
                    )
                    last_errors = title_validation_errors(
                        candidate.title,
                        supporting_span,
                        transcript=clip.transcript,
                        speaker_name=speech.speaker_name,
                        archetype=clip.archetype,
                    )
                if not last_errors:
                    return GeneratedTitle(
                        title=candidate.title.strip(),
                        supporting_span=supporting_span,
                        attempts=attempt_number,
                    )
            if attempt_number < self._max_attempts:
                messages.extend(
                    [
                        {"role": "assistant", "content": raw_content},
                        {"role": "user", "content": _correction_prompt(last_errors)},
                    ]
                )
        errors = ", ".join(last_errors)
        raise ExternalServiceError(
            f"Ollama returned no grounded title after {self._max_attempts} attempts: {errors}"
        )


class OpenAICompatibleTitleGenerator:
    """Generate grounded titles through an OpenAI-compatible chat API.

    Covers DeepSeek, MiniMax, z.ai and most hosted providers, which all speak
    `POST /chat/completions` with the same request and response shape. The model
    and base URL are configuration, so switching provider is an env change
    rather than a code change.

    **The validation loop is deliberately identical to the local one.** The
    model is the cheap, swappable part; `title_validation_errors` is what makes
    a generated headline safe to publish over a real politician's face, and it
    must not vary by backend. A stronger model gets better at *sounding* right —
    the local benchmark caught a same-model critic approving a subject/object
    inversion — so the deterministic checks matter more with a better model, not
    less.

    Usage is accumulated across attempts so a benchmark can report real cost per
    accepted title rather than per request.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_s: float,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        temperature: float = 0.15,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        transport: AuthedJsonTransport | None = None,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        if not api_key:
            raise ExternalServiceError("Title API key is missing")
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._api_key = api_key
        self._model = model
        self._timeout_s = timeout_s
        self._max_attempts = max_attempts
        self._temperature = temperature
        self._max_tokens = max_tokens
        self._transport = transport or _post_json_authed
        self.usage = TokenUsage()

    def generate(
        self,
        *,
        clip: SelectedClip,
        speech: Speech,
        debate_title: str,
    ) -> GeneratedTitle:
        evidence_sentences = _title_sentences(clip.transcript)
        messages: list[dict[str, object]] = [
            {"role": "system", "content": TITLE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": _title_user_prompt(
                    clip=clip,
                    speech=speech,
                    debate_title=debate_title,
                    evidence_sentences=evidence_sentences,
                ),
            },
        ]
        last_errors: tuple[str, ...] = ("unknown_validation_error",)

        for attempt_number in range(1, self._max_attempts + 1):
            response = self._transport(
                self._url,
                self._api_key,
                {
                    "model": self._model,
                    "messages": messages,
                    "stream": False,
                    "temperature": self._temperature,
                    # Every provider in this family supports json_object. A
                    # provider-specific json_schema would be stricter but would
                    # stop this class being generic, and the Pydantic model
                    # rejects a bad shape anyway.
                    "response_format": {"type": "json_object"},
                    "max_tokens": self._max_tokens,
                },
                self._timeout_s,
            )
            self.usage.add(response.get("usage"))
            raw_content = _chat_completion_content(response)

            errors, generated = _evaluate_title_response(
                raw_content,
                evidence_sentences=evidence_sentences,
                clip=clip,
                speech=speech,
                attempt_number=attempt_number,
            )
            if generated is not None:
                return generated
            last_errors = errors

            if attempt_number < self._max_attempts:
                messages.extend(
                    [
                        {"role": "assistant", "content": raw_content},
                        {"role": "user", "content": _correction_prompt(last_errors)},
                    ]
                )

        raise ExternalServiceError(
            f"{self._model} returned no grounded title after "
            f"{self._max_attempts} attempts: {', '.join(last_errors)}"
        )


@dataclass
class TokenUsage:
    """Accumulated token usage, for real cost reporting."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    reasoning_tokens: int = 0
    requests: int = 0
    #: Titles are generated concurrently (one HTTP call per clip), so the
    #: accumulator is shared across threads.
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, usage: object) -> None:
        """Fold in one response's `usage` block, tolerating a missing one."""

        if not isinstance(usage, Mapping):
            return
        with self._lock:
            self._add_locked(usage)

    def _add_locked(self, usage: Mapping[str, Any]) -> None:
        self.requests += 1
        self.prompt_tokens += _as_int(usage.get("prompt_tokens"))
        self.completion_tokens += _as_int(usage.get("completion_tokens"))
        # DeepSeek reports cache hits here; they are billed at ~2% of the
        # miss price, and the 1,553-char system prompt is identical on every
        # call, so this number should climb steeply after the first few clips.
        completion_details = usage.get("completion_tokens_details")
        if isinstance(completion_details, Mapping):
            # Billed as output, and on a reasoning model they dominate it.
            self.reasoning_tokens += _as_int(completion_details.get("reasoning_tokens"))
        details = usage.get("prompt_tokens_details")
        if isinstance(details, Mapping):
            self.cached_tokens += _as_int(details.get("cached_tokens"))
        self.cached_tokens += _as_int(usage.get("prompt_cache_hit_tokens"))

    def to_dict(self) -> dict[str, int]:
        """Serialisable counters. Excludes the lock, which is not JSON."""

        return {
            "requests": self.requests,
            "prompt_tokens": self.prompt_tokens,
            "cached_tokens": self.cached_tokens,
            "completion_tokens": self.completion_tokens,
            "reasoning_tokens": self.reasoning_tokens,
        }

    def cost_usd(self, *, input_per_m: float, output_per_m: float, cached_per_m: float) -> float:
        """Cost in USD for the accumulated usage."""

        billed_input = max(0, self.prompt_tokens - self.cached_tokens)
        return (
            billed_input / 1_000_000 * input_per_m
            + self.cached_tokens / 1_000_000 * cached_per_m
            + self.completion_tokens / 1_000_000 * output_per_m
        )


def _evaluate_title_response(
    raw_content: str,
    *,
    evidence_sentences: list[str],
    clip: SelectedClip,
    speech: Speech,
    attempt_number: int,
) -> tuple[tuple[str, ...], GeneratedTitle | None]:
    """Validate one model response. Shared by every backend.

    Extracted so the hosted and local generators cannot drift apart on the one
    thing that must never differ between them.
    """

    try:
        candidate = _TitleResponse.model_validate_json(raw_content)
    except ValidationError as exc:
        return (_schema_error(exc),), None

    invalid_indices = sorted(
        {
            index
            for index in candidate.evidence_indices
            if index < 1 or index > len(evidence_sentences)
        }
    )
    ordered = sorted(set(candidate.evidence_indices))
    if invalid_indices or ordered != candidate.evidence_indices:
        return ("invalid_evidence_indices:choose_exactly_one_valid_index",), None

    supporting_span = " ".join(
        evidence_sentences[index - 1] for index in candidate.evidence_indices
    )
    errors = title_validation_errors(
        candidate.title,
        supporting_span,
        transcript=clip.transcript,
        speaker_name=speech.speaker_name,
        archetype=clip.archetype,
    )
    if errors:
        return errors, None
    return (), GeneratedTitle(
        title=candidate.title.strip(),
        supporting_span=supporting_span,
        attempts=attempt_number,
    )


def title_validation_errors(
    title: str,
    supporting_span: str,
    *,
    transcript: str,
    speaker_name: str,
    archetype: str,
) -> tuple[str, ...]:
    """Return deterministic reasons why a generated title is unsafe to publish."""

    errors: list[str] = []
    clean_title = title.strip()
    clean_span = _compact_whitespace(supporting_span.strip())
    compact_transcript = _compact_whitespace(transcript)
    if not MIN_TITLE_CHARS <= len(clean_title) <= MAX_TITLE_CHARS:
        errors.append(f"title_length:{len(clean_title)}")
    if clean_span not in compact_transcript:
        errors.append("supporting_span_not_exact")
    invalid_characters = sorted(
        {
            char
            for char in clean_title
            if not _allowed_title_character(char)
        }
    )
    if invalid_characters:
        errors.append(f"invalid_title_characters:{''.join(invalid_characters)}")
    letters = [char for char in clean_title if char.isalpha()]
    if letters and sum(char.isupper() for char in letters) / len(letters) > 0.70:
        errors.append("title_all_caps")
    if "." in clean_title:
        errors.append("title_contains_full_stop")
    title_numbers = set(NUMBER_RE.findall(clean_title))
    transcript_numbers = set(NUMBER_RE.findall(transcript))
    unsupported_numbers = sorted(title_numbers - transcript_numbers)
    if unsupported_numbers:
        errors.append(f"unsupported_numbers:{'|'.join(unsupported_numbers)}")

    title_tokens = _normalized_tokens(clean_title)
    evidence_tokens = set(_normalized_tokens(clean_span))
    speaker_tokens = set(_normalized_tokens(speaker_name))
    ungrounded = sorted(
        {
            token
            for token in title_tokens
            if len(token) >= 4
            and token not in STOP_WORDS
            and token not in ALLOWED_ATTRIBUTION_WORDS
            and token not in evidence_tokens
            and token not in speaker_tokens
        }
    )
    if ungrounded:
        errors.append(f"ungrounded_title_words:{'|'.join(ungrounded)}")

    semantic_title_tokens = [
        token
        for token in title_tokens
        if len(token) >= 2
        and token not in STOP_WORDS
        and token not in ALLOWED_ATTRIBUTION_WORDS
        and token not in speaker_tokens
    ]
    if semantic_title_tokens and not _is_subsequence(
        semantic_title_tokens,
        _normalized_tokens(clean_span),
    ):
        errors.append("title_words_out_of_evidence_order")

    title_token_set = set(title_tokens)
    if title_tokens and title_tokens[-1] in DANGLING_TITLE_ENDINGS:
        errors.append(f"dangling_title_ending:{title_tokens[-1]}")
    required_qualifiers = evidence_tokens & CLAIM_QUALIFIERS
    if title_numbers:
        required_qualifiers |= evidence_tokens & NUMBER_QUALIFIERS
    missing_qualifiers = sorted(required_qualifiers - title_token_set)
    if missing_qualifiers:
        errors.append(f"missing_qualifiers:{'|'.join(missing_qualifiers)}")
    if archetype.casefold() == "confront" and ":" not in clean_title:
        errors.append("confront_title_missing_attribution")
    return tuple(errors)


def _title_user_prompt(
    *,
    clip: SelectedClip,
    speech: Speech,
    debate_title: str,
    evidence_sentences: list[str],
) -> str:
    numbered_sentences = "\n".join(
        f"[{index}] {sentence}" for index, sentence in enumerate(evidence_sentences, start=1)
    )
    return (
        f"DEBATT: {debate_title}\n"
        f"TALARE: {speech.speaker_name}\n"
        f"PARTI: {speech.party or 'okänt'}\n"
        f"KLIPPTYP: {clip.archetype}\n"
        f"KLIPPMENINGAR:\n{numbered_sentences}"
    )


def _schema_error(exc: ValidationError) -> str:
    """Turn a Pydantic failure into something the model can act on.

    `invalid_json_schema:string_too_long` tells a model nothing. Length
    overshoot was a third of all rejections in the first DeepSeek benchmark and
    it survived all three attempts every time, because the correction prompt
    never said what the limit was or by how much it had been missed.
    """

    error = exc.errors()[0]
    if error.get("type") in {"string_too_long", "string_too_short"}:
        actual = len(str(error.get("input", "")))
        return f"title_length:{actual}_tecken_men_kravet_ar_{MIN_TITLE_CHARS}-{MAX_TITLE_CHARS}"
    return f"invalid_json_schema:{error['type']}"


def _correction_prompt(errors: tuple[str, ...]) -> str:
    details = "; ".join(errors)
    return (
        "Förslaget underkändes av den automatiska faktakontrollen: "
        f"{details}. Gör om svaret. "
        f"Rubriken MÅSTE vara mellan {MIN_TITLE_CHARS} och {MAX_TITLE_CHARS} tecken — "
        "räkna tecknen innan du svarar och korta ned genom att ta bort ord, "
        "inte genom att hugga av mitt i en fras. "
        "Välj exakt ett giltigt evidence_index. Använd innehållsord "
        "som står exakt i de valda meningarna, förutom talarens namn och neutrala "
        "attributord, och behåll innehållsorden i samma ordning som i meningen. Bevara alla "
        "viktiga förbehåll. Skriv en enda komplett fras utan punkt."
    )


def _message_content(response: Mapping[str, object]) -> str:
    message = response.get("message")
    if not isinstance(message, Mapping):
        raise ExternalServiceError("Ollama response is missing message")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ExternalServiceError("Ollama response is missing message content")
    return content


def _chat_completion_content(response: Mapping[str, object]) -> str:
    """Pull the assistant message out of an OpenAI-compatible response."""

    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ExternalServiceError(f"Title API response has no choices: {str(response)[:200]}")
    first = choices[0]
    if not isinstance(first, Mapping):
        raise ExternalServiceError("Title API choice is not an object")
    message = first.get("message")
    if not isinstance(message, Mapping):
        raise ExternalServiceError("Title API choice has no message")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ExternalServiceError("Title API returned empty content")
    return content


def _as_int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _post_json_authed(
    url: str,
    api_key: str,
    payload: Mapping[str, object],
    timeout_s: float,
) -> Mapping[str, object]:
    """POST JSON with a bearer token. The API key never appears in an error."""

    request = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:
            decoded: object = json.load(response)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise ExternalServiceError(f"Title API failed with HTTP {exc.code}: {detail}") from exc
    except OSError as exc:
        raise ExternalServiceError(f"Title API request failed: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ExternalServiceError("Title API response is not valid JSON") from exc
    if not isinstance(decoded, Mapping):
        raise ExternalServiceError("Title API response is not a JSON object")
    return decoded


def _post_json(
    url: str,
    payload: Mapping[str, object],
    timeout_s: float,
) -> Mapping[str, object]:
    request = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:
            decoded: object = json.load(response)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise ExternalServiceError(
            f"Ollama request failed with HTTP {exc.code}: {detail}"
        ) from exc
    except OSError as exc:
        raise ExternalServiceError(f"Ollama request failed: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ExternalServiceError("Ollama response is not valid JSON") from exc
    if not isinstance(decoded, Mapping):
        raise ExternalServiceError("Ollama response is not a JSON object")
    return decoded


def _compact_whitespace(value: str) -> str:
    return " ".join(value.split())


def _title_sentences(transcript: str) -> list[str]:
    compact = _compact_whitespace(transcript)
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", compact)
        if sentence.strip()
    ]
    return sentences or [compact]


def _allowed_title_character(char: str) -> bool:
    if char.isalpha():
        return unicodedata.name(char, "").startswith("LATIN")
    return char.isdigit() or char.isspace() or char in ALLOWED_PUNCTUATION


def _normalized_tokens(value: str) -> list[str]:
    return [_normalize_word(match.group(0)) for match in TOKEN_RE.finditer(value)]


def _normalize_word(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    return "".join(char for char in decomposed if not unicodedata.combining(char))


def _is_subsequence(needles: list[str], haystack: list[str]) -> bool:
    needle_index = 0
    for token in haystack:
        if token == needles[needle_index]:
            needle_index += 1
            if needle_index == len(needles):
                return True
    return False
