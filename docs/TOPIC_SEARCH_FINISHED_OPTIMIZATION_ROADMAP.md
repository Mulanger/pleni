# Pleni Topic Search — Finished Optimization Roadmap

**Status:** revised plan. No production behavior is authorized by this document.
**Audience:** implementation agents and the product owner.
**Baseline date:** 2026-08-26.
**Primary dependency:** `docs/TOPIC_SEARCH_IMPLEMENTATION_PLAN.md` through UI16.15.

## Technical summary

Pleni's public topic search is usable today, but it is not yet evidence-backed
enough to call finished. The current production catalogue has complete search
coverage: 3,188/3,188 eligible clips have keyword documents, 3,188/3,188 have
current semantic documents, 4,160 current chunks exist, and no semantic
exceptions are recorded. Exact structured filters, semantic retrieval, keyword
fallback, public anonymous access, loading/error states and automatic date
broadening are deployed.

Four engineering gaps remain:

1. query-level semantic admission can still allow weak context-only results far
   down a valid result list;
2. the measured submitted-search p95 is 2,027 ms, above the existing 1,500 ms
   target;
3. future-index lag, provider region/retention and final physical-device
   acceptance are not closed with production evidence.

This roadmap closes those gaps without adding a second search vendor, storing
raw queries, creating a hand-written topic whitelist, or coupling search to one
historical backfill. The finished design remains Supabase/Postgres hybrid search
plus one transient OpenAI query embedding. Future clips enter through the
existing publish/index lifecycle.

## What “finished and optimized” means

The feature is finished only when every required engineering gate below passes.
Missing human evidence must never be replaced with an AI grade, but the absence
of an optional human study is not an engineering gate or owner task.

| Area | Current evidence | Required finish gate |
|---|---|---|
| Searchable catalogue | 3,188/3,188 keyword and semantic current | 100% keyword coverage and semantic current-or-reviewed-exception coverage |
| Regression safety | 36 captured evaluation queries exist, but are not human-judged | ten committed smoke searches and structured-filter fixtures pass automatically |
| Hybrid quality | preliminary examples pass | candidate-level admission removes known weak context filler while descriptive semantic cases remain non-empty |
| First results | preliminary examples pass | known positive searches retain results and exact/date behavior remains unchanged |
| Weak filler | known long-tail failure class | semantic-only candidates pass their own threshold; a strong candidate cannot admit weaker candidates |
| Negative queries | 2/2 deployed probes empty | every frozen negative remains empty in offline and public live capture |
| Historical truth | filters use debate date | no result is fabricated for absent catalogue years; date broadening remains explicit and truthful |
| Submitted latency | p95 2,027 ms over 30 calls | p95 <1,500 ms over 30 serial production calls including one cold call, or an explicit owner-approved SLO revision |
| Future indexing | no valid lag sample | p95 publish-to-semantic-current lag <120 s over at least 20 newly published clips while the worker is operational |
| Security/privacy | privilege matrix passes | matrix remains green; raw query/address never persists or appears in logs; actual provider region/retention is recorded |
| Rollback/device | procedures exist, final evidence incomplete | rollback rehearsed and Android acceptance completed on the production bundle |

Definitions:

- A **smoke search** is an example phrase run through the real search path after
  a code change. It checks explicit behavior; it does not teach the model.
- A **known positive** has at least one already verified catalogue result.
- A **known negative** is intentionally absent from the indexed catalogue and
  must remain empty.
- **Candidate-level admission** means each semantic-only candidate must pass its
  own minimum evidence threshold. A strong result elsewhere cannot admit a weak
  result.
- Human grades, if voluntarily supplied later, are evidence only; without a
  human denominator, nDCG/Precision@10 claims must remain null.
- Latency uses nearest-rank p95, matching the existing evaluator.
- Historical dates always mean `sources.debate_date`, never clip publication or
  indexing time.

## Immutable product and architecture rules

Every optimization agent must preserve these rules:

- Search stays available anonymously in the normal Search tab.
- Supabase remains the search database. No MongoDB Atlas Search, hosted vector
  database or additional SaaS search service is introduced.
