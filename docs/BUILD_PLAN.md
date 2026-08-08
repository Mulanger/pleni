# BUILD_PLAN.md

Fourteen chunks, each sized for one agent session. Sequential — do not start a chunk whose dependencies aren't marked DONE in `PROGRESS.md`.

## Phase map

| Phase | Chunks | Milestone |
|---|---|---|
| 0 — Foundations | C0 | Contracts and harness exist. Nothing runs yet. |
| 1 — Walking skeleton | C1, C2, S1 | **One ugly clip comes out end to end.** |
| 2 — Segmentation | C3 | Real speaker boundaries, validated against KBLab. |
| 3 — Understanding | C4, C5, C6, C7 | Real clip selection. |
| 4 — Vision & render | C8, C9, C10 | Real vertical framing and captions. |
| 5 — Ship | C11, C12 | Publishes to Bunny + Supabase, orchestrated. |
| 6 — Harden | C13 | Observability, backfill, runbook. |

**S1 is the important one.** After Phase 1 you have a runnable pipeline that produces a bad clip using stubs. Every agent from C3 onward can then execute the whole chain and watch their change take effect. Without it, integration bugs all surface at once in C12 — which is the worst possible session for them to surface in.

---

## C0 — Foundations

**Depends on:** nothing. **Size:** large. **This chunk determines the quality of every chunk after it.**

**Objective.** Establish the repo skeleton, the shared data contracts, config, logging, the test harness, and the fixture set. No pipeline logic.

**Deliverables**

```
pyproject.toml            pinned deps, ruff + mypy + pytest config
src/config.py             Pydantic Settings, all env vars
src/contracts.py          every inter-stage data model
src/errors.py             typed exception hierarchy
src/paths.py              work/<dokid>/ layout helpers — single source of truth
src/logging.py            structlog setup
tests/conftest.py         fixture loaders, golden-file comparison helper
tests/fixtures/           see AGENTS.md
Makefile, tasks.py        test, lint, typecheck, golden
PROGRESS.md               initialised with the chunk table
docs/adr/000-template.md
```

**Contracts to define** (exact fields are yours to design, these are the required types):

```python
Source          # dokid, title, debate_type, debate_date, source_url, duration_s, master_sha256
SpeakerEntry    # name, party, start_s, duration_s  — as returned by Riksdagen
MediaInfo       # width, height, fps, duration_s, has_audio, video_codec
Scene           # index, start_s, end_s
Speech          # speech_id, dokid, speaker_name, party, anforandetyp,
                # start_s, end_s, official_text, alignment_confidence, needs_review
Word            # text, start_s, end_s, probability
Sentence        # index, start_s, end_s, text, word_indices
Transcript      # speech_id, words, sentences, model, language
AudioFeatures   # speech_id, frame_hz, rms[], f0[], pauses[], emphasis_events[]
Candidate       # speech_id, start_s, end_s, sentence_span, features: dict[str, float],
                # archetype_scores: dict[str, float], gate_passed: bool, reject_reason
SelectedClip    # clip_id, speech_id, rank, start_s, end_s, archetype, title, transcript, topic
FaceTrack       # clip_id, track_id, samples[(t, x, y, w, h, is_speaking)]
CameraPlan      # clip_id, keyframes[(t, crop_x)], mode: "static" | "pan"
RenderedClip    # clip_id, paths{720,480,thumb,vtt}, duration_s, bytes
PublishResult   # clip_id, cdn_urls, supabase_row_id, published_at
```

**Critical:** all time values are `float` seconds **relative to the master file**. A `Candidate` at `start_s=412.7` means 412.7s into the debate, not into the speech. Every downstream ffmpeg seek depends on this. Write it in the docstrings.

**Tests.** Round-trip serialisation for every contract. `paths.py` layout tests. The golden-file helper tested against itself.

**Acceptance:** `python tasks.py test lint typecheck` green on an otherwise empty project.

---

## C1 — Riksdagen client

**Depends on:** C0. **Size:** medium.

**Objective.** Discover new debates and parse the media/speaker metadata into `Source` + `list[SpeakerEntry]`.

> **Start here, before writing code.** `ARCHITECTURE.md` §A1 carries a warning: the speaker-array structure is inferred from KBLab's 2022–24 work and has not been verified against a live 2026 response. **Your first task is to call `https://data.riksdagen.se/api/mhs-vodapi?<dokid>` with a current dokid and capture the raw response to `tests/fixtures/debates/short/api_response.json`.** Then write the parser against what's actually there.
>
> If the speaker list is absent or the timestamps are unpopulated, **stop and record it in `PROGRESS.md` as a blocker.** Do not work around it. That finding changes C3 from a cheap alignment job into a diarization pipeline, and that's an architecture decision, not an implementation one.

**Scope:** `src/riksdagen/{client,parser,discovery}.py`, `src/stages/discover.py`
**Do not touch:** anything under `src/stages/` other than `discover.py`

**Build:** polite HTTP client (backoff, retry, user-agent, rate limit), `mhs-vodapi` parser, `anforandelista` parser for official transcripts and `anforandetyp`, discovery-since-watermark, `00_source.json` writer.

