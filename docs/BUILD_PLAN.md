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
chose to follow can reveal political opinion. The library remains device-local;
only followed party and politician IDs are projected into the private
recommendation service after explicit consent. It is never put in a URL or a
log (`C-13`), and the Profil copy says where it lives.

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

## UI4 — Per-video comments and moderation

**Depends on:** A-3/A-4 (verified Clerk → Supabase authentication) and UI1.
**Size:** medium.

**Objective.** Give every published clip a readable public discussion without
exposing account photos, email addresses or Clerk subjects. Signed-in viewers
post under a unique `@username`; everyone can read and report. Posting,
deletion, rate limiting and moderation are enforced in Postgres RPCs rather than
trusted to the static client.

**Scope — may create or modify:**

```
migrations/01{2_video_comments,3_comment_reporter_identity}.{up,down}.sql
scripts/moderate_comments.py
tests/unit/test_comment_migration.py
web/src/comments.ts
web/src/clerk.tsx
web/src/App.tsx
web/src/styles.css
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, any numbered video stage,
candidate selection, vision, rendering, Bunny storage, feed ordering/media
windowing, onboarding or consent collection, and F1's reserved migrations 010
and 011.

**Build.** Add inaccessible-by-default comment/profile/report/moderation tables
plus narrowly granted RPCs. Public reads return only comment id, `@username`,
body, time and whether the authenticated caller owns the row. Clerk `sub` stays
inside protected tables. The write RPC validates a 3–24 character handle,
500-character text limit, link-free first-version policy, published clip,
account suspension and rate limits. Users can delete their own comments;
reports never auto-hide content; service-role moderation can hide/restore/delete
comments and suspend an author with an append-only audit event.

The frontend opens a restrained bottom sheet over the active video, pauses and
resumes playback around it, renders no user imagery, supports first-comment
username selection, authenticated posting, own-comment deletion and reasoned
reporting. Anonymous playback and comment reading remain available.

**Acceptance:** anon can read but cannot post or delete; authenticated A cannot
delete B; no public response contains a Clerk id; reporting and moderator actions
are persisted; rate and content limits fail closed; the production TypeScript
build and the full Python acceptance command are green.

---

## UI5 — Stop off-screen media

**Depends on:** UI2. **Size:** small.

**Objective.** A video may play only while its `FeedScreen` is mounted and the
document is visible. Switching to Sök, Följer or Profil, leaving a scoped
collection, or backgrounding the page must synchronously silence every media
element. A late autoplay rejection must not launch the muted fallback after its
video has been detached.

**Scope — may create or modify:**

```
web/src/App.tsx
AGENTS.md
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** feed ordering and source/poster window sizes,
Supabase reads or writes, comments, onboarding, numbered pipeline stages,
`src/contracts.py`, migrations and generated media.

**Build.** Make programmatic playback the single owner of autoplay, invalidate
pending playback requests on clip/screen/visibility changes, pause before React
detaches media nodes and resume after a temporary page hide only when the same
visible feed was actually playing.

**Acceptance:** a mobile-policy simulation may reject the initial unmuted
`play()` after navigation has already reached Sök; once it settles, every
tracked media element is paused and disconnected. The same is true on Profil.
TypeScript, the Vite production build and the full Python acceptance command are
green.

---

## UI6 — Browser-history navigation

**Depends on:** UI1 and UI5. **Size:** small.

**Objective.** Browser Back and Forward mirror Pleni's internal navigation
instead of leaving the site immediately. Tabs, feed modes, politician pages and
scoped clip feeds remain reloadable on the static InstaPods host.

**Scope — may create or modify:**

```
web/src/navigation.ts
web/src/App.tsx
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** visual layout, feed ordering, playback ownership,
Supabase reads or writes, comments, onboarding, numbered pipeline stages,
`src/contracts.py`, migrations and generated media.

**Build.** Add a small hash router over the browser History API. Each deliberate
screen transition pushes one same-document history entry; `popstate` restores
the corresponding app state. Hash URLs are required because InstaPods serves a
static root and has no path-based SPA fallback. Keep route state limited to
public identifiers and screen choices; do not put library contents in the URL
or history state.

**Acceptance:** Hem → Sök → Profil traverses back to Sök and Hem before leaving
Pleni; Forward restores Sök and Profil. Politician pages and saved/person clip
feeds return to their parent screen. Reloading a supported hash restores that
screen. Malformed hashes fail safely to Hem. TypeScript, the Vite production
build and the full Python acceptance command are green.

---

## UI7 — Compact politician profiles

**Depends on:** UI3. **Size:** small.

**Objective.** Remove the oversized empty header and vertically stretched
identity stack from politician profiles so the person and their published clips
share the first mobile viewport.

**Scope — may create or modify:**

```
web/src/styles.css
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** politician data or queries, portrait attribution,
profile actions, clip ordering, playback, comments, onboarding, numbered
pipeline stages, contracts, migrations and generated media.

**Build.** Keep the existing profile content and semantics. Reduce the top bar
to its safe-area plus normal control padding, arrange portrait and identity in
a compact two-column composition, and replace the partially empty three-column
stat cards with a two-item divided row. Preserve 44 px top-bar targets and the
official Riksdagen portrait credit.

**Acceptance:** no fixed empty band remains above the profile controls; the
identity block remains readable at 320 px width; both real statistics use the
full row; TypeScript, the Vite production build and the full Python acceptance
command are green.

---

## UI8 — Political party profiles

**Depends on:** UI1, UI3 and UI6. **Size:** medium.

**Objective.** Make each parliamentary party a first-class searchable profile
whose newest published clips and current politician roster come from Supabase.

**Scope — may create or modify:**

```
migrations/014_party_profiles.{up,down}.sql
web/src/types.ts
web/src/data.ts
web/src/supabase.ts
web/src/navigation.ts
web/src/App.tsx
web/src/styles.css
tests/unit/test_party_profile_migration.py
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, numbered pipeline stages,
publishing payloads, clip ranking, playback ownership, comments, onboarding,
generated media and existing applied migrations.

**Build.** Add an RLS-protected, public-read `party_profiles` table containing
canonical metadata for the eight Riksdag parties. Do not persist derived clip
or politician totals: count and filter them through the existing
`politicians → speeches → clips` relationships so pages cannot drift stale.
Search returns matching party pages before matching people, and selecting a
party filter always places that party page first. Party pages show clips in
descending `published_at` order and the current politician roster. Hash routes
must reload safely and participate in browser Back/Forward history.

**Acceptance:** all eight party rows are seeded with explicit browser read-only
privileges; a party-name search and party chip expose the party page before
people; a party page renders exact live totals when available, recent clips and
current politicians; clip and politician taps preserve Back navigation;
TypeScript, Vite production build, migration guard tests and the full Python
acceptance command are green.

---

## UI9 — Keep mobile video playback inline

**Depends on:** UI2 and UI5. **Size:** small.

**Objective.** Keep feed playback inside Pleni's portrait player on Android and
iOS instead of allowing browser media assistants to promote clips into a native
fullscreen, landscape, picture-in-picture or remote-playback surface.

**Scope — may create or modify:**

```
web/src/App.tsx
web/src/styles.css
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** clip ordering, media windowing, autoplay ownership,
mute fallback, progress/seeking, comments, Supabase reads, numbered pipeline
stages, contracts, migrations and generated media.

