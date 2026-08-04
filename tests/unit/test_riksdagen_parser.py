"""Tests for Riksdagen metadata parsers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest

from src.contracts import Source, SpeakerEntry
from src.errors import NotClippableError
from src.riksdagen.parser import (
    RiksdagenParseError,
    html_to_text,
    metadata_with_official_anforanden,
    parse_anforande_xml_response,
    parse_anforandelista_response,
    parse_video_response,
    source_artifact,
    video_page_url_from_document,
)


def load_fixture() -> dict[str, object]:
    payload = json.loads(
        Path("tests/fixtures/debates/short/api_response.json").read_text(encoding="utf-8")
    )
    assert isinstance(payload, dict)
    return payload


def load_json_fixture(path: str) -> dict[str, object]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return payload


def test_parse_video_response_against_captured_fixture() -> None:
    metadata = parse_video_response(load_fixture())

    assert metadata.source == Source(
        dokid="HDC120260305fs",
        title="Frågestund",
        debate_type="kam-fs",
        debate_date=metadata.source.debate_date,
        source_url="https://www.riksdagen.se/sv/webb-tv/video/fragestund/fragestund_hdc120260305fs/",
        duration_s=4291.0,
        master_sha256=None,
    )
    assert metadata.source.debate_date.isoformat() == "2026-03-05"
    assert len(metadata.speaker_entries) == 71
    assert metadata.speaker_entries[0] == SpeakerEntry(
        name="Andreas Norlén",
        party=None,
        start_s=64.0,
        duration_s=29.0,
    )
    assert metadata.speaker_entries[1] == SpeakerEntry(
        name="Johanna Haraldsson",
        party="S",
        start_s=93.0,
        duration_s=51.0,
    )
    assert metadata.media_urls.download_url is not None
    assert metadata.media_urls.download_url.endswith("_720p.mp4")
    assert metadata.anforanden[0].anforande_id == "44"
    assert metadata.anforanden[0].anforandetyp == "Anförande"
    assert "Jag vill hälsa statsråden välkomna" in metadata.anforanden[0].official_text


def test_parse_video_response_against_betankande_fixture() -> None:
    metadata = parse_video_response(
        load_json_fixture("tests/fixtures/debates/betankande/api_response.json")
    )

    assert metadata.source.dokid == "HD01SfU35"
    assert metadata.source.title == "En ny mottagandelag"
    assert metadata.source.debate_type == "bet"
    assert metadata.source.debate_date.isoformat() == "2026-06-03"
    assert len(metadata.speaker_entries) == 26
    assert metadata.media_urls.stream_url is not None
    assert metadata.media_urls.stream_url.endswith("playlist.m3u8")


def test_source_artifact_embeds_c0_contracts() -> None:
    metadata = parse_video_response(load_fixture())
    artifact = source_artifact(metadata)

    Source.model_validate(artifact["source"])
    raw_speakers = cast(list[object], artifact["speaker_entries"])
    for raw_speaker in raw_speakers:
        SpeakerEntry.model_validate(raw_speaker)
    assert len(artifact["anforanden"]) == 71
    media_urls = cast(dict[str, str | None], artifact["media_urls"])
    assert media_urls["download_url"] is not None
    assert media_urls["download_url"].endswith("_720p.mp4")


def test_parse_rejects_empty_response() -> None:
    with pytest.raises(RiksdagenParseError, match="contentApiData"):
        parse_video_response({})


def test_an_empty_speaker_list_is_not_clippable_rather_than_drift() -> None:
    """A document with no speakers usually has no video at all.

    Written interpellation answers, recess sessions and procedural items are all
    normal and expected — especially during a backfill. Reporting them as schema
    drift would make the daily canary cry wolf and would bury real failures in
    the dead-letter list behind hundreds of ordinary gaps.
    """

    payload = {
        "pageProps": {"contentApiData": {"documentId": "X", "title": "T", "date": "2026-01-01"}}
    }

    with pytest.raises(NotClippableError, match="nothing to clip"):
        parse_video_response(payload)


def test_not_clippable_is_still_distinct_from_a_malformed_response() -> None:
    """Real drift must keep raising the drift error, or the canary is useless."""

    with pytest.raises(RiksdagenParseError):
        parse_video_response({"pageProps": {}})


def test_parse_rejects_missing_start_positions() -> None:
    payload = {
        "pageProps": {
            "contentApiData": {
                "documentId": "X",
                "title": "T",
                "date": "2026-01-01",
                "speakers": [{"speaker": "A", "speechSeconds": 10, "speechNumber": 1}],
            }
        }
    }

    with pytest.raises(RiksdagenParseError, match="startPosition"):
        parse_video_response(payload)


def test_parse_rejects_unusable_duration() -> None:
    payload = {
        "pageProps": {
            "contentApiData": {
                "documentId": "X",
                "title": "T",
                "date": "2026-01-01",
                "speakers": [
                    {"speaker": "A", "startPosition": 10, "speechSeconds": 0, "speechNumber": 1}
                ],
            }
        }
    }

    with pytest.raises(RiksdagenParseError, match="duration"):
        parse_video_response(payload)


def test_parse_drops_a_phantom_zero_length_speaker() -> None:
    """Riksdagen duplicates a speaker at the same start with speechSeconds 0.

    HD10342 (2026-02) carried one at 1236 s, alongside the genuine
    254-second speech beginning at the same instant. The derived duration is
    then `1236 - 1236 = 0`, which used to fail the whole debate — roughly 21
    clips lost to a duplicate row. A zero-length speech is not a speech, so it
    is dropped and the real one is kept.
    """

    payload = {
        "pageProps": {
            "contentApiData": {
                "documentId": "HD10342",
                "title": "T",
                "date": "2026-02-01",
                "speakers": [
                    {
                        "speaker": "A",
                        "startPosition": 978,
                        "speechSeconds": 258,
                        "speechNumber": 1,
                    },
                    # The phantom: same start as the next entry, zero length.
                    {
                        "speaker": "B",
                        "startPosition": 1236,
                        "speechSeconds": 0,
                        "speechNumber": 2,
                    },
                    {
                        "speaker": "B",
                        "startPosition": 1236,
                        "speechSeconds": 254,
                        "speechNumber": 3,
                    },
                ],
            }
        }
    }

    result = parse_video_response(payload)

    assert [s.start_s for s in result.speaker_entries] == [978.0, 1236.0]
    assert [s.duration_s for s in result.speaker_entries] == [258.0, 254.0]


def test_parse_anforandelista_response() -> None:
    payload = {
        "anforandelista": {
            "anforande": [
                {
                    "anforande_id": "uuid-1",
                    "anforande_nummer": "12",
                    "talare": "Ledamot Test (S)",
                    "parti": "S",
                    "replik": "J",
                    "anforandetext": "<p>Herr talman!</p><p>Detta är text.</p>",
                    "intressent_id": "person-1",
                    "rel_dok_id": "DOC1",
                }
            ]
        }
    }

    entries = parse_anforandelista_response(payload)

    assert len(entries) == 1
    assert entries[0].anforande_id == "uuid-1"
    assert entries[0].anforandetyp == "Replik"
    assert entries[0].official_text == "Herr talman!\nDetta är text."
    assert entries[0].intressent_id == "person-1"


def test_parse_official_short_fixture_matches_speaker_count() -> None:
    video = parse_video_response(load_fixture())
    official = parse_anforandelista_response(
        load_json_fixture("tests/fixtures/debates/short/official_speeches_response.json"),
        rel_dokid=video.source.dokid,
    )

    assert len(official) == len(video.speaker_entries) == 71
    assert official[0].speech_number == 44
    assert official[0].anforande_id != "44"
    assert official[0].talare == "TALMANNEN"
    assert official[0].intressent_id == "0585684563812"
    assert any(entry.anforandetyp == "Svar" for entry in official)
    assert "(Applåder)" in "\n".join(entry.official_text for entry in official)


def test_parse_official_betankande_fixture_distinguishes_repliker() -> None:
    video = parse_video_response(
        load_json_fixture("tests/fixtures/debates/betankande/api_response.json")
    )
    official = parse_anforandelista_response(
        load_json_fixture("tests/fixtures/debates/betankande/official_speeches_response.json"),
        rel_dokid=video.source.dokid,
    )

    assert len(official) == len(video.speaker_entries) == 26
    assert official[0].anforandetyp == "Anförande"
    assert official[2].anforandetyp == "Replik"
    assert sum(entry.anforandetyp == "Replik" for entry in official) == 18
    text = "\n".join(entry.official_text for entry in official)
    assert "(Applåder)" in text
    assert "(TALMANNEN:" in text


def test_source_artifact_carries_official_speeches() -> None:
    metadata = parse_video_response(
        load_json_fixture("tests/fixtures/debates/betankande/api_response.json")
    )
    official = parse_anforandelista_response(
        load_json_fixture("tests/fixtures/debates/betankande/official_speeches_response.json"),
        rel_dokid=metadata.source.dokid,
    )

    artifact = source_artifact(
        metadata_with_official_anforanden(
            metadata,
            official,
            source="open_data_anforandelista+xml",
        )
    )

    assert artifact["official_speech_source"] == "open_data_anforandelista+xml"
    raw_anforanden = cast(list[dict[str, object]], artifact["anforanden"])
    assert raw_anforanden[0]["intressent_id"] == "0796312429425"
    assert "Vi moderater gick år 2022 till val" in str(raw_anforanden[0]["official_text"])


def test_committed_source_fixtures_contain_official_speech_text() -> None:
    for source_path in [
        Path("tests/fixtures/debates/short/00_source.json"),
        Path("tests/fixtures/debates/betankande/00_source.json"),
    ]:
        artifact = load_json_fixture(str(source_path))
        anforanden = cast(list[dict[str, object]], artifact["anforanden"])
        speaker_entries = cast(list[dict[str, object]], artifact["speaker_entries"])

        assert artifact["official_speech_source"] == "open_data_anforandelista+xml"
        assert len(anforanden) == len(speaker_entries)
        assert all(str(entry["anforande_id"]) for entry in anforanden)
        assert all(str(entry["intressent_id"]) for entry in anforanden)
        assert any("Applåder" in str(entry["official_text"]) for entry in anforanden)


def test_parse_anforande_xml_response_preserves_markers() -> None:
    entry = parse_anforande_xml_response(
        """
        <anforande>
          <anforande_id>uuid-2</anforande_id>
          <anforande_nummer>7</anforande_nummer>
          <talare>Ledamot Test (S)</talare>
          <parti>S</parti>
          <anforandetext>&lt;p&gt;(TALMANNEN: Ledamoten ska avsluta.)&lt;/p&gt;
          &lt;p&gt;(Applåder)&lt;/p&gt;</anforandetext>
          <intressent_id>person-2</intressent_id>
          <rel_dok_id>DOC1</rel_dok_id>
          <replik>Y</replik>
        </anforande>
        """
    )

    assert entry.anforandetyp == "Replik"
    assert "(TALMANNEN: Ledamoten ska avsluta.)" in entry.official_text
    assert "(Applåder)" in entry.official_text


def test_html_to_text_collapses_tags() -> None:
    assert html_to_text("<p>Ett&nbsp;test.</p><p>Nästa.</p>") == "Ett\xa0test.\nNästa."


def test_video_page_url_from_verified_document_shape() -> None:
    url = video_page_url_from_document(
        {
            "dok_id": "HDC120260305fs",
            "titel": "Frågestund",
            "doktyp": "kam-fs",
            "subtyp": "fs",
        }
    )

    assert url == "https://www.riksdagen.se/sv/webb-tv/video/fragestund/fragestund_hdc120260305fs/"


def test_video_page_url_uses_debate_category_when_present() -> None:
    url = video_page_url_from_document(
        {
            "dok_id": "HD01SfU35",
            "titel": "En ny mottagandelag",
            "doktyp": "bet",
            "subtyp": "bet",
            "debattnamn": "Debatt om förslag",
        }
    )

    assert (
        url
        == "https://www.riksdagen.se/sv/webb-tv/video/debatt-om-forslag/en-ny-mottagandelag_hd01sfu35/"
    )
