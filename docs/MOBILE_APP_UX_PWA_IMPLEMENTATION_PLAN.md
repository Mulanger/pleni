# Pleni mobile app UX and PWA implementation plan

**Status:** Implementation complete; UI14.6 release/device acceptance in progress
**Created:** 2026-08-11
**Owner:** Pleni
**Parent chunk:** UI14 (registered in `docs/BUILD_PLAN.md` by UI14.0)
**Detailed source of truth:** this file

## Purpose

Make Pleni feel as close to a native mobile video app as the web platform allows,
both when somebody follows a normal shared link and when they install Pleni to
their home screen. Keep the existing React/Vite web architecture. This is not a
Flutter project, a native rewrite, or a wrapper project.

This plan is deliberately split into small, ordered chunks so different agents
can complete one chunk at a time without reinterpreting the product or touching
the same code concurrently.

## How agents must use this plan

1. Read `AGENTS.md`, `PROGRESS.md`, the UI14 entry in `docs/BUILD_PLAN.md`, and
   this entire file before changing code.
2. Check `git status` and preserve all unrelated work. Never stage or rewrite
   changes that were already present.
3. Work on exactly one UI14 chunk per session unless the owner explicitly asks
   for more.
4. Change that chunk's status to **IN PROGRESS** before implementation.
5. If reality invalidates the plan, update the relevant section and Decision
   log before changing the implementation. Do not silently widen scope.
6. Run the focused checks and the full acceptance commands listed for the chunk.
7. Add the required `PROGRESS.md` handoff, update the chunk to **DONE** or
   **BLOCKED**, and fill in its handoff record.
8. Stop after the handoff. The next agent starts the next numbered chunk.

Only these status values are valid: **NOT STARTED**, **IN PROGRESS**, **DONE**,
and **BLOCKED**. At most one chunk may be **IN PROGRESS**.

## Delivery tracker

| Order | Chunk | Outcome | Status | Depends on |
|---:|---|---|---|---|
| 0 | UI14.0 | Register the governed implementation scope | DONE | none |
| 1 | UI14.1 | Install metadata, manifest, and production icons | DONE | UI14.0 |
| 2 | UI14.2 | Service worker and bounded app-shell caching | DONE | UI14.1 |
| 3 | UI14.3 | Install, update, offline, and standalone experience | DONE | UI14.2 |
| 4 | UI14.4 | Mobile browser, gesture, input, and sharing polish | DONE | UI14.3 |
| 5 | UI14.5 | Feed render isolation and adaptive next-video loading | DONE | UI14.4 |
| 6 | UI14.6 | Real-device acceptance, release, and rollback drill | IN PROGRESS | UI14.5 |

## Product and design contract

### Visual thesis

The full-bleed parliamentary video remains the visual anchor. Feed chrome stays
dark, restrained, and subordinate to the speaker. Utility, profile, search, and
legal surfaces retain their existing light treatment. PWA work must not trigger
a visual redesign, add generic cards, or introduce ornamental interface chrome.

### Content plan

The feed stays the first and primary experience. Bottom navigation remains stable.
Installation support lives quietly in Profile and appears elsewhere only when a
platform event makes it immediately useful. Offline and update messages are short,
plain-language status surfaces rather than new destinations.

### Interaction thesis

Native CSS scrolling owns vertical movement. Controls respond immediately with
short pressed feedback. Install and update prompts are contextual and dismissible.
Motion explains state changes; it does not decorate the app. The regular shared-link
experience remains first-class and never nags users into installing.

## Baseline that must be preserved

The following behavior is already implemented and is not work to rediscover or
replace:

- Pleni owns the video controls; native controls are withheld.
- Feed video elements use standard and legacy inline-playback hints.
- Picture-in-Picture, remote playback, AirPlay promotion, and accidental native
  fullscreen are suppressed where browser APIs allow it.
- The active clip autoplays unmuted when permitted and falls back to muted playback
  when required. The first surface tap can unlock audio without pausing.
- A viewer-selected mute is never silently reversed.
- Leaving the feed or hiding the document pauses media. Stale `play()` promises
  cannot restart a detached or off-screen clip.
- Only the active video plays.
- Feed movement uses CSS scroll snap. `.feed-item` remains `height: 100%` of the
  scroll container, not a viewport unit, and `scroll-snap-stop: always` limits a
  fling to one clip.
- Source attachment is windowed to the active clip plus or minus one. Poster
  attachment is windowed to plus or minus three. This reduced a fresh feed from
  roughly 119 CDN requests to 5.
- Safe-area insets, bottom navigation, progress scrubbing, looping, comments,
  sign-in gates, and hash-based browser history already work.
- Widths at or above 700 px intentionally show the phone gate.

An implementation that regresses any item above fails acceptance even if its own
new feature works.

## Platform limits and non-goals

The team must not spend time trying to eliminate behavior that mobile browsers
do not expose to web pages.

- A normal Safari or Chrome tab will still have browser chrome. Standalone mode is
  the supported way to remove most of it.
- Autoplay with sound is browser-policy controlled; the existing muted fallback
  is the correct behavior.
- Some OS-owned media or volume surfaces cannot be suppressed completely.
- Do not build Flutter, React Native, a native wrapper, or a separate app.
- Do not add a JavaScript swipe library or replace native scroll snapping.
- Do not restore native video controls or force fullscreen playback.
- Do not change hash routing unless the host first gains a verified SPA fallback.
- Do not disable pinch zoom or use `user-scalable=no`.
- Do not add offline video downloads, background media downloads, push
  notifications, analytics, or personalization as part of UI14.