**Tests.** Parser against the captured fixture. Malformed/empty responses. Retry and backoff logic with a mocked transport. One `@pytest.mark.live` test that hits the real API and asserts the schema still holds — this is your early-warning system for Riksdagen changing the contract.

**Acceptance:** `python -m src.stages.discover --dokid <id>` writes a valid `00_source.json`.

---

## C2 — Media acquisition & scene detection

**Depends on:** C1. **Size:** medium.

**Objective.** Fetch the master, extract the analysis derivatives once, detect camera cuts.

**Scope:** `src/media/{download,ffprobe,extract,scenes}.py`, `src/stages/{acquire,detect_scenes}.py`

**Build:** stream download with resume + sha256; HLS→MP4 remux with `-c copy`; `ffprobe` → `MediaInfo`; `analysis.wav` (16 kHz mono) and `frames/` (5 fps, 480px) extraction; PySceneDetect content detector → `02_scenes.json`.

**The rule that matters:** decode the master **once**. Every later stage reads `analysis.wav` or `frames/`, never the MP4. If you find yourself writing a second full decode, you've made a mistake.

**Tests.** ffprobe parsing against the fixture. Checksum dedupe. Scene detection over the fixture (which has one known cut) diffed against golden. Resume-after-partial-download.

**Acceptance:** `python -m src.stages.acquire --dokid <id>` populates `master.mp4`, `analysis.wav`, `frames/`, `01_media.json`, `02_scenes.json`.

---

## S1 — Walking skeleton *(spike, not production)*

**Depends on:** C2. **Size:** small. **Delete most of this later — that's expected.**

**Objective.** Make the whole chain run end to end with the dumbest possible implementation of every remaining stage, so subsequent agents have something executable.

**Stubs to write:**

| Stage | Stub behaviour |
|---|---|
| C3 speeches | Trust Riksdagen's raw timestamps, no refinement |
| C4 transcript | `kb-whisper-small` on CPU, no forced alignment |
| C5 features | Return zeros |
| C6 candidates | Fixed 45s windows every 45s |
| C7 selection | First 3 candidates |
| C8/C9 camera | Static centre crop, no face detection |
| C10 render | ffmpeg crop + scale, no subtitles, 540x960 only |
| C11 publish | Write JSON to disk, no network |

**Mark every stub** with `# STUB(Cn): replaced in chunk Cn`. Add `tests/e2e/test_skeleton.py` asserting the fixture produces ≥1 playable MP4 of the right dimensions.

**Acceptance:** `python tasks.py run-fixture` produces a watchable — if ugly — 9:16 clip.

---

## C3 — Speech segmentation

**Depends on:** S1. **Size:** large.

**Objective.** Turn approximate Riksdagen timestamps into accurate speech boundaries. `ARCHITECTURE.md` §A4.

**Scope:** `src/segment/{vad,fuzzy_match,refine,confidence}.py`, `src/stages/segment.py`

**Build:** widen metadata window ±15s → VAD → coarse ASR → fuzzy-match against the official protocol → snap to nearest scene cut within 2s → confidence score → route (accept / flag `needs_review` / diarize-and-retry / park).

**Validate against published ground truth.** `tests/fixtures/debates/kblab_ref/` holds KBLab's corrected timestamps for three 2022 debates. Your boundaries should land within ~1–2s of theirs. This is the only external correctness check in the project — treat a mismatch as your bug until proven otherwise.

**Tests.** Fuzzy matcher on synthetic offsets (±5s, ±30s, missing text, ASR noise). Scene snapping incl. the no-cut-nearby case. Confidence routing at each threshold. Integration against `kblab_ref` with tolerance. Overlapping/adjacent speeches.

**Acceptance:** boundaries within 2s of KBLab's on all three reference debates.

---

## C4 — Transcription & word alignment

**Depends on:** C3. **Size:** medium. **GPU.**

**Objective.** Word-level timestamps per speech. `ARCHITECTURE.md` §B1.

**Scope:** `src/asr/{kb_whisper,align,sentences}.py`, `src/stages/transcribe.py`

**Build:** `KBLab/kb-whisper-large` via faster-whisper (ctranslate2); WhisperX forced alignment for word timing; `initial_prompt` seeded with speaker name + debate title; Swedish sentence segmentation; optional official-protocol alignment path behind a config flag.

**Model size is configurable.** Default `large`, but tests use `small` — CI has no GPU.

**Tests.** Sentence splitter on Swedish edge cases (abbreviations, `t.ex.`, `kl. 14.30`, decimal commas, quotes). Word timestamps monotonic and within speech bounds. Golden transcript for the fixture (`small`, fixed seed). Empty/silent audio.

**Acceptance:** `04_transcript/<speech_id>.json` with monotonic word timings covering ≥95% of speech duration.

---

## C5 — Audio feature extraction

**Depends on:** C4. **Size:** small–medium.

**Objective.** Frame-level delivery features. `ARCHITECTURE.md` §B2.

**Scope:** `src/features/audio/{energy,pitch,pauses,emphasis}.py`, `src/stages/audio_features.py`