- The browser receives only the Supabase publishable key. Service keys, provider
  keys and management tokens remain server/local only.
- Raw queries and client addresses are transient. Do not store them in Postgres,
  logs, analytics, localStorage, sessionStorage, URLs or service-worker caches.
- Search health logs may contain status, mode, result-count bucket, booleans,
  version identifiers and phase durations only.
- Do not create a hard-coded list of approved search topics or aliases. The
  committed queries are regression evidence, not a whitelist, training set or
  production input.
- The owner is not responsible for grading the 36-query fixture, opening the
  385-row TSV or grading future backfill clips. Missing human grades are never a
  production or implementation blocker.
- One topic query makes at most one OpenAI embedding request. Date broadening,
  ranking retries and fallback reuse that vector.
- Person, party, verified-event and date constraints are applied before
  retrieval. Party-at-speech and speaker-at-speech remain historical facts.
- Date-only searches never become an unbounded catalogue feed.
- Result order is owned by the server and handed unchanged to the existing
  vertical feed.
- Scores and internal confidence thresholds remain private; the public response
  exposes human-readable explanations, not ranking internals.
- Existing migrations are immutable. Ranking changes use an additive migration
  and an additive RPC version with a complete down path.
- `src/contracts.py`, video stages, Bunny media objects, player scheduling and
  service-worker media exclusions are outside this roadmap.
- A model/index-version change requires a shadow index, measured cost, explicit
  owner approval for paid backfill and an atomic version switch. Never overwrite
  the only current index in place.

## Delivery sequence

```text
OPT0 optional review tooling (already implemented locally; non-blocking)
    ↓
OPT1 lean automatic smoke baseline
    ↓
OPT2 ranking v3 and no-filler cutoff
    ↓
OPT3 intent/filter hardening
    ↓
OPT4 latency and provider/index decision
    ↓
OPT5 future-index, operations and final release evidence
```

One agent owns one chunk. An agent stops at its chunk boundary, appends an exact
handoff to `PROGRESS.md`, and does not begin the next chunk even when it finishes
early. Production deploys, provider configuration changes and paid backfills
require explicit owner authority at the time they are performed.

## OPT0 — Optional evaluator and review tooling

**Status:** implemented in the owner's primary local working tree on 2026-08-26;
not yet assumed to be integrated into `main`. **Size:** complete/non-blocking.

### Objective

The evaluator can export/import human grades and calculate judged relevance
metrics if Pleni later chooses to run a formal study. It changes no production
behavior and is not a dependency for the next optimization chunk.

The 36 phrases and 385 pooled rows are historical internal fixtures. They do not
train search, control ranking or create work for the owner. Existing grades stay
empty unless a separate explicit task voluntarily performs a formal review.

### File scope

May modify:

- `scripts/evaluate_topic_search.py`;
- `tests/fixtures/search/judgments.json` schema metadata, without inventing
  grades;
- `tests/fixtures/search/expected.json` thresholds;
- `tests/unit/test_topic_search_evaluation.py`;
- focused search documentation and `PROGRESS.md`.

Must not modify:

- Edge Functions, migrations, search ranking constants, frontend code or the
  captured rankings in `documents.json`.

### Implementation

1. Keep the stdlib-only `review-export` and optional `review-import` commands
   available for a future owner-authorized relevance study. They may contain
   captured public titles/transcripts, but they must never receive live user
   queries, credentials or client identifiers.
2. Keep the existing grade validation and denominator-safe metrics. They are
   diagnostic utilities only: when no human grades exist, nDCG, Precision@10
   and grade-based tail metrics remain explicitly unavailable.
3. Keep these full-list audit queries as safe committed fixtures for automated
   capture checks; do not require a human to grade them:
   - `elsparkcykel`;
   - `elsparkcykel 30 mars`;
   - `elsparkcykel 22 juni`;
   - `trafiksäkerhet för små elektriska hyrfordon`;
   - `barnfattigdom`;
   - `äldreomsorg bemanning`;
   - `havsbaserad vindkraft i Kattegatt`;
   - `hur ska gängkriminaliteten stoppas`;
   - `bananministeriet på månen`;
   - `kvantdatorer på varje förskola`.
