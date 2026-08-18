# AGENTS.md

Standing rules for every coding session on this repo. Read this before doing anything.

## Read order

1. **This file** — the rules.
2. **`PROGRESS.md`** — what's done, what's next, what's blocked. This is the source of truth for state.
3. **`docs/BUILD_PLAN.md`** — find your assigned chunk. Read only that chunk plus its dependencies.
4. **`docs/ARCHITECTURE.md`** — the design reasoning. Reference it; don't re-litigate it.
5. **`src/contracts.py`** — the shared data types. Every stage speaks these.

## What this project is

A pipeline that takes a Swedish parliamentary debate video from Riksdagen webb-tv and produces vertical, speaker-centred short clips. Heavy video/image files live in Bunny Storage/CDN. Supabase stores metadata, source/speech/clip rows, features, engagement events, jobs and publish state. The current product decision is **no captions**; do not assume an ASS/VTT caption artifact exists.

The pipeline is a chain of **numbered stages**. Each stage reads the previous stage's artifact from disk and writes its own. No stage calls another stage directly.

```
work/<dokid>/
  master.mp4                          # C2
  analysis.wav                        # C2
  frames/%06d.jpg                     # C2
  00_source.json                      # C1
  01_media.json                       # C2
  02_scenes.json                      # C2
  03_speeches.json                    # C3
  04_transcript/<speech_id>.json      # C4
  05_audio_features/<speech_id>.json  # C5
  06_candidates/<speech_id>.json      # C6
  06_vision/<speech_id>.json          # C6v  speaker visibility, feeds C7
  07_selected/<speech_id>.json        # C7
  08_track/<clip_id>.json             # C8
  09_camera/<clip_id>.json            # C9
  10_render/<clip_id>_540x960.mp4     # C10 primary
  11_publish/<clip_id>.json           # C11
```

This layout is not incidental. It is what makes each stage independently runnable, testable and resumable, and what lets you work on stage 7 without ever running stage 2.

**`06_vision` must exist before C7 runs.** It is the only artifact whose absence
does not raise: C7 falls back to choosing clip windows blind, exactly as it did
before ADR 013, and yield drops by roughly half without anything failing. The
fallback is deliberate — it keeps old work dirs and the fixture runner working —
but it means *running the stages by hand in the wrong order silently produces a
worse catalogue*. C7 logs `vision_timeline_missing` at warning level for every
speech it cannot find one for. If you see that line, you skipped C6v.

## Current state snapshot

Last updated: 2026-08-11.

### Repository and deployment

- **The pipeline runs on the owner's local Windows workstation, not in the cloud.** It needs
  local ffmpeg. InstaPods hosts the *static frontend only* and knows nothing about the
  pipeline, the job queue or the orchestrator.
- **There is a GTX 1080 in that machine but nothing uses it.** `torch` is installed as
  `2.11.0+cpu` and `cuda.is_available()` is False. Nothing currently needs it: ASR does not
  run, because C4 uses Riksdagen's official transcript with distributed word timings
  (ADR 011). The `gpu` worker pool is a naming artifact, not a hardware requirement. Vision
  (C6v and C8) is OpenCV on CPU. A debate now takes roughly 12-15 minutes end to end, up
  from 9, because C6v runs detection and identity over whole speeches.
- **⚠ That workstation cannot sustain all-core load.** Seven hard power-offs in one session,
  every one under sustained multi-core work, with no bugcheck, no minidump and no WHEA
  entry — power being cut, not software crashing. One of them zeroed a golden file
  mid-write. Kernel-Power 41 events go back to January, so it predates any of this. Until
  it is diagnosed, **set `RIKET_FFMPEG_THREADS=2`** in `.env`; it caps decode and encode and
  defaults to `0`, meaning ffmpeg uses everything. Suspect PSU or cooling.
- Because that machine sleeps and reboots, discovery is catch-up (watermark-based), never
  tick-based, and every job is idempotent and resumable. Start everything with
  `python -m src.orchestrator.cli daemon`. See `docs/RUNBOOK.md`.

- **The project is called Pleni.** "Riket" / "Riket TV" is the old name. It survives in
  infrastructure identifiers that are deliberately *not* renamed — the Bunny zone
  `riketnlooigm`, the InstaPods pod `rikettv`, the `RIKET_` env prefix and the
  `riket.*` localStorage keys. See `docs/RENAME_TO_PLENI.md` for why each one stays.
