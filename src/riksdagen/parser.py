"""Parsers for Riksdagen video and speech metadata responses."""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime
from html.parser import HTMLParser
from typing import cast
from xml.etree import ElementTree

from src.contracts import Source, SpeakerEntry

NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(?P<payload>.*?)</script>',
    re.DOTALL,
)
PARTY_RE = re.compile(r"\(([A-ZÅÄÖa-zåäö-]+)\)\s*$")
ANSWER_SPEAKER_RE = re.compile(
    r"\b(statsministern|statsrådet|(?:[a-zåäö]+- och )?[a-zåäö]+ministern)\b",
    re.IGNORECASE,
)


class RiksdagenParseError(ValueError):
    """A Riksdagen response did not match the expected schema."""


@dataclass(frozen=True)
class MediaUrls:
    """Media URLs published with a Riksdagen webb-tv document."""

    stream_url: str | None
    download_url: str | None
    audio_url: str | None
    poster_url: str | None


@dataclass(frozen=True)
class AnforandeEntry:
    """Official speech text and identity metadata from an anförandelista source."""

    anforande_id: str
    anforandetyp: str
    speech_number: int
    talare: str
    speaker_name: str
    parti: str | None
    party: str | None
    intressent_id: str | None
    official_text: str
    rel_dok_id: str | None = None
    source_url: str | None = None
    start_s: float | None = None
    duration_s: float | None = None


@dataclass(frozen=True)
class VideoMetadata:
    """Parsed metadata for one Riksdagen webb-tv document."""

    source: Source
    speaker_entries: tuple[SpeakerEntry, ...]
    anforanden: tuple[AnforandeEntry, ...]
    media_urls: MediaUrls
    official_speech_source: str = "webb_tv_page_data"


def parse_video_response(payload: Mapping[str, object]) -> VideoMetadata:
    """Parse a current Riksdagen video JSON response into C0 contracts."""

    content = _content_api_data(payload)
    speakers = _speaker_list(content.get("speakers"))
    video = _optional_mapping(content.get("video"))
    metadata = _optional_mapping(content.get("metadata"))

    source = Source(
        dokid=_required_str(content.get("documentId"), "contentApiData.documentId"),
        title=_required_str(content.get("title"), "contentApiData.title"),
        debate_type=_optional_str(content.get("documentType")),
        debate_date=_parse_date(
            _optional_str(metadata.get("videoPublicationDate") if metadata else None)
            or _required_str(content.get("date"), "contentApiData.date")
        ),
        source_url=_source_url(content, metadata),
        duration_s=_optional_float(video.get("duration") if video else None)
        or _optional_float(metadata.get("videoDuration") if metadata else None),
        master_sha256=None,
    )
    duration_s = source.duration_s
    speaker_entries = _parse_speaker_entries(speakers, duration_s)
    anforanden = _parse_current_video_anforanden(speakers)
    media_urls = MediaUrls(
        stream_url=_optional_str(video.get("url") if video else None),
        download_url=_optional_str(video.get("downloadUrl") if video else None),
        audio_url=_optional_str(video.get("audioUrl") if video else None),
        poster_url=_optional_str(video.get("poster") if video else None),
    )
    return VideoMetadata(
        source=source,
        speaker_entries=speaker_entries,
        anforanden=anforanden,
        media_urls=media_urls,
    )


def parse_anforandelista_response(
    payload: Mapping[str, object], *, rel_dokid: str | None = None
) -> tuple[AnforandeEntry, ...]:
    """Parse the official open-data anförandelista response."""

    container = _required_mapping(payload.get("anforandelista"), "anforandelista")
    raw_entries = _listify(container.get("anforande"))
    entries: list[AnforandeEntry] = []
    for index, raw_entry in enumerate(raw_entries):
        entry = _required_mapping(raw_entry, f"anforandelista.anforande[{index}]")
        if rel_dokid is not None and _casefold(entry.get("rel_dok_id")) != rel_dokid.casefold():
            continue
        entries.append(_parse_anforande_entry(entry))
    return tuple(sorted(entries, key=lambda item: item.speech_number))


