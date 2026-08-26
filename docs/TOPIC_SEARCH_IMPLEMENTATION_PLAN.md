# UI16 — Interpretable Hybrid Topic and Event Search

**Status:** UI16.0–UI16.15 are deployed. Topic/video results are part of the
normal public Search tab; no sign-in or special URL is required.
**Last updated:** 2026-08-26.
**Owner-approved direction:** preserve the current live party/politician search and
add contextual search over published clips, including the visible **“Tolkat som”**
interpretation shown in the mockup below.

This document is the detailed implementation source of truth for UI16; all fifteen
bounded scopes are also registered in `docs/BUILD_PLAN.md`. It is intentionally
detailed because future coding agents implement one chunk at a time and do not
share conversation memory.

> Completing UI16.0 does not authorize a deployment. All production database,
> Edge Function, OpenAI, privacy, backfill and rollout actions remain gated by
> their chunk acceptance conditions and explicit owner approvals.

## Product outcome

Pleni’s existing Search page can currently find parties and politicians. UI16 adds
search over what was said inside the published videos.

Examples:

- `magdalena andersson skatter 2017` finds Magdalena Andersson clips about tax
  from debates held in 2017.
- `elsparkcyklar` finds relevant clips even if a speaker used related wording
  such as “el-scootrar”, “trafiksäkerhet” or “uthyrningsfordon”.
- `budgetdebatten 2022` identifies a verified parliamentary event and returns
  clips belonging to it.
- `problemen som drabbar små kommuner i norr` uses the whole sentence as a
  contextual topic query.

The system must remain understandable. The submitted query is separated into
recognised filters and a residual topic, then displayed as “Tolkat som”:

`Person · Magdalena Andersson` · `Ämne · skatter` · `År · 2017`

This is not an LLM-generated explanation. It is a faithful representation of the
structured query plan actually used to retrieve the results.

## Approved visual direction

![Approved Pleni topic-search result-page mockup](assets/topic-search-results-mockup.svg)

The mockup uses illustrative clip titles, dates, debate labels and transcript
excerpts. They are not claims about real archived speeches.

The design preserves the current Pleni Search language:

- warm white search surface and existing 48 px search field;
- current horizontal party chips and bottom navigation;
- compact identity destination above content results;
- cardless, image-led clip rows with dividers;
- speaker, party-at-the-time, debate date, debate context and a matched excerpt;
- “Spela alla” opens the existing vertical feed in relevance order.

## Locked decisions

1. Existing party and politician matches continue appearing while the viewer
   types. Contextual clip search runs only after Enter or an explicit Search tap.
2. Topics are open-ended. There is no production list of 30 allowed topics.
3. The manually judged query set described later is an offline quality test, not
   a menu of supported searches and not a list users choose from.
4. Structured filters are deterministic and evidence-backed. Embeddings search
   only the remaining topic text.
5. A recognised person, party, date or verified event becomes a strict filter.
6. If no structured entity is recognised, the complete submitted text becomes
   the topic query.
7. An ordinary real-world event is treated as a topic unless Pleni has a verified
   event record for it. The UI must never confidently invent an event.
8. Search covers finished, published clips only. It does not dynamically create
   new clips or search unpublished full speeches in V1.
9. Result metadata uses `sources.debate_date`, never `clips.published_at`, for
   historical date filtering and display.
10. Search results display the party recorded on the speech at that debate.
    Politician destinations may display the politician’s current party. These are
    deliberately separate because historical affiliation can differ.
11. Search queries are transient. They are not saved in URLs, localStorage,
    Clerk metadata, recommendation profiles, application logs or analytics.
12. Search never blocks C11 publishing. Keyword and semantic indexing are
    downstream, idempotent projections of already-published metadata.
13. `src/contracts.py` and the numbered work-artifact chain do not change.
14. A provider failure falls back to keyword search; party/person live search
    remains usable even if the complete topic-search service is unavailable.
15. The initial embedding index version is
    `openai:text-embedding-3-large:1024:v1`. A model, dimension, input format,
    chunking or normalization change creates a new version and a new backfill.

## Scope and non-goals

### In scope

- Swedish exact-word and semantic retrieval over published clip titles and clip
  transcripts;
- deterministic recognition of politicians, parties, explicit years/date ranges,
  and verified parliamentary events;
- visible, removable interpretation chips;
- contextual result excerpts;
- relevance-ordered handoff to the existing vertical feed;
- automatic indexing of all future backfills;
- idempotent backfill of the existing catalogue;
- public abuse protection without storing raw addresses or queries;
- quality measurement, index coverage and operator recovery procedures.

### Out of scope for V1

- searching every full speech when no published clip exists;
- generating a new clip around an arbitrary transcript match;
- captions or VTT/ASS artifacts;
- generative answers or summaries of political positions;
- an LLM deciding which person, party, year or event the user meant;
- personalised search ranking;
- using search queries to train recommendations or build interest profiles;
- global news/event knowledge not backed by Pleni’s catalogue metadata;
- voice search, spelling correction that silently changes intent, or relative
  dates such as “last year”;
- URL-addressable or persistently saved searches.

## Current data and integration points

The required searchable material is already published to Supabase:

| Source | Fields used by search |
|---|---|
| `public.clips` | `id`, `speech_id`, `title`, `transcript`, `duration_s`, `thumb_url`, video URL, moderation and publication state |
| `public.speeches` | stable `politician_id`, speaker name at the time, party at the time, speech type and `source_id` |
| `public.politicians` | stable person id, current name, current party, role and portrait |
| `public.sources` | `dokid`, title, debate type, debate date and Riksdagen URL |

The current frontend reads through `web/src/supabase.ts`; SearchScreen lives in
`web/src/App.tsx`. The static InstaPods frontend cannot hold an OpenAI secret.
Query embeddings therefore run only inside a Supabase Edge Function.

