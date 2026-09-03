# UI20 — Complete desktop parity

This document is the source of truth for the work that remains before Pleni's
desktop product has feature parity with the released mobile product. It tracks
implementation, verification and production rollout one independently releasable
chunk at a time.

## Goal and definition of complete

Desktop is complete when every real mobile route has a functional presentation
at widths of 1100 px and wider, no route falls through to
`DesktopComingSoon`, and each route preserves the same data, account and privacy
semantics as mobile.

Completion does **not** include a tablet product. Widths from 700 through 1099 px
continue to show the honest phone gate. It also does not reactivate comments;
UI19's global comment switch remains the product decision for both mobile and
desktop.

A chunk may move to `DONE` only when all of the following are true:

1. Its implementation and focused automated tests are committed.
2. Frontend Node tests, TypeScript and the production build pass.
3. The PWA verifier still reports the bounded app shell with no video/private
   data.
4. `python tasks.py test lint typecheck` passes, or a genuinely pre-existing
   failure is recorded under Blocked in `PROGRESS.md` without being suppressed.
5. Its required desktop and mobile regression viewports are visually checked.
6. The chunk is released from `main`, smoke-tested on `pleni.se` and handed off
   in `PROGRESS.md`.

## Status dashboard

Allowed states are `NOT STARTED`, `IN PROGRESS`, `DONE` and `BLOCKED`. Do not use
subjective percentages. Overall completion is the number of `DONE` rows divided
by the nine listed rows, including the completed UI17 baseline.

| Chunk | Deliverable | Status | Production evidence |
|---|---|---|---|
| UI17 | Desktop shell, Home feed, inspector and debate feed | DONE | Released 2026-09-02; see `PROGRESS.md` |
| UI20.0 | Shared desktop architecture and route outlet | IN PROGRESS | `2968d16` on `main`; InstaPods still served the prior bundle at the first release check |
| UI20.1 | Politician and party pages | IN PROGRESS | Implementation and local production-data checks complete; release waits for the UI20.0 InstaPods gate |
| UI20.2 | Search and search-result feed | IN PROGRESS | Locally implemented; production verification deferred until the combined desktop release |
| UI20.3 | Following | NOT STARTED | — |
| UI20.4 | Profile, account and onboarding | NOT STARTED | — |
| UI20.5 | Saved clips and legal pages | NOT STARTED | — |
| UI20.6 | Cross-route integration and quality | NOT STARTED | — |
| UI20.7 | Final production acceptance and closeout | NOT STARTED | — |

**Current completion:** 1 of 9 deliverables is `DONE`.

When a chunk changes state, update this table in the same commit as its
`PROGRESS.md` handoff. Production evidence must name the live route/viewports
checked; a local screenshot alone is not production evidence.

## Locked product and design decisions

### Visual thesis

Pleni desktop is a calm parliamentary newsroom: navy navigation, a warm light
workspace, real portraits and video as the visual anchors, strong editorial
hierarchy and thin dividers instead of a mosaic of generic cards.

### Content plan

- The persistent sidebar orients the viewer and owns top-level navigation.
- Each route has one primary workspace: feed, search results, followed entities,
  profile settings or editorial profile content.
- Secondary context appears beside the primary workspace only when it helps the
  current task; it must not become decorative dashboard chrome.
- Empty, loading, offline and error states use real application state and concise
  utility copy.

### Interaction thesis

- Route content uses one restrained fade/translate transition to preserve
  orientation.
- Interactive rows, clips and controls use a consistent hover/focus lift or
  background reveal.
- Returning from a focused clip feed restores the prior route, selected item and
  scroll position.
- All non-essential motion is removed under `prefers-reduced-motion`.

### Responsive contract

- 0–699 px: released mobile product; no desktop CSS may change its layout.
- 700–1099 px: existing phone gate; no videos or desktop workspace mount.
- 1100–1279 px: compact desktop with one content column where necessary.
- 1280–1439 px: normal desktop with two columns on routes that benefit from it.
- 1440 px and wider: roomier spacing, never a stretched reading measure.
- 125% browser zoom at a nominal 1440 px display must remain usable without
  horizontal page overflow.

