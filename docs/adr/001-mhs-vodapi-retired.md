# ADR 001: Retired mhs-vodapi Media Endpoint

Date: 2026-08-01

## Status

Accepted

## Context

C1 verified the architecture warning in A1 against a live 2026 Riksdagen webb-tv
document. The historical endpoint
`https://data.riksdagen.se/api/mhs-vodapi?<dokid>` now returns HTTP 404, so it
cannot be used as the source of speaker arrays or media URLs.

Riksdagen's current open-data support documentation says the open data offering
contains APIs, datasets, and reports, and that most data used by riksdagen.se is
available through open data. The documented API areas checked in C2 include
documents and official anföranden, but no documented replacement for the retired
`mhs-vodapi` media endpoint was found in the open-data user-support pages or
their searchable content.

The current Riksdagen webb-tv page embeds Next.js `__NEXT_DATA__` JSON containing
`contentApiData.video`, `contentApiData.speakers`, and media links such as
`downloadUrl`.

## Decision

The pipeline treats `mhs-vodapi` as retired and no longer depends on it.

C1 currently depends on the embedded Next.js page-data shape for webb-tv media
metadata and speaker timings. C2 consumes only the C1 `00_source.json` artifact
and does not scrape or reinterpret Riksdagen pages itself.

If a documented open-data media endpoint is later found, C1 should be revised in
its own chunk to use that endpoint and keep emitting the same C0 contracts.

## Consequences

The current path unblocks C2 and later media work without designing an
undocumented API workaround inside C2.

The remaining risk is that Next.js page-data is a website implementation detail,
not a documented open-data API. The C1 live test is the early-warning mechanism
for schema drift.

Official anföranden remain better served by the documented open-data anföranden
API than by page-data speech text. C3 should not assume page-data `speechNumber`
is an official `anforande_id`.

## Contracts Impact

No `src/contracts.py` changes.