4. `test_outputs/` remains ignored. Re-exporting the same fixtures must be
   byte-identical.

### Acceptance

- Offline evaluator tests cover export determinism, optional import validation,
  incomplete pools, duplicate ids, invalid grades and every denominator-safe
  metric.
- Re-exporting the same fixtures is byte-identical.
- Running normal `evaluate` without human import still refuses to manufacture
  nDCG/precision denominators.
- No production file changes and no OpenAI call occurs.

### Required handoff

Record the exact export command, output path and number of pooled rows available
for an optional study. Confirm that no grade was generated by an agent and that
the owner has no required review action.

## OPT1 — Lean automatic smoke baseline

**Status:** DONE 2026-08-26. **Size:** small. **Depends on:** deployed UI16.15,
not on human review or OPT0's optional grade importer.

### Objective

Create a small reproducible before/after snapshot that protects known product
behavior while later agents change ranking. This is ordinary regression testing,
not model training.

### File scope

May modify:

- `scripts/evaluate_topic_search.py` and focused offline fixtures;
- `tests/unit/test_topic_search_evaluation.py`;
- `docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`;
- this roadmap and `PROGRESS.md`.

Must not modify production ranking, Edge Functions, migrations, frontend code,
embedding model/index or public contracts.

### Ten smoke searches

Use exactly this small committed set for the baseline:

1. `elsparkcykel`;
2. `elsparkcykel 30 mars`;
3. `elsparkcykel 22 juni`;
4. `trafiksäkerhet för små elektriska hyrfordon`;
5. `barnfattigdom`;
6. `äldreomsorg bemanning`;
7. `havsbaserad vindkraft i Kattegatt`;
8. `hur ska gängkriminaliteten stoppas`;
9. `bananministeriet på månen`;
10. `kvantdatorer på varje förskola`.

These phrases are safe committed fixtures. They are never derived from logged
user searches and are never consulted by the live endpoint.

### Implementation

1. Capture current server order, result count, clip ids, dates and structured
   interpretation for the ten phrases without credentials, addresses or scores.
2. Encode only machine-checkable expectations:
   - the first eight positive cases preserve their known non-empty/structured
     behavior;
   - both negative cases remain empty;
   - `22 juni` stays exact with no broadening notice;
   - `30 mars` broadens and contains no row from the excluded date;
   - known March elflyg false-positive ids are forbidden scooter examples once
     identified from the existing capture.
3. Save a compact top-five title/excerpt report under `test_outputs/` for agent
   inspection. Label it as engineering smoke evidence, not human truth.
4. Do not add grades, nDCG targets, tuning/holdout splits or an owner review
   spreadsheet.

### Acceptance

- The same offline inputs produce byte-identical smoke output.
- All structured/date/negative expectations pass.
- The baseline records search/index/ranking versions and capture date.
- The owner has no action item. OPT2 may begin after the engineering handoff.

### Delivered 2026-08-26

**Status:** DONE. Implemented as the `smoke` command in
`scripts/evaluate_topic_search.py`, with `tests/fixtures/search/smoke.json`,
regression tests in `tests/unit/test_topic_search_evaluation.py` and the record
in `docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`.

Result on the frozen 2026-08-25 capture: **7 pass, 0 fail, 3 blocked** of 10.
Re-running over the same fixtures is byte-identical. No ranking, threshold, Edge
Function, migration, frontend, embedding model/index or public contract changed;
no OpenAI call, live call, deploy or dependency was added; no grade was created
and the owner has no action item.

Seven phrases bind to real captured runs. `elsparkcykel`, `elsparkcykel 30 mars`
and `elsparkcykel 22 juni` are reported as `blocked_needs_capture`: the frozen
capture holds no run for those exact phrases and records no debate date,
interpretation facet or date-broadening metadata for any phrase. Their
expectations are encoded and unit-tested against synthetic captures, so they
start checking automatically once a capture carries that metadata. The three
known elflyg false positives were identified from the existing capture and are
recorded as forbidden scooter examples and as a known open defect owned by OPT2.

