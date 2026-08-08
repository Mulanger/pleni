"""Riksdagen person records mapped to Pleni's public politician profile.

The complete source record is retained verbatim in Supabase. Only the small,
stable subset needed by today's UI is projected into first-class columns; new
profile features can therefore be built later without re-discovering historical
people or guessing at fields that the API already supplied.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from src.errors import ExternalServiceError

PORTRAIT_CREDIT = "Foto: Sveriges riksdag"
PORTRAIT_192_URL = "https://data.riksdagen.se/filarkiv/bilder/ledamot/{intressent_id}_192.jpg"


@dataclass(frozen=True)
class PoliticianProfile:
    """One complete Riksdagen person record plus UI-facing derived fields."""

    intressent_id: str
    name: str
    party: str | None
    constituency: str | None
    role: str | None
    avatar_url: str
    riksdagen_data: dict[str, object]

    def database_row(self) -> dict[str, object]:
        """JSON-compatible row consumed by the profile sync SQL."""

        return {
            "intressent_id": self.intressent_id,
            "name": self.name,
            "party": self.party,
            "constituency": self.constituency,
            "role": self.role,
            "avatar_url": self.avatar_url,
            "riksdagen_data": self.riksdagen_data,
        }


def profile_from_person(
    person: Mapping[str, object], *, expected_intressent_id: str | None = None
) -> PoliticianProfile:
    """Validate and project a complete `personlista` person object."""

    intressent_id = _required_text(person, "intressent_id")
    if expected_intressent_id is not None and intressent_id != expected_intressent_id:
        raise ExternalServiceError(
            "Riksdagen person response id did not match the requested intressent_id"
        )

    first_name = _optional_text(person.get("tilltalsnamn"))
    surname = _optional_text(person.get("efternamn"))
    name = " ".join(part for part in (first_name, surname) if part)
    if not name:
        name = _optional_text(person.get("sorteringsnamn")) or "Okänd talare"

    avatar_url = _optional_text(person.get("bild_url_192")) or PORTRAIT_192_URL.format(
        intressent_id=intressent_id
    )
    return PoliticianProfile(
        intressent_id=intressent_id,
        name=name,
        party=_optional_text(person.get("parti")),
        constituency=_optional_text(person.get("valkrets")),
        role=_optional_text(person.get("status")),
        avatar_url=avatar_url,
        riksdagen_data=dict(person),
    )


def _required_text(person: Mapping[str, object], key: str) -> str:
    value = _optional_text(person.get(key))
    if value is None:
        raise ExternalServiceError(f"Riksdagen person response is missing {key}")
    return value


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
