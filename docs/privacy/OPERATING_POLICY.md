# Privacy, safety and legal operating policy

Decision record for the current release, 2026-08-09.

Implementation note, 2026-08-14: an explicit-choice rule recommender is present
behind `VITE_RECOMMENDATIONS_ENABLED=false`. It must remain inactive until the
open approval, retention, access-review and real-database test gates are closed.
Its first version excludes playback history, inference and exploration.

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

Current-release criteria are in `DATA_FLOW_INVENTORY.md`. Where no fixed job
exists, public copy states a purpose-based criterion rather than inventing a
number. Before future telemetry launches, the owner must approve and implement
fixed periods for raw events, served items, derived profiles, consent evidence,
backup copies and model lineage.

Deletion removes public comment text immediately but may retain a minimal row
and moderation evidence. Such retained data may not be reused for ranking or
marketing.

## Rights, deletion and export (F0-12)

`kontakt@pleni.se` is the current intake. For each request:

1. Record receipt date and scope.
2. Verify identity proportionately through the authenticated account/email;
   never request more identity data than needed.
3. Search Clerk, Supabase comments/reports/moderation, local-state instructions
   and relevant processor/support copies.
4. Respond within the GDPR deadline and explain any lawful limitation.
5. Record completion without keeping the exported/deleted content itself.

This is not yet an end-to-end tested automated runbook. The UI therefore does
not display fake “download my data” or “delete account” rows. Account management
continues through Clerk, while broader GDPR requests use the contact email.

## Party balance and editorial claims (F0-13)

- Pleni does not claim political neutrality or equal party exposure.
- `Senaste` is chronological by published time.
- The current `För dig` surface must not be described publicly as a behavioural
  server recommender while it does not collect/use such a profile.
- Before a real recommender launches, approve repetition caps, balance metrics,
  user controls and an explanation of the parameters/relative importance.
- No party or advertiser may buy placement through the recommendation system.

## Security and incidents (F0-11)

Current controls include publishable browser keys only, server/local secret
separation, Clerk JWT authentication, Supabase RLS/no direct private-table
grants, narrow security-definer RPCs, rate limits and private reporter/author
identifiers.

Incident minimum:

1. Contain credentials/access and preserve an audit trail.
2. Identify systems, subjects, categories, time range and likely harm.
3. Notify processors and assess IMY/data-subject notification deadlines.
4. Document the decision even when notification is not required.
5. Correct the cause, rotate secrets where relevant and update the DPIA.