**Build.** Retain the standard `playsInline` hint and explicitly withhold native
controls, fullscreen, picture-in-picture and remote playback. Add the legacy
inline attributes still inspected by some Android WebViews and WebKit engines,
consume taps in the app-owned player, and suppress WebKit media-control chrome.
Do not change Pleni's own play, pause, mute, seek or loop behavior.

**Acceptance:** rendered feed videos carry standard and legacy inline hints,
native controls/PiP/remote playback are disabled, taps still use Pleni's player,
vertical swiping still scrolls the feed, TypeScript and the Vite production build
are green, and the behavior is rechecked on the reporting Android browser.

---

## UI10 — Profile library navigation

**Depends on:** UI1, UI3 and UI5. **Size:** small.

**Objective.** Turn the profile library rows into clear entry points for
managing follows and choosing saved videos without dropping the viewer directly
into autoplay playback.

**Scope — may create or modify:**

```
web/src/navigation.ts
web/src/App.tsx
web/src/styles.css
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** library storage keys, sign-in gating, Supabase
reads, feed ordering, playback ownership, media windowing, numbered pipeline
stages, contracts, migrations and generated media.

**Build.** Give personalization its own card, separate from account and data
controls. Make the profile's Following row open the existing followed-party and
followed-politician list, with an explicit unfollow action on every row. Replace
the saved archive's immediate autoplay feed with the same three-column clip
chooser used on politician profiles. Selecting a thumbnail opens the shared
immersive player at that clip, and Back returns to the saved grid.

**Acceptance:** personalization is visually separated from the data card; the
Following row opens the complete stored list and each entry can be unfollowed;
saved clips render as a three-column thumbnail grid; selecting any thumbnail
starts the shared player at that clip and browser Back returns to the grid;
TypeScript, the Vite production build and the full Python acceptance command are
green.

---

## UI11 — Self-hosted politician portraits

**Depends on:** UI3 and C11's verified Bunny upload client. **Size:** medium.

**Objective.** Remove the live frontend dependency on Riksdagen's portrait
server by mirroring official politician portraits into Pleni's existing Bunny
Storage/CDN while preserving source attribution and a safe initials fallback.

**Scope — may create or modify:**

```
migrations/015_self_hosted_portraits.{up,down}.sql
src/riksdagen/{profiles,portraits}.py
scripts/sync_politician_profiles.py
tests/unit/test_{riksdagen_profiles,portrait_mirror,profile_sync,publish_migrations}.py
docs/BUILD_PLAN.md
docs/RUNBOOK.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, numbered pipeline stages, clip
or thumbnail publishing paths, video acquisition, vision, camera planning,
rendering, private user data, frontend playback, feed ordering, generated media
and already-applied migrations.

**Build.** Persist the official source URL separately from the public CDN URL,
plus a SHA-256 content hash and last successful mirror timestamp. The existing
operator profile sync downloads each JPEG through the retrying Riksdagen client,
restricts sources to Riksdagen HTTPS, bounds byte size, validates JPEG markers,
and uploads the exact source bytes to a content-addressed Bunny path. The public
URL changes only after Bunny verifies the object. An unchanged hash reuses the
existing CDN URL; a failed download or upload retains the last working portrait
instead of replacing it with a broken source. Keep `Foto: Sveriges riksdag` as
the UI credit and do not transform the source photograph.

**Acceptance:** migrations retain source/hash/mirror state and default new rows
safely; invalid hosts, oversized bodies and non-JPEG responses are rejected;
content-addressed paths are deterministic; successful uploads update the public
avatar only after verification; failed refreshes preserve the previous avatar;
the production migration and one-time portrait backfill complete with verified
Bunny URLs; the full Python acceptance command and frontend build are green.

---

## UI12 — Public legal information

**Depends on:** F0 and UI6 navigation. **Size:** medium.

**Objective.** Replace development-only profile diagnostics and placeholder
privacy controls with a small, durable legal-information area whose text
matches what Pleni actually does today.

**Scope — may create or modify:**

```
web/src/App.tsx
web/src/clerk.tsx
web/src/navigation.ts
web/src/onboarding.tsx
web/src/onboarding-store.ts
web/src/styles.css
web/src/legal.ts
web/src/types.ts
docs/privacy/
docs/BUILD_PLAN.md
docs/RECOMMENDATION_PREREQUISITES.md  # F0 status only
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, numbered pipeline stages,
published clip metadata, feed ordering, recommendation algorithms, private
database schema, generated media, or already-applied migrations. Do not claim
that export, deletion, consent withdrawal or moderation workflows exist unless
the corresponding behavior is implemented and verified.

**Build.** Remove the signed-in Clerk/Supabase diagnostic from the production
Profile. Add quiet footer links to versioned Swedish terms, privacy information,
cookie/local-storage information, and operator/contact information, with hash
routes that participate in the existing browser history. Terms acceptance may
link to the terms, but the Article 13 privacy notice is information and must not
be presented as a contract the viewer has to accept. Describe the current Clerk,
Supabase, Bunny/CDN and device-local data flows, purposes, legal bases,
recipients/transfers, retention, rights, recommendation status, children,
comments/reporting and source attribution without placeholders or promises about
future features. Identify every cookie/local-storage purpose, provider and
duration; add a consent surface only for storage that is not strictly necessary
for a service requested by the viewer. Publish the legal operator's real name,
establishment address and email, plus organisation/VAT details when applicable.

**Acceptance:** the production diagnostic and its raw claim output are gone;
all legal pages are reachable from Profile and direct hash URLs; browser Back
returns to Profile; content remains readable at 390×844 and includes version and
effective date; onboarding links to the exact terms version and does not bundle
privacy information into consent; the operator identity, age policy, retention
decisions and actual third-party configuration are owner-confirmed; TypeScript,
the Vite production build and the full Python acceptance command are green.

**2026-08-09 launch note:** the owner confirmed `kontakt@pleni.se`, the
low-friction minors policy and current-release storage decisions. `Pleni AB` is
planned but is not registered and there is no establishment address yet. UI12
therefore ships an explicit disclosure of that gap instead of a fabricated
company identity; full operator information and provider-account DPA/log
verification remain open legal-operational work.

**Post-launch correction 2026-08-09:** onboarding is keyed to Clerk's
successful sign-up redirect and a first-session timestamp check. Restoring an
existing Clerk session or signing into an older account must never open it.

---

## UI13 — Resilient self-hosted portraits

**Depends on:** UI11. **Size:** small.

**Objective.** Make a politician identity visually stable even when a mobile
request briefly fails, and never give the browser an unverified Riksdagen URL
under the assumption that it is a Pleni-hosted portrait.

**Scope — may create or modify:**

```
migrations/016_verified_portrait_urls.{up,down}.sql
scripts/sync_politician_profiles.py
tests/unit/test_{profile_sync,publish_migrations}.py
web/src/App.tsx                  # Avatar delivery only
docs/{BUILD_PLAN,RUNBOOK}.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, video/thumbnail delivery,
profile layout, feed ordering, camera or render code, private user data, the
official image bytes, or already-applied migration files.

