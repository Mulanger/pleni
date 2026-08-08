"""Tests for complete Riksdagen person profile enrichment."""

from __future__ import annotations

import pytest

from src.errors import ExternalServiceError
from src.riksdagen.profiles import PORTRAIT_192_URL, profile_from_person


def test_profile_projects_ui_fields_and_retains_every_source_field() -> None:
    person = {
        "intressent_id": "person-1",
        "tilltalsnamn": "Anna",
        "efternamn": "Test",
        "parti": "M",
        "valkrets": "Kronobergs län",
        "status": "Statsråd",
        "bild_url_192": "https://data.example/person-1_192.jpg",
        "personuppdrag": {"uppdrag": [{"roll_kod": "Statsråd"}]},
        "personuppgift": {"uppgift": [{"kod": "Utbildning"}]},
    }

    profile = profile_from_person(person, expected_intressent_id="person-1")

    assert profile.name == "Anna Test"
    assert profile.party == "M"
    assert profile.constituency == "Kronobergs län"
    assert profile.role == "Statsråd"
    assert profile.avatar_url == "https://data.example/person-1_192.jpg"
    assert profile.riksdagen_data == person
    assert profile.database_row()["riksdagen_data"] == person


def test_profile_uses_deterministic_portrait_url_when_api_omits_one() -> None:
    profile = profile_from_person({"intressent_id": "person-2", "sorteringsnamn": "Test,Bo"})

    assert profile.name == "Test,Bo"
    assert profile.avatar_url == PORTRAIT_192_URL.format(intressent_id="person-2")


def test_profile_refuses_an_unexpected_identity() -> None:
    with pytest.raises(ExternalServiceError, match="did not match"):
        profile_from_person(
            {"intressent_id": "person-2", "tilltalsnamn": "Bo", "efternamn": "Test"},
            expected_intressent_id="person-1",
        )