**Build:** RMS per 20ms; F0 via `parselmouth`; pause detection from VAD (>400ms); emphasis events (>1.5 SD above local energy mean); rolling speech rate from C4 word timings.

**One pass over `analysis.wav`.** Not one pass per feature.

**Tests.** Synthetic signals with known properties — a sine at fixed F0, a square-wave envelope for energy, silence gaps at known offsets. This stage is very testable; don't settle for golden-file-only.

**Acceptance:** `05_audio_features/<speech_id>.json`, all arrays same length, no NaN.

---

## C6 — Candidate generation & hard filters

**Depends on:** C5. **Size:** medium.

**Objective.** Sentence-aligned 40–60s windows, minus the disqualified ones. `ARCHITECTURE.md` §B3 and §R3 Phase-1 filters.

**Scope:** `src/candidates/{windows,filters}.py`, `src/stages/candidates.py`

**Filters to implement** — each a named, individually testable predicate returning `(bool, reason)`:

dangling opener · procedural boilerplate (`Herr/Fru talman`, `yrkar bifall`, reservation numbers) · dead air >20% · cut collision <0.4s · low ASR confidence · orphan demonstrative · unbound pronoun · external reference

**Every rejected candidate is still written out** with its `reject_reason`. C7 needs the negatives, and so does the ranking model later.

**Tests.** One test per filter with a Swedish positive and negative case. Window generation boundary cases (speech shorter than 40s, exactly 60s, one long sentence spanning 90s). Assert every window starts and ends on a sentence boundary.

**Acceptance:** on the fixture, 40–60% of raw candidates rejected, all with reasons.

---

## C7 — Scoring & selection

**Depends on:** C6. **Size:** medium. **The product lives here.**

**Objective.** Three archetype scores, absolute publish gate, capped portfolio selection. `ARCHITECTURE.md` §R2, §R4, §R4b.

**Scope:** `src/scoring/{text_features,archetypes,gate,select.py}`, `src/stages/select.py`

**Build:**
- text features (§R2 group B) — second-person density, questions, negation, superlatives, numbers, NER via KB-BERT, anaphora, sentiment intensity, novelty vs speech centroid, boilerplate similarity
- **two scoring scales, kept separate** — within-speech z-scores for *ordering*, absolute features for the *gate*. §R4b. Conflating these is the single most likely bug in this chunk.
- `CONFRONT` / `EXPLAIN` / `QUOTABLE` weights from §R4, in `config.py`, not inline
- selection: `n = min(10, floor(duration/55), count(gate_passed))`, floor of 1; ≤20% overlap; ≤50% from one archetype
- **`sub_scores` dict on every candidate** — the seam where the LLM judge plugs in later (§R3). Design it so adding LLM keys requires no change to the selector.

**Out of scope:** the LLM judge itself. Phase 2.

**Tests.** Each text feature on hand-written Swedish examples. Z-scoring with a degenerate single-candidate speech. Selection: 2-min speech → 1–2 clips; 20-min → exactly 10; all-fail-gate → 0 or 1; overlap rejection; archetype ceiling. **Golden test over the fixture asserting selected clip IDs are stable** — this is your regression net when weights change.

**Acceptance:** `07_selected/<speech_id>.json` respecting every constraint, with full `sub_scores` on all candidates in `06_`.

---

## C8 — Face detection & active speaker

**Depends on:** C7. **Size:** medium. **GPU.**

**Objective.** Who is speaking, and where in frame. `ARCHITECTURE.md` §C1.

**Scope:** `src/vision/{detect,track,asd}.py`, `src/stages/track.py`

**Build:** YOLOv8-face or RetinaFace on `frames/` within clip ranges; ByteTrack IoU tracking; active-speaker selection with two backends behind one interface — `heuristic` (largest+most central) as default, `talknet` (`sieve-community/fast-asd`) when ≥2 faces are in shot. Exclude the sign-language inset region if present (`config.py`).

**Tests.** Tracking on synthetic sequences with known trajectories, incl. an occlusion gap. Heuristic selection with 1/2/3 faces. Empty-frame handling. Golden track over the fixture.

**Acceptance:** `08_track/<clip_id>.json` with a face box for ≥90% of sampled frames.

---

## V1 — YuNet replaces the Haar cascade — DONE

**Depends on:** C8. **Size:** small. **CPU.** Phase 1 of `docs/CLIPPING_V2_DESIGN.md`.

**Objective.** Stop the detector selecting furniture as the speaker. Measured over
the whole published catalogue, 24.9% of clips were framed on a box too large to
be a face and 74.3% carried at least one framing defect (design doc §1).

**Scope:** `src/vision/detect.py`, `src/vision/models/`, `src/stages/track.py`,
`src/config.py`, `tests/unit/test_vision_detect.py`, `pyproject.toml`.
**Do not touch:** `src/vision/track.py` selection weights, `src/camera/`,
`src/contracts.py`, anything in C6/C7.

**Build:** `FaceDetector` protocol; `YuNetFaceDetector` over a checksum-pinned
vendored ONNX; delete `HaarFaceDetector` and the area+centrality score it
required; clamp boxes into frame; resolve the sign-language inset once per clip
instead of detecting every frame twice.