- Do not cache private Clerk/Supabase responses, tokens, comments, or MP4 bodies.
- Do not change the no-captions product decision, pipeline stages, published
  metadata contracts, video framing, or clip ordering.

## Cross-cutting engineering rules

- No `src/contracts.py`, pipeline, migration, camera, vision, render, or publish
  changes belong to UI14.
- New dependencies must be exact-pinned and justified in `docs/DEPENDENCIES.md`.
- Do not add a frontend test framework only for this project. Prefer pure helpers,
  TypeScript checks, build verification, small static-asset tests, and real-device
  acceptance.
- Keep PWA code in a small dedicated module/folder instead of spreading service
  worker lifecycle logic through `App.tsx`.
- Service-worker cache names must begin with `pleni-` and be versioned.
- Every caching rule needs an explicit maximum age or entry count.
- An update must never force-reload while a clip is playing or a comment is being
  written.
- Accessibility labels, keyboard focus, reduced motion, and pinch zoom remain
  functional.

---

## UI14.0 — Register the governed scope

**Depends on:** none. **Size:** tiny. **Status:** DONE 2026-08-11.

### Objective

Register UI14 in the repository's mandatory build-plan registry without changing
runtime code. `docs/BUILD_PLAN.md` remains the high-level chunk registry; this file
remains UI14's detailed implementation and status source.

### Scope — may modify

```text
docs/BUILD_PLAN.md
docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md
PROGRESS.md
```

### Scope — must not touch

All application code, dependencies, lockfiles, generated assets, tests, pipeline
files, and deployment configuration.

### Steps

1. Add one `UI14 — Mobile app UX and PWA` entry after UI13 in
   `docs/BUILD_PLAN.md`.
2. Make it depend on UI5, UI6, UI9, and UI10.
3. State the parent objective, non-goals, aggregate file scope, acceptance summary,
   and point to this file for ordered subchunks and narrower scopes.
4. Do not duplicate this detailed plan in `docs/BUILD_PLAN.md`.
5. Record the planning handoff in `PROGRESS.md`.

### Acceptance

- The build-plan entry and this document do not conflict.
- A new agent following the AGENTS.md read order can find UI14 and this plan.
- No runtime or dependency file changed.

### Validation

Documentation review and `git diff --check`. No application test is required for
this documentation-only chunk.

### Handoff record

- **Date:** 2026-08-11
- **Files changed:** `docs/BUILD_PLAN.md` and this implementation plan.
- **Validation:** UI14 registry scope and detailed-plan scope reviewed together.
- **Decision:** keep `docs/BUILD_PLAN.md` as the mandatory registry and this file as
  the detailed source of truth.
- **Blockers:** none.
- **Next chunk:** UI14.1.

---

## UI14.1 — Manifest, install metadata, and icons

**Depends on:** UI14.0. **Size:** small. **Status:** DONE 2026-08-11.

### Objective

Give Pleni valid install metadata and production launcher artwork while preserving
normal shared-link startup.

### Scope — may create or modify

```text
web/index.html
web/public/manifest.json
web/public/favicon.svg
web/public/icons/*
tests/unit/test_pwa_assets.py
docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md
PROGRESS.md
```

### Scope — must not touch

`web/src/App.tsx`, service-worker code, Vite configuration, dependencies, routing,
video behavior, data access, pipeline files, migrations, and generated media.

### Steps

1. Treat the current favicon geometry as the temporary canonical mark unless the
   owner supplies approved replacement artwork before this chunk starts. Do not
   invent a second logo.
2. Produce crisp PNG assets for 192×192 and 512×512 launch icons, a genuinely
   maskable 512×512 icon whose meaningful artwork stays within the central safe
   zone, and a 180×180 Apple touch icon. Keep source and export names unambiguous.
3. Add `manifest.json` with:
   - `name`: `Pleni`
   - `short_name`: `Pleni`
   - a stable `/` app `id`, `/` `start_url`, and `/` scope
   - `display: "standalone"`
   - feed-appropriate `theme_color` and `background_color`
   - the approved `any` and `maskable` PNG icons
   - no orientation lock in v1
4. Link the manifest and Apple touch icon from `index.html`. Add the appropriate
   iOS web-app title/capability metadata without disabling ordinary browser use.
5. Keep `viewport-fit=cover`, initial scale 1, and user zoom support.
6. Add a focused static test that parses the manifest and HTML, verifies required
   fields/links, verifies actual PNG dimensions, and confirms no zoom-disabling
   viewport directive was introduced.

### Acceptance

- `/manifest.json` and every referenced icon exist in a production build.
- Manifest paths resolve under the deployed root and do not depend on a hash route.
- Chrome's Application panel parses the manifest without an icon or scope error.
- The maskable preview does not crop the Pleni mark.
- iOS uses the Apple touch icon rather than a page screenshot.
- Opening `https://pleni.se/` as a normal link behaves exactly as before.

### Validation

From the repository root:

```powershell
python -m pytest tests/unit/test_pwa_assets.py
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
cd ..
python tasks.py test lint typecheck
git diff --check
```

Inspect the generated manifest and icons in `web/dist/`; do not commit `web/dist/`.

### Handoff record