def parse_anforande_xml_response(xml_text: str) -> AnforandeEntry:
    """Parse one official open-data anförande XML response."""

    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise RiksdagenParseError("Invalid anförande XML response") from exc
    if root.tag != "anforande":
        raise RiksdagenParseError("Anförande XML root was not <anforande>")
    entry = {child.tag: child.text or "" for child in root}
    return _parse_anforande_entry(entry)


def merge_anforande_detail(summary: AnforandeEntry, detail: AnforandeEntry) -> AnforandeEntry:
    """Merge list identity metadata with a per-speech XML detail response."""

    if summary.speech_number != detail.speech_number:
        raise RiksdagenParseError("Anförande detail did not match list speech number")
    return replace(
        summary,
        anforande_id=detail.anforande_id or summary.anforande_id,
        anforandetyp=detail.anforandetyp,
        talare=detail.talare or summary.talare,
        speaker_name=detail.speaker_name or summary.speaker_name,
        parti=detail.parti or summary.parti,
        party=detail.party or summary.party,
        intressent_id=detail.intressent_id or summary.intressent_id,
        official_text=detail.official_text or summary.official_text,
        rel_dok_id=detail.rel_dok_id or summary.rel_dok_id,
        source_url=summary.source_url or detail.source_url,
    )


def metadata_with_official_anforanden(
    metadata: VideoMetadata,
    anforanden: Sequence[AnforandeEntry],
    *,
    source: str,
) -> VideoMetadata:
    """Return video metadata with official speech entries replacing page-data text."""

    return replace(
        metadata,
        anforanden=tuple(anforanden),
        official_speech_source=source,
    )


def source_artifact(metadata: VideoMetadata) -> dict[str, object]:
    """Build the JSON-compatible `00_source.json` artifact."""

    return {
        "source": metadata.source.model_dump(mode="json"),
        "speaker_entries": [
            speaker.model_dump(mode="json") for speaker in metadata.speaker_entries
        ],
        "anforanden": [asdict(anforande) for anforande in metadata.anforanden],
        "official_speech_source": metadata.official_speech_source,
        "media_urls": asdict(metadata.media_urls),
    }


def extract_next_data_json(html: str) -> Mapping[str, object]:
    """Extract the Next.js data JSON embedded in a Riksdagen page."""

    match = NEXT_DATA_RE.search(html)
    if match is None:
        raise RiksdagenParseError("Riksdagen page did not include __NEXT_DATA__ JSON")
    payload = json.loads(match.group("payload"))
    if not isinstance(payload, dict):
        raise RiksdagenParseError("__NEXT_DATA__ JSON was not an object")
    return payload


def video_page_url_from_document(
    document: Mapping[str, object], *, web_base_url: str = "https://www.riksdagen.se"
) -> str:
    """Construct the verified current webb-tv URL for a document-list/status record."""

    dokid = _required_str(document.get("dok_id"), "document.dok_id")
    title = (
        _optional_str(document.get("titel")) or _optional_str(document.get("dokumentnamn")) or dokid
    )
    subtyp = (_optional_str(document.get("subtyp")) or "").lower()
    doktyp = (_optional_str(document.get("doktyp")) or "").lower()
    debattnamn = _optional_str(document.get("debattnamn"))
    if subtyp == "fs" or doktyp == "kam-fs":
        category = "fragestund"
    elif debattnamn is not None:
        category = slugify(debattnamn)
    else:
        category = slugify(title)
    slug = f"{slugify(title)}_{dokid.lower()}"
    return f"{web_base_url.rstrip('/')}/sv/webb-tv/video/{category}/{slug}/"


