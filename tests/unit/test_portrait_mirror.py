"""Tests for safe Riksdagen portrait mirroring."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from pathlib import Path

import pytest

from src.errors import ExternalServiceError
from src.publish.bunny import BunnyUploadedObject
from src.riksdagen.client import HttpResponse
from src.riksdagen.portraits import (
    MAX_PORTRAIT_BYTES,
    PortraitImage,
    download_portrait,
    portrait_remote_path,
    upload_portrait,
)

SOURCE_URL = "https://data.riksdagen.se/filarkiv/bilder/ledamot/person-1_192.jpg"
JPEG = b"\xff\xd8\xff\xe0portrait-bytes\xff\xd9"


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
        headers=headers or {"Content-Type": "image/jpeg"},
    )


def test_download_and_upload_preserve_exact_bytes_at_content_addressed_path() -> None:
    http = FakeHttpClient(response(JPEG, {"content-type": "image/jpeg; charset=binary"}))
    storage = FakeStorage()

    image = download_portrait(http, SOURCE_URL)
    mirrored = upload_portrait(storage, intressent_id="person-1", image=image)

    expected_hash = hashlib.sha256(JPEG).hexdigest()
    expected_path = f"portraits/person-1/{expected_hash}.jpg"
    assert image.body == JPEG
    assert image.sha256 == expected_hash
    assert mirrored.cdn_url == f"https://cdn.example/{expected_path}"
    assert mirrored.sha256 == expected_hash
    assert storage.uploads == [(JPEG, expected_path, "image/jpeg")]
    assert http.requests == [(SOURCE_URL, "image/jpeg")]


@pytest.mark.parametrize(
    "source_url",
    [
        "http://data.riksdagen.se/portrait.jpg",
        "https://example.com/portrait.jpg",
        "https://data.riksdagen.se.evil.example/portrait.jpg",
        "https://user@data.riksdagen.se/portrait.jpg",
        "https://data.riksdagen.se:not-a-port/portrait.jpg",
    ],
)
def test_download_refuses_non_riksdagen_or_non_https_sources(source_url: str) -> None:
    http = FakeHttpClient(response(JPEG))

    with pytest.raises(ExternalServiceError, match="data.riksdagen.se"):
        download_portrait(http, source_url)

    assert http.requests == []


def test_download_refuses_oversized_body() -> None:
    http = FakeHttpClient(response(b"\xff\xd8\xff" + b"x" * MAX_PORTRAIT_BYTES + b"\xff\xd9"))

    with pytest.raises(ExternalServiceError, match="exceeded"):
        download_portrait(http, SOURCE_URL)


@pytest.mark.parametrize(
    ("body", "headers", "message"),
    [
        (b"not a jpeg", {"Content-Type": "image/jpeg"}, "valid JPEG"),
        (JPEG, {"Content-Type": "text/html"}, "content type"),
        (b"", {"Content-Type": "image/jpeg"}, "empty"),
    ],
)
def test_download_refuses_invalid_image_responses(
    body: bytes,
    headers: Mapping[str, str],
    message: str,
) -> None:
    with pytest.raises(ExternalServiceError, match=message):
        download_portrait(FakeHttpClient(response(body, headers)), SOURCE_URL)


def test_portrait_path_refuses_unsafe_ids_and_hashes() -> None:
    digest = hashlib.sha256(JPEG).hexdigest()
    assert portrait_remote_path("abc-123_DEF", digest).endswith(f"/{digest}.jpg")

    with pytest.raises(ExternalServiceError, match="unsafe"):
        portrait_remote_path("../person", digest)
    with pytest.raises(ExternalServiceError, match="SHA-256"):
        portrait_remote_path("person", "not-a-hash")


def test_upload_uses_only_a_prevalidated_portrait() -> None:
    storage = FakeStorage()
    image = PortraitImage(source_url=SOURCE_URL, body=JPEG, sha256=hashlib.sha256(JPEG).hexdigest())

    upload_portrait(storage, intressent_id="person-1", image=image)

    assert storage.uploads[0][0] == JPEG