- **Date:** 2026-08-11
- **Icon source:** retained the existing `favicon.svg` geometry and colors. Launcher
  PNGs use a full warm-white field; the maskable symbol is scaled to 76% around its
  centre so all meaningful artwork remains inside the maskable safe zone.
- **Files changed:** `web/index.html`, `web/public/manifest.json`,
  `web/public/icons/*`, `tests/unit/test_pwa_assets.py`, `docs/BUILD_PLAN.md`, this
  plan, and `PROGRESS.md`.
- **Validation:** 4 focused PWA asset tests passed; TypeScript and Vite production
  build passed; `python tasks.py test lint typecheck` passed with 379 tests and 68
  deselected; production preview returned 200 with `application/manifest+json` for
  the manifest and `image/png` for all four launcher assets.
- **Browser result:** the served manifest parsed as `Pleni`, `standalone`, with all
  three declared manifest icons. Final installed-device rendering remains in the
  required UI14.6 matrix.
- **Blockers:** none.
- **Next chunk:** UI14.2.

---

## UI14.2 — Service worker and bounded caching

**Depends on:** UI14.1. **Size:** medium. **Status:** DONE 2026-08-11.

### Objective

Add a predictable app-shell service worker that improves repeat launches and gives
installed users a usable offline shell without caching personal data or video.

### Scope — may create or modify

```text
web/package.json
web/package-lock.json
web/vite.config.ts
web/src/main.tsx
web/src/pwa/*
web/src/sw.ts
web/src/vite-env.d.ts
web/scripts/verify-pwa-build.mjs
docs/DEPENDENCIES.md
docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md
PROGRESS.md
```

### Scope — must not touch

Feed/player behavior in `App.tsx`, visual styling, Supabase/Clerk implementations,
hash routing, pipeline files, contracts, migrations, generated media, or host
deployment settings.

### Steps

1. Verify the current compatible release, exact-pin `vite-plugin-pwa`, and justify
   it in `docs/DEPENDENCIES.md`. Use `injectManifest` so cache behavior stays
   explicit and reviewable.
2. Add a small registration/lifecycle module under `web/src/pwa/`. Registration
   failure must not prevent the app from starting.
3. Precache only the revisioned production app shell emitted by Vite, including
   the offline navigation shell and essential local icons. Do not precache Bunny,
   Supabase, Clerk, or sample MP4 content.
4. Implement navigation network-first with the precached shell as the offline
   fallback. Hash routes must continue to resolve through the same document.
5. Use cache-first for immutable same-origin hashed assets.
6. If runtime image caching is added, limit it to public portrait/poster image
   requests, accept only successful/opaque image responses, and cap it at 40 entries
   and 7 days. Document the quota tradeoff.
7. Explicitly bypass every `video` request, Bunny MP4 URL, Range request, Supabase
   request, Clerk request, mutation, and non-GET request. These remain network/browser
   cache owned.
8. Version all `pleni-` caches and delete only obsolete Pleni-owned caches during
   activation. Never call a global cache clear.
9. Do not auto-`skipWaiting` for updates. Expose a message-based activation path
   for UI14.3 so the viewer controls when a waiting update takes over.
10. Add a production-build verifier that fails when the manifest, service worker,
    registration code, or offline shell is absent, or when an MP4 enters the
    precache manifest.

### Required caching table

| Request class | Strategy | Limit |
|---|---|---|
| Navigation/app shell | Network first, shell fallback | revisioned shell only |
| Same-origin hashed JS/CSS/fonts | Precache/cache first | build revisions |
| Public portraits/posters | Network/browser cache in v1 | no Cache Storage entries |
| Bunny MP4 / video / Range | Bypass service worker cache | none |
| Supabase and Clerk | Network only | none |
| Mutations and non-GET | Network only | none |

### Acceptance

- First online load registers and activates the worker without delaying React.
- A later offline reload renders Pleni's shell instead of the browser error page.
- Offline data failure is honest; it never presents stale personal state as current.
- Cache Storage contains no MP4, auth response, token, private API body, or mutation.
- A new build installs as waiting and does not reload the active page by itself.
- The app works normally when service workers are unsupported or registration fails.
- The production build verifier is green.

### Validation

```powershell
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
node .\scripts\verify-pwa-build.mjs
cd ..
python tasks.py test lint typecheck
git diff --check
```

Also inspect a production build over localhost in a Chromium Application panel:
worker lifecycle, precache contents, offline reload, Range/video bypass, and one
simulated update. Record evidence in the handoff.

### Handoff record

- **Date:** 2026-08-11
- **Dependency:** exact-pinned `vite-plugin-pwa` 1.3.0, whose published peer range
  includes Vite 8. The install also moved Vite's transitive `nanoid` from 3.3.16
  to the patched compatible 3.3.18; `npm audit` reports zero vulnerabilities.
- **Cache name and limit:** one `pleni-precache-<manifest fingerprint>` cache with
  9 same-origin app-shell entries (about 514 KiB in this build). No runtime image,
  video, API, auth, mutation or cross-origin cache exists.
- **Files changed:** `web/package.json`, `web/package-lock.json`,
  `web/vite.config.ts`, `web/src/main.tsx`, `web/src/pwa/register.ts`,
  `web/src/sw.ts`, `web/scripts/verify-pwa-build.mjs`, `docs/DEPENDENCIES.md`,
  this plan, and `PROGRESS.md`.