## OPT2 — Ranking v3 with candidate-level admission

**Status:** DEPLOYED 2026-08-26 after explicit owner approval.
**Size:** large. **Depends on:** OPT1.

### Objective

Eliminate weak semantic filler while preserving descriptive queries, Swedish
compounds and exact matches. Results may be shorter than the requested limit;
the system never fills a quota with low-confidence clips.

### File scope

May modify:

- evaluator logic and focused fixtures/tests;
- `supabase/functions/_shared/search/ranking.ts`;
- one new additive migration pair, using `029` only if it is still the next
  unused migration number;
- `supabase/functions/clip-search/index.ts`, Edge search tests and live RPC
  tests;
- search evidence docs and `PROGRESS.md`.

Must not modify the public `clip-search-v1` response shape, embedding dimensions,
index contents, frontend result ordering or prior migrations 022–028.

### Ranking design

Keep the current query-level semantic safety gate:

- a keyword anchor exists, or
- the query's best cosine similarity is at least 0.53, or
- the query's best Swedish lexical coverage is at least 0.67.

Add candidate-level admission after that gate:

- every keyword-matched candidate remains eligible;
- a semantic-only candidate is eligible only when its own similarity is at
  least the selected candidate threshold or its own lexical coverage is at
  least the selected lexical threshold;
- a strong candidate elsewhere in the query must never admit a weaker candidate;
- structured filters remain inside the `eligible` CTE before keyword/vector
  retrieval;
- no recency boost is added; date remains only a filter and deterministic tie
  break;
- scores remain absent from the public JSON.

### Deterministic conservative selection

Evaluate the existing threshold grid offline against the ten smoke searches.
Because there is no human-judged denominator, do not claim that the numerically
highest configuration is “best.” Select a conservative configuration using only
these gates:

- candidate similarity threshold: `0.40`, `0.45`, `0.48`, `0.50`, `0.53`;
- candidate lexical coverage threshold: `0.34`, `0.50`, `0.67`;
- keyword RRF weight: `1.5`, `2.0`;
- semantic RRF weight: `0.75`, `1.0`;
- RRF smoothing `k`: `40`, `50`, `60`.

Select exactly one configuration using this order:

1. discard any configuration that returns a result for either known negative;
2. discard any configuration that fails an exact/date/structured smoke case;
3. require each positive smoke search to retain at least
   `min(5, baseline result count)` results, except where the bounded contract
   already returns fewer;
4. require the descriptive semantic-only scooter search to remain non-empty;
5. require the known elflyg false-positive ids to disappear from scooter
   searches;
6. preserve baseline keyword-matched top results;
7. among survivors, prefer fewer semantic-only tail candidates, then the higher
   candidate similarity threshold, then the existing deterministic id.

If no configuration passes, stop and document the exact conflicting examples.
Do not ask the owner to grade 385 rows and do not add aliases or training data.

### Database and release shape

1. Create `public.search_clip_candidates_v3` with the same arguments and return
   envelope as v2. Keep v2 deployed for rollback.
2. Hard-code only the selected evaluated constants in v3 and mirror them in
   `ranking.ts`; migration tests must fail on drift.
3. Update the evaluator's hybrid replay to exactly match v3 SQL.
4. Switch the Edge dependency from v2 to v3 and bump `SEARCH_RANKING_VERSION` to
   `pleni-search-v3` only after offline gates pass.
5. The down migration revokes/drops v3 only. Operational rollback redeploys the
   previous Edge commit, which calls v2.
6. Date broadening continues to fetch at most 60 candidates, exclude the
   original inclusive date range and preserve the surviving order.

### Acceptance

- Unit/migration/Edge tests cover candidate-specific admission, no quota fill,
  deterministic ties, exact filters, keyword-only fallback, semantic outage,
  date broadening and malformed envelopes.