**Tests.** Detector miss returns `()`. Score is the model's, not derived from
geometry. Out-of-frame boxes clamp; degenerate boxes drop. Sub-minimum faces
drop regardless of confidence. Missing or tampered model fails loudly. Golden
C8 track summary regenerated and diffed.

**Acceptance:** zero impossible boxes on the Phase 1 sample; track coverage up
from 0.58 to 0.86. Met — design doc §6.

---

## V2 — Speaker identity verification

**Depends on:** V1. **Size:** large. **CPU.** Phases 2–3 of `docs/CLIPPING_V2_DESIGN.md`.

**Objective.** After V1, every remaining measured defect is identity or scene
continuity: two people on screen, both tracked perfectly, nothing saying which
one is speaking. Needs an ADR — `FaceSample`/`FaceTrack` cannot express detector
confidence, landmarks, provenance, scene id or identity evidence.

---

## C9 — Camera planning

**Depends on:** C8. **Size:** small–medium. **Pure function — no video IO.**

**Objective.** Face tracks → crop keyframes. `ARCHITECTURE.md` §C2.

**Scope:** `src/camera/{plan,smooth}.py`, `src/stages/camera.py`

**Build:** per-shot median x; face at ~38% from top; clamp to frame; **hold x for the whole shot, jump at cuts, never pan across one**; dead zone ±12% frame width; one-euro or Kalman smoothing with max pan velocity ~60 px/s at 1080p only when the dead zone is exceeded.

This chunk is entirely deterministic given `08_track` + `02_scenes`. Test it like a pure function, because it is one.

**Tests.** Static speaker → single keyframe. Speaker crossing the dead zone → bounded-velocity pan. Scene cut → discontinuous jump, no interpolation across it. Clamping at frame edges. Speaker exits frame → hold last valid.

**Acceptance:** `09_camera/<clip_id>.json`; no keyframe puts the crop outside the source frame.

---

## C10 — Render

**Depends on:** C9. **Size:** large.

**Objective.** The only stage that encodes video. `ARCHITECTURE.md` §C3–C5.

**Scope:** `src/render/{ass,ffmpeg,thumbnail,renditions}.py`, `src/stages/render.py`

**Build:** ASS subtitle generation with word-level `\k` karaoke highlighting, safe-area margins, 2–3 lines; speaker/party lower-third for 3s; source attribution; `sendcmd` file from camera keyframes; the ffmpeg filter chain (§C3); 540×960 primary rendition, `+faststart`; optional 360×640 only if telemetry later proves it useful; WebP thumbnail from a frame ~1.5s in with the largest face; VTT written alongside for storage.

**Seek into the master with the clip's absolute offsets.** Do not create intermediate per-speech video files. One encode per rendition, ever.

**Tests.** ASS timing correctness and escaping (Swedish å/ä/ö, apostrophes). `sendcmd` generation from keyframes. Output dimensions, duration (±0.1s), and faststart flag via ffprobe. Visual regression: render the fixture, extract 3 frames, compare to golden PNGs with a perceptual tolerance.

**Acceptance:** `python tasks.py run-fixture` yields playable 540×960 MP4s with burned-in captions and a correctly framed speaker.

---

## C11 — Publish

**Depends on:** C10. **Size:** medium.

**Objective.** Bunny upload then Supabase write, in that order, transactionally. `ARCHITECTURE.md` §D.

**Scope:** `src/publish/{bunny,supabase}.py`, `src/stages/publish.py`, `migrations/`

**Build:** Supabase migrations for the full schema (§Data model) incl. RLS; Bunny Storage upload to immutable date-partitioned paths with `HEAD` + byte-length verification; single-transaction row insert **only after verification passes**; `clip_features` bulk insert for all candidates; idempotent re-run.

**The invariant:** a `clips` row must never point at a file that isn't there. Upload, verify, then write. Never the other way round.

**Tests.** Upload against a mocked Bunny endpoint, incl. partial-failure and verification-mismatch paths. Migrations up/down against a local Postgres. RLS: anon can read published clips, cannot read unpublished, cannot write. Idempotent double-publish. One `@pytest.mark.live` round-trip against a staging bucket.

**Acceptance:** fixture clips land in staging Bunny + Supabase; re-running changes nothing.

---

## C12 — Orchestration

**Depends on:** C11. **Size:** large.

**Objective.** Turn twelve scripts into a resumable job graph. `ARCHITECTURE.md` §Orchestration.

**Scope:** `src/orchestrator/{queue,jobs,cli}.py`, `src/stages/__init__.py` (registry only)

**Build:** pg-boss or Graphile Worker on the existing Postgres; job types matching the stage numbers; fan-out (debate→speeches, speech→clips); idempotency keys (`render:clip_0123:v2`); exponential backoff, max 3 attempts, dead-letter with the error; separate worker pools for GPU / CPU / IO with independent concurrency; a CLI (`run`, `resume`, `retry`, `status`, `backfill`); cron discovery every 30 min.

**Resumption is the acceptance criterion.** Kill the worker mid-render and restart: it must continue from the last completed stage, not from the top.