- **Validation:** TypeScript and the Vite production build passed; the build
  verifier executed install, activate, cache cleanup, offline navigation,
  cache-first shell delivery, bypass rules and message-only update activation;
  `python tasks.py test lint typecheck` passed with 379 tests and 68 deselected;
  `npm audit` is clean; production preview served `/sw.js` with HTTP 200.
- **Lifecycle result:** registration runs after React/load and fails open; a first
  worker precaches and claims clients; updates wait; `SKIP_WAITING` is accepted
  only through the exported viewer-action path. Real installed-browser lifecycle
  remains in UI14.3 and the mandatory UI14.6 device matrix.
- **Observation:** local `npm ci` could not replace Vite's already-loaded Windows
  native binary (`EPERM`); `npm install` restored the tree, the lock resolved
  deterministically, all builds passed, and this is not a source/deploy blocker.
- **Blockers:** none.
- **Next chunk:** UI14.3.

---

## UI14.3 — Install, update, offline, and standalone experience

**Depends on:** UI14.2. **Size:** medium. **Status:** DONE.

### Objective

Make installation discoverable without nagging, make standalone state useful, and
give users safe control over service-worker updates.

### Scope — may create or modify

```text
web/src/App.tsx                 # Profile/install and global status surfaces only
web/src/styles.css              # PWA/install/update/offline styles only
web/src/pwa/*
web/src/types.ts                # PWA UI types only, if needed
docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md
PROGRESS.md
```

### Scope — must not touch

Feed ordering, video playback logic, progress/seeking, media windows, comments,
library storage, sign-in gates, Supabase/Clerk data access, legal copy, routing
architecture, service-worker cache strategies, dependencies, pipeline files, and
migrations.

### Steps

1. Detect standalone mode with the standard display-mode media query and the iOS
   standalone property behind a typed compatibility helper.
2. Capture Chromium's install event in the PWA module. Do not trigger it on page
   load. Add a quiet Profile row/button that invokes it only after a viewer action.
3. On iOS Safari, show concise Add to Home Screen instructions from that same
   Profile entry. Do not pretend an automated prompt is available.
4. Hide install actions when already standalone, unsupported, dismissed for the
   current session, or not yet eligible. Never block feed access.
5. Add a minimal offline status message driven by browser state and actual fetch
   failure. `navigator.onLine` alone is a hint, not proof that the API works.
6. When a worker is waiting, show a small update action. Activation requires a
   viewer tap. Reload only after the new worker controls the page and only after
   confirming there is no active comment draft or active playback; otherwise defer
   until a safe point.
7. Keep normal-browser and standalone navigation behavior equivalent. Do not fork
   product logic based on install state.
8. Respect reduced motion and existing focus styles.

### Acceptance

- Eligible Chromium shows a Profile install action and invokes the browser prompt
  only after the user taps it.
- iOS Safari shows accurate manual instructions; installed iOS hides them.
- Installed launch uses standalone display and all safe areas remain correct.
- Dismissing install support does not affect normal use.
- Offline and update surfaces are accessible, dismissible, and do not cover video
  controls or bottom navigation.
- A waiting update never interrupts active playback or destroys typed text.
- Browser Back, deep hash links, sign-in, and signed-out feed access still work.

### Validation

```powershell
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
node .\scripts\verify-pwa-build.mjs
cd ..
python tasks.py test lint typecheck
git diff --check
```

Manually cover Chromium install acceptance/dismissal, iOS instruction detection,
standalone detection, offline transition, and a waiting-worker update.

### Handoff record

- **Date:** 2026-08-11.
- **Files changed:** `web/src/App.tsx`, `web/src/styles.css`,
  `web/src/pwa/platform.ts`, and `web/src/pwa/usePwaExperience.ts`.
- **Platform paths tested:** a production preview at a 390×844 mobile viewport
  exposed Chromium installation only after eligibility; a viewer tap invoked the
  prompt and its headless dismissal removed the row for the session. An isolated
  iPhone Safari simulation exposed the manual Add to Home Screen path, expanded
  all three steps, and hid installation when `navigator.standalone` became true
  while preserving the Profile hash route and active navigation state.
- **Offline/update evidence:** simulated offline and reconnect transitions showed
  and dismissed the live status surface. Its measured rectangle overlapped neither
  the mute control nor bottom navigation. A waiting-update event deferred while a
  real feed video played and a typed draft existed; clearing the draft retained
  the deferral, and leaving the feed released it at the next safe point.
- **Tests/build:** TypeScript, the Vite production build, and the PWA verifier are
  green. The verifier retains 9 app-shell entries and no video/private-data cache.
  `python tasks.py test lint typecheck` is green: 379 passed, 68 deselected, one
  existing `audioop` warning; lint and strict typing clean.
- **Decisions:** installation remains one quiet Profile group and never appears
  from page load alone. iOS manual help is limited to mobile Safari, because other
  iOS browsers cannot be assumed to expose Safari's exact share-menu path. Update
  safety reads the existing video and comment DOM state instead of changing their
  ownership or behavior. Standalone state only hides redundant install UI; routing
  and product behavior stay shared with the normal browser experience.
- **Known platform limitation:** physical iPhone/Android installation, installed
  safe-area rendering, and a deployed-build-to-deployed-build worker takeover
  remain mandatory in the UI14.6 real-device/release matrix.
- **Blockers:** none.
- **Next chunk:** UI14.4.

---

## UI14.4 — Mobile browser and interaction polish

