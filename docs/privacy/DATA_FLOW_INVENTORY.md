# Data-flow inventory

Current release inventory, updated 2026-09-04. “Basis” is the project's in-house GDPR
analysis under the F0-2 risk acceptance; it has not been reviewed by counsel.

The rule-based recommender and submitted topic search are available in the
normal public app. Their explicit `false` frontend flags are emergency kill
switches, not the ordinary production state. Migration 030 and the OPT4/OPT5
Function candidates have not been deployed by this change, so the current
production data flows below remain unchanged until a separate release.

Topic search is anonymous in the normal Search tab and shows the concise
OpenAI/private-information warning. The database, Edge Function and semantic
index are deployed. The following rows describe the public topic-search
boundary.

## Public topic-search boundary

| Data | Source → destination | Purpose | Basis / special-category position | Retention criterion |
|---|---|---|---|---|
| Submitted search text, maximum 120 characters | Viewer → Pleni `clip-search` Edge Function | Interpret a viewer-requested person, party, event, date or topic search | Article 6 legitimate-interest/service-request analysis is proposed but owner/legal sign-off is pending. A query about politics does not by itself prove the viewer's opinion, but free text can contain personal or Article 9 data; the UI must tell viewers not to enter personal information. | Request memory only. The raw query is not written to Pleni logs, database, URL, localStorage or Clerk. |
| Residual topic text | Pleni Edge Function → OpenAI Embeddings API | Create a 1,024-dimension vector used transiently to retrieve related public parliamentary clips | Same purpose as the submitted search. OpenAI is a processor for this operation. The actual project's EEA/data-residency and retention configuration must be verified before release. | Pleni stores no query vector or raw query. OpenAI documents no application state for `/v1/embeddings`; default abuse-monitoring logs may be retained for up to 30 days unless approved controls change that. Actual project status remains unverified. |
| Daily HMAC client key, global/client bucket, counts, bucket boundaries and expiry | Request network address → one-way daily HMAC inside Edge Function → `private.search_rate_limit_buckets` | Resist automated abuse and cap provider spend without storing a raw address | Legitimate interest in service security and cost control. The HMAC is deliberately not a stable viewer identifier. | Buckets expire after 48 hours and are deleted opportunistically. Raw address and query are not accepted by the storage RPC. |
| Search health bucket/booleans, versions, phase durations, rate-limit reason and actual embedding-token count | Pleni `clip-search` Edge Function → transient response headers and allowlisted server health log | Measure latency, reliability and projected provider cost without observing what a viewer searched for | Legitimate interest in service reliability, security and cost control. Exact result count, query/topic, identity/filter selections, embedding, address and user identity are excluded by a tested allowlist. | Response headers last for the request. Operational log retention follows the hosting platform policy; no query text or stable viewer key is present. Engineering benchmark reports use only committed smoke query ids. |
| Public catalogue document, deterministic passage, 1,024-dimension passage embedding and source/index hashes | Riksdagen/Pleni public clip metadata → private Supabase search tables | Keyword and semantic retrieval over already-public parliamentary material | Same public-catalogue legitimate interest as the source clip. Embeddings describe public speech content, not viewer behaviour. | While the eligible clip is published and current; update/reject/unpublish/delete triggers converge the private index. Stale source-hash/index-version rows are excluded. |

Official OpenAI documentation used for this inventory states that API data is
not used to train OpenAI models by default unless the organisation opts in,
that default abuse-monitoring logs may be kept for up to 30 days, and that the
embeddings endpoint stores no application state and is eligible for Zero Data
Retention. Those published defaults do not prove this project's account
setting: <https://platform.openai.com/docs/models/default-usage-policies-by-endpoint>.

## Browser and device-local state