- The original `elsparkcykel 30 mars` elflyg rows do not appear in scooter
  searches, independent of the date-exclusion guard.
- The ten smoke searches pass before/after comparison with no structured,
  negative or known-positive regression.
- A compact top-five before/after report is included in the handoff and is
  labelled engineering evidence, not human-validated relevance evidence.
- Deploy only with owner authority, then capture the exact live version and
  rollback command in `PROGRESS.md`.

### Delivered 2026-08-26

**Status:** DONE. The implementation described below was first completed and
tested offline, then released after explicit owner approval; see the production
record at the end of this chunk.

Implemented as the additive migration pair `029_search_candidate_admission`,
candidate-admission constants and a mirrored predicate in
`supabase/functions/_shared/search/ranking.ts`, the v3 RPC switch in
`supabase/functions/clip-search/index.ts`, the `admission-grid` command in
`scripts/evaluate_topic_search.py`, and tests in
`tests/unit/test_topic_search_evaluation.py`,
`supabase/functions/tests/clip-search.test.ts` and
`tests/live/test_topic_search_rpc.py`.

**Selected configuration.** `sim0.50-lex0.67-kw1.50-sem1.00-k50`: candidate
similarity `0.50`, candidate lexical coverage `0.67`, with the deployed fusion
weights `1.5`/`1.0` and `k = 50` unchanged. The v2 query-level gate (`0.53`
similarity, `0.67` coverage, or a keyword anchor) is kept, not replaced.

**How the grid resolved.** All 180 configurations were replayed offline against
the frozen 2026-08-25 capture. No configuration is called best and no nDCG or
precision was produced; only observable membership was used.

| Candidate similarity | Outcome |
|---|---|
| `0.40` | discarded: the three elflyg rows stay in the scooter result (36 configurations) |
| `0.45`, `0.48`, `0.50` | 108 survivors across the three lexical values and twelve fusion variants |
| `0.53` | discarded: the descriptive scooter search falls to 3 results, below `min(5, 10)` (36 configurations) |

Among survivors, rule 7 selects the fewest semantic-only tail candidates (23,
a unique minimum), then the higher candidate similarity. The three fusion axes
change result order rather than admission, and the frozen capture preserves only
the top-N that the deployed weights produced, so they cannot be separated
offline and resolve to the deployed constants.

**Measured effect on the frozen capture.** Engineering evidence, not
human-validated relevance evidence.

| Search | Before | After | Dropped |
|---|---|---|---|
| `elsparkcyklar` (forbidden-example source, `q01`) | 10 | 6 | 3 elflyg rows plus 1 weak context row |
| `trafiksäkerhet för små elektriska hyrfordon` (`s04`) | 10 | 6 | 4 tail context rows |
| `barnfattigdom` (`s05`) | 10 | 10 | none |
| `äldreomsorg bemanning` (`s06`) | 10 | 10 | none |
| `havsbaserad vindkraft i Kattegatt` (`s07`) | 10 | 6 | 4 tail context rows |
| `hur ska gängkriminaliteten stoppas` (`s08`) | 10 | 10 | none |
| `bananministeriet på månen` (`s09`) | 0 | 0 | none |
| `kvantdatorer på varje förskola` (`s10`) | 0 | 0 | none |

`HD10398_27_c02`, `HD10401_27_c02` and `HD10406_27_c02` no longer appear in the
scooter result, independent of the date-exclusion guard: they are removed by
their own similarity (`0.416605`, below `0.50`) and coverage (`0`, below `0.67`).
Every top-five position is byte-identical before and after in all eight captured
searches: only tail candidates were removed, and no keyword-matched candidate
was dropped anywhere in the grid.

**Offline capture limitation.** The original smoke artifact still marks
`elsparkcykel`, `elsparkcykel 30 mars` and `elsparkcykel 22 juni` as
`blocked_needs_capture`; OPT2 implementation did not rewrite historical capture
evidence. The later owner-authorised production release tested those three
behaviours directly and recorded the results below.

