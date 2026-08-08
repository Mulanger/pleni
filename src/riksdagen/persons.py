"""Recover a missing `intressent_id` from Riksdagen's person register.

`anforandelista` omits `intressent_id` for speakers who are not sitting members
— ministers drawn from outside the chamber, mostly. Those speeches then join to
no politician in C11, and from V2 onward they cannot be identity-verified at all,
so every clip of them is rejected as unverifiable. Measured over 319 clips that
is 8.5% of the catalogue lost for a metadata reason with no vision content.

The ids **are** published: `personlista` returns them, but only when asked with
`rdlstatus=samtliga`, because the default query covers sitting members only.

## Why this is deliberately strict

Matching a name to a person and then putting that person's face and byline on a
political statement is a misattribution risk, not a data-cleaning task. The two
sources do not even agree on names: `anforandelista` says *Daniel Vencu
**Velasquez** Castro* where the register says *Daniel Vencu **Öhrlund** Castro*.
Matching on the full surname fails outright, and matching loosely would
eventually attach the wrong politician to a quote.

So a match is accepted only when **all** of these hold, and otherwise the id
stays `None` and the clip is rejected:

- the first name matches a register entry's `tilltalsnamn` exactly,
- the party matches exactly,
- the **last token** of the surname matches exactly,
- and exactly one person in the register satisfies all three.

Validated against ids the official API already supplies: the rule independently
re-derives Ola Möller's `0271338654822` and Anna Tenje's `0476336341120`, and
resolves Jessica Rosencrantz to `0992420223820` — the id recorded by hand in the
March backfill notes. It refuses `TREDJE VICE TALMANNEN`, which has no person
behind it.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from src.errors import ExternalServiceError


@dataclass(frozen=True)
class PersonMatch:
    """A resolved politician and the query that found them."""

    intressent_id: str
    matched_first_name: str


class PersonDirectory:
    """Name-to-`intressent_id` resolution against `personlista`, with a cache.

    One debate repeats the same handful of speakers, and a first name like
    "Daniel" costs a request that returns sixteen people, so results are cached
    per speaker for the life of the stage run.
    """

    def __init__(self, client: Any) -> None:
        self._client = client
        self._cache: dict[tuple[str, str], PersonMatch | None] = {}

    def resolve(self, speaker_name: str, party: str | None) -> PersonMatch | None:
        """Return the matching politician, or `None` when not unambiguous."""

        if not speaker_name or not party:
            return None
        key = (speaker_name, party)
        if key not in self._cache:
            self._cache[key] = self._resolve(speaker_name, party)
        return self._cache[key]

    def _resolve(self, speaker_name: str, party: str) -> PersonMatch | None:
        tokens = strip_title_and_party(speaker_name).split()
        if len(tokens) < 2:
            return None
        surname_key = _fold(tokens[-1])
        # The first name sits somewhere before the surname and after any
        # ministerial title, so candidates are tried nearest-first: "Anna Tenje"
        # resolves in one request, "Daniel Vencu Velasquez Castro" in three.
        for candidate in reversed(tokens[:-1]):
            try:
                people = self._client.fetch_personlista(candidate)
            except ExternalServiceError:
                return None
            matches = matching_ids(
                people, first_name=candidate, party=party, surname_key=surname_key
            )
            if len(matches) == 1:
                return PersonMatch(
                    intressent_id=next(iter(matches)), matched_first_name=candidate
                )
            if len(matches) > 1:
                # Two people share a first name, a party and a surname ending.
                # Guessing between them is exactly the misattribution this
                # module exists to avoid.
                return None
        return None


def matching_ids(
    people: Sequence[Mapping[str, Any]],
    *,
    first_name: str,
    party: str,
    surname_key: str,
) -> set[str]:
    """Register entries satisfying every match condition at once."""

    found: set[str] = set()
    for person in people:
        intressent_id = str(person.get("intressent_id") or "").strip()
        surname = str(person.get("efternamn") or "").strip()
        if not intressent_id or not surname:
            continue
        if _fold(person.get("tilltalsnamn")) != _fold(first_name):
            continue
        if _fold(person.get("parti")) != _fold(party):
            continue
        if _fold(surname.split()[-1]) != surname_key:
            continue
        found.add(intressent_id)
    return found


def strip_title_and_party(speaker_name: str) -> str:
    """Drop the trailing `(M)` party marker from a Riksdagen speaker string.

    The ministerial title prefix is deliberately *not* stripped: there is no
    reliable rule separating "Äldre- och socialförsäkringsministern" from a
    multi-word given name, so the title is left in place and the first-name
    search walks backwards past it instead.
    """

    return speaker_name.split("(")[0].strip()


def _fold(value: object) -> str:
    decomposed = unicodedata.normalize("NFKD", str(value or "").casefold())
    return "".join(char for char in decomposed if not unicodedata.combining(char))