**Tests.** Fan-out produces the right job count. Idempotency: enqueuing twice runs once. Retry and dead-letter paths. **Crash-recovery test — kill mid-pipeline, restart, assert no duplicate work and no missing output.**

**Acceptance:** `pipeline run --dokid <id>` completes the fixture end to end; killing and restarting mid-run converges to the same result.

---

## C12b — Per-clip render fan-out

**Depends on:** C12. **Size:** medium.

**Objective.** Make the pipeline's long pole parallel. `render` is 400 independent
50-second encodes — the most parallelisable work in the project and the stage that
dominates runtime — and C12 runs all of them serially in one job, so extra machines
buy nothing and a crash at clip 399 re-encodes all 400.

**Scope:** `src/stages/render.py` (per-clip entrypoint + skip-if-exists only),
`src/orchestrator/{jobs,queue,cli}.py`, `tests/unit/test_orchestrator_fanout.py`,
`tests/integration/test_orchestrator_recovery.py`, `docs/RUNBOOK.md`

**Must not touch:** `src/contracts.py`, `src/render/renditions.py` (the encoder is
already per-clip and correct), any other stage, `tests/fixtures/golden/*`.

**Build:** `render_clip(dokid, clip_id, work_dir)` alongside the existing
`render_dokid`, which keeps working for `run-fixture` and becomes a loop over it;
skip-if-exists so a retry does not redo finished clips; a `fan_out` stage kind that
enqueues one child job per selected clip; and a **join barrier** so `publish` runs
only once every child has completed.

**The barrier is the interesting part.** The C12 chain enqueues one successor on
completion, which cannot express "after all 400 of these". Each child checks
whether any sibling is still outstanding; the last one through enqueues `publish`.
Two children finishing simultaneously both see zero and both enqueue — which is
safe, because the idempotency key admits exactly one.

**A dead child blocks `publish` by design.** Publishing 399 of 400 clips silently
would be worse than stopping: the operator sees it in `pipeline status` and
retries. Same rule as the rest of the chain.

**Acceptance:** four workers render a debate in roughly a quarter of the serial
time; killing a worker mid-fan-out re-renders only the clips it held; a rendered
clip is never encoded twice; `publish` does not run until every child is complete.

---

## C13 — Observability & runbook

**Depends on:** C12. **Size:** medium.

**Objective.** Make it operable by someone who didn't build it.

**Scope:** `src/observability/`, `docs/RUNBOOK.md`, `scripts/`

**Build:** per-stage timing and cost metrics; a `pipeline status` dashboard query set; **the party/speaker distribution query from §R5** — clips per party over trailing 7 days, which you want visible regardless of whether you act on it; alerting on stage failure rate and on Riksdagen schema drift (the C1 live test, on a schedule); backfill script with rate limiting; `docs/RUNBOOK.md` covering the common failures table from `ARCHITECTURE.md`.

**Acceptance:** a full debate day processes unattended; `docs/RUNBOOK.md` covers every failure mode listed in the architecture.

---

# Recommendation chunks (P0, F0–F6)

These build the feed, not the media pipeline. They are numbered separately on
purpose: they consume C11 output and must never change a pipeline contract
(ADR 008). Architecture is `docs/RECOMMENDATION_LAUNCH_PLAN.md`; the gating
checklist with stable item IDs (`P0-3`, `A-7`, `C-2`, …) is
`docs/RECOMMENDATION_PREREQUISITES.md`. Cite those IDs in commits and handoffs.

Rule 2 applies here exactly as it does to C0–C13: **the file scope below is the
contract.** If a chunk needs a file that is not listed, that is a plan change,
not a judgement call.

---

## P0 — Database security & migration hardening — DONE

**Depends on:** C11. **Size:** small. **Status:** closed 2026-08-02, except
`P0-8` and `P0-9`.

**Objective.** Close the live privilege hole and make migrations trustworthy
before anything else adds tables to this database.

**Scope:** `migrations/00{2,3}_*.sql`, `src/publish/migrations.py`,
`src/stages/publish.py` (migration path only), `scripts/apply_migrations.py`,
`tests/unit/test_publish_migrations.py`, `tests/unit/test_migration_ledger.py`,
`tests/live/test_db_privileges.py`

**Built:** revoked the default `PUBLIC` execute grant on `publish_clip_batch`
and on every `SECURITY DEFINER` function in `public`; pinned their
`search_path`; dropped `discovered` from `sources_public_read`; replaced the
hardcoded `MIGRATION_PATH` with ordered discovery plus a `schema_migrations`
ledger that detects an edited-after-apply migration; added the privilege and
RLS matrix tests.

**Still open:** `P0-8` (reconcile live `clips` rows and Bunny objects against
known pipeline runs) and `P0-9` (key inventory and the rotate-or-not decision).

---

## F0 — Privacy, legal & product contract

**Depends on:** P0. Runs in parallel with P1. **Size:** large, mostly not code.

**Objective.** Produce the decisions that the F1 table shapes encode. Party
preferences and inferred political interests are GDPR Article 9
special-category data; this is what makes collection lawful, not polite.

**Scope:** `docs/privacy/` (new), `docs/RECOMMENDATION_PREREQUISITES.md`
(status updates only)

