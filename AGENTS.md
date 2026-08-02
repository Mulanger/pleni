# AGENTS.md

Standing rules for every coding session on this repo. Read this before doing anything.

## Read order

1. **This file** — the rules.
2. **`PROGRESS.md`** — what's done, what's next, what's blocked. This is the source of truth for state.
3. **`docs/BUILD_PLAN.md`** — find your assigned chunk. Read only that chunk plus its dependencies.
4. **`docs/ARCHITECTURE.md`** — the design reasoning. Reference it; don't re-litigate it.
5. **`src/contracts.py`** — the shared data types. Every stage speaks these.

## What this project is

A pipeline that takes a Swedish parliamentary debate video from Riksdagen webb-tv and produces vertical, subtitled, speaker-centred short clips, stored in Supabase and served from Bunny CDN.

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
  07_selected/<speech_id>.json        # C7
  08_track/<clip_id>.json             # C8
  09_camera/<clip_id>.json            # C9
  10_render/<clip_id>_540x960.mp4     # C10 primary
  11_publish/<clip_id>.json           # C11
```

This layout is not incidental. It is what makes each stage independently runnable, testable and resumable, and what lets you work on stage 7 without ever running stage 2.

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