- Git is initialized. Remote: `https://github.com/Mulanger/pleni.git`. Main branch: `main`.
- Public web app: `https://pleni.se/` (also `https://www.pleni.se/`). The pod hostname
  `https://rikettv.nbg1-3.instapods.app/` still works and is the DNS target, but it is no
  longer the address to give anyone.
- InstaPods pod: `rikettv`, static runtime, auto-deploys from `origin/main`.
- Current production/main closeout commit: `0bb6dd2` (`docs(UI14): close mobile
  PWA release`). The latest frontend worker acceptance release is `6b35faf`.
  UI14.0–UI14.6 are complete; detailed evidence and accepted device-coverage gaps
  are in `docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md`.
- The React app lives in `web/`, but the InstaPods Git deploy currently runs from the repo root. Its working settings are:
  - Install command: `cd web && npm ci`
  - Build command: `cd web && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node ./node_modules/vite/bin/vite.js build && cd .. && rm -rf ./assets ./index.html ./dist && cp -R web/dist/. ./`
  - Static host serves the pod root, so the build command copies `web/dist` contents to root. Do not change this back to a plain `npm ci` at repo root.
- Frontend env vars in InstaPods:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`
  - `VITE_CLERK_PUBLISHABLE_KEY` — **production** `pk_live_…` since 2026-08-06.
    Vite bakes `VITE_*` in at build time, so changing it in the InstaPods panel does
    nothing until the next deploy rebuilds the bundle.
- **Clerk production is live**: `clerk.pleni.se` (Frontend API) and `accounts.pleni.se`
  (account portal), five CNAMEs in the Simply zone, SSL issued. The development
  instance `leading-seasnail-33.clerk.accounts.dev` still exists and is still
  registered in Supabase — local dev uses it via `web/.env.local`. Supabase
  Third-Party Auth therefore has **two** Clerk entries; deleting the dev one breaks
  local sign-in, deleting the prod one breaks the live site.
- **Following, saving and liking require a signed-in account.** The gate is a single
  guard in `updateLibrary()` (`web/src/App.tsx`), the one funnel all four toggles
  pass through; a signed-out tap opens Clerk's modal and writes nothing. Storage is
  keyed `riket.library.v1:<clerk-user-id>` so two people on one device get separate
  libraries. The anonymous feed, search and playback still work signed out — F1's
  acceptance criterion is that `Senaste` keeps working signed out.
- Do not put server secrets in Vite env vars. Bunny API keys, Supabase access tokens and Supabase secret/service keys belong only in local/server worker environments.

### Pipeline completion

- Completed chunks: C0, C1, C1b, C2, S1, C3, R1, C4, C5, C6, C7, C8, C9, C10, C11,
  plus the framing rebuild V1-V7 (see `PROGRESS.md`, and ADRs 012 and 013).
- Frontend mobile/PWA chunks UI14.0–UI14.6 are also complete. The release keeps
  the React/Vite web architecture; there is no native wrapper or rewrite.
- Next planned pipeline chunks in `docs/BUILD_PLAN.md`: C12 orchestration, then
  C13 hardening/observability/runbook. **Do not begin C12 until the owner provides
  new instructions.**
- Current default acceptance command: `python tasks.py test lint typecheck`.
- Latest exact isolated UI14 release result: **372 passed**, 68 deselected, 1
  `audioop` deprecation warning. The latest complete mixed local working-tree run
  is **379 passed**, 68 deselected. The slow e2e remains a separate
  `pytest tests/e2e -m slow` run.
- `python tasks.py run-fixture` is the local end-to-end fixture runner. Use a fresh `--work-dir` when inspecting generated artifacts to avoid stale files from old runs.

### Important architecture facts already discovered

- `mhs-vodapi` is retired. Do not build new code against it.
- Video metadata is scraped/parsed from the modern Riksdagen webb-tv page data path implemented in C1/C2.
- Official speeches/transcripts come from the documented open-data `anforandelista`/speech XML flow added in C1b. `00_source.json["anforanden"]` includes `anforande_id`, speaker, party, `anforandetyp`, `intressent_id`, and full official text.
- The official transcript parser preserves `(Applåder)` and `(TALMANNEN: ...)` markers because ranking can use them.
- Available media ceiling is 1280x720. Direct downloads and HLS both showed only 720p and lower variants for checked 2026 debates; no 1080p rendition was found.
- Full-bleed mobile output is fixed at 540x960. For a 1280x720 master, the largest 9:16 crop is 406x720. Use `src/config.py` and `src/paths.py`; do not scatter literal geometry or paths.
- All times in every contract remain float seconds relative to the master video file, never a speech or clip-local offset.
- C10 renders one primary MP4 per clip: `10_render/<clip_id>_540x960.mp4`, plus a vertical WebP thumbnail. No captions are rendered by current decision (ADR 004).
- C11 publishes MP4/WebP to Bunny first, verifies public CDN visibility, then writes Supabase rows transactionally. A `clips` row must never point at a missing Bunny object.

### Data, storage and schema

- Bunny public CDN host used in live tests: `https://riketnlooigm.b-cdn.net`.
- Supabase project ref used in live tests: `nlooigmwuqqhhnontlgp`.
- Supabase stores metadata only. It does not store MP4/WebP bytes.
- Public frontend reads `clips` joined to `speeches` and `sources`, including speaker name, party, `anforandetyp`, source title/date/url, transcript/title, duration and Bunny URLs.
- Published HD10540 test batch: 16 clips and 16 thumbnails uploaded to Bunny and written to Supabase. The frontend feed currently displays those rows, with a local sample fallback in `web/src/data.ts`.
- Supabase render columns are `url_540x960` and optional `url_360x640`; `vtt_url` is nullable.