`clips.topic` may remain null and must not become a prerequisite. Search derives
its index from title, clip transcript and joined source/speaker metadata.

The current catalogue snapshot documented in `PROGRESS.md` is 3,188 published
clips across 248 debates. Implementation agents must measure the live eligible
count again before backfill; no plan constant is authoritative forever.

## End-to-end search pipeline

```text
C11 publishes clip metadata
        │
        ▼
private keyword document is synchronously refreshed
        │
        ├── clip immediately keyword-searchable
        │
        ▼
semantic job is queued idempotently
        │
        ▼
embedding worker creates deterministic passages and vectors
        │
        ▼
current index version becomes searchable

Viewer submits a query
        │
        ▼
Edge Function normalizes and interprets it
        │
        ├── person / party / date / verified event = strict filters
        └── remaining words = topic text
                    │
                    ▼
          keyword + semantic retrieval
                    │
                    ▼
        reciprocal-rank fusion and confidence gate
                    │
                    ▼
 interpretation + event destination + ordered clip results
                    │
                    ▼
 Search page → selected clip or “Spela alla” → existing FeedScreen
```

The search index is a derived read model. Supabase’s existing `clips`,
`speeches`, `politicians` and `sources` rows remain authoritative.

## Query interpretation contract

### Public request

```ts
type DisabledSearchFacet =
  | "person"
  | "party"
  | "event"
  | "date";

type ClipSearchRequest = {
  query: string;
  limit?: number; // server clamps to 1–60
  disabledFacets?: DisabledSearchFacet[];
};
```

The first submission normally contains only `query`. When a viewer removes a
“Tolkat som” chip, the frontend resubmits the original transient query with that
facet kind in `disabledFacets`. The server reinterprets the query, suppresses
that facet, and moves its original words back into the residual topic where
appropriate. The client never supplies trusted database filters directly.

Topic is not listed in `DisabledSearchFacet`: removing the topic chip leaves
no contextual query, so the frontend returns to the live identity-only state
instead of requesting an unbounded catalogue search.

### Public response

```ts
type SearchFacet =
  | {
      kind: "person";
      key: "person";
      label: string;
      politicianId: string;
      removable: true;
    }
  | {
      kind: "party";
      key: "party";
      label: string;
      party: PartyCode;
      removable: true;
    }
  | {
      kind: "event";
      key: "event";
      label: string;
      eventId: string;
      removable: true;
    }
  | {
      kind: "date";
      key: "date";
      label: string;
      from: string; // inclusive YYYY-MM-DD
      to: string;   // inclusive YYYY-MM-DD
      removable: true;
    }
  | {
      kind: "topic";
      key: "topic";
      label: string;
      removable: true;
    };

type SearchEventDestination = {
  id: string;
  label: string;
  dateLabel: string;
  sourceUrl: string | null;
  clipCount: number;
};

type SearchClipResult = {
  clip: ClipItem;
  speakerNameAtSpeech: string;
  partyAtSpeech: PartyCode;
  matchExcerpt: string; // plain text, <=220 characters
  matchKind: "keyword" | "context" | "both" | "filtered";
};

type SearchDateBroadening = {
  kind: "date";
  label: string;
  from: string;
  to: string;
};

type ClipSearchResponse = {
  mode: "hybrid" | "keyword_fallback" | "filtered";
  searchVersion: string;
  indexVersion: string;
  interpretation: {
    facets: SearchFacet[];
    ambiguity: null | {
      kind: "person" | "event";
      message: string;
      options: Array<{ id: string; label: string; detail: string }>;
    };
  };
  event: SearchEventDestination | null;
  results: SearchClipResult[];
  dateBroadening?: SearchDateBroadening | null;
};
```

Internal confidence, similarity and rank scores are not public response fields.
They belong in versioned evaluation output, not the UI.

### Interpretation order

The interpreter is deterministic and executes in this order:

1. Normalize Unicode and whitespace while preserving the submitted display text.
2. Extract explicit four-digit years, supported year ranges and valid Swedish
   day–month phrases. Interpreter V2 accepts a single year, `YYYY–YYYY`,
   `från YYYY`, `sedan YYYY`, `30 mars` and `30 maj 2025`. A day–month without
   a year uses the request's current UTC year. Date bounds are compared to
   `sources.debate_date`.
3. Match verified politician aliases against the longest token span first.
4. Match party codes, current party names and verified party aliases.
5. Match verified event aliases and normalized source titles, using the detected
   year/date to disambiguate occurrences.
6. Remove only the confidently consumed token spans.
7. Trim punctuation and stopword-only debris from the remainder.
8. Treat the remainder as the topic. Never generate a replacement topic.
9. Apply any `disabledFacets`, then rebuild the final query plan.

Matching must use Swedish-aware normalization and retain `å`, `ä` and `ö`
in display text. An unaccented comparison form may be used as an additional
lookup key, but never as the canonical name.

### Confidence and ambiguity rules

- Exact normalized full-name and verified alias matches may be accepted.
- A unique surname may be accepted only when exactly one catalogue politician
  owns it. Otherwise return person options and do not apply a person filter.
- Fuzzy matches require a configured minimum score and a clear margin over the
  second candidate. Both values are versioned and covered by fixtures.
- A year is always a date facet, even when the current catalogue has no clips in
  that year. The result is then honestly empty.
- A valid Swedish day–month is an exact date facet. Impossible dates such as
  `31 februari` remain topic text; the interpreter must not silently repair them.
- If an exact date plus topic returns no clips, the server automatically retries
  with only the date removed, preserves any person/party/event filters, omits the
  date from the applied facets and reports the original date in explicit
  date-broadening metadata. Date-only queries never broaden.
