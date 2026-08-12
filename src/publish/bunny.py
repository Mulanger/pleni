"""Bunny Storage and account API helpers for publishing rendered clips."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast

from src.errors import ExternalServiceError

BUNNY_API_BASE = "https://api.bunny.net"
CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable"


@dataclass(frozen=True)
class HttpResponse:
    """Small HTTP response shape used by mocked and real transports."""

    status: int
    headers: Mapping[str, str]
    body: bytes


class HttpTransport(Protocol):
    """HTTP boundary for tests to fake without mocking publish logic."""

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout_s: float,
    ) -> HttpResponse:
        """Issue an HTTP request."""


class UrllibTransport:
    """Stdlib HTTP transport."""

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout_s: float,
    ) -> HttpResponse:
        request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                return HttpResponse(
                    status=response.status,
                    headers={key: value for key, value in response.headers.items()},
                    body=response.read(),
                )
        except urllib.error.HTTPError as exc:
            return HttpResponse(
                status=exc.code,
                headers={key: value for key, value in exc.headers.items()},
                body=exc.read(),
            )
        except urllib.error.URLError as exc:
            raise ExternalServiceError(f"HTTP request failed for {url}: {exc}") from exc


@dataclass(frozen=True)
class BunnyUploadedObject:
    """Verified Bunny object URL and size."""

    remote_path: str
    public_url: str
    bytes: int


@dataclass(frozen=True)
class BunnyStorageTarget:
    """Bunny Storage details needed for verified uploads."""

    storage_zone_name: str
    storage_access_key: str
    storage_hostname: str
    cdn_base_url: str


class BunnyStorageClient:
    """Upload files to one Bunny Storage Zone and verify them before use."""

    def __init__(
        self,
        *,
        storage_zone_name: str,
        access_key: str,
        cdn_base_url: str,
        storage_hostname: str = "storage.bunnycdn.com",
        transport: HttpTransport | None = None,
        timeout_s: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self.storage_zone_name = storage_zone_name
        self.access_key = access_key
        self.cdn_base_url = cdn_base_url.rstrip("/")
        self.storage_hostname = storage_hostname
        self.transport = transport or UrllibTransport()
        self.timeout_s = timeout_s
        self.max_retries = max_retries

    def upload_file(
        self,
        local_path: Path,
        remote_path: str,
        *,
        content_type: str,
    ) -> BunnyUploadedObject:
        """Upload an immutable object and verify byte length with HEAD.

        Existing objects are accepted only when their byte length matches the
        local file. A mismatched object is treated as a failed publish rather
        than overwritten.
        """

        normalized_path = normalize_remote_path(remote_path)
        expected_size = local_path.stat().st_size
        existing_size = self.storage_file_size(normalized_path)
        if existing_size is not None:
            if existing_size == expected_size:
                verified_size = self.verified_public_file_size(normalized_path)
                if verified_size != expected_size:
                    raise ExternalServiceError(
                        "Existing Bunny object was not available from the public CDN: "
                        f"{normalized_path}: expected {expected_size} bytes, got {verified_size}"
                    )
                return BunnyUploadedObject(
                    remote_path=normalized_path,
                    public_url=self.public_url(normalized_path),
                    bytes=expected_size,
                )
            raise ExternalServiceError(
                "Refusing to overwrite existing Bunny object with different byte length: "
                f"{normalized_path}"
            )

        response = self._request(
            "PUT",
            self.storage_url(normalized_path),
            headers={
                "AccessKey": self.access_key,
                "Content-Type": content_type,
                "Cache-Control": CACHE_CONTROL_IMMUTABLE,
            },
            body=local_path.read_bytes(),
        )
        if response.status not in {200, 201}:
            raise _http_error("Bunny upload", response)

        verified_size = self.verified_public_file_size(normalized_path)
        if verified_size != expected_size:
            raise ExternalServiceError(
                "Bunny upload verification failed for "
                f"{normalized_path}: expected {expected_size} bytes, got {verified_size}"
            )
        return BunnyUploadedObject(
            remote_path=normalized_path,
            public_url=self.public_url(normalized_path),
            bytes=expected_size,
        )

    def storage_file_size(self, remote_path: str) -> int | None:
        """Return object byte length from Bunny Storage, or None when absent."""

        normalized_path = normalize_remote_path(remote_path)
        response = self._request(
            "GET",
            self.storage_url(normalized_path),
            headers={"AccessKey": self.access_key, "Range": "bytes=0-0"},
            body=None,
        )
        if response.status == 404:
            return None
        if response.status not in {200, 206}:
            raise _http_error("Bunny storage size verification", response)
        length = _content_range_total(response.headers) or _content_length(response.headers)
        if length is None:
            raise ExternalServiceError(
                f"Bunny storage response lacked byte length headers: {remote_path}"
            )
        return length

    def public_file_size(self, remote_path: str) -> int | None:
        """Return public CDN object byte length via HEAD, or None when absent."""

        normalized_path = normalize_remote_path(remote_path)
        response = self._request("HEAD", self.public_url(normalized_path), headers={}, body=None)
        if response.status == 404:
            return None
        if response.status != 200:
            raise _http_error("Bunny CDN HEAD verification", response)
        length = _content_length(response.headers)
        if length is None:
            raise ExternalServiceError(
                f"Bunny CDN HEAD response lacked Content-Length: {remote_path}"
            )
        return length

    def verified_public_file_size(self, remote_path: str) -> int | None:
        """HEAD the public CDN URL with short retry for new pull-zone propagation."""

        attempt = 0
        while True:
            size = self.public_file_size(remote_path)
            if size is not None or attempt >= self.max_retries:
                return size
            time.sleep(min(8.0, 0.5 * (2**attempt)))
            attempt += 1

    def storage_url(self, remote_path: str) -> str:
        """Build the Bunny Storage API URL for a remote path."""

        quoted = "/".join(
            urllib.parse.quote(part, safe="")
            for part in normalize_remote_path(remote_path).split("/")
        )
        return f"https://{self.storage_hostname}/{self.storage_zone_name}/{quoted}"

    def public_url(self, remote_path: str) -> str:
        """Build the CDN URL for a remote path."""

        quoted = "/".join(
            urllib.parse.quote(part, safe="")
            for part in normalize_remote_path(remote_path).split("/")
        )
        return f"{self.cdn_base_url}/{quoted}"

    def _request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
    ) -> HttpResponse:
        return request_with_retries(
            self.transport,
            method,
            url,
            headers=headers,
            body=body,
            timeout_s=self.timeout_s,
            max_retries=self.max_retries,
        )


class BunnyAccountClient:
    """Bunny account API helper for locating or creating publish zones."""

    def __init__(
        self,
        *,
        api_key: str,
        transport: HttpTransport | None = None,
        timeout_s: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self.api_key = api_key
        self.transport = transport or UrllibTransport()
        self.timeout_s = timeout_s
        self.max_retries = max_retries

    def provision_storage_target(
        self,
        *,
        storage_zone_name: str,
        pull_zone_name: str,
        region: str,
    ) -> BunnyStorageTarget:
        """Find or create the storage zone and linked pull zone for publishing."""

        zone = self.get_or_create_storage_zone(storage_zone_name, region=region)
        zone_id = _required_int(zone, "Id", "Bunny storage zone")
        storage_password = _required_str(zone, "Password", "Bunny storage zone")
        storage_hostname = _optional_str(
            zone.get("StorageHostname")
        ) or storage_hostname_for_region(_optional_str(zone.get("Region")) or region)
        pull_zone = self.get_or_create_pull_zone(pull_zone_name, storage_zone_id=zone_id)
        cdn_base_url = pull_zone_base_url(pull_zone, pull_zone_name)
        return BunnyStorageTarget(
            storage_zone_name=_required_str(zone, "Name", "Bunny storage zone"),
            storage_access_key=storage_password,
            storage_hostname=storage_hostname,
            cdn_base_url=cdn_base_url,
        )

    def get_or_create_storage_zone(self, name: str, *, region: str) -> Mapping[str, Any]:
        """Return an existing storage zone by name, or create it."""

        for zone in self.list_storage_zones():
            if _optional_str(zone.get("Name")) == name:
                return zone
        return self._json_request(
            "POST",
            f"{BUNNY_API_BASE}/storagezone",
            body={"Name": name, "Region": region, "ReplicationRegions": []},
            expected_status={200, 201},
            context="Bunny create storage zone",
        )

    def list_storage_zones(self) -> list[Mapping[str, Any]]:
        """List Bunny storage zones for the account."""

        response = self._request_json(
            "GET",
            f"{BUNNY_API_BASE}/storagezone",
            body=None,
            expected_status={200},
            context="Bunny list storage zones",
        )
        return _items_array(response, "Bunny storage zones")

    def get_or_create_pull_zone(self, name: str, *, storage_zone_id: int) -> Mapping[str, Any]:
        """Return an existing pull zone by name, or create it."""

        for pull_zone in self.list_pull_zones():
            if _optional_str(pull_zone.get("Name")) == name:
                return pull_zone
        return self._json_request(
            "POST",
            f"{BUNNY_API_BASE}/pullzone",
            body={
                "Name": name,
                "StorageZoneId": storage_zone_id,
                "EnableCacheSlice": True,
                "CacheControlPublicMaxAgeOverride": 31536000,
                "DisableCookies": True,
                "Type": 0,
            },
            expected_status={200, 201},
            context="Bunny create pull zone",
        )

    def list_pull_zones(self) -> list[Mapping[str, Any]]:
        """List Bunny pull zones for the account."""

        response = self._request_json(
            "GET",
            f"{BUNNY_API_BASE}/pullzone",
            body=None,
            expected_status={200},
            context="Bunny list pull zones",
        )
        return _items_array(response, "Bunny pull zones")

    def _json_request(
        self,
        method: str,
        url: str,
        *,
        body: Mapping[str, object] | None,
        expected_status: set[int],
        context: str,
    ) -> Mapping[str, Any]:
        parsed = self._request_json(
            method,
            url,
            body=body,
            expected_status=expected_status,
            context=context,
        )
        if not isinstance(parsed, Mapping):
            raise ExternalServiceError(f"{context} returned non-object JSON")
        return cast(Mapping[str, Any], parsed)

    def _request_json(
        self,
        method: str,
        url: str,
        *,
        body: Mapping[str, object] | None,
        expected_status: set[int],
        context: str,
    ) -> object:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        response = request_with_retries(
            self.transport,
            method,
            url,
            headers={
                "AccessKey": self.api_key,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            body=payload,
            timeout_s=self.timeout_s,
            max_retries=self.max_retries,
        )
        if response.status not in expected_status:
            raise _http_error(context, response)
        return json.loads(response.body.decode("utf-8") or "{}")


def request_with_retries(
    transport: HttpTransport,
    method: str,
    url: str,
    *,
    headers: Mapping[str, str],
    body: bytes | None,
    timeout_s: float,
    max_retries: int,
) -> HttpResponse:
    """Run one HTTP request with simple retry on rate-limit and 5xx responses."""

    attempt = 0
    while True:
        response = transport.request(method, url, headers=headers, body=body, timeout_s=timeout_s)
        if response.status not in {429, 500, 502, 503, 504} or attempt >= max_retries:
            return response
        retry_after = _retry_after_s(response.headers)
        delay_s = retry_after if retry_after is not None else min(8.0, 0.5 * (2**attempt))
        time.sleep(delay_s)
        attempt += 1


def normalize_remote_path(remote_path: str) -> str:
    """Normalize a storage key to a relative slash-separated path."""

    normalized = remote_path.replace("\\", "/").strip("/")
    if not normalized or "//" in normalized:
        raise ExternalServiceError(f"Invalid Bunny remote path: {remote_path!r}")
    return normalized


def storage_hostname_for_region(region: str) -> str:
    """Return Bunny's Storage API hostname for a primary region code."""

    by_region = {
        "DE": "storage.bunnycdn.com",
        "UK": "uk.storage.bunnycdn.com",
        "NY": "ny.storage.bunnycdn.com",
        "LA": "la.storage.bunnycdn.com",
        "SG": "sg.storage.bunnycdn.com",
        "SE": "se.storage.bunnycdn.com",
        "BR": "br.storage.bunnycdn.com",
        "JH": "jh.storage.bunnycdn.com",
        "SYD": "syd.storage.bunnycdn.com",
    }
    return by_region.get(region.upper(), "storage.bunnycdn.com")


