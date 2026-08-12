"""Tests for Bunny publish helpers."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import pytest

from src.errors import ExternalServiceError
from src.publish.bunny import (
    BunnyAccountClient,
    BunnyStorageClient,
    HttpResponse,
)


@dataclass(frozen=True)
class RecordedRequest:
    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes | None


class FakeTransport:
    def __init__(self, responses: list[HttpResponse]) -> None:
        self.responses = responses
        self.requests: list[RecordedRequest] = []

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout_s: float,
    ) -> HttpResponse:
        del timeout_s
        self.requests.append(RecordedRequest(method, url, headers, body))
        return self.responses.pop(0)


def test_upload_file_puts_then_verifies_with_head(tmp_path: Path) -> None:
    local_file = tmp_path / "clip.mp4"
    local_file.write_bytes(b"video")
    transport = FakeTransport(
        [
            HttpResponse(404, {}, b""),
            HttpResponse(201, {}, b""),
            HttpResponse(200, {"Content-Length": "5"}, b""),
        ]
    )
    client = BunnyStorageClient(
        storage_zone_name="zone",
        access_key="storage-password",
        cdn_base_url="https://cdn.example",
        storage_hostname="storage.example",
        transport=transport,
        max_retries=0,
    )

    uploaded = client.upload_file(local_file, "/clips/2026/08/clip.mp4", content_type="video/mp4")

    assert uploaded.public_url == "https://cdn.example/clips/2026/08/clip.mp4"
    assert uploaded.bytes == 5
    assert [request.method for request in transport.requests] == ["GET", "PUT", "HEAD"]
    assert transport.requests[0].headers["Range"] == "bytes=0-0"
    assert transport.requests[1].headers["AccessKey"] == "storage-password"
    assert transport.requests[1].headers["Cache-Control"].endswith("immutable")
    assert transport.requests[1].body == b"video"


def test_upload_file_reuses_existing_object_only_after_public_verification(
    tmp_path: Path,
) -> None:
    local_file = tmp_path / "clip.mp4"
    local_file.write_bytes(b"video")
    transport = FakeTransport(
        [
            HttpResponse(206, {"Content-Range": "bytes 0-0/5"}, b"v"),
            HttpResponse(200, {"Content-Length": "5"}, b""),
        ]
    )
    client = BunnyStorageClient(
        storage_zone_name="zone",
        access_key="storage-password",
        cdn_base_url="https://cdn.example",
        storage_hostname="storage.example",
        transport=transport,
        max_retries=0,
    )

    uploaded = client.upload_file(local_file, "clips/clip.mp4", content_type="video/mp4")

    assert uploaded.public_url == "https://cdn.example/clips/clip.mp4"
    assert [request.method for request in transport.requests] == ["GET", "HEAD"]


def test_upload_file_rejects_existing_object_missing_from_public_cdn(tmp_path: Path) -> None:
    local_file = tmp_path / "portrait.jpg"
    local_file.write_bytes(b"image")
    transport = FakeTransport(
        [
            HttpResponse(206, {"Content-Range": "bytes 0-0/5"}, b"i"),
            HttpResponse(404, {}, b""),
        ]
    )
    client = BunnyStorageClient(
        storage_zone_name="zone",
        access_key="storage-password",
        cdn_base_url="https://cdn.example",
        storage_hostname="storage.example",
        transport=transport,
        max_retries=0,
    )

    with pytest.raises(ExternalServiceError, match="not available from the public CDN"):
        client.upload_file(local_file, "portraits/person/hash.jpg", content_type="image/jpeg")


def test_upload_file_refuses_to_overwrite_different_size(tmp_path: Path) -> None:
    local_file = tmp_path / "clip.mp4"
    local_file.write_bytes(b"video")
    transport = FakeTransport([HttpResponse(206, {"Content-Range": "bytes 0-0/4"}, b"v")])
    client = BunnyStorageClient(
        storage_zone_name="zone",
        access_key="storage-password",
        cdn_base_url="https://cdn.example",
        storage_hostname="storage.example",
        transport=transport,
        max_retries=0,
    )

    with pytest.raises(ExternalServiceError, match="Refusing to overwrite"):
        client.upload_file(local_file, "clips/clip.mp4", content_type="video/mp4")


def test_account_client_uses_storage_zone_password_not_global_api_key() -> None:
    transport = FakeTransport(
        [
            HttpResponse(
                200,
                {},
                b'[{"Id":42,"Name":"riketclips","Password":"zone-password","Region":"DE"}]',
            ),
            HttpResponse(
                200,
                {},
                b'[{"Name":"riketclips","Hostnames":[{"Value":"riketclips.b-cdn.net"}]}]',
            ),
        ]
    )
    account = BunnyAccountClient(api_key="global-api-key", transport=transport, max_retries=0)

    target = account.provision_storage_target(
        storage_zone_name="riketclips",
        pull_zone_name="riketclips",
        region="DE",
    )

    assert target.storage_zone_name == "riketclips"
    assert target.storage_access_key == "zone-password"
    assert target.storage_hostname == "storage.bunnycdn.com"
    assert target.cdn_base_url == "https://riketclips.b-cdn.net"
    assert transport.requests[0].headers["AccessKey"] == "global-api-key"
