# Pleni privacy and legal pack

Last updated: 2026-08-09. Public notice version: `2026-08-09`.

This directory is the evidence pack for F0 in
`docs/RECOMMENDATION_PREREQUISITES.md`. The public Swedish copy rendered by the
app is canonical in `web/src/legal.ts`; these documents record why that copy
says what it says and what remains incomplete.

## Owner decisions recorded on 2026-08-09

- Anonymous visitors enter the public `Senaste` experience without onboarding,
  an age prompt, terms acceptance or a generic cookie banner.
- Clerk registration happens first. A signed-in account with no account-scoped
  onboarding record then sees the optional three-step onboarding flow.
- Users under 13 need a guardian's permission to use an account. Pleni does not
  collect birth dates, identity documents or an age-attestation field. The
  owner rejected a blanket 18+ rule and a mandatory age screen as
  disproportionate for public parliamentary content.
- Account creation presents links to the terms and privacy notice. The privacy
  notice is information, not something bundled into contractual acceptance.
- Optional personalisation stays off until affirmatively selected. The current
  release does not send viewing history or an inferred political profile to a
  Pleni server.
- Pleni has no advertising or first-party analytics. Political-interest data
  must never be passed to an advertising system.
- Public contact for general, privacy and content notices is
  `kontakt@pleni.se`.
- `Pleni AB` is planned but not registered. It must not be presented as the
  current legal operator. Exact legal name, organisation number, registered
  seat and establishment address remain a public-notice blocker.

## Documents

- `DATA_FLOW_INVENTORY.md` — current fields, systems, purposes, bases and
  retention criteria.
- `DPIA.md` — risk assessment for the current release and the planned political
  recommender, including the Article 22 conclusion.
- `OPERATING_POLICY.md` — minors, storage, advertising, DSA/comments,
  moderation, party balance, rights and incident handling.
- `PROCESSORS.md` — provider roles, transfer mechanisms and outstanding DPA
  checks.

## F0 status after UI12

| Item | Status | Evidence / remaining work |
|---|---|---|
| F0-1 DPIA | Drafted | `DPIA.md`; owner sign-off and re-run before server profiling launches. |
| F0-2 counsel | Decided | Owner accepts in-house analysis; no external counsel. |
| F0-3 Article 13 notice | Live for current processing | `web/src/legal.ts`; must be revised before watch-history profiling. |
| F0-4 data inventory | Drafted | `DATA_FLOW_INVENTORY.md`; verify provider log configuration. |
| F0-5 processors/transfers | Partial | Public mechanisms documented; execute/verify account DPAs and regions. |
| F0-6 retention | Partial | Current criteria documented; future telemetry/model periods remain gated. |
| F0-7 minors | Decided for V1 | No universal age gate; guardian permission under 13 for accounts; no age data. |
| F0-8 ePrivacy | Decided for V1 | Necessary auth and requested local features only; no analytics/ads. |
| F0-9 DSA | Conservative operating position | Treat comments as hosting for notice/action; formal classification remains. |
| F0-10 advertising | Decided | No ads and no reuse of political-interest data. |
| F0-11 security | Partial | Existing RLS/RPC/auth controls; incident and access audit remains. |
| F0-12 deletion/export | Not complete | Public request email exists; processor-wide tested runbook does not. |
| F0-13 party balance | Not complete | No neutrality claim; recommender policy still required. |
| F0-14 takedown | Implemented at product level | Comment reporting plus `kontakt@pleni.se`; operator runbook below. |

This pack records product decisions and engineering evidence. It is not a claim
that the unregistered operator information, provider contracts or future
recommendation system are already legally complete.