**Build:** DPIA including an explicit Article 22 conclusion (`F0-1`); Swedish
privacy counsel review of the Article 6 basis and Article 9(2)(a) analysis
(`F0-2`); Article 13 notice in plain Swedish stating that viewing activity is
used to infer political interests (`F0-3`); data-flow inventory covering Clerk,
Supabase and Bunny **including CDN access logs** (`F0-4`); processor agreements
and transfer assessment (`F0-5`); retention decisions (`F0-6`); minors policy
(`F0-7`); ePrivacy/cookie classification (`F0-8`); DSA classification (`F0-9`);
advertising firewall (`F0-10`); security controls (`F0-11`); deletion/export
runbook (`F0-12`); party-balance policy (`F0-13`); takedown path (`F0-14`).

**Acceptance:** product and privacy owners sign off; every field planned in F1
and F2 has a written purpose and retention rule; the non-profiled experience
stays fully functional.

**This gates consent collection from real users, not F1 engineering.** The F1
schema may be built in parallel — see the note in ADR 007.

---

## Q2 — Stable politician identity in the feed DTO

**Depends on:** C11 (the `politicians` table and its `intressent_id` upsert key).
**Blocks:** F1's private-schema key design, `C-9`, `F3`. **Size:** small.

**Objective.** Give the feed a person identity that survives a job title, so
follows and preferences are keyed on something that does not move.
Prerequisite `Q-2`, a GATE.

**Why now, and why before F1.** `speeches.politician_id` has existed since
migration 001 and the frontend has never read it. `personForClip()` builds
identity by stripping `(…)` and four hardcoded title prefixes —
`Justitieministern|Statsministern|Ministern|Ledamoten`, which are exactly the
ones that appeared in the 16-clip HD10540 batch it was written against — then
slugifying whatever is left. Every other ministerial title falls through
untouched. Measured against the live catalogue on 2026-08-04:

| | |
|---|---|
| Real politicians with clips | 165 |
| Distinct identities the UI renders | 171 |
| Politicians split across two identities | 5 |
| Clips affected | **380, or 21.6% of the catalogue** |

The five are the five most-clipped ministers — Andreas Carlson (151 clips),
Anna Tenje (82), Benjamin Dousa (55), Elisabet Lann (49), Erik Slottner (43) —
because a minister is precisely the person whose display name carries a title.
This is not a future risk from a title change; a fifth of the catalogue is
already mis-keyed, concentrated on the highest-volume speakers.

`politicians.intressent_id` is `unique` and is the `on conflict` target of the
C11 upsert, so `politicians.id` is stable across a title change: the row's
`name` and `role` update in place and the uuid does not move. That is the
property `Q-2` needs and it is already true in the database.

**Scope — may create or modify:**

```
web/src/supabase.ts        (select + mapClip only)
web/src/types.ts           (ClipItem identity fields)
web/src/App.tsx            (person identity, follow keying, profile derivation)
web/src/data.ts            (sample clips carry ids; PEOPLE becomes sample-only)
```

**Scope — must not touch:** `src/contracts.py`, any `src/**`, any
`migrations/*` (no schema change is needed — `politicians_public_read` is
`using (true)` and migration 004 grants `select` to `anon`), the consent and
onboarding flow, `tests/fixtures/golden/*`.

**Build.** `clips` gains an embedded `politicians` row through the existing
`speeches.politician_id` foreign key. `ClipItem` carries `politicianId` plus
the canonical name/party/role from that row. `PersonProfile.id` becomes the
politician uuid, follows key on it, and `personForClip()` stops matching on
names entirely.

**The unlinked case is deliberate.** 10 clips (0.57%) across 2 people have no
`politician_id` — ministers who are not sitting MPs, whom Riksdagen's
`anforandelista` omits. They get `politicianId: null` and a **disabled follow
control**, not a name-derived fallback. A name-keyed follow would silently
detach the day the `intressent_id` is recovered, and the user's follow list
would rot invisibly. Refusing to record a follow we cannot keep is the honest
failure. Recovering those ids is its own chunk — name matching can misattribute
a statement in political content.

**Acceptance:** the feed DTO carries `politicianId`; the 5 split ministers each
resolve to exactly one identity; following a minister from a clip where the
title is present and unfollowing from one where it is absent are the same
follow; a clip with no `politician_id` renders normally with the follow control
disabled; `tsc --noEmit` and `vite build` green.

---

## UI1 — Navigation tabs on real data

**Depends on:** Q2 (a stable person key to hang follows on). **Size:** medium.

**Objective.** Make Sök, Följer, Profil and the person page work against the
1,762-clip catalogue instead of demo arrays, and make a follow or a save
survive a reload.

**Why it is not F1.** `C-9` wants follows persisted *server-side*, which needs
the `private` schema, the consent ledger and the F0 documents — all open GATEs.
This chunk stops short of that line deliberately: everything is device-local,
written by exactly one module, and nothing is transmitted. That is the same
position `onboarding-store.ts` already occupies and the same reasoning
(`C-5` permits local; `C-1`/`C-2`/`C-6` gate the server). When F1 lands, the
ledger becomes the source of truth and this store becomes its cache.