**Not changed:** the public `clip-search-v1` response shape, embedding
dimensions, index contents, frontend code, `src/contracts.py`, migrations
022-028, the 36-query fixture and `judgments.json` (still 0/36 and not to be
graded), user query logs, secrets and provider settings.

### Production record 2026-08-26

Migration 029 is applied. `clip-search` Function version 7 was deployed from
commit `af8238a` with bundle SHA-256
`4c2c2046550777188e3893a410301add7c519eb094cfebf3f1d2e014ce44aee0` and
returns `searchVersion=pleni-search-v3`.

Public live acceptance passed for the plain scooter query, empty 30 March date
broadening, exact 22 June filtering, the descriptive scooter query and both
negative probes. The three known elflyg ids were absent. The exact counts and
timings are recorded in `PROGRESS.md`.

Operational rollback is redeploying `clip-search` from commit `16a4887`, which
calls v2. Keep 029 applied during an incident; v2 remains callable and no SQL
rollback is required. The down migration drops v3 alone if later schema cleanup
is separately reviewed.


## OPT3 — Intent and filter correctness hardening

**Status:** PLANNED. **Size:** medium. **Depends on:** OPT2 (deployed).

### Objective

Close predictable query-language gaps without turning the interpreter into a
topic dictionary or letting the browser guess what the server meant.

### File scope

May modify the shared interpreter/types, focused Edge fixtures/tests,
`web/src/App.tsx`, `web/src/search/*`, focused frontend tests and documentation.
The mirrored public contract may change only if new server-provided metadata is
strictly required; both copies and all fixtures must change byte-identically.

### Required behavior

- Preserve existing exact `30 mars`, explicit `30 mars 2026`, year, year-range
  and `från/sedan <year>` behavior.
- Add explicit Swedish month-and-year ranges: `mars 2026` and `i mars 2026`
  become `2026-03-01` through `2026-03-31` with a visible removable date facet.
- A bare month without a year remains topic text. This avoids interpreting
  `mars` as a date when the user may mean the planet or a named subject.
- Invalid calendar phrases remain searchable topic text.
- Person/party fuzzy matching keeps the existing minimum-score and margin rule;
  never guess between two close people.
- Do not add generic topic spell-correction or fixed synonym aliases. Swedish
  stemming handles lexical forms and embeddings handle semantic paraphrases;
  add a normalization rule only when a committed failing fixture proves a
  deterministic language defect.
- `Tolkat som` must exactly reflect enforced server filters. Removing a facet
  returns those words to the topic where applicable and triggers a new request.
- Empty, keyword-fallback and date-broadening notices remain mutually truthful.
- Date-only and month-only-without-topic searches remain bounded and empty.

### Acceptance query matrix

- `elsparkcykel`, `elsparkcyklar` and the descriptive small electric rental
  vehicle query return relevant scooter clips.
- `elsparkcykel 22 juni` is exact with no broadening notice.
- `elsparkcykel 30 mars` broadens with no 30 March rows.
- `elsparkcykel mars 2026` searches only March 2026 first and broadens only when
  that constrained result is empty.
- `mars` remains a topic.
- Person + party + topic + year retains all identity filters.
- Verified event + year uses exact source ids and no provider call when no topic
  remains.
- Ambiguous person/event choices never silently select an entity.

Run mirrored contract fixtures, interpreter tests, Edge tests, frontend tests,
TypeScript, production build and PWA verification.

## OPT4 — Latency, cost and embedding/index decision

**Status:** PLANNED. **Size:** large. **Depends on:** OPT2 and OPT3.

### Objective

Meet the latency target without buying a new service, weakening relevance,
logging queries or making duplicate provider calls.

### Measurement first

1. Extend the safe evaluator/benchmark to issue 30 serial public requests from
   the ten committed smoke phrases, approximately seven seconds apart so it respects
   real rate limits. Include one cold request and do not discard failures.
2. Report p50/p95/max for total request, preflight, provider-budget, embedding
   and retrieval phases. Do not print or persist credentials, addresses or
   non-fixture query text.