### Non-negotiable architecture

- Keep one `AppRoute` model, one set of Supabase/Edge readers and one Clerk
  session. Desktop is a presentation, not a parallel application.
- Extend shared screens with an explicit presentation mode or thin desktop
  composition. Never copy their data fetching or account mutations.
- Every focused clip collection uses the existing `FeedScreen`; only one video
  may play and no more than four video elements may be mounted.
- Keep the current 540×960 MP4 and WebP artifacts. No new render size, Bunny
  namespace or backfill belongs to UI20.
- Do not change `src/contracts.py`. No database migration is expected. If a real
  data gap appears, stop that chunk and document the required schema decision.
- Do not introduce fabricated counts, trends, engagement or hardcoded Bunny
  URLs. Desktop search omits the mobile example-only “popular debates” block.
- UI19 keeps comments hidden globally. The dormant desktop comment inspector is
  not a completion blocker and must not be independently enabled.

## UI20.0 — Shared desktop architecture

**Status:** `IN PROGRESS`  
**Depends on:** UI17.  
**Primary scope:** `web/src/App.tsx`, `web/src/styles.css`,
`web/src/desktop/*`, focused frontend tests.

### Build

- Replace the single `DesktopComingSoon` fallback with a route-aware desktop
  outlet that understands every existing `AppRoute` without changing hashes.
- Add restrained shared primitives for desktop page headers, bounded content,
  sections, back actions, and loading/empty/error states.
- Keep route state and data ownership in `App`; primitives receive state and
  callbacks rather than fetching independently.
- Define route-transition and focus-restoration hooks once for later chunks.
- Keep unsupported routes on their existing waiting page until their own chunk
  is complete; do not expose half-built screens.

### Acceptance

- Desktop Home remains byte-for-behaviour equivalent to UI17.
- Mobile, phone gate and desktop are mutually exclusive at 699/700/1099/1100 px.
- Direct links and browser Back/Forward select the correct desktop outlet.
- Changing viewport while video plays pauses and safely unmounts the old surface.
- Shared primitives have visible keyboard focus and reduced-motion behavior.

## UI20.1 — Politician and party pages

**Status:** `NOT STARTED`  
**Depends on:** UI20.0.  
**Primary scope:** shared person/party presentation in `web/src/App.tsx`, desktop
styles, route/layout tests. Existing data readers stay authoritative.

### Build

- Present politician identity, portrait provenance, party, role and constituency
  as a compact editorial identity area beside the real clip catalogue.
- Present party identity, verified logo, real counts, recent clips and politician
  list with the same follow controls as mobile.
- Use one column at 1100–1279 px and a stable identity/content split from 1280 px.
- Open person/party clips in the desktop `FeedScreen`; Back restores the profile
  and its previous scroll position.
- Support direct `person`, `person-clips`, `party` and `party-clips` hash routes,
  reload and browser history.
- Do not reproduce the current decorative profile-share buttons unless they gain
  a real share action with an honest success/failure result.

### Acceptance

- Real portraits/logos, initials fallback, totals, loading, empty and network
  failure states match mobile data semantics.
- Follow/unfollow uses the existing sign-in guard and account-bound library.
- A profile clip opens with one player; return restores the same profile and clip
  grid position.
- No horizontal overflow at 1100×720 or 125% zoom; portrait and clip imagery are
  never distorted.
- Mobile person and party screenshots remain unchanged.

## UI20.2 — Search

**Status:** `NOT STARTED`  
**Depends on:** UI20.0 and UI20.1.  
**Primary scope:** shared search presentation, desktop styles, existing
`web/src/search/*` state/route helpers and focused frontend tests.

### Build

- Bring the complete public search surface to desktop: person, party and topic
  search; party filters; interpretation facets; ambiguity choices; event result;
  date broadening; keyword fallback; pagination and all honest failure states.
- Use one results column at 1100–1279 px. From 1280 px, keep topic clips as the
  primary column and identity/party results as secondary context.
