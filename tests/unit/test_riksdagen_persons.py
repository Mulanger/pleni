"""Tests for recovering a missing `intressent_id` from the person register."""

from __future__ import annotations

import pytest

from src.errors import ExternalServiceError
from src.riksdagen.persons import (
    PersonDirectory,
    matching_ids,
    strip_title_and_party,
)


class _FakeClient:
    """Register stub that records how many lookups were made."""

    def __init__(self, by_first_name: dict[str, list[dict[str, str]]]) -> None:
        self.by_first_name = by_first_name
        self.calls: list[str] = []

    def fetch_personlista(self, first_name: str) -> list[dict[str, str]]:
        self.calls.append(first_name)
        return self.by_first_name.get(first_name, [])


def _person(first: str, last: str, party: str, iid: str) -> dict[str, str]:
    return {"tilltalsnamn": first, "efternamn": last, "parti": party, "intressent_id": iid}


def test_a_minister_outside_the_chamber_is_resolved() -> None:
    """The case this exists for: `anforandelista` omits the id for a minister who
    is not a sitting member, so every clip of them is unverifiable."""

    client = _FakeClient({"Jessica": [_person("Jessica", "Rosencrantz", "M", "0992420223820")]})

    match = PersonDirectory(client).resolve("EU-ministern Jessica Rosencrantz (M)", "M")

    assert match is not None
    assert match.intressent_id == "0992420223820"


def test_the_search_walks_back_past_a_ministerial_title() -> None:
    """There is no reliable rule separating a long Swedish ministerial title from
    a multi-word given name, so the first name is searched for backwards from the
    surname instead of parsed out."""

    client = _FakeClient({"Anna": [_person("Anna", "Tenje", "M", "0476336341120")]})

    match = PersonDirectory(client).resolve(
        "Äldre- och socialförsäkringsministern Anna Tenje (M)", "M"
    )

    assert match is not None and match.matched_first_name == "Anna"
    assert client.calls == ["Anna"], "the token adjacent to the surname is tried first"


def test_a_middle_name_the_two_sources_disagree_on_still_resolves() -> None:
    """`anforandelista` says *Vencu Velasquez Castro*, the register says *Vencu
    Öhrlund Castro*. Full-surname matching fails on this real case, so only the
    last surname token is compared — and the search walks back to find the given
    name."""

    client = _FakeClient(
        {
            "Daniel": [
                _person("Daniel", "Andersson", "S", "111"),
                _person("Daniel", "Vencu Öhrlund Castro", "S", "222"),
            ]
        }
    )

    match = PersonDirectory(client).resolve("Daniel Vencu Velasquez Castro (S)", "S")

    assert match is not None and match.intressent_id == "222"
    assert client.calls == ["Velasquez", "Vencu", "Daniel"]


def test_two_plausible_people_resolve_to_nobody() -> None:
    """Putting a politician's face and byline on a statement is not a data
    cleaning task. Ambiguity keeps `None`, which loses the clip instead of
    risking a misattribution."""

    client = _FakeClient(
        {"Anna": [_person("Anna", "Tenje", "M", "111"), _person("Anna", "Ek Tenje", "M", "222")]}
    )

    assert PersonDirectory(client).resolve("Anna Tenje (M)", "M") is None


def test_the_party_must_match() -> None:
    client = _FakeClient({"Anna": [_person("Anna", "Tenje", "M", "111")]})

    assert PersonDirectory(client).resolve("Anna Tenje (S)", "S") is None


def test_a_chair_announcement_has_no_person_behind_it() -> None:
    client = _FakeClient({})

    assert PersonDirectory(client).resolve("TREDJE VICE TALMANNEN", "TREDJE VICE TALMANNEN") is None


def test_results_are_cached_per_speaker() -> None:
    """A debate repeats the same speakers, and a common given name returns a long
    register page every time it is asked for."""

    client = _FakeClient({"Anna": [_person("Anna", "Tenje", "M", "111")]})
    directory = PersonDirectory(client)

    directory.resolve("Anna Tenje (M)", "M")
    directory.resolve("Anna Tenje (M)", "M")

    assert client.calls == ["Anna"]


def test_a_register_outage_is_not_fatal() -> None:
    class _Failing:
        def fetch_personlista(self, first_name: str) -> list[dict[str, str]]:
            raise ExternalServiceError("register down")

    assert PersonDirectory(_Failing()).resolve("Anna Tenje (M)", "M") is None


def test_missing_party_is_not_guessed() -> None:
    client = _FakeClient({"Anna": [_person("Anna", "Tenje", "M", "111")]})

    assert PersonDirectory(client).resolve("Anna Tenje", None) is None
    assert client.calls == []


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Ola Möller (S)", "Ola Möller"),
        (
            "Äldre- och socialförsäkringsministern Anna Tenje (M)",
            "Äldre- och socialförsäkringsministern Anna Tenje",
        ),
        ("TREDJE VICE TALMANNEN", "TREDJE VICE TALMANNEN"),
    ],
)
def test_party_marker_is_stripped_but_title_is_not(raw: str, expected: str) -> None:
    assert strip_title_and_party(raw) == expected


def test_entries_without_an_id_or_surname_are_skipped() -> None:
    people = [
        {"tilltalsnamn": "Anna", "efternamn": "Tenje", "parti": "M", "intressent_id": ""},
        {"tilltalsnamn": "Anna", "efternamn": "", "parti": "M", "intressent_id": "111"},
    ]

    assert matching_ids(people, first_name="Anna", party="M", surname_key="tenje") == set()