**Depends on:** UI14.3. **Size:** small to medium. **Status:** DONE 2026-08-11.

### Objective

Remove avoidable browser friction without weakening accessibility or changing the
established player model.

### Scope — may create or modify

```text
web/index.html
web/src/App.tsx                 # Sharing, theme state, and interaction attributes only
web/src/styles.css              # Mobile interaction fixes only
web/src/pwa/*                   # Shared display-mode/theme helper only
docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md
PROGRESS.md
```

### Scope — must not touch

Feed ordering, autoplay ownership, mute fallback, source/poster window constants,
progress semantics, comments behavior, Supabase/Clerk access, navigation model,
service-worker strategy, dependencies, pipeline files, contracts, and migrations.

### Steps

1. Make browser/standalone theme color match the active visual surface: dark in the
   video feed and the existing light utility color elsewhere. Keep a correct static
   fallback in `index.html`.
2. On mobile input-capable layouts, make search, comment-handle, and comment text
   inputs at least 16 CSS px so iOS does not focus-zoom them. Do not disable zoom.
3. Add `touch-action: manipulation` to discrete controls where it cannot interfere
   with feed pan-y or progress scrubbing.
4. Scope `user-select: none` to video controls and gesture surfaces. Preserve text
   selection in comments, legal copy, profiles, and form fields.
5. Add short pressed feedback to tap controls. Keep it restrained and compatible
   with reduced motion.
6. Wire the existing Share control to Web Share when supported, with a clipboard
   copy fallback and an honest success/failure message. Share the canonical clip
   URL, not a transient CDN URL.
7. Recheck overscroll containment and safe areas in browser and standalone modes.
   Add a keyboard/VisualViewport workaround only if a reproducible device test shows
   the current CSS fails; document that reproduction before coding the workaround.
8. Reconfirm that video taps, vertical pan, seek gestures, and double-tap behavior
   do not compete.

### Acceptance

- Browser chrome color does not flash light over the dark feed and changes correctly
  on light screens where the platform supports dynamic theme color.
- Focusing a search or comment field on iPhone does not zoom the page.
- Pinch zoom, keyboard access, focus visibility, and text selection in reading/form
  surfaces still work.
- Share opens the native share sheet where available and copies a canonical link
  otherwise.
- Tap feedback does not delay actions or animate continuously.
- Vertical swipe, one-clip snap, seeking, mute, play/pause, and inline playback are
  unchanged.

### Validation

```powershell
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
cd ..
python tasks.py test lint typecheck
git diff --check
```

Manually check a 390×844 browser viewport, coarse-pointer emulation, keyboard-only
navigation, reduced motion, share success/fallback, and selection/zoom behavior.

### Handoff record

**Completed:** 2026-08-11.

**Files changed:** `web/src/App.tsx`, `web/src/styles.css`,
`web/src/pwa/theme.ts`, this plan, and `PROGRESS.md`.

**Reproducible issues fixed:** browser chrome now follows the dark feed and light
utility surfaces; mobile text inputs compute to 16 CSS px without disabling page
zoom; feed gestures preserve vertical pan, pinch zoom, and progress ownership;
pressed feedback respects reduced motion; and Share now uses Web Share or a
clipboard fallback with quiet cancellation and honest result text. Shared links
use the existing person/party clip route and reopen the exact clip, never its Bunny
media URL. No VisualViewport workaround was added because no failing reproduction
was found.

**Validation:** TypeScript and the Vite production build passed. The PWA verifier
still reports 9 app-shell entries with no video/private-data caching.
`python tasks.py test lint typecheck` is green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean. `git diff --check` passed.
A 390×844 Chromium production preview covered coarse-pointer touch, keyboard-only
focus, reduced motion, dynamic theme switching, 16 px inputs, reading/form text
selection, overscroll containment, native-share success/cancel, clipboard
success/failure, and exact shared-link landing. Visual review confirmed the longer
share feedback labels stay inside the action rail.

**Deferred browser-owned limitations:** physical iPhone focus behavior, Safari and
Android browser-chrome rendering, real native share sheets/clipboard permissions,
installed safe areas, and platform double-tap handling remain part of UI14.6's
device matrix.

**Blockers:** none.

**Next chunk:** UI14.5. Isolate feed rendering and add adaptive next-video loading
without changing the player lifecycle, feed order, media windows, or UI14.4 gesture
and sharing behavior.

---

## UI14.5 — Feed render isolation and adaptive next-video loading

**Depends on:** UI14.4. **Size:** medium. **Status:** DONE 2026-08-11.

### Objective

Make feed transitions feel immediate while retaining the request-window win and
avoiding waste on constrained connections.

### Scope — may create or modify

```text
web/src/App.tsx
web/src/feed/*
web/src/types.ts                # Feed-only types if extraction requires them
web/src/styles.css              # Progress/render-isolation styles only
docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md
PROGRESS.md
```

### Scope — must not touch

Supabase query shape, feed ranking/order, impression thresholds, engagement writes,
comments, library/sign-in rules, PWA cache rules, manifest, routing architecture,
dependencies, pipeline files, contracts, migrations, and generated media.

### Pre-change evidence gate

Before refactoring, record on the same production build and connection profile:

- fresh-feed Bunny request count before first interaction;
- time from active-index change to first rendered frame for the next clip;
- whether a progress tick rerenders all mounted feed items;
- active, source-attached, and poster-attached item counts;
- behavior with data saver or a simulated slow connection.