def slugify(value: str) -> str:
    """Return the slug style used by current Riksdagen webb-tv URLs."""

    normalised = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", normalised.lower()).strip("-")
    if not slug:
        raise RiksdagenParseError("Cannot build a URL slug from an empty value")
    return slug


def html_to_text(value: str) -> str:
    """Convert small official transcript HTML snippets to plain text."""

    parser = _PlainTextParser()
    parser.feed(value)
    return parser.text


def _content_api_data(payload: Mapping[str, object]) -> Mapping[str, object]:
    direct = payload.get("contentApiData")
    if isinstance(direct, dict):
        return cast(Mapping[str, object], direct)

    page_props = _optional_mapping(payload.get("pageProps"))
    if page_props is not None:
        nested = page_props.get("contentApiData")
        if isinstance(nested, dict):
            return cast(Mapping[str, object], nested)

    props = _optional_mapping(payload.get("props"))
    if props is not None:
        nested_page_props = _optional_mapping(props.get("pageProps"))
        if nested_page_props is not None:
            content = nested_page_props.get("contentApiData")
            if isinstance(content, dict):
                return cast(Mapping[str, object], content)

    raise RiksdagenParseError("Response is missing contentApiData")


def _parse_speaker_entries(
    speakers: Sequence[Mapping[str, object]], duration_s: float | None
) -> tuple[SpeakerEntry, ...]:
    starts = [
        _required_float(speaker.get("startPosition"), "speaker.startPosition")
        for speaker in speakers
    ]
    if any(start < 0 for start in starts):
        raise RiksdagenParseError("speaker.startPosition must be non-negative")

    entries: list[SpeakerEntry] = []
    for index, speaker in enumerate(speakers):
        start_s = starts[index]
        raw_duration = _optional_float(speaker.get("speechSeconds"))
        duration = raw_duration if raw_duration and raw_duration > 0 else None
        if duration is None and index + 1 < len(starts):
            duration = starts[index + 1] - start_s
        if duration is None and duration_s is not None:
            duration = duration_s - start_s
        if duration is None or duration <= 0:
            raise RiksdagenParseError("speaker duration was missing and could not be derived")

        entries.append(
            SpeakerEntry(
                name=_speaker_name(speaker),
                party=_party(speaker),
                start_s=start_s,
                duration_s=duration,
            )
        )
    return tuple(entries)


def _parse_current_video_anforanden(
    speakers: Sequence[Mapping[str, object]],
) -> tuple[AnforandeEntry, ...]:
    entries: list[AnforandeEntry] = []
    for speaker in speakers:
        speech_number = int(_required_float(speaker.get("speechNumber"), "speaker.speechNumber"))
        duration = _optional_float(speaker.get("speechSeconds"))
        entries.append(
            AnforandeEntry(
                anforande_id=str(speech_number),
                anforandetyp=_optional_str(speaker.get("anforandetyp")) or "Anförande",
                speech_number=speech_number,
                talare=_optional_str(speaker.get("speaker")) or _speaker_name(speaker),
                speaker_name=_speaker_name(speaker),
                parti=_party(speaker),
                party=_party(speaker),
                intressent_id=_optional_str(speaker.get("stakeholderId2"))
                or _optional_str(speaker.get("stakeholderId")),
                official_text=html_to_text(_optional_str(speaker.get("speechText")) or ""),
                start_s=_optional_float(speaker.get("startPosition")),
                duration_s=duration if duration and duration > 0 else None,
            )
        )
    return tuple(entries)


def _parse_anforande_entry(entry: Mapping[str, object]) -> AnforandeEntry:
    number = int(_required_str(entry.get("anforande_nummer"), "anforande_nummer"))
    talare = _required_str(entry.get("talare"), "talare")
    parti = _optional_str(entry.get("parti"))
    return AnforandeEntry(
        anforande_id=_required_str(entry.get("anforande_id"), "anforande_id"),
        anforandetyp=_anforandetyp(entry, talare),
        speech_number=number,
        talare=talare,
        speaker_name=_speaker_name(entry),
        parti=parti,
        party=parti,
        intressent_id=_optional_str(entry.get("intressent_id")),
        official_text=html_to_text(_optional_str(entry.get("anforandetext")) or ""),
        rel_dok_id=_optional_str(entry.get("rel_dok_id")),
        source_url=_optional_str(entry.get("anforande_url_xml")),
    )


