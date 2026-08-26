# UI16.8 topic-search release evidence

Evidence date: 2026-08-25. Decision: **NO-GO / feature flag remains off**.

This is the durable gate record for topic search. “Pending” is not a pass, and
published provider capabilities are not treated as proof of an account setting.

## Data-quality boundary

- Population: 3,188 published, non-rejected clips in the production catalogue.
- Grain: one keyword document per eligible clip; one or more deterministic
  semantic passages per current document.
- Coverage: 3,188/3,188 keyword documents and 3,188/3,188 current semantic
  documents; 4,160 current chunks; zero semantic exceptions recorded.
- Evaluation sample: 36 distinct Swedish query intents covering exact topics,
  compounds, inflections, synonyms, descriptive paraphrases/questions,
  person/topic/year, event/year, quoted text, ambiguity-adjacent cases and two
  negatives.
- Retrieval status: all 36 queries now have complete keyword-only,
  semantic-only and deployed-v2 hybrid top-ten pools. The final capture used 344
  embedding tokens; two verified-event queries were correctly provider-free.
  The four structured person/event queries replay the exact production residual
  topic, UUID/date and verified source filters rather than embedding names as
  raw topics. Judgment status remains 0/36 manually complete.
- Consequence: nDCG and comparative quality percentages are intentionally not
  reported. Treating unjudged or uncaptured results as zero would manufacture a
  denominator and is prohibited by the evaluator.

## UI16.9 live behavior

Migrations 027 and 028 and the `clip-search` v2 Function are deployed while the
InstaPods viewer flag remains off. The new admission rule requires either a
keyword anchor, top cosine similarity of at least 0.53, or Swedish lexical
concept coverage of at least 0.67 before context-only results may enter the
fusion pool. Scores remain private and absent from the public response.

Both negative production probes now return an honest empty hybrid result:

- `bananministeriet på månen`: 0 results (raw semantic pool had 2).
- `kvantdatorer på varje förskola`: 0 results (raw semantic pool had 10).

Exact and descriptive positives retained relevant first results, including
`elsparkcyklar`, `trafiksäkerhet för små elektriska hyrfordon`, and the
calibration edge case `AI tar ungas jobb` (cosine 0.427622, lexical coverage
0.75). Structured Svantesson/tax/year, Tobias Andersson/public-service/year and
Busch/semiconductor requests still return constrained production results.

The post-cache operational population is 30 serial public production requests,
one approximately every seven seconds across the real client rate-limit
windows. It includes the initial cold request and does not discard failures or
outliers. All 30 returned HTTP 200. Latencies are stored in
`tests/fixtures/search/documents.json`; nearest-rank p95 is **2,027.124 ms** and
the maximum is **2,568.968 ms**. This is a large correction from the former
6,989.593 ms cold path, but still fails the strict <1,500 ms launch gate.

Query-free phase logs locate the p95 outlier in OpenAI: embedding took 1,121 ms,
while preflight/retrieval took 387/236 ms. Migration 028 removed the former
214,554-byte catalogue aggregation from each fresh Edge isolate by maintaining
a private trigger-refreshed materialization. Forcing a sub-second provider
timeout would make descriptive semantic-only searches intermittently empty, so
that quality regression was not used to manufacture a latency pass.

## Production privilege matrix

Read-only Management API audit on the real project:

| Surface | `anon` | `authenticated` | `service_role` | Result |
|---|---:|---:|---:|---|
| `private` schema usage | no | no | operator role | pass |
| Eight private search tables, including documents, chunks, aliases, events, rate limits and system state | no select/write | no select/write | server-only operation | pass |
| All private `*search*` helpers | no execute | no execute | execute | pass |
| Five public search RPCs | no execute | no execute | execute | pass |

All eight actual tables have RLS enabled. The raw rate-limit table cannot store
a query or address. The audit output contained index/sequence relations too;
those have no browser privileges but are not counted as tables in the RLS
denominator.

## Region and retention evidence

- Supabase Management API reports the production project `ACTIVE_HEALTHY` in
  `eu-west-1`. This proves the database project region, not every support/log
  path or every processor's region.
- OpenAI publishes no-training-by-default, up-to-30-day default abuse logs, no
  embeddings application state and ZDR eligibility. Source:
  <https://platform.openai.com/docs/models/default-usage-policies-by-endpoint>.