| Data | Source → destination | Purpose | Basis / terminal-storage class | Retention |
|---|---|---|---|---|
| `riket.onboarding.v1:<clerk_user_id>`: selected parties, personalisation flag, completion time | Signed-in viewer → that browser only | Remember optional onboarding choices for that account | Explicit personalisation choice; storage requested by the viewer. Article 9(2)(a) is the planned condition if the choice is used to reveal political opinion. | Until changed or browser site data is cleared. Legacy `leaning` properties are ignored and disappear on the next write. |
| `riket.library.v1:<clerk_user_id>`: followed people/parties, saved/liked clip ids | Signed-in viewer → that browser only | Provide follows, saves and likes requested by the viewer | Necessary to provide the requested device-local feature. | Until toggled off or browser site data is cleared. |
| `pleni.analytics-consent.v1`: granted/denied, notice version, decision time | Viewer → that browser only | Remember and enforce the separate analytics choice | Necessary to remember the viewer's requested privacy setting; no Google storage before an analytics grant | Until the notice version changes or browser site data is cleared. |
| `_ga`, `_ga_<measurement-id>` after grant only | Google Analytics tag → viewer's first-party Pleni cookie jar | Distinguish browser sessions and calculate aggregate usage | GDPR 6(1)(a) consent and prior terminal-storage consent | Google documents up to two years; Pleni clears accessible GA cookies on withdrawal. |
| Player state: current time, duration, visible/active clip | Video element → React memory | Play, pause, seek and choose the active inline video | Necessary transient application state; not persistent terminal storage. | Page lifetime only. |

The former bare `riket.onboarding.v1` and `riket.library.v1` keys are not
adopted into an account. Doing so could assign one person's political choices
to the next person using the device.

## Clerk account and authentication

| Data | Source → destination | Purpose | Basis | Retention criterion |
|---|---|---|---|---|
| Clerk user id, email, optional name/username/photo, authentication method | Viewer → Clerk → Pleni session | Create and operate an optional account | Contract / steps requested by the viewer | While the account exists, then Clerk's necessary backup, security and legal periods. |
| Session token and client/security cookies (`__session`, `__client`, `__client_uat`, possible `_cfuvid`) | Clerk → browser | Authenticate requests, rotate sessions, resist abuse | Strictly necessary for requested sign-in | Short-lived/rotating session and the configured Clerk session/client lifetime. |
| Security/audit events, IP/device/request context | Browser → Clerk | Authentication security and abuse prevention | Legitimate interest in a secure account service | Clerk's configured and contractual security criteria; dashboard verification remains. |

No Clerk subject is exposed in public comment responses. Supabase receives the
short-lived Clerk JWT only for authenticated RPC calls.

## Supabase metadata and comments

| Data | Source → destination | Purpose | Basis | Retention criterion |
|---|---|---|---|---|
| Public clip, speech, source, politician and party metadata | Pipeline/Riksdagen → Supabase → all viewers | Public parliamentary catalogue | Legitimate interest in providing public political information | While accurate and useful; corrected or unpublished through operator review. |
| Comment profile: private Clerk id, public chosen username, suspension state | Account → Supabase | Stable public comment identity and moderation | Comment service contract; legitimate interest for safety | While comments/account moderation need the identity; no Clerk deletion cascade exists yet. |
| Comment: clip id, private author id, public username/body/time, status/deleted time | Account → Supabase → viewers (safe projection only) | Public discussion | Comment service contract; moderation legitimate interest | Visible until user deletion or moderation. Deletion blanks body but retains a minimal row/status. |
| Report: comment id, optional private reporter id, reason, state/times | Viewer → Supabase → operator only | Receive and resolve content notices | Legitimate interest; legal obligation where a valid illegal-content notice applies | Until the case, abuse prevention, objection and legal-claim needs end. Fixed cleanup is not implemented. |
| Moderation event: comment/author ids, action, reason, moderator, time | Operator → Supabase | Explain and audit restrictions | Legitimate interest; DSA evidence where applicable | While needed for objections, abuse patterns and legal claims. Fixed cleanup is not implemented. |

## Media, hosting and network delivery

| Data | Source → destination | Purpose | Basis | Retention criterion |
|---|---|---|---|---|
| Static asset request: IP, time, user agent, requested URL and network context | Viewer → InstaPods | Deliver and secure the web application | Legitimate interest / necessary transmission | Hosting provider configuration; verify in provider account. |
| Video/portrait request: IP, time, user agent, country and object URL | Viewer → Bunny CDN | Deliver media, route traffic, diagnose and secure CDN | Legitimate interest / necessary transmission | Bunny describes visitor logs as temporary/anonymised; account configuration and DPA must be verified. |
| Public source-link request | Viewer → riksdagen.se after deliberate link click | Open the official original source | Viewer-requested navigation; Riksdagen is a separate controller for its site | Riksdagen's own policy. |