def pull_zone_base_url(pull_zone: Mapping[str, Any], fallback_name: str) -> str:
    """Return the first CDN hostname for a Bunny pull zone."""

    raw_hostnames = pull_zone.get("Hostnames")
    if isinstance(raw_hostnames, list):
        for raw_hostname in raw_hostnames:
            if isinstance(raw_hostname, Mapping):
                value = (
                    _optional_str(raw_hostname.get("Value"))
                    or _optional_str(raw_hostname.get("Hostname"))
                    or _optional_str(raw_hostname.get("Name"))
                )
                if value is not None:
                    return f"https://{value.strip('/')}"
    return f"https://{fallback_name}.b-cdn.net"


def _items_array(payload: object, context: str) -> list[Mapping[str, Any]]:
    raw_items = payload.get("Items", payload) if isinstance(payload, Mapping) else payload
    if isinstance(raw_items, list):
        items: list[Mapping[str, Any]] = []
        for item in raw_items:
            if not isinstance(item, Mapping):
                raise ExternalServiceError(f"{context} contained a non-object item")
            items.append(cast(Mapping[str, Any], item))
        return items
    raise ExternalServiceError(f"{context} response was not an array")


def _content_length(headers: Mapping[str, str]) -> int | None:
    for key, value in headers.items():
        if key.casefold() == "content-length":
            try:
                return int(value)
            except ValueError as exc:
                raise ExternalServiceError(f"Invalid Content-Length header: {value}") from exc
    return None