If the assumed all-row progress rerender is not reproduced, do not refactor for it.
Record the result and restrict this chunk to measured bottlenecks.

### Steps

1. Keep active-clip ownership in the feed screen, but isolate per-video transient
   playback state so `timeupdate` does not rerender unrelated rows. Use a memoized
   feed item or an equally small, measured solution; do not perform a broad App
   rewrite.
2. Preserve media refs, stale-play protection, visibility handling, mute intent,
   seeking, looping, impression tracking, and comment behavior exactly.
3. Preserve a hard maximum source attachment window of active plus or minus one
   and poster window of plus or minus three. Never restore unconditional `src` or
   `poster` attributes across the catalogue.
4. Track the most likely forward direction from active-index movement. On a
   confirmed non-data-saver, non-2G connection, allow only the predicted next clip
   to use `preload="auto"`; keep the previous neighbor at metadata.
5. When connection information is unavailable, default the next neighbor to
   metadata rather than assuming unlimited bandwidth. The active clip remains
   `auto`.
6. On data saver, 2G, or slow-2G, do not eagerly fetch a full next body. Retain
   enough metadata/poster behavior for a clear loading transition.
7. Treat Network Information API fields as optional hints behind a typed helper.
   Safari and unsupported browsers must follow the conservative default.
8. Do not service-worker-cache video or manually fetch MP4 blobs. Let the video
   element and HTTP Range/browser cache own media delivery.
9. Repeat the exact evidence capture and compare with the baseline.

### Performance gates

- A fresh feed must stay within 7 Bunny media/image requests before interaction,
  unless the handoff includes a reviewed resource-by-resource explanation. The
  current reference is about 5.
- Only the active video may play.
- No more than three video elements may have a source attached at once.
- No more than seven rows may have posters attached at once.
- A progress tick must not rerender every feed row.
- A strong downward fling still advances exactly one clip.
- The measured next-clip first-frame time must improve or remain neutral. A
  regression cannot be justified solely by cleaner code.

### Acceptance

All performance gates pass on a production build. Autoplay fallback, user mute,
first-tap audio unlock, pause/resume, seek, loop, visibility changes, detach safety,
impressions, comments, sharing, safe areas, and bottom navigation show no regression.

### Validation

```powershell
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
cd ..
python tasks.py test lint typecheck
git diff --check
```

Use the React profiler and browser network/media tooling on the production build.
Record comparable before/after numbers in the handoff; screenshots alone are not
performance evidence.

### Handoff record

**Completed:** 2026-08-11.

**Files changed:** `web/src/App.tsx`, `web/src/feed/network.ts`, this plan, and
`PROGRESS.md`. No styles, queries, service-worker rules, dependencies, routes, or
player contracts changed.

**Baseline and final measurements:** captured from production builds in a 390×844
headless Chromium viewport with touch/coarse-pointer emulation, browser cache
disabled, and the browser's reported `saveData=false` / `effectiveType=4g` profile.

| Gate | Before | After |
|---|---:|---:|
| Fresh Bunny media/image requests | 7 | 7 |
| Source-attached videos at top / middle | 2 / 3 | 2 / 3 |
| Poster-attached rows at top / middle | 4 / 7 | 4 / 7 |
| Playing videos | 1 | 1 |
| Rows performing work per progress commit | 60 | 1 |
| Active-commit to first frame, upper median over first 3 downward transitions | 81.3 ms | 69.9 ms |
| Play event to first frame, same transitions | 27.6 ms | 20.8 ms |

The seven fresh requests were four thumbnails, one visible politician portrait,
the active MP4, and the one source-window neighbor MP4. The helper does not create
requests itself. A strong fling still landed exactly one 844 px item ahead.

**Connection profiles:** confirmed 4G with Save-Data off gives `auto` to the active
clip and predicted neighbor only. Missing Network Information, Save-Data on, and
2G each produced `auto` / `metadata`. A live connection change from strong to
Save-Data changed the neighbor from `auto` to `metadata`. Chromium transport
throttling did not update `navigator.connection`, so the deterministic conservative
branches were additionally exercised by replacing that optional hint at runtime.

**Implementation:** the high-frequency current-time and duration state now belongs
to `FeedItemRow`, so a media clock tick no longer rebuilds the 60-row parent map.
`FeedScreen` retains refs and all playback ownership. It records the last committed
movement direction and gives eager preload to only that predicted neighbor when
the typed connection helper explicitly permits it. Unknown and constrained
browsers remain metadata-only for neighbors.

**Validation:** TypeScript, the Vite production build, and the PWA verifier passed;
the verifier still reports 9 app-shell entries and no video/private-data caching.
`python tasks.py test lint typecheck` is green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean. `git diff --check` passed.
Production-preview exercises also passed autoplay fallback, first-tap audio unlock,
explicit mute, pause/resume, 70% seeking, explicit looping, comments pause/resume,
sharing, hidden-page pause/resume, detach safety, direction reversal, safe layout,
and bottom navigation. Visual review found no feed layout change.

**Preserved invariants:** feed order and activation dwell are unchanged; only the
active video plays; source and poster windows remain ±1 and ±3; no MP4 is manually
fetched or service-worker-cached; autoplay/mute fallback, stale-play protection,
visibility cleanup, seek, loop, comments, sharing, and library/sign-in behavior
retain their existing owners and semantics.

**Blockers:** none.