- Retain the OpenAI privacy note and the existing topic-search feature switch.
- Do not show example “popular debates” on desktop. The neutral initial state may
  show the real party directory and search guidance only.
- Route “Play all” and individual clip results into the same desktop
  `FeedScreen`; Back restores query, interpretation, revealed count and scroll.

### Acceptance

- Person/party row selection opens the desktop profile implemented in UI20.1.
- Search request cancellation and stale-response protection are unchanged.
- Exact date, broadened date, ambiguity, keyword fallback, empty and error cases
  render correctly with production-shaped fixtures.
- Search collections keep server order and historical bylines and mount no more
  than four videos.
- Mobile search behavior and layout remain unchanged.

## UI20.3 — Following

**Status:** `NOT STARTED`  
**Depends on:** UI20.0 and UI20.1.  
**Primary scope:** shared Following presentation, desktop styles and account/
navigation regressions. No new persistence layer.

### Build

- Render real followed parties and politicians with verified logos/portraits and
  clear unfollow actions.
- Use a single list flow at compact desktop and parallel Party/Politician regions
  from 1280 px when both contain data.
- Give signed-out viewers an honest sign-in state using the existing Clerk modal;
  never create anonymous follow data.
- Open rows on the corresponding UI20.1 profile. Unfollow must stop row navigation
  and reuse the existing library mutation funnel.
- Preserve honest empty, loading and network-failure states without sample rows.

### Acceptance

- Signed-out state writes nothing; signed-in state is isolated per Clerk user.
- Follow/unfollow updates the desktop list and the feed/profile controls
  consistently.
- Row navigation and unfollow cannot fire together.
- Keyboard order, labels and focus restoration work in both one- and two-column
  layouts.
- Mobile Following remains unchanged.

## UI20.4 — Profile, account and onboarding

**Status:** `NOT STARTED`  
**Depends on:** UI20.0 and UI20.3.  
**Primary scope:** shared Profile/account/onboarding presentation, desktop
styles, PWA placement and focused auth/privacy tests.

### Build

- Adapt signed-out, unavailable-Clerk and signed-in account states for desktop.
- Surface real saved/followed totals and route shortcuts without inventing
  aggregate data.
- Adapt interest editing and onboarding for desktop while keeping one data model,
  consent ledger and mutation path.
- Preserve personalization enable/withdraw, data export, reset and delete with
  their existing sign-in requirements and honest progress/error messages.
- Place install, offline and update state once. Keep the existing rule that an
  update waits while video or a protected draft is active.
- Use a primary account/library column and a secondary preferences/privacy column
  from 1280 px; collapse to one ordered column on compact desktop.

### Acceptance

- Clerk modal flows, account switching and sign-out preserve library isolation.
- Interest and personalization choices update the existing feed behavior.
- Export produces the existing JSON contract; reset/delete retain confirmations,
  error handling and server semantics.
- Onboarding is keyboard operable, focus-contained where appropriate and usable
  at 1100×720 without clipped actions.
- Mobile Profile, onboarding and PWA surfaces remain unchanged.

## UI20.5 — Saved clips and legal pages

**Status:** `NOT STARTED`  
**Depends on:** UI20.0 and UI20.4.  
**Primary scope:** saved/legal presentation in `web/src/App.tsx`, desktop styles,
existing legal content and route tests.

### Build

- Adapt the saved archive into an editorial desktop clip grid using real
  thumbnails, dates and durations plus honest loading, empty and error states.
- Open a saved clip in the same desktop `FeedScreen`; Back restores archive
  position and the selected item.
- Render Terms, Privacy, Storage and About as a calm readable document surface
  with a bounded measure, local section navigation where useful and the existing
  unchanged legal copy.
- Preserve all legal hash routes and their return path to Profile.
- Do not add decorative or non-functional controls.

### Acceptance

- Saved ordering and account guard match mobile; missing/deleted clip IDs remain
  honest rather than becoming demo content.
- Saved collection playback respects the four-video ceiling and returns to the
  same archive position.
- Every legal route survives direct load, reload, Back/Forward and cross-links.
- Reading width, heading hierarchy, keyboard focus and link contrast pass at all
  desktop breakpoints.