A Bunny object URL identifies the requested clip. Pleni does not currently join
CDN access logs to a Clerk account or use them as a viewing-history profile.

## Optional aggregate analytics

| Data | Source → destination | Purpose | Basis / separation | Retention criterion |
|---|---|---|---|---|
| Client id, session context, IP/network request data, browser/device fields, approximate geography and current public page URL | Consenting viewer → Google Analytics 4 property `G-STDL8RHDCX` | Aggregate visits, devices, acquisition and geography | Consent. Google tag is absent before grant. No GA `user_id`, Clerk id, account fields or advertising consent. Google states GA does not log/store individual IP addresses. | GA event-level setting: 2 months; aggregate reports may remain longer; processor/security logs follow Google's terms. |
| `clip_impression`: public clip id, canonical clip page path, feed context/position and public duration | Consenting viewer → Google Analytics | Count one qualified content exposure after 72% visibility for one continuous foreground second | Consent; content performance only. Not joined to account, explicit preferences or recommender state and not an ad impression | Same GA retention. In-browser dedupe state lasts only for the current app session. |
| `video_start`, `qualified_view`, `video_progress`, `video_complete`, `watch_time` with clip id/context/duration and bounded measurement | Consenting viewer → Google Analytics | Understand real playback, three-second views, depth, completion and foreground time | Consent. Prefetch, samples, hidden tabs and repeated automatic loops excluded. Search text, comments, likes, saves, follows and political-interest fields forbidden | Same GA retention. Wall-clock accumulator is page-memory only and deleted after emission/exit. |

The canonical clip path necessarily identifies which public speech was viewed.
That can reveal political subject matter even without a named viewer. The
controls are prior opt-in, no account link, no Google Signals/advertising
consent, data minimisation, short event retention and immediate withdrawal.
Analytics remains separate from political personalisation and advertising.

## Purposes not present

- No account-linked, recommendation or advertising analytics. Optional
  consented aggregate GA4 analytics is described above.
- No advertising, ad measurement or promoted political placement.
- No email marketing.
- No server-side follows, saves, likes, onboarding preferences or inferred
  political-interest profile.
- No automated decision with legal or similarly significant effect.
- No saved search history, search-derived viewer profile or use of search text
  for recommendations, advertising, model training or suggested-search curation.

Any implementation that changes one of these statements must update this
inventory, the DPIA, the public notice version and the relevant consent/storage
surface before deployment.

## Inactive recommendation rollout boundary

If the owner approves the remaining F0 gates, deploys migrations 018/019 and the
Edge Functions, and enables the flag, V1 adds only these flows:

| Data | Source → destination | Purpose | Basis | Retention status |
|---|---|---|---|---|
| Versioned personalisation grant/withdrawal | Signed-in viewer → Clerk-authenticated Edge Function → `private.consent_records` | Prove and enforce the viewer's separate choice | Consent; Article 6(1)(a) and Article 9(2)(a) recorded with the notice version | Superseded records: 24 months. The latest state per purpose remains while current. |
| Explicitly selected/followed parties and followed politician UUIDs | Viewer/device cache → consent Edge Function → `private.viewer_preferences` | Order `För dig` using choices the viewer made | Explicit consent for political-interest personalisation | Deleted immediately on withdrawal, reset, recommendation deletion or Clerk account webhook. |
| Served personalised slate: request/item ids, algorithm version, clip, position, pool, reason and score components | Feed Edge Function → `private.feed_requests` / `private.feed_items` | Return an idempotent slate, suppress recent repeats and preserve the evaluation denominator | Same personalisation consent | 30 days; migration 020 schedules daily deletion and items cascade with the request. |
| Recommendation export/reset request audit: type, state, timestamps and non-content counts | Authenticated viewer → consent Edge Function → `private.data_subject_requests` | Complete and evidence the requested rights workflow | Compliance with the authenticated viewer's request | 24 months; export contents are returned to the viewer and are not stored in this table. |

The left/right question has been removed. V1 sends no likes, saves, watch time, playback event,
inferred interest, ad identifier or randomized exploration outcome. Anonymous,
signed-out and non-consenting viewers continue to use `Senaste` without a
persistent recommendation subject.
