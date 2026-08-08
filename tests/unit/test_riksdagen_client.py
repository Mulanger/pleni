"""Tests for the polite Riksdagen HTTP client."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import date

import pytest

from src.errors import ExternalServiceError
from src.riksdagen.client import HttpRequest, HttpResponse, RiksdagenClient, RiksdagenHTTPError


def client_with(
    transport: Callable[[HttpRequest], HttpResponse],
    sleep_calls: list[float],
    clock_values: list[float] | None = None,
) -> RiksdagenClient:
    if clock_values is None:
        clock_values = [0.0, 1.0, 2.0, 3.0]

    def sleep_fn(delay_s: float) -> None:
        sleep_calls.append(delay_s)

    def monotonic_fn() -> float:
        if clock_values:
            return clock_values.pop(0)
        return 999.0

    return RiksdagenClient(
        user_agent="test-agent",
        timeout_s=5.0,
        max_retries=2,
        min_interval_s=0.25,
        backoff_base_s=0.5,
        transport=transport,
        sleep_fn=sleep_fn,
        monotonic_fn=monotonic_fn,
    )


def test_retries_retryable_status_with_backoff() -> None:
    calls: list[HttpRequest] = []
    sleeps: list[float] = []

    def transport(request: HttpRequest) -> HttpResponse:
        calls.append(request)
        if len(calls) == 1:
            return HttpResponse(status_code=500, body=b"server error", headers={})
        return HttpResponse(status_code=200, body=b'{"ok": true}', headers={})

    client = client_with(transport, sleeps)

    payload = client.get_json("https://example.test/resource")

    assert payload == {"ok": True}
    assert len(calls) == 2
    assert calls[0].headers["User-Agent"] == "test-agent"
    assert sleeps == [0.5]


def test_does_not_retry_404() -> None:
    sleeps: list[float] = []

    def transport(request: HttpRequest) -> HttpResponse:
        return HttpResponse(status_code=404, body=b"missing", headers={})

    client = client_with(transport, sleeps)

    with pytest.raises(RiksdagenHTTPError) as exc_info:
        client.get("https://example.test/missing")

    assert exc_info.value.status_code == 404
    assert sleeps == []


def test_retries_transport_errors() -> None:
    calls = 0
    sleeps: list[float] = []

    def transport(request: HttpRequest) -> HttpResponse:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ExternalServiceError("temporary")
        return HttpResponse(status_code=200, body=b'{"ok": true}', headers={})

    client = client_with(transport, sleeps)

    assert client.get_json("https://example.test/resource") == {"ok": True}
    assert sleeps == [0.5]


def test_rate_limit_between_successful_requests() -> None:
    sleeps: list[float] = []
    calls = 0

    def transport(request: HttpRequest) -> HttpResponse:
        nonlocal calls
        calls += 1
        return HttpResponse(status_code=200, body=b'{"ok": true}', headers={})

    client = client_with(transport, sleeps, clock_values=[0.0, 0.1, 0.1, 1.0])

    client.get_json("https://example.test/one")
    client.get_json("https://example.test/two")

    assert calls == 2
    assert sleeps == [0.15]


def test_fetch_official_anforanden_filters_and_fetches_xml_details() -> None:
    calls: list[HttpRequest] = []

    def transport(request: HttpRequest) -> HttpResponse:
        calls.append(request)
        if request.url.endswith("/dokumentstatus/DOC1.json"):
            return _json_response(
                {
                    "dokumentstatus": {
                        "dokument": {
                            "dok_id": "DOC1",
                            "rm": "2025/26",
                        }
                    }
                }
            )
        if "/anforandelista/?" in request.url:
            return _json_response(
                {
                    "anforandelista": {
                        "anforande": [
                            {
                                "anforande_id": "summary-1",
                                "anforande_nummer": "7",
                                "talare": "Ledamot Test (S)",
                                "parti": "S",
                                "intressent_id": "person-1",
                                "rel_dok_id": "DOC1",
                                "replik": "Y",
                                "anforandetext": "",
                                "anforande_url_xml": "https://data.test/anforande/PROTO-7",
                            },
                            {
                                "anforande_id": "other",
                                "anforande_nummer": "8",
                                "talare": "Annan Test (M)",
                                "parti": "M",
                                "rel_dok_id": "OTHER",
                                "replik": "N",
                            },
                        ]
                    }
                }
            )
        if request.url == "https://data.test/anforande/PROTO-7":
            body = """
            <anforande>
              <anforande_id>detail-1</anforande_id>
              <anforande_nummer>7</anforande_nummer>
              <talare>Ledamot Test (S)</talare>
              <parti>S</parti>
              <anforandetext>&lt;p&gt;Officiell text.&lt;/p&gt;</anforandetext>
              <intressent_id>person-1</intressent_id>
              <rel_dok_id>DOC1</rel_dok_id>
              <replik>Y</replik>
            </anforande>
            """
            return HttpResponse(status_code=200, body=body.encode("utf-8"), headers={})
        return HttpResponse(status_code=404, body=b"missing", headers={})

    client = RiksdagenClient(
        user_agent="test-agent",
        timeout_s=5.0,
        max_retries=0,
        min_interval_s=0.0,
        transport=transport,
    )

    entries = client.fetch_official_anforanden(dokid="DOC1", debate_date=date(2026, 3, 5))

    assert len(entries) == 1
    assert entries[0].anforande_id == "detail-1"
    assert entries[0].anforandetyp == "Replik"
    assert entries[0].official_text == "Officiell text."
    assert calls[-1].headers["Accept"] == "text/xml"


def test_fetch_person_by_id_keeps_the_complete_person_record() -> None:
    calls: list[HttpRequest] = []

    def transport(request: HttpRequest) -> HttpResponse:
        calls.append(request)
        return _json_response(
            {
                "personlista": {
                    "person": {
                        "intressent_id": "person-1",
                        "tilltalsnamn": "Anna",
                        "efternamn": "Test",
                        "personuppdrag": {"uppdrag": [{"roll_kod": "Ledamot"}]},
                    }
                }
            }
        )

    client = client_with(transport, [])

    person = client.fetch_person_by_id("person-1")

    assert person is not None
    assert person["personuppdrag"] == {"uppdrag": [{"roll_kod": "Ledamot"}]}
    assert "iid=person-1" in calls[0].url
    assert "rdlstatus=samtliga" in calls[0].url


def test_fetch_person_by_id_does_not_accept_a_different_person() -> None:
    def transport(request: HttpRequest) -> HttpResponse:
        return _json_response(
            {
                "personlista": {
                    "person": [
                        {"intressent_id": "other"},
                        {"intressent_id": "also-other"},
                    ]
                }
            }
        )

    client = client_with(transport, [])

    assert client.fetch_person_by_id("person-1") is None


def _json_response(payload: object) -> HttpResponse:
    return HttpResponse(
        status_code=200,
        body=json.dumps(payload).encode("utf-8"),
        headers={},
    )
