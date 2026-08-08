"""HTTP client for Riksdagen open-data and webb-tv metadata."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from src.errors import ExternalServiceError
from src.riksdagen.parser import (
    AnforandeEntry,
    extract_next_data_json,
    merge_anforande_detail,
    parse_anforande_xml_response,
    parse_anforandelista_response,
    video_page_url_from_document,
)

DEFAULT_BASE_URL = "https://data.riksdagen.se"
DEFAULT_WEB_BASE_URL = "https://www.riksdagen.se"
DEFAULT_MIN_INTERVAL_S = 0.25
DEFAULT_BACKOFF_BASE_S = 0.5


@dataclass(frozen=True)
class HttpRequest:
    """Request object passed to injectable transports."""

    url: str
    headers: Mapping[str, str]
    timeout_s: float


@dataclass(frozen=True)
class HttpResponse:
    """Minimal HTTP response used by the client and tests."""

    status_code: int
    body: bytes
    headers: Mapping[str, str]

    @property
    def text(self) -> str:
        return self.body.decode("utf-8-sig")


class Transport(Protocol):
    """Callable transport protocol for replacing network IO in tests."""

    def __call__(self, request: HttpRequest) -> HttpResponse:
        """Perform one HTTP request."""


class RiksdagenHTTPError(ExternalServiceError):
    """HTTP response was non-successful after retry handling."""

    def __init__(self, status_code: int, url: str, body: bytes) -> None:
        super().__init__(f"Riksdagen request failed with HTTP {status_code}: {url}")
        self.status_code = status_code
        self.url = url
        self.body = body


def urllib_transport(request: HttpRequest) -> HttpResponse:
    """Default transport backed by urllib from the standard library."""

    urllib_request = Request(request.url, headers=dict(request.headers), method="GET")
    try:
        with urlopen(urllib_request, timeout=request.timeout_s) as response:
            status = response.status
            headers = dict(response.headers.items())
            body = response.read()
    except HTTPError as exc:
        return HttpResponse(
            status_code=exc.code,
            body=exc.read(),
            headers=dict(exc.headers.items()),
        )
    except URLError as exc:
        raise ExternalServiceError(f"Riksdagen request failed: {request.url}") from exc

    return HttpResponse(status_code=status, body=body, headers=headers)


class RiksdagenClient:
    """Polite Riksdagen HTTP client with retry, backoff and rate limiting."""

    def __init__(
        self,
        *,
        user_agent: str,
        timeout_s: float,
        max_retries: int,
        min_interval_s: float = DEFAULT_MIN_INTERVAL_S,
        backoff_base_s: float = DEFAULT_BACKOFF_BASE_S,
        transport: Transport = urllib_transport,
        sleep_fn: Callable[[float], None] = time.sleep,
        monotonic_fn: Callable[[], float] = time.monotonic,
        base_url: str = DEFAULT_BASE_URL,
        web_base_url: str = DEFAULT_WEB_BASE_URL,
    ) -> None:
        self._user_agent = user_agent
        self._timeout_s = timeout_s
        self._max_retries = max_retries
        self._min_interval_s = min_interval_s
        self._backoff_base_s = backoff_base_s
        self._transport = transport
        self._sleep_fn = sleep_fn
        self._monotonic_fn = monotonic_fn
        self._base_url = base_url.rstrip("/")
        self._web_base_url = web_base_url.rstrip("/")
        self._last_request_at: float | None = None

    def get(self, url: str, *, accept: str = "application/json") -> HttpResponse:
        """GET a URL with retry and rate limiting."""

        last_transport_error: ExternalServiceError | None = None
        for attempt in range(self._max_retries + 1):
            self._respect_rate_limit()
            try:
                response = self._transport(
                    HttpRequest(
                        url=url,
                        headers={"User-Agent": self._user_agent, "Accept": accept},
                        timeout_s=self._timeout_s,
                    )
                )
            except ExternalServiceError as exc:
                last_transport_error = exc
                if attempt >= self._max_retries:
                    raise
                self._sleep_fn(self._backoff_delay(attempt))
                continue

            self._last_request_at = self._monotonic_fn()
            if self._should_retry_status(response.status_code) and attempt < self._max_retries:
                self._sleep_fn(self._backoff_delay(attempt))
                continue
            if response.status_code >= 400:
                raise RiksdagenHTTPError(response.status_code, url, response.body)
            return response

        if last_transport_error is not None:
            raise last_transport_error
        raise ExternalServiceError(f"Riksdagen request failed without a response: {url}")

    def get_json(self, url: str) -> Mapping[str, object]:
        """GET and decode a JSON object."""

        response = self.get(url)
        try:
            payload = json.loads(response.text)
        except json.JSONDecodeError as exc:
            raise ExternalServiceError(f"Riksdagen returned invalid JSON: {url}") from exc
        if not isinstance(payload, dict):
            raise ExternalServiceError(f"Riksdagen returned non-object JSON: {url}")
        return payload

    def fetch_legacy_mhs_vodapi(self, dokid: str) -> Mapping[str, object]:
        """Fetch the legacy KBLab-documented media API for one dokid."""

        return self.get_json(f"{self._base_url}/api/mhs-vodapi?{dokid}")

    def fetch_document_status(self, dokid: str) -> Mapping[str, object]:
        """Fetch open-data document status metadata for one dokid."""

        return self.get_json(f"{self._base_url}/dokumentstatus/{dokid}.json")

    def fetch_document_list(self, params: Mapping[str, str]) -> Mapping[str, object]:
        """Fetch the open-data document list endpoint."""

        query = urlencode(params)
        return self.get_json(f"{self._base_url}/dokumentlista/?{query}")

    def fetch_personlista(self, first_name: str) -> list[Mapping[str, object]]:
        """Fetch register entries sharing a given name.

        `rdlstatus=samtliga` is load-bearing: the default query returns sitting
        members only, which is precisely the set that already has an
        `intressent_id` in `anforandelista`. Without it a minister drawn from
        outside the chamber is invisible here too.
        """

        query = urlencode({"fnamn": first_name, "rdlstatus": "samtliga", "utformat": "json"})
        payload = self.get_json(f"{self._base_url}/personlista/?{query}")
        listing = payload.get("personlista")
        if not isinstance(listing, Mapping):
            return []
        people = listing.get("person")
        if isinstance(people, Mapping):
            return [people]
        if isinstance(people, list):
            return [person for person in people if isinstance(person, Mapping)]
        return []

    def fetch_anforandelista(
        self, *, rm: str, debate_date: date, page_size: int = 10_000
    ) -> Mapping[str, object]:
        """Fetch open-data anförandelista rows from the day before a debate onward."""

        query = urlencode(
            {
                "rm": rm,
                "d": (debate_date - timedelta(days=1)).isoformat(),
                "sz": str(page_size),
                "utformat": "json",
            }
        )
        return self.get_json(f"{self._base_url}/anforandelista/?{query}")

    def fetch_official_anforanden(
        self, *, dokid: str, debate_date: date
    ) -> tuple[AnforandeEntry, ...]:
        """Fetch official speech metadata and full text for a webb-tv debate."""

        document = _document_from_status(self.fetch_document_status(dokid))
        rm = _required_document_str(document, "rm")
        payload = self.fetch_anforandelista(rm=rm, debate_date=debate_date)
        summaries = parse_anforandelista_response(payload, rel_dokid=dokid)
        entries: list[AnforandeEntry] = []
        for summary in summaries:
            if summary.source_url is None:
                entries.append(summary)
                continue
            detail = parse_anforande_xml_response(
                self.get(summary.source_url, accept="text/xml").text
            )
            entries.append(merge_anforande_detail(summary, detail))
        return tuple(entries)

    def fetch_video_page_data(self, dokid: str) -> Mapping[str, object]:
        """Fetch current webb-tv page data for one dokid."""

        document_status = self.fetch_document_status(dokid)
        document = _document_from_status(document_status)
        page_url = video_page_url_from_document(document, web_base_url=self._web_base_url)
        response = self.get(page_url)
        return extract_next_data_json(response.text)

    def fetch_video_metadata_payload(self, dokid: str) -> Mapping[str, object]:
        """Fetch video metadata, trying legacy mhs-vodapi before the current page JSON."""

        try:
            return self.fetch_legacy_mhs_vodapi(dokid)
        except RiksdagenHTTPError as exc:
            if exc.status_code != 404:
                raise
        return self.fetch_video_page_data(dokid)

    def _respect_rate_limit(self) -> None:
        if self._last_request_at is None:
            return
        elapsed_s = self._monotonic_fn() - self._last_request_at
        delay_s = self._min_interval_s - elapsed_s
        if delay_s > 0:
            self._sleep_fn(delay_s)

    def _backoff_delay(self, attempt: int) -> float:
        return self._backoff_base_s * float(2**attempt)

    @staticmethod
    def _should_retry_status(status_code: int) -> bool:
        return status_code == 429 or 500 <= status_code < 600


def _document_from_status(payload: Mapping[str, object]) -> Mapping[str, object]:
    status = payload.get("dokumentstatus")
    if not isinstance(status, dict):
        raise ExternalServiceError("Document status response is missing dokumentstatus")
    document = status.get("dokument")
    if not isinstance(document, dict):
        raise ExternalServiceError("Document status response is missing dokumentstatus.dokument")
    return document


def _required_document_str(document: Mapping[str, object], key: str) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ExternalServiceError(f"Document status response is missing dokument.{key}")
    return value.strip()