**Build.** Treat `avatar_source_url` as provenance only. A public `avatar_url`
is either a content-addressed Bunny object accompanied by its verified SHA-256,
or null. Preserve the last verified mirror on refresh failure and clear legacy
Riksdagen URLs that return no image. Retry a failed browser image request with
a distinct query before leaving the deterministic initials fallback visible;
load the large profile portrait eagerly.

**Acceptance:** every non-null production avatar is on Pleni's Bunny host and
returns an image; missing official portraits make no broken external request;
a transient image error receives bounded retries and always leaves a visible
fallback; focused tests, TypeScript, the production bundle and the full
acceptance command are green.

---

### UI13 follow-up — automatic portrait convergence

**Depends on:** UI13 and C12. **Size:** medium.

**Objective.** Ensure every newly published politician receives a verified
Pleni-hosted portrait without relying on an operator to remember a catalogue-wide
sync after each backfill.

**Scope — may create or modify:**

```
migrations/017_politician_portrait_jobs.{up,down}.sql
src/riksdagen/profile_sync.py
src/riksdagen/portraits.py
src/publish/bunny.py
src/orchestrator/{jobs,cli}.py
scripts/sync_politician_profiles.py
tests/unit/test_{profile_sync,publish_bunny,publish_migrations,orchestrator_daemon,orchestrator_fanout}.py
docs/{BUILD_PLAN,RUNBOOK}.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, clip selection, vision, camera,
rendering, feed layout, service-worker routing, private user data or prior
migration files.

**Build.** Enqueue one low-priority, independently retryable IO maintenance job
when an unsynchronised politician row is inserted. The job fetches only that
person, treats Riksdagen's explicit no-photo state as an honest initials fallback,
mirrors available JPEG bytes to the existing content-addressed Bunny path and
updates Supabase only after public-CDN verification. Keep the full operator sync
for periodic metadata/portrait refreshes. A portrait outage must not roll back or
block clip publication.

**Acceptance:** existing unsynchronised production politicians converge; every
non-null avatar has a matching hash path and returns a JPEG from Bunny; explicit
official no-photo records remain null without dead-lettering; a new politician
insert enqueues exactly one terminal portrait job; IO maintenance cannot starve
the other daemon pools; focused tests and the full project acceptance command are
green.

---

### UI13 follow-up — stable portrait remounts

**Depends on:** UI13. **Size:** small.

**Objective.** Keep a successfully painted portrait visible when fast navigation
unmounts and remounts Search, Following or another politician surface.

**Scope — may create or modify:**

```
web/src/App.tsx
web/src/portrait-image.ts
web/tests/portrait-image.test.mjs
.github/workflows/ci.yml
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** portrait source data, Supabase queries, navigation
layout, service-worker routing, video delivery, private user data, migrations or
numbered pipeline stages.

**Build.** Key delivery state to the immutable source URL instead of resetting it
in a passive effect. Remember the exact successfully painted URL in page-session
memory, reuse it after a real component remount, and synchronously recognize an
already-complete cached image without relying on a second `load` event. Retain the
bounded query retry and initials fallback.

**Acceptance:** a simulated Search → Following → Search lifecycle begins visibly
loaded after the first success; cached complete images are recognized; retry URLs
remain bounded and source-isolated; TypeScript, browser lifecycle tests, the
production build, PWA verification and full project acceptance are green.

---

## UI14 — Mobile app UX and PWA

**Depends on:** UI5, UI6, UI9 and UI10. **Size:** large, split into UI14.0–UI14.6.

**Objective.** Preserve Pleni's web architecture while making normal mobile-browser
playback more app-like and adding an installable, standalone PWA with safe,
bandwidth-conscious caching.

**Scope — may create or modify:**

```
web/index.html
web/package.json
web/package-lock.json
web/vite.config.ts
web/public/{manifest.json,icons/*,favicon.svg}
web/src/{App.tsx,main.tsx,styles.css,sw.ts,types.ts,vite-env.d.ts}
web/src/{pwa,feed}/*
web/scripts/verify-pwa-build.mjs
tests/unit/test_pwa_assets.py
docs/{BUILD_PLAN,DEPENDENCIES,RUNBOOK,MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN}.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, numbered pipeline stages,
migrations, published clip metadata, feed ranking/order, comment or sign-in rules,
camera/framing/rendering, generated media, native wrappers, or the no-captions
decision. Do not cache MP4 bodies, Range responses, private API responses, auth
tokens or mutations. Do not replace native CSS scrolling, force fullscreen, or
disable pinch zoom.

**Build.** Follow `docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md` in order. It is
UI14's detailed source of truth for subchunk status, narrower file scopes, measured
performance gates, caching policy, device acceptance and the required handoff after
each agent. One agent completes one subchunk and stops.

**Acceptance:** ordinary shared links remain fully usable; Android and iOS home-screen
installs launch standalone with valid icons and safe areas; offline reload shows an
honest app shell; updates never interrupt playback or typed text; service-worker
caches contain no video/private data; the existing inline player, one-clip snapping,
media windows and playback lifecycle do not regress; the real-device matrix and
rollback drill in the detailed plan are complete; TypeScript, the Vite production
build, the PWA build verifier and the full Python acceptance command are green.

---

## UI15 — Fast feed snapping

**Depends on:** UI2, UI5 and UI14.5. **Size:** small.

**Objective.** Replace slow, browser-defined touch momentum with a controlled
one-clip gesture: the card follows the finger, settles to the adjacent clip in
140 ms, and starts the already-preloaded destination when the swipe commits.

**Scope — may create or modify:**

```
web/src/App.tsx
web/src/styles.css
web/src/feed/media-policy.ts
web/src/feed/snap-policy.ts
web/tests/media-policy.test.mjs
web/tests/snap-policy.test.mjs
docs/BUILD_PLAN.md
AGENTS.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, numbered pipeline stages,
migrations, feed ranking/order, media-window breadth, service-worker caching,
comments, authentication, camera/framing/rendering, or generated media. Preserve
pinch zoom, progress scrubbing, pull-to-refresh, native wheel/keyboard scrolling,
deep-link positioning, one playing video and the four-source media ceiling.