- The production Function has no `OPENAI_EMBEDDINGS_BASE_URL` secret and uses
  `https://api.openai.com/v1/embeddings`; direct calls return project and
  organisation headers, while the project-settings API correctly returns 403
  to this non-admin project key. The current integration is therefore **not
  routed through the required `eu.api.openai.com` EEA endpoint**. Actual
  ZDR/Modified Abuse Monitoring approval, opt-in state and effective retention
  remain dashboard/admin evidence and have not been verified. The exact Data
  Controls page has been opened for the owner; this gate remains blocked.

## Release checklist

| Gate | Evidence | Status |
|---|---|---|
| 30+ manually judged queries | 36 seeded; 0 manually complete | fail/pending |
| Keyword vs semantic vs hybrid | all 36 three-mode pools captured on v2; human grades pending | capture pass / judgment pending |
| Hybrid nDCG@10 ≥ 0.75 | no valid judged denominator | pending |
| Relevant top three ≥24/30 | no valid judged denominator | pending |
| Exact matches top three | preliminary exact probes pass; full set unjudged | pending |
| Nonsense/absent topics empty | both complete v2 hybrid pools and public probes empty | pass |
| Submitted-search p95 <1.5 s | 30-request post-cache p95 2.027 s | **fail** |
| Keyword coverage 100% | 3,188/3,188 | pass |
| Semantic coverage/review | 3,188/3,188, zero exceptions | pass |
| Future index lag p95 <2 min | no post-publish sample | pending |
| Private/secret exposure | real privilege matrix pass; no secret printed/retrieved | pass |
| Actual OpenAI region/retention | not verified | pending |
| Privacy copy | draft complete; owner approval pending | pending |
| Rollback rehearsal | procedure documented; no staged production rehearsal | pending |
| Physical device | not run | pending |
| Owner go/no-go | not requested while prerequisite gates fail | pending |

Production migrations 027/028 and `clip-search` v2 are deployed and verified.

## Signed-in owner Android beta — 2026-08-26

The owner explicitly approved publishing the candidate to `main` for testing in
the real app and reported that Pleni has no current users. This approval is
implemented more narrowly than a public flag-on release: ordinary visitors stay
default-off, while `?topic-search-beta=android` enables the UI only for a
signed-in viewer. A visible warning names OpenAI, asks the viewer not to enter
personal/private information and requires confirmation before the first query
in each page session. No opt-in or query is persisted.

Commit `2a4773f` was pushed to `origin/main`; InstaPods served the matching
bundle on 2026-08-26. Post-deploy probes returned a relevant elsparkcykel result
first and an empty nonsense result. Six measured calls were 7,350, 1,010, 798,
2,038, 754 and 998 ms: the cold tail can still exceed the former launch target.
The 2017 mockup query is empty because the current published catalogue has no
2017 backfill and no published Magdalena Andersson speech/person row; current
catalogue person/topic examples work. This is a beta catalogue limitation, not
an invented result.

The limited owner beta therefore has **GO**. A general viewer release remains
**NO-GO** until account retention/region evidence, manual judgments, latency
policy and physical-device acceptance are closed or separately accepted.

## Public Search-tab release decision — 2026-08-26

The owner clarified that topic/video search is intended to be a normal part of
the Search tab for every visitor and explicitly instructed the implementation to
remove the sign-in/beta-only behavior and deploy to `main`. UI16.11 therefore
enables the existing anonymous search client by default in production, removes
the URL and Clerk gates, and removes the per-page confirmation dialog. The
concise inline OpenAI/private-information disclosure remains visible, queries
remain transient, and an explicit `VITE_TOPIC_SEARCH_ENABLED=false` remains the
frontend emergency stop.

This is an explicit product release decision. It does not rewrite the historical
UI16.8 evidence: ungraded relevance pools, the former latency target and
unverified provider account controls remain documented limitations rather than
being relabelled as passing evidence.

Release commit `082fbb7` was pushed to `origin/main` and the resulting InstaPods
bundle was verified at `https://pleni.se/`. The production bundle contains the
public search UI and no longer contains the beta URL marker or confirmation
dialog copy.

