# Data-flow inventory

Current release inventory, 2026-08-09. “Basis” is the project's in-house GDPR
analysis under the F0-2 risk acceptance; it has not been reviewed by counsel.

## Browser and device-local state

| Data | Source → destination | Purpose | Basis / terminal-storage class | Retention |
|---|---|---|---|---|
| `riket.onboarding.v1:<clerk_user_id>`: leaning, selected parties, personalisation flag, completion time | Signed-in viewer → that browser only | Remember optional onboarding choices for that account | Explicit personalisation choice; storage requested by the viewer. Article 9(2)(a) is the planned condition if the choice is used to reveal political opinion. | Until changed or browser site data is cleared. |
| `riket.library.v1:<clerk_user_id>`: followed people/parties, saved/liked clip ids | Signed-in viewer → that browser only | Provide follows, saves and likes requested by the viewer | Necessary to provide the requested device-local feature. | Until toggled off or browser site data is cleared. |
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

## Purposes not present

- No first-party web analytics.
- No advertising, ad measurement or promoted political placement.
- No email marketing.
- No server-side follows, saves, likes, onboarding preferences or inferred
  political-interest profile.
- No automated decision with legal or similarly significant effect.

Any implementation that changes one of these statements must update this
inventory, the DPIA, the public notice version and the relevant consent/storage
surface before deployment.
