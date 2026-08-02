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
Makefile                  test, lint, typecheck, golden
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

**Acceptance:** `make test lint typecheck` green on an otherwise empty project.

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

**Acceptance:** `make run-fixture` produces a watchable — if ugly — 9:16 clip.

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

## C13 — Observability & runbook

**Depends on:** C12. **Size:** medium.

**Objective.** Make it operable by someone who didn't build it.

**Scope:** `src/observability/`, `docs/RUNBOOK.md`, `scripts/`

**Build:** per-stage timing and cost metrics; a `pipeline status` dashboard query set; **the party/speaker distribution query from §R5** — clips per party over trailing 7 days, which you want visible regardless of whether you act on it; alerting on stage failure rate and on Riksdagen schema drift (the C1 live test, on a schedule); backfill script with rate limiting; `docs/RUNBOOK.md` covering the common failures table from `ARCHITECTURE.md`.

**Acceptance:** a full debate day processes unattended; `docs/RUNBOOK.md` covers every failure mode listed in the architecture.

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