**Acceptance:** a primary touch or pen gesture follows the pointer, advances at
most one clip and reaches the exact item boundary within 160 ms of release with
no residual drift; the committed destination becomes active immediately; short
drags return to the current clip; reduced motion aligns instantly; taps, seeking,
pinch zoom, pull-to-refresh, wheel/keyboard navigation and the existing playback
lifecycle remain correct. Snap-policy tests, TypeScript, the production build,
PWA verification, the full project acceptance command and `git diff --check` are
green. A preloaded destination must expose its decoded first frame before it
enters view, while an actually unready clip retains its bounded thumbnail rather
than flashing black. Physical iPhone Safari/Home Screen and Android Chrome or
Samsung Internet remain required before release.

---

## UI16 — Self-hosted party logos

**Depends on:** UI8 and UI11's verified Bunny upload path. **Size:** medium.

**Objective.** Replace letter-only party badges with the current official marks
for all eight Riksdag parties, mirrored byte-for-byte from Riksdagen into Pleni's
existing Bunny Storage/CDN and exposed through canonical `party_profiles` rows.

**Scope — may create or modify:**

```
migrations/021_party_logos.{up,down}.sql
src/riksdagen/party_logos.py
scripts/sync_party_logos.py
tests/unit/test_party_logo_{migration,mirror}.py
web/src/types.ts
web/src/data.ts
web/src/supabase.ts
web/src/party-logo.tsx
web/src/party-logo-policy.ts
web/src/App.tsx
web/src/onboarding.tsx
web/src/styles.css
web/tests/party-logo-policy.test.mjs
docs/BUILD_PLAN.md
docs/RUNBOOK.md
AGENTS.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, numbered pipeline stages, clip or
thumbnail publishing paths, feed ordering/playback, private user data, comments,
generated video, politician portrait paths, or already-applied migrations.

**Build.** Add source URL, verified public URL, SHA-256 and mirror timestamp to
`party_profiles`. The operator sync accepts only HTTPS PNGs from
`bilder.riksdagen.se`, bounds and validates the exact bytes, uploads them to an
immutable content-addressed `party-logos/<code>/<sha256>.png` Bunny path, verifies
public delivery, then updates all eight database rows together. The frontend
reads `logo_url` through `web/src/supabase.ts`; it never falls back to a live
Riksdagen image. Search, party pages, followed-party rows and onboarding show the
mark without layout shift and retain the existing party-letter/color fallback on
absence or image failure.

**Acceptance:** all eight official sources validate and all eight CDN objects are
public before database URLs change; browser roles remain read-only; frontend code
contains no hardcoded Bunny or Riksdagen logo URL; failed mirrors preserve the
last verified rows; logos render with meaningful party identity at every existing
party-avatar surface; Python unit/integration acceptance, frontend policy tests,
strict TypeScript, Vite/PWA build and `git diff --check` are green.

---

## UI17 — Compact politician clip count

**Depends on:** UI1 and UI3. **Size:** small.

**Objective.** Remove the two-column `Klipp` / `Visas här` statistic strip from
politician profiles and place the exact published total in the quiet label above
the clip grid as `Antal klipp: <count>`.

**Scope — may modify:**

```
web/src/App.tsx
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** party profiles, Supabase count queries, politician
DTOs, clip loading limits/order/playback, shared stat styling, numbered pipeline
stages, contracts, migrations, private user data or generated media.

**Acceptance:** politician profiles render no statistic strip and no `Visas här`
field; the grid label uses the exact `Politician.clipCount` when available and
does not invent a zero when it is unknown; the person loading skeleton reserves
no space for the removed strip; party profiles remain unchanged; TypeScript,
frontend tests, Vite/PWA build, full repository acceptance and `git diff --check`
are green.

---

## UI18 — Search all-parties home icon

**Depends on:** UI1 and UI8. **Size:** small.

**Objective.** Make the first party filter in Search read as the neutral home
state by replacing its grey dot and visible `Alla` text with a single home icon.

**Scope — may create or modify:**

