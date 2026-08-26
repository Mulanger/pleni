# Privacy, safety and legal operating policy

Decision record for the current release, updated 2026-08-14.

Implementation note, 2026-08-14: the owner approved the explicit-choice V1
policy and its production release. It excludes playback history, inference and
exploration. `VITE_RECOMMENDATIONS_ENABLED=false` is now an emergency kill
switch rather than the normal release state.

Topic search is separately present behind `VITE_TOPIC_SEARCH_ENABLED=false`.
Its backend evaluation does not authorise a viewer release.

## Topic-search query handling

- Search text is transient input. Do not add it to URLs, analytics, error logs,
  local storage, Clerk metadata, database rows, support traces or suggested
  searches.
- Do not connect topic queries, result clicks or result-feed playback to an
  account, advertising id or recommendation profile.
- Only the residual topic text may be sent to the configured embeddings
  endpoint. Do not send a Clerk id, IP address, rate-limit HMAC or result click.
- The public search surface must say that OpenAI helps interpret a submitted
  topic and ask viewers not to enter personal information.
- Provider unavailability or a kill switch falls back to keyword search. A
  nonsense or absent topic must return an honest empty state, not semantically
  adjacent filler.
- The OpenAI account's actual regional and retention settings, DPA and
  subprocessor position must be recorded before the viewer flag can be enabled.
- Raw queries must not be reused to fine-tune models, create aliases, populate
  “trending searches” or train a ranking system without a separate inventory,
  lawful-basis assessment, notice and owner decision.

## Minors and onboarding (F0-7)

- Public parliamentary video is available without an account or age check.
- Onboarding appears only after Clerk reports a signed-in account and only when
  that account has no account-scoped completion record.
- A user under 13 needs guardian permission to use an account. The rule is
  stated during account creation and repeated in onboarding.
- Pleni does not collect date of birth, an age band, identity documents or an
  age-verification token in V1.
- The decision is risk-based: universal age assurance for general-audience
  parliamentary content would add identifying data and friction without a
  proportionate safety benefit. Reassess if direct messaging, adult content,
  payments, targeted advertising or materially riskier interactions appear.
- Information aimed at account users must remain short, plain and readable by
  younger viewers.

## Cookies and terminal storage (F0-8)

- Anonymous viewing has no Pleni analytics or advertising storage.
- Clerk auth/session storage is classified as strictly necessary only when the
  viewer asks to register, sign in or use an authenticated feature.
- Library localStorage is written only after a signed-in viewer follows, likes
  or saves something and is necessary to remember that requested feature.
- Onboarding localStorage is written only after a signed-in viewer completes or
  skips the flow. Personalisation defaults off.
- Any new analytics, marketing, cross-site or non-essential storage requires a
  fresh inventory entry and a prior consent choice with equal accept/reject
  prominence. Continued browsing is never consent.

## Advertising firewall (F0-10)

Pleni carries no advertising, sponsored ranking or promoted political
placement. Viewer political-interest data, follows, watch history and inferred
state may not be disclosed to or queried by an ad system. Introducing any such
feature is a separate legal/architecture project and cannot be enabled by a
configuration flag in the existing recommender.

## Comments, DSA and notice/action (F0-9/F0-14)

The formal DSA classification remains open. Comments are ancillary to Pleni's
editorial catalogue, but Pleni takes the conservative operational position that
storing and displaying user comments requires a hosting-style notice/action
path even if an online-platform classification or particular small-enterprise
obligation is later found not to apply.

Current paths:

1. In-context comment report: spam, harassment, hate, private information,
   illegal content or other.
2. Detailed notice: `kontakt@pleni.se`, including exact URL/comment, reasons and
   contact information.
3. Operator decision: hide, restore or delete through the existing moderation
   RPC; reports move to reviewed.
4. Reason/objection: notify the affected user where contact is available and
   accept objections at the same email. Do not expose the reporter's identity
   unless legally necessary.
5. Urgent safety/life threats: preserve relevant evidence, restrict access and
   contact competent authorities when legally required.

The operator should acknowledge detailed notices without undue delay and make
a timely, diligent, objective decision. A fixed response SLO and notification
automation are still operational work.

## Retention (F0-6)

Current-release criteria are in `DATA_FLOW_INVENTORY.md`. V1 uses these fixed
database periods:

- served recommendation requests/items: 30 days;
- explicit preferences: until withdrawal, reset, deletion or account deletion;
- superseded consent evidence and completed recommendation-rights requests: 24
  months; the newest consent state per purpose remains while it is current.

Migration 020 schedules a daily `pg_cron` cleanup and was exercised against the
production schema. V1 creates no raw playback event, inferred profile or model
lineage row, so no period is assigned to data that does not exist. Provider
backup and log deletion windows remain governed by the verified provider
configuration and processor terms.

Deletion removes public comment text immediately but may retain a minimal row
and moderation evidence. Such retained data may not be reused for ranking or
marketing.

## Rights, deletion and export (F0-12)

Profile now provides authenticated JSON export, recommendation reset and
recommendation deletion. All three derive the subject from a verified Clerk
JWT and use service-only RPCs. Clerk account deletion is designed to reach the
same deletion RPC through the signed Svix webhook. `kontakt@pleni.se` remains
the intake for broader processor-wide and account/comment requests. For each
request:

1. Record receipt date and scope.
2. Verify identity proportionately through the authenticated account/email;
   never request more identity data than needed.
3. Search Clerk, Supabase comments/reports/moderation, local-state instructions
   and relevant processor/support copies.
4. Respond within the GDPR deadline and explain any lawful limitation.
5. Record completion without keeping the exported/deleted content itself.

The recommendation-only grant, slate, export, reset and deletion workflow was
exercised in a rollback-only production test on 2026-08-14. Account management
continues through Clerk, while broader GDPR requests use the contact email.

## Party balance and editorial claims (F0-13)

- Pleni does not claim political neutrality or equal party exposure.
- `Senaste` is chronological by published time.
- `För dig` is described as an explicit-choice rule feed, never as politically
  neutral or as a behavioural/ML profile.
- The approved V1 mix targets 5 fresh interest, 2 fresh general and 2 older
  interest positions per first ten, with the remaining planned adjacency slot
  falling back transparently because topic adjacency is disabled.
- Per ten, the ranker initially caps one speech at one clip, a preferred party
  at five clips (other parties at three), one speaker at two clips and adjacent
  speaker repetition. Soft caps relax deterministically only when inventory is
  too sparse; the served item records each relaxation.
- Profile exposes the input controls, every recommended clip carries a reason,
  and `Senaste` remains a full chronological alternative.
- No party or advertiser may buy placement through the recommendation system.

## Security and incidents (F0-11)

Current controls include publishable browser keys only, server/local secret
separation, Clerk JWT authentication, Supabase RLS/no direct private-table
grants, narrow security-definer RPCs, rate limits and private reporter/author
identifiers. The 2026-08-14 production check confirmed that `anon` and
`authenticated` have no `private` schema usage and cannot execute profile or
slate RPCs; only Edge Functions use the service role.

Incident minimum:

1. Contain credentials/access and preserve an audit trail.
2. Identify systems, subjects, categories, time range and likely harm.
3. Notify processors and assess IMY/data-subject notification deadlines.
4. Document the decision even when notification is not required.
5. Correct the cause, rotate secrets where relevant and update the DPIA.