The first owner browser test exposed a CORS preflight defect: the Function
allowed `content-type` but omitted the Vite client's required public `apikey`
header, so browsers blocked a healthy endpoint response. UI16.12 commit
`78c29af` adds that header and a regression test. The corrected Function was
deployed and verified with a 204 preflight explicitly allowing
`apikey, content-type, x-client-info`, followed by a 200 public query returning
ten `elsparkcyklar` results.

## OPT1 lean automatic smoke baseline — 2026-08-26

`scripts/evaluate_topic_search.py smoke` replays ten committed Swedish phrases
against the frozen 2026-08-25 capture and writes
`test_outputs/topic_search_smoke_baseline.md`.

**This is engineering smoke evidence, not human-validated relevance evidence.**
It records observable retrieval behavior only. It creates no relevance grade, no
nDCG, no precision and no human denominator, and it does not change the
judgment status recorded above: `judgments.json` remains 0/36 manually complete
and the owner has no review action. The ten phrases are regression test data.
They are never derived from logged user searches, the live endpoint never reads
them, and they are not a topic whitelist, a synonym table, a list of permitted
searches, training data or a ranking input.

Result on the frozen capture: **7 pass, 0 fail, 3 blocked** of 10.

| Phrase | Expectation | Result |
|---|---|---|
| `elsparkcykel` | non-empty | blocked, no capture for this exact phrase |
| `elsparkcykel 30 mars` | broadens, excludes the requested date | blocked, no date metadata captured |
| `elsparkcykel 22 juni` | exact date, no broadening notice | blocked, no date metadata captured |
| `trafiksäkerhet för små elektriska hyrfordon` | non-empty | pass, 10 results |
| `barnfattigdom` | non-empty | pass, 10 results |
| `äldreomsorg bemanning` | non-empty | pass, 10 results |
| `havsbaserad vindkraft i Kattegatt` | non-empty | pass, 10 results |
| `hur ska gängkriminaliteten stoppas` | non-empty | pass, 10 results |
| `bananministeriet på månen` | empty | pass, 0 results |
| `kvantdatorer på varje förskola` | empty | pass, 0 results |

The baseline records `searchVersion`/`rankingVersion` `pleni-search-v2`,
`indexVersion` `openai:text-embedding-3-large:1024:v1` and capture date
2026-08-25T17:00:10Z. Re-running it over the same fixtures is byte-identical.

### Privacy boundary of the smoke path

The smoke command is offline and provider-free: it reads two committed fixtures
and makes no Supabase, OpenAI or other network call. Its output carries titles,
source titles, speaker/party at speech, match excerpts, match kind, clip ids and
debate dates only. Per-candidate cosine similarity and Swedish lexical coverage
are private ranking scores and are dropped before anything is written. No
credential, access token, project reference, client address, embedding or raw
user query can reach the output; regression tests assert each of those.

### Known open defect recorded as the before state

Three electric-aviation clips entered the captured `elsparkcyklar` audit query
as context-only filler at hybrid ranks 8-10 with zero Swedish lexical coverage:
`HD10398_27_c02`, `HD10401_27_c02` and `HD10406_27_c02`. They are recorded as
forbidden scooter examples in `tests/fixtures/search/smoke.json`. OPT1 may not
change ranking, so the baseline reports them as a known open defect owned by
OPT2 rather than failing on them.

### Blocked evidence for the next agent

The frozen capture holds no run for `elsparkcykel`, `elsparkcykel 30 mars` or
`elsparkcykel 22 juni`, and it records no debate date, interpretation facet or
date-broadening metadata for any phrase. Those three expectations are reported
as `blocked_needs_capture` rather than guessed, because resolving them needs a
live Supabase read and one OpenAI query embedding that OPT1 is not permitted to
perform. `_result_summary` now captures `clip.debateDate`, which migration 026
already returns, so the next authorised `capture-live` run carries dates without
further code change. Adding the three phrases to the capture set and recording
the interpretation/broadening envelope remain open.

## OPT2 — Ranking v3 with candidate-level admission (2026-08-26)

Prepared and tested offline. Nothing was deployed, nothing was pushed to `main`,
and no live, OpenAI or other network call was made.

### What changed

