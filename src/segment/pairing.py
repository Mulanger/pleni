"""Align official speeches to the video's speaker segments for C3.

C1 produces two lists that describe the same debate from different sides:

- `speaker_entries` — who speaks **when**, from the webb-tv page data. This is
  the timing authority and every entry corresponds to a real video segment.
- `anforanden` — who says **what**, from the official open-data record. This is
  the identity and transcript authority.

C3 used to zip them by index. That holds only while the two lists describe the
same events in the same order, and they do not always: the official record can
carry an entry with no video segment of its own, such as a chair announcement.

`HD10342` has 8 speaker entries and 9 anföranden, the extra being a
`TREDJE VICE TALMANNEN` intervention. Index pairing therefore shifted everything
after it by one, so from 1236 s onward every speech carried the **wrong
speaker, party and official text**, and the final anförande was dropped. The
official name also *overrode* the correct one from the video metadata, so the
mistake was invisible in the artifact.

Identity verification is what surfaced it: SFace reported a median similarity of
0.000 for a politician who verifies at 86-96% elsewhere in the same debate,
which is the model correctly saying the face on screen is not the person named.

So the two lists are aligned by **name** instead, walking forward in the order
the debate happened. An official entry matching no video segment is stepped over;
a video segment matching no official entry keeps the name and party the video
metadata already gave it and simply has no transcript. Neither list is
renumbered onto the other.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

from src.contracts import SpeakerEntry

#: How many trailing name tokens form the identity key. Two is enough to tell
#: "Anna Tenje" from "Åsa Eriksson" while ignoring the ministerial title that
#: only the official record carries, and it keeps working for the long surnames
#: the two sources spell differently.
NAME_KEY_TOKENS = 2

#: How many unmatched official entries may be stepped over while looking for a
#: speaker's own. Chair interventions arrive in ones and twos; a larger window
#: would let a coincidental match far ahead swallow entries that belong to later
#: speakers, which is the failure mode being fixed rather than a new tolerance.
MAX_SKIPPED_OFFICIALS = 4


def pair_official_speeches(
    speakers: Sequence[SpeakerEntry],
    official_speeches: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any] | None]:
    """Return the official entry for each speaker segment, or `None`.

    The result is positionally parallel to `speakers`, so callers keep using the
    video metadata's timing and only take identity and text from the match.
    """

    if not speakers:
        return []
    if not official_speeches:
        return [None] * len(speakers)

    speaker_keys = [name_key(entry.name) for entry in speakers]
    official_keys = [
        name_key(str(entry.get("speaker_name") or entry.get("talare") or ""))
        for entry in official_speeches
    ]

    paired: list[Mapping[str, Any] | None] = [None] * len(speakers)
    cursor = 0
    for index, key in enumerate(speaker_keys):
        if not key:
            continue
        found = _next_match(official_keys, key, start=cursor)
        if found is None:
            # No official entry for this segment within reach. The caller keeps
            # the video metadata's name and gets no transcript, which is the
            # safe degradation: silence, not somebody else's words.
            continue
        paired[index] = official_speeches[found]
        cursor = found + 1
    return paired


def _next_match(
    official_keys: Sequence[tuple[str, ...]], key: tuple[str, ...], *, start: int
) -> int | None:
    """First official at or after `start` naming this speaker, skipping strays.

    A forward walk rather than `difflib`. Sequence alignment looks like the right
    tool until you feed it an interpellation, which is the same two people
    alternating: `Tenje, Eriksson, Tenje, Eriksson, Tenje`. Several equally long
    matching blocks exist, `SequenceMatcher` takes the leftmost, and on the real
    `HD10342` shape it chose one that silently *deleted* two speakers. Walking
    forward keeps the order the debate actually happened in.
    """

    limit = min(len(official_keys), start + MAX_SKIPPED_OFFICIALS + 1)
    for offset in range(start, limit):
        if official_keys[offset] == key:
            return offset
    return None


def name_key(name: str) -> tuple[str, ...]:
    """A comparable identity key for a Riksdagen speaker string.

    The two sources spell the same person differently: the video metadata says
    "Anna Tenje" where the official record says "Äldre- och
    socialförsäkringsministern Anna Tenje (M)". Taking the trailing tokens after
    dropping the party marker gives both the same key without needing a rule for
    where a Swedish ministerial title ends and a given name begins.
    """

    tokens = [_fold(token) for token in name.split("(")[0].split() if token.strip()]
    if not tokens:
        return ()
    return tuple(tokens[-NAME_KEY_TOKENS:])


def _fold(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    return "".join(char for char in decomposed if not unicodedata.combining(char))