- An event requires a verified event/source record. Semantic similarity to a
  title alone is insufficient to apply a strict event filter.
- If an event alias has several occurrences and no date resolves it, return
  event options or treat it as a general topic; do not silently choose the most
  recent occurrence.
- If interpretation code fails, use the whole query as topic text and attach no
  structured facet. Never fail into guessed filters.

### Expected behavior examples

| Submitted query | “Tolkat som” | Result behavior |
|---|---|---|
| `magdalena andersson skatter 2017` | Person · Magdalena Andersson; Ämne · skatter; År · 2017 | strict person/year filters; hybrid rank by tax relevance |
| `elsparkcyklar` | Ämne · elsparkcyklar | hybrid results across all people, parties and dates |
| `elsparkcyklar 2021` | Ämne · elsparkcyklar; År · 2021 | hybrid topic retrieval inside 2021 |
| `elsparkcyklar 30 mars` | Ämne · elsparkcyklar after automatic broadening | exact date is tried first; if empty, relevant topic clips from other dates are shown with a clear notice |
| `budgetdebatten 2022` | Händelse · Budgetdebatten; År · 2022 | verified event destination plus clips mapped to that event |
| `Northvolt konkurs` | Ämne · Northvolt konkurs | topic search unless a verified Pleni event exists |
| `S skatter` | Parti · Socialdemokraterna; Ämne · skatter | historical speech-party filter plus topic retrieval |
| `Magdalena Andersson` | Person · Magdalena Andersson | profile destination and filtered/latest published clips; no query embedding required |
| `2017` | År · 2017 | do not return an unbounded year feed; ask for a topic, person, party or event |
| a descriptive sentence | Ämne · the complete normalized sentence | semantic and keyword retrieval |
| an ambiguous surname | no person facet; choice UI | viewer selects a person or continues as topic text |

## Verified event model

“Event” means a catalogue-backed parliamentary occurrence, not general world
knowledge.

Create private normalized tables:

- `search_events`: canonical label, event kind, optional date bounds, verified
  state and provenance;
- `search_event_sources`: many-to-many links from an event to
  `public.sources.id`;
- `search_event_aliases`: normalized, unique aliases linked to an event;
- `search_person_aliases`: aliases linked to `public.politicians.id`, with
  provenance and verified/automatic state.

One source-derived event is generated for every eligible `public.sources` row.
Its source title, `dokid`, debate type and date are evidence. Cross-source or
recurring event groupings such as “Budgetdebatten 2022” require a verified event
row linking the appropriate sources.

Person aliases are automatically derived from current `politicians.name` and
historical `speeches.speaker_name` values already linked through
`politician_id`. Manually added aliases require provenance. Titles such as
“finansminister” may be stripped for lookup but are not identity aliases by
themselves.

The alias catalogue is intentionally small and structural. It improves detection
of named parliamentary events and historical names; it does not constrain which
topics embeddings can search.

## Search storage and ranking

### Migration-order gate

A read-only production check on 2026-08-25 established that recommendation
migrations `018_recommendation_identity`, `019_rule_based_feed` and
`020_recommendation_launch_controls`, followed by `021_party_logos`, are already
applied. Their recorded SHA-256 checksums exactly match the corresponding files
in repository history: 018/019 match this worktree and 020/021 match
`origin/main`. They are immutable production history and must never be moved,
renumbered or edited.

This UI16.0 worktree is based on an older feature branch that does not contain
the already-deployed 020/021 files. That is safe for interface-only work, but it
is not a valid base for another migration. Therefore:

1. Query the live `schema_migrations` ledger again immediately before any search
   migration deployment.
2. Start UI16.1 from a branch containing the checksum-matching deployed files
   018–021, normally current `origin/main`; do not manufacture or reconstruct
   missing applied files.
3. UI16 search migrations begin at **022** and reserve 022–025 for the four
   database-bearing chunks in this plan.
4. Applied migration files are immutable. Any correction is a new migration.
5. Stop if the chosen implementation branch, repository history and live ledger
   disagree in filename or checksum.

### Private tables

`private.clip_search_documents` has one row per eligible clip:

- `clip_id` primary/foreign key with cascade deletion;
- denormalized `source_id`, `politician_id`, party-at-speech and debate date
  for strict filters;
- title and complete public clip transcript;
- deterministic `source_hash`;
- generated Swedish weighted `tsvector`, title weight A and transcript weight B;
- keyword/index timestamps, current semantic state and failure detail;
- requested and completed index versions.

`private.clip_search_chunks` has deterministic passages:

- `clip_id`, zero-based `chunk_no` composite key;
- plain-text passage and character offsets into the normalized clip document;
- `source_hash` and `index_version`;
- `halfvec(1024)` embedding;
- creation timestamp.

Additional private tables hold events, aliases, rate-limit buckets and operator
status. Browser roles receive no table or sequence grants.

Enable extensions in their intended schema and verify the hosted project’s
versions before migration:

- `vector` / pgvector;
- `pgmq`;
- `pg_cron`;
- `pg_net`;
- `unaccent` if the chosen normalization function uses it.

Verify that `pg_catalog.swedish` text-search configuration exists. If it does
not, stop and revise the keyword design rather than silently using English.

Create:

- GIN index over the Swedish `tsvector`;
- HNSW cosine index using `halfvec_cosine_ops`;
- B-tree filter indexes covering debate date, politician, party and source;
- uniqueness on clip/chunk/index version where needed for idempotency.