```
web/src/App.tsx
web/src/styles.css
web/tests/search-filter-layout.test.mjs
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** party filter state/query behavior, party order or
colors, search requests/results, routing, bottom navigation, data contracts,
numbered pipeline stages, migrations, private user data or generated media.

**Acceptance:** the null/all filter remains the first 34 px tap target and keeps
its selected styling and behavior; it renders one home icon with an accessible
Swedish label and contains neither the grey-dot element nor visible `Alla` text;
all eight party filters remain unchanged; frontend tests, TypeScript, Vite/PWA
build, full repository acceptance and `git diff --check` are green.

---

## UI19 — Temporarily hide comments

**Depends on:** UI1 and UI4. **Size:** small.

**Objective.** Make the incomplete comment experience unavailable and invisible
to viewers without deleting its implementation, data layer or moderation work.

**Scope — may create or modify:**

```
web/src/App.tsx
web/tests/comments-hidden.test.mjs
docs/BUILD_PLAN.md
PROGRESS.md
```

**Scope — must not touch:** comment RPCs, database tables or migrations,
moderation tooling, existing comment data, legal disclosures, authentication,
feed playback, other action-rail controls, numbered pipeline stages, contracts,
private user data or generated media.

**Acceptance:** the shipped product switch is off; neither the comment action nor
comment sheet can render; no comment request starts during ordinary feed use;
likes, saves, sharing, playback and PWA update behavior remain unchanged; the
comment implementation stays available for later repair; frontend tests,
TypeScript, Vite/PWA build, full repository acceptance and `git diff --check`
are green.

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

### F2a — Served-slate envelope for explicit-interest V1

**Approved 2026-08-14. Depends on:** the F1 consent/profile slice and P1.
**Status:** implementation may proceed; production activation remains gated on
F0 owner approval. This is not the playback-event half of F2 and must not be
recorded as completing F2.

**Objective.** Give the deterministic feed an idempotent request/served-item
denominator without collecting watch behaviour. Anonymous `Senaste` requests
still create no viewer row. Playback events, inferred interests, analytics and
model-training reuse remain out of scope.

**Scope — may create or modify:**

```
migrations/018_recommendation_identity.{up,down}.sql
migrations/019_rule_based_feed.{up,down}.sql
supabase/functions/_shared/{cors,jwt,db,consent,ranking,svix}.ts
supabase/functions/{consent,feed-requests,clerk-webhook}/index.ts
supabase/functions/{deno.d.ts,tsconfig.json}
supabase/functions/tests/*.test.ts
supabase/config.toml
web/src/{account,consent}.ts
web/src/{App,onboarding}.tsx
web/src/{library-store,onboarding-store,supabase,types}.ts
web/src/vite-env.d.ts
web/src/styles.css
web/tests/recommendation-api.test.mjs
tests/unit/test_recommendation_migrations.py
tests/live/test_private_rls.py
tasks.py
.github/workflows/ci.yml
.env.example
web/.env.example
docs/DEPENDENCIES.md
docs/RECOMMENDATION_PREREQUISITES.md   (status only)
docs/privacy/*                         (status/processing-description only)
PROGRESS.md                            (handoff only)
```

No pipeline file or `src/contracts.py` is in scope. Migrations start at 018
because 009 and 012–017 already exist and 010/011 were never created;
migration numbers are monotonic, not gap-filling.

**Build.** A private append-only consent ledger and explicit preference rows;
service-role-only RPCs used by Edge Functions after Clerk JWT verification; an
idempotent `feed_requests`/`feed_items` envelope; a public security-invoker clip
catalogue view ordered by `sources.debate_date`; and an inactive-by-default
frontend rollout flag. The only stored ranking inputs are parties the viewer
affirmatively selected and parties/politicians they follow. The left/right
onboarding question is removed because V1 has no approved or reliable
ideological-to-party mapping.

**Acceptance.** A retry returns the same slate; withdrawal makes the next
personalized request fail closed; signed-out `Senaste` writes nothing; every
served item records position, pool, reason, algorithm version and score
components; no playback or inferred-interest row is created by this slice.

## F3 — Deterministic `För dig`

**Depends on:** F2 **and** P1 continuous supply. **Gated** — see the exit
criteria in `RECOMMENDATION_PREREQUISITES.md` §13. Do not start.

### F3a — Explicit-interest deterministic ranker

**Approved 2026-08-14 as part of F2a.** This is a rules-only preview behind
`VITE_RECOMMENDATIONS_ENABLED`; it does not mark F3 complete and must not be
enabled for real viewers until the F0 notice/retention decisions are approved
and the F2a migrations and functions are deployed together.

**Policy.** Candidate pools are `fresh_interest`, `fresh_general`,
`back_catalog_interest` and `adjacent_interest`, mixed 5/2/2/1 per ten when
inventory permits. Rank uses explicit party/politician affinity, freshness from
`sources.debate_date`, and `rank_in_speech` as the initial quality prior. Raw C7
`final_score` is not compared across speeches. The slate suppresses recently
served clips, prevents adjacent speaker repeats, applies transparent soft
speaker/party caps, and relaxes them deterministically for sparse inventory.
Random exploration remains disabled because no selection propensity is sampled
in this slice.

### F2b — Recommendation launch controls

**Approved 2026-08-14. Depends on:** F2a/F3a. **Size:** medium.

**Objective.** Close the technical production-activation gaps around the
explicit-interest V1 without adding playback telemetry or inferred interests:
fixed retention, subject export/reset/deletion, current notice copy and a
tested cleanup schedule.

**Scope — may create or modify:**

```
migrations/020_recommendation_launch_controls.{up,down}.sql
supabase/functions/_shared/consent.ts
supabase/functions/consent/index.ts
supabase/functions/tests/*.test.ts
web/src/{account,consent}.ts
web/src/{App,onboarding}.tsx
web/src/legal.ts
web/src/styles.css
web/tests/recommendation-api.test.mjs
tests/unit/test_recommendation_migrations.py
.env.example
web/.env.example
docs/privacy/*
docs/RECOMMENDATION_PREREQUISITES.md   (status only)
PROGRESS.md                            (handoff only)
```

No pipeline file, shared pipeline contract, playback event, inferred-interest
state or already-applied migration is in scope. Migration 020 may extend the
service-only RPC surface created by 018/019; the browser still reaches it only
through a Clerk-verified Edge Function.

**Acceptance.** Served slates expire automatically after the documented fixed
period; a signed-in viewer can export, reset and delete recommendation data;
withdrawal/reset applies before the next feed request; browser roles cannot
execute lifecycle RPCs; the public notice accurately describes the active V1;
and TypeScript, the Vite production build, Edge tests and the default Python
acceptance command are green.

## F4 — Frontend integration & controlled launch
## F5 — Content understanding & exploration
## F6 — Learned ranking

Scoped in `docs/RECOMMENDATION_LAUNCH_PLAN.md`. Expand into full chunk entries
here before implementation, as rule 2 requires.

---

## UI16.0–UI16.9 — Interpretable hybrid topic search — DONE 2026-08-25

**Detailed source of truth:** `docs/TOPIC_SEARCH_IMPLEMENTATION_PLAN.md`.
Migrations 022–028, the semantic catalogue, backfill, v2 search Function,
“Tolkat som” result page and exact-order existing-player handoff are complete.
The detailed plan retains every per-chunk dependency, file scope and acceptance
gate. `src/contracts.py`, numbered pipeline contracts and normal feed/PWA media
behavior remain outside UI16.

## UI16.10 — Signed-in owner Android beta — DONE 2026-08-26

**Owner approval:** the 2026-08-26 instruction authorises publishing the search
candidate to `main` for testing in the real app; the owner reports no current
users.

**Scope — may modify:** `web/src/search/feature.ts`, `web/src/App.tsx`, focused
frontend tests/styles, release/privacy documentation and `PROGRESS.md`.
**Must not modify:** ranking thresholds, embedding/index version, database
state, secrets, feed/player/PWA behavior, pipeline stages or `src/contracts.py`.

**Acceptance:** ordinary visitors remain on the default-off app. The special
production beta URL enables search only for a signed-in viewer, shows a provider
warning and requires explicit per-session confirmation. An explicit
`VITE_TOPIC_SEARCH_ENABLED=false` remains the emergency kill switch. Repository,
frontend and Edge gates pass; `main` deploys; live positive/negative probes and
the owner's Android findings are recorded. Known beta exceptions are p95 2.027 s
versus the former 1.5 s target, ungraded 36-query pools and unverified OpenAI
account retention/region controls.

## UI16.11 — Public integrated Search tab — DONE 2026-08-26

**Owner approval:** the 2026-08-26 clarification requires the video/topic
results to be part of the normal Search tab for every visitor, without sign-in
or a special beta URL.

**Scope — may modify:** `web/src/search/feature.ts`, `web/src/App.tsx`, focused
frontend tests, release/privacy documentation and `PROGRESS.md`.
**Must not modify:** search ranking, embeddings, database state, Edge behavior,
secrets, the feed/player/PWA media policy, pipeline stages or `src/contracts.py`.

**Acceptance:** a production build enables topic search by default for signed-out
and signed-in visitors; an explicit `VITE_TOPIC_SEARCH_ENABLED=false` remains the
emergency kill switch. The current Search tab keeps person and party discovery
and adds submitted video results, “Tolkat som”, empty/error states and the
existing result-feed handoff. There is no URL marker, Clerk gate or confirmation
dialog. The concise provider disclosure remains inline. Focused frontend,
TypeScript, production build, PWA and Edge regression checks pass before `main`
is deployed.

## UI16.12 — Public browser preflight repair — DONE 2026-08-26

**Depends on:** UI16.11. **Size:** small.

**Objective:** allow the public Search tab's required Supabase publishable-key
header through the `clip-search` browser preflight. Direct server probes are not
acceptance because they do not enforce browser CORS.

**Scope — may modify:** `supabase/functions/_shared/search/api.ts`, the focused
Edge regression test, topic-search release/runbook documentation and
`PROGRESS.md`. **Must not modify:** the search contract, ranking, embeddings,
database state, frontend layout, player/PWA behavior, pipeline stages or
`src/contracts.py`.

**Acceptance:** an allowed-origin `OPTIONS` response explicitly permits
`apikey` and `content-type`; disallowed origins remain rejected; all Edge and
frontend regressions pass; the Function is deployed; the live preflight and a
live public query both pass.

## UI16.13 — Swedish day–month interpretation and search loading state — DONE 2026-08-26

**Depends on:** UI16.12. **Size:** small.

**Objective:** interpret Swedish calendar phrases such as `30 mars` and
`30 maj 2025` as exact date facets instead of residual topic text, and make the
existing result-loading state visibly clear without changing the Search page's
layout or hierarchy.

**Scope — may modify:** the internal search interpreter/types and focused Edge
fixtures/tests; `web/src/App.tsx`, `web/src/styles.css` and focused frontend
tests; topic-search documentation and `PROGRESS.md`. **Must not modify:** the
public `clip-search-v1` transport contract, ranking thresholds, embeddings,
database state, player/PWA media behavior, pipeline stages or `src/contracts.py`.

**Acceptance:** valid Swedish day–month expressions are consumed into a date
facet using the current UTC year when no year is supplied; invalid dates stay
as topic text; explicit years remain exact and existing year/range behavior is
unchanged. Loading shows a compact visible spinner and status copy above the
existing skeleton, with reduced-motion support. Edge/frontend tests,
TypeScript, build/PWA checks, Function deployment and live interpretation pass.

## UI16.14 — Automatic date broadening for empty topic searches — DONE 2026-08-26

**Depends on:** UI16.13. **Size:** small.

**Objective:** keep exact date interpretation authoritative while automatically
showing relevant topic clips from other dates when the exact date has no
matches, with an explicit server-provided explanation.

**Scope — may modify:** the shared `clip-search-v1` response contract and its
Edge/browser parsers; the Edge search handler and focused tests; `web/src/App.tsx`,
`web/src/styles.css` and focused frontend tests; topic-search documentation and
`PROGRESS.md`. **Must not modify:** database schema, ranking thresholds,
embeddings, indexing, player/PWA media behavior, pipeline stages or
`src/contracts.py`.

**Acceptance:** an exact date query is attempted first; an empty topic-plus-date
query retries candidate retrieval with only the date removed, reusing the same
embedding and preserving person, party and verified-event filters. Date-only
queries never broaden. The response omits the relaxed date facet and includes
validated date-broadening metadata; the frontend displays a concise Swedish
notice and no extra user action is required. Exact matches and existing topic,
identity and provider-fallback behavior remain unchanged. Edge/frontend tests,
TypeScript, production build, deployment and live probes pass.

## UI16.15 — Truthful other-date fallback results — DONE 2026-08-26

**Depends on:** UI16.14. **Size:** small.

**Objective:** ensure an automatically broadened date search never reintroduces
weak candidates from the date range that the notice says had no relevant
matches.

**Scope — may modify:** the Edge search handler and focused tests;
`web/src/App.tsx` and focused frontend tests; topic-search documentation and
`PROGRESS.md`. **Must not modify:** the public `clip-search-v1` contract,
database/RPC schema, ranking thresholds, embeddings, indexing, player/PWA media
behavior, pipeline stages or `src/contracts.py`.

**Acceptance:** the fallback candidate lookup over-fetches to the existing
60-result ceiling, removes every clip whose debate date is inside the original
inclusive date range, preserves the remaining relevance order and reapplies the
requested limit. Broadening metadata and the relaxed facet appear only when an
outside-range result remains. Exact dates, identity/event filters, date-only,
disabled-date and provider-fallback behavior remain unchanged. The notice says
`Inga relevanta klipp hittades`. Full Edge/frontend tests, TypeScript,
production build, PWA verification, Function deployment and live probes pass.

---

## OPT1 — Lean automatic smoke baseline — DONE 2026-08-26

**Depends on:** deployed UI16.15 and
`docs/TOPIC_SEARCH_FINISHED_OPTIMIZATION_ROADMAP.md`. Not on OPT0's optional
grade importer and not on any human relevance review. **Size:** small.

**Objective:** create a small, reproducible, offline before/after snapshot that
protects the deployed topic-search behavior while later chunks change ranking.
This is ordinary regression testing. It is not model training, not a topic
whitelist, not a synonym table and not a source of ranking decisions. The ten
committed phrases are test data only; the live endpoint never reads them.

**Scope — may modify:** `scripts/evaluate_topic_search.py` and focused offline
search fixtures under `tests/fixtures/search/`;
`tests/unit/test_topic_search_evaluation.py`;
`docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`;
`docs/TOPIC_SEARCH_FINISHED_OPTIMIZATION_ROADMAP.md`; this file and
`PROGRESS.md`. **Must not modify:** production ranking or its thresholds, Edge
Functions, migrations, frontend code, the embedding model/index, the public
`clip-search-v1` contract, pipeline stages or `src/contracts.py`. No OpenAI
call, no live call and no deploy occurs. No dependency is added.

**Acceptance:** an offline `smoke` command replays the ten committed phrases
against the existing frozen capture, records server order, result count, clip
ids, debate dates, interpretation/facets, date-broadening metadata and the
search/index/ranking versions, and emits byte-identical output for identical
inputs. The eight positive phrases keep their known non-empty or structured
behavior; both negative phrases stay empty; `22 juni` stays an exact date with
no broadening notice; `30 mars` broadens only from an empty exact result and
returns no row from the excluded range. Phrases with no offline evidence are
reported as explicitly blocked rather than guessed. The three known elflyg
false positives are recorded as forbidden scooter examples. A compact top-five
title/excerpt report is written under the ignored `test_outputs/` directory and
is labelled engineering smoke evidence, never human-validated relevance
evidence. Output never contains credentials, client addresses, raw user
queries, embeddings or private ranking scores. No grade, nDCG target,
tuning/holdout split or owner review queue is created.

---

## OPT2 — Ranking v3 with candidate-level admission — DONE 2026-08-26

**Depends on:** OPT1's committed smoke baseline and
`docs/TOPIC_SEARCH_FINISHED_OPTIMIZATION_ROADMAP.md`. **Size:** large.

**Objective:** remove weak semantic filler from valid result lists without
damaging exact keyword matches, longer descriptive semantic queries, Swedish
compounds, structured person/party/date/event filters, keyword fallback or
automatic date broadening. A result list may be shorter than the requested
limit; nothing is ever backfilled to reach a quota.

**Scope — may modify:** `supabase/functions/_shared/search/ranking.ts`;
`supabase/functions/clip-search/index.ts`; one new additive migration pair;
`scripts/evaluate_topic_search.py` and focused fixtures/tests; Edge and live
search tests; search evidence docs, this file and `PROGRESS.md`. **Must not
modify:** the public `clip-search-v1` response shape, embedding dimensions,
index contents, frontend code, `src/contracts.py` or migrations 022-028.

**Ranking design.** The v2 query-level semantic safety gate is kept unchanged: a
keyword anchor exists, or the query's best cosine similarity is at least 0.53,
or its best Swedish lexical coverage is at least 0.67. Candidate-level admission
is added after it. Every keyword-matched candidate stays eligible. A
semantic-only candidate is admitted only when its own similarity is at least
0.50 or its own lexical coverage is at least 0.67, so a strong candidate
elsewhere in the query can never admit a weaker one. Structured filters stay
inside the `eligible` CTE ahead of keyword and vector retrieval. No recency
boost is added; date remains a filter and a deterministic tie break. Semantic
retrieval ranks are assigned before admission, so dropping a row never reorders
or promotes the rows that remain. Scores stay absent from the public JSON.

**Threshold selection.** `scripts/evaluate_topic_search.py admission-grid`
replays the roadmap's 180-point grid offline against the frozen capture. There
is no human-judged denominator, so no configuration is called best and no nDCG
or precision is produced; selection uses observable membership only. Candidate
similarity 0.40 is discarded because it keeps the elflyg filler, and 0.53 is
discarded because it starves a positive search below `min(5, baseline)`. Of the
108 survivors the conservative order selects `sim0.50-lex0.67-kw1.50-sem1.00-k50`.
The three fusion axes change order rather than admission, and the frozen capture
preserves only the top-N the deployed weights produced, so they are held at the
deployed constants.

**Acceptance:** the additive `029_search_candidate_admission` pair creates
`public.search_clip_candidates_v3` with v2's arguments and response envelope,
keeps v2 deployed for rollback, and its down migration drops v3 only. The
selected constants are mirrored in `ranking.ts` and both an Edge test and a unit
test fail on drift. `SEARCH_RANKING_VERSION` becomes `pleni-search-v3` and the
Edge Function calls v3. Unit, migration and Edge tests cover candidate-specific
admission, a strong candidate not admitting weaker ones, keyword preservation,
absent quota fill, deterministic order, structured filters, exact dates, date
broadening, keyword fallback, provider failure, semantic outage, malformed
envelopes, the negative phrases, the three elflyg ids and the v2 rollback
envelope. A compact top-five before/after report is written under the ignored
`test_outputs/` directory and labelled engineering evidence, never
human-validated relevance evidence. Date broadening still fetches at most 60
candidates, excludes the whole original range, preserves server order and makes
no second OpenAI call. Nothing is deployed and nothing is pushed to `main`; the
migration and the Edge switch are prepared and tested locally only, and both
require explicit owner authority at the time they are performed.

---

## OPT3 — Intent and filter correctness hardening — DONE 2026-08-26

**Depends on:** deployed OPT2 and
`docs/TOPIC_SEARCH_FINISHED_OPTIMIZATION_ROADMAP.md`. **Size:** medium.

**Objective:** close deterministic Swedish query-language gaps while keeping
all interpretation server-owned and evidence-based. Add explicit month-and-year
date ranges without aliases, topic dictionaries, generic spell correction or
changes to ranking/index data.

**Scope — may modify:** shared search interpreter/types; focused interpretation
fixtures and Edge tests; `web/src/App.tsx`, `web/src/search/*` and focused
frontend tests; search evidence docs, this file and `PROGRESS.md`. **Must not
modify:** `src/contracts.py`, database migrations, RPC signatures, embeddings,
index contents, ranking thresholds/order, pipeline stages, Bunny/player/PWA
media behavior or prior migration files.

**Behavior:** preserve exact day/month, explicit day/month/year, year,
year-range and `från`/`sedan` behavior. Interpret `mars 2026` and
`i mars 2026` as the inclusive range `2026-03-01`–`2026-03-31`; a bare month
remains topic text and invalid calendar phrases remain searchable. Disabling a
date facet returns its words to the topic. Person/party thresholds and ambiguity
rules remain unchanged. Date-only searches stay bounded and empty. Existing
keyword-fallback, empty-result and date-broadening behavior stays truthful.

**Acceptance:** the roadmap's OPT3 query matrix is covered by committed
interpreter/handler/frontend regressions. Month-range fallback excludes the
whole original month, preserves order and reuses one embedding. `Tolkat som`
labels the enforced filter as a date, and the broadening notice distinguishes
an exact day from a range without browser-side query interpretation. Mirrored
contract fixtures, all Edge/frontend tests, repository test/lint/typecheck,
TypeScript, production Vite build, PWA verification and `git diff --check` pass.
No live call, deploy or push is part of implementation without a separate
release decision.

**Delivered:** `search-interpret-v3` recognizes explicit Swedish month/year
ranges, including the optional preposition `i`, using real calendar month ends.
Invalid day/month/year phrases suppress overlapping year/month interpretations
and remain topic text. Handler tests prove month fallback excludes the inclusive
month, retains order and performs one embedding. Bare months remain topics;
month/year-only queries perform no retrieval; disabled date facets return the
original words. The browser labels the facet `Datum` and derives exact-day vs
range notice grammar only from server-provided `from`/`to` metadata. Fuzzy
thresholds, ambiguity behavior, ranking, index and public contract are unchanged.

Full gates: 501 Python tests, 139 Edge tests, 71 frontend tests, frontend
TypeScript, production Vite build and PWA verification with nine app-shell
entries. No live/OpenAI call, deploy or push was made.

---

## OPT4 — Latency, cost and embedding/index decision — DEPLOYED 2026-08-27; DAY 1/3 CAPTURED

**Depends on:** OPT2 and OPT3. **Size:** large.

**Objective:** make the existing production search path measurable without
persisting queries, weakening provider/rate-limit behavior or buying a second
service. Produce a deterministic decision gate that requires three separate-day
30-request samples before any embedding/index architecture change.

**Scope — may modify:** the public search Edge handler and its internal provider
adapter; the offline/live search evaluator; focused Python and Edge tests;
search evidence/runbook docs, this file and `PROGRESS.md`. **Must not modify:**
the public JSON search contract, ranking thresholds/order, migrations 001–029,
`src/contracts.py`, index contents, pipeline stages, Bunny/player/PWA media
behavior or frontend search semantics.

**Acceptance:** each successful/error response exposes privacy-safe aggregate
phase timing and actual embedding-token count through diagnostic headers, while
the structured server log contains only the OPT5 allowlisted health fields.
The benchmark runs exactly 30 serial public requests over the ten committed
smoke phrases, waits at least seven seconds between live calls, retains the
first/cold candidate and every failure, and persists query IDs rather than
query text. An offline decision command refuses fewer than three distinct UTC
dates and reports p50/p95/max, phase p95s, actual tokens and caller-supplied
cost projections. No small-model shadow backfill or endpoint switch occurs
without the evidence and approvals required by the roadmap.

**Delivered:** privacy-safe response timing/token diagnostics, a strict
30-request serial benchmark and a three-distinct-day decision command. The
decision recomputes failures, total percentiles, every server-phase p95 and
token totals from all 90 call rows; it never trusts a stored pass flag and never
selects the small model automatically. The current large 1024-dimensional
index remains unchanged. The three live samples are deliberately still
unpassed because they require three real UTC dates after deployment.

---

## OPT5 — Future backfill resilience, privacy-safe operations and closeout — DEPLOYED 2026-08-27; TIME-BOUND LAG SAMPLE PENDING

**Depends on:** OPT0–OPT4. **Size:** large.

**Objective:** keep fresh publications searchable during arbitrarily large
historical backfills, measure future-index lag without query data, lock the
privacy-safe log contract and leave every rollback/recovery path executable and
documented.

**Scope — may modify/create:** one additive search migration pair after 029;
the search embedding worker/RPC adapter; the existing search backfill operator
script; focused migration/worker/backfill/observability tests; search runbook,
roadmap/evidence docs, this file and `PROGRESS.md`. **Must not modify:** prior
migrations, `src/contracts.py`, public browser database access, search ranking,
embedding dimensions/model/index contents, C11 or any video stage, Bunny,
player/media scheduling or service-worker boundaries.

**Acceptance:** normal publication remains on the primary queue while bounded
historical work uses a separate backlog queue that is promoted only when no
fresh job is claimable. Source-hash/index-version idempotency, keyword-first
availability, retry/failure semantics and one-provider-call behavior remain
intact. Service-only read paths produce a privacy-safe 20-clip future-lag sample
and threshold-triggered read-only HNSW plan evidence. Exact log-shape tests fail
on raw query, topic, embedding, identity/filter/address or exact result-count
fields. Runbook tests/evidence cover the frontend kill switch, v2 Edge rollback,
provider-off keyword fallback, index-version restoration and queue recovery.
All offline/full gates pass; live lag, three-day latency, provider-account,
production deployment and Android evidence remain explicitly unpassed until
their separately authorized real operations occur.

**Delivered:** additive migration 030, a fresh-first worker claim, an isolated
historical backlog, two-queue status/recovery, strict future-lag and closeout
reports, thresholded sanitized HNSW plan evidence, exact privacy log allowlist
tests and the complete operator/rollback runbook. Offline release gates are
green. Migration/deployment and real-world acceptance remain separately
authorized operations rather than inferred passes.

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

---

## UI17 — Production desktop video feed — DONE 2026-09-02

**Depends on:** UI14.5, UI15 and the public catalogue view from F2a. **Size:** large.
**Status:** DONE and released 2026-09-02.

**Objective.** Add a desktop-first presentation for the existing feed without
creating a second player, changing 9:16 media or reopening completed mobile/PWA
work. The approved direction and release order are in
`docs/DESKTOP_FEED_IMPLEMENTATION_PLAN.md`.

**Scope — may create or modify:**

```
web/src/{App.tsx,styles.css,supabase.ts,types.ts,data.ts}
web/src/desktop/*
web/src/search/route.ts
web/src/feed/snap-policy.ts              # restore origin/main dependency only
web/tests/desktop-layout.test.mjs
supabase/functions/feed-requests/index.ts
migrations/031_desktop_debate_feed.{up,down}.sql
tests/unit/test_desktop_feed_migration.py
docs/{BUILD_PLAN,DESKTOP_FEED_IMPLEMENTATION_PLAN}.md
PROGRESS.md
```

**Scope — must not touch:** `src/contracts.py`, numbered pipeline stages,
generated media, feed ranking, recommendation consent, service-worker video
routing, Bunny objects or the mobile navigation/product surface.

**Acceptance:** below 700 px remains the existing mobile app; 700–1099 px keeps
the phone gate; 1100 px and above mounts one desktop `FeedScreen` with an exact
9:16 player, external action rail, live inspector, inline comments and real
same-debate clips. At most four media sources remain mounted. TypeScript, Node
tests, production build, PWA verification, migration guards and the full project
acceptance command must pass before release.

## UI20 — Complete desktop parity roadmap — REGISTERED 2026-09-03

**Depends on:** UI17 and the released mobile routes. **Size:** multi-session.

**Objective.** Give every existing mobile route a complete desktop presentation
at widths of 1100 px and wider without duplicating data, account or playback
logic. Tablet remains out of scope and comments remain hidden under UI19.

**Authoritative plan and chunk scope:**
`docs/DESKTOP_COMPLETION_PLAN.md`. It owns the status dashboard, locked design
and responsive contracts, dependencies, allowed scope and acceptance criteria
for UI20.0 through UI20.7. Implement only one listed chunk at a time and update
the dashboard plus `PROGRESS.md` in the same closeout.

**Scope — roadmap registration only:**

```
docs/DESKTOP_COMPLETION_PLAN.md
docs/BUILD_PLAN.md
PROGRESS.md
```

**Acceptance for registration:** the roadmap records UI17 as the completed
baseline, every remaining mobile route, explicit non-goals, per-chunk completion
gates, the full desktop/mobile test matrix and a release/rollback protocol. No
product code changes in this registration chunk.

---

## SEO — Search indexing (SEO0-SEO8) — REGISTERED 2026-09-03

**Depends on:** the released UI20 desktop work only in the sense that it must not
be disturbed. **Size:** nine chunks; SEO1 and SEO2 are the large ones.

**Objective:** give every published clip a crawlable watch page and connect them
with politician, party and debate hubs, so the catalogue can be found in Google
and Bing. Today `web/src/navigation.ts` routes on the URL fragment, which means
the entire site is one indexable URL.

**The plan lives in `docs/SEO_PLAN.md`.** It carries the locked decisions, the
measured host facts, the per-chunk scope and acceptance criteria, and the status
dashboard. Do not start a chunk from this heading alone; read that file.

**Architecture, decided in `docs/adr/014-prerendered-seo-surface.md`:** the SEO
surface is static HTML generated after `vite build` by a Node script reading
Supabase with the publishable key, one file per public URL, copied to the pod
root by the existing deploy command. The InstaPods pod returns 404 for any path
without a file, so a file per URL is a host requirement as well as an SEO one.

**Hard constraints.** `web/vite.config.ts` globs `**/*.html` into the service
worker precache, so the generator must run *after* the Vite build or the
nine-entry app shell becomes one entry per clip. The build must still succeed
with no `VITE_*` values (ADR 006), so the generator degrades to a logged no-op.
`src/contracts.py`, the pipeline stages, migrations 001-031, the render geometry
and the feed's media scheduler are all out of scope.

**Status:** SEO0 implemented locally 2026-09-03, pending deploy and owner Search
Console verification. SEO4 is deferred — `clips.topic` is null across all 5 514
published clips — and nothing depends on it.
