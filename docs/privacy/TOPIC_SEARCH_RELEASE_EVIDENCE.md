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