def _content_range_total(headers: Mapping[str, str]) -> int | None:
    for key, value in headers.items():
        if key.casefold() != "content-range":
            continue
        if "/" not in value:
            return None
        total = value.rsplit("/", 1)[1].strip()
        if total == "*":
            return None
        try:
            return int(total)
        except ValueError as exc:
            raise ExternalServiceError(f"Invalid Content-Range header: {value}") from exc
    return None


def _retry_after_s(headers: Mapping[str, str]) -> float | None:
    for key, value in headers.items():
        if key.casefold() == "retry-after":
            try:
                return max(0.0, float(value))
            except ValueError:
                return None
    return None


def _http_error(context: str, response: HttpResponse) -> ExternalServiceError:
    body_preview = response.body[:300].decode("utf-8", errors="replace")
    return ExternalServiceError(f"{context} failed with HTTP {response.status}: {body_preview}")


def _required_str(payload: Mapping[str, Any], key: str, context: str) -> str:
    value = _optional_str(payload.get(key))
    if value is None:
        raise ExternalServiceError(f"{context} missing {key}")
    return value


def _required_int(payload: Mapping[str, Any], key: str, context: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool):
        raise ExternalServiceError(f"{context} invalid {key}")
    if isinstance(value, int):
        return value
    raise ExternalServiceError(f"{context} missing {key}")


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