- Mobile Saved and Legal remain unchanged.

## UI20.6 — Cross-route integration and quality

**Status:** `NOT STARTED`  
**Depends on:** UI20.1–UI20.5.  
**Primary scope:** desktop integration, accessibility/performance regressions and
small corrections inside completed UI20 scopes only.

### Build

- Exercise Home ↔ Search/Following/Profile ↔ person/party/saved/legal ↔ focused
  feeds as one coherent navigation system.
- Standardize Back/Escape, focus restoration, scroll restoration, active sidebar
  state, landmarks, headings and visible focus.
- Apply the locked route transition and consistent hover/focus feedback; remove
  all non-essential motion under reduced motion.
- Audit 1100 px and 125% zoom for horizontal overflow, clipped controls and
  unreadable columns.
- Audit media scheduling across every route transition: one playing video, at
  most four mounted videos, bounded posters and no duplicated MP4 requests.
- Remove `DesktopComingSoon` only after all route branches have real accepted
  destinations.

### Acceptance

- A route matrix covers every `AppRoute`, direct hash, reload and Back/Forward.
- Automated checks cover one-player ownership, four-video ceiling and no desktop
  double-fetch regression.
- Keyboard-only and reduced-motion passes cover every desktop route.
- No route shows sample content as production data or a dead action.
- Mobile feed snap, bottom navigation, search and profiles retain their accepted
  behavior.

## UI20.7 — Production acceptance and closeout

**Status:** `NOT STARTED`  
**Depends on:** UI20.6.  
**Primary scope:** tests, release evidence, this document, `PROGRESS.md` and
runbook updates required by observed operations. No feature work.

### Automated gate

- Run all frontend Node tests.
- Run direct TypeScript validation and Vite production build.
- Run the PWA build verifier; its cache must exclude video, private origins and
  authenticated responses.
- Run `python tasks.py test lint typecheck`.
- Require `git diff --check` and a clean release worktree.

### Visual and behavioral matrix

- Desktop: 1100×720, 1280×720, 1440×900 and 1920×1080.
- Zoom: 125% at a desktop viewport that crosses into the compact layout.
- Mobile regression: 360×800 and 390×844.
- Account matrix: Clerk unavailable, signed out and signed in.
- Network/state matrix: loading, empty, offline, recoverable error and PWA update.
- Media matrix: Home, search feed, person feed, party feed, debate feed and saved
  feed.

### Release and rollback

- Release each prior functional chunk independently through `main`; do not wait
  for UI20.7 to discover integration failures.
- For final closeout, confirm `origin/main`, wait for the new InstaPods asset,
  smoke-test `pleni.se` and record its asset identifier and live routes.
- Roll back the frontend commit first on a UI incident. UI20 is expected to add
  no migration, Bunny object or pipeline artifact requiring data rollback.
- Mark UI20.7 and the parent UI20 `DONE` only when every dashboard row is `DONE`,
  `DesktopComingSoon` is unreachable/removed and no mobile route lacks a desktop
  destination.

## Working protocol for each future session

1. Read `AGENTS.md`, `PROGRESS.md`, the relevant UI20 chunk here and its listed
   dependencies.
2. Start from a clean worktree based on current `origin/main`; never reuse or
   overwrite the owner's dirty local backfill branch.
3. Change the selected dashboard row to `IN PROGRESS` when implementation begins.
4. Stay inside that chunk's primary scope. Record out-of-scope discoveries
   instead of fixing them opportunistically.
5. Complete focused tests and the shared release gate.
6. Release only that accepted chunk, smoke-test its live routes and update the row
   to `DONE` with concise production evidence.
7. Append the required `PROGRESS.md` handoff before ending the session.

## Explicitly out of scope

- A tablet UI below 1100 px.
- Captions, a new video aspect ratio or a new media backfill.
- Comment reactivation or new social/engagement features.
- A frontend framework/router rewrite.
- New recommendation or search ranking behavior.
- New analytics presented as popularity, views or engagement.
- Pipeline, worker, Bunny or Supabase schema changes unless a later chunk stops
  and receives a separately documented data decision.
