"""Tests for safe, complete Riksdagen party-logo mirroring."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from pathlib import Path

import pytest

from scripts.sync_party_logos import party_logo_update_sql, require_complete_update
from src.errors import ExternalServiceError
from src.publish.bunny import BunnyUploadedObject
from src.riksdagen.client import HttpResponse
from src.riksdagen.party_logos import (
    MAX_PARTY_LOGO_BYTES,
    PARTY_LOGO_SOURCES,
    PartyLogoImage,
    PartyLogoSource,
    download_party_logo,
    party_logo_remote_path,
    upload_party_logo,
)

SOURCE = PartyLogoSource(
    "S",
    "https://bilder.riksdagen.se/publishedmedia/source/socialdemokraterna.png",
)


def png(width: int = 128, height: int = 128) -> bytes:
    """Return the smallest envelope accepted by the dependency-free validator."""

    return b"".join(
        (
            b"\x89PNG\r\n\x1a\n",
            b"\x00\x00\x00\rIHDR",
            width.to_bytes(4, "big"),
            height.to_bytes(4, "big"),
            b"\x08\x06\x00\x00\x00",
            b"\x00\x00\x00\x00",
            b"\x00\x00\x00\x00IEND\xaeB`\x82",
        )
    )


class FakeHttpClient:
    def __init__(self, response: HttpResponse) -> None:
        self.response = response
        self.requests: list[tuple[str, str]] = []

    def get(self, url: str, *, accept: str = "application/json") -> HttpResponse:
        self.requests.append((url, accept))
        return self.response


class FakeStorage:
    def __init__(self) -> None:
        self.uploads: list[tuple[bytes, str, str]] = []

    def upload_file(
        self,
        local_path: Path,
        remote_path: str,
        *,
        content_type: str,
    ) -> BunnyUploadedObject:
        body = local_path.read_bytes()
        self.uploads.append((body, remote_path, content_type))
        return BunnyUploadedObject(
            remote_path=remote_path,
            public_url=f"https://cdn.example/{remote_path}",
            bytes=len(body),
        )


def response(body: bytes, headers: Mapping[str, str] | None = None) -> HttpResponse:
    return HttpResponse(
        status_code=200,
        body=body,
        headers=headers or {"Content-Type": "image/png"},
    )


def test_all_eight_canonical_sources_are_unique_riksdagen_pngs() -> None:
    assert [source.code for source in PARTY_LOGO_SOURCES] == [
        "S",
        "M",
        "SD",
        "C",
        "V",
        "KD",
        "MP",
        "L",
    ]
    assert len({source.url for source in PARTY_LOGO_SOURCES}) == 8
    assert all(
        source.url.startswith("https://bilder.riksdagen.se/")
        and source.url.endswith(".png")
        for source in PARTY_LOGO_SOURCES
    )


def test_download_and_upload_preserve_exact_bytes_at_content_addressed_path() -> None:
    body = png()
    http = FakeHttpClient(response(body, {"content-type": "image/png; charset=binary"}))
    storage = FakeStorage()

    image = download_party_logo(http, SOURCE)
    mirrored = upload_party_logo(storage, image)

    expected_hash = hashlib.sha256(body).hexdigest()
    expected_path = f"party-logos/s/{expected_hash}.png"
    assert image.body == body
    assert (image.width, image.height) == (128, 128)
    assert mirrored.cdn_url == f"https://cdn.example/{expected_path}"
    assert mirrored.sha256 == expected_hash
    assert storage.uploads == [(body, expected_path, "image/png")]
    assert http.requests == [(SOURCE.url, "image/png")]


@pytest.mark.parametrize(
    "source_url",
    [
        "http://bilder.riksdagen.se/logo.png",
        "https://example.com/logo.png",
        "https://bilder.riksdagen.se.evil.example/logo.png",
        "https://user@bilder.riksdagen.se/logo.png",
        "https://bilder.riksdagen.se:not-a-port/logo.png",
    ],
)
def test_download_refuses_non_riksdagen_or_non_https_sources(source_url: str) -> None:
    http = FakeHttpClient(response(png()))

    with pytest.raises(ExternalServiceError, match="bilder.riksdagen.se"):
        download_party_logo(http, PartyLogoSource("S", source_url))

    assert http.requests == []


@pytest.mark.parametrize(
    ("body", "headers", "message"),
    [
        (b"not a png", {"Content-Type": "image/png"}, "valid PNG"),
        (png(), {"Content-Type": "text/html"}, "content type"),
        (b"", {"Content-Type": "image/png"}, "empty"),
        (png(128, 96), {"Content-Type": "image/png"}, "unsafe dimensions"),
    ],
)
def test_download_refuses_invalid_image_responses(
    body: bytes,
    headers: Mapping[str, str],
    message: str,
) -> None:
    with pytest.raises(ExternalServiceError, match=message):
        download_party_logo(FakeHttpClient(response(body, headers)), SOURCE)


def test_download_refuses_oversized_body() -> None:
    body = png()[:-12] + b"x" * MAX_PARTY_LOGO_BYTES + png()[-12:]

    with pytest.raises(ExternalServiceError, match="exceeded"):
        download_party_logo(FakeHttpClient(response(body)), SOURCE)


def test_path_refuses_unknown_codes_and_hashes() -> None:
    digest = hashlib.sha256(png()).hexdigest()
    assert party_logo_remote_path("KD", digest) == f"party-logos/kd/{digest}.png"

    with pytest.raises(ExternalServiceError, match="Unknown"):
        party_logo_remote_path("NONE", digest)
    with pytest.raises(ExternalServiceError, match="SHA-256"):
        party_logo_remote_path("S", "not-a-hash")


def test_database_update_is_one_bounded_verified_batch() -> None:
    body = png()
    digest = hashlib.sha256(body).hexdigest()
    logo = upload_party_logo(
        FakeStorage(),
        PartyLogoImage(
            code="S",
            source_url=SOURCE.url,
            body=body,
            sha256=digest,
            width=128,
            height=128,
        ),
    )

    sql = party_logo_update_sql([logo]).lower()

    assert "jsonb_to_recordset" in sql
    assert "update public.party_profiles" in sql
    assert "logo_mirrored_at = pg_catalog.now()" in sql
    assert "where party.code = incoming.code" in sql
    assert "returning party.code" in sql
    assert "updated_count" in sql
    assert SOURCE.url.lower() in sql
    assert logo.cdn_url.lower() in sql


def test_database_update_requires_every_expected_row() -> None:
    require_complete_update({"result": [{"updated_count": 8}]}, expected=8)

    with pytest.raises(ExternalServiceError, match="updated 7"):
        require_complete_update({"result": [{"updated_count": 7}]}, expected=8)
    with pytest.raises(ExternalServiceError, match="no count"):
        require_complete_update({}, expected=8)
