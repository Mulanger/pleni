# Search V2 — approved implementation

Owner request: implement the six-stage plan from 2026-09-09 end to end. This
supersedes UI16/OPT restrictions on date-only search, automatic date broadening,
the old transport shape and stopping after one chunk. Video stages and
`src/contracts.py` remain outside this scope.

## Baseline

Base: `b647ad8`, current `origin/main`. The owner's main working directory is an
older, dirty pipeline checkout and is not an implementation target.

Production read-only audit on 2026-09-09: 11,646 eligible clips and keyword
documents; 2,920 current semantic documents; 8,726 pending documents. Indexing
is disabled, with 8,735 queued messages and zero failed documents. Coverage:
2023 2,496/0 semantic; 2024 2,878/0; 2025 2,977/0; 2026 3,295/2,920.
`2023` publicly returns zero; `elsparkcykel` returns two versus six for
`elsparkcyklar`. Known missed id:
`HD10552_cabb9ba6-5d6e-f111-bf27-6805cafeabf9_c02`.

## Delivery

1. S1: scope, baseline and reproducible regressions.
2. S2: recover indexing after cost estimate; per-year health and alerting.
3. S3: compatible v2 endpoint, explicit filters, sort, protected continuation,
   date-only search and no automatic broadening.
4. S4: additive full-text/trigram retrieval, catalogue-derived word forms,
   source-title evidence, exact-match priority and semantic admission.
5. S5: isolated search UI/state, suggestions, real pagination, responsive filters.
6. S6: real SQL/browser acceptance, full gates, backend-first release and rollback.

## Invariants and acceptance

Published clips only; anonymous mobile/desktop; debate date and historical
party; suggestions on typing, clips on submit; explicit filter overrides win;
quotes stay literal; person selection preserves topic/date; removing a facet
does not reintroduce its words. Year-only defaults to newest, topic to relevance;
newest/oldest also available. No 60-result catalogue ceiling. Back restores
results and position. Source-only matches are identified as debate context.
Queries/vectors never persist in logs, URLs, browser storage, analytics or user
profiles. Keep the embedding model/version and existing media ownership.

Year traversal must have no omissions/duplicates on a stable catalogue. The
known scooter clip must appear in the top five for singular/plural. Exact
titles/quotes, spelling, descriptions, filters, negatives, removal and stale
responses need regression coverage. Every eligible document must be current or
explicitly excepted. Targets: suggestions <300ms after debounce; submitted p95
<1.5s with cold/errors retained; publish-to-semantic-current p95 <120s in normal
operation. Report unobserved SLO/device coverage honestly. No human grading task.

## Status

Implementation and functional acceptance complete, 2026-09-10. Backend migrations
033–038 and the separate `clip-search-v2` endpoint are deployed. Frontend release
status is recorded in `PROGRESS.md`.

All 11,646 eligible documents have current keyword and semantic indexes, with
no pending/failed documents or health alerts. The bounded recovery consumed
2,089,519 tokens (about USD 0.272), plus the small smoke run and normal cron work;
the advance estimate was USD 0.297. No video was regenerated. A five-minute health
job retains aggregate coverage samples and emits database warning alerts. Fresh
publication dispatch checks the priority queue every 15 seconds; normal-operation
publish-to-current p95 has not yet been observed.

## Acceptance evidence and remaining limits

The rollback-only catalogue test traversed every year without duplicates or
missing clips: 2023 2,496; 2024 2,878; 2025 2,977; 2026 3,295. Known titles from
all four years, combined filters, unpublishing between pages, immediate keyword
publication, idempotent repair and denied anonymous direct RPC access passed.
Quoted text, explicit overrides, ambiguity, cursor tampering/expiry, provider
failure/budget fallback and rendering have automated behavior regressions.
Filtered iterative HNSW returned 20/20 candidates within the exact top-20
distance cutoff in each year (80/80 total, ties allowed). This is a bounded
catalogue regression, not a universal approximate-index recall guarantee.

The anonymous public comparison uses the same fully indexed catalogue:

| Fixture | V1 | V2 |
|---|---|---|
| 2023 | 0 | 20 per page, real continuation |
| elsparkcykel | 2, target absent | 18, target rank 3 |
| elsparkcyklar | 6, target rank 1 | 18, target rank 1 |
| elsparcykel / el sparkcyklar | not compared | target rank 2 for each |
| trafiksäkerhet för små elektriska hyrfordon | not compared | 6, target rank 2 |
| Two frozen nonsense queries | not compared | 0 for both, hybrid mode |

The public engineering sample includes 24 V2 searches, 9 suggestions and 3 V1
comparisons, measured end to end from the owner's Windows machine via the curl
transport. V2 p95 was **3,953 ms** and suggestions **891 ms** (before the UI's
200-ms debounce). Maximum V2 search was 6,484 ms. The first year request took
1,500 ms; warm examples reached 671 ms for a year and 1,063 ms for filtered text.
Two initial topic requests returned working keyword fallback after the embedding
deadline; later hybrid calls passed. All final sample requests returned HTTP 200.
Earlier pre-optimization topic requests returned 503 because of SQL timeouts;
those failures are not hidden as successful measurements. Cold starts were not
controlled or isolated. These small samples **do not meet the latency targets**
and are not a load test. Follow-up performance work remains explicitly open.

Desktop (1280px) and mobile (390×844) were checked in the in-app browser against
the real service. Rows, paging, filters and clip/back navigation work; returning
restores rows and scroll. Playback still mounts at most four videos; search
mounts none. No physical-device test is claimed.

## Operations and rollback

Run operator scripts from the directory containing the existing server `.env`;
do not copy it into `web/` or the clean worktree. Scripts never print credentials.

- `scripts/release_search_v2.py health`: per-year coverage and actionable alerts.
- `scripts/verify_search_v2_database.py`: rollback-only catalogue regressions;
  only rehearses migrations not already recorded in the ledger.
- `scripts/verify_search_v2_database.py --vectors-only`: filtered HNSW versus
  exact-distance regression on each catalogue year.
- `scripts/check_search_v2_public.py`: anonymous fixture comparison and latency
  sample, written to ignored `test_outputs/search-v2-public.json`.
- `scripts/recover_search_index.py --help`: bounded, cost-limited recovery.

Recovery of individual stale documents uses the service-only
`repair_search_index(text[])` RPC, at most 200 ids per call; it is idempotent.
Health warning codes are in Supabase database logs and aggregate health samples;
no email/Slack delivery has been configured.

Rollback the frontend by reverting the Search V2 release commit and rebuilding.
The V1 endpoint and contracts remain deployed for older PWA clients. Prefer
leaving additive schemas/indexes in place. If removing V2 database objects is
necessary, first remove all V2 clients and then apply down migrations in reverse
order (038 to 033), preserving the migration ledger deliberately. The old minute
worker dispatcher remains available. Never disable indexing as a frontend
rollback: that would recreate the original catalogue gap.