**Scope — may create or modify:**

```
web/src/library-store.ts   (new — device-local follows, saves, likes)
web/src/supabase.ts        (politician search, per-politician and by-id clip reads)
web/src/types.ts           (Politician + LibraryState DTOs)
web/src/App.tsx            (Sök, Följer, Profil, PersonScreen, scoped feed)
web/src/styles.css         (clip grid and list surfaces)
```

**Scope — must not touch:** `src/**`, `migrations/*` (none needed — every query
below was verified against the live project on the publishable key alone),
`web/src/onboarding*.{ts,tsx}` and the consent flow (F1), feed ordering.

**Build.**

*Reads.* `searchPoliticians()` over `public.politicians` with an `ilike` name
match and a party filter; `loadPoliticiansByIds()` to resolve a follow list
whose people may not be in the current feed; `loadClipsForPolitician()` using a
`speeches!inner(...)` join filter; `countClipsForPolitician()` reading the exact
total from `Content-Range` with `Prefer: count=exact`; `loadClipsByIds()` for
the saved archive.

*Store.* `library-store.ts` is the single writer for followed politicians,
followed parties, saved clips and liked clips. Follows are keyed on
`politicians.id` (`Q-2`), never a name.

*Scoped feed.* One mechanism serves both "this politician's videos" and "my
saved clips": a collection overlay that renders the existing `FeedScreen` over
a supplied clip array, so the player, the FE-4 dwell activation and the FE-3
loop instrumentation are reused rather than duplicated.

**A followed politician is Article 9 data.** A list of politicians a person
chose to follow reveals political opinion as surely as the onboarding leaning
slider does. It stays on the device, it is never put in a URL or a log
(`C-13`), and the Profil copy says where it lives.

**Demo data that stays, by owner's decision:** `TRENDING` and the recent-search
chips in Sök. Kept as a reminder of what to build, and labelled in the UI so
nobody reads them as real figures.

**Acceptance:** searching a surname finds that politician and opens their page;
their page lists their real clips and their real total; tapping one plays it;
following adds them to Följer and survives a reload; saving a clip puts it in
the saved archive and survives a reload; `tsc --noEmit` and `vite build` green.

---

## UI3 — Riksdagen politician portraits and profile enrichment

**Depends on:** UI1 and V3 (`intressent_id` recovery). **Size:** medium.

**Objective.** Replace initials with Riksdagen's official portrait wherever a
politician appears, while retaining the complete open-data person record for
future profile features. The app must remain usable when a portrait is absent or
fails to load.

**Scope — may create or modify:**