**Next chunk:** UI14.6. Run the real-device browser/standalone matrix, deployment
acceptance, service-worker update/rollback drill, and release decision. Do not add
new performance architecture unless a real-device failure is reproduced.

---

## UI14.6 — Real-device acceptance, release, and rollback

**Depends on:** UI14.5. **Size:** medium QA/release. **Status:** IN PROGRESS.

### Objective

Prove that both shared-link and installed modes work on real mobile browsers, then
release with a rehearsed path out of a persistent bad service worker.

### Scope — may create or modify

```text
web/src/**                       # Only fixes for reproduced UI14 acceptance defects
web/public/**                    # Only fixes for reproduced UI14 acceptance defects
web/index.html
web/vite.config.ts
web/package.json
web/package-lock.json
web/scripts/verify-pwa-build.mjs
docs/DEPENDENCIES.md             # Only if dependency facts changed
docs/RUNBOOK.md
docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md
PROGRESS.md
```

### Scope — must not touch

Unrelated product work, visual redesign, ranking, data schema, auth architecture,
pipeline files, contracts, migrations, clip media, or host configuration without
explicit owner authorization.

### Device matrix

Record actual OS and browser versions. Emulation does not replace these rows.

| Mode | Required platform |
|---|---|
| Normal shared link | Current iPhone Safari |
| Installed/Home Screen | Current iOS/iPadOS Home Screen web app |
| Normal shared link | Current Android Chrome |
| Installed | Current Android Chrome standalone PWA |
| Normal shared link | Current Samsung Internet |

### Required scenarios on each applicable row

1. First shared-link visit while signed out.
2. Warm revisit and cold launch.
3. Install discovery, install, launch, close, and relaunch.
4. Deep hash link and browser/system Back behavior.
5. Autoplay allowed and autoplay-muted fallback.
6. First-tap audio unlock, user mute, pause/play, loop, and seek.
7. Ten consecutive strong vertical swipes: exactly one clip per swipe.
8. Slow network, lost network, restored network, and offline shell reload.
9. Background/foreground and screen lock/unlock.
10. Share sheet or clipboard fallback.
11. Search and comment keyboard focus without accidental zoom.
12. Safe areas in portrait, including notched devices and installed mode.
13. Sign-in modal and return to the same app state.
14. Waiting service-worker update during playback and during a text draft.
15. Update accepted at a safe point, followed by correct controller takeover.
16. Cache inspection proving no MP4 or private response is present.

### Release steps

1. Run all checks from a clean production build.
2. Confirm the deployment still uses the documented root install/build commands;
   do not change InstaPods settings speculatively.
3. Obtain explicit owner authorization before pushing or deploying.
4. Deploy, then verify the manifest, icons, service-worker file, MIME types, scope,
   HTTPS, normal shared-link load, and installed launch on `https://pleni.se/`.
5. Confirm the new worker reaches activated/controller state on a fresh install and
   waiting state on an update.
6. Monitor browser console, network failures, feed request count, and API/auth
   behavior through the smoke test. No new analytics system is part of this chunk.
7. Record the deployed commit and results in `PROGRESS.md` and this handoff.

### Required rollback drill

Document in `docs/RUNBOOK.md` and test locally before release:

- how to deploy a corrected service worker under the same scope;
- how to publish an emergency worker that activates, deletes only `pleni-` caches,
  unregisters itself, and reloads only after viewer-safe takeover;
- why merely removing registration code does not remove an already installed worker;
- how to verify recovery in normal and installed modes;
- how to restore the last known-good build after worker cleanup.

Do not run the emergency unregister path in production as a drill. Test it under a
local production origin and keep the procedure ready.

### Final acceptance

- Normal shared links remain fast and fully usable without installation.
- Android installation is offered when eligible and launches standalone.
- iOS Add to Home Screen launches standalone with correct icon and safe areas.
- Offline reload shows an honest Pleni shell, not a browser failure or fake current
  data.
- Updates are viewer-controlled and preserve playback/drafts until a safe point.
- Cache Storage contains no MP4, private API response, token, or mutation.
- The feed remains within the request and attachment budgets from UI14.5.
- All baseline player and navigation behavior remains green across the matrix.
- The production manifest, service worker, icons, and start URL return successfully.
- Rollback instructions are complete and locally rehearsed.
- The full acceptance suite, TypeScript, Vite production build, PWA build verifier,
  and `git diff --check` are green.

### Validation

```powershell
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
node .\scripts\verify-pwa-build.mjs
cd ..
python tasks.py test lint typecheck
git diff --check
```

### Handoff record

Fill when complete: release date, deployed commit, every device/browser version,
scenario results, cache inspection, request/performance measurements, rollback drill
result, known browser-owned limitations, and any post-release follow-up. Mark UI14
**DONE** only when every required device row and final acceptance item is complete.

### UI14.6 execution record — 2026-08-11

**Status:** local acceptance and rollback rehearsal complete. The owner authorized
the production push after this preflight; physical-device acceptance remains open,
so UI14 is not done.

**Local production origin:** Chrome `151.0.7922.108`, Windows, `390×844`, fresh
isolated profiles, `http://127.0.0.1:5199/`.

- A fresh TypeScript/Vite production build and `verify-pwa-build.mjs` passed with
  nine bounded app-shell entries.
- The manifest returned 200 as JSON, declared standalone
  display, `/` start/scope and three manifest icons. The active worker controlled
  the page under `/`.