v2 admitted every semantic candidate as soon as the query as a whole cleared its
safety gate, so one strong candidate could drag context-only filler into an
otherwise valid result list. v3 keeps that query-level gate (a keyword anchor,
or best similarity at least `0.53`, or best Swedish lexical coverage at least
`0.67`) and adds candidate-level admission after it: a semantic-only candidate
is admitted only when its own similarity is at least `0.50` or its own lexical
coverage is at least `0.67`. Keyword-matched candidates are exempt and always
survive, so exact Swedish matches and compounds cannot be filtered out.

Semantic retrieval ranks are assigned before admission, so dropping a row never
reorders or promotes the rows that remain. Structured person, party, date and
verified-event filters stay inside the `eligible` CTE ahead of retrieval. No
recency boost was added; date remains a filter and a deterministic tie break. A
result list may be shorter than the requested limit and is never backfilled.

### How the thresholds were chosen

`scripts/evaluate_topic_search.py admission-grid` replays the roadmap's 180-point
grid offline against the frozen 2026-08-25 capture. **This is engineering
evidence of observable membership, not human-validated relevance evidence.** It
produces no relevance grade, no nDCG and no precision, and no configuration is
called best; the fixture's 36 queries and 385 captured rows were not graded and
must not be.

Candidate similarity `0.40` was discarded because it keeps the elflyg filler;
`0.53` was discarded because it starves the descriptive scooter search below
`min(5, baseline)`. Of the 108 survivors the roadmap's conservative order selects
`sim0.50-lex0.67-kw1.50-sem1.00-k50`. The keyword weight, semantic weight and
RRF `k` change result order rather than admission, and the frozen capture
preserves only the top-N that the deployed weights produced, so they cannot be
separated offline and were held at the deployed values.

### Measured effect on the frozen capture

| Search | Before | After | Dropped |
|---|---|---|---|
| `elsparkcyklar` (`q01`) | 10 | 6 | 3 elflyg rows plus 1 weak context row |
| `trafiksäkerhet för små elektriska hyrfordon` | 10 | 6 | 4 tail context rows |
| `barnfattigdom` | 10 | 10 | none |
| `äldreomsorg bemanning` | 10 | 10 | none |
| `havsbaserad vindkraft i Kattegatt` | 10 | 6 | 4 tail context rows |
| `hur ska gängkriminaliteten stoppas` | 10 | 10 | none |
| `bananministeriet på månen` | 0 | 0 | none |
| `kvantdatorer på varje förskola` | 0 | 0 | none |

Every top-five position is identical before and after in all eight captured
searches: only tail candidates were removed. No keyword-matched candidate was
dropped in any of the 180 configurations, and both negative phrases stay empty
in all of them.

The known open defect OPT1 recorded is closed on the captured evidence:
`HD10398_27_c02`, `HD10401_27_c02` and `HD10406_27_c02` are removed from the
scooter result by their own similarity (`0.416605`, below `0.50`) and coverage
(`0`, below `0.67`), independent of the date-exclusion guard.

### Privacy boundary of the grid path

The `admission-grid` command is offline and provider-free: it reads three
committed fixtures and makes no Supabase, OpenAI or other network call. Its JSON
output carries configuration identifiers, gate booleans, counts and clip ids;
the before/after report adds titles, source titles, speaker/party at speech,
match excerpts, match kind and debate dates. Per-candidate cosine similarity and
Swedish lexical coverage stay private: they are dropped before anything is
written, they never appear in the public `clip-search-v1` response, and
regression tests assert both. No credential, access token, project reference,
client address, embedding or raw user query can reach the output.

### Still blocked

`elsparkcykel`, `elsparkcykel 30 mars` and `elsparkcykel 22 juni` remain
`blocked_needs_capture`. OPT2 was instructed to make no live or OpenAI call, so
the capture that would resolve them was not produced and their date gates stay
honestly unproven rather than assumed green. Gate 5 was verified instead against
the captured `elsparkcyklar` run, the only scooter search the frozen capture can
evidence and the run the three false positives were identified from.

### Rollback

`029_search_candidate_admission.down.sql` drops `search_clip_candidates_v3`
alone. `search_clip_candidates_v2` and migrations 022-028 are untouched, so the
operational rollback is redeploying the previous Edge Function commit, which
calls v2. The v2 response envelope is unchanged, and an Edge test asserts the
handler still accepts it.
