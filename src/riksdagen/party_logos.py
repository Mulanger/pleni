"""Safe, byte-for-byte mirroring of official Riksdag party logos to Bunny."""

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

MAX_PARTY_LOGO_BYTES = 1_000_000
PARTY_LOGO_CONTENT_TYPE = "image/png"
PARTY_LOGO_PATH_PREFIX = "party-logos"
_PARTY_CODES = frozenset({"S", "M", "SD", "C", "V", "KD", "MP", "L"})
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_IEND = b"\x00\x00\x00\x00IEND\xaeB`\x82"


@dataclass(frozen=True)
class PartyLogoSource:
    """Canonical official source for one Riksdag party mark."""

    code: str
    url: str


PARTY_LOGO_SOURCES = (
    PartyLogoSource(
        "S",
        "https://bilder.riksdagen.se/publishedmedia/e9omiy7wkxkhts7ptwal/"
        "Symbol_Socialdemokraterna-_134px.png",
    ),
    PartyLogoSource(
        "M",
        "https://bilder.riksdagen.se/publishedmedia/p9df8v4c3f4fvupc7oqx/"
        "Symbol_Moderaterna_125px.png",
    ),
    PartyLogoSource(
        "SD",
        "https://bilder.riksdagen.se/publishedmedia/6gxtyz3j95i9xr0ejrbn/"
        "Sveriedemokraterna_132px.png",
    ),
    PartyLogoSource(
        "C",
        "https://bilder.riksdagen.se/publishedmedia/n8ppx8bt2189jfei9f7g/"
        "Symbol_Centern_125.png",
    ),
    PartyLogoSource(
        "V",
        "https://bilder.riksdagen.se/publishedmedia/4a9gkf3jqwprajbmcqt8/"
        "Symbol_Va-nsterpartiet_121px.png",
    ),
    PartyLogoSource(
        "KD",
        "https://bilder.riksdagen.se/publishedmedia/bnz3yl48fswzmc8cd4m8/"
        "KD_partilogga.png",
    ),
    PartyLogoSource(
        "MP",
        "https://bilder.riksdagen.se/publishedmedia/3sgk8lpoqlu2mht11nov/"
        "MP_partilogga.png",
    ),
    PartyLogoSource(
        "L",
        "https://bilder.riksdagen.se/publishedmedia/r0mdg32vrghp96agrxax/"
        "L_partilogga.png",
    ),
)


class PartyLogoHttpClient(Protocol):
    """The retrying GET boundary needed from :class:`RiksdagenClient`."""

    def get(self, url: str, *, accept: str = "application/json") -> HttpResponse:
        """Fetch one official party-logo response."""


class PartyLogoStorage(Protocol):
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
class PartyLogoImage:
    """Validated official PNG bytes and their stable content identity."""

    code: str
    source_url: str
    body: bytes
    sha256: str
    width: int
    height: int


@dataclass(frozen=True)
class MirroredPartyLogo:
    """One verified public CDN mirror."""

    code: str
    source_url: str
    cdn_url: str
    sha256: str
    bytes: int
    remote_path: str


def download_party_logo(
    client: PartyLogoHttpClient,
    source: PartyLogoSource,
) -> PartyLogoImage:
    """Download and validate an official Riksdagen PNG without transforming it."""

    _validate_code(source.code)
    _validate_source_url(source.url)
    response = client.get(source.url, accept=PARTY_LOGO_CONTENT_TYPE)
    body = response.body
    content_type = _header(response.headers, "content-type").split(";", 1)[0].strip().lower()

    if content_type != PARTY_LOGO_CONTENT_TYPE:
        raise ExternalServiceError(
            "Riksdagen party logo returned unexpected content type "
            f"{content_type or '(missing)'}"
        )
    if not body:
        raise ExternalServiceError("Riksdagen party logo response was empty")
    if len(body) > MAX_PARTY_LOGO_BYTES:
        raise ExternalServiceError(
            f"Riksdagen party logo exceeded {MAX_PARTY_LOGO_BYTES} bytes"
        )
    width, height = _png_dimensions(body)
    if width != height or not 24 <= width <= 2048:
        raise ExternalServiceError(
            f"Riksdagen party logo had unsafe dimensions {width}x{height}"
        )

    return PartyLogoImage(
        code=source.code,
        source_url=source.url,
        body=body,
        sha256=hashlib.sha256(body).hexdigest(),
        width=width,
        height=height,
    )


def party_logo_remote_path(code: str, sha256: str) -> str:
    """Return the immutable, content-addressed Bunny path for one party mark."""

    _validate_code(code)
    if re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
        raise ExternalServiceError(
            "Party logo SHA-256 must be 64 lowercase hexadecimal characters"
        )
    return f"{PARTY_LOGO_PATH_PREFIX}/{code.lower()}/{sha256}.png"


def upload_party_logo(
    storage: PartyLogoStorage,
    image: PartyLogoImage,
) -> MirroredPartyLogo:
    """Upload validated bytes and return only after Bunny public verification."""

    remote_path = party_logo_remote_path(image.code, image.sha256)
    with TemporaryDirectory(prefix="pleni-party-logo-") as directory:
        local_path = Path(directory) / "logo.png"
        local_path.write_bytes(image.body)
        uploaded = storage.upload_file(
            local_path,
            remote_path,
            content_type=PARTY_LOGO_CONTENT_TYPE,
        )
    return MirroredPartyLogo(
        code=image.code,
        source_url=image.source_url,
        cdn_url=uploaded.public_url,
        sha256=image.sha256,
        bytes=uploaded.bytes,
        remote_path=uploaded.remote_path,
    )


def _validate_code(code: str) -> None:
    if code not in _PARTY_CODES:
        raise ExternalServiceError(f"Unknown Riksdag party code: {code!r}")


def _validate_source_url(source_url: str) -> None:
    parsed = urlsplit(source_url)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ExternalServiceError(
            "Party logo source must be an HTTPS URL on bilder.riksdagen.se"
        ) from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != "bilder.riksdagen.se"
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
    ):
        raise ExternalServiceError(
            "Party logo source must be an HTTPS URL on bilder.riksdagen.se"
        )


def _header(headers: Mapping[str, str], name: str) -> str:
    wanted = name.casefold()
    for key, value in headers.items():
        if key.casefold() == wanted:
            return value
    return ""


def _png_dimensions(body: bytes) -> tuple[int, int]:
    if (
        len(body) < 45
        or not body.startswith(_PNG_SIGNATURE)
        or body[12:16] != b"IHDR"
        or not body.endswith(_PNG_IEND)
    ):
        raise ExternalServiceError(
            "Riksdagen party logo response was not a valid PNG envelope"
        )
    width = int.from_bytes(body[16:20], "big")
    height = int.from_bytes(body[20:24], "big")
    if width <= 0 or height <= 0:
        raise ExternalServiceError("Riksdagen party logo PNG had invalid dimensions")
    return width, height