3. Run the same sample three times on separate days before changing architecture
   so one provider outlier does not determine the design.

### Optimization order

Apply these in order and stop when the gate passes:

1. Remove redundant server/database work proven by phase timings. Preserve
   request and provider budgets; do not call OpenAI before rate-limit approval.
2. Confirm Function/database regional alignment and configure the approved
   OpenAI EU endpoint only after the actual project supports it and retention
   controls are recorded. Endpoint changes require live quality and latency
   recapture.
3. Compare the current `text-embedding-3-large` 1024-dimensional index with a
   shadow `text-embedding-3-small` 1024-dimensional index. Do not replace the
   current index in place.

The smaller model may be selected only when:

- every automatic structured, positive, negative and no-filler smoke gate passes;
- top-ten result-set overlap against the accepted large-model baseline is at
  least 80% for positive phrases, unless every documented difference is a known
  false-positive removal;
- the descriptive semantic-only query remains non-empty;
- production p95 improves by at least 20% or falls below 1,500 ms; and
- projected full reindex token count/cost is written down and the owner approves
  the paid shadow backfill.

Otherwise retain the large model. If measured p95 still exceeds 1,500 ms after
safe server optimizations, stop and request an explicit owner SLO revision. An
agent must not force keyword-only mode or shorten the provider timeout merely to
manufacture a pass.

### Forbidden shortcuts

- no persistent raw-query or query-embedding cache;
- no browser embedding call;
- no second provider call for fallback/date broadening;
- no silent quality fallback to improve latency metrics;
- no paid model/index backfill without approval;
- no unbounded retries.

### Acceptance

- All automatic smoke and contract gates are unchanged or improved.
- Thirty-call p95 is below the accepted SLO with all failures included.
- Provider timeout, quota, malformed response and semantic-index-unavailable
  paths still return honest keyword behavior.
- Actual embedding tokens and projected monthly cost are reported without
  logging user query text.

## OPT5 — Future backfill resilience, privacy-safe operations and closeout

**Status:** PLANNED. **Size:** large. **Depends on:** OPT0–OPT4.

### Objective

Prove the optimized search remains correct as new and historical clips arrive,
and leave operators with measurable health and a rehearsed rollback.

### Index and backfill behavior

- Keep one keyword document per eligible published clip and deterministic
  semantic passages versioned by source hash and index version.
- C11 publication continues to enqueue indexing indirectly through database
  lifecycle triggers; no pipeline stage calls the search worker directly.
- A clip becomes keyword-searchable before semantic completion. While semantic
  coverage is incomplete, public search reports keyword fallback honestly.
- Queue claim/ack/retry remains idempotent. Reprocessing the same source hash and
  index version creates no duplicate chunks or provider work.
- New publications take priority over historical search-index backfill so a
  large backfill cannot starve fresh clips.
- The existing HNSW half-vector index remains the semantic access path. Before
  catalogue size exceeds 10,000 and again at 50,000 clips, capture read-only
  query plans/latency and tune database indexes only from measured evidence.
- Historical video backfill itself remains owned by the pipeline/runbook. This
  roadmap guarantees that every resulting published row joins the same search
  lifecycle; it does not create a second search ingestion path.

### Future-index lag evidence

Measure at least 20 real newly published clips while workers are operational:

- start: committed `published_at`/catalogue eligibility time;
- end: document is keyword-current and semantic-current for the active version
  with at least one valid chunk when text exists;
- record only clip id, version, state timestamps and durations, never query text;
- target: semantic-current p95 <120 seconds and no unreviewed failures.

If the local workstation being asleep prevents the target, report that operating
condition honestly. Do not relabel offline time as search latency; either change
the worker operating model with explicit scope/authority or obtain an owner-
approved availability expectation.

### Privacy-safe observability

The server log summary may add only:

- HTTP status and search mode;
- result-count bucket (`0`, `1–5`, `6–10`, `11–20`, `21–60`);
- booleans for semantic availability, provider fallback and date broadening;
- search/index version;
- total and phase durations;
- rate-limit reason code.