def _anforandetyp(entry: Mapping[str, object], talare: str) -> str:
    explicit = _optional_str(entry.get("anforandetyp"))
    if explicit in {"Anförande", "Replik", "Svar"}:
        return explicit

    replik = (_optional_str(entry.get("replik")) or "").upper()
    if replik in {"J", "Y"}:
        return "Replik"

    activity = (_optional_str(entry.get("kammaraktivitet")) or "").casefold()
    if activity in {"frågestund", "interpellationsdebatt"} and ANSWER_SPEAKER_RE.search(talare):
        return "Svar"
    return "Anförande"


def _source_url(content: Mapping[str, object], metadata: Mapping[str, object] | None) -> str:
    return (
        _optional_str(content.get("url"))
        or _optional_str(metadata.get("canonicalUrl") if metadata else None)
        or _required_str(content.get("documentId"), "contentApiData.documentId")
    )


def _speaker_name(speaker: Mapping[str, object]) -> str:
    return (
        _optional_str(speaker.get("speakerShort"))
        or _optional_str(speaker.get("speaker"))
        or _required_str(speaker.get("talare"), "speaker name")
    )


def _casefold(value: object) -> str | None:
    text = _optional_str(value)
    return text.casefold() if text is not None else None


def _party(speaker: Mapping[str, object]) -> str | None:
    party = _optional_str(speaker.get("party")) or _optional_str(speaker.get("parti"))
    if party is not None:
        return party
    speaker_name = _optional_str(speaker.get("speaker")) or _optional_str(speaker.get("talare"))
    if speaker_name is None:
        return None
    match = PARTY_RE.search(speaker_name)
    return match.group(1) if match else None


def _speaker_list(value: object) -> tuple[Mapping[str, object], ...]:
    speakers = _listify(value)
    if not speakers:
        raise RiksdagenParseError("Response speaker list is missing or empty")
    return tuple(_required_mapping(item, "speaker") for item in speakers)


def _listify(value: object) -> tuple[object, ...]:
    if value is None:
        return ()
    if isinstance(value, Mapping):
        return (value,)
    if isinstance(value, Sequence) and not isinstance(value, str | bytes):
        return tuple(value)
    raise RiksdagenParseError("Expected a JSON object or array")


def _required_mapping(value: object, context: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise RiksdagenParseError(f"Expected object at {context}")
    return cast(Mapping[str, object], value)


def _optional_mapping(value: object) -> Mapping[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        return None
    return cast(Mapping[str, object], value)


def _required_str(value: object, context: str) -> str:
    result = _optional_str(value)
    if result is None:
        raise RiksdagenParseError(f"Expected non-empty string at {context}")
    return result


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _required_float(value: object, context: str) -> float:
    result = _optional_float(value)
    if result is None:
        raise RiksdagenParseError(f"Expected number at {context}")
    return result


def _optional_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _parse_date(value: str) -> date:
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized).date()
    except ValueError:
        try:
            return datetime.strptime(value[:10], "%Y-%m-%d").date()
        except ValueError as exc:
            raise RiksdagenParseError(f"Invalid date: {value}") from exc


class _PlainTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    @property
    def text(self) -> str:
        collapsed = re.sub(r"[ \t\r\f\v]+", " ", "".join(self._parts))
        collapsed = re.sub(r"\n{3,}", "\n\n", collapsed)
        return collapsed.strip()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"p", "br", "li"} and self._parts:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        self._parts.append(data)