```
migrations/009_politician_profiles.{up,down}.sql
src/riksdagen/{client,profiles}.py
scripts/sync_politician_profiles.py
tests/unit/test_riksdagen_{client,profiles}.py
web/src/types.ts
web/src/supabase.ts
web/src/App.tsx
web/src/styles.css
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, video acquisition, candidate
selection, vision, camera planning, rendering, Bunny clip storage, private user
data, or feed ordering/media windowing.

**Build.** Add the full `personlista` response to `politicians.riksdagen_data`,
derive the current name, party, role, constituency and 192 px official portrait
URL, and retain a sync timestamp. A database trigger supplies the deterministic
portrait URL immediately for newly published politicians even before the richer
profile sync runs. The sync is an explicit operator command and does not become
another numbered video stage.

Carry `avatar_url` and `constituency` through the public politician DTO and the
embedded clip query. Render the image in the feed identity row, search/follow
lists and politician page. Initials remain the error/absence fallback. Credit
the portraits as `Foto: Sveriges riksdag`, as required by Riksdagen's open-data
terms.

**Acceptance:** every linked politician with a published portrait displays it
without layout shift; a broken/missing image falls back to initials; the profile
page shows the same portrait and source credit; the full person JSON is retained
in Supabase; Python acceptance, TypeScript typecheck and Vite build are green.

---

## F1 — Identity, consent & the private schema

**Depends on:** F0 for the *values*; ADR 006 and ADR 007 for the *shape*.
**Size:** large. Split into F1a and F1b if a session runs long.

**Objective.** A signed-in viewer has a durable subject, a provable consent
record, and server-enforced control over what is collected about them. Nothing
personal is persisted before consent exists.

**Scope — may create or modify:**

```
migrations/010_private_schema.{up,down}.sql
migrations/011_consent_ledger.{up,down}.sql
supabase/functions/_shared/{jwt.ts,consent.ts,cors.ts,db.ts}
supabase/functions/consent/index.ts
supabase/functions/clerk-webhook/index.ts
supabase/config.toml
web/src/{consent.ts,account.ts}
web/src/App.tsx           (consent UI + account screens only)
web/src/types.ts          (consent + preference DTOs)
tests/live/test_private_rls.py
tests/unit/test_consent_state.py
supabase/functions/**/*_test.ts
docs/DEPENDENCIES.md
tasks.py                  (Deno targets, O-4)
```

**Scope — must not touch:** `src/contracts.py`, any `src/stages/*`, any
`src/{asr,camera,candidates,features,media,render,scoring,segment,vision}/*`,
`migrations/001_publish_schema.*`, `tests/fixtures/golden/*`.

> **Migration numbers corrected 2026-08-08.** This entry originally scoped
> `004_private_schema` and `005_consent_ledger`, then moved to `009`/`010` after
> migrations 004–008 landed. UI3 now owns `009_politician_profiles`, so F1 starts
> at `010`. Reusing an applied number would fail the `schema_migrations` checksum
> check on the first run.

**Build.**

*Schema (`C-1`, `C-2`, `C-3`, `C-8`, `A-7`).* `private` schema with `usage`
revoked from `anon` and `authenticated` and absent from the PostgREST exposed
list. `private.consent_records` — append-only, subject `clerk_user_id text`,
purpose, granted/withdrawn, Article 6 basis, Article 9 condition, notice
version, UI source, timestamps; a withdrawal is a new row, never an update.
`private.consent_notice_versions` so a 2027 audit can reconstruct the 2026 text.
`private.viewer_preferences` — subject, entity type/id, signed weight, source
`explicit`/`follow`/`inferred`, created/updated/decayed.
`private.data_subject_requests` for the export/reset/delete workflow.

*Verification (`A-11`, `A-12`).* Edge Functions deploy with `verify_jwt = false`
and verify inside the handler: fetch and **cache** the Clerk JWKS, then check
signature, `iss`, `exp`, `nbf` and `azp` against the allowed origins. The
subject comes from the verified `sub` and nothing else — a `user_id` in a
request body is ignored, always.

*Enforcement (`C-4`, `C-5`, `C-6`, `C-7`).* One `consent.ts` helper both
endpoints call. Four independent purposes: personalization, analytics, email,
model-training reuse. Absent means denied. Withdrawal takes effect on the next
request, cancels in-flight personalized calls and purges the client outbox for
that purpose. The UI switch displays server state; it is not the mechanism.

*Lifecycle (`A-14`, `A-15`).* `clerk-webhook` handles `user.deleted` with Svix
signature verification — an unauthenticated delete endpoint is a
denial-of-service on your own users' data. Deletion cascades across consent
records, preferences, inferred state and cached slates. In-app deletion reaches
the same code path.

*Rights (`C-10`).* Export, access, preference edit, recommendation reset and
deletion are real workflows. Placeholder buttons do not count — the Profil tab
currently has three of them.

*Client (`C-9`).* `liked` / `saved` / `following` / `followedParties` move out
of React state and onto the server, keyed on `politicians.id` and never on a
display-name slug (`Q-2`).

**Tests.** RLS matrix for every private table across anon / authenticated-as-A /
authenticated-as-B / service_role (`C-11`), in the same harness as
`tests/live/test_db_privileges.py`. JWT verification: wrong signing key, expired
token, unknown issuer and wrong `azp` each return 401 and write nothing.
Subject spoofing: posting another user's ID has no effect. Deletion: create
user, generate rows, delete in Clerk, assert every private row is gone.
Withdrawal flips the next request to non-profiled. A full anonymous session
creates zero private rows.

**Acceptance.** Default-off consent with proof of grant; immediate withdrawal;
export/reset/deletion complete end to end; private-schema RLS proven by the
matrix; `Senaste` still fully works signed out.

**Do not build in F1:** telemetry tables (`private.feed_requests`,
`feed_items`, `playback_events`) — those are F2. Any ranking — that is F3 and it
is gated.

---

## F2 — Exposure & playback telemetry

**Depends on:** F1. **Size:** large. See `RECOMMENDATION_LAUNCH_PLAN.md` §F2 and
prerequisite Block T. Frontend gates `FE-1` … `FE-4` must land **before**
collection starts, or the first data is already corrupt.

## F3 — Deterministic `För dig`

**Depends on:** F2 **and** P1 continuous supply. **Gated** — see the exit
criteria in `RECOMMENDATION_PREREQUISITES.md` §13. Do not start.

## F4 — Frontend integration & controlled launch
## F5 — Content understanding & exploration
## F6 — Learned ranking

Scoped in `docs/RECOMMENDATION_LAUNCH_PLAN.md`. Expand into full chunk entries
here before implementation, as rule 2 requires.

---

## Phase 2 backlog (not chunked yet)

Deliberately deferred. Do not pull these forward.

| Item | Blocked on |
|---|---|
| LLM judge (§R3) | C7 shipped and `sub_scores` proven stable |
| LightGBM ranker (§R4c) | ~2,000 published clips with engagement data |
| Exploration slots (§R4c) | Feed serving exists |
| Feed-level party balancing (§R5) | Feed serving exists |
| Human approval queue | A decision on Q9 |
| Blurred-pad fallback for wide shots | Evidence that the C7 framing gate is insufficient |

---

## Session sizing

C0, C3, C10 and C12 are the large ones — consider giving each its own session with nothing else. C5 and C9 are small and could share a session if the agent finishes early, **but only if the agent explicitly re-reads `BUILD_PLAN.md` for the second chunk** rather than continuing on momentum.

The two chunks most likely to go wrong are **C7** (the two-scale scoring separation) and **C12** (resumption semantics). Budget accordingly.