Do not log the raw query, normalized topic, embedding, person name/id, party,
event/source ids, exact date, address or user identity. Add tests that fail when
forbidden fields enter the log shape.

### Runbook and rollback

Document and rehearse:

1. frontend kill switch to hide submitted topic search;
2. Edge rollback to the previous v2-calling commit;
3. provider-off keyword-only emergency operation;
4. shadow-index rollback by restoring the previous active index version;
5. queue recovery for pending/processing/failed jobs;
6. verification that normal anonymous feed, people and party search remain live
   during every rollback.

### Final acceptance run

1. Recapture the ten smoke searches against the final production version and
   run every machine-checkable invariant. Do not create a grading task.
2. Generate a compact top-five title/excerpt comparison for positive searches
   and label it engineering evidence, not human-validated relevance evidence.
3. Verify 100% current keyword/semantic coverage and the 20-clip future-lag
   sample.
4. Run 30-call latency measurement and record p50/p95/max plus phase p95s.
5. Re-run the production privilege matrix and confirm provider region/retention
   evidence.
6. Run full Edge/frontend/Python tests, TypeScript, production build and PWA
   verification.
7. Deploy only with explicit owner approval, verify the production bundle and
   execute the live query matrix on Android.
8. Update `docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`, this roadmap and
   `PROGRESS.md` with exact versions, counts, metrics, commit, deployment and
   rollback evidence.

## Required final live query matrix

| Query | Required result |
|---|---|
| `elsparkcykel` | strongly relevant scooter clips first; no weak elflyg filler |
| `elsparkcykel 22 juni` | exact 22 June results, date facet retained, no broadening notice |
| `elsparkcykel 30 mars` | broader relevant results, truthful notice, zero 30 March rows |
| `trafiksäkerhet för små elektriska hyrfordon` | descriptive semantic matches survive without an exact keyword |
| one person + topic + year fixture | every result has the exact person and year |
| one party + topic fixture | every result has the historical party-at-speech |
| one verified event fixture | source constraint and destination are exact |
| `mars` | treated as topic, not a guessed date |
| `elsparkcykel mars 2026` | March range enforced or explicitly broadened |
| `bananministeriet på månen` | empty |
| `kvantdatorer på varje förskola` | empty |

## Agent test and handoff protocol

Every chunk agent must:

1. read `AGENTS.md`, `PROGRESS.md`, this roadmap, its dependency handoff and only
   the relevant implementation references;
2. verify the working tree and protect unrelated edits;
3. register its chunk in `docs/BUILD_PLAN.md` before implementation if it is not
   already registered there;
4. stay within the chunk's file scope;
5. use additive migrations and never rewrite applied SQL;
6. run focused tests while iterating and the repository-wide gates before
   handoff;
7. append the standard `PROGRESS.md` entry with exact evidence;
8. stop at the chunk boundary.

Agents must not tell the owner to grade the 36 queries, open the 385-row TSV or
review future clips as a prerequisite. If an agent chooses to use optional
human-judged evidence, it must first obtain a separate explicit instruction.

Default verification commands:

```text
python tasks.py test lint typecheck
node --experimental-strip-types --test supabase/functions/tests/*.test.ts
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
node scripts\verify-pwa-build.mjs
```

Also run the Edge TypeScript project and every command registered by the active
chunk. Live/provider commands are separate, explicit actions and must never be
required for the default offline test suite.

## Explicitly deferred beyond “finished search”

These are separate product projects and must not be pulled into an optimization
chunk:

- engagement-trained or personalized search ranking;
- a formal human-judged benchmark, nDCG study or mandatory relevance-labelling
  program;
- storing search history or query analytics;
- LLM query rewriting, summaries or answer generation;
- a manually curated topic taxonomy/whitelist;
- cross-language search;
- native Android/iOS rewrites;
- changing how videos are selected, rendered, stored or published;
- historical video backfill execution itself.

The optimized search must automatically benefit from later backfill because it
indexes the same published catalogue. Missing historical content is solved by
publishing that content, not by inventing search results.