### Frontend app state

- `web/` is a mobile-only React/Vite app. Widths `>=700px` intentionally show a "view on phone" gate.
- **UI14 mobile/PWA is released and closed.** Normal shared links retain the full
  product. Installed mode uses `/manifest.json`, `display: standalone`, production
  icons/theme metadata and the same routing/product logic as browser mode. Do not
  rename the linked manifest back to `.webmanifest` unless InstaPods' MIME mapping
  is fixed; that extension was served as `application/octet-stream` in production.
- The service worker precaches exactly the same-origin app shell (nine entries in
  the verified release). It deliberately bypasses MP4/video, Range, Bunny,
  Supabase, Clerk, private responses, mutations and non-GET requests. Updates wait
  for a viewer action and defer reload while video plays or a comment draft exists.
  Emergency unregister/recovery is documented and locally rehearsed in
  `docs/RUNBOOK.md`; do not use that path as a production drill.
- Installation is optional and contextual in Profile. Chromium uses its native
  install prompt; mobile Safari shows manual Add to Home Screen help. Offline state
  is honest: the shell can load, but the app never presents unavailable network
  data as current.
- Samsung installed/update operation is owner-confirmed. Exact device/browser
  versions, iPhone Safari/Home Screen, normal Android Chrome and Samsung Internet
  remain explicitly unverified, owner-accepted coverage gaps. Do not treat those
  rows as passes; see the UI14.6 closeout record in the detailed plan.
- The feed is a TikTok-style vertical scroll over published Bunny MP4s. UI15 owns
  primary touch/pen vertical gestures with Pointer Events: the card follows the
  pointer, advances at most one clip, activates the destination on release and
  settles to the exact boundary in 140 ms. Native wheel, keyboard, deep-link and
  unsupported-browser scrolling still use CSS snap; `scroll-snap-stop: always`
  remains load-bearing for that fallback. `web/src/feed/snap-policy.ts` is the
  gesture-policy source of truth. Preserve pinch zoom, pull-to-refresh, progress
  scrubbing and the four-source media ceiling when changing it. Item height is
  `100%` of `.feed-scroll` on purpose, never a viewport unit: `dvh` changes
  mid-scroll as the mobile URL bar collapses, which moves every snap point.
- Current player behavior:
  - the active clip autoplays; audio starts unmuted where browser policy allows it,
    and falls back to **muted playback** where it does not, rather than not playing;
  - the first tap after such an automatic mute turns audio on instead of pausing;
    a mute the viewer chose from the mute control is never undone this way;
  - the center play button appears only if playback itself was refused — with the
    muted fallback in place that is rare, and it no longer means "audio was refused";
  - tapping the video surface otherwise toggles pause/play;
  - progress uses real `video.currentTime`/duration and supports scrubbing;
  - playback is owned by `FeedScreen`, not the native `autoplay` attribute;
    leaving the feed or hiding the document pauses every video before detach,
    and stale `play()` promises cannot start a muted fallback off-screen;
  - bottom nav is flush to the mobile viewport bottom.
