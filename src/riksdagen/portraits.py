"""Safe, byte-for-byte mirroring of official politician portraits to Bunny."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Protocol
from urllib.parse import urlsplit

from src.errors import ExternalServiceError
from src.publish.bunny import BunnyUploadedObject
from src.riksdagen.client import HttpResponse

MAX_PORTRAIT_BYTES = 5_000_000
PORTRAIT_CONTENT_TYPE = "image/jpeg"
PORTRAIT_PATH_PREFIX = "portraits"
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


class PortraitHttpClient(Protocol):
    """The retrying GET boundary needed from :class:`RiksdagenClient`."""

    def get(self, url: str, *, accept: str = "application/json") -> HttpResponse:
        """Fetch one portrait source response."""


class PortraitStorage(Protocol):
    """The verified upload boundary needed from :class:`BunnyStorageClient`."""

    def upload_file(
        self,
        local_path: Path,
        remote_path: str,
        *,
        content_type: str,
    ) -> BunnyUploadedObject:
        """Upload an immutable object and return its verified public URL."""


@dataclass(frozen=True)
class PortraitImage:
    """Validated official portrait bytes and their stable content identity."""

    source_url: str
    body: bytes
    sha256: str


@dataclass(frozen=True)
class MirroredPortrait:
    """One verified public CDN mirror."""

    source_url: str
    cdn_url: str
    sha256: str
    bytes: int
    remote_path: str


def download_portrait(client: PortraitHttpClient, source_url: str) -> PortraitImage:
    """Download and validate an official Riksdagen JPEG without transforming it."""

    _validate_source_url(source_url)
    response = client.get(source_url, accept=PORTRAIT_CONTENT_TYPE)
    body = response.body
    content_type = _header(response.headers, "content-type").split(";", 1)[0].strip().lower()

    if content_type != PORTRAIT_CONTENT_TYPE:
        raise ExternalServiceError(
            f"Riksdagen portrait returned unexpected content type {content_type or '(missing)'}"
        )
    if not body:
        raise ExternalServiceError("Riksdagen portrait response was empty")
    if len(body) > MAX_PORTRAIT_BYTES:
        raise ExternalServiceError(f"Riksdagen portrait exceeded {MAX_PORTRAIT_BYTES} bytes")
    if not _is_jpeg(body):
        raise ExternalServiceError("Riksdagen portrait response was not a valid JPEG envelope")

    return PortraitImage(
        source_url=source_url,
        body=body,
        sha256=hashlib.sha256(body).hexdigest(),
    )


def portrait_remote_path(intressent_id: str, sha256: str) -> str:
    """Return the immutable, content-addressed Bunny path for one portrait."""

    if _SAFE_ID.fullmatch(intressent_id) is None:
        raise ExternalServiceError("Politician id is unsafe for a Bunny portrait path")
    if re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
        raise ExternalServiceError("Portrait SHA-256 must be 64 lowercase hexadecimal characters")
    return f"{PORTRAIT_PATH_PREFIX}/{intressent_id}/{sha256}.jpg"


def upload_portrait(
    storage: PortraitStorage,
    *,
    intressent_id: str,
    image: PortraitImage,
) -> MirroredPortrait:
    """Upload validated bytes and return only after Bunny public verification."""

    remote_path = portrait_remote_path(intressent_id, image.sha256)
    with TemporaryDirectory(prefix="pleni-portrait-") as directory:
        local_path = Path(directory) / "portrait.jpg"
        local_path.write_bytes(image.body)
        uploaded = storage.upload_file(
            local_path,
            remote_path,
            content_type=PORTRAIT_CONTENT_TYPE,
        )
    return MirroredPortrait(
        source_url=image.source_url,
        cdn_url=uploaded.public_url,
        sha256=image.sha256,
        bytes=uploaded.bytes,
        remote_path=uploaded.remote_path,
    )


def _validate_source_url(source_url: str) -> None:
    parsed = urlsplit(source_url)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ExternalServiceError(
            "Portrait source must be an HTTPS URL on data.riksdagen.se"
        ) from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != "data.riksdagen.se"
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
    ):
        raise ExternalServiceError("Portrait source must be an HTTPS URL on data.riksdagen.se")


def _header(headers: Mapping[str, str], name: str) -> str:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return ""


def _is_jpeg(body: bytes) -> bool:
    return (
        len(body) >= 4 and body.startswith(b"\xff\xd8\xff") and body.rstrip().endswith(b"\xff\xd9")
    )
