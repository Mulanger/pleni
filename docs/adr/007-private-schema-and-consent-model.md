# ADR 007: Private schema and consent model

Date: 2026-08-02

## Status

Accepted — structure only. The **values** this schema records (which purposes,
which Article 6 basis, which retention periods) are decided by `F0` and are not
settled by this ADR.

## Context

Prerequisites `C-1` … `C-13`, `T-1` … `T-3`.

Everything the recommender learns about a viewer is, in this domain, data
revealing political opinions: Article 9 special-category data. The current app
holds it in React state — `liked`, `saved`, `following`, `followedParties`,
`consent` are all `useState` in `App.tsx`, so nothing survives a reload and
nothing has ever been transmitted. That is why there is still a clean choice to
make about where it goes.

The `public` schema is exposed through PostgREST. Every table in it is one
mistaken `grant` away from being world-readable, and the project has already had
exactly that failure once: `publish_clip_batch` was `SECURITY DEFINER` with the
Postgres default `PUBLIC` execute grant still in place, reachable with the
publishable key (`P0-1`, closed by migration 002).

## Decision

### 1. Viewer data lives in a `private` schema that PostgREST cannot see

Political content stays in `public`. Viewer behaviour, consent records and
inferred interest state go in `private`, with `usage` revoked from `anon` and
`authenticated`, and `private` absent from the API's exposed schema list.

This is defence in depth on purpose. RLS is the second line, not the first: a
policy bug in `public` leaks a row, and the same bug in a schema PostgREST does
not serve leaks nothing, because there is no route to the table at all. Access is
exclusively through Edge Functions using the service-role connection (ADR 005),
which means every read of this data passes through code we wrote and can audit.

### 2. Consent is an append-only ledger, not a boolean column

`private.consent_records` records subject, purpose, granted-or-withdrawn, the
Article 6 basis, the Article 9 condition, the notice version, the UI surface that
collected it, and timestamps. **A withdrawal is a new row.** Nothing is ever
updated in place.

A boolean that flips cannot answer "what did this person agree to, and to what
text, on the day we started profiling them?" — which is the only question that
matters in an audit two years later. Current state is a query over the ledger
(latest row per subject per purpose), not a stored field.

### 3. Purposes are separate, and default to denied

Personalization, analytics, email and model-training reuse are four independent
consents (`C-4`). One "improve my experience" switch is not specific enough to be
valid. Absence of a row means denied — there is no default-grant path, and the
current `useState({ personal: true, email: true })` mockup is replaced outright
(`C-5`; the defaults were already flipped to `false` in the previous session, but
they are still in-memory and enforce nothing).

### 4. Enforcement is server-side; the toggle is a display of state

A single helper in the Edge Function, called by both endpoints, decides whether
personalization is permitted (`C-6`). Consent absent → `for_you` is refused and
falls back to `Senaste`; personalization events are rejected or stripped. The UI
switch shows what the server believes, and changing it is a request to the server
— it is never the mechanism.

Withdrawal takes effect on the **next** request: in-flight personalized calls are
cancelled and the client outbox is purged for that purpose (`C-7`).

### 5. Explicit choices stay separable from inferred ones

`private.viewer_preferences` carries a `source` of `explicit` / `follow` /
`inferred`. Collapsing them would make "edit my interests" impossible to
implement honestly, because the UI could not show which affinities the person
chose and which the system guessed about them.

### 6. Subject keys are `text`

`clerk_user_id text`, per ADR 006. Not `uuid`, not a foreign key to `auth.users`,
which does not exist here.

### 7. Anonymous requests create no rows

A no-consent `Senaste` request is not attached to a stable subject and leaves no
viewer history (`T-5`). This is testable and must be tested: drive a full
anonymous session, assert zero `private` rows.

## Consequences

Every read of viewer data costs an Edge Function invocation. There is no path
where the browser queries this data directly, and that is the point.

Deletion has to be built, not assumed. A Clerk `user.deleted` webhook must cascade
across consent records, preferences, inferred state, raw events and cached slates
(`A-14`), and the same code path must serve in-app deletion (`A-15`).

Retention jobs must actually run (`C-12`). A retention policy that is written down
and not implemented is worse than none, because it creates a documented promise
the system does not keep.

The ledger grows monotonically. That is acceptable — consent evidence is small,
and its whole value is that it is not overwritten.

**This ADR fixes the shape, not the content.** Which purposes exist, which lawful
basis each one rests on, and how long each row is kept are `F0` decisions
(`F0-1`, `F0-2`, `F0-3`, `F0-6`). The schema is deliberately built to hold
whatever those answers turn out to be, so the legal work and the engineering work
can run in parallel — but no consent may be collected from a real user before
`F0` has produced them.

## Contracts Impact

None. `src/contracts.py` describes pipeline artifacts; viewer data never enters
it (see ADR 008).