- Video sources use a bounded directional scheduler: one clip behind, the active
  clip, the immediate destination, then a second destination only after the first
  is playable. At most four `<video>` elements exist; rows outside that window keep
  only their bounded poster (±3). Leaving the window pauses, removes `src`, calls
  `load()` and unmounts the media element so obsolete requests/decoders are released.
  Mounting all 60 rows with media previously cost **119** CDN requests. Do not
  reintroduce unconditional `src`/`poster` attributes.
- High-frequency playback time/duration state belongs to each feed row, so a
  progress tick updates one row instead of rebuilding all 60. Active and forward
  destinations use explicit `load()` with `preload="auto"`; the second look-ahead
  is disabled only by an explicit Save-Data, 2G or slow-2G signal. Missing network
  hints are normal (including Samsung Internet) and no longer suppress preparation.
  The poster stays visible until a decoded frame is presented. Video remains owned
  by the media element/browser HTTP cache, never the service worker or a manual blob
  fetch.
- Bunny sends no `Timing-Allow-Origin`, so `transferSize` is 0 for every CDN
  resource — request counts and timings are measurable from the page, byte totals
  are not.
- Politician portraits are public only after a content-addressed Bunny object has
  verified; `avatar_source_url` is provenance and never a frontend fallback.
  Migration 017 enqueues a low-priority standalone `portrait_sync` IO job for each
  newly published, unsynchronised politician so catalogue backfills cannot leave
  later app pages on initials. Riksdagen's explicit no-photo records correctly
  remain initials and complete without dead-lettering. The full profile-sync
  script remains the periodic metadata/portrait refresh.
- The frontend data layer is `web/src/supabase.ts`; do not bypass it with hardcoded Bunny URLs except for the fallback sample data.
- In this Codex desktop environment, `npm run ...` scripts have previously failed due a local Bun remap issue. Prefer direct Node commands:
  - Typecheck: `node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json`
  - Build: `node .\node_modules\vite\bin\vite.js build`
  - Dev server: `node .\node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5199 --strictPort`

### Known caveats

- `src/segment/vad.py` uses deprecated stdlib `audioop`; tests pass on current Python, but Python 3.13 will require replacing it.
- The C8 detector is **YuNet**, run by OpenCV from a checksum-pinned ONNX committed
  under `src/vision/models/`. The Haar cascade and its centre-podium fallback are
  both gone (ADR 010, then V1). Active-speaker *selection* is still a geometric
  heuristic in `src/vision/track.py` — largest, most-covered, most-centred face —
  and that is now the pipeline's leading framing defect, because it cannot tell
  which of two tracked faces is the one speaking. Identity verification (SFace)
  is the planned fix; TalkNet/real ASD remains further out. See
  `docs/CLIPPING_V2_DESIGN.md`.
- The Vite frontend intentionally uses only the Supabase publishable key. If a feature needs writes, worker orchestration or server-side API endpoints must own those writes.
- `work/`, `test_outputs/`, `web/dist/`, `web/node_modules/`, env files and generated media are ignored and should stay uncommitted.

## The seven rules

**1. Do not change `src/contracts.py` without an ADR.**
The contracts are the interface between chunks written in different sessions by different agents. Changing a field silently breaks code you cannot see. If a contract genuinely needs to change: write `docs/adr/NNN-title.md` stating what changed and why, update every consumer, run the full test suite, and note it in `PROGRESS.md`.

**2. Stay inside your chunk's file scope.**
Every chunk in `BUILD_PLAN.md` lists the files you may create or modify, and the files you must not touch. If you believe code outside your scope is wrong, **write it in `PROGRESS.md` under Observations — do not fix it.** A drive-by refactor in session 4 that breaks session 2's tests costs more than the bug.

**3. Never mock the thing under test.**
Mock the network. Mock the GPU if you must. Do not mock the function whose behaviour the test is supposed to verify. A test that passes because everything around it was stubbed is worse than no test, because it reports safety that isn't there.

**4. Tests must pass before you finish. All of them, not just yours.**
`pytest -m "not live and not slow"` must be green. If a pre-existing test fails and it isn't yours, stop and record it in `PROGRESS.md` under Blocked rather than deleting or skipping it.