- Cache Storage contained nine same-origin shell entries and no MP4, Range,
  Bunny, Supabase or Clerk response. A deliberate unrelated cache survived both
  normal activation and emergency cleanup.
- The feed mounted 60 rows but attached only two video sources and four posters at
  the top; exactly one video played. Every video used custom controls, inline and
  vendor-inline attributes, Picture-in-Picture disablement and remote-playback
  disablement. The bottom navigation ended exactly at the 844 px viewport edge.
- Ten consecutive strong touch swipes stopped at `844, 1688, …, 8440` px: exactly
  one 844 px feed item per swipe, with one playing video after every transition.
- Search navigated to `#/sok?feed=senaste`, its input computed to 16 px, and browser
  Back returned to the exact `#/hem/senaste` feed state. The cached shell reloaded
  while transport was offline and stayed controlled; the platform offline event
  displayed the honest Pleni offline status. Physical lost/restored-network
  behavior remains in the device rows below.
- A corrected worker at the existing URL/scope installed in waiting state while
  one video continued playing. The old controller and document stayed unchanged;
  after playback was paused, the activation message produced `controllerchange`
  and an activated replacement without changing the document identity.
- The emergency worker locally activated over a controlled production preview,
  did not reload an actively playing document, deleted only the `pleni-` cache,
  retained the unrelated cache, posted `PLENI_EMERGENCY_WORKER_READY` and left zero
  registrations. Restoring the known-good build and reopening the same profile
  produced an activated normal controller and recreated only the Pleni shell cache.
  The exact emergency TypeScript in `docs/RUNBOOK.md` also passed a standalone
  strict TypeScript compile.

**Pre-deployment origin check:** `https://pleni.se/` returned 200, but
`/manifest.json`, `/sw.js` and all four new PNG launcher assets returned
404. This was the expected state before the UI14 worktree was pushed.

**First production deployment:** commit `968749e` reached `origin/main` on
2026-08-11. The app, worker and icons returned 200, but InstaPods served the
`.webmanifest` file as `application/octet-stream`. UI14.6 treated this as a real
installability defect and changed the linked file to `/manifest.json`, which the
host serves as `application/json`; the correction shipped in the production
release below.

**Production release:** corrective commit `235227c` reached `origin/main` and
InstaPods on 2026-08-11. A fresh production profile verified `/manifest.json` as
`application/json`, standalone display, `/` start/scope, an activated controlling
worker under `https://pleni.se/`, nine same-origin app-shell cache entries and no
video/private origin in Cache Storage. The live 390×844 feed mounted 60 rows with
two sources, four posters, one playing video, no native controls, stable bottom
navigation and no runtime exceptions. Physical-device rows remain pending.

**Owner device checkpoint:** the owner confirmed on 2026-08-11 that the deployed
app works on their phone and subsequently confirmed that they could download the
controlled `21b0bd7` update on a Samsung device. This proves real-device delivery
of the first installed-update build, but the model, OS/browser version, exact
launch mode and playback/takeover observations are not recorded, so it does not
yet close a mandatory matrix row. Worker-only commit `6b35faf` is the second
controlled update and isolates text-draft protection without changing player or
UI behavior.

| Mode | Required platform | Result |
|---|---|---|
| Normal shared link | Current iPhone Safari | **PENDING** — physical device/version required |
| Installed/Home Screen | Current iOS/iPadOS Home Screen web app | **PENDING** — deployment and physical install required |
| Normal shared link | Current Android Chrome | **PENDING** — physical device/version required |
| Installed | Current Android Chrome standalone PWA | **PENDING** — deployment and physical install required |
| Normal shared link | Current Samsung Internet | **PENDING** — physical device/version required |

**Release state:** base deployment and automated live-origin verification are
complete at `235227c`; controlled installed-update delivery is confirmed for
`21b0bd7`, and draft-safety update `6b35faf` is the next Samsung check. Run every
required scenario on the five physical rows and change this status to DONE only
after all rows pass.

---

## Definition of done for UI14

UI14 is done only when all seven tracker rows are **DONE** and the evidence shows:

1. Pleni continues to work well from an ordinary shared web link.
2. Avoidable mobile browser friction is reduced without disabling accessibility.
3. Installed Pleni launches and behaves like a stable standalone video app.
4. App-shell caching improves repeat/offline startup without caching video or
   private data.
5. Next-video preparation improves or preserves measured transition time within the
   defined request and attachment budgets.
6. Existing inline playback, media lifecycle, one-clip snapping, safe areas, bottom
   navigation, auth, comments, and hash navigation do not regress.
7. A bad service-worker release has a documented and rehearsed recovery path.

## Decision log

Add dated entries here only when the plan changes materially.

- **2026-08-11:** Keep React/Vite and native CSS scroll snapping. No native rewrite
  or wrapper.
- **2026-08-11:** Use an explicit `injectManifest` service worker. Video and private
  API responses remain outside Cache Storage.
- **2026-08-11:** Installation stays optional and contextual in Profile. Shared-link
  users receive the complete product.
- **2026-08-11:** Do not lock orientation in the first PWA release.
- **2026-08-11:** Separate implementation into one-agent chunks with hard file scopes,
  measurable gates, and a handoff after each chunk.
- **2026-08-11:** UI14.2 leaves public portraits/posters to the HTTP browser cache
  in v1. The service worker caches only the same-origin app shell, avoiding opaque
  cross-origin quota and staleness until image-cache value is measured.