Supabase currently documents `halfvec` HNSW support up to 4,000 dimensions, so
1,024 is within that limit. Re-verify against the live pgvector version before
deploying: [Supabase vector indexes](https://supabase.com/docs/guides/ai/vector-indexes).

### Eligibility and lifecycle

Eligibility always matches the public feed:

```sql
clips.published_at is not null
and clips.moderation <> 'rejected'
```

A database trigger synchronously refreshes or removes the keyword document when
clip title/transcript, speech/source joins, moderation or publication state
changes. The same transaction enqueues semantic work; it does not make a network
call.

- Newly published clips become keyword-searchable immediately.
- Embeddings are eventually consistent and do not delay C11.
- Unpublishing, rejection or deletion removes the clip and its chunks from
  search.
- A matching source hash and index version is a no-op.
- A changed source hash replaces all chunks transactionally only after the new
  embeddings validate.
- Failed semantic work retries with bounded exponential backoff.
- After five failed attempts, semantic state becomes `failed`; keyword search
  remains available and operator status exposes the failure.

Use Supabase’s queue/cron/Edge architecture as the starting point:
[automatic embeddings](https://supabase.com/docs/guides/ai/automatic-embeddings)
and [scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).
Do not make C11 call the embedding provider directly.

### Passage construction

- Normalize whitespace without altering Swedish words.
- Split at sentence boundaries.
- Target at most 700 Unicode characters per passage.
- Carry one sentence of overlap where the clip requires multiple passages.
- Never emit an empty passage.
- Embed `clip title + "\n\n" + passage`.
- Keep passages in source order with deterministic character offsets.
- The same code creates backfill and future-publish passages.

At 45–90 seconds, most clips should produce only a few passages. Record the
measured distribution before fixing worker batch size.

### Embedding provider

V1 uses OpenAI `text-embedding-3-large` with
`dimensions: 1024`. Official OpenAI documentation currently describes it as
the most capable embedding model for English and non-English tasks, and the
Embeddings API supports a custom `dimensions` value for text-embedding-3
models:

- [text-embedding-3-large model](https://developers.openai.com/api/docs/models/text-embedding-3-large)
- [Embeddings API reference](https://developers.openai.com/api/reference/ruby/resources/embeddings/methods/create)

The worker must reject a response with the wrong item count, dimensions, index
order, non-finite values or unexpected model metadata.

`OPENAI_API_KEY` and the Supabase service credential are Edge Function secrets.
They never appear in Vite variables, browser requests, logs or migration files.
Use the EEA regional endpoint only after the project is confirmed eligible and
configured.

Provider price and limits are operational inputs, not constants in code. Before
backfill, calculate estimated tokens and cost using current official pricing,
show the estimate to the owner, set a project budget/spend alert, and require an
explicit start decision.

OpenAI’s official data-control documentation, verified 2026-08-23, says API data
is not used to train models unless the customer opts in, while the Embeddings
endpoint can have abuse-monitoring retention and is eligible for Zero Data
Retention for approved customers. EEA regional processing lists
`/v1/embeddings` as supported. The release gate must verify Pleni’s actual
project settings rather than assuming eligibility:
[OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data).

### Hybrid retrieval

Structured facets first constrain the candidate catalogue. Retrieval then runs:

1. up to 120 keyword candidates using Swedish full-text search;
2. up to 120 semantic passage candidates using cosine distance;
3. best semantic passage per clip;
4. reciprocal-rank fusion (RRF);
5. deterministic tie-breaking by debate date, rank-in-speech and clip id;
6. maximum 60 public results.

Initial calibration values:

- semantic similarity floor `0.35`;
- RRF smoothing `k=50`;
- keyword weight `1.5`;
- semantic weight `1.0`.

These are baselines, not unquestionable truths. UI16.8 may tune them against the
committed Swedish relevance fixture before launch. The accepted values are stored
under a version such as `pleni-search-v1`; changing them after launch creates a
new search version and reruns the comparison report.

Use Supabase’s official hybrid-search pattern as the SQL starting point:
[hybrid search](https://supabase.com/docs/guides/ai/hybrid-search).

Exact title/transcript matches should receive keyword strength; semantic search
should supply synonyms and contextual wording. Publication time never makes an
old backfill “new”: only `sources.debate_date` participates in historical
filtering/ties.

When no topic remains:

- person/party/event filters use `mode: "filtered"` and do not call OpenAI;
- person-only retains the profile destination and may show latest published clips;
- verified event-only returns that event’s clips;
- date-only refuses an unbounded result list and asks for another term.

## Public Edge Function

Add `POST /functions/v1/clip-search`.

Behavior:

- anonymous access is allowed;
- only `POST` and CORS preflight are accepted;
- trim and normalize queries of 2–120 characters;
- reject an oversized body before JSON parsing;
- validate `disabledFacets` against the fixed enum;
- interpret on the server;
- generate one query embedding only when residual topic text exists;
- execute hybrid or filtered SQL using validated structured values;
- return complete playable clip payloads in SQL order;
- choose the best matched passage and return a plain-text excerpt no longer than
  220 characters, cut at word boundaries;
- return `keyword_fallback` if OpenAI times out, rate-limits or returns invalid
  data;
- never expose vectors, internal scores, confidence thresholds or unpublished
  rows;
- set `Cache-Control: no-store`;
- never log request bodies, query strings, interpretation labels or excerpts.

The fallback UI copy is:

> Kontextsökningen är tillfälligt begränsad. Resultaten matchar orden i talen.

The complete topic-search API failing must not erase or disable the existing
client-side/live party and politician results.

## Public abuse protection and privacy

No sign-in is required.

- Limit to 10 submitted contextual searches per minute and 200 per UTC day per
  network address.
- Derive a daily client key using HMAC-SHA256 over address, UTC date and
  `SEARCH_RATE_LIMIT_SECRET`.
- Store only the HMAC, bucket and count in a private table.
- Never store the raw address or query.
- Delete expired counters after 48 hours.
- Add a global request/provider-token ceiling so distributed traffic cannot
  bypass per-client limits.
- Configure provider spend alerts and a kill switch independent of the frontend
  feature flag.
- Log only aggregate latency, result count, mode, status code, rate-limit count,
  coverage and worker failure counts.
- Ensure infrastructure access logs are reviewed for request-body or URL leakage.
  The query is in a POST body, never the URL.

Before launch, update Pleni’s privacy documentation to cover transient query
processing, OpenAI’s role, regional/retention configuration, pseudonymous abuse
counters, their retention, and the fact that searches are not used for
recommendations or profiling.

## Search-page behavior

### Submission and state

- Keep the existing input and 220 ms live identity lookup.
- Add an explicit Search action; Enter performs the same action.
- Abort stale requests and ignore late responses using a monotonically increasing
  request id or AbortController.
- Do not submit topic search on every keystroke.
- Preserve current party filter behavior; selected party becomes a strict search
  facet on submission.
- A successful submission replaces the prior topic result set for the session.
- While a submitted search is pending, show a compact visible spinner and
  `Söker efter relevanta klipp…` above the existing result skeleton. Preserve a
  static, understandable state when reduced motion is requested.
- Back restores submitted text, response, revealed count and scroll position in
  page-session memory only.
- A reload may forget the search.

### “Tolkat som”

- Render only after a submitted search response.
- Display facets in order: person, party, event, topic, date.
- Render only facets the server actually used.
- Use the server label; do not reinterpret again in the browser.
- Each chip has an accessible remove action and announces that results are being
  broadened.
- Removing a facet resubmits with `disabledFacets`; removing topic returns to
  identity-only search.
- During ambiguity, show explicit options such as “Välj person”; do not show the
  uncertain facet as settled.
- If the entire query is the topic, display one topic facet even when it is a
  full sentence.

### Result groups

Order:

1. current matching party destination, when applicable;
2. current matching politician destination(s);
3. verified event destination, when applicable;
4. contextual clip results.

Clip rows show:

- 9:16 thumbnail and duration;
- clip title;
- speaker name and party at the time of the speech;
- source debate date and concise debate/source label;
- two-line matched transcript excerpt;
- no technical “AI”, embedding, similarity or match-kind badge.

Show `Mest relevanta först · N träffar`. Fetch up to 60 once, render 20
initially, and reveal the next 20 through “Visa fler” without another embedding
request.

No-result behavior:

- retain identity/event destinations;
- say that no relevant clips were found inside the active facets;
- suggest removing a facet or trying a broader Swedish expression;
- do not pad the page with low-confidence semantic matches.

### Feed handoff

- Tapping a row opens the existing bounded-media `FeedScreen` at that clip.
- “Spela alla” opens at result 1.
- Preserve the exact complete relevance order returned by the server.
- Do not refetch or reorder through the ordinary “Senaste” loader.
- Preserve the four-source media ceiling, directional preloading, poster bounds,
  service-worker bypasses and UI15 gesture policy.
- Back returns to the exact search state and scroll position.
- Search-specific excerpts do not appear as video captions.

## Implementation chunks

Agents implement exactly one chunk per session unless the owner explicitly
assigns more. Before starting a chunk, copy its definitive scope into
`docs/BUILD_PLAN.md`, mark it in `PROGRESS.md`, read its dependencies, and
verify the previous chunk’s handoff. At chunk end, run the stated acceptance
checks and append the handoff template from this document.

| Chunk | Objective | Depends on | Size | Status |
|---|---|---|---|---|
| UI16.0 | migration/deployment gate and contracts | owner authorization | small | DONE 2026-08-25 |
| UI16.1 | private schema and keyword-only search | UI16.0 | large | DONE 2026-08-25 |
| UI16.2 | deterministic interpretation and verified events | UI16.1 | large | DONE 2026-08-25 |
| UI16.3 | passage generation and automatic semantic indexing | UI16.1 | large | DONE 2026-08-25 |
| UI16.4 | public API, hybrid ranking and abuse protection | UI16.2, UI16.3 | large | DONE 2026-08-25 |
| UI16.5 | catalogue backfill and operator controls | UI16.3, UI16.4 | medium | DONE 2026-08-25 |
| UI16.6 | search results UI and interpretation chips | UI16.4 | large | DONE 2026-08-25 |
| UI16.7 | relevance-feed handoff and session restoration | UI16.6 | medium | DONE 2026-08-25 |
| UI16.8 | relevance evaluation, privacy gate and controlled release | all previous | large | IMPLEMENTED / RELEASE BLOCKED |
| UI16.9 | no-filler relevance, latency and evaluation closeout | UI16.8 evidence | medium | BACKEND DEPLOYED / RELEASE BLOCKED |
| UI16.14 | automatic date broadening for empty topic searches | UI16.13 | small | DONE 2026-08-26 |
| UI16.15 | truthful other-date fallback results | UI16.14 | small | DONE 2026-08-26 |

### UI16.0 — Gate, file ownership and interface fixtures

**Objective:** make later database work safe before any migration is written or
applied.

**May modify:**

```text
docs/BUILD_PLAN.md
docs/TOPIC_SEARCH_IMPLEMENTATION_PLAN.md
PROGRESS.md
tests/unit/test_publish_migrations.py
supabase/functions/_shared/search-types.ts  # interface only
web/src/search/types.ts                     # mirrored interface only
web/src/search/feature.ts                   # default-off flag reader only
web/src/vite-env.d.ts
web/.env.example
web/tests/search-contract.test.mjs
web/tests/fixtures/search-contract/*
```

**Must not touch:** production database, Edge deployments, numbered pipeline
stages, `src/contracts.py`, current Search rendering, ranking or embeddings.

**Deliverables:**

- capture live migration-ledger evidence;
- prove deployed migrations 018–021 are immutable and checksum-matched to
  repository history;
- reserve search migrations from 022 onward and require UI16.1 to start from a
  branch containing 020/021;
- register every UI16 chunk and exact file scope in `BUILD_PLAN.md`;
- commit mirrored request/response fixtures, including all interpretation modes
  and malformed responses;
- add a feature flag `VITE_TOPIC_SEARCH_ENABLED=false` only if its env/type
  ownership is included in the registered scope.

**Acceptance:** migration discovery remains top-level-only; no deployed migration
is moved or changed; search types round-trip through fixtures; no network or
database mutation occurred; default feature remains off.

### UI16.1 — Search foundation and keyword retrieval

**Objective:** make every eligible clip immediately searchable by exact Swedish
words, with private storage and strict permissions.

**May create or modify:**

```text
migrations/022_search_foundation.{up,down}.sql
tests/unit/test_topic_search_migrations.py
tests/live/test_topic_search_rls.py
docs/BUILD_PLAN.md
PROGRESS.md
```

**Must not touch:** OpenAI, Edge Functions, frontend, C11 Python, existing public
table contracts.

**Deliverables:**

- extensions/version preflight;
- private document, event/alias and rate-limit tables;
- public-data synchronization triggers;
- Swedish weighted `tsvector`, GIN/filter indexes;
- security-definer keyword-search function with an explicit safe
  `search_path`;
- exact eligibility/removal behavior;
- RLS/grant matrix proving anon/authenticated cannot read private data or invoke
  private helper functions.

**Acceptance:** insert/update/reject/unpublish/delete fixtures converge correctly;
Swedish inflections and exact title/transcript matches work; a future published
clip needs no manual keyword backfill; keyword function returns only public,
playable clips in deterministic order.

### UI16.2 — Deterministic interpretation and verified events

**Objective:** implement the query plan behind “Tolkat som” without a generative
model.

**May create or modify:**

```text
migrations/023_search_entities.{up,down}.sql
supabase/functions/_shared/search/{normalize,interpret,types}.ts
supabase/functions/tests/search-interpreter.test.ts
tests/fixtures/search/interpretation_cases.json
docs/BUILD_PLAN.md
PROGRESS.md
```

**Must not touch:** embeddings, hybrid score SQL, frontend rendering, feed,
numbered pipeline.

**Deliverables:**

- Swedish normalization and token-span accounting;
- year/range parser;
- current/historical politician alias projection;
- party recognition;
- source-derived and curated verified event model;
- ambiguity/options behavior;
- disabled-facet behavior;
- plain residual topic generation by subtraction, never rewriting.

**Acceptance:** table-driven fixtures cover every example in this document,
titles/punctuation/diacritics, surname collisions, historical names, repeated
events across years, no-topic cases and failure fallback. The response never
claims an unverified event or ambiguous person.

### UI16.3 — Semantic index lifecycle

**Objective:** asynchronously create and maintain versioned passage embeddings
for every eligible clip.

**May create or modify:**

```text
migrations/024_search_embeddings.{up,down}.sql
supabase/functions/search-embed/index.ts
supabase/functions/_shared/search/{chunks,openai,worker}.ts
supabase/functions/tests/search-{chunks,worker,openai}.test.ts
supabase/config.toml
.env.example
docs/DEPENDENCIES.md                 # only if a dependency is truly added
docs/BUILD_PLAN.md
PROGRESS.md
```

**Must not touch:** public search endpoint, frontend, feed, C11 Python,
`src/contracts.py`.

**Deliverables:**

- deterministic sentence-boundary passages and hashes;
- pgmq enqueue/claim/ack/retry/dead behavior;
- cron/pg_net invocation with secrets in Vault or Function secrets as
  appropriate;
- batched OpenAI Embeddings calls with dimensions fixed to 1024;
- strict response validation;
- transactional chunk replacement;
- index state/coverage query;
- keyword availability independent of semantic state.

**Acceptance:** idempotency, changed-text reindex, rejected/deleted cleanup,
partial-batch failure, wrong-dimension response, provider timeout, five-attempt
failure and retry recovery all pass without delaying or mutating C11.

### UI16.4 — Public interpreted hybrid search API

**Objective:** expose one safe anonymous endpoint that interprets, filters,
retrieves and returns playable results.

**May create or modify:**

```text
migrations/025_hybrid_clip_search.{up,down}.sql
supabase/functions/clip-search/index.ts
supabase/functions/_shared/search/{api,ranking,rate-limit}.ts
supabase/functions/_shared/{cors,db}.ts       # additive reuse only
supabase/functions/tests/clip-search.test.ts
tests/live/test_topic_search_rpc.py
supabase/config.toml
docs/BUILD_PLAN.md
PROGRESS.md
```

**Must not touch:** frontend, existing recommendation behavior, C11, feed
ordering outside search.

**Deliverables:**

- structured filter + keyword/semantic candidate SQL;
- versioned RRF;
- best-passage excerpt selection;
- filtered/no-topic mode;
- OpenAI keyword fallback;
- HMAC rate limits, cleanup and global ceiling;
- strict CORS/method/body/validation handling;
- redacted structured logs;
- complete response matching UI16.0 fixtures.

**Acceptance:** successful hybrid, filtered, fallback, ambiguity, empty,
rate-limited, stale-index and malformed-provider cases pass. Query and raw
address never appear in persisted rows or captured application logs. Explain
plans match the filters SQL actually applied.

### UI16.5 — Existing-catalogue backfill and operations

**Objective:** index the current catalogue safely and leave a restartable
operator workflow for later backfills.

**May create or modify:**

```text
scripts/backfill_topic_search.py
tests/unit/test_topic_search_backfill.py
docs/RUNBOOK.md
docs/BUILD_PLAN.md
PROGRESS.md
```

**Must not touch:** embedding logic already owned by UI16.3, frontend, video
artifacts, Bunny objects, C11.

**Deliverables:**

- dry-run reporting eligible clip/document/passage counts, estimated provider
  tokens/current-price cost and missing metadata;
- enqueue-only backfill using the same worker path as future clips;
- bounded batch/concurrency controls;
- resume, status, retry-failed and stop procedures;
- index-version and source-hash coverage report;
- no-op behavior when rerun at 100% coverage.

**Acceptance:** a staging subset can be interrupted and resumed without duplicate
chunks or charges for already-current rows. Production backfill requires the
owner to approve the dry-run cost and start. Completion means every eligible clip
has an up-to-date keyword document and either current semantic coverage or an
explicit reviewed failure.

### UI16.6 — Search result page and “Tolkat som”

**Objective:** implement the approved mockup without changing the established
Pleni visual language.

**May create or modify:**

```text
web/src/App.tsx
web/src/styles.css
web/src/supabase.ts
web/src/types.ts
web/src/vite-env.d.ts
web/src/search/{api,state,types}.ts
web/tests/search-{api,state,render}.test.mjs
docs/assets/topic-search-results-mockup.svg
docs/BUILD_PLAN.md
PROGRESS.md
```

**Must not touch:** feed gesture/media scheduler, service worker cache policy,
database migrations, Edge implementation, numbered pipeline.

**Deliverables:**

- explicit submit and stale-request cancellation;
- identity results remain live and independent;
- interpretation/ambiguity UI;
- removable facets;
- event destination;
- accessible cardless clip rows with party-at-speech and excerpts;
- loading, fallback, partial, empty and error states;
- 20/20/20 local reveal;
- session-only restoration state;
- default-off feature flag behavior.

**Acceptance:** matches the approved 390×844 direction; keyboard and screen-reader
labels are complete; topic failures do not erase identity results; queries never
enter URL/localStorage/Clerk; TypeScript, Vite build, PWA verification and
focused UI tests are green.

### UI16.7 — Relevance feed and Back restoration

**Objective:** play results in the returned relevance order while preserving all
existing feed performance and navigation guarantees.

**May create or modify:**

```text
web/src/App.tsx
web/src/search/{state,route}.ts
web/tests/search-feed.test.mjs
docs/BUILD_PLAN.md
PROGRESS.md
```

**Must not touch:** `web/src/feed/snap-policy.ts`, service worker video bypass,
media-source window policy, database, Edge Functions, numbered pipeline.

**Deliverables:**

- row and “Spela alla” handoff;
- exact server-order collection;
- start-id selection;
- no “Senaste” refetch/reorder;
- Back restoration of query, response, reveal count and scroll;
- correct historical byline data where the search response supplies it;
- no captions created from excerpts.

**Acceptance:** first selected clip is active; swiping follows exact search order;
one playing video and at most four source-bearing video elements remain true;
Back is lossless within the session; deep-link and normal feed behavior remain
unchanged.

### UI16.8 — Relevance, privacy and controlled release

**Objective:** prove the feature useful and safe before enabling it for viewers.

**May create or modify:**

```text
tests/fixtures/search/{documents,judgments,expected}.json
scripts/evaluate_topic_search.py
tests/unit/test_topic_search_evaluation.py
docs/privacy/*
docs/RUNBOOK.md
docs/BUILD_PLAN.md
docs/TOPIC_SEARCH_IMPLEMENTATION_PLAN.md
PROGRESS.md
```

Production migrations/functions, OpenAI project settings, secrets, backfill and
InstaPods flag changes require explicit owner approval at each irreversible or
cost-bearing step.

**Deliverables:**

- at least 30 manually judged Swedish evaluation queries;
- keyword-only vs semantic-only vs hybrid comparison report;
- latency/load and index-lag evidence;
- private-table/RPC privilege matrix on real Postgres;
- OpenAI regional/retention evidence for the actual project;
- updated privacy copy;
- staged deploy/rollback rehearsal;
- physical-device search/feed acceptance;
- final owner go/no-go checklist.

**Acceptance gates:**

- hybrid nDCG@10 >= 0.75;
- at least 24/30 judged queries have a relevant top-three result;
- hybrid matches or beats both single retrieval methods;
- exact title/transcript matches rank in the top three;
- nonsense and absent topics do not receive semantic-only filler;
- submitted-search p95 < 1.5 seconds under agreed load;
- 100% eligible keyword coverage;
- semantic coverage 100% or every exception explicitly reviewed;
- future semantic-index lag p95 < two minutes;
- no private data or secret exposure;
- privacy and owner release approval complete.

Deploy with `VITE_TOPIC_SEARCH_ENABLED=false`. Apply migrations and functions,
backfill, validate, then enable the flag and rebuild InstaPods. Roll back by
disabling the flag; search tables and indexes may remain because they do not
affect publishing or the existing feed. A provider-spend emergency switch must
force keyword-only mode without a frontend rebuild.

**UI16.8 execution record, 2026-08-25:** implementation/evidence scaffolding is
complete but the release is **NO-GO**. The real catalogue has 3,188/3,188
keyword and semantic coverage with 4,160 chunks and the production private
privilege matrix passes. The 36-query fixture is not manually judged and the
three-mode capture could not complete because the local evaluation OpenAI key
returned HTTP 401. Eight bounded live endpoint probes measured p95 6,989.593 ms;
both negative probes returned semantic-only filler. Actual OpenAI project
region/retention, future-index-lag, staged rollback, physical-device and owner
approval gates remain pending. The authoritative matrix is
`docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`; the flag remains false and no
deployment/configuration change was made.

**UI16.9 execution record, 2026-08-25:** the stale process-credential precedence
bug is fixed and the valid project key completes a 36-query, three-mode capture
(344 tokens; two verified-event queries provider-free). `pleni-search-v2`
admits context-only results only with a keyword anchor, cosine ≥0.53 or Swedish
lexical coverage ≥0.67. Both negative queries are now empty while exact,
descriptive, low-cosine/lexically-grounded and structured positives retain
results. Migrations 027/028 and the v2 Function are deployed; 028 materializes
the 214,554-byte entity catalogue behind transactional entity-change triggers.
The original 6.99-second cold path is removed, but the fixed 30-request
post-cache sample still fails the strict gate at p95 2,027.124 ms, with 1,121 ms
inside the external embedding call at the p95 observation. OpenAI uses the
global API endpoint; actual project retention controls remain admin/dashboard
evidence. Manual judgments, future-index lag, privacy approval, rollback/device
acceptance and owner GO remain pending. The viewer flag is still false.

**UI16.15 execution record, 2026-08-26:** date broadening now over-fetches up to
the existing 60-result contract ceiling, removes candidates inside the original
inclusive date range, preserves the remaining server order and reapplies the
request limit. If no outside-range candidate remains, the original date facet
stays active and no broadening notice is emitted. The public contract, RPC,
embeddings and ranking calibration are unchanged. The notice now distinguishes
absence of relevant date-scoped matches from absence of catalogue clips. Live
acceptance for `elsparkcykel 30 mars` returned 25 broader results, none dated
2026-03-30; `elsparkcykel 22 juni` returned nine exact-date results with no
notice; and the unqualified topic query remained at 28 results.

## Evaluation fixture clarification

The 30+ evaluation queries are written by reviewers because search quality needs
repeatable evidence. They should cover:

- topic-only queries;
- person/party plus topic;
- explicit years and ranges;
- verified event occurrences;
- Swedish compounds, inflections and synonyms;
- descriptive questions whose exact wording is absent;
- quoted/exact phrases;
- historical names and party-at-speech cases;
- ambiguous people/events;
- nonsense and genuinely absent subjects.

For every query, judgments identify relevant clip ids and relevance grades. They
do not become search aliases, application code, suggested topics or a whitelist.
Deleting the fixture must not change what production queries are accepted.

## Testing matrix

| Layer | Required evidence |
|---|---|
| Migration discovery | deployed 018–021 stay immutable and checksum-matched; search uses 022+ with stable ordering |
| Database permissions | anon/authenticated cannot read private search tables or call private helpers |
| Keyword lifecycle | publish/update/reject/unpublish/delete convergence |
| Interpreter | exact, fuzzy-margin, ambiguous, disabled and topic fallback cases |
| Events | source-derived, recurring, year-disambiguated and unverified-event behavior |
| Passages | deterministic boundaries, overlap, hashes, empty/long/unusual Swedish text |
| Worker | claim/ack/retry, idempotency, partial failure and transactional replace |
| Provider | timeout, 429, malformed JSON, wrong count/dimension/order/non-finite vectors |
| Ranking | filters first, best passage, RRF, tie order, thresholds and no unpublished rows |
| Rate limiting | minute/day/global ceilings, HMAC rotation and 48-hour cleanup |
| Frontend | live identity, submit-only topic, facets, ambiguity, loading/fallback/error/empty, reveal |
| Feed | exact order, selected start, media ceiling, Back restoration |
| Privacy | no raw query/address persistence or logging; secrets server-only |
| Operations | dry-run cost, interrupted resume, coverage, failed-row recovery and rollback |

Each implementation chunk runs focused tests plus the repository defaults:

```text
python tasks.py test lint typecheck
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
```

Run the existing PWA verifier and the Edge Function TypeScript/test commands
registered by the implementing chunk. Live tests remain explicitly marked and
require the relevant owner-approved environment.

## Agent rules and handoff

Every UI16 implementation agent must:

1. Read `AGENTS.md`, `PROGRESS.md`, this document, its assigned
   `BUILD_PLAN.md` chunk and only the necessary dependencies.
2. Check the working tree and preserve unrelated/user-owned edits.
3. Verify the prior chunk is complete; do not paper over a missing dependency.
4. Stay inside the registered file scope.
5. Avoid changing `src/contracts.py`; UI16 does not require it.
6. Never deploy, backfill, create a paid provider resource or change a live flag
   without the explicit authority required by that chunk.
7. Record exact tests, migration/deployment state, counts and blockers.
8. Stop at the end of the assigned chunk.

Append this to `PROGRESS.md`:

```markdown
## UI16.N — <chunk name> — DONE / BLOCKED YYYY-MM-DD

**Built:** exact files and behavior.
**Tests:** exact commands and counts/results.
**Contracts touched:** search interface version; `src/contracts.py` must be none.
**Database state:** migrations written/applied/not applied; environment and ledger evidence.
**Deployment state:** functions/secrets/flags/backfill deployed or explicitly not deployed.
**Index state:** eligible documents, keyword-current, semantic-current, failed, index version.

**Decisions made:**
- ...

**Observations (not fixed, out of scope):**
- ...

**Blocked / needs a decision:**
- ...

**Next agent should know:**
- exact next chunk;
- required files and prior assumptions;
- recovery commands/state;
- any owner approval still required.
```

## Definition of done

UI16 is complete only when:

- all chunks are marked DONE with green acceptance evidence;
- every current eligible clip is keyword-searchable and semantically current or
  explicitly reviewed as failed;
- future published clips index automatically without a C11 code path;
- the interpreter’s visible facets exactly match enforced filters;
- open-ended topic, person/topic/year and verified-event examples work;
- the approved result design and exact-order feed handoff pass mobile QA;
- privacy, EEA/retention, rate-limit and spend controls are confirmed;
- feature flag rollout and rollback have been rehearsed;
- the owner explicitly approves production enablement.