**5. Dependencies are pinned and justified.**
New dependency → add to `pyproject.toml` with an exact version and one line in `docs/DEPENDENCIES.md` saying why. Prefer stdlib. Prefer a dependency already in the tree. Do not add a framework to solve a fifty-line problem.

**6. Every chunk ends with a `PROGRESS.md` handoff entry.**
Use the template at the bottom of this file. The next agent has no memory of your session. What you leave in the ledger is all they get.

**7. When blocked, stop and write it down.**
Do not guess at an API shape, invent a field name, or stub something and hope. Record what you needed, what you tried, and what decision is required. A clear blocker is a useful outcome for a session.

## Conventions

| Thing | Convention |
|---|---|
| Language | Python 3.11+ |
| Types | Full annotations. `mypy --strict` on `src/`. |
| Data models | Pydantic v2 in `src/contracts.py` |
| Formatting | `ruff format`, `ruff check --fix` |
| Task runner | `python tasks.py test lint typecheck`; Makefile delegates to `tasks.py` |
| Config | `src/config.py`, env vars via Pydantic Settings. **No hardcoded paths, keys or magic numbers in stage code.** |
| Logging | `structlog`, JSON output. Every stage logs `dokid`, `stage`, `duration_ms`. |
| Errors | Typed exceptions in `src/errors.py`. Never bare `except:`. |
| Commits | `chunk(C4): short description` |
| Time | Seconds as `float`, always relative to the **master file** start. Never re-base offsets per speech. |
| IDs | `dokid` from Riksdagen, `speech_id` = `{dokid}_{anforande_id}`, `clip_id` = `{speech_id}_c{NN}` |

## Test taxonomy

```
tests/unit/          pure functions, no IO, milliseconds
tests/integration/   one stage over a fixture, diffed against a golden file
tests/e2e/           full chain over the 3-minute fixture      @pytest.mark.slow
tests/live/          hits real Riksdagen/Bunny/Supabase        @pytest.mark.live
```

Default run excludes `live` and `slow`. CI runs everything except `live`.

**Golden-file testing is the backbone here.** Each stage's JSON output is compared against a committed expected file, with float tolerance. When output legitimately changes, regenerate with `python tasks.py golden` and *review the diff in the commit* — an unreviewed golden update defeats the whole mechanism.

## Fixtures

`tests/fixtures/` is committed to the repo and must stay small (< 50 MB total).

| Fixture | Contents | Purpose |
|---|---|---|
| `debates/short/` | 3-min trimmed MP4, two speakers, one camera cut | Fast e2e |
| `debates/short/api_response.json` | Captured `mhs-vodapi` response | Offline C1 tests |
| `debates/short/protocol.txt` | Official transcript for those speeches | C3 alignment |
| `debates/kblab_ref/` | Metadata for 3 debates from `kb-labb/riksdagen_anforanden/metadata` | Validate C3 boundaries against published ground truth |
| `golden/` | Expected output per stage | Regression |

Record real API responses once, commit them, and test against the recording. Do not write tests that require the network to pass.

## Handoff template

Append to `PROGRESS.md` at the end of every session:

```markdown
## C4 — Transcription & alignment — DONE 2026-08-06

**Built:** `src/stages/transcribe.py`, `src/asr/kb_whisper.py`
**Tests:** 11 unit, 3 integration. `pytest -m "not live and not slow"` green.
**Contracts touched:** none / added `Transcript.language_confidence` (see ADR 003)

**Decisions made:**
- Used faster-whisper over transformers: 3.2x throughput on the fixture.
- Word timestamps come from WhisperX alignment, not Whisper's own — the latter drifted up to 400ms.

**Observations (not fixed, out of scope):**
- `src/stages/scenes.py` re-decodes the master instead of using `frames/`. Wasteful. Belongs to C2.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- Model weights cache to `~/.cache/kb-whisper`. First run downloads 3 GB.
- Fixture transcription takes ~40s on CPU. Marked `slow`.
```

## Anti-patterns seen in this kind of work

- Rewriting a previous chunk's code because it isn't how you'd have written it.
- Widening a function's responsibility "while I'm in here."
- Adding a config flag instead of making a decision.
- Catching an exception to make a test pass.
- Implementing stage N+1 because you finished early. **Stop and hand off instead.** Scope creep across a session boundary is how contracts drift.
- Leaving `TODO` without a corresponding line in `PROGRESS.md`.
