# Data protection impact assessment

Draft for owner approval, updated 2026-08-25. Scope: current Pleni web app plus the
planned personalised political-video recommender described in
`docs/RECOMMENDATION_LAUNCH_PLAN.md`.

## 1. Why a DPIA is required

The planned system evaluates internet behaviour and can infer political
interests, a GDPR Article 9 special category. The combination of systematic
evaluation/profiling and sensitive data is likely high risk. This DPIA must be
approved and re-run before watch history, exposure events or inferred political
state are collected from real viewers.

The current release is materially narrower: it serves a public feed, keeps
follows/preferences in account-scoped browser storage, and does not send watch
history or an inferred interest profile to Pleni's server. An explicit-choice
rule recommender now exists behind an inactive build flag. If separately
approved and deployed it stores selected/followed parties, followed politicians
and served slates, but still no watch history or inferred state. The former
left/right self-placement question has been removed.

The topic-search backend is deployed for evaluation but remains hidden behind
`VITE_TOPIC_SEARCH_ENABLED=false`. Search text is transient and is not used to
build a viewer profile, but a free-text query can itself contain personal or
special-category data and the residual topic is sent to OpenAI for an
embedding. This DPIA therefore treats the provider path as a launch gate even
though Pleni does not persist a query history.

## 2. Proposed processing

The future recommender may use explicit party/person choices, follows, served
items and playback signals to rank public parliamentary clips. The intended
benefit is relevance and discovery, not prediction of voting behaviour,
eligibility, creditworthiness, employment, health, policing or another
high-impact outcome.

Data subjects are Swedish/EU viewers with accounts. Politicians appearing in
the catalogue are also data subjects, but the high-risk viewer profile is the
focus of this DPIA.

## 3. Necessity and proportionality

- Anonymous and non-profiled `Senaste` must remain fully functional.
- Personalisation must default off and be enabled by a separate affirmative
  action with a versioned notice.
- No analytics or email consent may be bundled with political personalisation.
- Explicit choices should be preferred over behavioural inference.
- The system must collect only events that demonstrably improve the ranking;
  raw video URLs/CDN logs must not become a shadow analytics source.
- Age documents, exact date of birth and universal age assurance are not
  necessary or proportionate for public parliamentary content. Under-13 account
  use requires guardian permission in the terms; Pleni does not collect an age
  field in V1.
- No profile or event may be used for advertising or promoted political
  placement.

## 4. Article 22 conclusion

The present and planned feed ordering does **not** make a decision that produces
legal effects or similarly significantly affects a viewer. It changes the order
of public videos and always leaves a chronological alternative available.
Article 22 is therefore not expected to apply to the ranking decision.

This conclusion must be revisited if Pleni adds eligibility, access, pricing,
political persuasion services, account sanctions driven solely by automation,
or another consequential use. The fact that Article 22 is not triggered does
not remove the Article 5, 6, 9, 12–15, 21, 25, 32 and 35 obligations.

## 5. Risk register

| Risk | Likelihood / impact before controls | Required control | Residual position |
|---|---|---|---|
| Political preference leaks between people sharing a device | Medium / high | Storage keys include Clerk user id; anonymous/bare legacy keys are never adopted. | Low/medium; device owner can still inspect browser storage. |
| A breach reveals a named viewer's political profile | Medium / high | V1 uses a non-exposed `private` schema, service-only RPCs, Clerk JWT verification, explicit consent, immediate preference deletion on withdrawal, 30-day slate cleanup and authenticated data controls. Production privileges and lifecycle RPCs were exercised on 2026-08-14. | Accepted by the owner for explicit-choice V1; reassess before watch telemetry, inference or ML. |
| Consent is coerced by blocking the public feed | High / high | `Senaste` works without account or consent; onboarding appears only after sign-in and can be skipped. | Low. |
| Privacy notice is mistaken for contractual consent | Medium / medium | Separate terms and privacy links; no “accept privacy policy” checkbox. | Low. |
| Watch history is collected through CDN logs without consent | Medium / high | Do not join/access Bunny logs for recommendations; provider logs limited to delivery/security; document any future access. | Low/medium pending provider configuration audit. |
| Filter bubble or political imbalance | High / medium | Full chronological alternative, input controls, per-clip explanations, documented 5/2/2 mix and deterministic speech/speaker/party caps. No neutrality claim or paid placement. | Accepted for explicit V1; measurement remains required before learned ranking. |
| Minors are excluded or over-identified unnecessarily | Medium / medium | No universal age gate or DOB; clear under-13 guardian rule; child-readable information; risk-based reassessment for new features. | Low for current content. |
| Harmful/illegal comments remain public | Medium / high | In-context reporting, rate limits, moderation state, operator email, reasons and objection path. | Medium; response SLO and operator coverage need measurement. |
| Account deletion leaves comments or processor copies | High / high | Tested deletion/export runbook and Clerk lifecycle integration before claiming automated deletion. | Open; public notice directs requests to email and does not claim automation. |
| Staff or service credentials are over-privileged | Medium / high | Publishable keys only in browser, service secrets local/server only, revoked public table rights, narrow RPCs and operator audit. | Medium pending formal access review. |
| A sensitive topic query is retained, logged or connected to a viewer | Medium / high | No query in URL/local storage/Clerk/database/log summary; no Authorization-dependent result; daily one-way HMAC rate key only; tell viewers not to enter personal data. | Low/medium, but only after provider/account retention and log behavior are verified. |
| OpenAI receives topic text outside the intended region or for longer than disclosed | Medium / high | Server-only credential, embeddings endpoint only, no user id/address forwarded, verify actual project region/ZDR or retention setting, DPA and subprocessor terms before release. | **Open — release blocked.** Published provider defaults are not account evidence. |
| Semantic similarity invents relevance for nonsense or absent topics | High / medium | Negative-query benchmark, a calibrated no-result rule and feature-flag rollback. | **Open — the 2026-08-25 live sample returned unrelated semantic-only filler for both negative probes.** |

## 6. Safeguards and launch gates

Server-side personalisation may not launch until:

1. F1 private schema and versioned consent ledger are deployed and tested.
2. Turning consent off immediately stops event collection and serving from the
   profile, and deletion handles derived state/model lineage.
3. Provider DPAs, regions, subprocessors and transfer mechanisms are recorded.
4. Fixed retention jobs are tested against raw events, served items, derived
   profiles, backups and exports.
5. The privacy notice explicitly explains that viewing behaviour is used to
   infer political interests and describes meaningful recommender logic.
6. Party-balance and repetition policy is approved without claiming political
   neutrality.
7. Incident response, access review, export, deletion and takedown exercises
   have completed successfully.
8. The actual OpenAI project region/retention controls are captured and the
   topic-search notice is approved.
9. Negative queries return no semantic filler, submitted-search latency passes
   the agreed load gate, and physical-device acceptance is signed off.

The inactive rule-based implementation is engineering evidence for controls
1–2, not approval of them. Static migration tests and local Edge tests do not
replace deployment validation against the real database or owner approval.

## 7. Approval

Engineering draft complete: 2026-08-09.

Owner approval: **pending**. Approval of UI12 and its low-friction account flow
does not by itself approve collection of server-side watch history or inferred
political profiles.
