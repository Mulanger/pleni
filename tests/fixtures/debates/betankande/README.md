# Betänkande fixture

`master.mp4` is a 3-minute fixture trimmed from `hd01sfu35`, "En ny
mottagandelag" on 2026-06-03. The span starts at 00:08:20 in the full debate and
crosses the speaker change at 00:08:49.

`api_response.json` is the captured current webb-tv Next.js page-data JSON.
`official_speeches_response.json` is filtered official anförandelista data
enriched from each speech's XML detail response. `00_source.json` is the C1
source artifact containing those official speeches.

This fixture is for C2/C3-era tests that need a structurally typical betänkande
debate with longer speeches than the `debates/short` frågestund metadata
fixture.
