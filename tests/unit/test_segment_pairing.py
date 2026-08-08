"""Tests for aligning official speeches to video speaker segments."""

from __future__ import annotations

from src.contracts import SpeakerEntry
from src.segment.pairing import name_key, pair_official_speeches


def _speaker(name: str, start: float) -> SpeakerEntry:
    return SpeakerEntry(name=name, party="M", start_s=start, duration_s=100.0)


def _official(name: str, anforande_id: str) -> dict[str, str]:
    return {"speaker_name": name, "anforande_id": anforande_id, "official_text": name}


def test_the_hd10342_defect_an_official_entry_with_no_video_segment() -> None:
    """The bug this module exists for.

    `HD10342` has 8 speaker entries and 9 anföranden -- the extra being a
    `TREDJE VICE TALMANNEN` intervention with no video segment of its own. Index
    pairing shifted every speech after it onto the wrong person, and because the
    official name *overrode* the video metadata's, the artifact looked fine.
    Wrong politician, wrong party, wrong transcript, on published clips.
    """

    speakers = [
        _speaker("Anna Tenje", 0.0),
        _speaker("Åsa Eriksson", 260.0),
        _speaker("Anna Tenje", 1236.0),
        _speaker("Åsa Eriksson", 1490.0),
        _speaker("Anna Tenje", 1602.0),
    ]
    official = [
        _official("Äldre- och socialförsäkringsministern Anna Tenje (M)", "a1"),
        _official("Åsa Eriksson (S)", "a2"),
        _official("TREDJE VICE TALMANNEN", "a3"),
        _official("Äldre- och socialförsäkringsministern Anna Tenje (M)", "a4"),
        _official("Åsa Eriksson (S)", "a5"),
        _official("Äldre- och socialförsäkringsministern Anna Tenje (M)", "a6"),
    ]

    paired = pair_official_speeches(speakers, official)

    assert [p["anforande_id"] for p in paired] == ["a1", "a2", "a4", "a5", "a6"], (
        "the chair announcement must be skipped, not consume a speaker's slot"
    )


def test_a_ministerial_title_does_not_break_the_match() -> None:
    """The two sources spell the same person differently: the video metadata has
    a bare name, the official record prefixes a long Swedish ministerial title
    and suffixes a party."""

    paired = pair_official_speeches(
        [_speaker("Anna Tenje", 0.0)],
        [_official("Äldre- och socialförsäkringsministern Anna Tenje (M)", "a1")],
    )

    assert paired[0] is not None and paired[0]["anforande_id"] == "a1"


def test_an_unmatched_segment_gets_no_official_entry_rather_than_a_guess() -> None:
    """Falling through to whatever entry sits at the same index is precisely the
    defect. No match means no transcript, and the caller keeps the video
    metadata's name."""

    paired = pair_official_speeches(
        [_speaker("Jessica Rodén", 0.0)],
        [_official("Någon Annan (S)", "a1")],
    )

    assert paired == [None]


def test_repeated_speakers_keep_their_own_turns_in_order() -> None:
    """An interpellation is the same two people alternating, so the alignment has
    to preserve order rather than matching on name alone."""

    speakers = [
        _speaker("Anna Tenje", 0.0),
        _speaker("Åsa Eriksson", 100.0),
        _speaker("Anna Tenje", 200.0),
    ]
    official = [
        _official("Anna Tenje (M)", "first"),
        _official("Åsa Eriksson (S)", "second"),
        _official("Anna Tenje (M)", "third"),
    ]

    paired = pair_official_speeches(speakers, official)

    assert [p["anforande_id"] for p in paired] == ["first", "second", "third"]


def test_more_video_segments_than_official_entries_is_survivable() -> None:
    speakers = [_speaker("Anna Tenje", 0.0), _speaker("Åsa Eriksson", 100.0)]

    paired = pair_official_speeches(speakers, [_official("Anna Tenje (M)", "a1")])

    assert paired[0] is not None
    assert paired[1] is None


def test_empty_inputs_do_not_explode() -> None:
    assert pair_official_speeches([], [_official("Anna Tenje (M)", "a1")]) == []
    assert pair_official_speeches([_speaker("Anna Tenje", 0.0)], []) == [None]


def test_name_key_ignores_party_and_title_but_keeps_the_person() -> None:
    assert name_key("Anna Tenje") == name_key("Statsrådet Anna Tenje (M)")
    assert name_key("Åsa Eriksson (S)") == name_key("Asa Eriksson")
    assert name_key("Anna Tenje") != name_key("Åsa Eriksson")
    assert name_key("") == ()
