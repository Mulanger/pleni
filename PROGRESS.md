# Progress

This file is the source of truth for chunk status and handoff notes.

## Chunk Table

| Chunk | Status | Notes |
|---|---|---|
| C0 - Foundations | DONE | Completed 2026-08-01 |
| C1 - Riksdagen client | DONE | Completed 2026-08-01 |
| C1b - Official transcripts & Windows tasks | DONE | Completed 2026-08-01 |
| C2 - Media acquisition & scene detection | DONE | Completed 2026-08-01 |
| S1 - Walking skeleton | DONE | Completed 2026-08-01 |
| C3 - Speech segmentation | DONE | Completed 2026-08-01 |
| C4 - Transcription & word alignment | DONE | Completed 2026-08-01 |
| C5 - Audio feature extraction | DONE | Completed 2026-08-01 |
| C6 - Candidate generation & hard filters | DONE | Completed 2026-08-01 |
| C7 - Scoring & selection | DONE | Completed 2026-08-01 |
| C8 - Face detection & active speaker | DONE | Completed 2026-08-01 |
| C9 - Camera planning | DONE | Completed 2026-08-01 |
| C10 - Render | DONE | Completed 2026-08-01 |
| C11 - Publish | DONE | Completed 2026-08-02 |
| C12 - Orchestration | TODO | Depends on C11 |
| C13 - Observability & runbook | TODO | Depends on C12 |
| UI2 - Feed swipe & autoplay | DONE | Completed 2026-08-06 |
| UI3 - Riksdagen portraits & politician profiles | DONE | Completed 2026-08-08 |
| UI5 - Stop off-screen media | DONE | Completed 2026-08-08 |
| UI8 - Political party profiles | DONE | Completed 2026-08-09 |
| UI9 - Inline mobile video playback | DONE | Completed 2026-08-09 |
| V1 - YuNet replaces the Haar cascade | DONE | Completed 2026-08-07 |
| V2 - Speaker identity verification | DONE | Completed 2026-08-08 |
| V3 - Portrait recovery + framing-aware selection | DONE | Completed 2026-08-08 |
| V5 - Clip edges land on measured silence | DONE | Completed 2026-08-08 |
| V7 - Selection prefers windows that cut cleanly | DONE | Completed 2026-08-08 |
| V4 - C3 speaker misattribution | DONE | Completed 2026-08-08 |

## C0 - Foundations - DONE 2026-08-01

**Built:** `pyproject.toml`, `Makefile`, `src/config.py`, `src/contracts.py`, `src/errors.py`, `src/logging.py`, `src/paths.py`, `tests/conftest.py`, `tests/unit/`, `tests/fixtures/`, `scripts/generate_synthetic_fixture.py`, `docs/DEPENDENCIES.md`, `docs/adr/000-template.md`, `docs/BUILD_PLAN.md`, `docs/ARCHITECTURE.md`
**Tests:** 21 unit tests. `python -m pytest -m "not live and not slow"`, `python -m ruff check .`, and `python -m mypy src` green. `make test lint typecheck` could not be invoked in this Windows environment because `make` is not installed, but the underlying target commands pass.
**Contracts touched:** initial `src/contracts.py` created.

**Decisions made:**
- All contracts carrying time values document that times are float seconds relative to the master debate video, never speech- or clip-relative. Nested timing models (`Word`, `Sentence`, `TimeSpan`, face samples, camera keyframes) follow the same rule.
- Kept `Candidate.features`, `Candidate.archetype_scores`, and `Candidate.sub_scores` as open `dict[str, float]` maps. `sub_scores` is deliberately generic so C7 heuristics and the later LLM judge can add keys without selector or contract changes.
- Added small nested models (`SentenceSpan`, `TimeSpan`, `FaceSample`, `CameraKeyframe`, `RenderedPaths`) so tuples from the build plan are named, validated, and serializable without ad hoc shape assumptions.
- Used strict Pydantic v2 models with `extra="forbid"` and frozen instances to make artifact drift fail early.
- Made `src/paths.py` the only canonical builder for every `work/<dokid>/` artifact path, including directories and per-entity JSON/MP4/VTT/WebP paths.
- Stored C7 archetype weights in `src/config.py` defaults rather than hardcoding them in later scoring code.
- Added `imageio-ffmpeg==0.6.0` as a dev-only fallback because no system ffmpeg is on PATH here; the generated synthetic fixture is committed under `tests/fixtures/synthetic/`.

**Observations (not fixed, out of scope):**
- The original planning files were present at repo root, while `AGENTS.md` expects them under `docs/`. C0 copied them into `docs/BUILD_PLAN.md` and `docs/ARCHITECTURE.md` for future sessions and left the originals untouched.
- This directory is not currently a Git repository, so no commit or git diff workflow was available.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- Start C1 by verifying the live `mhs-vodapi` response shape before writing parser assumptions, as called out in `docs/BUILD_PLAN.md` and `docs/ARCHITECTURE.md`.
- Run `python -m pip install -e ".[dev]"` in a fresh environment before checks.
- `tests/fixtures/synthetic/hard_cut_20s.mp4` is a deterministic 20s 1920x1080 fixture with one hard cut at 10s and mono audio. The real `tests/fixtures/debates/short/` and KBLab fixtures remain placeholders for C1-C3.

## C1 - Riksdagen client - DONE 2026-08-01

**Built:** `src/riksdagen/client.py`, `src/riksdagen/parser.py`, `src/riksdagen/discovery.py`, `src/stages/discover.py`, `tests/unit/test_riksdagen_parser.py`, `tests/unit/test_riksdagen_client.py`, `tests/unit/test_riksdagen_discovery.py`, `tests/live/test_riksdagen_live.py`, `tests/fixtures/debates/short/api_response.json`
**Tests:** 38 non-live tests. `python -m pytest -m "not live and not slow"` green. `python -m pytest -m live` green. `python -m ruff check .` and `python -m mypy src` green. CLI acceptance passed: `python -m src.stages.discover --dokid hdc120260305fs --work-dir <temp>` wrote `00_source.json`, and the embedded `Source` plus 71 `SpeakerEntry` objects validated through C0 contracts.
**Contracts touched:** none.

**Decisions made:**
- Verified the documented legacy media API first. `https://data.riksdagen.se/api/mhs-vodapi?hd01sfu35` returned 404, and the public KBLab example `https://data.riksdagen.se/api/mhs-vodapi?H901FiU1` also returned 404 on 2026-08-01. The architecture prediction that this endpoint still serves video metadata did not hold.
- The current Riksdagen site does still publish the required speaker metadata. The captured fixture is the current Next.js page-data JSON for `HDC120260305fs`, saved at `tests/fixtures/debates/short/api_response.json`.
- Current speaker shape is `pageProps.contentApiData.speakers[]` with `speaker`, `speakerShort`, `party`, `speechNumber`, `speechText`, `startPosition`, and `speechSeconds`. `startPosition` is populated for all 71 speakers in the fixture.
- `speechSeconds` is populated for 70 of 71 speakers. The opening talman entry has `speechSeconds: 0`, so the parser derives that duration from the next `startPosition`. It does not derive missing start times.
- The client tries legacy `mhs-vodapi` first and falls back on the current webb-tv page data by resolving document status, constructing the verified Frågestund page URL, fetching the page, and extracting `__NEXT_DATA__`.
- `00_source.json` is a C1 wrapper with top-level `source`, `speaker_entries`, `anforanden`, and `media_urls`. `source` and every `speaker_entries[]` item round-trip through C0 contracts; the extra keys persist C1 metadata that C2/C3 will need because C0 did not define a wrapper model.
- `Source.source_url` is the canonical Riksdagen page URL. C2 should use `media_urls.download_url` or `media_urls.stream_url` for media acquisition.
- Current video JSON lacks a separate official `anforande_id` and `anforandetyp`; C1 records `anforande_id` as the stable `speechNumber` string and defaults `anforandetyp` to `Anförande` for this source shape. The parser also supports the official `anforandelista` response shape when those fields are present.

**Observations (not fixed, out of scope):**
- General URL construction is verified for `kam-fs` / Frågestund pages. Other webb-tv categories such as decisions or interpellation debates may need route mapping once C1 is pointed at those doktyper.
- `make` is still not installed on this Windows PATH; direct target commands were used.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- C2 should read `work/<dokid>/00_source.json`, validate `source` with `Source`, then take the media URL from `media_urls.download_url` first and `media_urls.stream_url` as fallback.
- C3 should treat `speaker_entries[].start_s` as master-relative seconds and can join official text via `anforanden[].speech_number` / `anforande_id`.
- The live drift test is `tests/live/test_riksdagen_live.py` and is intentionally excluded from the default test run.

## C2 - Media acquisition & scene detection - DONE 2026-08-01

**Built:** `docs/adr/001-mhs-vodapi-retired.md`, `src/media/download.py`, `src/media/ffprobe.py`, `src/media/extract.py`, `src/media/scenes.py`, `src/stages/acquire.py`, `src/stages/detect_scenes.py`, C2 unit/integration tests, `tests/fixtures/golden/02_scenes_synthetic.json`, `tests/fixtures/debates/betankande/master.mp4`
**Tests:** 45 non-live tests. `python -m pytest -m "not live and not slow"` green. `python -m ruff check .` and `python -m mypy src` green. CLI acceptance passed against a local HTTP media server: `python -m src.stages.acquire --dokid fixturecli --work-dir <temp>` wrote `master.mp4`, `analysis.wav`, 100 frames, `01_media.json`, and `02_scenes.json`. `make test lint typecheck` could not be invoked because `make` is not installed on this Windows PATH; the underlying commands pass.
**Contracts touched:** none.

**Decisions made:**
- C2 consumes only C1 `00_source.json`; it validates `source` with `Source` and uses `media_urls.download_url` first, falling back to `media_urls.stream_url` for HLS remux.
- `download_with_resume` uses `<target>.part` for HTTP range resume and skips re-download when an existing file matches `Source.master_sha256`. If C1 provides no checksum, C2 computes the final SHA-256 for logging/dedupe but does not mutate `00_source.json`.
- HLS inputs are remuxed to MP4 with ffmpeg `-c copy`; direct MP4 inputs are streamed to disk.
- `probe_media` prefers `ffprobe` JSON, but falls back to parsing `ffmpeg -i` header metadata because this environment has the pinned `imageio-ffmpeg` binary but no `ffprobe` on PATH.
- `extract_analysis_assets` runs one ffmpeg process to produce both 16 kHz mono `analysis.wav` and `frames/%06d.jpg` at 5 fps, 480px wide. Later stages should read those artifacts instead of decoding `master.mp4`.
- Scene detection feeds the extracted 5 fps JPEG frames into PySceneDetect's `ContentDetector`, so `02_scenes.json` is derived without a second full master decode. Scene times are still master-relative seconds; cut precision is bounded by the 0.2s frame interval.
- Added a real betänkande fixture from `hd01sfu35`, "En ny mottagandelag" on 2026-06-03. `tests/fixtures/debates/betankande/master.mp4` is a 00:08:20-00:11:20 trim, re-encoded to 854x480, 2.75 MB, spanning the 00:08:49 speaker change.

**Carry-over answers from C1:**
- ADR 001 documents that `mhs-vodapi` is retired: live requests to `https://data.riksdagen.se/api/mhs-vodapi?<dokid>` return 404, so the pipeline currently depends on C1's parsed Next.js page data until a documented replacement is found.
- Checked Riksdagen open-data user support, API, document, and anföranden documentation. They document general REST access plus document and official anföranden APIs, but I found no documented replacement media endpoint for `mhs-vodapi` or `mhdownload` media metadata. C1 was not rewritten in C2.
- Media rendition HEAD probes for `2442606030056143321` (`hd01sfu35`) and `2442603050053964121` (C1 short fixture) found `_720p.mp4`, `_480p.mp4`, and `_aud.mp3`. `_1080p.mp4`, `_576p.mp4`, `_360p.mp4`, `_270p.mp4`, and `_240p.mp4` returned 404 for both checked IDs. C10 should assume the current downloadable master is 1280x720 unless a future source proves otherwise; a centered 9:16 crop is about 405-406 px wide and will need upscale for 720p vertical output.
- C1 has `parse_anforandelista_response`, but `src/stages/discover.py` does not fetch the official open-data anförandelista. Current `00_source.json` therefore stores Next.js page `speechText`, uses `speechNumber` as the string `anforande_id`, and defaults `anforandetyp` to `Anförande` when page data lacks it.

**Observations (not fixed, out of scope):**
- This directory is still not a Git repository, so no git diff or commit workflow was available.

**Blocked / needs a decision:**
- Before C3, either C1 should be amended to fetch the official open-data anförandelista or the architecture needs an explicit decision to proceed without official `anforande_id` / real `anforandetyp`. C3's fuzzy matcher should not treat current page-data `speechNumber` as the official anförande UUID.

**Next agent should know:**
- Run C1 discover before C2 acquire; C2 intentionally does not call C1.
- `src/stages/acquire.py` writes `01_media.json` and `02_scenes.json`; `src/stages/detect_scenes.py` reruns only scene detection from `01_media.json` plus `frames/`.
- Scene detection tests use the synthetic hard cut fixture and golden file; the betänkande fixture is available for realistic media probing and later stage coverage.

## C1b - Official transcripts & Windows tasks - DONE 2026-08-01

**Built:** `tasks.py`, Makefile delegation to `tasks.py`, official anförandelista/XML fetching in `src/riksdagen/client.py`, expanded official speech parsing in `src/riksdagen/parser.py`, C1 discover integration in `src/stages/discover.py`, output geometry settings in `src/config.py`, fixture `00_source.json` artifacts for short and betänkande debates, official speech fixtures for both debates.
**Tests:** 55 non-live tests. `python tasks.py test lint typecheck` green. Live CLI smoke passed for `hdc120260305fs` and `hd01sfu35`: both wrote `00_source.json` with `official_speech_source=open_data_anforandelista+xml`; counts were 71/71 and 26/26 for speaker entries vs official speeches.
**Contracts touched:** none.

**Decisions made:**
- Official transcripts now come from the documented open-data anföranden API, not from the retired media API and not from Next.js page transcripts when the official API succeeds.
- Fetch flow: `dokumentstatus/<dokid>.json` gives `rm`; `anforandelista/?rm=<rm>&d=<debate_date - 1 day>&sz=10000&utformat=json` returns speech identity rows; C1 filters those rows by `rel_dok_id == dokid`; each matching row's `anforande_url_xml` is then fetched because the list JSON leaves `anforandetext` empty.
- `00_source.json` keeps the existing `anforanden` top-level key but now fills it with official entries containing `anforande_id`, `speech_number`, raw `talare`, raw `parti`, `speaker_name`, `party`, `anforandetyp`, `intressent_id`, `rel_dok_id`, `source_url`, and full plain-text `official_text`. The artifact also records `official_speech_source`.
- `(Applåder)` and `(TALMANNEN: ...)` markers are preserved by HTML-to-text conversion. Tests assert both against fixtures/synthetic XML.
- `anforandetyp` maps `replik=J` and XML `replik=Y` to `Replik`; otherwise it is `Anförande`. `Svar` is inferred only for minister-titled speakers in `frågestund` / `interpellationsdebatt`, because the documented API exposes only anföranden/repliker plus the `replik` flag.
- `parse_video_response` now prefers `metadata.videoPublicationDate` for `Source.debate_date` when present. This fixes `hd01sfu35`, where `contentApiData.date` is 2026-06-02 but the debate/video date is 2026-06-03.
- `video_page_url_from_document` now uses `debattnamn` as the page category when present; this resolves `hd01sfu35` to `/debatt-om-forslag/...`.
- Added output layout settings in `src/config.py`: `OUTPUT_WIDTH=540`, `OUTPUT_HEIGHT=960`, `CROP_WIDTH=406`, `CROP_HEIGHT=720`. C10 should use these rather than literals.
- `tasks.py` is the cross-platform task runner for `test`, `lint`, `typecheck`, `format`, `golden`, and `fixture`; Makefile targets shell out to it so the commands cannot drift.

**HLS finding:**
- The webb-tv page's `contentApiData.video.url` is an HLS manifest (`playlist.m3u8`) for both checked debates.
- Both HLS manifests list two variants only: `BANDWIDTH=3000000` and `BANDWIDTH=500000`.
- ffmpeg probe showed the 3 Mbps variant is 1280x720 at 50 fps and the 500 kbps variant is 848x480 at 25 fps for both `2442606030056143321` (`hd01sfu35`) and `2442603050053964121` (short fixture). No 1080p HLS rendition was found.

**Observations (not fixed, out of scope):**
- The official anförandelista endpoint does not appear to support a working `dokid` query parameter; unknown query parameters are ignored. The implementation therefore queries by riksmöte/date window and filters client-side by `rel_dok_id`.
- The official source is much less fragile than Next.js page-data, but it still depends on `rel_dok_id` being populated and on the 10,000-row date-window cap being enough. This held for both 2026 fixtures.
- This directory is still not a Git repository, so no git diff or commit workflow was available.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- C3 can now use `00_source.json["anforanden"]` as official transcript input and should prefer `anforande_id` over page `speechNumber` when constructing `speech_id`.
- Speech counts match C1 speaker counts for both committed fixtures: short Frågestund 71/71, betänkande 26/26.
- HLS does not improve source resolution over the downloadable 720p master; C10 still needs the 406x720 crop-to-540x960 upscale path.

## S1 - Walking skeleton - DONE 2026-08-01

**Built:** `src/stages/segment.py`, `src/stages/transcribe.py`, `src/stages/audio_features.py`, `src/stages/candidates.py`, `src/stages/select.py`, `src/stages/track.py`, `src/stages/camera.py`, `src/stages/render.py`, `src/stages/publish.py`, `src/stages/run_fixture.py`, `src/stages/_io.py`, `tests/e2e/test_skeleton.py`, `tasks.py`
**Tests:** 56 non-live tests. `python tasks.py test lint typecheck` green. Slow skeleton test green with `python -m pytest tests/e2e/test_skeleton.py -m slow`. Acceptance passed: `python tasks.py run-fixture` wrote 3 playable 540x960 MP4 clips under `work/s1_fixture/HD01SfU35/10_render/`.
**Contracts touched:** none.

**Decisions made:**
- Every post-C2 implementation is intentionally marked with `# STUB(Cn): replaced in chunk Cn`; these are executable placeholders, not production logic.
- The S1 fixture runner uses the committed `tests/fixtures/debates/betankande/master.mp4` and does not hit the network.
- The betankande fixture is a 00:08:20-00:11:20 trim of the full debate. `src/stages/run_fixture.py` writes a fixture-local `00_source.json` with speaker times rebased to that trimmed master only, preserving the invariant that all downstream times are master-relative.
- C3 stub zips `speaker_entries` to `anforanden` by order, trusts raw Riksdagen start/duration values, uses official `anforande_id` for `speech_id`, sets `alignment_confidence=0.0`, and marks every speech `needs_review=True`.
- C4 stub does not download or run Whisper; it builds deterministic word/sentence timings from official text so the skeleton stays runnable on CPU-only machines. C4 must replace this with real `kb-whisper` plus alignment.
- C6 emits fixed 45s windows every 45s with open `features`, `archetype_scores`, and `sub_scores` dicts intact. C7 selects the first 3 passing candidates globally.
- C8/C9 use empty face tracks and a static center crop. C10 renders only the `_720.mp4` path label, scaled to the configured 540x960 output. For the 854x480 test fixture it computes the largest available 9:16 crop dynamically; production C10 should use the C1b 720p geometry settings.
- C11 writes local `PublishResult` JSON with `file://` URLs and no network.

**Observations (not fixed, out of scope):**
- This directory is still not a Git repository, so no git diff or commit workflow was available.
- The skeleton leaves generated acceptance artifacts in `work/s1_fixture/HD01SfU35/`; they are run outputs, not committed fixtures.
- Selected artifacts are JSON arrays grouped by `07_selected/<speech_id>.json` because C0 defined `SelectedClip` but no wrapper model. Later C7 may formalize that artifact shape with an ADR if needed.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- Start C3 by replacing `src/stages/segment.py` and its `# STUB(C3)` function; do not build on the stub confidence/review semantics as if they were meaningful.
- `python tasks.py run-fixture` is now the executable walking skeleton entrypoint and should remain green as real chunks replace stubs.
- The C4 stub transcript model string is `s1-official-text-stub`; any artifact carrying it should be treated as synthetic, not ASR output.

## C3 - Speech segmentation - DONE 2026-08-01

**Built:** `src/segment/vad.py`, `src/segment/fuzzy_match.py`, `src/segment/refine.py`, `src/segment/confidence.py`, `src/stages/segment.py`, `tests/unit/test_segment_*.py`, `tests/integration/test_segment_stage.py`, `tests/fixtures/debates/kblab_ref/metadata_sample.json`
**Tests:** 68 non-live tests. `python tasks.py test lint typecheck` green. C3-focused tests: 12 passing. `python tasks.py run-fixture` still renders 3 clips after replacing the S1 C3 stub.
**Contracts touched:** none.

**Decisions made:**
- Replaced the S1 C3 stub with a real stage that reads only C1 `00_source.json` and C2 `01_media.json`, `02_scenes.json`, and `analysis.wav`, then writes `03_speeches.json` through the existing `Speech` contract.
- Added lightweight VAD over C2's 16 kHz mono `analysis.wav`; it detects RMS-energy speech spans and trims boundaries only when the VAD correction stays near the metadata boundary.
- Added fuzzy transcript matching utilities using stdlib token normalization and `difflib.SequenceMatcher`. The stage does not run ASR yet, but C3 now has the pure matching primitive needed when coarse ASR output is available.
- Added a metadata prior from KBLab's modern adjusted metadata: start `+2.0s`, end `-1.7s`. This matches KBLab's published observation that modern Riksdagen starts are typically a little early and ends a little late.
- Scene snapping uses internal `02_scenes.json` cut points and snaps a refined boundary only when a cut is within 2s.
- Confidence routing follows the architecture thresholds: `>0.85` accept, `0.60-0.85` accept with `needs_review=True`, `<0.60` park-level confidence. Because the `Speech` contract has no parked/skipped status field, C3 still serializes speeches and carries low confidence via `alignment_confidence` plus `needs_review`.
- `speech_id` continues to use official `anforande_id` from C1b. `official_text`, `anforandetyp`, speaker name, and party are preserved from `00_source.json["anforanden"]`.
- The KBLab reference fixture is a compact JSON sample from `kb-labb/riksdagen_anforanden/metadata/adjusted_metadata.csv.gz`, covering debates `H910420`, `H910485`, and `H910377`. Pure refinement lands every sampled boundary within 2s of KBLab adjusted start/end.

**Observations (not fixed, out of scope):**
- C3 does not download or run `kb-whisper`; adding that dependency would overlap C4. The fuzzy matcher is present and tested, but live ASR-backed alignment remains future work.
- VAD currently uses the stdlib `audioop` module for fast RMS calculation. Tests pass on the current Python, but `audioop` is deprecated for removal in Python 3.13.
- This directory is still not a Git repository, so no git diff or commit workflow was available.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- C4 should consume `03_speeches.json`; all times remain float seconds relative to the master file.
- Speeches with `alignment_confidence < 0.85` are not failed; they are marked `needs_review=True`. C4 should still be able to transcribe them unless product policy later adds a skip list.
- When real ASR word timestamps exist, wire them into `src/segment/fuzzy_match.py` rather than changing the `Speech` contract.

## R1 - 9:16 render contract sync - DONE 2026-08-01

**Built:** `docs/adr/002-render-rendition-540x960.md`, `src/paths.py`, `src/stages/render.py`, `src/stages/publish.py`, canonical doc updates in `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/BUILD_PLAN.md`, plus matching unit-test updates.
**Tests:** 68 non-live tests. `python tasks.py test lint typecheck` green. `python tasks.py run-fixture` wrote 3 `_540x960.mp4` clips. Slow skeleton test green with `python -m pytest tests/e2e/test_skeleton.py -m slow`.
**Contracts touched:** changed `RenderedPaths.mp4_720/mp4_480` to `RenderedPaths.mp4_540x960` plus optional `mp4_360x640` (see ADR 002).

**Decisions made:**
- Treated the newly added root architecture document as the fresher source, then synced `docs/ARCHITECTURE.md` so future sessions read the 1280x720 source ceiling, 406x720 crop, and 540x960 output decision from the canonical doc path.
- Removed the old fixed 720/480 render ladder from the contract because the product decision is one primary full-bleed 9:16 mobile rendition. Left `mp4_360x640` optional for a later low-bandwidth rendition if telemetry proves it useful.
- Updated the C10/C11 walking-skeleton stubs to emit and publish `_540x960.mp4` files with CDN key `540x960`; they remain stubs and do not implement final C10 subtitle/thumbnail/camera logic.
- Updated the stub ffmpeg scaling filter to use `flags=lanczos,unsharp=5:5:0.8:3:3:0.4` and CRF 20 so acceptance artifacts follow the decided quality path.

**Observations (not fixed, out of scope):**
- Historical S1 notes above mention the old `_720.mp4` stub label; this entry supersedes that note.
- This directory is still not a Git repository, so no git diff or commit workflow was available.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- C10 should write `10_render/<clip_id>_540x960.mp4` as the primary artifact and should not require `_720.mp4` or `_480.mp4`.
- Use `WorkPaths.render_primary_mp4()` for the primary output; `WorkPaths.render_low_mp4()` is reserved for a possible future 360x640 rendition.
- Publish/storage rendition labels should be `540x960` and, only if later added, `360x640`.

## C4 - Transcription & word alignment - DONE 2026-08-01

**Built:** `src/asr/kb_whisper.py`, `src/asr/align.py`, `src/asr/sentences.py`, `src/asr/__init__.py`, `src/stages/transcribe.py`, `tests/unit/test_asr_*.py`, `tests/integration/test_transcribe_stage.py`, `tests/fixtures/golden/04_transcript_synthetic.json`
**Tests:** 78 non-live tests. `python tasks.py test lint typecheck` green. C4-focused tests: 10 passing. `python tasks.py run-fixture` still writes 3 playable `_540x960.mp4` clips; generated fixture transcripts are monotonic with min coverage 1.000. Slow skeleton test green with `python -m pytest tests/e2e/test_skeleton.py -m slow`.
**Contracts touched:** none.

**Decisions made:**
- Replaced the S1 C4 stub with a real stage orchestrator that reads C3 `03_speeches.json` plus C2 `analysis.wav`, writes one `Transcript` contract to `04_transcript/<speech_id>.json`, and validates every emitted word as master-relative and within the C3 speech interval.
- Added a `SpeechTranscriber` protocol so the stage can run deterministic fixture/test backends without mocking the stage itself. Direct Python calls default to `OfficialTextTranscriber` so `run-fixture` stays CPU-only and deterministic.
- The CLI defaults to `--backend auto`: use faster-whisper when importable, otherwise fall back to official-text timing. `--backend faster-whisper` forces the KBLab model path; `--backend official` is explicit model-free timing.
- Pinned `faster-whisper==1.2.1` and `whisperx==3.8.6`. The faster-whisper backend extracts each C3 speech window from `analysis.wav` only, passes speaker/title context as `initial_prompt`, requests word timestamps, then runs WhisperX forced alignment unless `--no-whisperx-align` is set.
- Added Swedish sentence splitting for common abbreviation and number cases (`t.ex.`, `kl. 14.30`, decimal commas, quotes) and sentence construction from master-relative words.
- Added optional official-protocol projection: `--prefer-official-text` replaces ASR words with official transcript tokens projected onto the ASR timing span. This preserves the official record text while keeping machine-derived timing.

**Observations (not fixed, out of scope):**
- The model backend was not live-tested with downloaded KBLab weights or GPU hardware in this session. Default tests exercise pure timing, sentence splitting, stage IO, and backend construction paths without network/model assets.
- `OfficialTextTranscriber` emits synthetic timings across the full speech window. Any transcript with model `official-text-timing` is deterministic fixture/test output, not evidence that ASR heard the audio.
- This directory is still not a Git repository, so no git diff or commit workflow was available.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- C5 should consume `04_transcript/<speech_id>.json`; word and sentence times remain float seconds relative to the master file.
- For real transcription, run `python -m src.stages.transcribe --dokid <id> --backend faster-whisper --model-size small|medium|large` after C2/C3 artifacts exist. Use `--prefer-official-text` if the product wants official-record text timed by ASR.
- If a future live model test is added, mark it `slow` or `live` unless model weights are already available locally; default CI must not download KBLab/WhisperX assets.

## C5 - Audio feature extraction - DONE 2026-08-01

**Built:** `src/features/audio/energy.py`, `src/features/audio/pitch.py`, `src/features/audio/pauses.py`, `src/features/audio/emphasis.py`, `src/features/__init__.py`, `src/features/audio/__init__.py`, `src/stages/audio_features.py`, `tests/unit/test_audio_*.py`, `tests/integration/test_audio_features_stage.py`
**Tests:** 85 non-live tests. `python tasks.py test lint typecheck` green. C5-focused tests: 7 passing. `python tasks.py run-fixture` still writes 3 playable `_540x960.mp4` clips; fixture C5 artifacts validate with equal-length arrays and no NaN. Slow skeleton test green with `python -m pytest tests/e2e/test_skeleton.py -m slow`.
**Contracts touched:** added `AudioFeatures.speech_rate_wps` (see ADR 003).

**Decisions made:**
- C5 reads C2 `analysis.wav` once into an `AudioBuffer`, then slices that buffer per C3 speech. Feature modules operate on samples and arrays, so RMS, F0, pauses, emphasis, and speech rate do not each reopen or reread the WAV.
- The frame grid is fixed at 20 ms (`frame_hz=50.0`). `rms`, `f0`, and `speech_rate_wps` are dense arrays on that same grid, and the `AudioFeatures` validator enforces equal lengths.
- RMS is normalized PCM16 energy. F0 uses Praat-Parselmouth when importable, with a deterministic zero-crossing fallback so default tests and fixture runs stay native-asset free.
- Pause detection uses the RMS/VAD proxy with a dynamic silence threshold (`max(0.005, max_rms * 0.08)`) and emits only gaps at least 400 ms long. Pause times are master-relative `TimeSpan`s.
- Emphasis detection emits local energy bursts above `mean + 1.5 SD` over a 2s neighborhood. Event times are master-relative.
- Rolling speech rate is serialized as `speech_rate_wps`: words per second over a centered 5s window using C4 word midpoint timestamps.

**Observations (not fixed, out of scope):**
- `praat-parselmouth==0.4.7` is pinned and documented, but it is not installed in this local environment; tests and fixture runs used the zero-crossing fallback. A future environment with the dependency installed should exercise the Praat path.
- C5 does not compute window-level aggregate features such as energy p90, pitch range, or rate variance. That belongs to C6 when it has candidate windows.
- This directory is still not a Git repository, so no git diff or commit workflow was available.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- C6 should consume `05_audio_features/<speech_id>.json` together with C3 speeches and C4 transcripts. Audio event times and transcript times are all master-relative seconds.
- Use the open `Candidate.features` map for aggregates derived from C5 arrays, for example `energy_p90`, `pitch_range`, `rate_var`, `dead_air_frac`, and emphasis counts.
- `speech_rate_wps` is already frame-aligned with `rms` and `f0`; do not recompute rolling speech rate unless the C6 window aggregation explicitly needs a different window size.

## C6/C7 - Candidate generation, scoring & selection - DONE 2026-08-01

**Built:** `src/candidates/windows.py`, `src/candidates/filters.py`, `src/stages/candidates.py`, `src/scoring/text_features.py`, `src/scoring/archetypes.py`, `src/scoring/gate.py`, `src/scoring/select.py`, `src/stages/select.py`, C6/C7 unit and integration tests, `tests/fixtures/golden/07_selected_fixture_ids.json`
**Tests:** 108 non-live/non-slow tests. `python tasks.py test lint typecheck` green. C6/C7-focused tests: 23 passing. Slow fixture test green with `python -m pytest tests/e2e/test_skeleton.py -q`. `python tasks.py run-fixture` renders 2 playable `_540x960.mp4` clips after real C6/C7 selection.
**Contracts touched:** none.

**Decisions made:**
- C6 now generates all sentence-boundary windows whose duration falls inside `Settings.min_candidate_s` and `Settings.max_candidate_s`. Candidate, sentence, scene, pause, and audio-feature times remain float seconds relative to the trimmed/master debate file.
- C6 writes both passing and rejected candidates to `06_candidates/<speech_id>.json`; rejected rows keep the first hard-filter reason so later ranking/training can inspect negatives.
- Implemented the required hard filters as named predicates: dangling opener, procedural boilerplate, dead air, cut collision, low ASR confidence, orphan demonstrative, unbound pronoun, and external reference. Added `i ljuset av detta` to external-reference phrases because the fixture shows it as a backward-pointing opener.
- `Candidate.features`, `Candidate.archetype_scores`, and `Candidate.sub_scores` stay open dicts. C6 stores cheap absolute filter features; C7 appends raw features, within-speech z-scores, archetype scores, final score, and gate metadata into `sub_scores` without changing the contract.
- C7 keeps the two scoring scales separate: z-scored features order candidates inside one speech, while the absolute publish gate checks `self_contained`, `face_height_frac`, `dead_air_frac`, `mean_word_probability`, and prior C6 gate status.
- Archetype weights come from `src/config.py`. Selection uses `n = min(10, floor(duration/55), gate_passed_count)` with a floor of 1 when anything passes, <=20% overlap, and a soft <=50% archetype ceiling that relaxes only when needed to fill the target.
- Phase-1 titles use the first sentence truncated on a word boundary at 60 characters. The LLM judge/title seam is represented by open `sub_scores` keys rather than a new contract.

**Observations (not fixed, out of scope):**
- The fixture has one short speech with no 40-60s candidates and one longer speech with 359 raw candidates. C6 rejects 146/359 (40.7%): 117 `dangling_opener`, 16 `procedural_boilerplate`, and 13 `external_reference`.
- The fixture golden selected IDs are stable at `HD01SfU35_90051909-8a5f-f111-8b6f-6805cafea079_c01` and `_c02`; the preceding short speech emits an empty `07_selected` array.
- `face_height_frac` is a C7 gate placeholder set to `1.0` until C8/C9 provide real vision/framing signals. C7 should be revisited only when those signals exist, not before.
- This directory is still not a Git repository, so no git diff or commit workflow was available.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- Start C8. Do not change C6/C7 contracts to add vision data; put candidate-level framing signals into the existing open feature/sub-score dicts if needed.
- `06_candidates` is rewritten by C7 to include full scoring details. Consumers after C7 should read `07_selected` for clip lists and may inspect `06_candidates` for audit/ranking diagnostics.
- Empty selected arrays are valid for speeches too short to produce candidates; downstream stages already iterate selected clips and skip empty speeches.

## C8/C9/C10 - Vision, camera planning & no-caption render - DONE 2026-08-01

**Built:** `src/vision/{detect,track,asd}.py`, `src/stages/track.py`, `src/camera/{plan,smooth}.py`, `src/stages/camera.py`, `src/render/{ffmpeg,thumbnail,renditions}.py`, `src/stages/render.py`, `scripts/export_mobile_clips.py`, `docs/adr/004-no-caption-render.md`, Phase 4 unit/integration tests, `tests/fixtures/golden/08_track_fixture_summary.json`
**Tests:** 126 non-live/non-slow tests. `python tasks.py test lint typecheck` green. Phase 4-focused tests: 17 passing. Slow fixture test green with `python -m pytest tests/e2e/test_skeleton.py -q`. Clean fixture run green with `python -m src.stages.run_fixture --work-dir work\phase4_check`.
**Contracts touched:** none.

**Decisions made:**
- C8 stores face boxes in source/master video pixel coordinates, not analysis-frame coordinates. Detection still runs on the C2 480px-wide JPEG frames and scales boxes back through `MediaInfo`.
- C8 uses OpenCV Haar face detection as the default local backend and falls back to a conservative center-podium speaker proxy when the detector misses a sampled frame. This keeps the camera planner supplied with boxes on chamber wide shots or detector misses instead of reverting to empty tracks.
- Added an active-speaker backend seam. The implemented backend is the architecture's start-here heuristic: persistent, large, centered face track. TalkNet/ASD is not pulled in yet; adding it should implement the existing `ActiveSpeakerBackend` protocol.
- C8 tracking is IoU-based with a short occlusion gap and interpolation on the C2 frame grid. The fixture active tracks cover all sampled frames: 296/296 for selected clip c01 and 192/192 for c02.
- C9 plans crop x positions per scene/shot from the active face track. It holds static x within a shot when movement stays inside the 12% dead zone, jumps at scene cuts, clamps every keyframe to the source frame, and uses rate-limited pan only when within-shot drift exceeds the dead zone.
- C9/C10 share the same crop sizing helper. For 1280x720 it returns the decided 406x720 crop; for the committed 854x480 fixture it returns 270x480.
- C10 seeks directly into `master.mp4` using selected clip master-relative offsets and performs one encode per rendered clip. The filter chain is `sendcmd,crop,scale=540:960:flags=lanczos,unsharp`, CRF 20, `+faststart`, mono AAC.
- Per user request, C10 intentionally does not generate captions: no ASS file, no subtitle filter, and no VTT sidecar. ADR 004 records this as the current product decision.
- C10 now writes vertical WebP thumbnails alongside the primary MP4.

**Observations (not fixed, out of scope):**
- `src/stages/run_fixture.py` reuses its default `work/s1_fixture` directory without clearing stale downstream artifacts. Current downstream stages read current `07_selected` and ignore stale files, but manual artifact inspection should use a fresh `--work-dir`.
- `opencv-python==4.11.0.86` is now pinned because C8 depends on OpenCV directly. C2 already used `cv2` indirectly for scene frames.
- The fixture has close podium shots, so Haar detection works well. The proxy fallback is important for robustness but should be evaluated against more wide-shot fixtures once C8 has more visual coverage.
- This directory is still not a Git repository, so no git diff or commit workflow was available.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- Start C11. Publish should continue to consume `10_render/<clip_id>_540x960.mp4` as the primary rendition and can use `10_render/<clip_id>.webp` when thumbnail upload is implemented.
- Do not assume VTT exists; no-caption render is an accepted decision in ADR 004.
- If C11 wants to publish vision diagnostics or thumbnails, read only clips from current `07_selected` rather than globbing all historical/stale files under later artifact directories.
- Use `scripts/export_mobile_clips.py` for local review folders; its manifest joins `07_selected` to `03_speeches` and includes `speaker_name`, `party`, and `anforandetyp` for every clip.

## C11 - Publish - DONE 2026-08-02

**Built:** `src/publish/bunny.py`, `src/publish/supabase.py`, `src/stages/publish.py`, `migrations/001_publish_schema.up.sql`, `migrations/001_publish_schema.down.sql`, `scripts/serve_clip_feed.py`, C11 unit/integration tests.
**Tests:** 138 non-live/non-slow tests. `python tasks.py test lint typecheck` green. Live HD10540 publish completed against Bunny + Supabase.
**Contracts touched:** none.

**Decisions made:**
- Heavy artifacts stay in Bunny Storage/CDN only. Supabase stores source, politician, speech, clip, candidate-feature, engagement/job/run metadata plus Bunny URLs. No MP4/WebP bytes go to Supabase.
- Provisioned Bunny Storage Zone + Pull Zone `riketnlooigm` in DE/Falkenstein/Frankfurt. Public CDN host is `https://riketnlooigm.b-cdn.net`.
- Bunny's live Storage API returned 401 for `HEAD` even with the storage-zone password; current Bunny docs list GET/PUT/DELETE for Storage files, not HEAD. C11 therefore checks pre-existing objects with authenticated `GET` + `Range: bytes=0-0`, uploads with raw binary `PUT`, then verifies the public CDN URL with `HEAD` + `Content-Length` before writing Supabase rows.
- Supabase schema follows the architecture model but uses contract-native `speeches.id text` and `clips.speech_id text`, because the frozen contract ID is `{dokid}_{anforande_id}`. Render columns are `url_540x960` and optional `url_360x640`; `vtt_url` remains nullable because C10 intentionally emits no captions.
- Supabase metadata write is a single transactional `publish_clip_batch(payload jsonb)` Postgres function call. The stage applies migrations through Supabase Management API, but sends the large publish payload through the project REST RPC using the secret server key; Management API returned 413 for the full batch.
- Supabase Management API rejected Python/urllib with Cloudflare 1010, so `SupabaseManagementClient` defaults to a `curl` subprocess transport when available. Tests still fake the HTTP boundary.
- `pipeline_runs` now uses stable idempotency key `publish:<dokid>:v1`; reruns upsert the completion row instead of appending duplicates.
- Added `scripts/serve_clip_feed.py`, a stdlib local review server for a TikTok-like vertical feed over a manifest. This is a review surface only, not a numbered pipeline stage.

**Live publish results:**
- Published HD10540 test batch from `work/local_test_hd10540/HD10540`: 16 clips and 16 thumbnails uploaded to Bunny and 16 `11_publish/*.json` artifacts written.
- Supabase public readback with the publishable key returned `Content-Range: 0-15/16` for `clips?id=like.HD10540*`.
- Supabase server-side readback returned 651 `clip_features` rows for `speech_id=like.HD10540*`.
- Public clip rows join speaker metadata from `speeches`; readback includes names such as `Justitieministern Gunnar Strömmer (M)` and `Mathias Tegnér (S)`.
- Local published-feed manifest is `test_outputs/HD10540_published_feed/manifest.json`. Local server is running at `http://127.0.0.1:8765/` from process id 29904.

**Observations (not fixed, out of scope):**
- Supabase currently has earlier null-idempotency `pipeline_runs` rows from the first successful live test before the idempotency patch. The stable `publish:HD10540:v1` row is present and future reruns use it.
- There is still no Git repository in this workspace, so no commit workflow was available.
- `src/segment/vad.py` still emits the Python 3.13 `audioop` deprecation warning during tests; this predates C11.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- Start C12. Use `python -m src.stages.publish --dokid <dokid> --work-dir <root> --backend remote --apply-migrations` for remote publish after C10 artifacts exist.
- Required remote env vars are `RIKET_BUNNY_API_KEY`, `RIKET_SUPABASE_PROJECT_REF`, `RIKET_SUPABASE_ACCESS_TOKEN`, and `RIKET_SUPABASE_SECRET_KEY`. The publishable key is for public readback/local viewers, not server writes.
- C11 assumes `10_render/<clip_id>_540x960.mp4` and `10_render/<clip_id>.webp`; it does not assume a VTT file exists.

## Frontend feed redesign - DONE 2026-08-02

**Built:** `web/src/App.tsx`, `web/src/styles.css`
**Tests:** `node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` green, `node .\node_modules\vite\bin\vite.js build` green, `python tasks.py test lint typecheck` green.
**Contracts touched:** none.

**Decisions made:**
- Reworked the feed toward a darker full-bleed video surface with compact white overlays, so metadata and controls consume less of the 9:16 frame.
- Default follow state is now empty for people and parties; the first visible feed follow button loads as `Följ`, not `Följer`.
- Kept `muted=false` on load and verified the mute control initially exposes `Stäng av ljud`.
- Added an overlay transport cluster with play/pause plus 10-second rewind/forward. The scrubber remains edge-pinned and draggable.

**Observations (not fixed, out of scope):**
- Browser autoplay policy can still block unmuted playback until a user gesture. In that case the video remains unmuted but paused with the play control visible.
- The existing Python `audioop` deprecation warning still appears during acceptance tests; this predates the frontend change.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- Local Vite QA ran at `http://127.0.0.1:5199/` using Chrome mobile viewports 393x852, 360x640, and 320x568.

## Frontend feed cleanup - DONE 2026-08-02

**Built:** `web/src/App.tsx`, `web/src/styles.css`
**Tests:** `node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` green, `node .\node_modules\vite\bin\vite.js build` green, `python tasks.py test lint typecheck` green.
**Contracts touched:** none.

**Decisions made:**
- Removed the under-name clip tags (`svar`, archetype, `Klipp N`) from the feed overlay.
- Removed the persistent center transport controls. Tapping the video now flashes only a play or pause icon for ~520 ms, then clears the screen again.

**Observations (not fixed, out of scope):**
- Fast seeking remains available through the draggable progress scrubber rather than persistent center skip buttons.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- Chrome mobile QA verified zero `.clip-context` elements, zero persistent transport controls, and a transient `.playback-flash` that disappears after tap.

## C7 local title generation experiment - DONE 2026-08-02

**Built:** `src/scoring/titles.py`, Ollama title integration in `src/stages/select.py`, title settings in `src/config.py`, and focused unit/integration coverage.
**Tests:** `python tasks.py test lint typecheck` green: 144 passed, 2 deselected, 1 existing `audioop` deprecation warning.
**Contracts touched:** none.

**Decisions made:**
- Title generation is opt-in with `RIKET_TITLE_BACKEND=ollama` or `--title-backend ollama`; the default remains the deterministic first-sentence fallback so CI and unattended runs never require Ollama.
- The tested local model is `qwen3:8b` through Ollama 0.32.5. C7 sends only final selected clip text, speaker metadata, archetype, and debate title; it never uploads video.
- The model selects one numbered transcript sentence as evidence. A title is accepted only when it is 28-60 characters, uses Latin characters, is not all caps or dangling, introduces no number, keeps content words grounded and in evidence order, preserves important forecast/number qualifiers, and attributes CONFRONT titles. Invalid output gets up to three corrective attempts, then C7 keeps the fallback title.
- The selector remains deterministic and pure. LLM enrichment happens in the C7 stage after portfolio selection, without changing `SelectedClip` or any other shared contract.

**Local benchmark:**
- Initial raw `qwen3:4b-instruct` output was not safe: it produced all-caps text, altered numbers, misspelled Swedish words, and inverted claims.
- `qwen3.5:4b` improved wording but still edited evidence and overclaimed. The final `qwen3:8b` guarded run used the GTX 1080 at 100% GPU with a 4096-token context and took 94.8 seconds for 16 clips including retries.
- Strict validation accepted 4/16 titles and safely retained the old title for 12/16: `Strömmer: Tyresö bör ha egen polisstation`, `Fler patruller och en starkare närvaro i vardagen`, `Strömmer: Polistillväxten ska öka`, and `Sverige riskerar att hamna i EU:s underskottsförfarande`.

**Observations (not fixed, out of scope):**
- The free 8B model is useful as a draft generator but is not good enough for unattended replacement of every political title. A same-model critic incorrectly approved a subject/object inversion, so it was not added.
- Ollama 0.32.5 and `qwen3:8b` are installed locally. The verified 1.56 GB installer was moved to `D:\OllamaSetup-0.32.5.exe` because the C drive was low on space.

**Blocked / needs a decision:**
- Decide whether titles should remain local draft suggestions with editorial review, or whether to benchmark a stronger hosted model for higher automatic acceptance. The current implementation deliberately favors fallback over a plausible but unsupported title.

**Next agent should know:**
- Re-run the benchmark with `python -m src.stages.select --dokid HD10540 --work-dir work\local_test_hd10540 --title-backend ollama --title-model qwen3:8b`.

## Clerk auth foundation + P0 privilege hardening - DONE 2026-08-02

**Built:** `web/src/clerk.tsx`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/supabase.ts`,
`web/src/styles.css`, `web/src/vite-env.d.ts`, `web/package.json`, `web/.env.example`,
`migrations/002_security_hardening.{up,down}.sql`, `src/stages/publish.py`,
`tests/unit/test_publish_migrations.py`, `docs/RECOMMENDATION_PREREQUISITES.md`,
`docs/DEPENDENCIES.md`
**Tests:** Full acceptance green - `pytest -m "not live and not slow"` **154 passed, 2 deselected**
(144 before, +10 new migration tests); `ruff check .` clean; `mypy src` strict clean, 66 files.
TypeScript `tsc --noEmit` green; `vite build` green.
Caveats on how that was verified: the Linux sandbox has Python 3.10 while the project targets
3.11+, so the run used a venv with a `.pth` shim aliasing `datetime.UTC` to `timezone.utc` (the
only 3.11-only feature in `src/` and `tests/`), and `opencv-python-headless` in place of
`opencv-python`. The `vite build` used `cssMinify:false` because the committed `node_modules`
holds win32-only native bindings. **Re-run `python tasks.py test lint typecheck` on Windows**
against the real pins before committing.
**Contracts touched:** none.

**Decisions made:**
- Identity is Clerk only, through Supabase's *native* third-party auth integration. The Clerk
  Supabase JWT template has been deprecated since 2025-04-01 and must not be used; it requires
  sharing the Supabase JWT secret with a third party.
- Clerk's own quickstart prompt targets Next.js App Router (`proxy.ts`, `clerkMiddleware()`,
  `app/layout.tsx`, `@clerk/nextjs`). None of it applies here - `web/` is a React 19 + Vite SPA
  with no router and no server. The correct SDK is `@clerk/react`, wrapping `main.tsx`.
- Auth uses `mode="modal"` for sign-in/sign-up. This sidesteps prerequisite N-4 entirely: the
  InstaPods static host has no SPA fallback, so redirect routes like `/sign-in` would 404.
- Clerk is optional at runtime. `AuthProvider` renders children unwrapped when
  `VITE_CLERK_PUBLISHABLE_KEY` is absent, so a deploy without the env var cannot take the public
  feed down. `clerkEnabled` gates every Clerk component.
- `loadPublishedClips()` stays anonymous. Published clips are public data readable by `anon`, so
  sending a Clerk token there would only create a failure mode. The token path lives in the new
  `supabaseRest(path, { accessToken })` helper for the private endpoints F1/F2 will add.
- Added `checkClerkSupabaseLink()` as a diagnostic. It performs one authenticated read and
  reports whether Supabase accepted the Clerk JWT - the fastest way to tell whether the
  third-party auth registration has been done.
- Consent switches now default to **off** (`personal`, `analytics`, `email` all `false`). They
  were `personal: true, email: true`. Still in-memory only; this is a partial C-5 fix.
- `discover_migrations()` replaces the hardcoded `MIGRATION_PATH`. `--apply-migrations` applied
  only `001_publish_schema.up.sql`, so migration 002 would never have run.
- Migration 002 revokes the default `PUBLIC` execute grant on `publish_clip_batch(jsonb)`, loops
  over every `SECURITY DEFINER` function in `public` and does the same, pins the definer
  `search_path` to `pg_catalog, public`, adds a `schema_migrations` ledger table, and drops
  `discovered` from `sources_public_read`.

**Live findings (recorded, not fixed):**
- The `sk_live_...` secret key was pasted into a chat transcript. It must be rotated in the
  Clerk dashboard. It is not used anywhere in this repo.
- The supplied `pk_live_Y2xlcmsudmFrdHNrb2xhbi5zZSQ` decodes to `clerk.vaktskolan.se` - a
  production instance bound to a domain the app is not served from. Unusable at
  `rikettv.nbg1-3.instapods.app`.
- The Clerk dashboard already has a dedicated **RiketTV** application. Its development instance
  is `leading-seasnail-33.clerk.accounts.dev`; JWKS at
  `https://leading-seasnail-33.clerk.accounts.dev/.well-known/jwks.json`. Both its keys read
  "Never used". `web/.env.local` holds the dev publishable key and is gitignored via `.env.*`.
- Bundle cost of Clerk: `index.js` 219.6 kB -> 528.0 kB raw (159.9 kB gzipped). Acceptable for
  now; revisit with code-splitting if the mobile feed's first paint regresses.

**Observations (not fixed, out of scope):**
- `BUILD_PLAN.md` at the repo root and `docs/BUILD_PLAN.md` have diverged (different checksums).
  `AGENTS.md` points at the `docs/` copy. One should be deleted.
- `ProfileScreen` still shows invented counts ("Sparade klipp 24", "Följda ämnen 12") and
  `mapClip()` still fabricates `likes`/`comments`. Prerequisite FE-2.
- No CI exists (`.github/` absent), so every gate is enforced by hand.

**Dashboard configuration completed this session:**
- Clerk dashboard -> Connect Clerk with Supabase, instance RiketTV / Riket / **Development**:
  status **Enabled**. Clerk session tokens now carry the `role: authenticated` claim that
  Supabase PostgREST requires.
- Supabase project `nlooigmwuqqhhnontlgp` -> Authentication -> Sign In / Providers ->
  Third-Party Auth: **Clerk ENABLED**, domain `https://leading-seasnail-33.clerk.accounts.dev`.
  This was the project's first third-party provider.
- Both sides point at the Clerk *development* instance. Repeat both steps for the production
  instance once A-2 (custom domain) is resolved; the two instances have different domains, so
  the Supabase entry must be added again, not edited.

**Blocked / needs a decision:**
- Production launch still needs a domain. See prerequisite A-2.
- Nothing yet writes to `private.*` because that schema does not exist. Authenticated Supabase
  calls now *authenticate*, but there is still no table only a signed-in user may read or write,
  so the integration is not yet exercised by real product code. F1 adds that.

**Next agent should know:**
- Run `npm install` inside `web/` on Windows before anything else; `@clerk/react` and
  `@clerk/localizations` are in `package.json` but not yet in the local `node_modules`.
- Dev server: `node .\node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5199 --strictPort`.
- Do not add `CLERK_SECRET_KEY` to any `VITE_*` variable. `web/.env.example` says so explicitly.
- The full prerequisite checklist for the recommender is `docs/RECOMMENDATION_PREREQUISITES.md`.
  This session closed P0-2, P0-3 (partially - the ledger table exists but nothing writes to it
  yet), P0-4 (file-level only, not a live privilege test), P0-6, and started A-3/A-6.

## P0 completion + Block O foundations + F1 plan — DONE 2026-08-02

**Built:** `migrations/003_auth_probe.{up,down}.sql`,
`migrations/004_revoke_default_table_grants.{up,down}.sql`, `src/publish/migrations.py`,
`scripts/apply_migrations.py`, `.github/workflows/ci.yml`, `supabase/config.toml`,
`.env.example`, `docs/adr/005-serving-boundary-and-runtime.md`,
`docs/adr/006-clerk-sole-identity-provider.md`,
`docs/adr/007-private-schema-and-consent-model.md`,
`docs/adr/008-recommendation-metadata-outside-contracts.md`,
`tests/live/test_db_privileges.py`, `tests/unit/test_migration_ledger.py`,
plus edits to `src/stages/publish.py`, `src/publish/supabase.py`, `docs/BUILD_PLAN.md`,
`docs/RECOMMENDATION_PREREQUISITES.md`, `web/src/{App.tsx,supabase.ts,types.ts,data.ts,styles.css,vite-env.d.ts}`.
Deleted the diverged root `BUILD_PLAN.md`.

**Tests:** `python tasks.py test lint typecheck` green on Windows against the real pins —
**160 passed, 54 deselected**, 1 pre-existing `audioop` warning; ruff clean; mypy strict clean
on 67 files. `tsc --noEmit` green; `vite build` green. The 54 deselected are 52 new `live`
DB-privilege tests plus the 2 pre-existing `slow` tests.
**Contracts touched:** none.

**Live finding — P0-7 confirmed, not yet fixed:**
Probed project `nlooigmwuqqhhnontlgp` from outside with only the publishable key that already
ships in the browser bundle:

- `GET /rest/v1/clip_features|engagement_events|jobs|pipeline_runs` → **200 `[]`**
  (authorized; RLS filtered every row)
- `POST /rest/v1/clips` → **`42501 new row violates row-level security policy`**
- `GET /rest/v1/schema_migrations` → **`42501 permission denied`**

The difference between those last two messages is the whole finding. `permission denied` means
no grant. `violates row-level security policy` means the grant *is* there and the statement
reached the policy check. So `anon` holds `INSERT` on `public.clips`, `jobs` and
`engagement_events`, and `SELECT` on every protected table — because Supabase ships
`alter default privileges in schema public grant all on tables to anon, authenticated` and
migration 001 never revoked it. Nothing is exploitable today; RLS has no INSERT policy. But RLS
is the only thing stopping it, and `engagement_events` is where F2 viewer telemetry lands.
Migration `004` revokes the existing grants and the default for future tables.

**Decisions made:**
- `public.auth_probe()` (migration 003) is the missing half of the Clerk verification. It is
  `SECURITY INVOKER`, returns only the caller's own verified claims, and is granted to
  `authenticated` while revoked from `anon`. The grant is the proof: `anon` gets
  `permission denied`, a signed-in caller gets their Clerk `sub` back from SQL. That single
  round trip demonstrates RS256 verification against the Clerk JWKS, the `role: authenticated`
  claim being honoured, and A-7's `clerk_user_id text` key being readable in SQL.
- Migration application moved out of the publish stage into
  `scripts/apply_migrations.py`. Migration 003 has nothing to do with publishing clips, and
  coupling schema changes to a media pipeline run was the reason the hardcoded path went
  unnoticed for so long.
- The `schema_migrations` ledger now actually gets written. It existed as a table after 002 but
  nothing inserted into it, so "apply the migrations" still meant "re-run every file". Checksums
  hash bytes, not decoded text, so a line-ending change is caught as the edit it is.
- `discover_migrations` moved to `src/publish/migrations.py` and is re-exported from
  `src/stages/publish.py`, so the existing test imports still work. Stages depend on libs, not
  the other way round.
- CI (`O-1`) installs the full pinned tree including the torch stack whisperx pulls in. A slimmer
  install would be faster and would mean CI is not testing what production runs.
- Deleted the root `BUILD_PLAN.md`. It had genuinely diverged — it still documented `make` where
  `docs/BUILD_PLAN.md` documents `tasks.py`. `AGENTS.md` points at the `docs/` copy.

**Observations (not fixed, out of scope):**
- `riksdagen-clip-pipeline-architecture.md` at the root is still byte-identical to
  `docs/ARCHITECTURE.md`. Harmless today because they cannot disagree, but it is a second copy
  and will eventually drift the same way `BUILD_PLAN.md` did.
- The CI workflow has never run. GitHub Actions cannot be exercised from here, so the first push
  needs watching — the torch install on a cold pip cache is the likely failure.
- `web/.env.local` is dead since `envDir` moved to the repo root. The live file is `.env.local`
  at the root.

**Blocked / needs a decision:**
- **Migrations 003 and 004 are not applied.** Needs `RIKET_SUPABASE_PROJECT_REF` and
  `RIKET_SUPABASE_ACCESS_TOKEN` in a root `.env` (see `.env.example`), then
  `python scripts/apply_migrations.py`.
- **The Clerk → Supabase token link is still unverified.** It needs migration 003 applied *and*
  a signed-in session. Nobody is signed in on the live site; the check cannot be completed
  without an account, which is the account holder's action to take.
- Production launch still needs a domain (`A-2`). Unchanged.

**Next agent should know:**
- The verification is one button once 003 is applied: Profil tab → Diagnostik →
  "Testa Clerk → Supabase" while signed in. It calls `rpc/auth_probe` and prints the claims.
  Record the `sub`, `role`, `iss` and `pg_role` values here when it first returns `ok`.
- `python -m pytest tests/live/test_db_privileges.py -m live` is the P0-4/P0-7 acceptance. It
  will fail until migration 004 is applied — that failure is the finding, not a broken test.
- F1 is scoped in `docs/BUILD_PLAN.md` with an explicit file scope and an explicit
  must-not-touch list. Read it before starting; ADR 007 explains why the schema may be built
  while F0 is still open, and what may not be done until F0 closes.

## FE-3 / FE-4 / FE-5 — playback signal integrity — DONE 2026-08-02

**Built:** `web/src/App.tsx` (feed activation, playback state, action rail).
**Tests:** `python tasks.py test lint typecheck` green — 160 passed, 54 deselected.
`tsc --noEmit` green; `vite build` green (407.43 kB, 117.54 kB gzipped).
Behaviour measured in Chrome at 375x812 against the sample feed, by hooking
`HTMLMediaElement.prototype.play` and driving the scroller:

| Scenario | Clips activated |
|---|---|
| Flick across 4 clips, 75 ms per clip (under the 180 ms dwell) | **1** |
| Scroll across 4 clips, 400 ms per clip (over the dwell) | **3** |

Loop check: `video.loop === false`, a dispatched `ended` calls `play()` once and playback
resumes from zero.
**Contracts touched:** none.

**Decisions made:**
- The dwell is 180 ms and the visibility floor is 0.72. The floor is
  `IMPRESSION_VISIBLE_FRACTION`, written down once because T-8 requires the activation
  rule and the analytics query to share one definition. When the analytics side is built,
  import that constant rather than retyping the number.
- Kept looping as product behaviour and implemented it explicitly rather than removing it.
  The viewer experience is identical; the difference is that the loop boundary is now an
  event instead of an invisible seek to zero.
- `loopCounts` is a ref, not state. Counting a replay must not re-render the feed.
- `blocked` is separate state from `paused` rather than a derived flag, so no future
  refactor can quietly collapse "browser refused autoplay" into "viewer paused".
- The comment button is icon-only. Measured in the browser: "Kommentera" needs 67 px and
  "Kommentar" 62 px in a 54 px rail that sits 7 px from the screen edge, so no Swedish
  label fits. It kept its accessible name.

**Observations (not fixed, out of scope):**
- `paused` is now write-only state — nothing reads it since a previous session removed the
  persistent transport controls. It is the natural anchor for the FE-6 playback state
  machine, so it was left in place rather than deleted and re-added.
- The comment button still has no comment feature behind it. Removing it is a product
  decision, not a data-integrity one, so it stayed.

**Blocked / needs a decision:**
- none

**Next agent should know:**
- FE-6 (the explicit idle/blocked/playing/paused/seeking/buffering/ended state machine with
  `visibilitychange`) is the natural next step and should absorb `paused`, `blocked` and
  `loopCounts` rather than adding a fourth parallel map.
- The measurement harness above is worth re-running after any feed change: hook
  `HTMLMediaElement.prototype.play`, drive `.feed-scroll` in fixed steps, count distinct
  activations. A regression here is silent and only shows up as inflated impressions.

## P0 closed live — migrations 003/004 applied — DONE 2026-08-02

**Applied:** `003_auth_probe`, `004_revoke_default_table_grants` to project
`nlooigmwuqqhhnontlgp` via `python scripts/apply_migrations.py`.

The ledger already held `001` and `002` with matching checksums, so the runner reported
them `already-applied` and only ran `003` and `004`. That is the first real proof that
`apply_pending_migrations()` works against a live database rather than a fake.

**Tests:** `python -m pytest tests/live/test_db_privileges.py -m live` — **52 passed**.

**Re-verified from outside the network, publishable key only:**

| Probe | Before | After |
|---|---|---|
| `POST /rest/v1/clips` | `42501 new row violates row-level security policy` | `42501 permission denied for table clips` |
| `GET /rest/v1/clip_features` | `200 []` | `42501 permission denied` |
| `GET /rest/v1/jobs` | `200 []` | `42501 permission denied` |
| `GET /rest/v1/pipeline_runs` | `200 []` | `42501 permission denied` |
| `POST /rest/v1/rpc/auth_probe` | `404 PGRST202` | `42501 permission denied for function auth_probe` |
| `GET /rest/v1/clips` | 16 rows | 16 rows |

The first row is the finding and the fix in one line. `violates row-level security policy`
means the grant was present and the statement reached the policy check; `permission denied`
means the grant is gone. The last row is the no-regression check on the public feed.

`auth_probe` moving from `404` to `permission denied` is half the Clerk proof: `anon` is
correctly refused. The other half needs a signed-in session.

**Blocked / needs a decision:**
- **`P0-9` — rotate the Supabase Management access token.** It was pasted into a chat
  transcript on 2026-08-02 to unblock this work, with the account holder's explicit
  agreement to rotate afterwards. Revoke at Supabase dashboard -> Account -> Access Tokens
  and replace the value in the gitignored `.env`. The `sk_live_...` Clerk secret key from
  the previous session is still outstanding and unrelated to this repo.
- The Clerk -> Supabase token link is still unverified end to end. Needs a sign-in.

**Next agent should know:**
- `.env` at the repo root now holds `RIKET_SUPABASE_PROJECT_REF` and
  `RIKET_SUPABASE_ACCESS_TOKEN`, so `python -m pytest -m live` and
  `python scripts/apply_migrations.py` both work without further setup.
- New tables in `public` are now unreachable by default. After `create table public.foo`,
  add an explicit `grant select on public.foo to anon` if the browser should read it.
  Silence is denial, deliberately.

## A-3 / A-4 — Clerk → Supabase link VERIFIED end to end — DONE 2026-08-02

The integration had been configured in two dashboards since the previous session and never
exercised. It is now proven, with evidence, against project `nlooigmwuqqhhnontlgp` and Clerk
development instance `leading-seasnail-33.clerk.accounts.dev`.

**The signed-in call — `POST /rest/v1/rpc/auth_probe`, HTTP 200:**

```json
{
  "sub":             "user_3HN2v8fTvekjonu4R3jzk8Sk6iY",
  "role":            "authenticated",
  "iss":             "https://leading-seasnail-33.clerk.accounts.dev",
  "azp":             "http://127.0.0.1:5199",
  "pg_role":         "authenticated",
  "auth_jwt_sub":    "user_3HN2v8fTvekjonu4R3jzk8Sk6iY",
  "auth_uid":        null,
  "claim_keys": ["azp","exp","fva","iat","iss","nbf","role","sid","sts","sub","v"]
}
```

`sub` matches `window.Clerk.user.id` exactly. **The identical call with the publishable key
returns `401 42501 permission denied for function auth_probe`** — that contrast is the proof,
not the 200 on its own.

What each line establishes:

- PostgREST verified an RS256 signature against the Clerk JWKS. A forged token with the right
  `iss` and `kid` but a bad signature returns `PGRST301 None of the keys was able to decode
  the JWT`, so the verification is real and not a shape check.
- `pg_role = authenticated` — Postgres switched roles on the strength of the `role` claim that
  Clerk's Supabase integration adds. Without it the caller would land on `anon` and be denied.
- **`auth.jwt()->>'sub'` equals the Clerk subject.** This is the A-7 mechanism every private
  table's RLS will use, confirmed working rather than assumed.
- **`auth.uid()` is `null`.** Clerk subjects are strings, not UUIDs. Any future policy reaching
  for `auth.uid()` silently matches nothing — which is exactly why A-7 mandates
  `clerk_user_id text` and `(select auth.jwt()->>'sub')`.

**Bug found and fixed forward (migration 005):**
`auth_probe()` as shipped in 003 used `pg_catalog.current_user::text`. `current_user` is a
reserved keyword, not a schema-qualified function, so Postgres parsed `pg_catalog` as a table
and every call raised `42P01 missing FROM-clause entry for table "pg_catalog"`. PostgREST maps
42P01 to **HTTP 404**, so the failure was indistinguishable from "the function does not exist"
— the one diagnosis that was wrong, and the one the UI confidently reported.

Two things worth carrying forward from that:
- A PostgREST 404 can come from *inside* a function body. `PGRST202` in the response body means
  routing; a bare Postgres SQLSTATE means the function ran and failed.
- `has_function_privilege` returned true throughout. Checking the grant was not enough. The new
  `test_auth_probe_body_actually_executes` calls `select public.auth_probe()` so the body runs.

003 was already applied and in the ledger, so it was fixed forward rather than edited — editing
it would have changed its checksum and `apply_pending_migrations()` would have refused to run.
That is the ledger behaving as designed, on its first real opportunity to.

**Tests:** `python -m pytest tests/live/test_db_privileges.py -m live` — **53 passed**.
`python tasks.py test lint typecheck` — 160 passed, 55 deselected. `tsc --noEmit` green.

**Observations:**
- **A-8:** Clerk session tokens live **60 seconds** (`exp - iat`). Short. The refresh-then-retry
  behaviour A-8 asks for is not optional polish — a viewer who scrolls for two minutes will hit
  an expired token, and queued telemetry must survive that 401.
- `azp` is the origin the token was minted for (`http://127.0.0.1:5199` here). A-11's in-function
  verification should check it against an allow-list; Supabase itself does not.
- The `aud` claim is absent from Clerk's default session token.

**Next agent should know:**
- The verification is repeatable: Profil → Diagnostik → "Testa Clerk → Supabase" while signed in.
  It now prints the token summary and the raw response on failure, not just a Swedish label.
- Clerk development instances accept `+clerk_test` addresses with the fixed code `424242`, so
  this can be re-run without a real identity.

## C13 — Observability, freshness SLO and runbook — DONE 2026-08-03

**Built:** `migrations/007_job_runs.{up,down}.sql`, `src/observability/{__init__,metrics}.py`,
`scripts/pipeline_report.py`, `docs/RUNBOOK.md`, `.github/workflows/schema-drift.yml`,
`tests/unit/test_observability_metrics.py`, `tests/live/test_observability.py`, plus job-run
recording in `src/orchestrator/queue.py`.
**Tests:** `python tasks.py test lint typecheck` green — **208 passed**, 61 deselected;
ruff clean; mypy strict clean on 73 files. Live: 6 observability + 6 queue + 53 privilege.
**Contracts touched:** none.

**Decisions made:**
- `public.jobs` is mutated in place, so once a job completes the only surviving evidence of a
  rocky path is `attempts = 3`. `public.job_runs` is append-only, one row per attempt, and is
  what makes "how long does render take", "what fails most" and "did Tuesday process cleanly"
  answerable at all. Cost is one INSERT per transition.
- **The reaper writes history too.** A crashed worker reports nothing, so without an explicit
  `reaped` row the most interesting failures would be precisely the ones missing from the
  metrics.
- History is written *before* the state change, while `locked_at`/`locked_by` still describe
  the attempt the update is about to clear.
- ADR 009's one-statement rule does not extend to the history INSERT, and the code says so.
  That rule exists because `claim` is where atomicity buys the exclusion guarantee. A request
  dying between the state change and the history row costs a gap in a chart, not a lost job.
- `reaped` counts as a failure in `stage_failures()`. A worker that died mid-job did not
  succeed.
- Timings use `percentile_disc`, never a mean. A mean hides the tail, and the tail is what
  breaks a lease.
- Freshness excludes backfilled debates by filtering on `debate_date`, not `published_at`.
  A 2024 debate published today would otherwise report a two-year lag and destroy the
  percentile — the same distinction `Q-4` makes for ranking.
- Party distribution is **reported, not enforced**. The balance policy is `F0-13` and belongs
  to product, not to a scoring function. Building the measurement first is what makes that an
  informed decision.

**Live numbers, project `nlooigmwuqqhhnontlgp` (2026-08-03):**
- Inventory: 1 debate, 7 speeches, **16 published clips**, 2 parties. `Q-1` wants ~2000.
- Freshness over 120 days: 1/1 debates published, **p50 = p95 = 41.2 days**. That is the
  backfilled test batch, not steady state — the 30-day window correctly reports "no debates"
  and will stay honest once real supply starts.
- Party exposure: **M 81.2%, S 18.8%** across 16 clips. An interpellation debate where the
  minister answers repeatedly. Not a ranking artefact — it is what the source material
  contains — but it is exactly the kind of skew `F0-13` exists to have an opinion about.
- Stage timing/reliability: empty. No job has run through the queue yet.

**Observations (not fixed, out of scope):**
- **No discovery cron.** C12 calls for 30-minute discovery; debates are still enqueued by
  hand. This is the largest remaining gap in P1 and the reason "unattended" currently means
  "unattended once started".
- **Render is one job per debate**, serial, with no skip-if-exists. A crash at clip 399 of 400
  re-encodes all 400. At high volume the render can also outlive its six-hour lease, at which
  point the reaper starts a *second* worker on the same debate. Both are in
  `docs/RUNBOOK.md` under Known sharp edges.
- The freshness SLO is measured from midnight on `debate_date` because that column is a DATE.
  It overstates lag by up to a day and cannot be fixed by arithmetic — it needs Riksdagen's
  publication timestamp captured at C1.

**Blocked / needs a decision:**
- `P0-9` — the Supabase Management access token is still the one pasted into a chat
  transcript on 2026-08-02. Rotate it.

**Next agent should know:**
- `python scripts/pipeline_report.py` is the one command to run first when something looks
  wrong. `--json` for machine-readable, `--freshness-days N` to widen the window.
- `docs/RUNBOOK.md` is organised by symptom, not by subsystem, because a symptom is what you
  actually have when something breaks.
- The schema-drift workflow runs daily at 06:15 UTC and is the only early warning for the
  pipeline's least stable dependency. A red run means discovery is broken *silently* — the app
  keeps serving yesterday's clips and nothing reaches a user.

## C12b — Per-clip render fan-out — DONE 2026-08-03

**Built:** `src/stages/render.py` (`render_clip`, `selected_clip_ids`, skip-if-exists,
`--clip-id`/`--force`), fan-out and join-barrier support in
`src/orchestrator/{jobs,queue,cli}.py`, `tests/unit/test_orchestrator_fanout.py`,
updates to `tests/integration/test_orchestrator_recovery.py`, `docs/BUILD_PLAN.md`
(C12b scope entry), `docs/RUNBOOK.md`.
**Tests:** `python tasks.py test lint typecheck` green — **235 passed** (was 219),
67 deselected; ruff clean; mypy strict clean on 74 files.
**Contracts touched:** none.

**Measured against the real encoder** (fixture `HD01SfU35`, 2 clips):

| Operation | Time |
|---|---|
| `render_clip` on a clip that already exists | **0 ms**, file untouched |
| `render_dokid` over 2 already-rendered clips | **15 ms** |
| `render_clip --force` (a real encode) | **7,015 ms** |

At 400 clips a failed retry used to mean ~47 minutes of re-encoding. It is now
milliseconds, and only the clip that actually failed is redone.

**Decisions made:**
- `render` became a **fan-out node**: it runs no stage of its own, enqueues one
  `render_clip` per selected clip, and completes. Its lease dropped from 6 h to
  10 minutes because the hours now live in the children. That also removes a latent
  hazard: a render exceeding a 6 h lease would have been reaped mid-flight and a
  second worker started on the same debate, both writing the same paths.
- **The join barrier** is what the C12 chain could not express. Each `render_clip`
  checks whether any sibling is still outstanding; the last one through enqueues
  `publish`. Two children finishing simultaneously both see zero and both enqueue —
  safe, because the idempotency key admits exactly one. A lock would cost more than
  the duplicate insert it prevents.
- **A dead child blocks `publish` deliberately.** Shipping 399 of 400 clips and
  calling the debate done is worse than stopping. It surfaces in `pipeline status`
  and waits for a retry — the same rule as everywhere else in the chain.
- Children carry `dokid` in their payload because their own `entity_id` is a clip ID
  while `publish` is per debate. Without it the barrier would have nothing to name.
- `render_dokid` still exists and still works; it is now a loop over `render_clip`.
  `run-fixture` and single-machine runs are unaffected.
- `StageCallable` was widened to `(*args: str, work_dir=...)` rather than modelled as
  an overload, because the only caller is one dispatch in `Worker._execute` that
  already branches on `joins_siblings`.

**Observations (not fixed, out of scope):**
- The fan-out mechanism is generic (`fans_out_to` / `fan_out_units` / `joins_siblings`)
  but only `render` uses it. C4/C5/C6 are per-speech and could fan out the same way;
  that needs per-speech entrypoints on five more stages and a scope entry of its own.
- Skip-if-exists checks existence and non-zero size, not integrity. A truncated MP4
  from a killed ffmpeg would be skipped rather than re-encoded. `--force` is the
  escape hatch; a checksum or a duration probe would be the real fix.

**Blocked / needs a decision:**
- `P0-9` — rotate the Supabase Management access token pasted into the transcript on
  2026-08-02.
- Whether to backfill Riksdagen's 2024-2025 archive (~50 debates) or start from now.
  `pipeline discover --since now` opts out; doing nothing opts in.

**Next agent should know:**
- P1 is complete. `Q-1` (inventory) is now purely a function of running the daemon —
  the machinery no longer stands in the way.
- Four workers on four machines render a debate in roughly a quarter of the time.
  On one workstation the win is smaller but the retry cost is the real prize.
- `python -m src.stages.render --dokid X --clip-id Y --force` re-renders one clip.

## Backfill readiness — doktype survey, skip state, month windows — DONE 2026-08-03

**Built:** `migrations/008_job_skipped_state.{up,down}.sql`, `NotClippableError` in
`src/errors.py`, `backfill_window()` + `pipeline backfill` in
`src/orchestrator/{discovery,cli}.py`, `JobQueue.skip()`, corrected
`DEFAULT_DISCOVERY_DOKTYPES`, runbook backfill section, 9 new tests.
**Tests:** 243 passed (was 235); ruff and mypy clean on 74 files.
**Contracts touched:** none.

**Surveyed the live Riksdagen API before backfilling anything** — the owner asked
whether webb-tv content beyond debates (guest visits and so on) would break the
pipeline. Measured, not assumed:

| doktyp | What it is | Documents | Through real C1 |
|---|---|---|---|
| `ip` | Interpellationsdebatt | 15,757 | HD10540: 7 speakers / 7 anföranden |
| `kam-fs` | Frågestund | 604 | 81 / 81 |
| `kam-sd` | Särskild debatt | 100 | 66 / 66 |
| `kam-ad` | Aktuell debatt | 97 | 90 / 90 |
| `kam-vo` | Beslut / Votering | 8,047 | refuses — nothing to clip |
| `kam-ip` | Session wrapper "Interpellationssvar" | 616 | refuses — no speaker list |
| `kam-al` | Session wrapper | 68 | refuses |

**Two findings:**

1. **Discovery was asking for the wrong type.** `DEFAULT_DISCOVERY_DOKTYPES` was
   `("kam-fs",)`, but HD10540 — the batch actually published, the 16 clips live in
   the app — is `doktyp=ip`. The automated loop would never have found the content
   type already validated end to end. Now `("ip", "kam-fs", "kam-sd", "kam-ad")`.
2. **`kam-ip` is not `ip`.** 616 session-level "Interpellationssvar" wrappers versus
   15,757 individual debates. Easy to pick the wrong one; the constant says so.

**Discovery is a whitelist, which is the safety property the owner was asking about.**
`dokumentlista?doktyp=X` only returns what is named, so guest visits, ceremonies and
school tours cannot appear. And a non-debate fails in `discover` — the first stage,
metadata only — before `acquire` downloads any video. The cost of a wrong doktype is
a failed metadata fetch, not a wasted download.

**Decisions made:**
- `NotClippableError` is now distinct from `RiksdagenParseError`. An empty speaker
  list is not schema drift — it is a written interpellation answer or a recess
  session. Conflating them made the daily canary cry wolf and, during a backfill,
  would have buried real failures behind hundreds of normal gaps. Everything from
  2026-06-18 onward is in that category: the chamber had risen for the summer.
- Migration 008 adds a `skipped` state. Terminal but not failed: the job ran,
  concluded correctly that there was nothing to do, and the chain stops. Retrying it
  three times first was wrong twice over.
- **Backfill never reads or writes the discovery watermark.** Backfill is bounded and
  historical; the daemon is the forward loop. Sharing state is how backfilling
  January silently makes the daemon skip August.
- Backfilled work is enqueued at **negative priority**, so this morning's debate is
  always claimed before an archive of 2024.
- `--to` is exclusive, so consecutive months cannot double-count a day. Overlapping
  windows are safe regardless — the idempotency key admits each debate once.

**Live check:** `backfill --from 2026-03-01 --to 2026-04-01 --dry-run` found **64
documents** for March 2026, a workable month-sized window.

**Blocked / needs a decision:**
- `P0-9` — rotate the Supabase Management access token from the 2026-08-02 transcript.

**Next agent should know:**
- Volume: `ip` alone is 15,757 documents. Do not run an unbounded backfill; a month is
  the unit, and `pipeline_report.py` after each one is the feedback loop.
- The M 81% / S 19% party skew seen in the first 16 clips comes from interpellation
  debates structurally — a minister answers repeatedly. Watch it as `ip` volume grows;
  it is `F0-13` territory, not a bug.

## C7 title generation moved to a hosted API — DONE 2026-08-03

**Built:** `OpenAICompatibleTitleGenerator` + `TokenUsage` + shared
`_evaluate_title_response` in `src/scoring/titles.py`, `api` backend in
`src/stages/select.py`, title API settings in `src/config.py`,
`scripts/benchmark_titles.py`, 6 new tests, `.env.example` entries.
**Tests:** 248 passed (was 243); ruff and mypy clean on 74 files.
**Contracts touched:** none.

**Benchmark, 16 real HD10540 clips, deepseek-chat:**

| | local qwen3:8b | DeepSeek API |
|---|---|---|
| Accepted | 4/16 (28%) | **7/16 (44%)** |
| Wall clock | 94.8 s | **42.4 s** |
| Attempts per accepted | — | 1.57 |
| Cost | GPU time | **$0.0013 → $0.08 per 1,000 clips** |

59% of input tokens were cache hits — the 1,553-char system prompt is identical
on every call and DeepSeek bills cache reads at ~10% of the miss price. That is
why the real cost came in ~3x below the estimate.

**Decisions made:**
- The validation loop is now shared by both backends via
  `_evaluate_title_response`. The model is the cheap, swappable part;
  `title_validation_errors` is what makes a headline safe to publish over a real
  politician's face, and it must not vary by provider.
- The backend is generic OpenAI-compatible rather than DeepSeek-specific, so
  switching to MiniMax, z.ai or anything else is an env change.
- `_schema_error()` reports the actual title length instead of the opaque
  `invalid_json_schema:string_too_long`, and the correction prompt restates the
  limit. **This removed all three length failures.**
- Acceptance nonetheless stayed at 7/16: the three clips that had failed on
  length now fail on grounding instead. Forced to be short, the model invents a
  word rather than dropping one. **The binding constraint is the grounding
  rules, not formatting** — which is the honest reading, and the reason not to
  chase the number by loosening the validator.

**Rejection profile after the fix** (9 rejections):
`title_words_out_of_evidence_order` 7, `ungrounded_title_words` 6 (overlapping).
Both are the fact-checker working. The order rule is the strictest of them and
would move acceptance most if relaxed — it exists because the previous session
caught a subject/object inversion that a same-model critic approved, so it
should not be relaxed without a deliberate decision recorded here.

**Observations (not fixed, out of scope):**
- At $0.08 per 1,000 clips, a 44% acceptance rate is still a good trade: the full
  ~15,000-clip archive costs about $1.20 and yields ~6,600 better titles. Cost is
  not a reason to tune anything.
- The 9 rejected clips keep their deterministic first-sentence title, which is
  the correct conservative behaviour and unchanged.

**Blocked / needs a decision:**
- `P0-9` — rotate both the Supabase token and the DeepSeek key; both were pasted
  into chat transcripts.
- Whether to relax `title_words_out_of_evidence_order`. Not recommended without
  a benchmark showing it does not readmit inversions.

**Next agent should know:**
- `python scripts/benchmark_titles.py --dokid HD10540 --work-dir work/local_test_hd10540`
  re-runs the comparison against any provider; `--model` and `--base-url` override.
- Set `RIKET_TITLE_BACKEND=api` to use it in C7. Default stays `fallback` so no
  unattended run starts spending money by accident.

## C7 titles — deepseek-v4-pro at 16/16, concurrency, open name decision — 2026-08-03

**Tests:** 250 passed; ruff and mypy clean on 74 files.

**Benchmark, 16 real HD10540 clips** (`scripts/benchmark_titles.py`):

| Config | Accepted | Per clip | Per 1,000 clips |
|---|---|---|---|
| local qwen3:8b (baseline) | 4/16 (28%) | 5.9 s | GPU time |
| deepseek-v4-flash | 7/16 (44%) | 2.6 s | $0.08 |
| **deepseek-v4-pro** | **16/16 (100%)** | 44 s serial, ~21 s at 6-way | **$0.88** |
| deepseek-v4-pro, no names | 9/16 and 11/16 | — | $1.80 |

**I measured Pro wrong twice before getting it right.** `max_tokens` was 200, then
3,000; Pro spends ~2,200 tokens reasoning before emitting any content, so both
truncated it mid-thought and returned empty strings. Truncation is
indistinguishable from a model that cannot follow instructions — it read as
"the expensive model is worse" when it was the best of the three. `DEFAULT_MAX_TOKENS`
is now 16,000 and there is a regression test asserting it stays clear of that.

**Run-to-run variance is real.** Two runs of the identical no-name config gave
9/16 and 11/16 at temperature 0.15. Differences under about 3 clips are sampling
noise, not signal. Re-run twice before believing a comparison.

**Decisions made:**
- Titles are generated concurrently, order preserved (`RIKET_TITLE_CONCURRENCY`,
  default 4). Each title is an independent HTTP call; serially a reasoning model
  would spend 44 minutes on a 60-clip debate and dominate the pipeline.
- `TokenUsage` is lock-guarded and now reports reasoning tokens, which are billed
  as output and dominate the bill on a reasoning model.
- Backend is generic OpenAI-compatible, so MiniMax or z.ai is an env change.

**OPEN DECISION — speaker names in titles.**
The owner wants titles without "Strömmer:" prefixes, because the feed already
shows speaker and party directly beneath the title, and the prefix costs ~10 of
60 characters.

Removing it from the prompt alone was tried and **reverted**, because it is
half a change: `title_validation_errors` still enforces
`confront_title_missing_attribution`, so the prompt forbade what the fact-checker
demanded. Four of the seven extra rejections were exactly that contradiction.

Doing it properly needs, in one change:
1. Drop `confront_title_missing_attribution` from the validator.
2. Add a same-debate duplicate check — without the speaker as a differentiator
   the model converged on the same number twice (clips 1 and 3 both became
   "Beräknas anslagen till polisen öka med 43 procent").
3. Re-benchmark **twice** given the variance above.

The counter-argument, which the owner should weigh: clip 8 is Tegnér attacking
Strömmer. Without attribution it reads, under a "Gunnar Strömmer" label, as
Strömmer criticising his own party. Rare, but it is the case the rule exists for.

**Blocked / needs a decision:**
- The name question above.
- `P0-9` — rotate the Supabase token *and* the DeepSeek key; both are in chat
  transcripts.

**Next agent should know:**
- Default is still `RIKET_TITLE_BACKEND=fallback`, so nothing spends money
  unattended. Set `api` plus `RIKET_TITLE_MODEL=deepseek-v4-pro` to enable.
- $4 of DeepSeek credit is roughly 4,500 clips at Pro pricing. March 2026 alone
  is 64 debates.

## C7 titles — the 16/16 score was measuring the wrong thing — DONE 2026-08-03

**Built:** relaxed `title_validation_errors`, `_is_grounded` inflection matching,
`speaker_surname`, `MODEL_PRICES`/`price_for` in `src/scoring/titles.py`;
debate-wide duplicate suppression and speaker-roster threading in
`src/stages/select.py`; per-model pricing in `scripts/benchmark_titles.py`.
**Tests:** 258 passed (was 250); ruff and mypy clean on 74 files.
**Contracts touched:** none. `TitleGenerator.generate` gained a defaulted
`debate_surnames` keyword — that protocol lives in `src/scoring/titles.py`, not
`src/contracts.py`, so rule 1 does not apply.

### Why the last session cost $0.43

Answered from `work/title_bench_*.json`, which recorded the provider's own usage
blocks. No new API calls were needed to establish any of this.

- **98% of the output tokens paid for were reasoning, not writing** — 455,164 of
  464,529 across 226 captured requests. Each call spent 2,000–5,400 tokens
  thinking to emit a ~40-token headline.
- **`src/config.py` billed every model at Flash's price.** Verified against
  api-docs.deepseek.com: Pro is `$0.435 / $0.87` per 1M in/out, **3.1x** Flash's
  `$0.14 / $0.28`. Every Pro benchmark reported about a third of its true cost.
- **`TokenUsage` double-counted cache hits.** DeepSeek returns the same figure as
  both `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens`; the
  accumulator added both. Cached (350k) exceeded prompt (222k) — impossible — and
  `cost_usd` then clamped billed input to zero.

Recomputed correctly the eight saved runs cost **$0.32**; scaling 226 captured
requests to the ~285 the owner was billed for gives **$0.40** against an actual
$0.43. **The previous entry's "$0.88 per 1,000 clips" for Pro is really $2.70.**

### The finding that matters: 16/16 was not a quality measurement

A ~100-line script that picks a sentence and searches contiguous word spans — no
LLM, no API, **$0.00** — also scores **16/16** against the old validator. Its
titles are unreadable (`(M): Som snabbt kan gripa in när det krävs och som
erbjuder`). Pro's 16/16 titles were genuinely good. **Both score 100%.**

So the number the last session spent $0.43 hill-climbing certifies that a title
is *legal*, never that it is *good*. Worse, the rule doing most of the work —
`title_words_out_of_evidence_order`, 21 of the rejections — reduced the task to
deletion-only compression, a constraint search. That is precisely what the
reasoning tokens were buying. The expensive model was brute-forcing a puzzle the
validator invented.

### What changed, and the evidence for it

Owner decided both, 2026-08-03. Rejection counts are across all 226 requests.

| Rule | Fires | Change |
|---|---:|---|
| `title_words_out_of_evidence_order` | 21 | **Removed.** Style rule, not safety. |
| `confront_title_missing_attribution` | 12 | **Replaced** by `title_names_other_speaker_without_attribution`. |
| `ungrounded_title_words` | 10 | **Kept, stemming added.** `polistätheten` vs `polistäthet` was a false alarm. |
| `unsupported_numbers`, `missing_qualifiers`, length, caps, chars, full stop, dangling | ≤3 | **Kept unchanged — this is the real safety floor.** |

Attribution is now required only when a title names *another* member of the same
debate. The roster comes from the debate's own `03_speeches.json`, so it needs no
name recognition. This is what finally unblocks the owner's "no speaker names"
preference, which had been reverted last session for being half a change.

### Benchmark on the relaxed validator, same 16 HD10540 clips

| Model | Accepted | After dedupe | Wall clock | Reasoning tokens | Per 1,000 clips |
|---|---|---|---|---|---|
| **`deepseek-chat`** | **13/16** | **12/16** | **8.5 s** | **0** | **$0.09** |
| `deepseek-v4-flash` | 16/16 | 14/16 | 202.7 s | 90,722 of 91,388 out | $1.70 |
| `deepseek-v4-pro` (strict, previous) | 16/16 | — | ~700 s | 47,667 | $2.70 |

`deepseek-chat` was 7/16 under the old rules and is 13/16 under these — same
model, same clips. **`deepseek-v4-flash` is also a reasoning model**, 99% of its
output tokens; the name does not mean cheap. `deepseek-chat` is the only one of
the three that does not think, and it is **30x cheaper and 24x faster than Pro**
for titles a human reads as comparable:

- `Polisreformen 2015 blev en massdöd av polisstationer`
- `Sverige riskerar att hamna i EU:s underskottsförfarande`
- `Strömmer: S ska förhandla med V och MP efter valet`

Its 3 rejections are the safety floor working: `styret` and `botten` are words
nobody said, and clip 15 dropped the hedge `prognoser`. Those keep their
deterministic first-sentence titles, which is correct.

**Decisions made:**
- Dropping the speaker's own name makes two clips from one debate converge — 1 of
  16 pairs on `deepseek-chat`, 2 on flash, exactly as predicted last session. The
  loser keeps its deterministic title rather than retrying, matching every other
  failure path. If collisions get common, retry-on-duplicate inside the generator
  is the better fix.
- `benchmark_titles.py`'s docstring no longer calls acceptance "the number that
  matters". It now says to read the titles, and records why.

**Observations (not fixed, out of scope):**
- Role inversion is now undetectable — pinned by
  `test_role_inversion_is_a_known_accepted_gap`, which asserts the current
  (permissive) behaviour and explains what to do about it. Flip that assertion,
  do not delete the test.
- `deepseek-chat` sometimes still writes the speaker's own surname (clip 7). The
  prompt asks it not to; it is allowed, just wasteful. Not worth a rule.

**Blocked / needs a decision:**
- `P0-9` — rotate the Supabase token *and* the DeepSeek key; both are in chat
  transcripts. Carried over, still open.

**Next agent should know:**
- `.env` is already correct: `RIKET_TITLE_BACKEND=api`,
  `RIKET_TITLE_MODEL=deepseek-chat`. **Do not switch to `deepseek-v4-pro`** — the
  previous handoff recommended it on a 3x-understated cost figure.
- A full 16-clip benchmark now costs $0.0014 and 8.5 seconds. Run it and *read
  the output* whenever the prompt or validator changes. Do not chase acceptance.
- At $0.09 per 1,000 clips the whole ~15,000-clip archive is about $1.40.
- Backfill is unblocked. `P1-6` is the next open item.

## C8 — active-speaker selection was a persistence vote — DONE 2026-08-03

**Built:** `merge_fragmented_tracks`, `relative_scores`, `MIN_COVERAGE_FRAC`
floor and weighted scoring in `src/vision/track.py`; merge step and
`face_track_merge_*` settings wired through `src/stages/track.py` and
`src/config.py`.
**Tests:** 264 passed (was 258); ruff and mypy clean on 74 files.
**Contracts touched:** none.

### The bug

Reported by the owner: some clips follow a person in the crowd instead of the
speaker, and some are not centred on anyone.

`_track_score` was:

```python
persistence * 2.0 + area_frac * 100.0 + center_score * 3.0 + track.mean_score
```

`persistence` was a **raw frame count**. On a 48-second clip that is ~480 points
against 2.2 for size and 3.0 for centring, so **~99% of the decision was "which
face was detected in the most frames"**. The docstring claimed "largest, most
centered, most persistent"; arithmetically it was persistence alone.

Haar is a frontal-face detector. A speaker who turns to address the chamber or
looks down at notes stops being detected, and any dropout longer than
`face_track_max_gap_s` (1.0 s) opens a *new* track — so one speaker arrived as
several short fragments while a motionless face in the gallery arrived as one
long one, and won.

### Two failure modes, one root cause

The off-centre complaint is the same bug's consequence. C9 only moves the crop
where it has face samples; on a track covering 20% of frames it holds the last
known crop through every gap, so a speaker who moved during a dropout ends up
off-centre. Measured before the fix: **11 of 16 tracks covered less than half
the clip**, worst 42 of 215.

### Fix, in three parts

1. **Stitch fragments** (`merge_fragmented_tracks`). Tracks that do not overlap
   in time, are separated by ≤ 4 s, and still overlap ≥ 0.30 IoU at the seam are
   rejoined. Requiring real overlap is what stops a cut to another shot being
   stitched in — a new framing moves the box and IoU collapses.
2. **Normalise the score.** Every component in `[0, 1]` relative to the best
   candidate in the same clip: 0.45 area, 0.30 coverage, 0.20 centring, 0.05
   detector confidence. Size leads because Riksdagen's feed is directed — the
   mixer frames whoever is speaking large.
3. **Floor the coverage** (`MIN_COVERAGE_FRAC = 0.15`). **This one is not
   optional and I found it the hard way.** Weighting size without a floor just
   swaps one failure for another: Haar fires on torsos and chamber fittings for
   a frame or two and those false positives are *large* (19–27% of frame width
   against the podium's steady 11%). A single 27%-wide detection in 1 frame of
   242 outscored a speaker tracked in 226. Across the five worst clips every
   genuine podium track sits at ≥19% coverage and every artifact below 11%.

### Result, same 16 HD10540 clips, C8 + C9 re-run

| | Before | After |
|---|---|---|
| Plausible podium framing | 14/16 | **16/16** |
| Mean tracked coverage | 47% | **55%** |
| Clips gaining coverage | — | 8 (+6 to +82 frames) |
| Regressions | — | **0** |

The two reported clips both fixed: tracked face width went 6.9% → 11.9% and
6.2% → 11.7% of frame, i.e. from a distant face to podium framing. Both
re-rendered and visually confirmed by the owner.

**Decisions made:**
- Scoring is relative to the other candidates in the clip rather than against a
  tuned reference size, so nothing needs re-tuning per debate type or framing.
- `relative_scores` returns positionally, not keyed by `track_id`. Ids are only
  unique within one `build_face_tracks` call; a dict keyed on them silently
  collapsed two candidates into one, and a test caught it.
- The coverage floor falls back to the full candidate set when nothing clears
  it, so a badly tracked clip degrades to a best guess, never to no-face.

**Observations (not fixed, out of scope):**
- Haar remains the real ceiling. It cannot see a profile, which is why coverage
  is 55% and not 90%. A modern detector (YOLOv8-face, SCRFD) is the next
  meaningful step and the GPU is already there for ASR. TalkNet ASD is the tier
  above that; `src/vision/asd.py` already has the `ActiveSpeakerBackend` seam.
- `sign_language_inset_*` all default to `None`, so interpreter faces are not
  excluded on any debate that has an interpreter inset. Not seen on HD10540.

**Blocked / needs a decision:**
- `P0-9` — rotate the Supabase token *and* the DeepSeek key. Still open.

**Next agent should know:**
- C8 over 16 clips is ~2m15s; a single clip re-render is ~17s.
- `work/hd10540_track_before/` holds the pre-fix tracks for comparison. Delete
  when no longer useful; `work/` is gitignored.
- Backfill is unblocked and this was the last thing gating it.

## C8/C9/C10/C11 — Phase 0: the detector stops fabricating faces — DONE 2026-08-03

**Built:** `estimate_speaker_proxy()` and the `fallback` parameter deleted from
`src/vision/detect.py`; fail-closed gates through `src/vision/track.py`,
`src/camera/plan.py`, `src/stages/render.py` and `src/stages/publish.py`;
`docs/adr/010-fail-closed-speaker-evidence.md`.
**Tests:** 270 passed (was 264) plus the slow e2e; ruff and mypy clean on 74 files.
**Contracts touched:** none — see ADR 010. `render_clip()` returns `Path | None`.

### What was actually wrong

The owner reported clips following someone in the crowd. The cause was not a
tuning problem. `HaarFaceDetector.detect()` ran with `fallback=True`, and on any
frame where Haar found nothing it returned a **hardcoded box** — always exactly
`x=568, y=129.6, w=144, h=144` in master coordinates.

**1,133 of 2,032 selected face samples (56%) in the published clips were that one
constant.** It is identical every frame, so it chains into a perfectly stable,
perfectly centred track that beats real detections under any score rewarding
size, centrality or persistence — real detections fragment when a speaker turns
their head; the placeholder never does.

It also destroyed measurement, which is the worse half. My own "16/16 plausible
podium framing" from earlier this session was a geometric check the synthetic box
satisfies **by construction**, and my scoring change in `8d95d1f` raised the
synthetic share from 52% to 56% while appearing to improve things. Two committed
artifacts had it baked in: `test_speaker_proxy_is_centered_and_positive` asserted
the fabrication was centred and positive, and the golden
`08_track_fixture_summary.json` recorded the proxy box as clip `c02`'s first
observation, exact to three decimals.

### The gate chain

| Stage | Absence of evidence now means |
|---|---|
| C8 detect | `()` — no synthesised observation exists anywhere |
| C8 select | no track clears `MIN_COVERAGE_FRAC` → `no-face` |
| C9 plan | no samples → `CameraPlan(keyframes=())` |
| C10 render | no keyframes → not rendered, returns `None` |
| C11 publish | no keyframes → skipped, no upload, no row |

A clip that *had* evidence but whose render is missing still raises
`ArtifactError`. Fail-closed must not swallow real faults.

### Measured result on HD10540

| | Before | After |
|---|---|---|
| Synthetic samples in `08_track` | 1,133 / 2,032 | **0 / 982** |
| Clips rejected as unverifiable | 0 | **4 / 16** |

**I predicted 1 of 16 and was wrong.** I compared *frames containing any face*
(14–84%, only one clip under 15%) against the coverage floor, but the floor
applies to a **single track's** coverage, and real detections fragment across
many tracks. The four rejects are the four lowest-detection clips — 14%, 32%,
22%, 18% — where the best single track reaches only 5%, 15%, 9% and 10%.

That comparison also sizes the next chunk of work: frame-level detection averages
~68% but **median best-track coverage is only ~30%**, so roughly half of all real
detections are lost to fragmentation. That is the prize for Phase 1.

**Decisions made:**
- No flagged or lower-weighted variant of the fallback survives. The value of the
  rule is that no code path can produce a face nobody detected;
  `test_the_synthetic_face_fallback_cannot_be_reintroduced` enforces it
  structurally, including scanning the module source.
- The unused `"proxy"` detector backend was removed — it advertised exactly the
  behaviour being deleted and nothing referenced it.
- The floor stays at `0.15`. Lowering it to recover the four clips would be
  chasing the number again; the fix is better detection, not a lower bar.
- `test_track_and_camera_stages_write_phase4_artifacts` asserted
  `len(samples) >= 18` on **flat grey frames with two rectangles drawn on them**.
  Haar never detected a face there — the assertion was checking the placeholder
  worked, so C8/C9 integration had no genuine coverage. It now asserts `no-face`,
  and a new positive-path test uses the committed `betankande` debate footage
  (real faces in ~77% of sampled frames).

**Observations (not fixed, out of scope):**
- Nothing yet verifies the tracked face is the *right* face. A large, central,
  persistent face that is not the speaker still wins. Phases 1–2 of
  `speaker_verified_crop_design.md` address that.
- The slow e2e hits the DeepSeek API because `.env` sets `RIKET_TITLE_BACKEND=api`.
  Run it with `RIKET_TITLE_BACKEND=fallback` — titles are not in any golden, so
  the call is pure cost and non-determinism.
- `python tasks.py golden` runs `-m "not live and not slow"`, so it does **not**
  regenerate `08_track_fixture_summary.json`, which lives in the slow e2e.
  Regenerate with `UPDATE_GOLDEN=1 python -m pytest tests/e2e -m slow`.

**Blocked / needs a decision:**
- The 16 live clips were produced by the fabricating pipeline. Re-render and
  republish, or leave until identity verification lands? Owner's call.
- `P0-9` — rotate the Supabase token and the DeepSeek key. Still open.

**Next agent should know:**
- Verified the design doc's load-bearing external claims before acting on them:
  Riksdagen portraits resolve by `intressent_id` (Strömmer 2069x2758px, and it
  works for a *minister*), `cv2.FaceDetectorYN` and `cv2.FaceRecognizerSF` ship in
  the pinned OpenCV 4.11, SFace's 0.363 cosine threshold is LFW-only, and YuNet
  returns 5 landmarks with mouth *corners* but no lip aperture. Models are MIT
  (YuNet) and Apache 2.0 (SFace).
- **This machine has no GPU.** `torch` is `2.11.0+cpu`, `cuda.is_available()` is
  False, contradicting `AGENTS.md`. Plan CPU-only.
- Clips will look jumpier now. That is Haar's real behaviour, not a regression.

## March 2026 backfill — 997 clips live on Bunny + Supabase — DONE 2026-08-04

**Built:** `politician_linkage` metric (`src/observability/metrics.py`,
`scripts/pipeline_report.py`), worker resilience in `src/orchestrator/cli.py`,
`docs/adr/011-official-text-timing-over-asr.md`, RUNBOOK sections on the
watermark and lease reaping.
**Tests:** 273 passed; ruff and mypy clean on 74 files.
**Contracts touched:** none.

### Result

| | |
|---|---|
| Clips published | **997** |
| Debates | 48 sources, 47 backfilled |
| Speeches / politicians | 598 / 129 |
| Clips missing a URL | 0 |
| Debates with missing rows | 0 of 47 |
| Supabase size | **82 MB** of the 500 MB free tier |
| Bunny | 10.3 GB, ~$0.10/month, upload free |

Wall clock: ~2h40m processing (10 workers), ~35 min publishing. Zero dead jobs,
`max_attempts: 1` throughout. CDN spot-checks return HTTP 200 with real byte
counts. **My earlier estimate of 150–250 MB for Supabase was 2-3x too high.**

### ASR has never run (ADR 011)

`transcribe_dokid` selects `transcriber or OfficialTextTranscriber()` and the
orchestrator passes none, so `AutoSpeechTranscriber` — which would use
faster-whisper — is never chosen. Found because transcribe finished in
**1,688 ms for 20.6 minutes of audio**.

Now a recorded decision rather than an accident. The text is Riksdagen's own
authoritative transcript, better than ASR for a service printing words under a
politician's face. What is approximate is sub-speech timing: words are spread
evenly (0.4119 s apart in HD10367), so cut points drift by a word or two. Speech
windows are real, from C3's VAD at ~0.84 confidence. Keeps a debate at ~9 minutes
instead of hours on a box with no GPU.

### Three failure modes that were silent, now fixed

1. **A transport timeout killed the worker.** `run_forever` did not catch
   `ExternalServiceError` from `claim()`, so one curl timeout ended a worker
   permanently. Fired **19 times** during the run — without the fix, workers
   would have died 19 times overnight.
2. **A timeout while recording success discarded finished work.** The fix for (1)
   was too broad: it wrapped the bookkeeping *after* the stage ran. A clip
   rendered its MP4 and thumbnail, `complete` timed out, and the row sat
   `running` behind a 20-minute lease. The render fan-out's join barrier then
   held back the whole debate. `complete`/`fail`/`skip`/`advance_after` now retry.
3. **`RIKET_SUPABASE_SECRET_KEY` absent silently downgrades publishing.**
   `_supabase_publisher_from_settings` falls back to the Management API, which
   embeds the payload in a SQL string and returns **HTTP 413** on any debate over
   ~4 MB of metadata — 14 of 47 here. With the key set it uses the REST RPC
   (JSON body, no size cap). Both paths already existed; only the config was
   missing. A 13-clip test passed precisely because it was small enough to hide
   the limit.

**Blocked / needs a decision:**
- **Ministers who are not sitting MPs have no `intressent_id`.** 6 speeches (1%)
  are unlinked, all Jessica Rosencrantz, EU-minister, in `HDC120260326fs`.
  Riksdagen's `anforandelista` omits the id; the Talman in the *same* debate has
  one, and Strömmer had one because he is also a sitting MP. The id **is**
  recoverable: `personlista?fnamn=Jessica&enamn=Rosencrantz&rdlstatus=samtliga`
  returns `0992420223820` — the default query omits non-sitting members. A
  name-based fallback in C1 would close this, but name matching can misattribute
  a statement in political content, so it wants its own scoped chunk and a test.
  Expect this to grow as more ministers appear.
- `P0-9` — **four** credentials are now in chat transcripts: Supabase access
  token, DeepSeek key, Bunny storage password, Supabase secret key. Rotate all.

**Next agent should know:**
- Work dir is `D:/riketvideos` (49 GB for March). **Moving `RIKET_WORK_DIR`
  orphans the discovery watermark**, which lives inside it — the daemon then
  treats itself as a first run and walks the 2002 archive. Only
  `--max-enqueue` (25) contained it. See RUNBOOK.
- **`run --pool` does not reap expired leases; only `daemon` does.** Two jobs sat
  locked by dead PIDs for 5-6 hours and two debates never published, with
  `dead 0` reported throughout.
- The `gpu` pool has no GPU (`torch 2.11.0+cpu`). It was the throughput
  bottleneck at 1 worker because `transcribe` and `track` both sit in it; 4
  workers roughly halved the run.
- Publishing skips debates already fully in the DB — rebuild the todo list by
  comparing `10_render/*.mp4` counts against `public.clips`.
- Beware CRLF on this box: Python's `write_text` emits `\r\n`, and a `\r` in a
  bash-read dokid produced 27 instant failures whose error message looked normal.

## February 2026 backfill + onboarding UI — DONE 2026-08-04

**Built:** `web/src/onboarding.tsx`, `web/src/onboarding-store.ts`, onboarding
styles and `ListRow` button semantics in `web/src/App.tsx`; phantom-speaker fix
in `src/riksdagen/parser.py`.
**Tests:** 273 passed; ruff and mypy clean; web typecheck and build clean.
**Contracts touched:** none. `web/src/types.ts` gained `OnboardingState` and
`ConsentState` (frontend types, not `src/contracts.py`).

### Catalogue after two months

| | |
|---|---|
| Clips | **1,762** (997 → 1,762, +765) |
| Sources / speeches / politicians | 88 / 1,057 / 181 |
| Clips missing a URL | 0 |
| Unlinked speeches | 8 (0.76%) |
| Supabase | **136 MB** of the 500 MB free tier |
| Dead jobs at finish | 0 |

CDN spot-checks return HTTP 200 with real byte counts. `Q-1` wants ~2,000 clips;
at 1,762 one more month clears it.

Wall clock ~4h20m for 51 debates (39 clippable, 11 skipped, 1 recovered).

### C1: Riksdagen emits phantom zero-length speakers

`HD10342` dead-lettered the entire debate. Riksdagen returned a duplicate
speaker with `speechSeconds` 0 at the **same** `startPosition` as the real one:

```
[5] start=1236 secs=0    next=1236 derived=0
[6] start=1236 secs=254  next=1490 derived=254
```

Both duration fallbacks fail on that shape, so the parser raised and took ~22
clips with it. Zero-length entries are now skipped; a duration that cannot be
derived at all still raises, so real feed drift stays loud. Retried after the
fix and HD10342 published 22 clips — the count went 1,740 → 1,762.

**Workers cache the parser per process**, so the fix did not reach the running
backfill. Restarting workers before the retry was necessary.

### The cpu pool is the bottleneck, not io or gpu

Mid-run, 74 jobs were queued on `cpu` with 3 workers while 4 `gpu` workers held
2 jobs and 3 `io` workers had none. `render_clip` is cpu-only and by far the most
numerous job in the graph. Doubling cpu to 6 roughly doubled throughput.

**Start the next month at 2 io / 6 cpu / 2 gpu** rather than the 3/3/4 used here.

The 10-minute `reap` loop ran throughout and there was no repeat of the stalled
leases that cost two debates in March.

### Onboarding (frontend)

Three-step flow from the supplied design — political leaning, party selection,
terms and consent — shown once and reopenable from a new row in Profil.
**Device-local only**; `onboarding-store.ts` is deliberately the sole writer so
"is any of this transmitted?" is answerable from one file. `C-5` permits exactly
this; `C-1`, `C-2` and the F0 documents are still open GATEs.

Three departures from the design, all required:
- **`C-4`**: the single "godkänner villkoren" checkbox became accepting terms
  plus three independent switches, all defaulting off.
- **`A-9`**: the design gated the app behind accepting terms. Consent as the
  price of entry is not freely given, so onboarding is skippable.
- **No confirmation dialog on decline.** EDPB Guidelines 03/2022 name
  "questioning a refusal to grant consent" as continuous prompting. The
  consequence is stated once, above both buttons, before the choice.

"Slå på allt" and "Fortsätt utan" are identical 239x48 boxes — the accept path
must not be easier to reach than the refusal. Personalisation grants the
personalised feed **on its own**; requiring all three would breach `C-4`
granularity and Article 7(4).

**Blocked / needs a decision:**
- **Non-sitting ministers still have no `intressent_id`.** Now 8 speeches across
  two people: Jessica Rosencrantz (EU-minister, 6) and Daniel Vencu Velasquez
  Castro (2). Recoverable via `personlista?...&rdlstatus=samtliga`, which the
  default query omits. Wants its own chunk — name matching can misattribute a
  statement in political content.
- `P0-9` — **five** credentials are now in chat transcripts: Supabase access
  token, DeepSeek key, Bunny storage password, Supabase secret key, and the
  rotated Bunny password. Rotate all.

**Next agent should know:**
- Disk on `D:/riketvideos` is ~100 GB for two months. Nothing prunes masters
  (~550 MB each); the full archive would be ~550 GB.
- A third month puts Supabase near 190 MB, still inside the free tier.
- The onboarding flow writes nothing to the server. Wiring it to
  `private.consent_records` is F1 work and must not happen before F0.

## Q2 — Stable politician identity in the feed DTO — DONE 2026-08-04

**Built:** `politician_id` + embedded `politicians` row in `web/src/supabase.ts`;
`politicianId`/`politicianName`/`politicianRole` on `ClipItem` in
`web/src/types.ts`; identity, follow keying and profile derivation rewritten in
`web/src/App.tsx`; sample-clip ids and dead-data notices in `web/src/data.ts`;
Q2 chunk entry in `docs/BUILD_PLAN.md`.
**Tests:** `python tasks.py test lint typecheck` green — **274 passed**, 67
deselected, 1 pre-existing `audioop` warning; ruff clean; mypy strict clean on
74 files. No Python file was touched, so that count is unchanged by this chunk.
`tsc --noEmit` green; `vite build` green (418.27 kB, 121.00 kB gzipped — +40
bytes).
**Contracts touched:** none. `ClipItem` is a frontend DTO in `web/src/types.ts`,
not `src/contracts.py`.

### The bug was already live, not a future risk

`Q-2` describes a name slug that "breaks the moment a title changes". Measured
against the live catalogue first, it had already broken. `personForClip()`
stripped `(…)` and four hardcoded title prefixes —
`Justitieministern|Statsministern|Ministern|Ledamoten`, exactly the set present
in the 16-clip HD10540 batch it was written against — then slugified the rest.
Every other ministerial title fell through:

| | |
|---|---|
| Real politicians with clips | 165 |
| Distinct identities the UI rendered | **171** |
| Politicians split across two identities | **5** |
| Clips affected | **380, 21.6% of the catalogue** |

The five were the five most-clipped ministers — Andreas Carlson (151 clips),
Anna Tenje (82), Benjamin Dousa (55), Elisabet Lann (49), Erik Slottner (43) —
because a minister is precisely the person whose display name carries a title.
The bug was concentrated on the highest-volume speakers, which is the worst
place for it and the reason it stayed invisible: each half looked like a
plausible person.

### Why no migration was needed

`politicians.intressent_id` is `unique` and is the `on conflict` target of the
C11 upsert, so `politicians.id` is already stable across a title change — the
row's `name` and `role` update in place and the uuid does not move.
`politicians_public_read` is `using (true)` and migration 004 kept `select` for
`anon`, so the embed works on the publishable key. Verified from outside with
the browser's own key: `HTTP 200`, 200 rows, an embedded politician on every one.

### Verified in the browser, not asserted

Dev server at 375x812 against the live catalogue:

| Check | Result |
|---|---|
| Identities in a 60-clip page | 23, **all uuids**, zero slug fallbacks |
| Follow one Anna Tenje clip | all **9** of her clips flip to `Följer` |
| Effect on the other 51 clips | **none** |
| Unlinked speaker (forced through the real path) | follow + profile disabled, `aria-pressed` absent, title explains why |
| Unlinked clip content | title, debate date and source link all still render |

`data-politician-id` is now on each feed article, mirroring `data-clip-id`, so
the identity a follow keys on is checkable from outside without reading React
state. That is what made the table above measurable.

**Decisions made:**
- **An unlinked speaker is not followable.** 10 clips (0.57%), 2 people —
  ministers who are not sitting MPs, whom Riksdagen's `anforandelista` omits.
  They get `politicianId: null` and inert controls, not a name-derived fallback.
  A name-keyed follow would silently detach the day the `intressent_id` is
  recovered, and the viewer's follow list would rot with no symptom. Refusing a
  follow we cannot keep is the honest failure.
- `aria-pressed` is **absent** rather than `"false"` on a disabled follow.
  `false` would tell a screen reader this is a toggle that happens to be off.
- The politician row wins over `speeches.party` for party, because the row is
  the person's current affiliation while the speech column is what Riksdagen
  printed that day.
- `slugify()` was **deleted**, not left unused. A dead identity-slug helper in
  the file is an invitation for the next session to reach for it. `cleanName()`
  survives for display and now carries a docstring saying it must never key
  anything.
- Sample clips carry `demo-politician-…` ids rather than the real uuids those
  speakers have, so a demo row can never be mistaken for a catalogue row and a
  live uuid cannot rot inside committed demo data.

**Consequence worth reviewing: the profile screen lost three sections.**
Not a drive-by — replacing the identity source is what made them unbackable:

- **"Följare 16 800"** came from the hardcoded demo `PEOPLE` list, which
  `personForClip()` matched real clips against *by name*. A genuine Strömmer
  clip rendered a demo profile's invented follower count as fact. Nothing counts
  followers, so the stat is gone rather than zeroed (FE-2).
- **The clip grid** was `PERSON_CLIPS`: six hardcoded rows with invented view
  counts ("48 t"), rendered on *every* politician's page regardless of who they
  were.
- **"Om" and "Utskott"** had no data source; `bio` was being filled with a
  random clip transcript.

What remains is counted: `Klipp i flödet` and `Anföranden i flödet` — 9 and 3
for Anna Tenje, matching the DOM exactly. Small numbers, but counted rather than
invented, which is the property that matters on political content. The honest
replacement for the clip grid is that person's real clips, which needs a
per-politician query the app does not have.

**Observations (not fixed, out of scope):**
- `PEOPLE` and `PERSON_CLIPS` in `web/src/data.ts` are now **dead** — nothing
  imports them. Both carry fabricated figures. Left in place with a docstring
  explaining why, because deleting demo data is a product call, not a Q-2 one.
- `PARTIES[].clips` in `data.ts` is still fabricated and still rendered
  (`S: 1240`, `M: 1108`; real is `S: 600`, `M: 442`). Same FE-2 family, and it
  is live on the Följer screen.
- `cleanName()` still leaves most ministerial titles in the *displayed* name —
  "Äldre- och socialförsäkringsministern Anna Tenje" is what the overlay shows.
  Cosmetic now that identity does not depend on it. Fixing it properly means
  taking a clean name from Riksdagen rather than regexing the display string.
- `docs/BUILD_PLAN.md` F1 scope named `migrations/004_private_schema` and
  `005_consent_ledger`. **Both numbers are taken and applied**
  (`004_revoke_default_table_grants`, `005_fix_auth_probe_role_columns`) and the
  tree is at `008`. Corrected to `009`/`010` in place with a note — reusing an
  applied number would have failed the `schema_migrations` checksum on F1's
  first run.
- `docs/RECOMMENDATION_PREREQUISITES.md` §1 is badly stale: it still says
  "16 published clips, one debate". Live is 1,762 clips / 88 debates / 165
  politicians with clips. Several items marked open there are in fact done
  (`P1-6`; `N-1` is substantively covered by ADR 005). Only the `Q-2` line was
  updated this session.

**Blocked / needs a decision:**
- Whether the profile screen stays sparse or gets a real per-politician clip
  query. Product call.
- `P0-9` — **five** credentials remain in chat transcripts: Supabase access
  token, Supabase secret key, DeepSeek key, Bunny storage password and the
  rotated Bunny password. Carried since 2026-08-02, still open, still the only
  live risk in the prerequisite list.

**Next agent should know:**
- **F1 must key every private table on `clip.politicianId` / `politicians.id`**,
  never on a name. That was the whole point of doing this before F1.
- The measurement harness is worth re-running after any feed change:
  `[...document.querySelectorAll('article.feed-item')]` grouped by
  `data-politician-id`, asserting every value is a uuid. A regression here is
  silent — it surfaces as a follow that quietly stops working.
- `web/` has **no JS test runner**. The verification above was done by driving
  the real dev server, because there is nowhere to put a unit test. If F1 adds
  Deno targets per `O-4`, a frontend runner is worth adding at the same time.

## UI1 — Navigation tabs on real data — DONE 2026-08-04

**Built:** `web/src/library-store.ts` (new); politician search, per-politician
and by-id clip reads in `web/src/supabase.ts`; `Politician` and `LibraryState`
in `web/src/types.ts`; Sök, Följer, Profil, `PersonScreen` and a scoped
`CollectionScreen` in `web/src/App.tsx`; grid/collection/empty/placeholder
surfaces in `web/src/styles.css`; UI1 chunk entry in `docs/BUILD_PLAN.md`.
**Tests:** `python tasks.py test lint typecheck` green — **274 passed**, 67
deselected; ruff clean; mypy strict clean on 74 files. No Python touched.
`tsc --noEmit` green; `vite build` green (425.85 kB, 122.81 kB gzipped, +7.6 kB
raw over Q2).
**Contracts touched:** none. `Politician` and `LibraryState` are frontend DTOs.

### What was actually wrong

Sök, Följer and the person page were all rendered from
`mergePeopleFromClips(clips)` — the *loaded feed*. That is 60 clips containing
**23 people, out of 165 with published clips.** So:

- searching for almost anyone returned nothing. Verified before the change:
  "strömmer" → 0 results, though he has 65 published clips;
- a person you followed last week vanished from Följer as soon as they left the
  recent feed;
- the person page showed six hardcoded demo tiles with invented view counts.

Everything now reads `public.politicians` and `public.clips` directly. Every
query runs on the publishable key under existing RLS — **no migration, no new
grant.** All six were verified against the live project before any UI was
written.

### Verified in the browser at 375x812, against the live catalogue

| Check | Result |
|---|---|
| Search "strömmer" (not in the feed) | 1 träff → opens his page |
| His page | **65 Klipp** — matches the DB exactly — 60 tiles with thumbnails |
| Search "busch" → her page | **40 Klipp** — matches the DB exactly |
| Tap tile 5 in the grid | scoped feed opens **on that exact clip** |
| Follow, then reload | survives; Följer resolves him from the stored uuid |
| Save 3 clips, then reload | survives; archive opens in newest-saved order (c03, c02, c01) |
| Profil | "3 klipp · sparas bara på den här enheten", "1 personer" |
| Console errors | **0** |

### Decisions made

- **Device-local, single writer.** `library-store.ts` is the only module that
  writes follows, saves and likes, so "does any of this leave the device?" is
  answerable from one file. It does not. `C-9` wants these server-side; that
  needs the private schema, the consent ledger and the F0 documents, all open
  GATEs. A list of politicians someone follows reveals political opinion just
  as the onboarding leaning slider does — it is Article 9 data and it is
  treated the same way. When F1 lands the ledger becomes the source of truth
  and this store becomes its cache.
- **One player, not two.** A scoped feed — a politician's clips or the saved
  archive — renders through the existing `FeedScreen` with a different header.
  Everything the feed has earned (FE-4 dwell activation, FE-3 explicit loop,
  FE-5 blocked-vs-paused) applies for free and cannot drift out of sync.
- **The exact clip total comes from `Content-Range`,** not from counting the
  page. `Prefer: count=exact` with a one-row window makes the total independent
  of how many rows were fetched — hence "65 Klipp / 60 Visas här" rather than a
  single ambiguous 60. A missing header yields `null`, which renders as absent;
  "we could not count" must not display as `0`.
- **The person page orders by `published_at` but the grid labels `debate_date`,**
  and every tile shows that date (`Q-8`).
- **Search is debounced 220 ms and aborts in flight.** Eight requests for a
  surname can return out of order; the same stale-response rule `FE-7` states
  for the feed.
- Library lists are **capped** on read (500 follows, 500 saves, 2000 likes).
  Not tidiness: the saved list becomes an `id=in.(…)` query string, and an
  unbounded array from hand-edited `localStorage` would build a URL the gateway
  rejects — breaking the whole archive rather than one row.

### Two bugs found while verifying

1. **Nested `<button>` inside `<button>`.** `ListRow` renders as a button when
   given `onClick`, and Följer also passes a button in `action`. React logged
   "cannot contain a nested button" and only the outer control was
   keyboard-reachable. The existing comment in `ListRow` had anticipated
   exactly this and the new screen walked into it anyway. Fixed structurally: a
   row with *both* now makes only the lead half a button and leaves the action
   as its sibling. Verified `document.querySelectorAll('button button').length
   === 0` and that tapping "Följer" unfollows without opening the profile.
2. **Avatar initials read "JG" for Gunnar Strömmer** — `Avatar` was given the
   raw `politicians.name`, so it initialled "Justitieministern Gunnar". Now
   given the cleaned name.

### `cleanName()` improved — measured against all 23 titled names

Q2 left this as a cosmetic observation; Sök and Följer made it prominent
("ÄO" as initials for Anna Tenje). Surveyed the real data rather than guessing:
23 of 181 politician rows carry a title.

The rule is `/^.*ministern\s+/i` — **greedy and deliberately without `\b`**:

- greedy, so a compound portfolio collapses in one step. "Gymnasie-, högskole-
  och forskningsministern Lotta Edholm" ends its title at the *last* segment; a
  lazy match leaves "och forskningsministern".
- no `\b`, because "Finansmarknadsministern" has no word boundary before
  "ministern" — `\bministern` matches neither it nor most compounds.
- **definite form only**, so "Minister för civilt försvar Carl-Oskar Bohlin"
  is left whole rather than mangled into "för civilt försvar Carl-Oskar
  Bohlin".

Result: 19 of 23 resolve to a clean personal name, including
"Arbetsmarknadsminister och vikarierande klimat- och miljöministern Johan
Britz" → "Johan Britz". The four unchanged are the indefinite-form minister and
the three `TALMANNEN` chair rows, all of which read correctly as they are.

Still display-only. It must never key anything durable — that is
`clip.politicianId`.

### Demo data kept, at the owner's request

`TRENDING` and the recent-search chips stay in Sök as a reminder of what to
build. Both are now **labelled** — an "exempel" tag on the chips and
"Exempeldata — popularitet mäts inte ännu" above the trending list. The chips
are not the viewer's search history and the trending figures are invented;
a label is what separates a mockup from a claim, and this is political content.

### Observations (not fixed, out of scope)

- `PARTIES[].clips` in `data.ts` is still fabricated and still rendered
  (`S: 1240` against a real 600). Same FE-2 family. It no longer appears in
  Följer, but it is still live elsewhere.
- The person page loads at most 60 of a politician's clips with no pagination —
  Ebba Busch shows 40 of 40, Strömmer 60 of 65. `FE-9` (cursor pagination that
  appends without resetting) is the real fix and is F2/F4 work.
- Search matches `politicians.name` only. Searching a party name or a topic
  finds nothing, and the party chips are the only way to browse by party.
- `TALMANNEN`, `ANDRE VICE TALMANNEN` and `TREDJE VICE TALMANNEN` have their own
  `politicians` rows and 20 clips between them. They are the chair, not people
  to follow. Nothing hides them from search.
- The "Aviseringar" and "Följda ämnen" rows are gone from Profil; "Ladda ner
  mina data", "Samtycken & cookies" and "Radera konto" are still placeholders
  with no handler (`C-10` — real workflows, F1).

### Blocked / needs a decision

- `P0-9` — **five** credentials in chat transcripts: Supabase access token,
  Supabase secret key, DeepSeek key, Bunny storage password, rotated Bunny
  password. Carried since 2026-08-02. Still the only live risk in the list.

### Next agent should know

- **The library is device-local and F1 must migrate it, not ignore it.** Anyone
  who used the app has follows and saves in `riket.library.v1`; the consent
  ledger landing must not silently orphan them.
- Every read added here is in `web/src/supabase.ts` and each carries the query
  it runs. `countClipsForPolitician` is the only one that reads a response
  *header* rather than a body — do not "simplify" it into a row count.
- The scoped-feed mechanism (`ClipCollection` + `CollectionScreen`) is the
  place to hang any future "clips from this debate" or "clips you liked" view.
  It costs one state field and no new player.

## A-2 — pleni.se live, and the rename to Pleni — DONE 2026-08-05

**The project is now Pleni.** `https://pleni.se` and `https://www.pleni.se` both
serve the app over HTTPS with valid certificates. `A-2`, open and blocking since
2026-08-02, is **closed**.

### Domain

Registration had **failed** at Simply.com and nobody had noticed: the product
page said "Registrering av pleni.se misslyckades" while the hosting product
looked healthy, and `a.ns.se` returned NXDOMAIN. Cause was a missing
`Företagsnamn` on the account — `.se`/IIS rejects registrations without valid
registrant data. Owner fixed the account, retry succeeded, expiry 2027-08-04.

Zone at Simply (ns1/ns2/ns3.simply.com), 12 records:

| Type | Name | Value |
|---|---|---|
| ALIAS | pleni.se | rikettv.nbg1-3.instapods.app |
| CNAME | www | rikettv.nbg1-3.instapods.app |
| TXT | _instapods | InstaPods apex ownership token |

Simply supports **ALIAS**, so the apex needs no hardcoded pod IP — both names
follow the pod hostname and survive an InstaPods IP change. Deleted the two
stock `A → 94.231.103.86` records and the `*` wildcard. All mail records (MX,
SPF, DKIM x2, DMARC, 3x SRV, autoconfig) untouched and verified after each
delete. InstaPods → Domains: apex **active, SSL active**; `www` shows *pending*
but returns 200 with a valid cert, so that flag is stale.

### Rename

| Where | Was | Now |
|---|---|---|
| GitHub repo | `Mulanger/riketTV` | **`Mulanger/pleni`** (old URL 301s) |
| Clerk workspace | RiketTV | **Pleni** |
| Clerk application | Riket | **Pleni** |
| Supabase project | Mulanger's Project | **Pleni** |
| UI strings | Riket TV / Kammaren | **Pleni** |

Two user-visible strings said **"Kammaren"**, not "Riket" — an older name in the
onboarding heading and the version footer. A grep for "riket" misses them.

**Deliberately NOT renamed** — see `docs/RENAME_TO_PLENI.md` for the evidence:

- **Bunny zone `riketnlooigm`.** Verified live: all 1,762 clips *and* all 1,762
  thumbnails carry absolute URLs on that host. 3,524 URLs, no redirect.
  Renaming 404s the whole catalogue.
- **InstaPods pod `rikettv`.** Its hostname is the ALIAS/CNAME target.
- **`RIKET_` env prefix** (`src/config.py:19`). One line, but every `.env`, CI
  secret and the InstaPods env panel must change in the same commit.
- **localStorage keys `riket.library.v1` / `riket.onboarding.v1`.** They hold
  every viewer's follows, saves, likes and consent answers. Renaming a key
  orphans the data — silently wiping the library and resetting consent to off.
  The `.v1` is a version, not a brand.

**Verified after the GitHub rename:** auto-deploy still fires. Commit `fbd1fa0`
deployed on push *after* the rename. InstaPods still stores the old clone URL
`.../riketTV.git` and works via GitHub's redirect — left alone deliberately,
because reconnecting a working pipeline gains nothing. It only breaks if
someone recreates a repo at `Mulanger/riketTV`.

**Blocked / needs a decision:**
- `P0-9` — five credentials in chat transcripts: Supabase access token,
  Supabase secret key, DeepSeek key, Bunny storage password, rotated Bunny
  password. Open since 2026-08-02. Still the only live risk in the list.

**Next agent should know:**
- Verify delegation with `nslookup -type=NS pleni.se a.ns.se`, never a public
  resolver alone — a registered-but-unpublished domain reads NXDOMAIN
  everywhere and Simply then falsely warns "domain does not point to Simply
  nameservers".
- The Simply DNS UI resists automation: coordinate clicks need
  `scale = 1568 / window.innerWidth`, the first submit click is routinely
  swallowed, delete buttons use a `data-confirm-question` interceptor that
  ignores synthetic `.click()`, record **type is immutable** (delete + re-add),
  and a direct GET to a state-changing URL bounces to login. Clicking by
  element `ref` is the most reliable path.
- **Clerk production instance is now unblocked** and is the rest of `A-2`. It
  needs new CNAMEs on pleni.se, a new `VITE_CLERK_PUBLISHABLE_KEY` in the
  InstaPods env panel, and a **second** Supabase third-party auth entry — an
  addition, not an edit, since dev and prod have different domains.

## UI2 — One clip per swipe, and a feed that plays on arrival — DONE 2026-08-06

**Built:** snap and sizing rules in `web/src/styles.css`; muted-fallback autoplay,
tap-to-unmute and `VIDEO_WINDOW`/`POSTER_WINDOW` source windowing in
`web/src/App.tsx`; player-behavior bullets in `AGENTS.md`.
**Tests:** `python tasks.py test lint typecheck` green — **274 passed**, 67
deselected, 1 pre-existing `audioop` warning; ruff clean; mypy strict clean on 74
files. No Python was touched, so that count is unchanged by this chunk.
`tsc --noEmit` green; `vite build` green (426.13 kB, 122.95 kB gzipped).
**Contracts touched:** none.

### The reported bug was one missing declaration

A swipe jumped two or three clips, on phone *and* on desktop. The feed is pure
CSS scroll-snap — no swipe library, no JS scroll or touch handler anywhere in
`web/src/` — so the behaviour came down to what `.feed-item` declared.

`scroll-snap-stop` was absent, which defaults to `normal`, and `normal`
**explicitly permits a fling to pass over snap points**: the browser runs its
usual momentum physics and snaps to whatever is nearest when the fling stops.
Three clips of momentum lands three clips away. `always` forbids passing a snap
point at any gesture velocity, and is the same fix for desktop wheel momentum.

Two compounding faults fixed in the same rule:

- **`.feed-item` was sized in `dvh`/`svh`.** `dvh` changes *while you scroll* as
  the mobile URL bar collapses; container and items resize together mid-fling,
  every snap point moves, and `mandatory` re-targets. It is now `height: 100%`
  of `.feed-scroll`, which is `inset: 0` and therefore has a definite height, so
  an item can no longer disagree with its scroller. Verified: all 60 items
  measure 812 px against a 812 px scroller, one distinct height.
- **No `overscroll-behavior`.** Added `contain`, so an overscroll cannot chain to
  the document or trigger Android Chrome's pull-to-refresh mid-swipe.
- `min-height: 680px` was dead (overridden to `0` 1,160 lines later) and is gone.

### Nothing autoplayed, and that was by design

`muted` initialises to `false`, so the first `play()` was an **unmuted** autoplay.
Every modern browser refuses that until the origin has earned a user gesture. The
FE-5 path caught the rejection and rendered the centre play button — working
exactly as written, but the written outcome is "a frozen poster until you tap",
which is the wrong default for a short-form feed.

`playWithMutedFallback()` now retries muted before concluding anything. This
**sharpens FE-5 rather than weakening it**: `blocked` stops meaning "audio was
refused", which is routine and happens on nearly every cold load, and starts
meaning "playback itself was refused", which is rare and is the only case where a
centre play button is the right answer.

The first tap after an automatic mute turns audio on instead of pausing — on this
feed a tap means "let me hear it" far more often than "stop". `autoMutedRef`
exists so that shortcut can only ever undo *our* mute; a mute the viewer chose
from the mute control is theirs and stays put.

### Measured, not assumed: 119 CDN requests per feed load

Every one of the 60 rows mounted with its Bunny URL and `preload="metadata"`, so
a cold load opened **119** requests to one CDN host against a browser cap of
about six connections. The clip being watched queued behind metadata and posters
for clips nobody would reach.

| | Before | After |
|---|---|---|
| CDN requests on a cold load | **119** | **5** |
| MP4 | 59 | 1 |
| WebP posters | 60 | 4 |
| Last CDN response finished | 2,796 ms | 966 ms |

**How the baseline was taken.** It is not an inference from reading the code:
both constants were temporarily set to `999` to reproduce the pre-change state,
the page reloaded, and `performance.getEntriesByType('resource')` counted. Repeat
that if either window is ever tuned. The first draft of this entry claimed a
before-figure of 61, which was the *mid-change* state — the video window was
already in when that reading was taken — and it understated the problem by half.

The request counts are deterministic and follow from the code. The two timings
are single observations on one machine against the live CDN, so treat them as
indicative rather than a benchmark.

`VIDEO_WINDOW = 1`, `POSTER_WINDOW = 3`. The window is centred on the active
clip, so whichever clip you swipe to already had its `src` as a neighbour and
does not wait on the 180 ms FE-4 dwell before it starts fetching. The wider
poster window is safe *only because* `scroll-snap-stop` now caps a gesture at one
clip — the window cannot be outrun by a single swipe.

### Verified in the browser at 375x812, against the live catalogue

| Check | Result |
|---|---|
| Single wheel fling | index 0 → **1**, `scrollTop` 812, remainder **0** |
| Fling up | index 3 → **2**, remainder 0 |
| 3x-repeat hard fling | 1 → 3, i.e. **never more than one per gesture** |
| `scrollSnapStop` computed | `always` |
| Item vs scroller height | 812 / 812, one distinct item height across all 60 |
| Autoplay on load | starts on its own, `readyState` 4, **no centre play button** |
| Autoplay with unmuted `play()` forced to reject | **plays muted**, button reads `Slå på ljud`, no play button |
| First tap after that | audio **on**, still playing |
| Second tap | pauses, as before |
| Deep link (person grid tile 5) | lands on that exact clip, remainder 0, `src` window `[3,4,5]` |
| Console errors / nested buttons | **0 / 0** |

The muted-fallback row is the one that needed a trick: this desktop browser
permits unmuted autoplay, so the branch never ran. Patching
`HTMLMediaElement.prototype.play` to reject any unmuted call reproduces mobile
policy exactly and exercises the real code path.

**What the browser pane cannot show is sustained playback.** `document.hasFocus()`
is false in that surface even straight after a synthetic click, and the browser
suspends media in an unfocused tab: every newly-activated clip advanced from 0 to
about 2 s and then froze, with `readyState` 4, `ended` false and `networkState`
idle. So "autoplay starts without a tap" is proven — `play()` is not refused and
the centre button never appears — while "it keeps running" is not observable
here. Pre-existing behaviour, unrelated to this chunk, but worth knowing before
someone reads a frozen `currentTime` as a regression.

**Observations (not fixed, out of scope):**
- A clip that leaves the `src` window keeps whatever it already buffered —
  removing the `src` attribute does not reset a media element. It is paused, so
  it is not competing for bandwidth, and it makes scrolling back instant. Truly
  releasing it would need `removeAttribute('src')` + `load()`.
- `transferSize` is 0 for every Bunny resource because the CDN sends no
  `Timing-Allow-Origin`. Request *counts* and timings are measurable from the
  page; byte totals are not. Worth adding that header if bandwidth ever needs
  attributing from the client.
- `PARTIES[].clips` in `data.ts` is still fabricated and still rendered. Same
  FE-2 family, carried since Q2.
- **The chunk table at the top of this file still lists C12 and C13 as `TODO`**,
  but both have full handoff entries below dated 2026-08-03 and C12b is recorded
  as complete. Left as-is rather than corrected in passing (rule 2); it reads as
  the largest remaining work when in fact P1 is closed, so it is worth a one-word
  fix by whoever owns the ledger next.

**Blocked / needs a decision:**
- `P0-9` — five credentials in chat transcripts: Supabase access token, Supabase
  secret key, DeepSeek key, Bunny storage password, rotated Bunny password. Open
  since 2026-08-02. Still the only live risk in the list.

**Next agent should know:**
- **`scroll-snap-stop: always` is load-bearing, not decoration.** If a future
  change reintroduces multi-clip jumping, check that declaration and the item
  height before reaching for a JS gesture handler. A touch-driven `scrollTo`
  fallback was planned and deliberately not built — it fights the native
  scroller and costs the momentum feel.
- Verified on desktop Chromium only. `scroll-snap-stop` has a patchier history in
  iOS Safari; confirm on a real iPhone at `https://pleni.se` before assuming the
  phone half of the report is closed.
- Anything added to the feed item that fetches must respect the windows.

## A-2 closed + library gated behind an account — DONE 2026-08-06

**Built:** `useViewer()` in `web/src/clerk.tsx`; per-account keying and null-user
refusal in `web/src/library-store.ts`; the sign-in gate in `web/src/App.tsx`;
Clerk production DNS, Supabase third-party auth and the InstaPods key (infra).
**Tests:** `python tasks.py test lint typecheck` green — **274 passed**, 67
deselected; ruff clean; mypy strict clean on 74 files. No Python touched.
`tsc --noEmit` green; `vite build` green.
**Contracts touched:** none.

### Clerk production — the rest of A-2

All five CNAMEs added to the Simply zone for `pleni.se`. Clerk went from
**0/5** to **Verified** on the first check; SSL **Issued**; primary domain
**Verified**.

| Host | Target |
|---|---|
| `accounts` | `accounts.clerk.services` |
| `clerk` | `frontend-api.clerk.services` |
| `clk._domainkey` | `dkim1.mqb2yvc3pi4p.clerk.services` |
| `clk2._domainkey` | `dkim2.mqb2yvc3pi4p.clerk.services` |
| `clkmail` | `mail.mqb2yvc3pi4p.clerk.services` |

Verified against `ns1`/`ns2.simply.com` directly, not a public resolver. **Every
mail record was re-checked afterwards** — MX, SPF, `_dmarc`, both
`simplycom*._domainkey`, the three SRVs and `autoconfig` are unchanged. Clerk's
DKIM selectors (`clk`, `clk2`) do not collide with Simply's (`simplycom1`,
`simplycom2`), which is the one thing that could have broken mail.

Production key is `pk_live_Y2xlcmsucGxlbmkuc2Uk`; the base64 tail decodes to
`clerk.pleni.se$`, which is how you check a Clerk key points where you think.

**Supabase now has two Clerk third-party auth entries** — `https://clerk.pleni.se`
added, `https://leading-seasnail-33.clerk.accounts.dev` kept. An addition, not an
edit: dev and prod are different issuers, and deleting the dev entry breaks local
sign-in.

**`VITE_*` is baked in at build time.** Changing the key in the InstaPods panel
does nothing until a deploy rebuilds the bundle. The env save and this commit
were sequenced so one deploy carries both.

### The library now belongs to an account, not a device

`Q-2` made identity stable; this makes it *owned*. All four toggles already
funnelled through `updateLibrary()`, so the gate is one guard in one place rather
than four call sites that can drift.

- Signed out, a tap opens Clerk's modal and **writes nothing** — no optimistic
  local state to reconcile, and no anonymous row for F1 to migrate.
- Storage moved from a bare `riket.library.v1` to `riket.library.v1:<user-id>`.
  Two people on one phone must not see each other's follows: a follow list
  reveals political opinion, and leaking it to whoever signs in next is the same
  Article 9 problem as sending it to a server with no lawful basis, just closer
  to home.
- `writeLibrary` refuses a null user outright, so an anonymous library cannot
  come into existence even if a future caller forgets to check.
- The pre-existing anonymous library is **not adopted** by the first account to
  sign in. Attributing follows to someone who did not make them is worse than
  losing them. The owner confirmed the only such data is their own.

`useViewer()` branches on `clerkEnabled`, which is a build-time constant — so the
apparent conditional hook is legal, because exactly one path is taken for the
life of any bundle. Calling `useUser()` outside a `ClerkProvider` throws, which
is why the branch has to exist. A deploy without the key reports "not signed in"
rather than crashing, so the anonymous feed survives a missing env var.

### Verified in the browser

| Check | Result |
|---|---|
| Tap `Gilla` signed out | Clerk modal opens |
| Library keys written | **none** |
| Legacy anonymous blob | unchanged, and now unread |
| Feed, search, playback signed out | unaffected |

The dev-instance modal rendered **"Development mode"** in orange — visible to any
viewer. That is the concrete reason production Clerk had to land before the gate
shipped, not after.

**Observations (not fixed, out of scope):**
- `clearLibrary()` is exported and now takes a user id, but nothing calls it.
  Sign-out drops the in-memory state and leaves the stored blob for the next
  sign-in on that device, which is the behaviour you want on a personal phone and
  the wrong one on a shared device. A real "forget me on this device" belongs
  with `C-10`'s deletion workflow in F1.
- The InstaPods control panel is at `app.instapods.com`, not `instapods.app` —
  that domain serves the pods only and its root errors.

**Blocked / needs a decision:**
- `P0-9` — five credentials in chat transcripts. Open since 2026-08-02.
- **F0 still gates consent collection from real users.** F1 *engineering* may
  proceed in parallel (BUILD_PLAN F0, ADR 007), and the gate above deliberately
  collects nothing new — it only stops collecting from people who never asked.
  The DPIA, Article 6 basis and Article 9(2)(a) analysis are still open before
  anything personal reaches a server.

**Next agent should know:**
- F1 is next and is the large one. Migrations start at **009** — `004`–`008` are
  applied and the ledger checksums them.
- The library store is now the shape F1 wants: single writer, keyed on the Clerk
  subject and on `politicians.id`. When the consent ledger lands it becomes the
  cache and the server becomes the source of truth, exactly as
  `library-store.ts` has said since UI1.
- Do not delete either Supabase Clerk entry.

## V1 — YuNet replaces the Haar cascade — DONE 2026-08-07

**Built:** `src/vision/models/{face_detection_yunet_2023mar.onnx,MODELS.md}`,
`FaceDetector` protocol + `YuNetFaceDetector` + `verify_model_checksum` in
`src/vision/detect.py`, YuNet settings in `src/config.py`, detector wiring and a
single-detect inset path in `src/stages/track.py`, package-data in
`pyproject.toml`, `docs/CLIPPING_V2_DESIGN.md`, V1/V2 chunk entries in
`docs/BUILD_PLAN.md`.
**Tests:** `python tasks.py test lint typecheck` green — **281 passed** (was
274), 67 deselected, 1 pre-existing `audioop` warning; ruff clean; mypy strict
clean on 74 files. Slow e2e green after a reviewed golden regeneration.
**Contracts touched:** none.

### The complaint was measurable, and it was not the camera

The owner reported clips "only filming a shoulder or missing the speaker".
Measured over the entire published catalogue — 1,746 clips, 87 debates, read
from existing artifacts with no re-processing:

| Defect | Clips | Share |
|---|---:|---:|
| Tracked box too large to be a face (>205 px on a 1280 px frame) | 435 | 24.9% |
| ≥1 shot with **zero** face evidence, C9 holding a stale crop | 867 | 49.7% |
| Track covers <50% of the clip | 607 | 34.8% |
| **At least one of the above** | **1,297** | **74.3%** |

The number that redirected the whole session: **face-centre-inside-crop is
1.000 at p10, p50 and p90**, with 0.002 of samples in the outer 15%. The camera
obeys its target perfectly. Every smoothing-side fix — Kalman, EMA, one-euro,
padded gesture-aware bounding boxes — acts on a signal that is already 100%
obeyed and cannot move that number. The target was simply not a person.

Two published examples, confirmed by drawing the boxes on the analysis frames:
`HD10392_ebe6af7e…_c01` is 45 s of a seated bystander's lap while Erik Slottner
speaks off-frame; `HDC120260305fs_35dc833f…_c01` is rows of empty blue seats.

### Root cause

`haarcascade_frontalface_default` returns **no confidence**, so `detect.py`
synthesised one from box area plus distance from frame centre. That score
*rewards* precisely what a large central false positive has. Haar also emits
square boxes and cannot see a profile, which is where the 62% median coverage
came from.

### Bake-off — 22 clips, stratified, through the real C8 code path

| config | frames w/ a face | median box width | track coverage | box >0.16 |
|---|---:|---:|---:|---:|
| `haar480` | 0.925 | 0.176 | 0.581 | **15/22** |
| `yunet480` | 0.974 | 0.099 | **0.858** | **0/22** |
| `yunet960` | 1.000 | 0.097 | **0.858** | **0/22** |

**Decisions made:**
- **Haar is deleted, not demoted.** A backend that selects chamber furniture as
  the speaker, reachable by an env var, is a trap for a future session — the same
  reasoning as ADR 010's refusal to keep a lower-weighted fallback. A fresh
  checkout with no model now fails loudly instead of degrading silently.
- **960×540 rejected for detection.** `speaker_verified_crop_design.md` §3.2
  predicted it would become default. It does not: frame detection gains 2.6 pp
  but median box width and track coverage are *identical* to 480×270 — the same
  track is chosen. That cancels a re-decode of 87 masters. Re-open it as a **V2
  identity** question: a 0.097 box is ~124 px at master scale but only ~46 px on
  a 480-wide analysis frame, which is marginal for SFace.
- **The body/pose detector was dropped after measuring.** It was in the plan (and
  in external advice) on the assumption that low coverage meant faces vanishing
  on head-turns. It does not: YuNet detects a face in 97–100% of frames. On
  single-speaker podium clips it is 1 track at coverage 1.00; on debate two-shots
  it is 2.50 faces/frame with top-1 **and** top-2 both ≥0.98. The residual is two
  people both tracked perfectly and no signal saying which is speaking. A body
  detector adds evidence where evidence is already complete.
- The inset is resolved once per clip from the first frame instead of detecting
  every frame twice, which halved detector calls on any debate with an inset
  configured.

**Golden diff, reviewed rather than accepted:** `08_track_fixture_summary.json`
keeps its `sample_count` (296, 153) and `track_id` (`track-001`), so the same
track with the same coverage is still selected. Box geometry changed from square
(106.75×106.667) to taller-than-wide (84.6×111.4, ratio ~0.74). Haar is trained
on square windows and can only emit squares; a real face box is taller than
wide, and YuNet's is ~20% tighter in width.

**Observations (not fixed, out of scope):**
- **The track merger fuses two people who use the same podium.** On
  `HD10392_ebe6af7e…_c01` the selected track alternates between Slottner and a
  later speaker at the same lectern: `merge_fragmented_tracks` is not scene-aware,
  so a cut that swaps the person while preserving screen position gives a high
  seam IoU and the two stitch into one identity. Theoretical in the design doc,
  now the *dominant* residual defect. V2.
- `FaceSample.is_speaking` is still set `True` for every sample of the selected
  track and has never carried an active-speaker decision.
- `face_height_frac` is still hardcoded to `1.0` in `src/scoring/text_features.py`
  against `MIN_FACE_HEIGHT_FRAC = 0.0` in `src/scoring/gate.py`. That gate has
  never been able to fire. V2/phase 3 supplies the real value.
- C9 still holds the previous crop through a shot with no samples
  (`src/camera/plan.py:65-69`). Half the catalogue hits it. V2.
- OpenCV Zoo's NanoDet ONNX emits GFL distribution bins, not `xyxy`; it needs DFL
  decoding and is not a drop-in, should a person detector ever be wanted.

**Blocked / needs a decision:**
- **The 1,762 live clips were all produced by the old detector**, ~74% with at
  least one defect. Owner deferred the re-render/republish decision until after
  phase 3, so nothing on Bunny or Supabase changed in this session.
- `P0-9` — five credentials in chat transcripts. Still open, carried over.

**Next agent should know:**
- Nothing has been re-processed. The catalogue on disk and the live site are
  still entirely old-detector output; the numbers above describe what *is*
  published, not what the code now produces.
- `python tasks.py golden` does **not** cover the C8 summary — it lives in the
  slow e2e. Regenerate with
  `UPDATE_GOLDEN=1 RIKET_TITLE_BACKEND=fallback python -m pytest tests/e2e -m slow`,
  and set `RIKET_TITLE_BACKEND=fallback` or the run bills the DeepSeek API.
- YuNet boxes can extend past the frame edge; `FaceSample.x/y` are
  `NonNegativeFloat`, so `scale_detections_to_media` clamps. Do not remove it.
- V2 is the whole remaining defect surface and needs an ADR before code:
  `FaceSample`/`FaceTrack` cannot carry confidence, landmarks, provenance, scene
  id or identity evidence.

## V2 — Speaker identity verification — DONE 2026-08-08

**Built:** `src/vision/identity.py`, `src/vision/models/face_recognition_sface_2021dec.onnx`,
scene-terminated tracking and `select_verified_track` in `src/vision/track.py`,
`IdentityVerifiedBackend` in `src/vision/asd.py`, enrolment and per-frame identity
scoring in `src/stages/track.py`, unsupported-span handling in `src/camera/plan.py`,
identity settings in `src/config.py`, `docs/adr/012-speaker-identity-verified-framing.md`,
`tests/unit/test_vision_identity.py`, `tests/fixtures/debates/betankande/speaker_enrolment.jpg`.
**Tests:** `python tasks.py test lint typecheck` green — **296 passed** (was 274),
67 deselected, 1 pre-existing `audioop` warning; ruff clean; mypy strict clean on
75 files. Slow e2e green after a reviewed golden regeneration.
**Contracts touched:** yes — see ADR 012.

### What V1 left behind

After the detector swap, every remaining defect was identity or scene
continuity, not detection. On a debate two-shot YuNet tracks *both* people in
~100% of frames, so geometry has no information about which one is speaking. And
`merge_fragmented_tracks` was not scene-aware, so on `HD10392_ebe6af7e…` two
speakers who used the same lectern across a cut were tracked as one person.

### The measurement that shaped the design

Closed-set rank-1 identification, ground truth from Riksdagen's own metadata,
nothing hand-labelled: **30/30 across three debates**. Two findings changed the
plan:

- **Margin beats absolute similarity.** A correct match landed at **0.366** — on
  top of OpenCV's documented 0.363 LFW threshold — while beating the runner-up by
  **+0.299**. Gating on the published absolute figure would have thrown that clip
  away. `IdentityThresholds` therefore keeps permissive absolute floors and lets
  the competitor margin discriminate.
- **480×270 frames are sufficient for identity too.** All 30 succeeded on ~46 px
  faces. `speaker_verified_crop_design.md` §3.2 assumed 960×540 would be
  required; measured, it is not — for detection (V1) or identity (V2). The
  re-decode of 87 masters is cancelled for good.

### Measured yield: 40.8%

Real C8 path, read-only, over **319 clips across 14 random debates**.

| Outcome | Clips | Share |
|---|---:|---:|
| accepted | 130 | **40.8%** |
| no verified speaker in a long shot | 161 | 50.5% |
| no official portrait to enrol | 27 | 8.5% |
| identity mismatch | 1 | 0.3% |

Sitting exactly on the 40% floor `speaker_verified_crop_design.md` §7.5 set for
a viable gate. Yield tracks debate *format*, not any threshold: near 100% for a
single speaker at a lectern, **36.4%** for an interpellation (`HD10342`),
**34.5%** for a frågestund — the formats that cut constantly between people and
carry the most wide shots, which is exactly where the old pipeline mis-framed
worst.

**An earlier figure of 67.4% was wrong; see the C8/C10 disagreement below.**

**The rejections are real.** Per-shot analysis of the two worst debates: 83–96%
of no-evidence shots have *no face detected at all*, the rest are single spurious
detections below the coverage floor, and **zero** are "track fine but embedding
lost". The gate rejects clips where the speaker is genuinely off screen — the
complaint this work exists to fix.

**Decisions made:**
- Tracks terminate at every scene cut; cross-shot association is identity only.
  Within a shot, fragment merging is *safe by construction* now, so it was kept.
- Acceptance is per shot, and the clip's timeline is the union of accepted shots.
  A cutaway shorter than `identity_max_unsupported_gap_s` (1.0 s) is tolerated —
  Riksdagen's feed cuts constantly and holding the crop for half a second is
  invisible, while rejecting every clip containing a cut would reject nearly all
  of them.
- Shot **edges** are always identity-sampled, not just the 1 Hz grid. Without
  that a short shot got no embeddings purely because no frame landed on the grid,
  and read as "no evidence" when the truth was "never asked".
- The geometric selector is deleted rather than kept as a fallback. Its history
  is the argument: a raw persistence vote that gave clips to a motionless face in
  the gallery, reweighted toward size, then giving them to chamber furniture.
- `is_speaking` removed rather than repurposed (ADR 012). Per-sample
  `identity_verified` was considered and rejected — SFace samples at ~1 Hz, so it
  would read `False` on most samples of a properly verified track.

**Observations (not fixed, out of scope):**
- **The cheapest remaining yield is not a vision problem.** 27 clips (8.5%) were
  rejected *only* because no portrait could be enrolled — the non-sitting minister
  `intressent_id` gap already recorded in the March and February backfills.
  `personlista?...&rdlstatus=samtliga` returns those ids. Closing it takes yield
  **40.8% → 49.3%** with no vision work, the best return per unit of effort
  available. It is no longer a *substitute* for vision-aware window selection
  though: at 40.8% the gate sits on the floor, and that is the only remaining
  lever that raises yield without weakening the identity gate.
- **Loosening the cutaway tolerance would not help.** `unsupported_span_exceeds_1.0s`
  is the dominant rejection cause (160 of 189), so the obvious move is to relax
  it. Measured on `HD10342`'s rejected clips the longest gap per clip runs
  2.6, 3.5, 3.6, 4.0, 4.4, 4.6, 5.2, 6.2, 6.2, 8.6, 18.2, 20.8, 32.5, 37.1 s —
  median 5.7 s, shortest 2.6 s. A 3 s tolerance recovers 1 of 14. The footage
  genuinely cuts away; relaxing the threshold buys volume by re-admitting the
  original complaint.
- Yield is not precision. These numbers say how many clips survive the gate, not
  how many survivors are correctly framed. The shot-level validation set of
  `speaker_verified_crop_design.md` §9.2 is still owed; until it exists the honest
  claim is "known failure modes fixed, gate rejects real absences", not "output
  verified correct".
- `face_height_frac` is still hardcoded to `1.0` in `src/scoring/text_features.py`
  against `MIN_FACE_HEIGHT_FRAC = 0.0`. C8 now has the real value; nothing feeds
  it back to C7.
- Vertical composition remains unmanaged: the crop is full source height with
  `y=0`. Third-order — head height p25–p75 is 0.294–0.370, which is fine; the p90
  tail of 0.765 is not.

**Blocked / needs a decision:**
- **The 1,762 live clips are all old-detector output**, ~74% with a framing
  defect. Nothing has been re-processed or re-published. The owner deferred this
  until after phase 3; the yield number needed to make that call now exists.
- `P0-9` — five credentials in chat transcripts. Still open, carried over.

### The bug a full debate run caught that the unit suite did not

C8 accepted any clip clearing `min_verified_frac` *even when it had recorded an
unsupported span longer than the tolerated cutaway*, while C9 refuses to plan a
camera across exactly such a span. The gates disagreed, so `08_track` asserted
`accepted` about clips that silently never rendered. Processing `HD10342` end to
end exposed it: **C8 reported 15 accepted, C10 emitted 8**, seven vanishing with
no record anywhere. Same defect class as ADR 010's fabricated box — an artifact
claiming a success that did not happen.

The long span now decides; `min_verified_frac` is a backstop.
`test_an_accepted_clip_never_carries_a_span_c9_will_refuse` pins it. **This is
why the first yield measurement read 67.4% instead of 40.8%** — it counted
phantom accepts. Nothing here was caught by a green unit suite; it took one real
debate.

**Next agent should know:**
- **This workstation hard power-cycled five times under sustained all-core load**
  (2026-08-07, 19:30–20:51). No BSOD, no minidump, no WHEA — the signature of
  power being cut, not a software crash. `cv2.setNumThreads(3)` in the audit
  scripts kept it stable for the rest of the run. Suspect PSU or cooling;
  unresolved, and worth knowing before launching a full backfill.
- C8 is ~3 s per clip at 3 threads including SFace, and portraits cache to
  `<work_dir>/_portraits`, so a debate re-run costs one request per politician.
- Tests must not hit the network: `track_dokid(..., portraits=...)` is the
  injection seam, and the e2e and C8 integration tests enrol from a crop of the
  committed fixture footage rather than an official portrait.

## V3 — Both yield levers — DONE 2026-08-08

**Built:** `src/riksdagen/persons.py` and `fetch_personlista` in
`src/riksdagen/client.py`, id recovery in `src/stages/discover.py`;
`src/vision/timeline.py`, `src/stages/vision.py` (C6v), `06_vision` paths,
framing features in `src/scoring/archetypes.py`, live framing gates in
`src/scoring/gate.py`, `vision` stage in `src/orchestrator/jobs.py`, C6v in
`src/stages/run_fixture.py`, `docs/adr/013-framing-informs-selection.md`,
`tests/unit/test_riksdagen_persons.py`, `tests/unit/test_vision_timeline.py`.
**Tests:** `python tasks.py test lint typecheck` green — **319 passed** (was
298), 68 deselected; ruff clean; mypy strict clean on 78 files. Slow e2e green
after a reviewed golden regeneration.
**Contracts touched:** none — framing values ride in the open
`Candidate.features` map; the timeline is a new plain-JSON artifact. See ADR 013.

### Lever 1 — portrait gap, 8.5% of clips

`anforandelista` omits `intressent_id` for speakers who are not sitting members,
so ministers drawn from outside the chamber could not be identity-verified at
all. `personlista?...&rdlstatus=samtliga` has the ids; the default query does not.

**Verified on the real failing case.** `HDC120260326fs` had 6 anföranden with no
id, all Jessica Rosencrantz. After the fix: **0 missing**, all resolved to
`0992420223820` — the id the March backfill recorded by hand.

The matching rule is deliberately strict, because attaching a politician's face
and byline to a statement is a misattribution risk rather than a data-cleaning
task. The two sources do not even agree on names: `anforandelista` says *Daniel
Vencu **Velasquez** Castro* where the register says *Daniel Vencu **Öhrlund**
Castro*, so full-surname matching fails outright. A match needs first name,
party and the **last** surname token to agree, and to be unique; anything else
keeps `None` and loses the clip. Validated by having it independently re-derive
ids the official API already supplies (Ola Möller, Anna Tenje).

### Lever 2 — framing informs selection (ADR 013)

C7 chose windows blind and C8 found out afterwards whether the picture held. A
new per-speech pass (C6v) writes `06_vision/<speech_id>.json`, and C7 admits a
candidate only when the speaker is verified for nearly all of it with no single
long absence.

Measured on `HD10342`, the hardest format available:

| | before | after |
|---|---:|---:|
| windows C7 proposed | 22 | 15 |
| clips C8 accepted | 8 | **14** |
| survival rate of C7's picks | 36.4% | **93.3%** |

**Usable clips up 75% with the identity gate untouched.** The fixture shows it in
miniature: `c02` moved from `rejected_no_evidence` to `accepted` with 189
detected samples because C7 shifted the window past an 8 s region where nobody
was detectable.

`face_height_frac` now carries a measured value. It had been hardcoded to `1.0`
against a gate constant of `0.0` since C7 shipped — the framing half of the
publish gate had never been able to fire.

**Decisions made:**
- C6v and C8 share one per-shot verification rule, so selection is judged by the
  rule it will later be judged by and the two cannot drift.
- C8 still re-verifies independently and remains the only authority on what may
  be published. C6v does not weaken the gate; it stops C7 proposing doomed
  windows.
- The pass is additive: a work dir without `06_vision` selects exactly as before,
  which keeps older work dirs and any non-C6v caller working.
- The gate checks the **longest** unverified gap, not just the total, because
  that is what C8 rejects on.

### Found while validating: C3 misattributes speakers when the lists diverge

`src/stages/segment.py:74-78` pairs `speaker_entries` (timing) to `anforanden`
(identity) **positionally**, and the official name *overrides* the correct one
from the video metadata. `HD10342` has 8 speaker entries and 9 anföranden — the
extra one is a `TREDJE VICE TALMANNEN` announcement with no video segment — so
from 1236 s onward **every speech carries the wrong speaker, party and official
text**, and the last anförande is dropped entirely.

Identity verification is what exposed it: a speaker who verifies at 86–96%
elsewhere in the same debate scored a median similarity of **0.000** across a
whole speech, which is SFace correctly reporting that the person in frame is not
the person named.

Blast radius across the live catalogue: **1 of 87 debates, 22 clips (1%)** — and
it is `HD10342`, the debate the owner independently reported as problematic.

**Not fixed: C3 is outside this chunk's file scope (rule 2).** It needs a real
pairing key rather than an index — `anforandetyp` plus speaker name against the
speaker entries, or dropping official entries with no matching video segment
before zipping.

**Blocked / needs a decision:**
- **The C3 misattribution above.** Wrong politician on 22 published clips.
  Severity argues for fixing it next regardless of chunk boundaries.
- **The 1,762 live clips are all old-detector output.** Nothing re-processed or
  re-published.
- `P0-9` — five credentials in chat transcripts. Still open.

**Next agent should know:**
- Corpus yield of 40.8% was measured **before** lever 2 and is now stale as a
  measure of the shipped pipeline; it was the number for blind window selection.
  Re-measuring it across the 14-debate sample is the obvious next task, and needs
  a C6v pass per debate (~120 s for 28 minutes of debate at three threads).
- C6v costs real time and sits in the `gpu` pool. C8 still re-detects the chosen
  window rather than slicing C6v's output — the obvious next optimisation, which
  also happens to preserve an independent second check.
- `python -m src.stages.vision --dokid <id> --work-dir <root>` runs it alone.
  `vision_dokid(..., portraits=...)` is the offline injection seam.

## V4 — C3 misattributed speakers when the two source lists diverge — DONE 2026-08-08

**Built:** `src/segment/pairing.py`, name-aligned pairing in
`src/stages/segment.py`, `tests/unit/test_segment_pairing.py`.
**Tests:** `python tasks.py test lint typecheck` green — **326 passed** (was
319), 68 deselected; ruff clean; mypy strict clean on 79 files. Slow e2e green.
**Contracts touched:** none.

### The defect

C1 emits two lists describing the same debate from different sides:
`speaker_entries` (who speaks **when**, the timing authority, one entry per real
video segment) and `anforanden` (who says **what**, the identity and transcript
authority). C3 zipped them **by index**, and the official name *overrode* the
correct one from the video metadata.

The official record can carry an entry with no video segment. `HD10342` has 8
speaker entries and 9 anföranden — the extra is a `TREDJE VICE TALMANNEN`
intervention — so from 1236 s onward **every speech carried the wrong speaker,
party and official text**, and the final anförande was dropped entirely. Because
the official name overrode the right one, the artifact looked correct.

**Identity verification is what exposed it.** SFace reported a median similarity
of **0.000** across a whole speech for a politician who verifies at 86–96%
elsewhere in the same debate — the model correctly reporting that the face on
screen is not the person named. Nothing else in the pipeline would have noticed.

Blast radius: **1 of 87 debates, 22 clips (1% of the catalogue)** — and it is the
debate the owner independently reported as problematic.

### The fix

`pair_official_speeches` aligns the two lists by name, walking forward in the
order the debate happened. An official entry with no video segment is stepped
over; a segment with no official entry keeps the video metadata's name and party
and simply has no transcript — silence rather than somebody else's words.

**A first implementation used `difflib`, and the test caught it.** Sequence
alignment looks right until it meets an interpellation, which is two people
alternating: `Tenje, Eriksson, Tenje, Eriksson, Tenje`. Several equally long
matching blocks exist, `SequenceMatcher` takes the leftmost, and on the real
`HD10342` shape it chose one that silently **deleted two speakers**. It passed on
the live artifact by luck. A forward walk with a bounded skip is both simpler and
correct.

### Result on HD10342, the full chain

| | speeches verified | selected | accepted |
|---|---|---:|---:|
| identity gate, blind selection | 5 of 8 (three at 0–6%) | 22 | 8 |
| + framing-aware selection (V3) | 5 of 8 | 15 | 14 |
| + correct attribution (V4) | **8 of 8, all 86–96%** | 20 | **17** |

The three speeches previously reading 0%, 6% and 6% visible were not framing
failures at all — the pipeline was looking for the wrong person in them.

**Decisions made:**
- The video metadata's name is the fallback and never loses a guess. An
  unmatched segment is described by the source that actually knows who was on
  screen.
- `MAX_SKIPPED_OFFICIALS = 4` bounds the forward scan. Chair interventions come
  in ones and twos; a wider window would let a coincidental match far ahead
  swallow entries belonging to later speakers, which is the failure being fixed.
- Two trailing name tokens form the identity key, so "Anna Tenje" matches
  "Äldre- och socialförsäkringsministern Anna Tenje (M)" without needing a rule
  for where a Swedish ministerial title ends.

**Blocked / needs a decision:**
- **`HD10342`'s 22 published clips carry the wrong speaker from 1236 s on.**
  Re-processing produces different `anforande_id`s and therefore different
  `clip_id`s, so this is a republish rather than an update. Owner's call.
- The 1,762 live clips remain old-detector output; nothing re-processed.
- `P0-9` — five credentials in chat transcripts. Still open.

**Next agent should know:**
- A length mismatch between `speaker_entries` and `anforanden` is the cheap
  detector for this shape: 1 of 87 debates today. It is not the only one — the
  lists could diverge at equal length — but per-speech verified visibility near
  0% while other speeches in the same debate sit at 90% is the reliable signal,
  and it is now free to compute from `06_vision`.

## UI3 — Riksdagen portraits and complete politician profiles — DONE 2026-08-08

**Built:** `migrations/009_politician_profiles.{up,down}.sql`, complete-person
fetching in `src/riksdagen/client.py`, `src/riksdagen/profiles.py`,
`scripts/sync_politician_profiles.py`, portrait fields through
`web/src/{types.ts,supabase.ts,App.tsx}`, portrait styling and focused tests.
**Tests:** `python tasks.py test lint typecheck` green — **332 passed**, 68
deselected, 1 pre-existing `audioop` warning; ruff clean; mypy strict clean on
80 files. `tsc --noEmit` green; `vite build` green (427.34 kB, 123.36 kB
gzipped). Live API dry run 3/3; full sync 183/183, zero missing.
**Contracts touched:** none.

### What changed

- Every public politician row now carries the official 192 px Riksdagen
  portrait URL, the complete nested `personlista` JSON and a sync timestamp.
  The projected columns use the same record for clean name, party, current role
  and constituency; the raw object retains assignments and biography fields for
  later profile features.
- Portraits replace initials in the feed identity row, search and followed lists,
  and the politician page. Initials remain underneath as the load/error fallback,
  image elements are lazy-loaded to protect the feed request budget, and fixed
  dimensions prevent layout shift.
- The politician page shows the required `Foto: Sveriges riksdag` credit and the
  Riksdagen constituency when one is published. Smaller uses carry the same
  credit as their image title without adding a second metadata line to the feed.
- Migration 009 installs a trigger that fills a deterministic portrait URL for
  every future politician insert. Full profile enrichment stays an explicit
  operator command instead of becoming a video stage.

### Live result

Migration `009_politician_profiles` is applied to project
`nlooigmwuqqhhnontlgp`. The sync fetched and updated all **183** existing
politicians: 183 portrait URLs, 183 non-empty complete records and 183 sync
timestamps. Public-key PostgREST reads include the fields, and three sampled
portrait URLs returned HTTP 200 with real JPEG byte lengths.

### Decisions made

- Store the full source object as `jsonb` rather than anticipating which fields
  later profile features will need. UI code still selects only the six small
  columns it renders, so the feed payload does not inherit that JSON weight.
- Use Riksdagen's 192 px URL for app avatars. The existing SFace identity path
  continues to fetch `_max.jpg`; UI presentation and model enrolment have
  different bandwidth needs.
- Keep enrichment independent of C1–C11. This avoids coupling a Riksdagen
  biography/API outage to video publication and avoids colliding with the
  concurrent video-pipeline work.

### Observations (not fixed, out of scope)

- The frontend changes are built locally but are not deployed until committed
  and pushed; the live site therefore continues to show initials for now.
- Run `python scripts/sync_politician_profiles.py` after the planned full
  backfill. The trigger supplies portraits immediately, but the complete person
  data and constituency are refreshed by this command.
- Browser-control tooling was unavailable in this session, so visual QA is still
  owed on a real 375×812 viewport after deployment. Data, image responses,
  TypeScript and the production bundle were verified.

### Blocked / needs a decision

- `P0-9` — five credentials in chat transcripts remain open for rotation.

### Next agent should know

- Riksdagen requires the credit `Foto: Sveriges riksdag` and limits press-image
  use to contexts describing the Riksdag and its work. Pleni's debate/profile
  use fits that context; do not reuse these portraits as advertising creative.
- F1 migration numbers moved from `009`/`010` to `010`/`011` because UI3 now
  owns applied migration 009.

## UI4 — Per-video comments and moderation — DONE 2026-08-08

**Built:** `migrations/012_video_comments.{up,down}.sql`, forward fix
`013_comment_reporter_identity`, `web/src/comments.ts`, the comment sheet in
`web/src/{App.tsx,styles.css}`, token/username support in `web/src/clerk.tsx`,
`scripts/moderate_comments.py` and focused migration security tests.
**Tests:** `python tasks.py test lint typecheck` green — **346 passed**, 68
deselected, one pre-existing `audioop` warning; ruff and mypy clean. Frontend
`tsc --noEmit` and Vite production build green (437.19 kB JS, 126.56 kB gzip).
**Contracts touched:** none.

### What changed

- Every published clip now opens a mobile comment sheet from the existing
  action rail. The sheet pauses the active video, resumes it on close, loads the
  real per-clip thread and keeps the composer above the mobile safe area.
- Comments render only `@username`, relative time and text. There is no user
  image field or avatar component. A viewer without a comment identity chooses
  a unique 3–24 character handle on the first post; Clerk subjects never leave
  the protected database projection.
- Anyone can read and report. Posting and own-comment deletion require the
  verified Clerk → Supabase session. The database enforces published-clip
  membership, 500 characters, no links in the first version, three posts per
  minute / 100 per day, account suspension and immutable ownership.
- Reports never auto-hide political speech. Service-role-only functions hide,
  restore or delete after review and can suspend an author. Each action writes
  an append-only moderation event. `scripts/moderate_comments.py` lists open
  reports and performs those actions without exposing moderator powers to the
  static app.

### Live result

Migrations `012_video_comments` and `013_comment_reporter_identity` are applied
to project `nlooigmwuqqhhnontlgp`. Public-key REST verification returned HTTP
200 for anonymous listing and HTTP 401 for anonymous posting. A rollback-only
live transaction proved safe public projection, A-cannot-delete-B, reporting
before a reporter has posted, hide/restore, suspension and own deletion. No test
comments or reports remain in the database.

### Decisions made

- The static frontend calls small Postgres RPCs rather than receiving direct
  table write grants. The tables have RLS enabled, no public policies and no
  privileges for `anon` or `authenticated`; public reads are a five-field safe
  projection.
- Username choice is separate from Clerk full name and email. Clerk's explicit
  username may be suggested, but Pleni never derives a public handle from a real
  name or email address.
- The visual system is a restrained near-black sheet over the full-bleed video,
  with a single blue identity/action accent, plain divided rows instead of
  avatar cards, and short sheet/row/composer motion with a reduced-motion path.
- `012` was already live when the signed-in-report-before-first-comment edge
  case was found. The fix is migration `013`, not an edit to the ledgered file.
  F1's reserved `010`/`011` numbers remain untouched.

### Observations (not fixed, out of scope)

- The onboarding terms/privacy acceptance remains device-local placeholder
  work for the later F0/F1 session, by owner request. UI4 does not persist or
  reinterpret those consent switches.
- Browser-control tooling was unavailable for a rendered 375×812 capture. CSS,
  accessibility structure, TypeScript and the production bundle were verified;
  final feel should be checked on the owner's live phone after deploy.

### Blocked / needs a decision

- `P0-9` — five credentials in chat transcripts remain open for rotation.

### Next agent should know

- Use `python scripts/moderate_comments.py reports` for the queue, then
  `hide|restore|delete <comment-uuid> --reason ...` or
  `suspend|unsuspend @username --reason ...`.
- Comments cascade with `clips` and comment profiles. A later account-deletion
  workflow can delete one `comment_profiles` row and remove that account's
  comments without searching public text.

## UI5 — Stop off-screen media — DONE 2026-08-08

**Built:** lifecycle-owned playback in `web/src/App.tsx`, plus the UI5 scope in
`docs/BUILD_PLAN.md` and the player invariant in `AGENTS.md`.
**Tests:** `python tasks.py test lint typecheck` green — **346 passed**, 68
deselected, one pre-existing `audioop` warning; ruff and mypy clean. Frontend
`tsc --noEmit` and Vite production build green (438.26 kB JS, 126.89 kB gzip).
A focused 393×852 headless-Chrome run forced the first unmuted `play()` to
reject 600 ms late, navigated to Sök before it settled, and found 0 mounted
videos plus 0 playing detached media; the same check passed on Profil.
**Contracts touched:** none.

### What was wrong

- Native `autoPlay` and `playWithMutedFallback()` could both own startup.
  React removed the feed on navigation, but a browser-policy rejection can
  settle later; its catch handler could then call `video.play()` again on the
  detached element. Detached media may continue producing audio.
- Unmounting relied on DOM removal to stop playback. There was no explicit
  pre-detach pause or invalidation token for an already pending `play()`.

### What changed

- Programmatic playback is now the only autoplay owner. Each request carries a
  generation and may update state or attempt the muted fallback only while the
  same clip, media node, mounted feed and visible document are still current.
- Layout cleanup and stable ref cleanup pause every media element before it is
  detached. Navigation, clip changes, comment opening and document hiding also
  invalidate pending requests. Returning from a temporary page hide resumes
  only if that same visible feed was playing beforehand.

### Observations (not fixed, out of scope)

- The concurrent C6 edits in `src/candidates/windows.py`, `src/config.py`,
  `src/stages/candidates.py` and `tests/unit/test_candidates_windows.py` belong
  to the other agent. They were not edited or staged by UI5; full acceptance
  happened to include their current working-tree state and remained green.

### Blocked / needs a decision

- `P0-9` — five credentials in chat transcripts remain open for rotation.

### Next agent should know

- Do not restore the JSX `autoPlay` attribute. `FeedScreen` must remain the
  single playback owner so screen and visibility cleanup can cancel every
  pending fallback deterministically.

## V5 — Clip edges land on measured silence — DONE 2026-08-08

**Built:** pause snapping with lead-in/tail in `src/candidates/windows.py`, wiring
and settings through `src/stages/candidates.py` and `src/config.py`, an ffmpeg
thread cap in `src/media/ffprobe.py` applied at all three call sites, tests in
`tests/unit/test_candidates_windows.py`.
**Tests:** `python tasks.py test lint typecheck` green — **346 passed**, 68
deselected; ruff clean; mypy strict clean on 80 files. Slow e2e green after a
reviewed golden regeneration.
**Contracts touched:** none.

### The complaint, and why it was real

The owner reported clips "ending at very random places". Measured against the
waveform rather than against metadata — C5's RMS comes from the audio, so it can
be asked whether a cut point is real — over 517 published clips in 30 debates:

| | before | after |
|---|---:|---:|
| clip **starts** mid-speech | 63% | **22%** |
| clip **ends** mid-speech | 60% | **22%** |
| ends landing inside a real pause | 11% | **78%** |
| median distance from end to nearest pause | 1.35 s | **0.00 s** |

The cause is ADR 011. C4 distributes the official transcript's words evenly
across the speech window, so the "sentence boundaries" C6 builds candidates on
are linear interpolations, not observations of when anyone stopped talking. Same
defect class as the framing work: a derived guess treated as evidence.

C5's pauses come from the waveform, so snapping to them replaces the guess with a
measurement — the move `src/segment/refine.py` already makes with scene cuts.

**Clip count held**: 21 vs 20 on `HD10342`, so no yield was traded for it. The
fixture golden shows the same thing in miniature: both clips still accepted, with
*more* detected samples (296→301 and 189→208) and no unsupported spans, because
the chosen windows moved to better-bounded positions.

**Decisions made:**
- Snapping runs *before* the duration filters, so a window is admitted on the
  length it will actually be rendered at rather than on its interpolated one.
- The start snaps to a pause's **end** and the end to a pause's **start**, then
  `cut_lead_in_s` (0.20) and `cut_tail_s` (0.30) back each edge into that
  silence. Landing exactly on the first phoneme clips it; the padding is clamped
  inside the pause so it never reaches into the neighbouring sentence.
- `cut_snap_max_s` is 2.0 s. A pause exists within 1 s of a cut for 40% of clips
  and within 2 s for 65%; beyond that the timings are simply wrong and no snap
  distance rescues them.
- Off by default in the function signature (`max_snap_s=0.0`), so callers that do
  not pass pauses behave exactly as before.

### A measurement trap worth remembering

The first version snapped without padding, and the start metric got *worse*:
59% → 76% "at more than half of speaking level". That was the metric being wrong,
not the code — snapping the start to the instant speech resumes makes it loud **by
construction**. Sampling 0.15 s either side of the boundary instead measures what
was actually wanted: quiet before the start, quiet after the end. Both baseline
and result were then re-measured with the corrected metric.

**Observations (not fixed, out of scope):**
- This closes roughly two thirds of the problem. For the ~35% of cuts with no
  pause within 2 s the word timings are simply wrong, and only real alignment
  fixes them. Forced alignment is the tier-2 option: the authoritative text
  already exists, so it needs mapping rather than recognition, which is far
  cheaper than ASR. `torch` here is `2.11.0+cpu` while a GTX 1080 sits unused —
  a CUDA build would make that practical.

**Blocked / needs a decision:**
- **The development workstation cannot sustain all-core load.** Seven hard
  power-offs in one session, every one under sustained multi-core work, with no
  bugcheck, no minidump and no WHEA entry — power being cut, not software
  crashing. One of them **zeroed `08_track_fixture_summary.json` mid-write**
  (1033 bytes of NUL; restored from git). Kernel-Power 41 events go back to
  January, so this predates the session. Suspect PSU or cooling. Until it is
  resolved, run anything ffmpeg-heavy with `RIKET_FFMPEG_THREADS=2`.
- Carried over: the `HD10342` republish, the 1,762 old-detector clips, and P0-9.

**Next agent should know:**
- `RIKET_FFMPEG_THREADS` caps decode and encode. Default `0` is ffmpeg's own
  "use everything", i.e. unchanged. At 2 threads the slow e2e takes 103 s instead
  of 77 s and the machine survives it, which is the only reason the golden could
  be regenerated at all.
- The cut-quality measurement is worth keeping as a regression check: sample RMS
  0.15 s either side of every clip boundary and compare against that speech's
  own 60th-percentile loudness. Both the baseline and the result above were
  produced that way.

## V6 — Tier-2 timing: tried, measured, reverted — 2026-08-08

**Built:** nothing shipped. This entry exists so the next agent does not spend the
same day rediscovering it.
**Tests:** `python tasks.py test lint typecheck` green — 346 passed, unchanged.
**Contracts touched:** none.

### The idea

V5 snapped clip edges onto measured pauses and fixed about two thirds of the bad
cuts. The remaining third had no pause within the 2 s snap window, meaning the
interpolated sentence times were simply too wrong to rescue.

The obvious cause: C4 spreads the official transcript's words evenly over
**wall-clock** time (ADR 011), which assumes the speaker never stops. A 10 s pause
consumes a tenth of a 100 s speech while consuming no words, so every later word
is placed early and the error accumulates. The obvious fix, and much cheaper than
adding a neural forced aligner to a machine that cannot run one: spread the words
over **voiced** time instead, using the VAD C3 already owns, and map back onto the
clock so silence costs no words.

### It did not work

Measured on `HD10342`, cut quality by the same waveform metric as V5:

| | V5 only | + voiced timing | + voiced timing, silence definitions aligned |
|---|---:|---:|---:|
| starts mid-speech | **22%** | 45% | 24% |
| ends mid-speech | **22%** | 40% | 43% |
| ends inside a real pause | **78%** | 70% | 57% |

The middle column had a genuine bug behind it — C4's VAD splits speech at 0.35 s
gaps while C5 calls a gap a pause at 0.40 s, so words were distributed against one
model of the speech and edges snapped against another. Aligning them recovered
the starts. **The ends still got worse.**

The reason is structural, and it is why more tuning will not save it. Changing
word timings shifts every sentence boundary, which changes the whole candidate
set, so C7 selects *different windows*. Selection ranks on text and audio, not on
cut quality, so the reshuffle is effectively random with respect to the metric.
Meanwhile V5's snapping already puts an edge on a measured pause whenever one is
within 2 s — regardless of how wrong the interpolation was. Improving the
interpolation therefore buys almost nothing that snapping had not already bought,
while destabilising which clips get chosen.

**Reverted rather than shipped.** There was no measured upside and a consistent
downside, and a config flag to hide it would be a decision not made.

**Observations (not fixed, out of scope):**
- Sample was 21 clips in 2 debates, which is small. The direction was consistent
  across three runs, but a larger sample would make the negative result firmer.
- Voiced-proportional timing may still be right for something this metric cannot
  see: the correspondence between `clips.transcript` and what is actually said.
  That matters for titles and search, not for where the cut lands. If it is
  retried, measure *that*, not cut quality.
- Real forced alignment (CTC, e.g. `torchaudio.functional.forced_align` with an
  MMS bundle) remains the only thing that fixes the underlying timings. It needs
  torch with CUDA; this box has `2.11.0+cpu` and an idle GTX 1080.

**Next agent should know:**
- Do not re-attempt voiced-proportional word distribution expecting better cuts.
  The blocker is that selection is not cut-quality aware, not the timing model.
- The cut-quality measurement is worth keeping: sample RMS 0.15 s either side of
  each clip boundary, compare against that speech's own 60th-percentile loudness,
  and report the share above 50%. Sampling *at* the boundary measures the wrong
  thing and will tell you a correct fix made things worse.

## V7 — Selection prefers windows that cut cleanly — DONE 2026-08-08

**Built:** `edge_gap_s` feature in `src/scoring/archetypes.py`, cut-aware ordering
in `src/scoring/select.py`, `max_clip_edge_gap_s` in `src/config.py`, wiring in
`src/stages/select.py`, tests in `tests/unit/test_scoring_select.py`.
**Tests:** `python tasks.py test lint typecheck` green — **348 passed**; slow e2e
green after a reviewed golden regeneration.
**Contracts touched:** none — the feature rides in the open `Candidate.features`.

### Why this and not forced alignment

V6 established that improving word timings does not improve cuts, because
selection ranks on text and audio and cannot see where a window cuts. That
diagnosis points somewhere much cheaper than a neural aligner: a speech offers
hundreds of admissible windows, some of which already end on real silence, and
nothing preferred them.

### Measured before building

On the shipped V5 artifacts for `HD10342`: **39% of chosen clips had a materially
cleaner window available in the same speech**, sometimes cutting several seconds
from any pause when a perfect alternative existed among the same passing
candidates. That headroom is what justified the work.

### Result

| | V5 only | + V7 |
|---|---:|---:|
| clips cutting on silence (edge within 0.25 s) | 56% | **68%** |
| clips that passed over a cleaner window | 39% | **26%** |
| clips produced | 18 | **19** |

Modest, not transformational — the big win was V5 (11% → 78% of ends landing in a
pause). This is polish on top, and it costs nothing: no dependency, no model, no
extra compute, and no clips lost.

**Decisions made:**
- Cut quality is expressed as an **ordering**, not a filter. The first attempt
  used a filter with a relaxation ladder and produced *byte-identical* output,
  because a filter is all-or-nothing: a clean-only pass filling three of four
  slots was discarded whole and the unrestricted retry threw the partial win away
  with it. Sorting cleanly-cut windows first lets the greedy fill take them while
  they last and top up from the rest, so the preference can never cost a clip.
- Score still breaks ties within each group, so a clean window does not beat a
  much better one by an unbounded margin — it wins the ordering, not the ranking.

**A measurement error worth not repeating:** the first headroom check reported
62%, run against candidates still built from the reverted V6 timings. Re-run on
the shipped artifacts it was 39%. When a change is reverted, regenerate every
downstream artifact before measuring anything against it.

**Observations (not fixed, out of scope):**
- 26% of clips still pass over a cleaner window. Those lose on overlap, the
  archetype ceiling, or a large score gap — which is the intended trade, not a
  bug. Pushing further would start sacrificing content quality for cut placement.
- The loudness metric and the pause-membership metric disagreed slightly on this
  19-clip sample. Pause membership is the more robust of the two at this size;
  neither should be trusted alone below a few hundred clips.

**Next agent should know:**
- Real forced alignment (CTC, `torchaudio.functional.forced_align`) is still the
  only thing that fixes the underlying word timings, and is still gated on torch
  with CUDA — this box has `2.11.0+cpu` and an idle GTX 1080. Read V6 first: the
  benefit will not show up in cut quality, so measure transcript-to-audio
  correspondence instead.

## HANDOFF — re-backfill after the framing rebuild (2026-08-08)

For the next agent, whose job is wiping Bunny and re-publishing the catalogue.
Everything below is a consequence of V1-V7; none of it is optional.

### The catalogue on Bunny and Supabase is stale in three separate ways

1. **Framing.** All 1,762 published clips came from the Haar-era pipeline. 74.3%
   carried at least one framing defect — measured, not estimated (see
   `docs/CLIPPING_V2_DESIGN.md` §1). Nothing has been re-rendered.
2. **Attribution.** `HD10342` carries the **wrong speaker** from 1236 s onward
   (V4). Its 22 clips name the wrong politician, party and transcript.
3. **Two clips are test artifacts.** `HD01SfU35_90051909-…_c01` and `_c02` were
   published by accident on 2026-08-07 from the 854x480 fixture trim, taking the
   catalogue 1,762 → 1,764. The hole is closed (V-fix `1dfabff`), the clips are
   not. Delete them and the `HD01SfU35` `sources` row.

### Clip IDs will change, so this is a republish and not an update

`clip_id` is `{dokid}_{anforande_id}_c{NN}`. V4 changed which `anforande_id` a
speech gets when the two C1 lists diverge, and V5/V7 changed which windows are
selected, so `c01` is not the same 45 seconds it used to be. **Do not try to
update rows in place.** Delete, re-process, re-publish.

Order matters when deleting: **Supabase rows first, then Bunny objects.** C11's
invariant is that a `clips` row never points at a missing file, and the reverse
order breaks it for as long as the deletion runs.

### Re-processing: what must be re-run, and from where

Old artifacts on `D:/riketvideos` are **not** reusable from C3 onward:

| Stage | Why it must re-run |
|---|---|
| C1 discover | recovers `intressent_id` for non-sitting ministers (V3) |
| C3 segment | name-based speaker pairing (V4) |
| C4 transcribe | cheap, and downstream of C3 |
| C5 audio features | cheap, and C6 needs the pauses |
| C6 candidates | edges snap to measured silence (V5) |
| **C6v vision** | **new stage**, and C7 silently degrades without it |
| C7 select | framing- and cut-aware selection (V3, V7) |
| C8 track | `FaceTrack` contract changed; old `08_track/*.json` **will not load** |
| C9, C10, C11 | downstream of all of the above |

Only C2's `master.mp4`, `analysis.wav`, `frames/` and `02_scenes.json` survive.
That is the expensive part, so a re-run is much cheaper than a cold backfill —
no re-download.

### Expectations

- **Yield will be well below 100% and that is the point.** A clip is rejected
  when the expected speaker cannot be verified on screen; the old pipeline
  published those mis-framed. Corpus yield measured **40.8%** before V3, and V3
  raised it substantially on the one debate re-measured (`HD10342`: 8 → 17
  accepted). **The corpus figure has not been re-measured since V3 and is stale
  — measure it early rather than trusting 40.8%.**
- Yield tracks debate *format*: near 100% for a single speaker at a lectern,
  ~35% for frågestund and interpellation, which cut constantly between people.
- Budget roughly 12-15 minutes per debate, up from 9.

### Traps that have already bitten someone

- **`RIKET_FFMPEG_THREADS=2`.** The workstation hard power-cycles under
  sustained all-core load and has corrupted a file mid-write. See `AGENTS.md`.
- **`run_fixture` publishes.** It did, to production, because `publish_dokid`
  falls through to `settings.publish_backend` and `.env` says `remote`. Now
  pinned to `local` with a test guarding it — do not undo that.
- **`git add -A` is unsafe here.** Other agents work in this repo concurrently;
  an earlier commit swept up an unrelated in-progress feature. Stage by path.
- **Re-measure after reverting anything.** A headroom figure was reported at 62%
  because it was computed against artifacts from a reverted change; the real
  number was 39%.

### Still open

- `P0-9` — five credentials in chat transcripts, unrotated.
- No shot-level audit set exists, so precision among *accepted* clips is
  unverified. Yield is not precision. `speaker_verified_crop_design.md` §9.2
  specifies the set; the rule of three means zero failures in 100 audited clips
  bounds the true failure rate at ~3%, not 0.

## UI6 — browser-history navigation — DONE 2026-08-09

**Built:** `web/src/navigation.ts`, integration in `web/src/App.tsx`, and the
UI6 scope in `docs/BUILD_PLAN.md`.
**Tests:** Ten route parse/serialize checks green; direct TypeScript check and
Vite production build green; `python tasks.py test lint typecheck` green (352
passed, 68 deselected, one existing `audioop` warning; lint and strict typing
clean).
**Contracts touched:** none.

**Decisions made:**
- Pleni now pushes a browser-history entry for bottom tabs, `För dig`/`Senaste`,
  politician profiles, saved clips and politician clip feeds. Browser Back and
  Forward restore those screens in order instead of leaving Pleni on the first
  Back press.
- Routes use URL hashes, such as `#/sok` and `#/person/<id>`, because the
  InstaPods deployment is a static host with no path-based SPA fallback. Hash
  routes survive reloads without a server rewrite or a router dependency.
- History and URLs contain only public screen choices and public politician or
  clip identifiers. Saved/followed library contents remain outside both.
- Unknown or malformed hashes fail safely to Hem. An in-app back button on a
  directly loaded deep link falls back to its parent tab rather than creating a
  navigation loop.

**Observations (not fixed, out of scope):**
- The available browser-control runtime could not attach in this session, so
  verification used the complete route round-trip matrix, compiled bundle and
  production build rather than automated Back/Forward clicks in a mobile pane.
- Comment and onboarding sheets remain transient overlays rather than history
  entries. UI6 covers navigable screens and tabs; modal dismissal semantics are
  unchanged.

**Blocked / needs a decision:**
- none.

**Next agent should know:**
- Do not replace the hash routes with path routes unless InstaPods first gains
  an SPA fallback; direct reloads on `/person/...` would otherwise return 404.
- `web/src/navigation.ts` is the single owner of route parsing, serialization
  and the History API marker. Add future screens there instead of calling
  `pushState` from components.

## UI7 — compact politician profiles — DONE 2026-08-09

**Built:** profile layout polish in `web/src/styles.css` and the UI7 scope in
`docs/BUILD_PLAN.md`.
**Tests:** Direct TypeScript check and Vite production build green;
`python tasks.py test lint typecheck` green (352 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean).
**Contracts touched:** none.

**Decisions made:**
- Reduced the profile top bar from 50 px of fixed empty lead-in to 8 px above
  the existing 44 px controls, while retaining the device safe-area inset. The
  scroll content lead-in also drops from 20 to 14 px.
- Replaced the tall centred identity stack with a 96 px portrait beside the
  name, party, role/constituency and follow action. Long names retain a flexible
  text column and may wrap without squeezing the portrait.
- Replaced the three-column card grid, which only contained two real values,
  with a cardless divided row. `Klipp` and `Visas här` now use the whole width
  without an empty third cell.
- Kept portrait attribution, 44 px top-bar targets, profile data, clip order and
  all behavior unchanged. This is a hierarchy and spacing correction only.

**Observations (not fixed, out of scope):**
- The browser-control runtime was unavailable in this session, so visual QA was
  limited to the responsive CSS constraints, compiled bundle and production
  build. Final feel should be checked on the live phone after deployment.

**Blocked / needs a decision:**
- none.

**Next agent should know:**
- The compact identity layout is intentionally CSS-only. Do not add duplicate
  profile DTO fields or a second portrait component to adjust its spacing.

## UI8 — political party profiles — DONE 2026-08-09

**Built:** `migrations/014_party_profiles.{up,down}.sql`, party DTOs and public
reads in `web/src/{types,data,supabase}.ts`, hash routes in
`web/src/navigation.ts`, search/following/profile UI in `web/src/App.tsx`, party
layout in `web/src/styles.css`, migration guardrails in
`tests/unit/test_party_profile_migration.py`, and the UI8 scope in
`docs/BUILD_PLAN.md`.
**Tests:** Party migration and migration-discovery guardrails green (13 tests);
direct TypeScript check and Vite production build green;
`python tasks.py test lint typecheck` green (355 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean). Live mobile QA at
390×844 verified 35 newest Moderaterna clips, 42 politician records, party-first
search results and browser Back to the filtered search screen.
**Contracts touched:** none.

**Decisions made:**
- Added canonical storage for the eight Riksdag party codes, names, short names,
  colours and display order. Migration 014 is applied to production project
  `nlooigmwuqqhhnontlgp`; anonymous `select` returned all eight rows and an
  anonymous write was rejected with HTTP 401.
- Clip and politician totals are not stored on the party row. The profile counts
  the live relationships instead, preventing totals from becoming stale.
- Party membership follows `public.politicians.party`, the same current-
  affiliation rule used when displaying clips. Party clips traverse
  `politicians → speeches → clips` and sort by `clips.published_at desc`.
- Selecting a party chip always renders its party page before the politician
  results. Text search matches the canonical code, full name and short name.
- Party search rows use the party avatar, name and action text without a separate
  eyebrow label; the extra label collided with the name at mobile widths.
- Added `#/party/<code>` and `#/party/<code>/clips` routes. Opening a party,
  politician or clip pushes same-document history so Back returns to the parent
  search or party screen.
- Removed fabricated party clip totals from `web/src/data.ts`; real totals now
  come from exact Supabase counts and render only when successfully read.

**Observations (not fixed, out of scope):**
- Search remains capped at 40 politician results, while a party profile loads up
  to 100 current politician rows. Moderaterna currently has 42 records, so its
  party page is the complete roster and its search list is the existing bounded
  search result window.
- The backend migration is live, but this frontend branch has not been pushed or
  merged. The public site will not expose party pages until the frontend commit
  reaches `origin/main` and InstaPods rebuilds it.

**Blocked / needs a decision:**
- none.

**Next agent should know:**
- New party metadata belongs in `public.party_profiles`; changing affiliation
  still belongs in `public.politicians.party`. Do not copy membership or derived
  clip totals into the party table.
- Keep party clip ordering on `published_at desc` unless product explicitly
  changes what “recent” means.

## UI9 — inline mobile video playback — DONE 2026-08-09

**Built:** inline media hardening in `web/src/App.tsx`, native-control
suppression in `web/src/styles.css`, and the UI9 scope in
`docs/BUILD_PLAN.md`.
**Tests:** Direct TypeScript check and Vite production build green; rendered
mobile DOM verified at 390×844 with 60 clips and the standard plus legacy inline
attributes; a video tap stayed outside fullscreen and picture-in-picture;
`python tasks.py test lint typecheck` green (355 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean).
**Contracts touched:** none.

**Decisions made:**
- Kept `playsInline` and explicitly disabled browser controls,
  picture-in-picture and remote playback on every feed video.
- Added `webkit-playsinline`, `x5-playsinline`, `x5-video-player-type=h5-page`
  and `x-webkit-airplay=deny` for Android WebViews and older WebKit engines that
  do not rely solely on the standard hint.
- Video-surface taps now prevent the media element's default action and call
  Pleni's existing play/pause path directly. The surrounding feed tap remains
  as a fallback, and mute, seek, loop, autoplay and media windowing are unchanged.
- Suppressed WebKit media-control chrome and retained vertical `pan-y` touch
  behavior so the video surface remains part of the swipe feed.

**Observations (not fixed, out of scope):**
- Samsung Internet documents its floating Video Assistant as a browser feature
  that appears when online video starts. Pleni can withhold native controls and
  request inline playback, but a viewer's browser setting may override site
  hints. If the blue button survives this change, confirm Samsung Internet and
  compare Chrome on the same phone before changing the player again.

**Blocked / needs a decision:**
- none.

**Next agent should know:**
- Do not re-add the native `controls` attribute to feed videos. Pleni owns play,
  pause, mute and seek, and Samsung's Popup Video is specifically tied to native
  media controls.

## UI10 — profile library navigation — DONE 2026-08-09

**Built:** saved-library routes in `web/src/navigation.ts`, the saved clip grid,
profile/following navigation and separated profile cards in `web/src/App.tsx`,
supporting layout in `web/src/styles.css`, and the UI10 scope in
`docs/BUILD_PLAN.md`.
**Tests:** Direct TypeScript check and Vite production build green;
`python tasks.py test lint typecheck` green (355 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean).
**Contracts touched:** none.

**Decisions made:**
- The profile's Following row now opens the complete device-local following
  list. People and parties retain profile navigation, while each row exposes an
  explicit `Avfölj` action that updates the same library state as the feed.
- Saved clips first render in the established three-column portrait grid. A
  thumbnail opens the existing shared feed player at that exact clip; no second
  playback implementation was introduced.
- Saved grid and saved player have separate hash routes. Browser Back returns
  from playback to the grid, and direct saved-player links fall back there via
  the in-app back control.
- `Personaliserat flöde` now occupies its own `Personalisering` card, visually
  separated from download, cookie and account-deletion controls.

**Observations (not fixed, out of scope):**
- Saved clips and follows remain scoped to the signed-in account on this device.
  Server persistence remains F1 and was not pulled into this UI chunk.

**Blocked / needs a decision:**
- none.

**Next agent should know:**
- Keep the saved grid as the archive entry point. `saved-clips` is only the
  immersive playback route after a deliberate thumbnail selection.

## UI11 — self-hosted politician portraits — DONE 2026-08-09

**Built:** provenance and mirror state in
`migrations/015_self_hosted_portraits.{up,down}.sql`, safe JPEG download and
content-addressed upload in `src/riksdagen/portraits.py`, mirror integration in
`scripts/sync_politician_profiles.py`, focused unit/migration tests, the UI11
scope in `docs/BUILD_PLAN.md`, and operator instructions in `docs/RUNBOOK.md`.
**Tests:** 25 focused portrait/profile/migration tests green; direct frontend
TypeScript check and Vite production build green;
`python tasks.py test lint typecheck` green (370 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean).
**Contracts touched:** none.

**Decisions made:**
- Keep the official Riksdagen URL in `avatar_source_url`, but serve the frontend
  from the verified Bunny URL in `avatar_url`. The exact JPEG bytes are retained
  without resizing or recompression, and the existing UI credit stays
  `Foto: Sveriges riksdag`.
- Bunny paths are immutable and content-addressed as
  `portraits/<intressent_id>/<sha256>.jpg`. An unchanged source hash reuses the
  prior CDN URL; a changed portrait gets a new URL and can cache for one year.
- Downloads are restricted to HTTPS on `data.riksdagen.se`, require
  `image/jpeg`, a valid JPEG envelope and at most 5 MB. Politician ids and hashes
  are validated before becoming storage paths.
- Supabase switches to a new CDN URL only after the existing Bunny client has
  uploaded and verified it. A failed refresh retains the last working URL and
  hash. The politician trigger also prevents later clip publication from
  replacing a verified CDN portrait with Riksdagen's source URL.
- Profile and portrait sync remain an explicit operator command outside the
  numbered video stages. A Riksdagen image outage therefore cannot block clip
  acquisition, rendering or publication.

**Live result:**
- Migration 015 is applied to production project `nlooigmwuqqhhnontlgp`.
- 208 of 210 known politician portraits were mirrored into Bunny zone
  `riketnlooigm`. A complete public-CDN verification downloaded all 208 objects
  (2,041,091 bytes): every response was JPEG, every HTTP status was 200 and
  every SHA-256 matched Supabase.
- Johan Britz and Benjamin Dousa remain on the initials fallback. Riksdagen's
  returned 80 px, 192 px and max portrait URLs all return 404 for both people;
  no third-party substitute was introduced.
- A repeat canary reused all three unchanged CDN portraits with zero uploads,
  confirming the periodic refresh path is idempotent.

**Observations (not fixed, out of scope):**
- The two missing portraits belong to people for whom Riksdagen currently
  publishes metadata but no portrait bytes. If another official source is used
  later, its separate licence and credit must be verified first.

**Blocked / needs a decision:**
- none.

**Next agent should know:**
- Run `python scripts/sync_politician_profiles.py` after a politician backfill or
  when official portraits may have changed. Exit status 2 means at least one
  source or mirror failed; successful rows are still updated safely.

## UI12 - public legal information - SHIPPED 2026-08-09

**Built:** removed the signed-in Clerk->Supabase diagnostic and raw auth-claim
output; added static-host-safe legal routes and four public Swedish pages from
the Profile footer; changed onboarding to run only after Clerk sign-in and once
per account; scoped onboarding localStorage by Clerk user id; separated terms,
privacy information and optional personalisation; removed non-functional data
export/deletion controls; and created the F0 evidence pack in `docs/privacy/`.
**Tests:** Direct TypeScript check and Vite production build green;
`python tasks.py test lint typecheck` green (370 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean).
**Contracts touched:** none.

**Decisions made:**
- Anonymous visitors enter the feed without onboarding, an age gate, terms
  acceptance or a generic cookie banner. Clerk registration happens first; a
  signed-in account without a completion marker then sees optional onboarding.
- Under-13 account use needs guardian permission, stated without collecting a
  birth date or adding an age checkbox. The owner rejected blanket 18+ access
  and universal age assurance as disproportionate for parliamentary content.
- Terms are presented with account creation. The Article 13 privacy notice is
  accessible information, not something bundled into contractual acceptance.
- Personalisation stays off until affirmatively selected. The public notice
  states that the current release does not send viewing history or an inferred
  political profile to a Pleni server.
- Current storage is limited to necessary Clerk authentication and features the
  signed-in viewer requests. There is no first-party analytics, advertising or
  promoted political placement.
- Public legal entry points are `Villkor`, `Integritet`, `Cookies` and
  `Om & kontakt`. Comment rules, notice/action and objections live in the terms
  and contact page instead of a separate thin page.
- Fake `Ladda ner mina data` and `Radera konto` rows were removed. GDPR requests
  use `kontakt@pleni.se` until real end-to-end workflows exist.

**Follow-up - profile layout restored 2026-08-09:**
- The `Konto`, `Mina intressen` and `Personalisering` groups remain visible to
  signed-out visitors. Account-required taps open Clerk; legal pages stay public.

**Follow-up - onboarding trigger corrected 2026-08-09:**
- A missing device-local completion marker is no longer treated as proof of a
  new account. Onboarding requires Clerk's completed-sign-up redirect plus a
  first-session timestamp match. Restored sessions and normal sign-ins skip it.

**Live legal status:**
- `kontakt@pleni.se` is the confirmed public contact.
- `Pleni AB` is planned but not registered. Public copy explicitly does not
  present it as an existing legal entity and records that name, organisation
  number, registered seat and establishment address must be added after
  incorporation.
- F0-7 (minors), F0-8 (current ePrivacy classification), F0-10 (advertising
  firewall) and the V1 F0-14 takedown path are recorded as decided. The DPIA,
  inventory, processor register and operating policy are drafted but retain
  their documented launch gates for future server-side profiling.

**Observations (not fixed, out of scope):**
- Clerk, Supabase, Bunny and InstaPods account-side DPA, region, log-retention,
  backup and subprocessors evidence still needs an operator dashboard audit.
- Clerk account deletion is not yet an end-to-end deletion cascade for Supabase
  comment identities/reports. Do not claim it is until F0-12/A-14 is tested.
- A real recommender still needs the versioned server consent ledger, fixed
  retention jobs, party-balance policy and updated notice/DPIA before collecting
  viewing events or inferred political interests.

**Blocked / needs a decision:**
- Complete legal operator information cannot be published until the operating
  person/entity is identified or Pleni AB is registered with an organisation
  number, seat and establishment address. This is disclosed rather than filled
  with a placeholder.

**Next agent should know:**
- Do not restore `AuthDiagnostics` or the old anonymous first-run onboarding.
  Do not read the bare legacy onboarding key into a Clerk account.
- `web/src/legal.ts` is the canonical public copy. Any new provider, storage
  purpose, analytics event or recommender input requires a new notice version
  and matching updates under `docs/privacy/` before deployment.

## UI13 - resilient self-hosted portraits - DONE 2026-08-09

**Built:** `migrations/016_verified_portrait_urls.{up,down}.sql`, safe failed-
refresh handling in `scripts/sync_politician_profiles.py`, bounded browser image
retries and eager profile-hero loading in `web/src/App.tsx`, focused tests and
the UI13 runbook/build-plan handoff.
**Tests:** 15 focused profile/migration tests green; direct TypeScript check and
Vite production build green; `python tasks.py test lint typecheck` green (372
passed, 68 deselected, one existing `audioop` warning; lint and strict typing
clean).
**Contracts touched:** none.

**Decisions made:**
- `avatar_source_url` is provenance only. Public `avatar_url` is now either a
  SHA-verified content-addressed Pleni Bunny URL or null.
- A failed mirror refresh preserves a prior verified CDN portrait. With no prior
  mirror it stores null, so the initials fallback appears without a broken
  Riksdagen request.
- The browser retries an image error twice with distinct query parameters.
  Large profile portraits load eagerly; list/feed portraits stay lazy.

**Live result:**
- Migration 016 is applied to production project `nlooigmwuqqhhnontlgp`.
- Anonymous production reads return 210 politicians: 208 Bunny portrait URLs,
  zero external avatar URLs and two null fallbacks.
- All 208 Bunny objects returned HTTP 200 with an image content type. Riksdagen
  returns 404 for every checked portrait size for Benjamin Dousa and Johan
  Britz, so their honest fallback remains initials until an official image is
  published and mirrored.

**Blocked / needs a decision:**
- none.

**Next agent should know:**
- Do not put `avatar_source_url` back into the public image path. Re-run
  `python scripts/sync_politician_profiles.py` when Riksdagen publishes either
  missing portrait; the content-addressed mirror will replace the fallback.

## UI14.0 — mobile app UX and PWA scope registration — DONE 2026-08-11

**Built:** registered UI14 in `docs/BUILD_PLAN.md` and linked its ordered detailed
source of truth, `docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md`.
**Tests:** documentation review and scope comparison; no runtime code changed.
**Contracts touched:** none.

**Decisions made:**
- `docs/BUILD_PLAN.md` remains the mandatory chunk registry. The dedicated UI14
  plan owns subchunk status, narrow file scopes, caching rules, acceptance gates
  and sequential-agent handoffs.

**Blocked / needs a decision:** none.

**Next agent should know:** UI14.1 is complete in the following handoff. Start
with UI14.2; do not repeat manifest or icon work.

## UI14.1 — manifest, install metadata and icons — DONE 2026-08-11

**Built:** `web/public/manifest.json`; 192×192 and 512×512 `any` launcher
icons; a safe-zone-aware 512×512 maskable icon; a 180×180 Apple touch icon;
documented icon sources/colors; manifest, Apple launch and static theme metadata
in `web/index.html`; and focused PWA asset contract tests.
**Tests:** 4 focused PWA tests passed. TypeScript and the Vite production build
passed. `python tasks.py test lint typecheck` is green: 379 passed, 68 deselected,
one existing `audioop` warning; lint and strict typing clean. A production preview
served the manifest as `application/manifest+json` and every icon as `image/png`,
all with HTTP 200.
**Contracts touched:** none.

**Decisions made:**
- Retained the existing favicon mark and exact warm-white, black and blue palette;
  no new logo was invented.
- Launcher assets use an edge-to-edge warm-white field so platform masks do not
  reveal transparent corners. The maskable symbol is scaled to 76% around centre.
- Manifest identity, start URL and scope are `/`; display is `standalone`; launch
  and static theme colors are feed-dark; no orientation lock was added.
- Pinch zoom remains enabled. iOS receives explicit app title/capability metadata
  and a dedicated Apple touch icon.

**Observations (not fixed, out of scope):**
- Dynamic light/dark browser chrome belongs to UI14.4. UI14.1 intentionally uses
  the dark feed color as the static startup fallback.
- Installed-device icon rendering remains part of the mandatory UI14.6 device
  matrix; the source PNGs and maskable safe zone were visually inspected locally.

**Blocked / needs a decision:** none.

**Next agent should know:** start UI14.2. Do not modify the feed/player or visual
styles. Add the explicit service worker and bounded caching exactly as specified
in `docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md`.

## UI14.2 — service worker and bounded app-shell caching — DONE 2026-08-11

**Built:** exact-pinned `vite-plugin-pwa==1.3.0`; explicit post-load registration
and waiting-update lifecycle in `web/src/pwa/register.ts`; a repo-owned TypeScript
service worker in `web/src/sw.ts`; `injectManifest` production configuration; and
`web/scripts/verify-pwa-build.mjs` for static and executable worker-policy checks.
**Tests:** TypeScript and the Vite production build passed. The built worker
precached 9 app-shell entries (513.75 KiB). The verifier passed install, activate,
selective cleanup, offline navigation, cache-first shell delivery, media/Range/
cross-origin/mutation bypass and message-only activation. `npm audit` reports zero
vulnerabilities. `python tasks.py test lint typecheck` is green: 379 passed, 68
deselected, one existing `audioop` warning; lint and strict typing clean. A local
production preview served `/sw.js` with HTTP 200.
**Contracts touched:** none.

**Decisions made:**
- Use `injectManifest` with an unminified classic worker so the exact cache policy
  and injected asset list remain build-verifiable.
- Derive each `pleni-precache-*` name from the injected manifest. A waiting worker
  therefore cannot overwrite the active worker's shell cache; old Pleni caches are
  deleted only when the new worker activates.
- Cache only same-origin build assets. Navigation is network-first with the
  precached `index.html` as offline fallback. Revisioned shell assets are cache-first.
- Cross-origin requests, video/audio, MP4/HLS/WebM, HTTP Range, non-GET, Supabase,
  Clerk and Bunny remain network/browser-cache owned. Public portrait/poster
  runtime caching is deferred until value and opaque-cache quota are measured.
- Updates never call `skipWaiting()` during install. UI14.3 can activate a waiting
  worker only through the exported viewer-action message.
- `vite-plugin-pwa` installation exposed Vite/PostCSS's transitive vulnerable
  `nanoid==3.3.16`; the lock now resolves compatible patched `3.3.18`.

**Observations (not fixed, out of scope):**
- A deployment-style `npm ci` in the active Windows tree hit `EPERM` while replacing
  Vite's loaded native Rolldown binary. `npm install` restored the dependency tree;
  the exact lock, audit, TypeScript, production build and verifier are green. The
  InstaPods clean Linux install is a different condition and retains its normal
  deployment validation gate.
- UI14.2 exposes lifecycle state/events but deliberately adds no install, offline
  or update UI. Those surfaces belong to UI14.3.

**Blocked / needs a decision:** none.

**Next agent should know:** start UI14.3. Consume the exported PWA lifecycle helpers
without changing cache policy. Installation and update prompts must remain quiet,
dismissible and safe around playback/comment drafts.

## UI14.3 — install, update, offline and standalone experience — DONE 2026-08-11

**Built:** typed standalone/iOS compatibility helpers; tap-only Chromium install
handling; concise iPhone/iPad Safari Home Screen guidance in Profile; dismissible
offline and waiting-update surfaces; and safe update deferral around playing video
and non-empty comment drafts.
**Tests:** TypeScript, Vite production build and the PWA verifier are green. The
verifier retains 9 app-shell entries with no video/private-data cache.
`python tasks.py test lint typecheck` is green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean. Production-preview mobile
browser exercises covered Chromium prompt dismissal, iOS manual guidance,
standalone hiding, offline dismissal, overlay geometry and update deferral/release.
**Contracts touched:** none.

**Decisions made:**
- Installation stays one quiet Profile group and is hidden when unsupported, not
  eligible, dismissed for the session, newly installed or already standalone.
- iOS manual instructions are limited to mobile Safari; no automated prompt is
  implied where the platform does not provide one.
- A worker can activate only after a viewer taps Update. Reload still waits for the
  browser's controller-change event and for both playback and comment drafts to be
  safe. Existing player/comment ownership was not changed.
- Browser connectivity is only a hint; a rejected catalogue request also drives
  the honest network-failure message.
- Normal browser and standalone launches share routing and product behavior.

**Observations (not fixed, out of scope):**
- Physical iPhone/Android installation, installed safe-area rendering and an actual
  deployed waiting-worker takeover remain in UI14.6's real-device/release matrix.

**Blocked / needs a decision:** none.

**Next agent should know:** start UI14.4. Preserve the UI14.3 lifecycle and status
surfaces while adding only the scoped theme, input, touch and sharing polish.

## UI14.4 — mobile browser and interaction polish — DONE 2026-08-11

**Built:** dynamic dark/light browser theme synchronization in
`web/src/pwa/theme.ts`; mobile-safe 16 px search and comment inputs; scoped touch,
selection, overscroll and pressed-state rules; and a working feed Share action with
native Web Share, canonical Pleni clip links, clipboard fallback, quiet cancellation
and accessible success/failure feedback.
**Tests:** TypeScript and the Vite production build passed. The PWA verifier remains
green with 9 app-shell entries and no video/private-data caching.
`python tasks.py test lint typecheck` is green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean. `git diff --check` passed.
Production-preview checks at 390×844 covered a coarse pointer and touch input,
keyboard-only focus, reduced motion, dark/light theme changes, 16 px inputs,
reading/form text selection, overscroll containment, all share outcomes, and exact
shared-link landing. The temporary share labels were visually checked in the feed.
**Contracts touched:** none.

**Decisions made:**
- Shared URLs use the existing person-clips route when a stable politician id is
  available and the existing party-clips route otherwise. Both carry the clip id
  and reopen the exact clip; neither exposes a Bunny media URL or changes routing.
- A viewer-cancelled native share remains silent and does not unexpectedly copy to
  the clipboard. Successful native share, successful copy and total failure receive
  distinct short labels and accessible status text.
- `touch-action: manipulation` is limited to discrete controls. Feed/video surfaces
  explicitly keep `pan-y pinch-zoom`; progress keeps `touch-action: none` for its
  established scrub ownership.
- Press feedback is a 90 ms opacity/scale response. Reduced-motion mode removes the
  scale and transition while retaining immediate opacity feedback.
- No keyboard/VisualViewport workaround was added because the current safe-area and
  fixed-surface CSS produced no reproducible failure in the production preview.

**Observations (not fixed, out of scope):**
- Dynamic browser chrome, focus zoom, platform double-tap behavior, installed safe
  areas, native share sheets and clipboard permissions still require physical iOS
  and Android coverage in UI14.6.

**Blocked / needs a decision:** none.

**Next agent should know:** start UI14.5. Isolate feed rendering and add adaptive
next-video loading without changing feed order, autoplay/mute ownership, seek
semantics, media windows, or UI14.4's sharing and gesture behavior.

## UI14.5 — feed render isolation and adaptive next-video loading — DONE 2026-08-11

**Built:** a per-row `FeedItemRow` media clock in `web/src/App.tsx`, so active
progress no longer rebuilds every catalogue row; last-direction prediction for one
next neighbor; and the typed, optional Network Information helper
`web/src/feed/network.ts`, with conservative Safari/unknown, Save-Data and 2G
behavior.
**Tests:** TypeScript, the Vite production build and the PWA verifier passed. The
verifier retains 9 app-shell entries and no video/private-data cache.
`python tasks.py test lint typecheck` is green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean. `git diff --check` passed.
**Contracts touched:** none.

**Measured production result (390×844 Chromium, cache disabled, reported 4G):**
- Fresh Bunny media/image requests stayed 7 → 7: four thumbnails, one portrait,
  the active MP4 and one neighboring MP4.
- Source attachments stayed 2 at the top and 3 in the middle; posters stayed 4
  and 7; exactly one video played.
- Five baseline progress commits rebuilt the inline 60-row map. Five final commits
  performed work in only the active `FeedItemRow`: 60 → 1 rows per tick.
- Active-state commit to first rendered frame improved from an 81.3 ms upper
  median to 69.9 ms over the first three consecutive downward transitions.
  Play-to-frame improved from 27.6 ms to 20.8 ms over the same sample.
- A strong touch fling advanced exactly one 844 px item. Visual output, safe layout
  and the bottom navigation were unchanged.

**Decisions made:**
- High-frequency current-time and duration state belongs to the row. Media refs,
  active ownership, autoplay/mute fallback, stale-play generation, visibility,
  looping, seeking and comments remain in `FeedScreen`.
- The active clip is always `preload="auto"`. Only the predicted next neighbor may
  also be `auto`, and only when the browser explicitly reports Save-Data off plus
  effective 3G/4G. Missing information, Save-Data, 2G and slow-2G stay metadata.
- Direction is committed with the active-index movement. Forward motion makes the
  next row eager; reversing makes the previous row eager and returns the abandoned
  direction to metadata.
- Video stays browser/HTTP-Range owned. No manual MP4 fetch, blob cache or service
  worker media rule was introduced.

**Regression matrix:** production-preview checks passed autoplay muted fallback,
first-tap audio unlock, viewer mute persistence, surface pause/resume, 70% scrub,
explicit end/loop restart, comments pause/resume, canonical sharing, hidden-page
pause/resume, detached-video pause, direction reversal, request windows and the
one-playing-video invariant. Unknown connection, Save-Data, 2G, strong 4G and a
live strong→Save-Data change all selected the expected preload policy.

**Observations (not fixed, out of scope):**
- CDP transport throttling changes bandwidth but did not update Chromium's
  `navigator.connection` values. The optional hint branches were therefore tested
  by deterministic runtime substitution; physical Data Saver behavior belongs to
  UI14.6.
- First-frame callbacks vary by roughly one 60 Hz frame even with decoded media.
  Repeated matched transitions were used instead of a single favorable sample.

**Blocked / needs a decision:** none.

**Next agent should know:** start UI14.6. Complete the physical iPhone/Android
browser and installed-mode matrix, real native share/install/update behavior,
deployment verification and the bad-service-worker rollback drill. Do not redesign
the feed or widen media windows unless a reproduced device failure requires it.

## UI14.6 — real-device acceptance, release, and rollback — DONE 2026-08-11

**Built:** the frontend PWA release, preferred corrected-worker rollback and
emergency unregister procedures in `docs/RUNBOOK.md`; a locally rehearsed rollback
path; and the detailed pre-release/device evidence ledger in
`docs/MOBILE_APP_UX_PWA_IMPLEMENTATION_PLAN.md`; production release `968749e`; and
the host-MIME correction `235227c`. Controlled worker-only release `21b0bd7`
changes the worker/cache identity for physical installed-update acceptance without
changing the player or UI. Second worker-only release `6b35faf` isolates comment-
draft protection. No host configuration was changed.
**Tests:** the exact isolated release tree passed a clean `npm ci` with zero audit
vulnerabilities, TypeScript, the Vite production build, `verify-pwa-build.mjs` and
`python tasks.py test lint typecheck`: 372 passed, 68 deselected, one existing
`audioop` warning; lint and strict typing clean. The complete mixed working tree is
also green at 379 passed. The emergency worker snippet passed a standalone strict
TypeScript compile. `git diff --check` passed.
**Contracts touched:** none.

**Local acceptance (Chrome 151.0.7922.108, Windows, 390×844 production preview):**
- Shared-link launch, exact deep hash and browser Back passed. Search input computed
  to 16 px. The feed and bottom navigation ended at the stable 844 px viewport.
- The 60-row feed attached two video sources and four posters at the top; exactly
  one video played. Custom controls, inline/vendor-inline playback, disabled PiP
  and disabled remote playback were present on every video.
- Ten strong touch swipes stopped at exact 844 px increments through 8440 px, one
  clip per swipe with one playing video after every transition.
- Manifest, worker and app shell installed locally under scope `/`. Cache Storage
  held nine same-origin shell URLs and no MP4, Range, Bunny, Supabase or Clerk
  response. Offline transport reloaded the controlled cached shell; the offline
  platform event exposed the honest Pleni status.
- A same-scope corrected worker reached waiting state while one video played. The
  controller/document stayed unchanged until playback was paused and the explicit
  activation message produced controller takeover.
- The emergency worker took over without reloading the playing document, removed
  only `pleni-` caches, retained a deliberate unrelated cache, posted its recovery
  message and unregistered. Restoring the known-good build and reopening the same
  profile restored an activated normal worker and bounded shell cache.

**Decisions made:**
- Keep UI14.6 regression-only. No visual/player changes were justified by the local
  evidence; the frontend skill was used to preserve the existing full-bleed video
  hierarchy and interaction model rather than introduce release-phase redesign.
- The normal same-scope waiting-worker update is the preferred rollback. The
  emergency worker is a production incident tool only: it skips waiting, has no
  fetch handler, never reloads clients, deletes only `pleni-` caches and unregisters
  itself. A viewer reloads/relaunches only after playback/draft activity is safe.
- Emulation and headless Chrome results are preflight evidence, not substitutes for
  any row in the mandatory physical-device matrix.

**Release observations:**
- `https://pleni.se/` returned 200 before release, while the new manifest, worker
  and four launcher icon URLs all returned 404. That was the expected pre-release
  state before the UI14 worktree was pushed.
- The first production release, `968749e`, served the app, worker and icons, but
  exposed a host-specific installability defect: InstaPods returned
  `manifest.webmanifest` as `application/octet-stream`. UI14.6 reproduced and fixed
  it by linking the equivalent `/manifest.json`, which receives the standard JSON
  MIME mapping. Corrective commit `235227c` is live and verified.
- A fresh live production profile loaded `/manifest.json` as `application/json`,
  installed an activated controller at scope `/`, precached nine same-origin shell
  URLs and cached no video/private origin. The feed retained two sources, four
  posters, one playing video and a bottom nav flush to the 844 px viewport, with no
  runtime exception.
- Chrome transport-offline emulation reloaded the cached shell but did not emit the
  same connectivity event as a device radio transition. The status surface passed
  with the browser `offline` event; actual lost/restored-network behavior remains
  in the physical matrix.
- The owner confirmed that the deployed app works on their phone and that they
  could download controlled update `21b0bd7` on a Samsung device. This confirms
  real-device delivery of the first installed-update build. The exact model,
  OS/browser, launch mode and playback/takeover observations were not captured and
  remain recorded coverage gaps in the closeout below.
- Controlled worker-only commit `6b35faf` is the latest Samsung acceptance build.
  Its distinct worker/cache identity exercises safe update delivery while leaving
  video, feed, navigation and data behavior unchanged.

**Owner closeout decision:**
- The owner confirmed the Samsung installed/update flow worked and directed the
  mobile release to close. UI14.6 and UI14 are DONE at production state `8b6abd1`,
  with worker acceptance release `6b35faf`.
- The exact Samsung model, Android/browser versions and granular scenario results
  were not captured. iPhone Safari, iOS Home Screen, normal Android Chrome and
  Samsung Internet remain explicitly unverified, owner-accepted post-release
  compatibility coverage gaps. None is represented as a pass.

**Blocked / needs a decision:** none.

**Next agent should know:** the mobile UX/PWA release is closed. Do not begin C12
until the owner provides new instructions. If a device-specific defect is later
reported, reproduce it and reopen a narrowly scoped UI follow-up rather than
silently changing this completed acceptance record.

## UI14 follow-up - Pleni favicon and install artwork - DONE 2026-08-12

**Built:** replaced the former black-T placeholder with the owner-supplied Pleni
artwork across the browser favicon, Apple touch icon, PWA 192 px icon, PWA 512 px
icon and maskable icon. Stored the original 1254 px source at
`web/public/brand/pleni-logo.png` for future download pages and app-store exports.
Updated `web/index.html`, `web/vite.config.ts` and the icon asset notes.
**Tests:** TypeScript, Vite production build and `verify-pwa-build.mjs` passed.
The verified service worker remains at exactly 9 same-origin app-shell entries
with no video/private data. `python tasks.py test lint typecheck` is green:
379 passed, 68 deselected, one existing `audioop` warning; lint and strict typing
clean.
**Contracts touched:** none.

**Decisions made:**
- Used the supplied favicon package without redesigning the mark so its tested
  small-size spacing is preserved.
- Kept the supplied 512 px safe-margin image for both the normal and maskable PWA
  declarations. Its opaque field reaches every edge and its mark remains within
  the maskable safe area.
- The full-resolution brand source and the redundant 16 px favicon are distributed
  with the site but excluded from offline precaching; the 32 px favicon remains in
  the established nine-entry shell.

**Observations (not fixed, out of scope):** existing installed copies may retain a
launcher icon briefly until Android refreshes the PWA metadata or the app is
reinstalled. The stable manifest icon URLs are intentionally unchanged.

**Blocked / needs a decision:** none.

**Next agent should know:** the favicon and install artwork are released through
`main`. Preserve `/manifest.json` and the existing stable icon URLs.

## UI14 follow-up - installed-icon refresh and clear update restart - DONE 2026-08-12

**Built:** versioned Android/PWA, maskable and Apple icon filenames and updated
their manifest/HTML declarations; retained the stable Pleni app id, start URL and
manifest location. The deferred update notice now explicitly says Pleni will
restart, and a successful controller takeover leaves a session-scoped marker so
the reloaded app confirms completion for five seconds. Extended the PWA build
verifier and `tests/unit/test_pwa_assets.py` to enforce the versioned icon contract
and shipped update copy.
**Tests:** TypeScript, Vite production build and `verify-pwa-build.mjs` green. The
worker still precaches exactly 9 same-origin shell entries with no video/private
data. `python tasks.py test lint typecheck` green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean.
**Contracts touched:** none.

**Decisions made:**
- Icon content changes must use new filenames. Chrome 144+ treats an unchanged
  manifest icon URL as unchanged artwork, even if the bytes at that URL changed.
- The existing service-worker safety boundary remains: activation waits for video
  playback and comment drafts, then reloads only after controller takeover.
- The frontend skill kept the existing quiet status surface. Copy now explains
  the restart and confirms completion instead of adding a larger modal or new
  animation.

**Observations (not fixed, out of scope):** the new icon URL lets supporting
Android WebAPK browsers detect the metadata change, but some browsers/platforms
may still require their own review prompt, delayed metadata refresh or reinstall.

**Blocked / needs a decision:** none.

**Next agent should know:** increment the icon filenames and update the manifest,
Apple link, verifier and asset test together whenever install artwork changes.

## UI14 follow-up - automatic pause and minimal update progress - DONE 2026-08-12

**Built:** tapping `Uppdatera` now pauses all playing videos immediately, shows a
minimal 2 px progress line for exactly two seconds, activates the already-downloaded
waiting worker, restarts once and retains the existing five-second success notice.
An unsent comment still blocks activation; playback pauses, and the flow resumes
automatically after the draft is cleared. Updated the production PWA verifier to
require the shipped copy and two-second progress treatment.
**Tests:** TypeScript, Vite production build and `verify-pwa-build.mjs` green. The
worker still precaches exactly 9 same-origin shell entries with no video/private
data. `python tasks.py test lint typecheck` green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean.
**Contracts touched:** none.

**Decisions made:**
- An explicit Update tap authorizes Pleni to pause playback; viewers no longer
  need to pause the video themselves.
- The two-second line is a deliberate transition, not byte-download progress. The
  update prompt is only shown once the replacement worker has already installed.
- Kept the existing small notice and one brand-blue line. Reduced-motion mode
  removes the fill animation while preserving the same safe update timing.
- Comment drafts remain the only normal deferral after Update is tapped.

**Observations (not fixed, out of scope):** users controlled by the preceding
worker will receive one more update prompt for this interaction release.

**Blocked / needs a decision:** none.

**Next agent should know:** preserve the automatic pause, comment-draft guard,
two-second visual transition, controller-change wait and post-reload confirmation
as one update lifecycle.

## UI14 follow-up - persistent reinstall entry - DONE 2026-08-12

**Built:** Profile now always shows `Installera Pleni` in normal browser mode and
hides it only in actual standalone mode. When `beforeinstallprompt` is available,
the row opens Android/Chromium's native installer. Otherwise the same row expands
a compact three-step browser-menu guide covering `Installera app` and `Lagg till
pa startskarmen`; the existing Safari-specific guide remains. Removed the
session-only installed/dismissed flags that made the row disappear after an app
was deleted without notifying the open tab. The build verifier now requires the
manual-fallback copy in the production bundle.
**Tests:** TypeScript, Vite production build and `verify-pwa-build.mjs` green. The
worker still precaches exactly 9 same-origin shell entries with no video/private
data. `python tasks.py test lint typecheck` green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean.
**Contracts touched:** none.

**Decisions made:**
- Browser display mode, rather than a stale session flag, owns whether the App
  group is visible.
- Pleni uses the native installer only from a captured browser event; when that
  event is unavailable, the persistent row gives honest manual instructions.
- The frontend skill kept the fallback inside the existing App group instead of
  adding another banner, modal or permanent explanatory block.

**Observations (not fixed, out of scope):** browser menu labels vary across Android
browsers, so the guide includes both common Swedish labels.

**Blocked / needs a decision:** none.

**Next agent should know:** never gate the Profile install entry solely on
`beforeinstallprompt`; a manual browser-menu fallback must remain available in
all non-standalone sessions.

## UI14 follow-up - mode-specific update delivery - DONE 2026-08-12

**Built:** normal browser sessions now activate a waiting service worker silently
without pausing playback, reloading the current page or rendering update UI. The
small Update button, automatic video pause, two-second progress line, controlled
restart and completion confirmation remain exclusive to actual standalone mode.
`PwaStatusStack` independently gates the update surface on standalone mode while
continuing to show honest offline/network notices in either mode.
**Tests:** TypeScript, Vite production build and `verify-pwa-build.mjs` green. The
worker still precaches exactly 9 same-origin shell entries with no video/private
data. `python tasks.py test lint typecheck` green: 379 passed, 68 deselected, one
existing `audioop` warning; lint and strict typing clean.
**Contracts touched:** none.

**Decisions made:**
- The installed PWA owns explicit update interaction because it has no browser
  refresh chrome and may remain open as an app.
- The normal website accepts the waiting worker in the background but keeps the
  current document uninterrupted; the new version appears on the next natural
  reload/navigation.
- Both the lifecycle hook and visible status component enforce the mode boundary
  so a state race cannot expose the app-only updater on `pleni.se`.
- The frontend skill removed website update chrome rather than introducing a
  second browser-specific notice.

**Observations (not fixed, out of scope):** an already-open browser document may
continue its loaded version until its next natural reload, by design.

**Blocked / needs a decision:** none.

**Next agent should know:** keep browser updates silent and non-interrupting; only
standalone mode may show or execute the explicit pause/progress/restart flow.

## UI search redesign - modern search and profile flow - DONE 2026-08-12

**Built:** adapted the supplied `Swedish politician TikTok search` design into
`web/src/App.tsx` and `web/src/styles.css`: a calmer search header, 16 px mobile-safe
input, party filter rail, a dedicated factual party destination card above politician
results, roomier result rows, session-only recent searches, refined party/person
profiles, and consistent clip duration badges. No new dependency, font or image asset.
**Tests:** direct TypeScript check and Vite production build green;
`verify-pwa-build.mjs` green with exactly 9 same-origin app-shell entries and no
video/private data; `python tasks.py test lint typecheck` green: 379 passed,
68 deselected, one existing `audioop` warning; `git diff --check` green.
**Contracts touched:** none.

**Decisions made:**
- Kept the existing React routing, Supabase search APIs, party/person data models,
  bottom navigation and shared clip-player handoff. The supplied design changes
  hierarchy and presentation, not data ownership or navigation semantics.
- A matching/selected party is promoted from an ordinary list row to a dedicated
  destination card. Clip and politician totals render only when the existing exact
  counts are available; missing counts remain absent rather than becoming zero.
- Recent searches work within the current app session and can be cleared, but are
  not persisted. Political search terms can reveal sensitive interests, so a visual
  redesign does not silently create a new durable local data store.
- `Populära debatter` remains explicitly labelled as example data because Pleni does
  not yet measure search popularity. The supplied invented trend figures were not
  relabelled as product telemetry.
- The frontend skill shaped the result toward restrained editorial hierarchy:
  Pleni's existing type and neutral palette remain, party colour is confined to
  identity surfaces, cards are used only for destinations/interactions, and motion
  is limited to focus, results entrance and affordance feedback with reduced-motion
  coverage.

**Observations (not fixed, out of scope):**
- Search-popularity measurement remains a future analytics/product decision. Until
  it exists, the example label is load-bearing and must not be removed.
- No physical iPhone/Android device pass was added by this desktop-only redesign.

**Blocked / needs a decision:** none.

**Next agent should know:** keep search terms session-only unless a separate privacy
decision authorizes persistence. Preserve factual count handling and the existing
bounded media behavior when changing the party/person clip grids.

## UI14 follow-up - edge-to-edge Pleni favicon artwork - DONE 2026-08-12

**Built:** recreated the Pleni icon master with the deep blue field reaching all
four canvas edges and the white P centred without the former outer white padding;
published versioned 16/32/ICO browser favicons plus 180/192/512/maskable installed
icons; updated the HTML, manifest, PWA verifier and icon documentation; added a
pixel-level regression test for blue corners and a white central mark.
**Tests:** focused icon tests green (5 passed); direct TypeScript, Vite production
build and `verify-pwa-build.mjs` green with exactly 9 app-shell entries and no
video/private data; `python tasks.py test lint typecheck` green: 380 passed,
68 deselected, one existing `audioop` warning; lint and strict typing clean.
**Contracts touched:** none.

**Decisions made:**
- Used the built-in image editing flow against `web/public/brand/pleni-logo.png`.
  Final prompt: remove the white outer canvas, extend Pleni blue to every edge,
  preserve the distinctive centred white P, and add no border, shadow or text.
- Stored the project master at
  `web/public/brand/pleni-logo-edge-20260812.png`; all runtime sizes are mechanical
  derivatives from that one square source.
- Changed every runtime icon URL to release `20260812b`. Stable icon URLs can keep
  stale artwork in browser/WebAPK metadata caches even when their bytes change.
- Removed the superseded unversioned favicons and `20260812` launcher exports after
  verifying that no source reference still consumes them. They remain recoverable
  from Git history.
- The maskable icon uses the same edge-to-edge blue field; the P itself remains
  inside the platform safe zone, so Android may apply its own shape without exposing
  a white ring.

**Observations (not fixed, out of scope):** installed platforms may still wait for
their normal metadata-review cycle; the new URLs make the artwork change detectable
but cannot force an immediate launcher refresh.

**Blocked / needs a decision:** none.

**Next agent should know:** derive future favicon and launcher exports from the
edge-to-edge master, increment the release filename, and update HTML, manifest,
verifier and tests together. The corner-pixel regression is load-bearing.

## UI follow-up — coordinated loading skeletons — DONE 2026-08-12

**Built:** adjusted the `Populära debatter` note so its text has balanced top and
bottom breathing room; replaced transient loading labels with layout-matched feed,
search, profile and clip-grid skeletons; coordinated party-profile and politician
search requests behind one readiness boundary so search sections appear together.
**Tests:** direct TypeScript check and Vite production build green;
`verify-pwa-build.mjs` green with exactly 9 same-origin app-shell entries and no
video/private data; `python tasks.py test lint typecheck` green: 380 passed,
68 deselected, one existing `audioop` warning; `git diff --check` green.
**Contracts touched:** none.

**Decisions made:**
- A query is considered ready only when both the politician search and the shared
  party catalogue have settled for the current query/filter key. Results from a
  previous query remain hidden while the current request is pending.
- Skeletons mirror the surfaces they replace instead of adding a generic spinner:
  the immersive feed remains dark, search reserves its party/list geometry, and
  profile/archive clip grids reserve their final three-column layout.
- The frontend skill kept motion subtle and functional. The shimmer is disabled by
  `prefers-reduced-motion`, and all skeletons expose concise loading status to
  assistive technology without announcing their decorative pieces.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Next agent should know:** keep the search readiness key coupled to both data
sources if more result sections are added; otherwise partial-result flashes can
return even though each request is individually race-safe.

## UI follow-up — bounded progressive video loading — IMPLEMENTED 2026-08-12

**Built:** replaced the symmetric ±1 source window with a directional scheduler
that keeps one clip behind, the active clip and the immediate destination, then
stages a second destination after the first is genuinely playable; dynamically
attached sources now receive explicit `load()` and obsolete media is paused,
emptied, reset and unmounted; posters remain until a decoded frame is presented;
the active row shows a restrained indicator only for real `waiting`/`stalled`
events. Added pure policy/lifecycle helpers and dependency-free Node tests.
**Tests:** 6 media scheduler/lifecycle tests green; direct TypeScript check and
Vite production build green; `verify-pwa-build.mjs` green with exactly 9
same-origin app-shell entries and no video/private data; `python tasks.py test
lint typecheck` green: 380 passed, 68 deselected, one existing `audioop` warning;
`git diff --check` green.
**Contracts touched:** none.

**Decisions made:**
- The media window is capped at four source-bearing elements. The second forward
  source is added only after the immediate neighbor reaches playable state, so
  preparation advances without opening the whole 60-row catalogue.
- Missing Network Information API data is normal connectivity. Only explicit
  Save-Data, 2G or slow-2G disables the second look-ahead; the immediate neighbor
  still loads eagerly.
- Source ownership is deterministic: attach sets preload before src and calls
  `load()`; cleanup pauses, removes src and calls `load()` before unmount. Retained
  media is never reloaded when promoted to active, preserving its buffered bytes.
- The browser media element and HTTP Range cache remain the only video transport.
  No blob fetch or service-worker video caching was added.

**Observations (not fixed, out of scope):** the physical Samsung Internet
cold-cache 15-swipe acceptance pass is not possible from this desktop session.

**Blocked / needs a decision:** none for deployment. Physical Samsung Internet
acceptance remains to verify no progressive worsening, at most four `video[src]`
elements, exactly one playing video and no transition stall over 500 ms on strong
Wi-Fi.

**Next agent should know:** `web/src/feed/media-policy.ts` is the source of truth
for window and connection policy. Keep its Node tests and the explicit release
lifecycle when changing feed media behavior.

## UI13 follow-up — automatic portrait convergence — DONE 2026-08-12

**Built:** added one independently retryable `portrait_sync` IO job per newly
published politician, transactionally enqueued by
`migrations/017_politician_portrait_jobs`; extracted the reusable targeted sync
into `src/riksdagen/profile_sync.py`; kept the catalogue-wide operator script as
the periodic refresh; required Bunny's public CDN to verify an already-existing
object before it can be reused; fixed the single-process daemon so a busy first
pool cannot prevent the other pools from being polled. Updated the runbook, build
plan and focused portrait/queue/CDN tests.
**Tests:** focused portrait, migration, queue and Bunny tests green; direct
frontend TypeScript, production Vite build and PWA verification green with 9
same-origin shell entries and no video/private caching; `python tasks.py test
lint typecheck` green: 397 passed, 68 deselected, one existing `audioop` warning;
lint and strict typing clean on 82 source files; `git diff --check` green.
**Contracts touched:** none.

**Root cause confirmed:** the 208 portraits mirrored on 2026-08-09 were healthy,
but portrait sync remained a manual whole-catalogue command. Later C11 publishes
added 36 politicians without running it. This left 46 of 738 live clips and 9 of
the current top 60 on initials even though every affected official JPEG existed.
All five frontend politician surfaces already used the same avatar component;
the service worker, Bunny CORS/cache headers and retry URLs were not the fault.

**Production result:**
- Target-synced all 36 missing rows. Every one downloaded as a valid official
  JPEG, uploaded to its immutable `portraits/<intressent_id>/<sha256>.jpg` path
  and became public only after Bunny verification.
- Production now has 246 politician rows: 244 verified Bunny portraits, zero
  unsynchronised profiles, zero external Riksdagen avatar URLs and two honest
  initials fallbacks. Johan Britz and Benjamin Dousa explicitly publish
  `HarBild=false`; their absent photos are expected and do not fail a job.
- Downloaded all 244 public portraits after the repair. Every response was HTTP
  200 `image/jpeg`, every JPEG envelope was valid and every downloaded SHA-256
  matched both Supabase and the content-addressed URL.
- Zero published clips now belong to a politician without an available portrait;
  the top-60 missing count is also zero. Both migration-backfill maintenance jobs
  completed, no portrait jobs remain queued/running/dead, and the production
  trigger is enabled.

**Decisions made:**
- Portrait work remains outside the numbered video chain and runs at priority
  -100 in the IO pool. A Riksdagen/Bunny outage retries only that politician and
  cannot roll back or block clip publication.
- Explicit `HarBild=false` or an official portrait 404 is a successful no-photo
  outcome. It refreshes profile metadata, retains a prior verified mirror if one
  exists, otherwise leaves the deterministic initials fallback.
- An unchanged hash still goes through the Bunny uploader's public verification
  path; matching database state alone is not proof that the CDN can serve it.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Next agent should know:** migration 017 is applied to production. New C11
politician inserts enqueue `portrait_sync:<intressent_id>:v1` automatically. Keep
that job standalone and low priority; use `scripts/sync_politician_profiles.py`
for occasional whole-catalogue metadata and changed-photo refreshes.

## UI13 follow-up — stable portrait remounts — DONE 2026-08-12

**Built:** replaced Avatar's passive URL reset with a source-keyed image child;
added a page-session success registry for immutable Bunny portrait URLs; detects
already-complete cached images during layout; preserves bounded retries, exact-URL
invalidation and initials fallback across real Search/Following unmounts. Added
dependency-free portrait lifecycle tests and made CI run the complete web test set.
**Tests:** 6 portrait lifecycle tests and 6 progressive-media tests green; direct
TypeScript, Vite production build and PWA verification green with exactly 9
same-origin shell entries and no video/private caching; `python tasks.py test lint
typecheck` green: 397 passed, 68 deselected, one existing `audioop` warning; strict
typing clean on 82 source files; `git diff --check` green.
**Contracts touched:** none.

**Root cause confirmed:** Search and Following are mutually exclusive route
branches, so switching tabs destroys every Avatar. A cached JPEG could fire
`load` on the new instance before React flushed Avatar's passive mount effect.
The load handler made the image visible, then the effect reset `imageLoaded` to
false; no second load event existed, so CSS kept a healthy image at opacity zero.

**Decisions made:**
- URL changes now reset synchronously through the keyed `AvatarImage` lifecycle;
  no delayed effect is allowed to overwrite a successful cached load.
- A successful display URL is remembered only for the current page session. This
  survives component remounts without persisting search/follow activity.
- Later errors conditionally remove only the exact failed cached URL, so a stale
  error cannot erase a newer retry success. Every new lifecycle receives two
  fresh retry URLs even if an earlier lifecycle succeeded on a retry.
- Native lazy loading remains for ordinary list/feed portraits, but a synchronous
  `complete && naturalWidth > 0` check makes correctness independent of receiving
  another cached-image load event. The profile hero remains eager/high-priority.

**Observations (not fixed, out of scope):** no physical-phone automation was
available in this desktop session; the exact unmount/remount and cached-complete
states are covered by dependency-free regression tests.

**Blocked / needs a decision:** none.

**Next agent should know:** keep portrait success state keyed by the canonical
immutable source URL. Do not reintroduce a passive mount reset or make cached
image visibility depend solely on a future `load` event.

## F2a/F3a — explicit-interest rule feed — IMPLEMENTED, INACTIVE 2026-08-14

**Built:** migrations 018/019 add a non-exposed `private` schema, append-only
versioned personalisation consent, explicit party/politician preferences, and an
idempotent served-slate envelope. Added Clerk RS256/JWKS verification, strict
origin checks, Svix-verified Clerk deletion, consent/feed Edge Functions, and a
deterministic rule ranker. The React app now sends onboarding party choices and
followed parties/politicians only after a server-confirmed grant, requests the
server order for `För dig`, cancels stale requests, shows reason labels, deletes
preferences on withdrawal, and falls back to `Senaste` on failure. Onboarding is
now two steps; the unused left/right page and its stored field were removed, and
legacy `leaning` values are ignored. The complete slice is behind
`VITE_RECOMMENDATIONS_ENABLED=false`; no migration or function was deployed and
no real viewer data was collected.

**Tests:** 19 dependency-free Edge tests green (mixer, date freshness, quality
prior, seen suppression, diversity/cap relaxation, deterministic fallback,
Clerk signature/issuer/expiry/authorized-party/key rotation, Svix tamper/age);
15 complete web tests green; strict TypeScript checks green for web and Edge;
production Vite build green; PWA verifier green with exactly 9 app-shell entries
and no video/private caching; 6 recommendation migration guard tests green;
full Python test phase green: **403 passed, 68 deselected**, one existing
`audioop` warning; strict mypy green on 82 source files; focused new Python lint
green; `git diff --check` green. The combined `python tasks.py test lint
typecheck` stopped after the green test phase because the pre-existing untracked
`scripts/_publish_2026_jan_apr.py` has an unsorted import block. That user-owned
file was preserved unchanged.

**Contracts touched:** none.

**Decisions made:**
- Rule V1 uses only parties explicitly selected in onboarding and followed
  parties/politicians. Likes, saves, watch history and inferred interests never
  leave the device in this slice. The left/right onboarding question was removed;
  no ideological-to-party mapping has been approved.
- The explainable score weights explicit interest, freshness from
  `sources.debate_date`, and `rank_in_speech`; raw cross-speech C7
  `final_score` is never compared. Backfills do not become new because they were
  recently published.
- The planned first-ten mix is five fresh-interest, two fresh-general, two older
  matching-interest and one adjacent slot. Because V1 has no reviewed adjacency
  taxonomy and exploration is disabled, the final slot falls back
  deterministically and records that fallback instead of relabelling an old
  unrelated clip as adjacent.
- The slate has a hard two-clips-per-speech ceiling, soft speaker/party caps,
  adjacent-speaker suppression and deterministic sparse-inventory relaxation.
  Recently served clips are suppressed for 30 days while unseen inventory is
  sufficient.
- Browser roles have no private-schema access or RPC execution. Edge Functions
  derive the Clerk subject exclusively from a verified token and use the service
  role only after that boundary. A consent recheck and slate insert occur in one
  database function, so withdrawal wins over an in-flight request.

**Observations (not fixed, out of scope):** the Browser control surface was not
available in this desktop session, so no interactive visual pass was possible;
the TypeScript/build/PWA and component-level checks completed. The owner reports
more than 3,000 clips, but party/speaker/date distribution still needs a
committed readiness measurement before closing Q-1.

**Blocked / needs a decision:** production activation remains blocked on the
explicit F0 owner approval, retention periods/jobs, access audit, subject
export/reset/delete workflows, a real-Postgres RLS/grant/idempotency/deletion
matrix, deployment of both migrations and all three functions, Clerk webhook
configuration, and controlled mobile QA. Full F2 playback telemetry and ML data
collection remain deliberately unbuilt.

**Next agent should know:** deploy migrations 018 then 019 and the
`consent`, `feed-requests` and `clerk-webhook` functions as one gated release;
configure exact `CLERK_ISSUERS`, `ALLOWED_ORIGINS` and
`CLERK_WEBHOOK_SIGNING_SECRET`; validate in staging/real Postgres; update the
public privacy notice; only then set `VITE_RECOMMENDATIONS_ENABLED=true` for a
controlled build. Do not enable the flag against an undeployed schema. Do not
add playback telemetry or learned ranking under this slice.

## UI14 follow-up — stale app-shell recovery — DONE 2026-08-14

**Built:** navigation requests handled by the service worker now bypass the
browser HTTP cache while keeping the existing precached shell as the offline
fallback. Bumped the worker release namespace and extended the production PWA
verifier to fail if online navigation can reuse cached HTML.
**Tests:** 15 web tests green; strict TypeScript green; Vite production build
green; PWA verifier green with 9 app-shell entries, no video/private caching,
and the new online-navigation cache assertion; `git diff --check` green.
**Contracts touched:** none.

**Root cause:** the static host serves `index.html` without `Cache-Control` and
the deploy command removes the previous hashed assets before copying the new
build. The worker's network-first navigation used the request's default HTTP
cache mode, so an existing browser could receive an older HTML shell after its
old precache had been deleted. That shell referenced a removed JavaScript asset,
leaving an empty root and a white screen. A fresh mobile-sized browser rendered
the deployed feed normally, confirming that the current bundle itself loads.

**Decisions made:** online app-shell navigation uses `cache: "no-store"`; media,
Supabase, Clerk and offline behavior remain unchanged. Viewer-controlled worker
activation remains intact.

**Blocked / needs a decision:** the InstaPods build remains non-atomic. Keeping
the previous hashed asset directory until the new build is fully copied would
remove the brief deployment race as well, but that setting lives outside this
repository.

## F2b — Recommendation launch controls — DONE 2026-08-14

**Built:** migration 020 adds a current versioned notice, authenticated JSON
export, recommendation reset, recommendation deletion support and a daily
retention job. The consent Edge Function exposes those service-only workflows;
Profile provides real export/reset/delete controls; onboarding and the Swedish
privacy notice now describe the active rule feed and its fixed periods. The
release defaults on after backend deployment, with an explicit
`VITE_RECOMMENDATIONS_ENABLED=false` remaining as the emergency kill switch.

**Production deployment:** migrations 018, 019 and 020 are applied and recorded
in the Supabase migration ledger. `consent`, `feed-requests` and
`clerk-webhook` are deployed with exact Pleni origins and Clerk dev/prod
issuers. Production checks confirm the private schema and recommendation RPCs
are denied to browser roles, the version-2 notice is active, and the daily
30-day slate cleanup job is active. A rollback-only production probe passed
grant, slate recording, export, reset and deletion without retaining test data.

**Tests:** strict TypeScript green; production Vite/PWA build green with nine
shell entries; 19 Edge security/ranking tests green; three web recommendation
tests green; seven migration guard functions green; `git diff --check` green.
The full Python task runner could not run in this desktop runtime because no
project Python environment/pytest installation was available; the dependency-
free migration guards were executed directly with the bundled Python runtime.

**Contracts touched:** none.

**Decisions made:** explicit preferences persist until withdrawal/reset/delete;
served slates persist for 30 days; superseded consent and completed rights-audit
rows persist for 24 months while the newest consent state is retained. The V1
balance policy is the deterministic 5/2/2 mix plus speech/speaker/party caps,
recorded relaxations, per-clip reasons and the complete chronological `Senaste`
alternative. No watch history, likes, saves, playback event, inferred interest,
exploration or ML state is collected.

**Blocked / needs a decision:** the Clerk `user.deleted` webhook endpoint still
needs its dashboard-generated Svix signing secret set as
`CLERK_WEBHOOK_SIGNING_SECRET`; the authenticated browser-control runtime was
not available in this session. Until then, in-app recommendation deletion works
but deleting an account directly in Clerk cannot be claimed to cascade. A
signed-in mobile production acceptance pass is also still required.

**Next agent should know:** endpoint for Clerk is
`https://nlooigmwuqqhhnontlgp.supabase.co/functions/v1/clerk-webhook`, subscribed
to `user.deleted`. After saving its signing secret to Supabase, sign in on
`pleni.se`, grant V2 consent with at least one party, confirm `För dig` shows
reasoned/reranked clips, reload for a distinct slate, then exercise export and
reset. Full playback telemetry and learned ranking remain separate future work.

## F2b follow-up — production consent authentication — DONE 2026-08-14

**Built:** the Clerk Edge verifier now treats the Supabase-specific
`role: authenticated` claim as optional on a session token that has already
passed signature, issuer, authorized-origin, lifetime and subject verification.
A present contradictory role still fails closed. Consent and feed endpoints
write a non-identifying auth rejection code to function logs for future
diagnosis.

**Root cause:** production consent invocations returned 401 before every
database call. The endpoints incorrectly required Clerk's optional Supabase
integration role claim even though the Edge boundary verifies Clerk sessions
itself. That claim exists in the development token captured earlier but is not
part of Clerk's base session-token authentication contract.

**Production deployment:** updated `consent` and `feed-requests` functions were
deployed immediately. No database migration or frontend rebuild is required.

**Tests:** 20 Edge security/ranking tests green, including absent role accepted,
authenticated role accepted and contradictory role rejected; web strict
TypeScript green; `git diff --check` green.

**Contracts touched:** none.

**Blocked / needs a decision:** none for consent authentication. The previously
recorded Clerk deletion-webhook signing-secret task remains separate.

## F2b follow-up — feed refresh and interest editing — DONE 2026-08-14

**Built:** `För dig` is now the default discovery surface for every viewer.
With explicit consent it requests a new server-ranked slate; without consent or
an account it draws a fresh 60-clip shuffle from a 240-clip public candidate
window without creating private viewer data. `Senaste` remains chronological
and is shown only when the viewer selects that tab. A custom top-of-feed
pull-down gesture now requests a new slate and presents visible Swedish refresh
feedback instead of delegating to the browser's disabled page refresh.

Party and politician follow changes now reload `För dig` after their consented
preference projection reaches the server. Saving onboarding choices and editing
selected parties does the same. Profile's `Redigera mina intressen` action now
opens a one-step editor that preserves the existing consent state and never
re-presents the consent prompt.

**Tests:** frontend strict TypeScript green; Vite production/PWA build green
(nine precache entries); 15 frontend Node tests green; 20 Edge
security/ranking/webhook tests green; `git diff --check` green. The default
Python acceptance command could not run in this desktop runtime because its
bundled Python has no `pytest`, `ruff` or `mypy` installed; no Python or pipeline
file changed in this follow-up.

**Contracts touched:** none.

**Decisions made:** anonymous and declined-consent discovery is deliberately
random rather than a disguised copy of `Senaste`; it creates no request history
or recommendation profile. A personalized feed failure also stays on `För dig`
and falls back to the same general shuffle instead of silently changing tabs.
Pull-to-refresh is available only at the top of the main feed, so normal clip
swipes and scoped saved/person/party feeds keep their existing behavior.

**Blocked / needs a decision:** none for these five feed scenarios. The earlier
Clerk account-deletion webhook secret and signed-in production acceptance items
remain separate.

## F2a/F2b follow-up — refresh polish and reason copy — DONE 2026-08-14

**Built:** back-catalog recommendations retain the useful explicit explanation
(`Eftersom du valde/följer …`) without appending `äldre klipp`; the internal
back-catalog pool and `older_*` audit reason code remain unchanged. The
presentation change is recorded as algorithm version `explicit-rules-v1.1`.
Production `feed-requests` was redeployed with the new shared ranker.

Tapping Home now requests a fresh slate through the same path as pull-to-refresh,
including when Home is already active. Manual refresh keeps the current video
mounted while the replacement loads. The pull gesture now moves with the finger,
eases into the armed/loading state, rotates and spins the refresh icon, and
settles back after the new slate is ready; reduced-motion preferences disable
the added transitions.

**Tests:** strict frontend TypeScript and Vite/PWA production build green; 15
frontend Node tests and 20 Edge security/ranking/webhook tests green; the ranker
test now locks the exact back-catalog explanation copy; `git diff --check` green.

**Contracts touched:** none.

**Blocked / needs a decision:** none for this follow-up. The previously recorded
Clerk deletion-webhook secret and signed-in production acceptance items remain.

## F2b follow-up — full-bleed feed skeleton — DONE 2026-08-14

**Built:** the initial feed loader no longer renders a narrow rounded portrait
placeholder in the middle of the screen. Its video placeholder now fills the
complete feed viewport, matching the real 9:16/full-bleed player, with a subtle
composited light sweep behind the existing caption and action-rail placeholders.
Reduced-motion mode disables the sweep.

**Tests:** strict frontend TypeScript, Vite/PWA production build and 15 frontend
Node tests green; `git diff --check` green.

**Contracts touched:** none.

**Blocked / needs a decision:** none.

## F2b follow-up — stable follow interactions — DONE 2026-08-14

**Built:** following or unfollowing a politician/party updates the visible button
and consented server preference projection without replacing, clearing or
scrolling the slate currently being watched. The choice affects the next Home,
pull or normal feed refresh instead. Preference writes settle for 180 ms and run
through a single ordered queue, preventing rapid follow/unfollow taps from
leaving an older request as the final server state.

**Audit:** the remaining immediate feed replacements are intentional: completed
onboarding, saving the explicit interest editor, consent withdrawal/reset/delete,
switching feed mode, and explicit Home/pull refresh. Likes and saves remain local
library updates and do not enter recommendation sync.

**Tests:** strict frontend TypeScript, Vite/PWA production build and 15 frontend
Node tests green; `git diff --check` green.

**Contracts touched:** none.

**Blocked / needs a decision:** none.

## F2a follow-up — unseen-first refresh ranking — DONE 2026-08-14

**Built:** personalized refreshes no longer replay a recently served perfect
interest match merely to satisfy the planned pool for that position. Pool
composition is now a soft goal: any selectable unseen candidate wins before a
clip from the 30-day recent-slate history. Recent clips enter only after unseen
eligible inventory is exhausted, and that relaxation is recorded as
`recent_clip_fallback`. The ranking release is versioned
`explicit-rules-v1.2`.

**Tests:** added the exact regression case of a recent followed-politician match
versus an unseen general clip; the unseen clip now ranks first. All 21 Edge
security/ranking/webhook tests pass and `git diff --check` is green. The default
Python acceptance command could not run because this desktop runtime has no
`python` executable.

**Contracts touched:** none.

**Blocked / needs a decision:** none.

## F2a follow-up — restore full-catalogue feed variety — DONE 2026-08-14

**Diagnosis:** the live catalogue contains 3,188 published clips, but only 19
have debate dates inside the 45-day fresh window. Ebba Busch has 59 published
clips and all 59 are older. V1 filtered every older non-interest clip out, so an
Ebba-only profile had just 78 eligible clips; removing that follow left only 19.
The 60-item served-slate history therefore exhausted the pool almost
immediately and deterministic refreshes repeated it.

**Built:** older general clips again participate in the existing persisted
`adjacent_interest` compatibility pool as deterministic catalogue variety. The
reason is neutral (`För variation i ditt flöde`) with code
`catalogue_variety`; it does not claim a topic/ideology match and keeps
exploration probability at zero. The general candidate window is raised from
700 to the existing 1,000-row database/API ceiling, while the unseen-first rule
still prevents recent matches from winning. Ranking records use
`explicit-rules-v1.3`.

**Tests:** all 21 Edge security/ranking/webhook tests pass, including sparse
fresh inventory, neutral older variety and an unseen old-general clip beating a
recent perfect followed-politician match; `git diff --check` green. The default
Python command remains unavailable because this desktop runtime has no
`python` executable.

**Contracts touched:** none.

**Blocked / needs a decision:** none.

## UI13 follow-up — newest-first profile clip grids — DONE 2026-08-15

**Built:** politician and party profile grids now read from the flattened public
clip catalogue and order by the speech's `debate_date` descending. Upload time
only breaks ties within one debate date, followed by clip id for stable reloads.
This replaces the previous `published_at`-only queries, which allowed a newly
encoded backfill from an older debate to appear above newer parliamentary
material. A shared non-mutating comparator protects the rendered order even if
the API response order regresses.

**Tests:** 16 frontend Node tests green, including a regression where an old
debate uploaded today must remain below a newer debate; strict frontend
TypeScript and the Vite/PWA production build are green with nine precache
entries; real public politician and KD catalogue reads returned descending
debate dates; `git diff --check` green. The default project acceptance command
could not run because this desktop runtime has no `python` executable.

**Contracts touched:** none.

**Blocked / needs a decision:** none.

## F2b follow-up — recommendation reasons are internal-only — DONE 2026-08-15

**Built:** the scrolling video overlay no longer renders algorithm reason tags
such as `Eftersom du följer …` or `För variation i ditt flöde`. The frontend
adapter now discards `reason` and `reasonCode` instead of copying them into the
display `ClipItem`, and the unused pill styling is removed. The Edge response
and private served-slate records retain pool/reason data for internal auditing;
ranking behavior and collection remain unchanged.

**Tests:** 16 frontend Node tests, strict TypeScript and the Vite/PWA production
build are green with nine precache entries. A built-asset check confirms the
reason tag class and tooltip text are absent; `git diff --check` green. The
default project acceptance command remains unavailable because this desktop
runtime has no `python` executable.

**Contracts touched:** none.

**Blocked / needs a decision:** none.

## UI14 follow-up — sound-on feed playback — DONE 2026-08-15

**Built:** feed playback still requests unmuted autoplay first, but a browser's
muted fallback is now scoped to only the clip whose sound-on attempt was
rejected. It no longer changes the viewer's app-wide mute choice. Every newly
active clip retries sound, while an explicit tap on the mute control remains
persistent across clips. Tapping the video or sound control after a
browser-enforced fallback enables audio within that same user gesture.

**Tests:** 17 frontend Node tests green, including the distinction between a
clip-local autoplay fallback and a viewer mute; strict frontend TypeScript and
the Vite/PWA production build are green with nine precache entries;
`git diff --check` green. The default project acceptance command remains
unavailable because this desktop runtime has no `python` executable.

**Contracts touched:** none.

**Blocked / needs a decision:** browser autoplay policy can still reject sound
on a true cold load before any user gesture. In that case Pleni keeps the video
moving muted, shows the sound-off control, and retries sound on the next clip or
enables it immediately on the viewer's first tap.

## UI15 — fast feed snapping — IMPLEMENTED 2026-08-18

**Built:** added a dependency-free Pointer Events controller and pure snap policy
for primary touch/pen gestures; kept one-to-one finger tracking within one
adjacent item; committed on 8%/48 px distance or 0.35 px/ms release velocity;
activated the guaranteed destination on release; settled to its exact boundary
in 140 ms; and made reduced motion immediate. Native wheel, keyboard, deep-link
and unsupported-browser scrolling still use the existing CSS snap fallback. The
first item's downward pull remains owned by the existing refresh interaction.

**Tests:** 8 new snap-policy tests and all dependency-free web tests green;
direct TypeScript check green; Vite production build green; PWA verifier green
with exactly 9 same-origin app-shell entries and no video/private data;
`python tasks.py test lint typecheck` green through the configured Python 3.12
runtime: **397 passed, 68 deselected**, one existing `audioop` warning; lint and
strict typing clean on 82 source files; `git diff --check` green.

**Contracts touched:** none.

**Decisions made:**
- `web/src/feed/snap-policy.ts` owns the thresholds, one-item clamp, exact
  alignment, 140 ms duration and easing. No gesture or animation dependency was
  added.
- CSS disables only browser-owned one-finger vertical panning while the
  controller is supported. Horizontal direct movement and pinch zoom remain
  browser-owned; pull-to-refresh and the progress slider retain their existing
  gesture ownership.
- A committed controlled swipe bypasses the 180 ms observer dwell because its
  destination is guaranteed. The observer remains the activation path for
  wheel, keyboard and programmatic scrolling and cannot race a controlled snap.
- The full-bleed visual hierarchy, controls, sound-on behavior and media
  presentation are unchanged.

**Observations (not fixed, out of scope):** physical iPhone and Android devices
were unavailable in this desktop session, so the live deployment still needs a
real-device feel check by the owner.

**Blocked / needs a decision:** none for deployment. Confirm release-to-alignment
speed, zero residual drift, one clip per gesture, rapid reversal, taps, scrubbing,
pinch zoom and pull-to-refresh on the live phone build.

**Next agent should know:** do not replace the controller with native smooth
scrolling; CSS cannot tune user momentum. Keep `scroll-snap-stop: always` for the
native fallback and keep the media scheduler as the only source-window owner.

## UI15.1 — decoded-frame poster handoff — DONE 2026-08-18

**Built:** removed the video element's duplicate native poster and made the
bounded thumbnail overlay yield as soon as `loadeddata` confirms a decoded
current frame. Immediate and staged destinations now expose their prepared frame
before entering view, while cold or unmounted clips retain the existing bounded
thumbnail fallback. Source scheduling, autoplay, mute behavior and the four-video
ceiling are unchanged.

**Tests:** added a media-policy regression for HTML media ready states; all 26
dependency-free frontend tests green; strict frontend TypeScript green; Vite/PWA
production build green with exactly 9 app-shell entries and no video/private
data; `python tasks.py test lint typecheck` green through Python 3.12: **397
passed, 68 deselected**, one existing `audioop` warning; `git diff --check`
green.

**Contracts touched:** none.

**Decisions made:** the explicit overlay remains the only thumbnail layer. It is
removed at `HAVE_CURRENT_DATA`, when a frame is decoded beneath it, rather than
waiting for a compositor callback after playback starts. This avoids both a
thumbnail flash and a black frame without widening the preload window.

**Observations (not fixed, out of scope):** physical device confirmation remains
with the owner on the live release.

**Blocked / needs a decision:** none.

**Next agent should know:** do not restore a `poster` attribute on the mounted
feed `<video>`; the bounded overlay already owns the cold-load fallback.

## UI16 — verified party logos — DONE 2026-08-19

**Built:** added migration 021, an eight-party official-source registry, strict
PNG validation, exact-byte content hashing, verified content-addressed Bunny
uploads and a repeatable `scripts/sync_party_logos.py` release command. The
frontend now reads `party_profiles.logo_url` and shows the real marks in search,
party profiles, followed-party rows and onboarding. A failed or absent mirror
retains the existing party-coloured letter with no layout shift.

**Tests:** 19 focused mirror/migration tests and all 29 dependency-free frontend
tests green; direct frontend TypeScript check green; Vite production build and
PWA verification green with exactly 9 app-shell entries and no video/private
data; `python tasks.py test lint typecheck` green through Python 3.12: **416
passed, 68 deselected**, one existing `audioop` warning; lint clean and strict
typing clean on 83 source files; `git diff --check` green.

**Contracts touched:** none. `src/contracts.py` is unchanged. Migration 021 adds
nullable delivery/hash/timestamp fields plus non-null official provenance to
the existing `public.party_profiles` table.

**Decisions made:**
- Riksdagen's official transparent PNG bytes are kept unchanged and mirrored to
  `party-logos/<code>/<sha256>.png`; Pleni does not hotlink source images.
- All eight sources validate before upload, all eight public Bunny objects
  verify before one atomic database update, and the command requires exactly
  eight updated rows before reporting success.
- `logo_source_url` is provenance only. The browser rejects Riksdagen hosts as a
  fallback and uses only a safe HTTPS delivery URL from `logo_url`.
- The fallback letter stays rendered until the transparent PNG decodes, then is
  removed so it cannot show through transparent regions of the real mark.

**Production evidence:** migration 021 applied to Supabase project
`nlooigmwuqqhhnontlgp`; S, M, SD, C, V, KD, MP and L were mirrored and persisted.
An independent anonymous REST read returned exactly eight valid CDN/hash pairs,
and HEAD verification returned HTTP 200 with `image/png` for every public URL.

**Observations (not fixed, out of scope):** physical-phone visual confirmation
remains with the owner after the main deployment.

**Blocked / needs a decision:** none.

**Next agent should know:** run `scripts/sync_party_logos.py --dry-run` before a
refresh. Never expose `logo_source_url` to the browser or seed `logo_url` before
Bunny verification; keep the letter fallback for transient delivery failures.

## UI16.1 — persistent party-logo handoff — DONE 2026-08-19

**Built:** removed the letter-first transition for verified party logos. A valid
CDN URL now suppresses the letter while its image decodes, successful immutable
URLs are remembered for the page lifetime, and cached images are confirmed
synchronously before paint when navigating between party surfaces. The letter
returns only when no verified URL exists or the current CDN image genuinely
fails.

**Tests:** added 3 party-logo lifecycle regressions; all 32 dependency-free
frontend tests green; direct TypeScript check green; Vite/PWA production build
green with exactly 9 app-shell entries and no video/private data; `python
tasks.py test lint typecheck` green through Python 3.12: **416 passed, 68
deselected**, one existing `audioop` warning; lint and strict typing clean on 83
source files; `git diff --check` green.

**Contracts touched:** none.

**Decisions made:**

- A pending verified logo renders the stable party medallion without the legacy
  letter; this avoids replacing one identity mark with another during decode.
- Successful content-addressed URLs stay in memory only for the current page.
  No viewing state or image bytes are persisted.
- The ornamental logo entrance animation was removed so a remounted cached mark
  appears immediately instead of replaying a fade.

**Observations (not fixed, out of scope):** physical-phone confirmation remains
with the owner on the live release.

**Blocked / needs a decision:** none.

**Next agent should know:** keep `shouldShowPartyLogoFallback()` failure-driven;
do not make readiness alone reveal the letter again.

## UI17 — compact politician clip count — DONE 2026-08-19

**Built:** removed the two-column `Klipp` / `Visas här` statistic strip from
politician profiles and moved the exact published total into the quiet grid
label as `Antal klipp: <count>`. When the exact count is unavailable the label
stays `Antal klipp` rather than inventing a number. The person loading skeleton
also stops reserving space for the removed strip; party profile stats are
unchanged.

**Tests:** all 32 dependency-free frontend tests green; direct source acceptance
confirmed the person stats are absent, the exact-count label is present, the
person skeleton is compact and party stats remain; direct TypeScript check
green; Vite/PWA production build green with exactly 9 app-shell entries and no
video/private data; `python tasks.py test lint typecheck` green through Python
3.12: **416 passed, 68 deselected**, one existing `audioop` warning; lint and
strict typing clean on 83 source files; `git diff --check` green.

**Contracts touched:** none.

**Decisions made:**

- The exact `Politician.clipCount` remains the count authority; the loaded grid
  length is no longer exposed as a competing `Visas här` statistic.
- Shared stat styling stays because party profiles still use it.
- No replacement card or motion was added; removing the strip is the spacing
  improvement.

**Observations (not fixed, out of scope):** physical-phone confirmation remains
with the owner on the live release.

**Blocked / needs a decision:** none.

**Next agent should know:** do not replace an unavailable exact count with
`clips.length`; the grid is bounded and that would present a partial page as a
catalogue total.

## UI18 — search all-parties home icon — DONE 2026-08-20

**Built:** replaced the Search page's first party-filter grey dot and visible
`Alla` text with a centered home icon. The control remains first, retains the
same null/all filter behavior and selected styling, and now has the accessible
label `Visa alla partier`.

**Tests:** added one dependency-free source regression; all **33** frontend tests
green; direct TypeScript check green; Vite/PWA production build green with
exactly 9 app-shell entries and no video/private data; `git diff --check` green.
The required repository-wide gate is green: **416 passed, 68 deselected**, lint
clean, and strict typing clean across **83 source files**.

**Contracts touched:** none.

**Decisions made:**

- Reused the existing Lucide `Home` icon and existing filter state; no dependency
  or behavior change was introduced.
- The icon-only control is 34 px wide, matching the filter row height, and keeps
  its purpose available to assistive technology through a Swedish label.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Next agent should know:** UI18 changes only the first Search filter's
presentation; every party filter and the underlying null/all selection behavior
remain unchanged.

## UI19 — temporarily hide comments — DONE 2026-08-20

**Built:** added a temporary in-app product switch that prevents both the feed
comment action and the comment sheet from rendering. The comment implementation,
data layer, moderation tooling, existing data and legal disclosures remain
intact for later repair.

**Tests:** added two dependency-free visibility regressions; all **35** frontend
tests green; direct TypeScript check green; Vite/PWA production build green with
exactly 9 app-shell entries and no video/private data. The built JavaScript
contains no comment sheet or comment read/write RPC names. The repository-wide
gate is green: **416 passed, 68 deselected**, lint clean, and strict typing clean
across **83 source files**. `git diff --check` green.

**Contracts touched:** none.

**Decisions made:**

- Used one local `COMMENTS_ENABLED = false` switch instead of deleting the feature
  or hiding it with CSS, so viewers cannot open it and the production bundle can
  remove its runtime and network code.
- Kept legal disclosures unchanged because comment data and moderation records
  may still exist while the user interface is temporarily unavailable.
- Preserved likes, saves, sharing, playback, authentication and PWA behavior.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Next agent should know:** re-enabling comments requires repairing and accepting
the feature first, then changing the switch near the top of `web/src/App.tsx`;
do not remove the guard before that acceptance work is complete.

## UI16.10 — signed-in owner Android beta — DEPLOYED 2026-08-26

**Built:** integrated UI16.0–UI16.9 onto the latest `origin/main` without the
unrelated dirty workstation changes. Ordinary visitors remain default-off. The
special production URL marker `?topic-search-beta=android` enables topic search
only for a signed-in viewer; the page shows a Swedish OpenAI/private-information
warning and requires explicit confirmation before the first submitted query in
each page session. The opt-in and query are not persisted. An explicit
`VITE_TOPIC_SEARCH_ENABLED=false` remains the emergency kill switch.

**Tests:** repository acceptance green: **446 passed, 78 deselected**, one
existing `audioop` warning; Ruff and strict typing clean on 83 source files.
Frontend: **67 passed**, TypeScript green, production Vite build green and PWA
verification green with exactly nine app-shell entries and no video/private
data. Edge: **99 passed** under Node 24 TypeScript stripping; only typeless
package warnings. `git diff --check` green.

**Production:** release commit `2a4773f` was pushed to `origin/main` and the
InstaPods HTML/bundle was verified at `pleni.se`; the deployed JavaScript
contains the beta marker, consent warning and `clip-search` client. A positive
elsparkcykel probe returned ten results with “6 500 skadades i olyckor med
elsparkcyklar” first. The nonsense probe returned zero results. Six post-deploy
calls measured 7,350, 1,010, 798, 2,038, 754 and 998 ms, so cold latency remains
visible in the beta.

**Contracts touched:** none. `src/contracts.py`, the browser/Edge
`clip-search-v1` transport contract, ranking/index versions, feed player,
gesture policy and PWA media ceiling are unchanged.

**Decisions made:** the owner's instruction is accepted as GO for a limited
real-app Android test, not a general viewer launch. The narrower signed-in URL
gate and per-session warning avoid exposing anonymous visitors while OpenAI
account retention/region and the former 1.5 s latency target remain unresolved.

**Observations (not fixed, out of scope):** the mockup query “Magdalena Andersson
skatter 2017” returns no clip result because the current catalogue has no 2017
backfill and no published Magdalena Andersson speech/person row. It must not be
made to look successful through aliases or unrelated semantic filler.

**Blocked / needs a decision:** none for the owner beta. General release remains
blocked on the UI16.8 evidence listed in
`docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`.

**Next agent should know:** give the owner the exact beta URL and collect Android
behavior for the signed-in gate, warning, positive/topic, negative/empty,
result-feed autoplay/order, Back restoration and observed cold latency. Do not
turn the URL beta into a public flag without a separate owner decision.

## UI16.11 — public integrated Search tab — DEPLOYED 2026-08-26

**Built:** removed the signed-in owner-beta gate from the completed topic-search
experience. Production now enables topic/video search by default for every
visitor on the normal Search tab. Person and party lookup remain intact; a
submitted query can additionally render “Tolkat som”, relevant video rows,
empty/error states and the existing exact-order result feed. The special URL
marker and confirmation dialog are gone. A concise inline disclosure remains,
and explicit `VITE_TOPIC_SEARCH_ENABLED=false` is still the emergency kill
switch.

**Tests:** all **67 frontend tests** pass; focused topic-search suite **33 passed**;
TypeScript passes; the production Vite build passes; PWA verification reports
exactly nine app-shell entries with no video/private data; all **99 Edge tests**
pass. `git diff --check` passes. The Python repository gate could not be rerun
because this workstation currently exposes no installed project Python runtime
(the desktop-bundled Python has no `pytest`); the immediately preceding release
commit remains green at **446 passed, 78 deselected**, and UI16.11 changes no
Python file.

**Contracts touched:** none. `src/contracts.py`, `clip-search-v1`, ranking,
embedding/index versions, database state and player/PWA media behavior are
unchanged.

**Production:** commit `082fbb7` was pushed to `origin/main`. InstaPods served
the new `/assets/index-CEARHAzJ.js` bundle at `https://pleni.se/`; the deployed
bundle contains the public search button, inline disclosure and `clip-search`
client, and contains neither `topic-search-beta` nor the former confirmation
copy.

**Decisions made:** public production availability follows the owner's explicit
clarification. Non-production builds remain opt-in unless the environment flag
is true, while an explicit false overrides the production default.

**Observations (not fixed, out of scope):** no new catalogue content was added;
queries still reflect the dates and speakers currently backfilled.

**Blocked / needs a decision:** none for deployment.

**Next agent should know:** the normal URL `https://pleni.se/` is now the only URL
needed for search testing, and sign-in is not required. Verify the first public
Android search with `elsparkcyklar`, then verify an absent topic stays empty.

## UI16.12 — public browser preflight repair — DEPLOYED 2026-08-26

**Built:** corrected `clip-search` CORS so its allowed-origin `OPTIONS` response
permits the public Supabase `apikey` header sent by `web/src/search/api.ts`, in
addition to `content-type` and `x-client-info`. Added an exact browser-preflight
regression. Disallowed origins and the existing POST-only behavior are
unchanged.

**Tests:** all **100 Edge tests** pass, including the new preflight regression;
all **67 frontend tests** pass; `git diff --check` passes.

**Contracts touched:** none. The search request/response contract, ranking,
embeddings, database state, frontend layout, player/PWA behavior and
`src/contracts.py` are unchanged.

**Production:** fix commit `78c29af` was pushed to `origin/main`, then the
`clip-search` Function was deployed with JWT verification disabled as before.
The real browser preflight returns 204 with
`Access-Control-Allow-Headers: apikey, content-type, x-client-info`. A following
public `elsparkcyklar` request returned HTTP 200 with ten results and “6 500
skadades i olyckor med elsparkcyklar” first.

**Decisions made:** fixed the Function's narrow CORS declaration rather than
changing the browser client or bypassing the publishable-key header.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Next agent should know:** direct server probes do not enforce CORS. Any future
public Function acceptance must include an actual preflight that requests every
non-simple header used by the browser client.

## UI16.13 — Swedish day–month interpretation and search loading state — DEPLOYED 2026-08-26

**Built:** interpreter `search-interpret-v2` now consumes valid Swedish
day–month phrases such as `30 mars`, common month abbreviations and explicit
forms such as `30 maj 2025`. An omitted year uses the request's current UTC
year; explicit dates filter `sources.debate_date` exactly. Impossible calendar
dates remain residual topic text. The Search result-loading state now displays
a compact Lucide spinner and visible `Söker efter relevanta klipp…` status above
the existing cardless skeleton rows, with reduced-motion handling.

**Tests:** all **104 Edge tests** and **68 frontend tests** pass. Focused
interpreter/API fixtures cover `30 mars`, explicit `30 maj 2025`, request-year
propagation and invalid `31 februari`. TypeScript, production Vite build and PWA
verification pass; the PWA still precaches exactly nine app-shell entries and
no video/private data. `git diff --check` passes. The unavailable workstation
Python gate was not rerun; UI16.13 changes no Python file.

**Contracts touched:** none. The public byte-identical `clip-search-v1`
transport contract, ranking, embedding/index versions, database state,
player/PWA media behavior and `src/contracts.py` are unchanged.

**Production:** commit `2899e97` was pushed to `origin/main`; the updated
`clip-search` Function was deployed with JWT verification disabled as before.
The live query `elsparkcyklar 30 mars` returned HTTP 200 with separate
`Datum · 30 mars 2026` and `Ämne · elsparkcyklar` facets and zero honest results.
The known matching date `elsparkcyklar 22 juni` returned eight results with the
expected scooter-safety clip first. InstaPods serves a bundle containing the
visible spinner copy and its reduced-motion CSS.

**Decisions made:** an unqualified day–month means that exact day in the current
UTC year. It does not leak back into semantic topic text or broaden silently to
another month. The loading indicator augments the existing skeleton instead of
adding a card, modal or competing accent.

**Observations (not fixed, out of scope):** `30 mars` must not return clips from
May or June; use the actual debate date. Month-only ranges such as `maj 2026`
remain outside this chunk.

**Blocked / needs a decision:** none.

**Next agent should know:** keep date filtering tied to `sources.debate_date`,
not clip publication time. If month-only or relative dates are later added,
version them with explicit fixtures instead of weakening the exact-day rule.

## UI16.14 — Automatic date broadening for empty topic searches — DEPLOYED 2026-08-26

**Built:** Added optional `dateBroadening` metadata to the mirrored
`clip-search-v1` response contract. The Edge handler now tries the exact date
first and, only when a topic-plus-date query has no results, repeats candidate
retrieval with the date removed. The same embedding and all person, party and
verified-event/source filters are retained. The result UI omits the relaxed date
facet and shows `Inga klipp hittades den <datum>. Visar relevanta klipp från
andra datum.`. Date-only and disabled-date searches never broaden.

**Tests:** all **108 Edge tests** and **70 frontend tests** pass. Edge/browser
contract fixtures cover valid and malformed broadening metadata; focused handler
tests cover exact hits, empty-date fallback, identity/event preservation,
disabled dates and provider keyword fallback. Frontend TypeScript, production
Vite build, PWA verification (9 app-shell entries, no video/private data) and
`git diff --check` pass. The Python gate was not rerun because this workstation
does not expose an installed project Python runtime; no Python files changed.

**Contracts touched:** optional `dateBroadening` in `clip-search-v1`, mirrored
byte-identically in the Edge and browser parsers. `src/contracts.py` unchanged.

**Database state:** no migrations, tables, indexes or RPC signatures changed.

**Deployment state:** the updated `clip-search` Edge Function was deployed with
the existing JWT-verification setting; the frontend commit was pushed to
`origin/main` for InstaPods auto-deploy. Live exact-date and broadened-date
probes passed.

**Index state:** unchanged from UI16.13: 3,188/3,188 keyword documents and
3,188/3,188 current semantic documents, 4,160 current chunks, zero reviewed
semantic exceptions, index version `openai:text-embedding-3-large:1024:v1`.

**Decisions made:** unqualified day–month phrases remain exact dates in the
current UTC year. Automatic broadening is transparent, removes only the date,
and runs only when a topic remains and the exact candidate set is empty. The
response explicitly records the original date so the browser never reinterprets
the query.

**Observations (not fixed, out of scope):** month-only and relative-date
phrases remain unsupported; exact date searches with no topic remain bounded
and empty by design.

**Blocked / needs a decision:** none.

**Next agent should know:** test `elsparkcyklar 30 mars` for broad results with
the notice, `elsparkcyklar 22 juni` for exact-date results without it, and
`elsparkcyklar` for the unchanged all-date search.

## UI16.15 — Truthful other-date fallback results — DEPLOYED 2026-08-26

**Built:** The Edge date fallback now requests up to the existing 60-candidate
ceiling, removes every result whose `clip.debateDate` lies inside the original
inclusive date range, preserves the remaining relevance order and reapplies the
client limit. If nothing outside the range remains, the original empty exact
response and date facet are retained without `dateBroadening`. The existing
cardless notice now says `Inga relevanta klipp hittades`.

**Tests:** all **110 Edge tests** and **70 frontend tests** pass. Focused
regressions cover mixed same/other dates, order and limit preservation,
same-date-only fallback, full year-range exclusion, exact-date success,
identity/event filter preservation, disabled dates and provider fallback. Edge
and frontend TypeScript checks, the Vite production build, PWA verification
(9 app-shell entries, no video/private data) and `git diff --check` pass. No
Python files changed; the unavailable local project Python gate was not rerun.

**Contracts touched:** none. `clip-search-v1` and `src/contracts.py` are
unchanged.

**Database state:** no migrations, tables, indexes, RPC signatures or ranking
thresholds changed.

**Deployment state:** `clip-search` was deployed with the existing
JWT-verification setting. The frontend/docs commit was pushed to `origin/main`
for InstaPods auto-deploy.

**Index state:** unchanged from UI16.14: 3,188/3,188 keyword documents and
3,188/3,188 current semantic documents, 4,160 current chunks, zero reviewed
semantic exceptions, index version `openai:text-embedding-3-large:1024:v1`.

**Decisions made:** “andra datum” is enforced as an inclusive exclusion of the
original date range, not just removal of the SQL date constraint. Fallback
over-fetching is bounded by the existing public ceiling and never creates a
second embedding request.

**Observations (not fixed, out of scope):** the global semantic admission and
ranking thresholds remain unchanged; those require a separate evaluated search
quality change.

**Blocked / needs a decision:** none.

**Next agent should know:** live `elsparkcykel 30 mars` returns 25 results with
the broadening notice and zero `2026-03-30` dates. `elsparkcykel 22 juni`
returns nine exact-date results with no notice, and `elsparkcykel` remains at 28
results.

## OPT1 — Lean automatic smoke baseline — DONE 2026-08-26

**Built:** an offline, provider-free `smoke` command in
`scripts/evaluate_topic_search.py`; the focused fixture
`tests/fixtures/search/smoke.json`; the compact report
`test_outputs/topic_search_smoke_baseline.md` (ignored directory); the OPT1
chunk entry in `docs/BUILD_PLAN.md`; the OPT1 record in
`docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`; the DONE/handoff section in
`docs/TOPIC_SEARCH_FINISHED_OPTIMIZATION_ROADMAP.md`.

This is ordinary regression testing, not model training and not human relevance
judgment. The ten committed phrases are test data only: they are never derived
from logged user searches, the live endpoint never reads them, and they are not
a topic whitelist, a synonym table, a list of permitted searches, training data
or a source of ranking decisions.

**Tests:** 24 new unit tests in `tests/unit/test_topic_search_evaluation.py`
(36 in that file). `C:\WINDOWS\py.exe -3.12 tasks.py test lint typecheck` is
green: **471 passed**, 78 deselected, 1 pre-existing `audioop` deprecation
warning; ruff clean; mypy clean over 83 source files. `git diff --check` clean.
`ruff format --check` is clean for both files this chunk touched; the 33
unrelated files it would reformat are pre-existing and were left alone.

**Contracts touched:** none. `src/contracts.py`, `clip-search-v1`, ranking
thresholds, Edge Functions, migrations, the frontend and the embedding
model/index are all unchanged.

**Database state:** unchanged. No migration, table, index or RPC signature was
touched, and no live or OpenAI call was made.

**Deployment state:** nothing deployed, nothing pushed. The work sits on
`claude/opt1-smoke-baseline-f4d17b` in a worktree.

**Index state:** unchanged; the baseline pins `openai:text-embedding-3-large:1024:v1`
and refuses to run against a capture with a different index version.

**Result:** 7 pass, 0 fail, 3 blocked of 10 on the frozen 2026-08-25 capture.
Re-running over the same fixtures is byte-identical for both the JSON and the
Markdown report.

**Decisions made:**
- The served order is the hybrid list. Keyword-only and semantic-only pools stay
  diagnostics, because they are not what a viewer sees.
- Seven phrases bind to real captured runs and are verified by exact captured
  query text, so one phrase can never silently inherit another's evidence. That
  guard is what keeps `elsparkcykel` from claiming the captured `elsparkcyklar`
  run.
- The three phrases with no capture are reported as `blocked_needs_capture`
  rather than guessed or filled in from prose. Their expectations are encoded
  and unit-tested against synthetic captures, so they begin checking
  automatically the moment a capture carries date metadata.
- A blocked search does not fail `--strict-release`; a real regression does.
  OPT1 is forbidden from producing the capture that would resolve a blocker, so
  failing on one would only train the next agent to ignore the gate.
- Private ranking scores (cosine similarity, Swedish lexical coverage) are
  dropped by an allowlist before anything is written.
- `_result_summary` now captures `clip.debateDate`, which migration 026 already
  returns. This costs nothing today and removes the date blocker from the next
  authorised capture.
- `--output` now writes LF instead of the Windows default CRLF. This is shared
  with `evaluate` and `capture-live` and is what makes a written baseline
  byte-identical across platforms. `evaluate`'s payload itself is unchanged:
  its stdout and JSON content are byte-identical to the previous commit.

**Observations (not fixed, out of scope):**
- `docs/TOPIC_SEARCH_FINISHED_OPTIMIZATION_ROADMAP.md` existed only as an
  untracked file in the sibling worktree `.codex-worktrees/ui16-public-search`.
  It was copied into this worktree byte-identically (md5
  `9c80634066ad98c721ba8fe088fd4553`) and verified to contain OPT0-OPT5 and
  `Lean automatic smoke baseline` before any work began. It has never been
  committed on any branch; the owner should decide where it lives.
- OPT0's `review-export`/`review-import` tooling is not present in this repo, on
  any branch, or in either sibling worktree. OPT1 does not depend on it.
- `ruff format --check` reports 33 pre-existing unformatted files repo-wide.
  Formatting them is not this chunk's scope.

**Blocked / needs a decision:**
- The three `elsparkcykel` smoke expectations cannot be verified offline. The
  frozen capture has no run for those exact phrases, and no run of any phrase
  records a debate date, an interpretation facet or date-broadening metadata.
  Producing them needs a live Supabase read plus one OpenAI query embedding,
  which OPT1 is explicitly not permitted to perform. This is recorded, not
  worked around.

**Next agent should know:**
- Run `C:\WINDOWS\py.exe -3.12 scripts/evaluate_topic_search.py smoke` for the
  baseline; add `--strict-release` in CI. Output goes to
  `test_outputs/topic_search_smoke_baseline.{json,md}`.
- To unblock the three date expectations, an authorised operator must run one
  `capture-live` that includes the three elsparkcykel phrases and records the
  interpretation and `dateBroadening` envelope per run. Nothing else is needed:
  `_smoke_check` already implements both date rules and both are unit-tested.
- The three known elflyg false positives `HD10398_27_c02`, `HD10401_27_c02` and
  `HD10406_27_c02` sit at hybrid ranks 8-10 of the captured `elsparkcyklar` run
  with zero lexical coverage. They are recorded as forbidden scooter examples
  and as a known open defect owned by OPT2. OPT1 may not change ranking, so the
  baseline reports them instead of failing on them; OPT2 removing them is the
  measurable improvement.
- `judgments.json` is untouched and still 0/36 manually complete. Do not grade
  it, and do not ask the owner to.

## OPT2 production release — DEPLOYED 2026-08-26

**Released:** owner approval was recorded in the session before any production
write. `029_search_candidate_admission.up.sql` was applied through the checksum
ledger; migrations 001–028 all reported `already-applied`. The `clip-search`
Edge Function was then deployed from candidate commit `af8238a` with
`verify_jwt=false`, matching the existing public anonymous configuration.

**Exact live Function:** Supabase project `nlooigmwuqqhhnontlgp`, Function id
`51f63fc5-564b-42ca-8846-b6d9c4e0595f`, version **7**, bundle SHA-256
`4c2c2046550777188e3893a410301add7c519eb094cfebf3f1d2e014ce44aee0`, updated
`2026-08-26T21:35:47.614Z`. Public responses report
`searchVersion=pleni-search-v3`.

**Pre-release tests:** `C:\WINDOWS\py.exe -3.12 tasks.py test lint typecheck`
— **501 passed**, 79 deselected, Ruff clean and mypy clean over 83 source files.
Edge tests — **123 passed, 0 failed**. `git diff --check af8238a^ af8238a`
passed. The only untracked worktree file was `.claude/settings.local.json`; it
was not staged or committed.

**Post-migration contract:**
`pytest tests/live/test_topic_search_rpc.py -m live -q` — **5 passed**. This
proved 029 is present, v3 is service-only, v2 remains callable, both versions
keep the same private envelope, the materialized catalogue still matches live
entities and rate-limit storage still cannot retain query/address data.

**Public live probes:** all returned HTTP 200, `pleni-search-v3` and hybrid
mode.

| Query | Results | Acceptance |
|---|---:|---|
| `elsparkcyklar` | 6 | first result remains “6 500 skadades i olyckor med elsparkcyklar”; all three known elflyg ids absent |
| `elsparkcykel 30 mars` | 2 | broadened from 30 March; every result is dated 22 June 2026; all three known elflyg ids absent |
| `elsparkcykel 22 juni` | 2 | exact-date results only; no broadening notice |
| `trafiksäkerhet för små elektriska hyrfordon` | 6 | descriptive semantic query remains non-empty |
| `bananministeriet på månen` | 0 | negative remains empty |
| `kvantdatorer på varje förskola` | 0 | negative remains empty |

The first request included a 5,886 ms cold path; the five following requests
were 779–1,291 ms. This release does not claim the separate broad latency gate
is closed.

**Operational rollback:** keep migration 029 applied; it is additive and v2
remains deployed. From a temporary checkout of rollback commit `16a4887`, run:

```powershell
git worktree add ..\pleni-search-v2-rollback 16a4887
cd ..\pleni-search-v2-rollback
npx supabase functions deploy clip-search --project-ref nlooigmwuqqhhnontlgp --no-verify-jwt
```

Then verify a public response reports `searchVersion=pleni-search-v2`. No SQL
rollback is needed for an incident. The reviewed down migration exists only for
later schema cleanup and drops v3 without touching v2.

**Blocked / needs a decision:** none for the OPT2 release. OPT3 remains a
separate chunk. The 36-query human-judgment programme remains intentionally
unused and is not a prerequisite for continuing the finished optimization
roadmap.

## OPT2 — Ranking v3 with candidate-level admission — DONE 2026-08-26

**Built:** the additive migration pair `migrations/029_search_candidate_admission.{up,down}.sql`
creating `public.search_clip_candidates_v3`; candidate-admission constants and a
mirrored `admitsSemanticCandidate` predicate in
`supabase/functions/_shared/search/ranking.ts`; the v3 RPC switch in
`supabase/functions/clip-search/index.ts`; the offline `admission-grid` command
and its before/after report renderer in `scripts/evaluate_topic_search.py`; the
OPT2 entries in `docs/BUILD_PLAN.md`,
`docs/TOPIC_SEARCH_FINISHED_OPTIMIZATION_ROADMAP.md` and
`docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`.

This is ordinary ranking work backed by offline regression evidence. It is not
model training and not human relevance judgment. The 36-query fixture and its
385 captured rows were not graded, `judgments.json` is untouched and still 0/36,
and the owner has no action item beyond the deploy decision below.

**Tests:** 30 new unit tests in `tests/unit/test_topic_search_evaluation.py`
(66 in that file) and 13 new Edge tests in
`supabase/functions/tests/clip-search.test.ts` (36 declarations there, 39
executed cases: one existing declaration is a three-case parameterised loop).
`C:\WINDOWS\py.exe -3.12 -m pytest tests/unit -q` passes.
`C:\WINDOWS\py.exe -3.12 tasks.py test lint typecheck` is green: **501 passed**,
79 deselected, 1 pre-existing `audioop` deprecation warning; ruff clean; mypy
clean over 83 source files. `node --experimental-strip-types --test
supabase/functions/tests/*.test.ts` is **123 pass, 0 fail**. `git diff --check`
is clean. `ruff format --check` is clean for all three Python files this chunk
touched; the 32 unrelated files it would reformat are pre-existing.

**Contracts touched:** none. The public `clip-search-v1` response shape,
`src/contracts.py`, embedding dimensions, index contents, the frontend, the
video pipeline, Bunny, the player/PWA and migrations 022-028 are all unchanged.
`searchVersion` in the response is a value, not a shape: it now reads
`pleni-search-v3`.

**Database state:** unchanged on every environment. Migration 029 was written
and tested as text; it was **not applied**. No live or OpenAI call was made.

**Deployment state:** nothing deployed, nothing pushed. The work sits on
`claude/pleni-opt2-ranking-4d87c9` in a worktree.

**Index state:** unchanged. `openai:text-embedding-3-large:1024:v1`, same
dimensions, same chunks, no backfill.

### The defect and the fix

v2's `semantic_admitted` CTE cross joins one query-level `semantic_confidence`
row, so a single keyword anchor anywhere in the query admits **every** semantic
candidate. That is why three electric-aviation clips sat at ranks 8-10 of the
captured `elsparkcyklar` run with cosine similarity `0.416605` and zero Swedish
lexical coverage.

v3 keeps that query-level gate verbatim and adds a second CTE after it. A
candidate that also matched keywords is exempt; a semantic-only candidate must
clear `similarity >= 0.50` or `lexical_coverage >= 0.67` on its own evidence.
The v3 function body is otherwise byte-identical to v2: same `eligible` CTE with
the structured filters ahead of retrieval, same `0.35` floor, same `limit 120`
pools, same `1.5`/`1.0` weights and `k = 50`, same tie breaks, same envelope.

### Selected configuration

`sim0.50-lex0.67-kw1.50-sem1.00-k50` — candidate similarity `0.50`, candidate
lexical coverage `0.67`, fusion weights and `k` unchanged from v2.

Run `C:\WINDOWS\py.exe -3.12 scripts/evaluate_topic_search.py admission-grid`
(add `--strict-release` in CI; it exits 1 when no configuration passes). Output
goes to `test_outputs/topic_search_admission_before_after.md`.

| Candidate similarity | Outcome |
|---|---|
| `0.40` | discarded, 36 configurations: the three elflyg rows stay in the scooter result |
| `0.45` / `0.48` / `0.50` | 108 survivors; semantic-only tails 30 / 29 / 25-23 |
| `0.53` | discarded, 36 configurations: the descriptive scooter search falls to 3, below `min(5, 10)` |

Rule 7 picks the fewest semantic-only tail candidates (23, a unique minimum at
lexical `0.67`), then the higher similarity.

### Top-five before/after on the frozen capture

Engineering evidence of observable membership. Not human-validated relevance
evidence: no grade, no nDCG, no precision, and no configuration is called best.

| Search | Before | After | Dropped |
|---|---|---|---|
| `elsparkcyklar` (`q01`) | 10 | 6 | 3 elflyg rows + 1 weak context row |
| `trafiksäkerhet för små elektriska hyrfordon` (`s04`) | 10 | 6 | 4 tail context rows |
| `barnfattigdom` (`s05`) | 10 | 10 | none |
| `äldreomsorg bemanning` (`s06`) | 10 | 10 | none |
| `havsbaserad vindkraft i Kattegatt` (`s07`) | 10 | 6 | 4 tail context rows |
| `hur ska gängkriminaliteten stoppas` (`s08`) | 10 | 10 | none |
| `bananministeriet på månen` (`s09`) | 0 | 0 | none |
| `kvantdatorer på varje förskola` (`s10`) | 0 | 0 | none |

**Every top-five position is identical before and after in all eight captured
searches.** Only tail candidates were removed. Across all 180 configurations no
keyword-matched candidate was ever dropped and both negatives stayed empty.

**Decisions made:**
- Semantic retrieval ranks stay assigned *before* admission, exactly as in v2.
  Recomputing them afterwards would promote survivors and reshuffle the head;
  filtering after ranking is why the top five is provably unchanged.
- `matchKind` is what makes a candidate semantic-only, not absence from the
  captured keyword top-10. The captured `rankings.keyword` list is a
  diagnostic pool of 10, while the real keyword CTE holds up to 120, so
  `barnfattigdom` and `äldreomsorg bemanning` look semantic-only by list
  membership but are `both` and correctly exempt.
- The keyword weight, semantic weight and RRF `k` axes were enumerated but held
  at the deployed values. They change order rather than admission, and the
  frozen capture preserves only the top-N the deployed weights produced, so a
  different weighting cannot be replayed against it honestly. The grid records
  this rather than implying it compared them.
- The smoke fixture keeps `pleni-search-v2`. It describes what produced the
  frozen capture, so it is now the v2 before-state and its drift test binds to
  the new `SEARCH_RANKING_ROLLBACK_VERSION`. Relabelling it v3 would have
  falsified the baseline.
- Gate 5 is verified against the captured `elsparkcyklar` run, bound through
  `forbiddenExamples.identifiedFrom`. It is the only scooter search the frozen
  capture can evidence, and it is the run the three false positives came from.
- The grid stops and reports conflicts rather than selecting something when no
  configuration passes; a unit test drives that path.

**Observations (not fixed, out of scope):**
- `docs/BUILD_PLAN.md` still labels the OPT1 chunk `PLANNED` although OPT1 is
  DONE and recorded as such in the roadmap and `PROGRESS.md`. Left alone: it is
  OPT1's record to correct.
- `ruff format --check` reports 32 pre-existing unformatted files repo-wide.
  Formatting them is not this chunk's scope.

**Blocked / needs a decision:**
- **The deploy is the owner's call and was not performed.** Applying
  `029_search_candidate_admission.up.sql` and deploying the `clip-search` Edge
  Function both require explicit owner authority at the time they happen. Until
  then production still runs v2 and is unaffected by this branch.
- The three `elsparkcykel` smoke expectations remain `blocked_needs_capture`.
  OPT2 was instructed to make no live or OpenAI call, so the capture OPT1's
  handoff asked for was not produced. Their date gates stay honestly unproven
  rather than assumed green.

**Next agent should know:**
- Deploy order if the owner authorises it: apply `029` first (additive, v2 stays
  callable), then deploy the Edge Function, then capture the live version and
  the rollback command here. Rollback is redeploying the previous Edge commit,
  which calls v2; no SQL rollback is needed for that.
  `029_search_candidate_admission.down.sql` drops v3 alone.
- `tests/live/test_topic_search_rpc.py` now expects `search_clip_candidates_v3`
  only when `029` is in `public.schema_migrations`, so it is truthful before and
  after the deploy. `test_v3_returns_the_same_envelope_as_v2` skips until then.
- The selected constants live in three places and two tests fail on drift:
  `029_search_candidate_admission.up.sql`, `ranking.ts` and the grid's
  `SELECTED_CONFIGURATION_ID`.
- OPT3 owns intent and filter hardening and does not need the v3 deploy to have
  happened; it can read v3's SQL as text.
- `judgments.json` is untouched and still 0/36 manually complete. Do not grade
  it, and do not ask the owner to.

## OPT3 — Intent and filter correctness hardening — DONE 2026-08-26

**Built:** explicit Swedish month/year recognition in
`supabase/functions/_shared/search/interpret.ts`; interpreter version
`search-interpret-v3`; focused fixture/handler regressions; truthful date-facet
and date-broadening copy in `web/src/search/state.ts` and `web/src/App.tsx`;
the registered/completed chunk and evidence updates in `docs/BUILD_PLAN.md`,
`docs/TOPIC_SEARCH_FINISHED_OPTIMIZATION_ROADMAP.md` and
`docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`.

**Tests:** `C:\WINDOWS\py.exe -3.12 tasks.py test lint typecheck` — **501
passed**, 79 deselected, one pre-existing `audioop` warning; Ruff clean and mypy
clean over 83 source files. All Edge tests — **139 passed, 0 failed**. All
frontend tests — **71 passed, 0 failed**. Frontend TypeScript, Vite production
build and `web/scripts/verify-pwa-build.mjs` passed; the PWA retains exactly nine
same-origin app-shell entries with no video/private data. `git diff --check`
passed.

**Contracts touched:** none. `clip-search-v1` remains byte-identical between
Edge and browser; `src/contracts.py`, RPC signatures, ranking/index versions,
embeddings, database migrations and pipeline contracts are unchanged. The
internal interpreter version moved from v2 to v3 because its deterministic
date-language behavior changed.

**Behavior delivered:**
- `mars 2026` and `i mars 2026` become `2026-03-01`–`2026-03-31`; all Swedish
  months/abbreviations use their actual final day, including leap years.
- A bare `mars` stays topic text. A month/year-only query has no retrieval
  anchor and returns empty without provider or candidate retrieval.
- Impossible phrases such as `31 februari 2026` suppress overlapping
  month/year candidates and remain entirely searchable topic text.
- Removing a month date facet returns its exact original words to the topic and
  triggers one new request through the existing frontend flow.
- Empty constrained months broaden only after the exact range is empty, exclude
  the whole original inclusive month, retain server order and reuse one
  embedding.
- `Tolkat som` now calls every date facet `Datum`. Broadening says `den` for an
  exact day and `under` for a range, based only on server `from`/`to` metadata.
- Person fuzzy score `0.88`, margin `0.08`, party matching, close-person/event
  ambiguity, verified source filtering and the whole OPT2 ranking are preserved.

**Decisions made:** no synonym/alias list or generic spell-correction was added.
Month/year is a grammar rule backed by committed failures, not topic knowledge.
The public search/ranking version remains `pleni-search-v3`; only the internal
interpreter version changes.

**Database/deployment state:** unchanged by OPT3. No live/OpenAI call, database
write, Function deploy or push occurred. Production still runs the deployed
OPT2 commit and does not understand month/year until this candidate is released.

**Blocked / needs a decision:** production release requires a new explicit
owner approval. If approved, deploy `clip-search` first, push the committed OPT3
frontend/docs to `main`, then verify the roadmap matrix live. No migration is
needed. Rollback is redeploying Function version 7/source commit `af8238a` and
reverting the OPT3 frontend commit; migration 029 remains applied.

**Next agent should know:** OPT4 is next and must measure before changing
latency/cost architecture. Do not fold OPT4 into this release and do not create
human grading work or topic aliases.

## OPT4 — Latency, cost and embedding/index decision — CODE COMPLETE 2026-08-27; LIVE EVIDENCE PENDING

**Built:** privacy-safe `Server-Timing` and actual prompt-token response headers
in `supabase/functions/_shared/search/api.ts`; preservation of OpenAI usage in
`supabase/functions/clip-search/index.ts`; exact allowlisted search-health logs;
and the `benchmark-live`/`latency-decision` operator gates in
`scripts/evaluate_topic_search.py` with focused Edge/Python regressions.

**Tests:** the full offline closeout after OPT4 and OPT5 is **512 Python tests
passed** with one pre-existing `audioop` warning, Ruff clean, focused Ruff
formatting clean and mypy clean over 83 source files. All Edge tests are **143
passed, 0 failed** and all frontend tests are **71 passed, 0 failed**. Frontend
and Edge TypeScript pass; the Vite production build and PWA verification pass
with exactly nine same-origin app-shell entries and no video/private data.
`git diff --check` is clean.

**Contracts touched:** no public JSON contract and no pipeline contract.
`clip-search-v1`, `src/contracts.py`, ranking order/thresholds, provider model,
1024 dimensions and active index version are unchanged. The internal embedding
adapter now carries OpenAI's numeric prompt-token usage with the vector.

**Decisions made:** the benchmark is exactly 30 serial requests—the ten frozen
smoke phrases repeated three times—with at least seven seconds between calls.
It keeps the cold candidate and all failures and writes only query ids. The
three-day decision independently recomputes failures, total p50/p95/max, every
server-phase p95 and token totals from all 90 call rows. It retains
`text-embedding-3-large:1024:v1`; it cannot silently select a small model,
change endpoint/timeout or authorize a paid shadow backfill.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** implementation is not blocked. The SLO gate is
real production evidence and needs one 30-call report on each of three distinct
UTC dates after this Function candidate is explicitly deployed. OpenAI
region/retention evidence and any small-model shadow spend are also separate
owner-controlled actions. No live/OpenAI call, endpoint change, deploy or push
occurred in this chunk.

**Next agent should know:** run the three commands documented in
`docs/RUNBOOK.md` only after release authority. A failed daily gate retains the
large model and requires an owner SLO decision or separate paid-shadow approval;
it never weakens search to manufacture a pass.

## OPT5 — Future backfill resilience, privacy-safe operations and closeout — CODE COMPLETE 2026-08-27; PRODUCTION EVIDENCE PENDING

**Built:** additive `030_search_future_resilience` up/down migration; isolated
`search_embeddings_backfill`; service-only fresh-first
`claim_search_embedding_jobs_v2`; two-queue status, future-publication lag and
closeout evidence RPCs; the matching worker claim; historical-backfill,
20-clip lag, 10k/50k HNSW plan-audit and strict closeout commands in
`scripts/backfill_topic_search.py`; exact privacy-log, migration, worker and
operator regressions; and full runbook/roadmap/privacy evidence.

**Tests:** same complete release gate as OPT4: **512 Python**, **143 Edge** and
**71 frontend** tests passed; Ruff, focused formatting, mypy over 83 files,
both TypeScript projects, Vite production build, nine-entry PWA verification
and `git diff --check` are green.

**Contracts touched:** no `src/contracts.py`, public search JSON, RPC ranking
signature, embedding model/dimensions or pipeline-stage contract. Migration 030
is additive and service-role-only. The existing primary queue, completion/
failure RPCs and HNSW index remain intact for rollback.

**Decisions made:** C11's existing trigger continues to enqueue normal
publication in the primary queue. Historical work enters a separate backlog;
the worker claims fresh work first and promotes only unused batch capacity into
the unchanged primary completion path. The lag clock starts at committed
`clips.published_at` and ends only at current source hash/index version with a
matching chunk. Plan evidence is read-only, sanitized and due at 10,000 and
50,000 documents. Closeout requires exact eligible/keyword equality, all
semantics current, no pending/processing/failed rows and both queues empty.

**Observations (not fixed, out of scope):** the local worker being asleep can
inflate publication-to-index time; the report must label that as an operating
availability condition rather than relabeling it search latency.

**Blocked / needs a decision:** code is complete, but migration 030 and the
matching Functions have not been deployed. Therefore no queue mutation, HNSW
probe, provider call, 20-new-clip lifecycle sample, final production coverage,
production rollback rehearsal or Android acceptance was fabricated. Those
operations require an explicit release instruction and, for the lag gate, 20
real newly published clips while workers are operating.

**Next agent should know:** release order is migration 030, `search-embed`, then
`clip-search`, followed by closeout/status and the live matrix. Incident
rollback normally redeploys accepted Function version 7/source `af8238a` while
leaving additive migrations 029/030 applied; provider-off keyword fallback and
both-queue recovery are documented in `docs/RUNBOOK.md`.

## OPT3–OPT5 production release attempt — BLOCKED 2026-08-27

**Owner authority:** the owner explicitly approved applying migration 030,
deploying the Functions, pushing OPT3–OPT5 to `main` and performing every live
acceptance step except the Android device test.

**Completed before the release gate stopped:** the checksum migrator reported
001–029 `already-applied` and applied
`030_search_future_resilience.up.sql` to project `nlooigmwuqqhhnontlgp`. Five
read-only topic-search RPC contract tests passed. `closeout-status --strict`
passed with 3,188 eligible documents, 3,188 keyword documents, 3,188 current
semantic documents, zero pending/processing/failed rows and both fresh/backfill
queues empty. The catalogue is below the first 10,000-document HNSW plan-audit
threshold, so `plan-audit` correctly returned `due=false` without EXPLAIN.

**Blocking gate:** the full live database privilege matrix reported **52
passed, 1 failed**. The failing assertion predates comments and rejects every
browser-callable `SECURITY DEFINER` RPC. Production intentionally exposes the
five reviewed comment RPCs created later by migration 012:
`list_video_comments`/`report_video_comment` to anonymous and authenticated
roles, and `get_my_comment_profile`/`create_video_comment`/
`delete_video_comment` to authenticated viewers. Migration 012 revokes default
access first, grants those exact roles deliberately and has focused unit tests
for its safe projection/authentication/ownership rules. Git history confirms
the broad live assertion (`ab4f6dc`) predates the comment feature (`3007ae7`).
No migration-030 Function appeared in the reachable list.

**Release state:** stopped before deploying `search-embed` or `clip-search` and
before pushing to `main`, as required by `AGENTS.md` when an unrelated existing
test is red. Migration 030 is additive/service-only and remains applied; the
currently deployed Functions do not call its new claim RPC, so normal
production behavior remains on Function version 7/source `af8238a`.

**Decision required:** repair `tests/live/test_db_privileges.py` in a separate
security-test scope so it allows only the five intentional comment RPC grants,
asserts their exact role matrix and continues rejecting every other public
`SECURITY DEFINER` function. Then rerun the full privilege matrix before
resuming Function deployment and the main push. Do not skip or suppress the
gate.

**Resolved 2026-08-27:** the owner explicitly approved proceeding. The live
test now asserts the exact five-signature role matrix rather than suppressing
the check: two RPCs are anon+authenticated, three are authenticated-only and
every other public `SECURITY DEFINER` Function remains forbidden. The complete
production privilege matrix is **53 passed, 0 failed**. Release may resume.

## OPT3–OPT5 — Production release — LIVE 2026-08-27

**Built/released:** additive migration 030; fresh-first `search-embed`; OPT3
intent parsing, OPT4 diagnostics/benchmarking and OPT5 operations in
`clip-search`; frontend bundle from `main` commit `8f55827` through InstaPods.

**Production versions:** `search-embed` version 7, SHA-256
`365dcc83440f5245257ad8cf5a717a713cd7272d23b10ce6cbdcc3f2736cee15`;
`clip-search` version 10, SHA-256
`7116ca04236d04ae8b645aa452a097e66059eafce5a379fd1b50dbb6c7a7450e`;
both `verify_jwt=false`. InstaPods served `/assets/index-Dusp71cV.js` and the
nine-entry PWA app shell.

**Tests/evidence:** offline closeout was 512 Python, 143 Edge and 71 frontend
tests plus Ruff, mypy, both TypeScript projects, Vite and PWA verification.
Production privilege checks are 53/53 and five read-only search RPC checks pass.
All ten smoke phrases and the extended public matrix pass. Strict coverage is
3,188 eligible = 3,188 keyword = 3,188 current semantic documents; no failures,
in-flight work or queue backlog.

**Rollback rehearsal:** temporarily deployed `af8238a`; old hashes matched
`cda92cd71ec52906ba83f1602673f44220b7c48aa4784322090e95b46accf7a9`
(`search-embed`) and
`4c2c2046550777188e3893a410301add7c519eb094cfebf3f1d2e014ce44aee0`
(`clip-search`). Restored the current hashes/versions above. Post-restore plain,
exact-day and broadened searches plus strict closeout all pass.

**Latency/cost day 1:** 30/30 HTTP 200; client p50 921.691 ms, p95 1,539.333
ms, max 7,500.599 ms. 201 embedding tokens cost about USD 0.000026; a
10,000-query/month scenario is about USD 0.008710 at USD 0.13/million tokens.
The day is recorded as a 39.333 ms p95 miss; no model/timeout/endpoint was
changed from one day's evidence.

**Time-bound evidence still pending:** two more benchmark runs on distinct UTC
dates and 20 genuinely new published clips. The first future-lag report has
0/20 because no new clips were published after the release checkpoint; no fake
sample was created. OpenAI's account-specific retention detail did not render
during the read-only dashboard check, so it is not claimed. Android testing was
explicitly excluded by the owner and remains the owner's device acceptance.

**Next agent should know:** search is live and rollback-proven. Do not rewrite
ranking or buy a shadow index from the single-day p95. Complete the two remaining
daily reports, run `latency-decision`, and run the lag gate only after 20 real
post-release clips exist.

## UI17 — Production desktop video feed — LIVE 2026-09-02

**Built:** a mutually exclusive mobile/tablet/desktop shell; the existing
bounded `FeedScreen` in desktop presentation mode; exact 9:16 playback with a
separate action rail; desktop clip inspector, keyboard/one-step navigation and
same-debate feed context; honest desktop waiting pages for Following, Search and
Profile; `ClipItem.sourceId`; the public same-debate loader; migration 031 with
up/down and restored grants; and the matching `feed-requests` projection.
`docs/DESKTOP_FEED_IMPLEMENTATION_PLAN.md` records the approved layout and scope.

**Tests:** **514 Python tests passed**, 79 deselected, with the one existing
`audioop` warning; Ruff and strict mypy over 83 source files pass. All **74
frontend Node tests**, frontend TypeScript, Vite production build and PWA
verification pass; the service worker still contains exactly nine app-shell
entries and no video/private data. Browser QA passed at 1100x720, 1440x900 and
mobile/tablet widths: the video ratio is exactly 9:16, no horizontal overflow
appears, one-step navigation remains aligned and at most four videos mount.

**Contracts touched:** no `src/contracts.py` or pipeline artifact contract.
The additive frontend field is `ClipItem.sourceId: string | null`; sample and
legacy search clips use `null`.

**Decisions made:** widths below 700 px retain the released mobile app, 700-1099
px retain the phone gate and desktop begins at 1100 px. Mobile and desktop never
mount together. The existing UI19 `COMMENTS_ENABLED=false` product switch is
preserved: the desktop inspector uses the same comment implementation and
pause/resume lifecycle, but no comment trigger or thread is exposed while that
global switch remains off.

**Production evidence:** migration `031_desktop_debate_feed.up.sql` is applied
to project `nlooigmwuqqhhnontlgp`. An explicit `anon` role query read all 5,488
rows and all 5,488 carried `source_id`, `speech_start_s` and `clip_start_s`; the
view count exactly matched the 5,488 published, non-rejected, non-empty MP4 rows.
The updated `feed-requests` Function was deployed successfully with the project
configuration retaining `verify_jwt=false` and in-handler Clerk verification.

**Observations (not fixed, out of scope):** the desktop comment surface remains
intentionally unavailable for the same product reason as mobile UI19. Enabling
comments later is one existing feature-switch decision, not a second desktop
implementation.

**Frontend production evidence:** the first `main` push did not wake InstaPods,
but the documented follow-up commit `21893ac` retriggered its webhook. Production
now serves `/assets/index-Bo1wny8c.js` with a fresh 2026-09-02 build timestamp and
the UI17 inspector, `sourceId` and debate-return code present. A live 1440x900
browser smoke test measured the player at 444.375x790 (exactly 9:16), one playing
video and three mounted videos without horizontal overflow. Opening a real
related clip switched to the debate feed with four mounted videos and one
playing; the accessible back action restored the previous Edward Riedl clip and
returned to three mounted videos. At 900x720 the phone gate rendered with zero
videos and no overflow. At 390x844 the existing mobile bottom navigation and
three-video bounded window rendered with no overflow.

**Blocked / needs a decision:** none. UI19 still intentionally hides comments
globally; that existing product switch is the only reason the implemented
desktop comment panel is not exposed to viewers.

**Next agent should know:** rollback frontend first. Migration 031 is additive
and safe to leave applied; use its down file only after the UI17 frontend no
longer reads the new projection fields.

## UI20 — Complete desktop parity roadmap — REGISTERED 2026-09-03

**Built:** `docs/DESKTOP_COMPLETION_PLAN.md`, the authoritative tracker for the
remaining desktop work. It records UI17 as the released baseline and divides
full mobile-feature parity into UI20.0–UI20.7 with dependencies, primary scope,
acceptance criteria, production gates and a four-state dashboard.

**Tests:** documentation links/chunk headings and `git diff --check` verified.
Frontend: 74 Node tests passed; TypeScript, Vite production build and PWA
verification passed. Project acceptance: 514 passed, 79 deselected, one known
`audioop` deprecation warning; Ruff and mypy passed. No product code, runtime
contract or generated artifact changed.

**Contracts touched:** none.

**Decisions made:** desktop parity means every current mobile route at 1100 px
and wider. The 700–1099 px phone gate stays. UI19 keeps comments globally hidden.
Each functional chunk is independently tested, released and smoke-tested; a row
becomes `DONE` only after its live evidence is recorded.

**Observations (not fixed, out of scope):** the repository already contains an
older unrelated UI17 label for compact profile counts. UI20 is used for this
roadmap so no further identifier collision is introduced.

**Blocked / needs a decision:** none.

**Next agent should know:** begin with UI20.0 only. Work from a clean worktree
based on current `origin/main`; do not modify or clean the owner's dirty local
backfill branch. Update both the roadmap dashboard and this ledger at each chunk
boundary.

## UI20.0 — Shared desktop architecture — IN PROGRESS 2026-09-03

**Built:** `web/src/desktop/route-outlet.ts` exhaustively describes every
existing `AppRoute`; `web/src/desktop/DesktopRouteOutlet.tsx` selects the released
Home feed or an honest route-specific pending surface; and
`web/src/desktop/primitives.tsx` provides the shared page, header, section,
loading/empty/error and focus-restoration primitives. `web/src/App.tsx` now uses
one route-aware desktop outlet, while explicit desktop/mobile keys force clean
surface teardown when the viewport crosses a product boundary. Desktop styling
locks the navy Pleni navigation, warm workspace, restrained dividers, visible
focus and reduced-motion behavior.

**Tests:** 77 Node tests passed, including exhaustive route descriptors, direct
hash selection, one shared focus boundary and mutually exclusive surfaces.
TypeScript, Vite production build and PWA verification passed. Project
acceptance: 514 passed, 79 deselected, one known `audioop` deprecation warning;
Ruff and mypy passed.

**Visual verification:** local 1100×720 rendered the route-specific Search
surface with navy navigation, focus on `tab:sok`, zero videos and no horizontal
overflow. Direct `#/person/alice?from=sok`, browser Back and Forward restored
the correct route heading, active navigation and focus key. At 1099×720 only the
phone gate mounted; at 390×844 only the mobile app mounted. Neither surface had
horizontal overflow.

**Contracts touched:** none. No database migration, video rendition, Bunny
object, Supabase reader or mobile product logic changed.

**Decisions made:** unsupported routes remain explicit, route-aware waiting
surfaces until their own UI20 chunk is accepted. Route data and navigation stay
owned by `App`; desktop primitives are presentation-only. UI19 comments remain
hidden.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** no product decision is blocked. Commit `2968d16`
and the UI20 roadmap commit are on `origin/main`, but both `pleni.se` and the pod
hostname still served the previous light-sidebar bundle during the immediate
post-push checks. UI20.0 remains `IN PROGRESS` until InstaPods serves the new
asset and the live desktop/mobile smoke checks pass.

**Next agent should know:** first recheck the deployed asset; do not reimplement
or repush the frontend. When the navy route-aware outlet is live, record the
production viewport evidence, move the roadmap row to `DONE`, update completion
to 2 of 9 and commit/push the documentation closeout. UI20.1 is next only after
that gate.

## UI20.1 — Politician and party desktop pages — IN PROGRESS 2026-09-03

**Built:** the route-aware outlet now exposes `person`, `person-clips`, `party`
and `party-clips` on desktop. The existing `PersonScreen`, `PartyScreen` and
`CollectionScreen` receive an explicit presentation mode, so desktop reuses the
mobile data, portrait/logo delivery, counts, follow guard and bounded
`FeedScreen` rather than cloning any business logic. Compact desktop is one
continuous column; widths from 1280 px use an editorial identity/content split.
Decorative profile share controls remain mobile-only. Session-only keyed scroll
memory restores the profile after opening a clip and stores no browsing data.

**Tests:** 79 Node tests passed, including all desktop route descriptors, shared
profile presentations, bounded collection playback and keyed/clamped scroll
memory. TypeScript, Vite production build and PWA verification passed. Project
acceptance: 514 passed, 79 deselected, one known `audioop` deprecation warning;
Ruff and mypy passed.

**Visual verification:** using the public production catalogue in the local
build, 1440×900 showed Patrik Björck's real Riksdagen portrait, role and 15 real
clips with no video mounted on the chooser. A selected clip opened the same
desktop `FeedScreen` with three video elements and one playing; Back restored a
non-zero profile scroll position. Socialdemokraterna rendered its verified logo,
1,792 real clips, 102 politicians and 60 loaded clips. The 1100×720 compact
layout stayed one column without horizontal overflow; 1280×720 used two columns
without clipping the long party name. At 390×844 only the unchanged mobile party
screen mounted, with no horizontal overflow. Signed-out Follow opened Clerk's
login dialog through the existing account guard.

**Contracts touched:** none. No Python contract, database migration, Supabase
reader, Bunny path, video rendition or account persistence changed.

**Decisions made:** identity remains the dominant visual; clips remain the main
content. The desktop layout uses cardless dividers and real media. Direct profile
clip hashes fall back to the correct person/party page, not the top-level tab.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** UI20.1 is locally complete but cannot be released
or marked `DONE` until UI20.0 is observed in production. The available Chrome
session reaches `app.instapods.com` but is signed out, so the host's stalled
auto-deploy could not be inspected or restarted.

**Next agent should know:** sign in to `app.instapods.com`, inspect/restart the
`rikettv` deployment for current `origin/main`, then close UI20.0. After that,
commit/push this UI20.1 implementation, run live person/party/profile-clip smoke
checks and close UI20.1 before beginning UI20.2.

## UI20.2 — Desktop search — IN PROGRESS 2026-09-03

**Built:** the complete public Search route now mounts on desktop through the
route-aware outlet. It reuses the existing person, party and topic state,
OpenAI privacy note, facets, ambiguity/date/fallback handling, pagination and
the bounded `CollectionScreen` for individual results and Spela alla. Compact
desktop remains one column; normal desktop places topic clips first with
identity results as secondary context. The mobile-only example “Populära
debatter” block is replaced on desktop by the real party directory.

**Tests:** 80 frontend Node tests and TypeScript pass, including direct desktop
Search routing, shared state ownership, the bounded result player and the
absence of example debate content from the desktop branch.

**Contracts touched:** none. Search requests, Supabase readers, stored state and
media contracts are unchanged.

**Decisions made:** search remains one shared component with an explicit
presentation mode. Query, interpretation, revealed result count and scroll
remain owned by the existing App state, so returning from a focused feed does
not create a second search session.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** no implementation decision is blocked. The row
remains `IN PROGRESS` because the owner asked to defer deployment and production
smoke checks until all remaining desktop chunks are implemented locally.

**Next agent should know:** continue with UI20.3 Following. Do not duplicate the
library store or account guard; the desktop list must use the same follow arrays
and mutation funnel as mobile.

## UI20.3 — Desktop Following — IN PROGRESS 2026-09-03

**Built:** the Following tab now has a real desktop presentation using the same
account-scoped politician and party IDs, profile readers and follow mutation
funnel as mobile. Signed-out visitors see an honest Clerk sign-in action rather
than an anonymous empty library. Compact desktop uses one list flow and normal
desktop places Party and Politician regions side by side when present. Row
navigation and the explicit Avfölj controls remain separate interactions.

**Tests:** 81 frontend Node tests and TypeScript pass. Focused coverage verifies
the route is available, the shared library arrays and sign-in guard are wired,
and both unfollow controls stop row navigation.

**Contracts touched:** none. Clerk identity, local library keys and Supabase
profile reads are unchanged.

**Decisions made:** the signed-out state takes precedence over the ordinary
empty state because follows are account-bound. No anonymous or example rows are
created.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** no implementation blocker. Production evidence
is intentionally deferred until the combined desktop release requested by the
owner.

**Next agent should know:** continue with UI20.4 Profile/account/onboarding,
reusing every existing account, recommendation and PWA callback.

## UI20.4 — Desktop Profile, account and onboarding — IN PROGRESS 2026-09-03

**Built:** Profile now mounts as a real desktop route with the same Clerk states,
real saved/followed totals, interest editor, personalization consent, data
export/reset/delete actions and PWA installation state as mobile. Compact
desktop keeps one ordered flow; normal desktop separates account/library from
preferences/privacy. The shared onboarding dialog gains a wider, height-bounded
desktop composition while retaining one state model and one set of callbacks.

**Tests:** 82 frontend Node tests and TypeScript pass. Focused coverage confirms
the desktop route reuses all three recommendation-data actions and the shared
primary/secondary profile structure.

**Contracts touched:** none. Clerk, recommendation, consent, export and PWA
contracts are unchanged.

**Decisions made:** Profile remains one shared screen with presentation-only
layout changes. PWA/offline/update state is still rendered once by App, never
duplicated by the desktop outlet.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** no implementation blocker. Production and
signed-in browser acceptance are deferred until all desktop chunks are ready.

**Next agent should know:** continue with UI20.5 Saved clips and legal pages.
Use the shared bounded CollectionScreen and preserve the existing legal copy.

## UI20.5 — Desktop Saved clips and legal pages — IN PROGRESS 2026-09-03

**Built:** Saved now renders the real account archive as a desktop editorial
thumbnail grid and stores its session scroll position before opening the shared
bounded `CollectionScreen`. Back returns to the archive. Terms, Privacy,
Storage and About reuse the canonical `LEGAL_PAGES` copy and hashes in a quiet,
bounded desktop reading surface with working local page navigation.

**Tests:** 83 frontend Node tests, TypeScript and the Vite production build pass;
the build still generates the nine-entry PWA app shell. Focused tests cover all
three desktop route branches, canonical legal content and saved scroll memory.

**Contracts touched:** none. Saved ordering, library guards, legal copy and
media scheduling remain shared with mobile.

**Decisions made:** the archive chooser never autoplays media; it mounts the
existing player only after a real saved clip is selected. Legal desktop changes
reading measure and typography only.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** no implementation blocker. Production smoke
tests remain deferred until the combined desktop release.

**Next agent should know:** UI20.6 must now treat every route as available,
remove the obsolete waiting fallback, standardize Escape/back/focus behavior
and run the media/overflow/mobile regression audit.

## UI20.6 — Desktop route integration and quality — IN PROGRESS 2026-09-03

**Built:** every `AppRoute` now maps to a real desktop surface and no route can
show the former “under arbete” waiting page. The outlet has one focus boundary
whose identity includes transient search-feed context. Escape closes a focused
search feed or returns one semantic level from person, party, saved and legal
routes while leaving dialogs to their own focus/close behavior. All collection
destinations continue to use the single bounded `FeedScreen`.

**Tests:** 85 frontend Node tests, TypeScript, Vite production build and PWA
verification pass. The service worker still precaches exactly nine app-shell
entries and excludes video/private data. Full project acceptance passes with
514 Python tests, 79 deselected, the known `audioop` warning, Ruff and strict
mypy over 83 source files.

**Contracts touched:** none. No data reader, account store, Python contract,
database schema, Bunny object or video rendition changed.

**Decisions made:** a missing surface is now treated as an unexpected render
error, never as an advertised unfinished desktop page. Escape is ignored when a
dialog owns the event. Top-level tabs remain stable on Escape.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** implementation and automated integration are
complete. The row remains `IN PROGRESS` until the owner-requested later visual
matrix and production smoke checks are performed.

**Next agent should know:** UI20.7 can begin with the final local acceptance
record. Do not mark any UI20 row `DONE` or push/deploy until viewport, signed-in
and live production evidence is collected.

## UI20.7 — Desktop local acceptance — IN PROGRESS 2026-09-03

**Built:** the complete desktop parity implementation is present locally across
UI20.0–UI20.6. All top-level and nested routes have real desktop destinations;
no desktop waiting page remains. The visual audit found and fixed one missing
desktop heading in the empty Saved archive.

**Tests:** 85/85 frontend Node tests pass. Frontend TypeScript, Vite production
build and PWA verification pass; the generated worker contains nine bounded
app-shell entries and no video/private data. `python tasks.py test lint
typecheck` passes with 514 tests, 79 deselected, the known `audioop` warning,
Ruff and strict mypy across 83 source files. `git diff --check` is clean after
the documentation whitespace correction.

**Local visual evidence:** 1100×720 showed the compact desktop shell and Search
without overflow; every route in the route matrix mounted a real surface.
1280×720 rendered Profile as two 436 px columns. 1440×900 rendered the Privacy
document at a 640 px reading measure. The effective 1152 px layout used by a
1440 px viewport at 125% remains in the compact-safe interval. At 1099×720 only
the phone gate mounted with zero videos; at 390×844 only the existing mobile
Profile and bottom navigation mounted. No checked viewport overflowed.

**Contracts touched:** none throughout UI20. No schema migration, media
backfill, Bunny object or pipeline contract is required.

**Decisions made:** the owner requested implementation first and review later.
Strict roadmap rows remain `IN PROGRESS` until the deployment and live evidence
are recorded.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none. Remaining work is push/deploy, real-data
media checks and Clerk signed-out/signed-in production behavior.

**Next agent should know:** push the accepted commits in order, verify the new
InstaPods asset and update each roadmap row to `DONE` with live evidence.

## UI20.8 — Light desktop navigation — DONE 2026-09-03

**Built:** restored the approved light desktop sidebar palette: warm white
background, navy Pleni identity, neutral inactive navigation and a restrained
blue-grey active state. The route structure, controls and all mobile styles are
unchanged.

**Tests:** 85/85 frontend Node tests pass. TypeScript, Vite production build and
PWA verification pass with nine bounded app-shell entries and no video/private
data. Full project acceptance passes with 514 Python tests, 79 deselected, the
known `audioop` warning, Ruff and strict mypy over 83 source files. A local
1440×900 visual check confirms the light sidebar, active-state contrast and no
horizontal overflow; 390×844 still mounts only the mobile surface.

**Contracts touched:** none. This is a desktop-only CSS and design-document
correction.

**Decisions made:** the owner explicitly selected the original light navigation
over the navy UI20 variant. `docs/DESKTOP_COMPLETION_PLAN.md` now records that
choice as the current visual thesis.

**Observations (not fixed, out of scope):** none.

**Production evidence:** commit `c1319e5` is released from `main`. A fresh
1440×900 load of `pleni.se` showed the light sidebar, navy Pleni identity,
blue-grey active Home state, real production video and the normal inspector.
A 390×844 production check mounted the mobile feed and bottom navigation only.

**Blocked / needs a decision:** none.

**Next agent should know:** the light desktop navigation is the approved
baseline. Do not restore the navy background unless the owner requests it.

## UI20.9 — Reactive account transitions — DONE 2026-09-03

**Built:** `web/src/clerk.tsx` now subscribes directly to Clerk's settled user
and session emissions instead of depending only on a later context render. One
shared viewer identity drives the desktop sidebar, Profile, Following, saved
library guards, onboarding and recommendation-token access. Transitional
undefined resources retain the last settled UI; complete sign-in and sign-out
events update it immediately. `ProfileScreen` and `AccountCard` no longer use a
second independent signed-in conditional, and signed-in profile copy reads the
current Clerk client resource. The pure reducer lives in
`web/src/auth/viewer-identity.ts`.

**Tests:** four focused account-reactivity checks cover initial state,
transitional loading, sign-in, sign-out, live token lookup and the shared
Profile state. All 89 frontend Node tests pass. TypeScript, Vite production
build and PWA verification pass with nine bounded app-shell entries and no
video/private data. Full project acceptance passes with 514 Python tests, 79
deselected, the known `audioop` warning, Ruff and strict mypy over 83 source
files.

**Contracts touched:** none. Clerk, Supabase, local-library and recommendation
data formats are unchanged.

**Decisions made:** update React from Clerk's documented client listener rather
than automatically reloading the page. This preserves the active route, video
position and unsaved UI state while still removing the manual-refresh defect.

**Observations (not fixed, out of scope):** none.

**Production evidence:** commit `02947c2` is released from `main` as
`assets/index-CsWv4FpT.js`. A fresh signed-out 1440×900 Profile load showed the
login/create-account state. The owner's existing signed-in Chrome session,
loaded against the same new asset, immediately showed `Mitt konto`, the Profile
identity and e-mail, sign-out, account-scoped library totals and the enabled
personalization state. The session was not signed out solely for testing.

**Blocked / needs a decision:** none.

**Next agent should know:** account UI must continue to derive from the shared
`useViewer()` identity. Do not reintroduce a separate Clerk `<Show>` branch in
Profile or replace the listener with a forced page reload.
## SEO — Search indexing roadmap — REGISTERED 2026-09-03

**Built:** `docs/SEO_PLAN.md`, the authoritative tracker for making the
catalogue discoverable in Google and Bing. It divides the work into SEO0-SEO8
with dependencies, locked decisions, per-chunk acceptance criteria and a
four-state dashboard.

**Tests:** documentation only in this entry; the gates are recorded under SEO0
below. `git diff --check` clean.

**Contracts touched:** none.

**Decisions made:** the SEO surface is prerendered static HTML generated after
`vite build` from Supabase's publishable key, one file per public URL. Identity
always occupies its own final path segment. `pleni.se` apex is canonical. The
swipe feed is unchanged for humans. See `docs/adr/014-prerendered-seo-surface.md`.

**Observations (not fixed, out of scope):** `docs/DESKTOP_COMPLETION_PLAN.md`
still shows UI20.0-UI20.7 as `IN PROGRESS` awaiting an InstaPods gate that
UI20.8's released commit `c1319e5` has since passed. Those rows look stale
rather than blocked. Not touched — it belongs to whoever closes UI20.

**Blocked / needs a decision:** none.

**Next agent should know:** start at SEO0, then SEO1+SEO2 together. SEO4 is
deferred on missing data, not blocked, and nothing depends on it.

## SEO0 — Crawl foundation, host facts and baseline — IN PROGRESS 2026-09-03

**Built:** `web/public/robots.txt`; an expanded `web/index.html` head with
canonical, Swedish description, Open Graph/Twitter tags and a `WebSite` +
`Organization` JSON-LD graph; `web/tests/seo-foundation.test.mjs`;
`docs/adr/014-prerendered-seo-surface.md`.

**Tests:** 93 frontend Node tests pass, up from 85 — the eight new ones are the
SEO0 guardrails. TypeScript passes. The Vite production build passes and the
generated worker still precaches **exactly 9 entries**; `robots.txt` does not
enter the manifest because `txt` is absent from `globPatterns`. Project
acceptance passes: 514 Python tests, 79 deselected, the known `audioop`
warning, Ruff clean, strict mypy over 83 source files.

**Local verification:** the built `dist` was served on 127.0.0.1 and loaded at
375x812. The app mounted with the new head, the tab title read
"Pleni — riksdagsdebatter som korta klipp", and the feed correctly reported no
network because the local build carries no `VITE_*` values (ADR 006 degraded
path). The built JSON-LD parses and its `publisher` reference resolves. One
console error — "An unknown error occurred when fetching the script" — was
reproduced identically from a build of the unmodified `index.html`, so it is a
property of the bare `python -m http.server` harness, not this change.

**Contracts touched:** none. No routing, service worker, migration, pipeline or
feed code changed.

**Host facts measured against production 2026-09-03** (full evidence in ADR 014):

- `https://pleni.se/klipp/test` returns **404**. nginx 1.24.0 serves files with
  **no SPA fallback**, so a path without a file cannot be indexed or even
  deep-linked. This is why SEO1 must not ship before SEO2.
- The apex, `www.pleni.se` and `rikettv.nbg1-3.instapods.app` all return 200
  with byte-identical bodies (md5 `ee351be0...`) and no `Location`. No
  `Cache-Control`, no `X-Robots-Tag`. Absolute canonical links are the only
  deduplication mechanism available.
- **5 514 published clips**, 364 politicians, 377 debates — about 6 260 pages
  including hubs.
- **`clips.topic` is null for all 5 514 clips.** SEO4 is deferred, not blocked.
- `https://riketnlooigm.b-cdn.net/robots.txt` returns 404, which grants
  Googlebot access to the MP4s rather than denying it.
- `https://pleni.se/robots.txt` returned 404 before this chunk.

**Decisions made:**
- No `SearchAction` / sitelinks searchbox. `web/src/search/route.ts` keeps query
  text in React memory and out of the URL by design, so there is no endpoint a
  searchbox could resolve.
- No `Sitemap:` line in `robots.txt` yet; it lands in SEO5 with the sitemap it
  names, rather than pointing a crawler at a 404.
- `twitter:card` is `summary`, because the brand mark is square (1254x1254).
  Watch pages will use a player card with the clip's own vertical thumbnail.

**Observations (not fixed, out of scope):**
- `src/scoring/titles.py` produces truncated sentence fragments — a sampled
  title is "Kriget i Iran och stangningen av Hormuzsundet har inneburit". That
  reads acceptably as a feed overlay and poorly as an indexed `<title>` under a
  named politician's byline. SEO2 must compose page titles from speaker, party
  and `sources.title` rather than trusting the clip title. Not a defect in the
  feed; do not change the pipeline for it.
- `speaker_name` and `politicians.name` carry a role prefix and the
  parenthesised party, e.g. "Infrastruktur- och bostadsministern Andreas
  Carlson (KD)". Name slugs must strip both.
- Sampled `clip_id`s contain hyphens inside the Riksdagen GUID, e.g.
  `HD10533_47a16b6f-7d66-f111-8b6f-6805cafea079_c01`. The plan's separate
  id segment is required, not merely tidier.

**Blocked / needs a decision:** nothing blocking implementation. Two items need
the owner, and neither stops SEO1/SEO2:
- Search Console and Bing Webmaster verification require the owner's accounts.
- Nothing has been pushed or deployed. The commit is local.

**Next agent should know:**
- `node_modules` is absent from a fresh worktree; run `npm ci` in `web/` first
  or every React-importing test fails with `ERR_MODULE_NOT_FOUND`.
- Port 5199 was occupied by another process, so the launch config's dev server
  was not used; the built `dist` was served on a spare port instead.
- SEO0's remaining acceptance is deploy plus owner verification. SEO1 and SEO2
  can begin immediately and must land in one deploy.

## SEO1 — Path routing alongside hash — IN PROGRESS 2026-09-03

**Built:** `routeFromPath`, `pathForRoute`, `initialRoute` and
`APP_SHELL_ROUTES` in `web/src/navigation.ts`; `useAppNavigation` now writes
real paths with `pushState` and rewrites a legacy hash URL once with
`replaceState`; a `popstate` listener in `web/src/pwa/usePwaExperience.ts`;
`web/tests/path-routing.test.mjs`.

**Tests:** 10 new routing tests inside a suite that went from 93 to 121 with
SEO2. Every canonical path round-trips (`pathForRoute(routeFromPath(p)) === p`),
every legacy hash route resolves to the identical route object, malformed paths
fail home without throwing, and party paths accept only the eight real codes.
TypeScript passes.

**Contracts touched:** none. `AppRoute` is unchanged, so `App.tsx` and the
desktop route outlet needed no edits at all.

**Decisions made:**
- Politician and party paths carry **no decorative slug**: `/politiker/<uuid>`
  and `/parti/<kod>`. The app pushes these URLs and only ever holds the id, so a
  slug would give one entity two URLs and one page two history entries — and
  every pushed URL needs a generated file because the pod 404s the rest. This
  amends the original scheme in ADR 014; the amendment is recorded there.
- The home feed keeps its mode in the path (`/` and `/senaste`) rather than a
  query, and default query values are omitted, so each route has exactly one
  canonical path.
- A legacy hash is honoured only in its original shape — a hash route at the
  site root — so a real path route can never be overridden by a stray fragment.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none. SEO1 must not deploy without SEO2,
because a path with no generated file 404s on the pod.

**Next agent should know:** `APP_SHELL_ROUTES` in `navigation.ts` and the
`APP_SHELLS` list in `web/seo/prerender.mjs` must stay in agreement; a test
fails if a pushable route has no generated shell.

## SEO2 — Prerendered clip watch pages — IN PROGRESS 2026-09-03

**Built:** `web/seo/lib.mjs` (pure helpers), `web/seo/templates.mjs` (page
templates), `web/seo/prerender.mjs` (the generator),
`web/tests/seo-prerender.test.mjs`, a `prerender` script and an extended
`build` script in `web/package.json`, and the updated InstaPods build command in
`AGENTS.md` and `README.md`.

**Tests:** 121 frontend Node tests pass, up from 93. TypeScript passes. The Vite
production build passes and the generated worker still precaches **exactly 9
entries** — verified by counting `{"revision":…}` records in `dist/sw.js` after
the prerender wrote 6 139 HTML files. Project acceptance passes: 514 Python
tests, 79 deselected, the known `audioop` warning, Ruff and strict mypy over 83
source files.

**Generated against production data 2026-09-03:**
- **5 514 clip watch pages, 0 skipped**, across 377 debates.
- 10 app shells and 614 entity shells (299 politicians with clips × 2 routes,
  plus 8 parties × 2).
- 6 139 `index.html` files in `dist` including the root.

**Degradation verified:** with `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`
unset the generator writes the 10 app shells, logs, and **exits 0**; with an
unreachable Supabase host it logs `clip fetch failed` and **exits 0**. A failed
prerender cannot fail a deploy, which is the ADR 006 rule.

**Local verification:** a real interpellation watch page was served and loaded at
375×812. It rendered the brand, breadcrumbs, `<h1>`, byline, the Bunny WebP
poster, the facts list, the full transcript, the Riksdagen source link, the
onward links and the related-clips list. Title read "Andreas Carlson (KD) om
Stöd till kollektivtrafiken — 12 juni 2026 | Pleni".

**Contracts touched:** none. No pipeline code, migration, Bunny path, render
geometry, service worker or feed logic changed.

**Decisions made:**
- **Watch pages do not boot the SPA.** No `<div id="root">`, no module script —
  asserted by test. That removes the content-parity/cloaking risk completely and
  makes the poster the LCP element. Closing the swipe-feed gap for a Google
  visitor is registered as its own chunk, SEO2b.
- **Shell pages are the built `index.html` patched**, not a reconstructed
  document, so hashed asset URLs, icons, the manifest link and PWA metadata stay
  correct as the build changes. `replaceOnce` throws if `index.html`'s head stops
  matching, so a future head change fails in tests rather than shipping shells
  that carry the home page's canonical.
- **Entity shells are `noindex, follow`** until SEO3 gives them real content. 614
  identical JavaScript-dependent pages would be duplicate thin content.
- Titles say "om" for a debate subject and "i" for a chamber sitting. Measured:
  335 of 377 debates carry a real subject, 38 are "Frågestund", so
  "Andreas Carlson om Frågestund" had to become "i Frågestund".
- Related-clip anchor text uses the clip's own title, not the speaker name.
  Several clips from one speaker in one debate is the normal case and
  `name (party)` repeated six times is useless as anchor text.
- No new dependency. The generator uses Node's built-in `fetch`, matching the
  app's own raw-PostgREST approach.

**Observations (not fixed, out of scope):**
- 299 of 364 politicians have at least one published clip. The other 65 get no
  page, which is correct.
- `clips.title` remains a truncated fragment. It is used for anchor text and
  never for a page title. Fixing the generator's input belongs to the pipeline.

**Blocked / needs a decision:** none.

**Next agent should know:**
- **Run the prerender AFTER `vite build`, never before.** `vite.config.ts` globs
  `**/*.html`, so HTML written first turns the nine-entry app shell into one
  entry per clip. `npm run build` in `web/` has the right order.
- The InstaPods build command now also removes the previous deploy's generated
  route roots before copying, so an unpublished clip cannot keep a live page.
  **That command must be updated in the InstaPods panel — editing `AGENTS.md`
  changes documentation only.**
- A full prerender over 5 514 clips takes a few seconds after the build; the
  Supabase read is 12 paged requests of 500 rows.
- SEO5 is the natural next chunk: the URL set now exists, so the sitemaps have
  something to list. SEO3 upgrades the entity shells in place.

## SEO3, SEO5, SEO6-SEO8 — hubs, sitemaps and refresh — IN PROGRESS 2026-09-03

**Built:** `web/seo/hubs.mjs` (politician, party and debate pages),
`web/seo/sitemaps.mjs` (video sitemap, plain sitemaps, sitemap index),
`renderStaticPage` and the JSON-LD/prerender injection in
`web/seo/templates.mjs`, hub and sitemap wiring plus `fetchAll`/`groupBy` in
`web/seo/prerender.mjs`, `.github/workflows/seo-refresh.yml`, two new CI steps,
`web/tests/seo-hubs-sitemaps.test.mjs`.

**Tests:** 132 frontend Node tests pass, up from 121. TypeScript passes. The
Vite build passes and the worker still precaches **exactly 9 entries** after the
prerender writes 6 516 HTML files and 8 XML files. Project acceptance passes:
514 Python tests, 79 deselected, the known `audioop` warning, Ruff and strict
mypy over 83 source files.

**Generated against production data 2026-09-03:**
- 5 514 clip watch pages, 0 skipped.
- **377 debate pages**, fully static.
- **307 hubs** (299 politicians with clips + 8 parties) with real prerendered
  content, plus 307 `noindex` `/klipp` sub-route shells.
- 10 app shells. 6 516 pages in total.
- **Sitemap index + 7 children, 6 205 URLs.** Every file parses as XML, the
  largest is 2.06 MB against a 50 MB limit, and the largest shard holds 2 000
  URLs against a 50 000 limit. 27 sampled URLs including the first and last
  each resolve to a real file on disk.

**Local verification:** `/parti/kd` served the SEO title, then React replaced
the prerendered list with the real Pleni party screen — KD's verified logo,
873 klipp, 26 politiker, real thumbnails. `/debatt/stod-till-kollektivtrafiken/HD10533`
rendered fully static: "12 juni 2026 · 14 klipp · 4 talare", clips grouped under
each speaker with the politician's name linking to their hub.

**Contracts touched:** none.

**Decisions made:**
- **Politician and party hubs are app shells with prerendered content inside
  `#root`.** React clears the container on mount, so a direct visit still gets
  the real app screen while a crawler gets identity, counts and 60 real links to
  watch pages. Both render the same entity from the same rows, so this is
  progressive enhancement rather than a second version of the page. Debate pages
  are fully static because the app has no debate route to hand over to.
- **Hubs list the 60 most recent clips instead of paginating.** Query-string
  pagination cannot work on a host that serves files — `/parti/m?sida=2` and
  `/parti/m` are the same file — so pagination would need real `/sida/<n>`
  paths. The sitemap is the complete index; a hub's job is clustering and crawl
  depth. Build real pagination only if the sitemap proves insufficient.
- The `/politiker/<id>/klipp` and `/parti/<kod>/klipp` routes stay
  `noindex, follow` and canonicalise to their hub. They are routes the app
  pushes, not separate pages worth indexing.
- `robots.txt` gains its `Sitemap:` line from the generator, not from the source
  file, and only after the index is actually written. A build that cannot reach
  Supabase therefore ships no sitemap and no pointer to one.
- `<lastmod>` keeps a bare `YYYY-MM-DD` as a bare date rather than inventing a
  time the row never carried.
- SEO6 calls an InstaPods deploy hook if `INSTAPODS_DEPLOY_HOOK` is set and
  otherwise does nothing but explain itself. It deliberately does **not** fall
  back to a bot pushing commits to `main` on a schedule; that is the owner's
  decision and the workflow says so in its header.

**Observations (not fixed, out of scope):**
- 65 of 364 politicians have no published clip and get no page. Correct.
- Hub pages carry two JSON-LD blocks: the site-level `Organization`/`WebSite`
  inherited from `index.html` and the hub's own graph. Their `@id`s differ, so
  they do not conflict.

**Blocked / needs a decision:** nothing blocking code. Four owner actions
remain, listed in the next section.

**Next agent should know:**
- SEO2b is the only unbuilt chunk that is not deferred: an in-app `clip` route
  so a Google visitor can continue into the feed instead of following a link.
- CI now runs the prerender in its degraded path and asserts the 9-entry
  precache, so the ordering trap fails in CI rather than in production.
- The Chrome extension was not connected during this session
  (`list_connected_browsers` returned empty), so the InstaPods panel could not
  be inspected or changed.

## SEO follow-up — readable slugs in every URL — IN PROGRESS 2026-09-03

**Built:** `partyPathSlug`, `personPathSlug` and slug-aware path parsing in
`web/src/navigation.ts`; an optional decorative `personSlug` on the `person` and
`person-clips` routes; a URL-upgrade effect in `web/src/App.tsx`;
`politicianPath`, `partyPath`, `partyPathForCode` and `PARTY_NAMES` in
`web/seo/lib.mjs`, with every internal link, breadcrumb and sitemap entry
switched to the canonical form; two new tests including the slug drift guard.

**Tests:** 136 frontend Node tests pass, up from 132. TypeScript passes. The
Vite build passes and the worker still precaches exactly 9 entries. Project
acceptance passes: 514 Python tests, 79 deselected, Ruff and strict mypy over 83
source files.

**Why this reverses an earlier decision.** The first ADR 014 amendment dropped
the slug from politician and party paths, reasoning that the app pushes those
URLs and holds only the id. That was an over-correction. The app does not need
the slug at navigation time: it pushes `/politiker/<id>`, and when the profile
row arrives `App` replaces the URL with `/politiker/<namn-slug>/<id>`. The owner
pushed back on losing the slug and was right to.

**Generated against production 2026-09-03:** 5 514 watch pages, 377 debate
pages, 307 hubs and 929 shells — the shell count rose from 307 because each
politician and party now has both the canonical slug path and the id/code alias,
plus their `/klipp` sub-routes. Sitemaps list the canonical form only.
`/parti/kd` canonicalises to `/parti/kristdemokraterna`;
`/politiker/<id>` canonicalises to `/politiker/andreas-carlson/<id>`.

**Local verification:** loading `/politiker/490b6787-…` upgraded the URL to
`/politiker/andreas-carlson/490b6787-…`, history grew by exactly one entry for
the navigation rather than two, and Back landed on `/senaste` instead of the
id-only form. `/parti/moderaterna` served the party hub.

**Contracts touched:** none. `AppRoute` gained an optional decorative field;
identity is still `personId`, and every comparison in the app keys on it.

**Decisions made:**
- Both URL forms are generated and the alias canonicalises to the slug form, so
  a URL the app pushed before the row arrived can be reloaded or shared without
  a 404 and without competing in the index.
- `personPathSlug` (TypeScript, in the bundle) and `slugify` (plain Node, in the
  build) are separate implementations with a drift test over real Swedish names,
  following the same pattern as the search ranking constants. There is no shared
  module because the two run in different toolchains.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Next agent should know:** if you change either slug function, the drift test
in `web/tests/path-routing.test.mjs` is the one that fails. Fix both sides; do
not relax the test.

## SEO production release — IN PROGRESS 2026-09-03

**Released:** merged the four SEO commits into current `origin/main` as
`3a4101e`, changed the InstaPods `rikettv` build command to run
`node seo/prerender.mjs` after Vite and clean every generated route before the
copy, then deployed. The first full SEO build completed successfully in 32
seconds. A production-only nginx directory redirect defect was fixed in
`6f3e8e8` (`chunk(SEO5): canonicalize static directory URLs`); its automatic
deployment completed successfully in 36 seconds.

**Production evidence:**
- `https://pleni.se/robots.txt` returns direct 200 and names
  `https://pleni.se/sitemap.xml`.
- `https://pleni.se/sitemap.xml` returns direct 200 and lists exactly seven
  child sitemaps.
- `https://pleni.se/klipp/andreas-carlson-stod-till-kollektivtrafiken/HD10533_47a16b6f-7d66-f111-8b6f-6805cafea079_c01/`
  returns direct 200. Its static document has a video, a 772-character
  transcript, a Riksdagen link, no module script and no React root; it therefore
  works with JavaScript disabled.
- `https://pleni.se/parti/moderaterna/`,
  `https://pleni.se/politiker/andreas-carlson/490b6787-c178-42e1-9ab8-e9d233939643/`
  and `https://pleni.se/debatt/stod-till-kollektivtrafiken/HD10533/` each return
  direct 200.
- A fresh `https://pleni.se/#/party/M` load rewrites to
  `https://pleni.se/parti/moderaterna/`.
- At 390×844 the homepage loaded 60 feed rows, kept three video elements and
  played the active one (`readyState=4`, time advancing); the directional media
  window is unchanged.
- The `pleni.se` domain property is accessible in Google Search Console.
  `https://pleni.se/sitemap.xml` was submitted on 2026-09-03 and Google reports
  it as a successfully read sitemap index. The first report still shows zero
  discovered pages and videos while the new property data is processing.
- URL Inspection reports `https://pleni.se/` as indexed. This confirms the
  SEO0 baseline of **1 indexed URL** at submission time; the aggregate Pages
  report says to check again after processing.
- URL Inspection initially reported the representative watch URL above as
  unknown to Google. Its live test then passed with “URL is available to
  Google” and “Page can be indexed”, after which an indexing request added it
  to Google's priority crawl queue.
- The same live test detected the video and one valid `VideoObject`, including
  its `.webp` `thumbnailUrl`, MP4 `contentUrl`, canonical URL and transcript.
  The WebP thumbnail is accepted; no JPEG C10 change is indicated.

**Tests:** merged release and slash-canonical hotfix both passed the full gates:
514 Python tests with 79 deselected and the known `audioop` warning, Ruff,
strict mypy over 83 files, 140 frontend Node tests, TypeScript and Vite. A full
production-data prerender wrote 5 514 watch pages, 377 debate pages, 307 hubs,
929 shells, 7 130 HTML files and eight XML files. The service worker precaches
exactly nine entries.

**Contracts touched:** none.

**Decisions made:**
- Every generated directory URL is slash-canonical. The first production
  activation showed that nginx redirects a slashless HTTPS directory to an
  absolute HTTP URL, then redirects back to HTTPS. Slash URLs return 200
  directly. Canonicals, sitemaps, internal links and app navigation now emit
  the slash form; parsers still accept old slashless inbound links. ADR 014's
  third amendment records the measured host behaviour.
- The scheduled workflow still does not push fallback commits. The signed-in
  InstaPods pod Git settings and Integrations panel expose no deploy-hook URL,
  and the official Git deployment documentation offers only a bearer-token API
  endpoint for manual deploys. Any alternative needs an explicit owner decision.

**Observations (not fixed, out of scope):**
- The first full deploy exposed InstaPods' insecure absolute directory redirect
  only for missing trailing slashes. Pleni-generated URLs no longer traverse
  it; changing nginx itself is unavailable in the panel.

**Blocked / needs a decision:**
- Bing Webmaster Tools sign-in, site verification and sitemap submission were
  explicitly deferred by the owner on 2026-09-03.
- SEO6 needs an owner-approved authenticated InstaPods API strategy or an
  explicit decision to remain manual; no panel deploy hook exists.

**Next agent should know:** Google Search Console is complete for launch. Recheck
the sitemap's discovered-page/video counts after Google's processing delay, and
submit the sitemap to Bing when the owner resumes that work. Do not expose any
future InstaPods API token in logs or documentation. SEO8's four-week comparison
date is 2026-10-01.

## SEO0 — Homepage search metadata refresh — DONE 2026-09-03

**Built:** `web/index.html` now uses the owner-selected title
“Riksdagsdebatter i kortformat | Pleni” and description “Upptäck aktuella frågor
och uttalanden från Sveriges riksdag genom korta, tydliga videoklipp med
källhänvisning.” The same identity is synchronized across Open Graph,
Twitter/X and the `WebSite` JSON-LD. `web/seo/templates.mjs` gives indexable
pages unlimited snippet/video previews and large image previews, adds image
type/alt metadata, uses a valid `summary_large_image` card for watch pages, and
replaces every shell's social title and description instead of leaving the
homepage values behind. Private shells still carry one `noindex, follow` tag.

**Tests:** 514 Python tests passed with 79 deselected and the known `audioop`
warning; Ruff and strict mypy passed. All 140 frontend Node tests, TypeScript
and Vite passed. The production-data prerender wrote 7 130 HTML and eight XML
files; the service worker still precaches exactly nine entries.

**Contracts touched:** none.

**Production evidence:** InstaPods deployed `06a2486` successfully in 38
seconds. `https://pleni.se/` returned 200 with the selected title and
description, matching `og:title` and `twitter:title`, plus the preview robots
policy. `https://pleni.se/parti/moderaterna/` carries its own social title and
description, `https://pleni.se/profil/` carries exactly one `noindex, follow`,
and the representative Andreas Carlson watch page uses
`summary_large_image` with a descriptive image alt. Google Search Console then
accepted `https://pleni.se/` into its priority crawl queue for omindexing.

**Decisions made:** no `keywords`, invented social account, SearchAction or
other decorative metadata was added. Google recommends concise titles, useful
descriptions and consistent `WebSite` naming; preview directives explicitly
allow the rich image/video treatment Pleni's content supports.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none for this refresh. Google controls the
displayed title and snippet and may take several days to recrawl the page.

**Next agent should know:** the homepage metadata strings are guarded by
`web/tests/seo-foundation.test.mjs`; shell identity replacement and watch-card
metadata are guarded by `web/tests/seo-prerender.test.mjs`.

## SEO0 — Search favicon and concise homepage title — DONE 2026-09-04

**Built:** `web/index.html` now uses the exact homepage title
“Riksdagsdebatter i kortformat” across the document, Open Graph and Twitter/X
metadata. `web/public/favicon-pleni-20260904.png` is a 96×96, 7 KB browser and
Google Search favicon derived from the latest approved white Pleni mark on its
blue edge-to-edge field. `web/seo/templates.mjs` gives every prerendered page
the same stable favicon URL. The PWA verifier and favicon/SEO tests guard the
new asset, dimensions and links. The superseded 32 px favicon remains available
to existing clients but is excluded from the service-worker precache.

**Tests:** 514 Python tests passed with 79 deselected and the known `audioop`
warning; Ruff and strict mypy passed. All 140 frontend Node tests, TypeScript
and Vite passed. The production-data prerender wrote 7 130 HTML and eight XML
files; the service worker still precaches exactly nine entries.

**Contracts touched:** none.

**Production evidence:** InstaPods deployed `e1e1ddc` successfully in 4m 9s.
`https://pleni.se/` returned 200 with the exact title and the versioned 96 px
favicon link. `https://pleni.se/favicon-pleni-20260904.png` returned 200 as
`image/png` with 7 238 bytes, and the representative Andreas Carlson watch page
also referenced it. Google Search Console reported the homepage as indexed and
accepted it into the priority crawl queue after this release.

**Decisions made:** kept the latest approved Pleni artwork unchanged, resized
it to Google's recommended 48 px multiple and used a new stable URL so browser
and crawler caches do not keep selecting the older favicon. The WebSite and
Organization identity still name Pleni; only the visible homepage result title
was shortened per the owner's wording.

**Observations (not fixed, out of scope):** the full SEO deployment now takes
4m 9s because it publishes 7 130 HTML files. It completed without timeout or a
file-limit error.

**Blocked / needs a decision:** none. Google controls when search results are
recrawled and may continue to show its cached favicon/title for days or weeks.

**Next agent should know:** the current search favicon URL is deliberately
versioned. Do not reuse that URL for different artwork; publish another stable
versioned URL and request homepage reindexing instead.

## SEO2b — Watch-page entry into För dig — DONE 2026-09-04

**Built:** `/klipp/<slug>/<clip_id>/` is now a first-class public app route.
The prerender still sends the complete video, transcript, facts, primary-source
link, social metadata and `VideoObject` before JavaScript, then boots the same
bounded `FeedScreen` used by Pleni. The selected clip is first and the normal
För dig slate continues underneath it without duplicating that clip. A safe
embedded clip payload removes the initial data round trip; an anonymous exact-id
read in `web/src/supabase.ts` is the fallback for missing or stale payloads.

**Tests:** all 144 frontend Node tests passed; TypeScript passed; the Vite
production build passed; `verify-pwa-build.mjs` confirmed exactly nine precache
entries and no video/private data. The full repository gate passed: 514 Python
tests, 79 deselected, the known `audioop` warning, Ruff clean and strict mypy
clean over 83 source files.

**Production evidence:** InstaPods deployed `b9b4ec1` successfully in 7m 43s.
The exact owner-reported URL
`https://pleni.se/klipp/andreas-carlson-en-tunnel-under-sodertalje-kanal/HD10184_41_c01/`
opened in the desktop För dig surface with `HD10184_41_c01` as the first clip,
played with time advancing, loaded 61 feed rows and enabled navigation. Moving
to the next clip activated Ebba Busch's “Halvledare avgörande för Sveriges
framtid som industrination”; three video elements were mounted before the move
and four after it, preserving the bounded media window. Three additional
sitemap-selected production pages (`HBC120240116sd_1_c01`, `HD10124_25_c03`,
`HD10209_19_c01`) each had exact agreement between final route id, static video
`src`, bootstrap `videoUrl` and `VideoObject.contentUrl`, plus a non-empty
transcript, Riksdagen source, React root and production module.

**Contracts touched:** none.

**Decisions made:**
- The watch page upgrades directly into the normal For You surface, including
  bottom navigation, instead of a one-video collection that would still be a
  product dead end.
- The final clip-id path segment is authoritative. The title slug is decorative,
  and the prerendered payload is accepted only when its id matches the route.
- The original static article remains fully functional without JavaScript. Its
  structured data and social metadata are retained while the built app module
  provides progressive enhancement.
- No feed gesture, snap or media-policy file changed; the four-source scheduling
  limit remains owned by the existing player.

**Observations (not fixed, out of scope):** the checked-in local frontend env has
only the Clerk development key, so a local full-catalogue prerender cannot query
Supabase. The generator's real-row shape and no-environment fallback are covered
by tests; the production deploy supplies the public Supabase values.

**Blocked / needs a decision:** none.

**Next agent should know:** `web/src/clip-entry.ts` is the trust boundary for the
embedded payload. Keep route identity authoritative and never let a slug or
unvalidated JSON choose the clip. Generated clip HTML must continue to be
written only after the Vite build so it stays outside the service-worker cache.

## UI20.1b — Desktop politician and party pages redesigned — DONE 2026-09-04

**Built:** `web/src/App.tsx` (`DesktopProfileBar`, `DesktopProfileFacts`,
`DesktopRailFact`, `DesktopRailPerson`, `DesktopClipGallery`, desktop branches
of `PersonScreen` and `PartyScreen`), `web/src/styles.css` (`.desktop-profile-*`,
`.desktop-gallery-*`, `.desktop-rail-*`), `web/tests/desktop-profile.test.mjs`.

**Why:** the desktop profile surfaces were the released mobile markup with two
class modifiers on. Measured at 1440×900 before the change: the hero was
`max-width: 760px` inside a 1210 px workspace (37% of the row beside the name
empty), `.desktop-profile-toolbar` reserved 78 px for a lone Back button, the
section heading read “Antal klipp: 112” where a heading belonged, the party hero
was a 10% colour wash, and a party's politician list sat below the whole clip
grid, roughly 1100 px down.

**What it is now:** a 56 px context bar with a breadcrumb; a full-width masthead
on `#fbfbf9` carrying an upright 176×220 portrait (or a 132 px party mark), the
name at up to 52 px, the party line, a fact strip and two actions; then a
gallery beside a side column. `Spela alla klipp` is the primary action and opens
the existing `person-clips` / `party-clips` collection through the same
`FeedScreen`; desktop previously had no way to start a profile's feed at all.
The gallery is three tiles across with the newest clip leading in full sentence
form, and it scrolls inside its own frame so the masthead and side column stay
put. The side column carries the facts, the party card and party colleagues on a
person page, and the membership list — moved up from the page foot — on a party
page.

**Tests:** 8 new frontend tests in `web/tests/desktop-profile.test.mjs`; two
assertions in `desktop-route-outlet.test.mjs` updated from `.person-scroll` to
`.desktop-profile-scroll`. All 152 frontend Node tests pass, TypeScript passes,
the Vite production build passes and still precaches exactly nine app-shell
entries. Repository gate green: 514 Python tests, 79 deselected, the known
`audioop` warning, Ruff clean, strict mypy clean over 83 source files.

**Local verification:** politician and party routes checked at 1100, 1280, 1440,
1920 and 375 px against a temporary local reader stub (reverted; not committed),
because the checked-in local env has no Supabase key. No console errors and no
horizontal page overflow at any width. At 1440 px the tiles measure 231×410, the
gallery frame is 1366 px tall — 3.2 rows — over 3332 px of content, and its
scrollbar renders. `Spela alla klipp` navigated to `/parti/moderaterna/klipp/`
with two video elements mounted and none playing until activation; Back restored
the party page with its scroll position and unmounted the media. The mobile
profile rendered byte-identically to the released product at 375 px.

**Contracts touched:** none. No migration, no new reader, no new render size.

**Decisions made:**
- The gallery's height is `aspect-ratio: 1 / 1.82` rather than a pixel value, so
  three whole rows survive every desktop width instead of only the one the
  design was measured at. The frame is applied only above nine grid tiles, so a
  short catalogue renders a plain grid instead of a tall box of empty space.
- The side column's width is `clamp(296px, 23vw, 336px)` with a matching gap. A
  fixed 336 px rail at the 1280 px breakpoint took the three tiles down to
  185 px — narrower than they are one breakpoint below.
- A profile route is not a tab, so `DesktopSidebar` receives `Tab | null` and
  lights nothing. It previously kept the last visited tab lit, so `Sök` stayed
  highlighted while the viewer read a politician page.
- The person page's side column reuses `loadPoliticiansForParty()` keyed on the
  party, and takes the party card from the `party_profiles` read that already
  runs at startup — one extra request per party, none per person.
- Only counts the catalogue reports reach the masthead. `clipCount` and
  `politicianCount` are `null` when the count request failed and are then
  absent, never zero. The party page's “Visas här” statistic is gone from
  desktop: it counted the rows that happened to load.
- The upright portrait is a deliberate departure from the circular avatar used
  in the feed, search and Följer. Riksdagen's official portraits are upright and
  a circle crops the shoulders out of them.
- Mobile is untouched. Every rule is inside `@media (min-width: 1100px)` and
  both screens keep their existing mobile branch verbatim.

**Observations (not fixed, out of scope):** `web/vite.config.ts` sets
`envDir: ".."`, so a local `web/.env.local` is silently ignored — env files
belong at the repository root. This cost a debugging cycle and is worth a line
in the runbook.

**Blocked / needs a decision:** none.

**Production verification:** live at `pleni.se` on commit `9822b9b`. At
1440×900, Adam Reuterskiöld's canonical profile rendered the verified Bunny
portrait at 192 px intrinsic width, the Moderaterna party card, four catalogue
clips and the colleagues rail. The document matched the viewport width and the
browser console had no errors.

**Next agent should know:** the real portrait, party-card and desktop-layout
gaps from local verification are closed. Signed-in follow actions were not
exercised because production verification deliberately did not authenticate as
the owner.

## UI20.2b — Desktop search: party roll-downs — DONE 2026-09-04

**Built:** `web/src/App.tsx` (`DesktopPartyDirectory`, `PARTY_MEMBER_LIMIT`,
`SearchScreen` wiring), `web/src/styles.css` (`.party-directory-*`,
`.party-menu-*`), `web/tests/search-party-directory.test.mjs`.

**Why:** the desktop search page asked for the party twice. The header carried
eight letter chips (`.chips`, a 7 px colour dot plus an abbreviation) that set
`partyFilter`; the body carried `<Group title="Riksdagspartier">` with the same
eight parties, ~550 px further down, navigating to the party page instead.
Nothing in either appearance said which did what, and the one carrying the
verified party mark and the whole name was the one below the fold. Ledamöter
were not reachable from search at all — mobile has that list on the party page,
desktop had no equivalent.

**What it is now:** one row of eight party buttons in the body, carrying the
same `PartyAvatar` (the content-addressed `party_profiles.logo_url` mark, with
the party-coloured letter as its fallback) and the full party name that the
removed list used. Each opens a roll-down with two actions — *Öppna partisidan*
and *Visa klipp från X* — above the party's politicians, fetched once per party
with `loadPoliticiansForParty()` and scrolling inside the panel. The compact
chip row is now the results state only, so the two never share the screen; its
unlabelled house icon reads "Alla partier" on desktop.

**Tests:** 8 new frontend tests in `web/tests/search-party-directory.test.mjs`;
one assertion in `desktop-route-outlet.test.mjs` moved from the removed
`Riksdagspartier` group to the directory. All 160 frontend Node tests pass,
TypeScript passes, the production build passes and still precaches exactly nine
app-shell entries. Repository gate green: 514 Python tests, 79 deselected, the
known `audioop` warning, Ruff clean, strict mypy clean over 83 source files.

**Local verification:** `/sok` checked at 1100, 1280, 1360, 1440 and 375 px
against a temporary local reader stub (reverted; not committed). No console
errors and no horizontal overflow at any width. Opening a menu moved focus to
its first action and set `aria-expanded="true"`; a real pointer click outside
closed it; `Escape` closed it and returned focus to the trigger. With 68 demo
politicians the panel's list measured 252 px over 3 338 px of content with a
10 px scrollbar. *Visa klipp från Moderaterna* switched the page to the results
state, removed the directory, showed the compact chips with `M` active and the
home chip reading "Alla partier". Mobile rendered the released chips row and
*Populära debatter* unchanged at 375 px.

**Contracts touched:** none. No new reader, no migration.

**Decisions made:**
- The second action is *Visa klipp från X*, not the checkbox the approved mockup
  showed. A party filter with no query already satisfies `showIdentityResults`,
  so choosing it leaves the landing state immediately — a checkbox there could
  never render checked, and the matching `is-filtered` state on the trigger
  could never appear either. Both were removed rather than shipped dead.
- Four columns start at 1360 px, not 1280. At 1280 a four-up row leaves 228 px
  per button and "Sverigedemokraterna" truncates; three columns give 308 px.
  Verified by measuring `scrollWidth > clientWidth` on every name at both widths.
- The panel's last column in each row flips to right-aligned
  (`:nth-child(3n)`, and `:nth-child(4n)` above 1360) so a 360 px menu never
  hangs off the workspace. No JS measurement.
- Rows carry `tabIndex={-1}` inside `role="menu"`, so Tab leaves the panel
  instead of walking 107 politicians; the arrows, Home and End move inside it.
- A failed politician fetch keeps the two actions and says so. The party page
  must stay reachable when the members list is not.
- Mobile is untouched: the chips row keeps its icon-only home button and
  *Populära debatter*, and every new rule is inside `@media (min-width: 1100px)`.

**Observations (not fixed, out of scope):** the panel opens below its trigger
with no upward flip. At the current hero height the tallest panel ends around
740 px, so it fits a 900 px viewport; on a very short window it will clip. A
flip needs a measured collision check and belongs with a shared popover helper
rather than this one surface.

**Blocked / needs a decision:** none.

**Production verification:** live at `pleni.se/sok` on commit `9822b9b`. All
eight party triggers rendered their content-addressed Bunny marks with positive
intrinsic widths. The old duplicate `Riksdagspartier` group was absent;
Moderaterna opened one 360 px roll-down with both actions and 83 real
politicians. There was no horizontal overflow and no browser-console error.

**Next agent should know:** the real-logo and live-data gaps from local
verification are closed. The short-window upward-flip observation remains a
future shared-popover concern, not a release blocker.

## UI20.3 — Profile pagination and desktop Following — DONE 2026-09-04

**Built:** cursor pagination in `web/src/supabase.ts`, pagination state and
desktop gallery controls in `web/src/App.tsx`, duplicate-safe page merging in
`web/src/profile-clip-order.ts`, a dedicated desktop `FollowingScreen` branch,
the corresponding rules in `web/src/styles.css`, and coverage in
`web/tests/desktop-following.test.mjs`, `web/tests/desktop-profile.test.mjs` and
`web/tests/profile-clip-order.test.mjs`.

**Tests:** all 167 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and its verification confirms exactly nine app-shell
entries with video and private data excluded. Repository gate green: 514 Python
tests, 79 deselected, the known `audioop` warning, Ruff clean and strict mypy
clean over 83 source files.

**Local verification:** the signed-out Following page was inspected at
1440×900 in a real browser. The account panel is exactly 380 px, the content
columns are 654/380 px, the document has no horizontal overflow and the console
has no errors. The only visible network notice was expected because the local
release checkout deliberately has no production frontend environment values.

**Contracts touched:** none. No migration, dependency or mobile layout change.

**Decisions made:**
- Profile pages use a stable `(debate_date DESC, published_at DESC, id ASC)`
  cursor rather than an offset. A failed older page leaves the existing gallery
  and its scroll position intact and exposes a retryable error.
- `Spela alla klipp` appears only once every page is loaded. Before then the
  action truthfully says `Spela senaste klippen`; `Hämta fler klipp` is the path
  to the rest of the catalogue.
- The desktop Following page does not repeat the mobile page's invented zero
  counts while signed out. It explains how follows affect För dig, gives usable
  signed-out routes and presents sign-in/create-account as the clear next step.
- The signed-in layout puts politicians in the main column and parties in a
  336 px rail. It warns when personalization is off and links to Profile.
- The proposed `Senast tillagd` fact is absent because the saved library has no
  per-follow timestamp. Copy also says the library is account-separated on this
  device; it does not claim server sync that the current implementation cannot
  guarantee.
- Unfollow remains immediate, matching current product behavior, but is visually
  quiet until hover or keyboard focus. No speculative undo state was added.
- Mobile Following, search and profile branches remain unchanged.

**Observations (not fixed, out of scope):** the local checkout cannot exercise
the signed-in Following branch with production Clerk/Supabase data. Its state,
routing, honest-copy and accessibility contracts are covered by the frontend
tests; final live verification will not sign in as the owner.

**Blocked / needs a decision:** none.

**Production verification:** InstaPods served the new JS/CSS release
(`index-zxCCYbpm.js`, `index-i7vfDIbW.css`) from `pleni.se`. Signed-out Följer
rendered the new copy and 380 px account panel at 1440×900 without the invented
zero subtitle, overflow or console errors. Moderaterna reported 1,424 clips;
`Hämta fler klipp` grew the gallery 60 → 120 → 180 with no error, and the
second page retained the outer 1,267 px and inner 0 px scroll positions exactly.
The production service worker precaches the current JS/CSS among exactly nine
app-shell entries and no video.

**Next agent should know:** UI20.1b–UI20.3 are released and their signed-out,
public-data desktop paths are production-verified. The only accepted coverage
gap is the signed-in Following state, which remains covered by frontend tests
but was not opened using the owner's production account.

## UI20.4 — Internally scrolling profile rosters — DONE 2026-09-04

**Built:** `web/src/App.tsx` now expands the complete party roster inside both
the desktop party page and a desktop politician profile instead of extending
the whole profile document. `web/src/styles.css` gives expanded rosters a
bounded internal scroll region, and `web/tests/desktop-profile.test.mjs` covers
both routes and their accessibility wiring.

**Tests:** all 168 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and still precaches exactly nine app-shell entries with
no video/private data. Repository gate green: 514 Python tests, 79 deselected,
the known `audioop` warning, Ruff clean and strict mypy clean over 83 source
files.

**Contracts touched:** none. No migration, dependency or mobile change.

**Decisions made:**
- Only the expanded politician list scrolls, at `min(430px, 52vh)`. The rail,
  facts, gallery and outer profile scroll keep their existing layout.
- The party page keeps its collapsed six-row preview. The politician page now
  expands its colleagues in place instead of using the old party-page
  navigation as a substitute for showing all.
- Both toggles expose `aria-expanded` and `aria-controls`, switch their chevron
  direction, and reset to the six-row preview when the selected party or
  politician changes.
- Mobile markup and behavior remain untouched.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Production verification:** live at `pleni.se` on commit `ca5669d`. At
1440×900, Moderaterna expanded from six to 83 rows inside a 430 px region with
4,897 px scroll height and `overflow-y: auto`; the outer page stayed 2,111 px
high and the document stayed exactly viewport-wide. Adam Reuterskiöld's profile
expanded from six to 82 colleagues inside the same 430 px region with 4,838 px
scroll height. Both toggles changed to `Visa färre`, exposed
`aria-expanded="true"`, and produced no browser-console errors.

**Next agent should know:** the collapse/long-page defect is closed on both
desktop profile routes and verified against production data. Mobile remains
unchanged.

## UI20.5 — Live member filtering in Search party menus — DONE 2026-09-04

**Built:** the desktop party roll-down in `web/src/App.tsx` replaces `Visa klipp
från …` with an auto-focused `Sök namn` field that filters the open party's
member list while the viewer types. `web/src/party-member-filter.ts` owns the
accent-, case- and whitespace-insensitive match; `web/src/styles.css` provides
the compact field and centered no-result state; `web/src/supabase.ts` raises
the party-member read from 100 to 200 rows. Focused coverage lives in
`web/tests/search-party-directory.test.mjs` and
`web/tests/party-member-filter.test.mjs`.

**Tests:** all 171 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and still precaches exactly nine app-shell entries with
no video/private data. Repository gate green: 514 Python tests, 79 deselected,
the known `audioop` warning, Ruff clean and strict mypy clean over 83 source
files.

**Contracts touched:** none. No migration, dependency or mobile change.

**Decisions made:**
- Filtering is local over the already fetched party roster, so each keystroke
  makes no new network request and preserves the server's alphabetical order.
- The 100-row ceiling is now 200 in both the menu and shared party reader so a
  party with more than 100 names can actually be searched in full.
- Empty matches show the exact centered state `Inga namn hittade` inside the
  existing scroll frame. The live count reads `x av y`, and changing the query
  returns the internal list to its top.
- The roll-down is now an accessible dialog rather than an ARIA menu, because
  it contains a text input. Opening focuses that input; Arrow Down enters the
  filtered results, Escape returns focus to the party trigger, and moving focus
  outside closes the panel.
- Mobile Search and the main topic/person search behavior remain unchanged.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Production verification:** live on `pleni.se/sok` from code commit `de9dab3`.
At 1440 x 900, Socialdemokraterna loaded all 109 names inside the 252 px internal
scroll area (5,347 px scroll content), rather than stopping at the former
100-row ceiling. The input received focus when the party opened and the old clip
action was absent. `Anders Ygeman` returned one row and `1 av 109`; an unknown
name returned zero rows, `0 av 109` and the centered `Inga namn hittade` state.
Both queries reset the internal scroll to the top, clearing restored all 109
rows, and Escape closed the dialog and returned focus to the party trigger.
There were no console errors or horizontal overflow.

**Next agent should know:** the desktop Search party menu now has complete,
production-verified live member filtering. No follow-up is required for this
change.

## UI21 — Consent-gated aggregate web analytics — DONE 2026-09-04

**Built:** `web/src/analytics-consent.ts` owns a versioned, separate analytics
choice; `web/src/analytics.ts` loads GA4 measurement `G-STDL8RHDCX` only after
grant and emits bounded content/playback events; `web/src/AnalyticsConsentBanner.tsx`
and `web/src/styles.css` provide the equal-weight first-visit/settings surface.
`web/src/App.tsx` connects the existing bounded player, every feed context,
Profile and the Cookies page. The public legal copy and the three internal
privacy records now describe the exact flow and advertising firewall.

**Tests:** all 177 frontend Node tests pass, including six new analytics tests;
TypeScript passes; the production Vite/PWA build passes and precaches exactly
nine app-shell entries. Repository gate green after directing pytest's temp
files to the sandbox-writable `test_outputs` directory: 514 Python tests, 79
deselected, the known `audioop` warning, Ruff clean and strict mypy clean over
83 source files.

**Visual verification:** the first-visit panel was inspected in the real local
browser at desktop width and 375×812. It remains a non-modal bottom surface,
both choices are equal-sized, expanded details and actions stay inside the
mobile viewport (the action row ended at 782 px in an 812 px viewport), and
keyboard semantics are exposed. The only local notice was the expected missing
network configuration in the isolated checkout.

**Contracts touched:** none. No migration, Supabase data, recommendation
telemetry, search query, service-worker rule or media scheduler changed.

**Decisions made:**
- Basic Consent Mode is literal: no Google script or request exists before a
  grant. Denial stays tag-free; withdrawal denies all Google categories, clears
  accessible GA cookies and reloads to remove the already-executed tag.
- Consent is site-level, account-independent and separate from the Article 9
  political-personalisation choice. The saved record contains only decision,
  notice version and time.
- A clip impression requires one continuous second at 72% visibility in a
  visible document. Starts require actual foreground playback; the three-second
  view, progress, completion and wall-clock watch time are session-deduplicated.
  Prefetch, buffering, samples, hidden tabs and repeated automatic loops cannot
  manufacture new views.
- Qualified feed impressions also emit a page view with the existing canonical
  `/klipp/<slug>/<id>/` SEO URL. A canonical SEO entry relies on GA's current
  page view and does not emit a duplicate manual view.
- No Clerk id, email/name, search text, follow/like/save state, comment or
  political-preference field is sent. Google Signals and every advertising
  consent category remain disabled. These metrics are explicitly not ad
  impressions.

**Observations (not fixed, out of scope):** GA4 event-level retention is already
two months. The reliable clip KPIs are `clip_impression` and `qualified_view`;
the general GA page-view total can also include ordinary History API route
views from Enhanced Measurement and must not be presented as ad inventory.

**Blocked / needs a decision:** none for this release. Before future personalised
ads in the EEA, Pleni still needs a separate advertising project, network terms,
certified CMP/TCF decision where required, and ad-render/viewability measurement.

**Production verification:** live at `pleni.se` from code commit `3baa7f0`
with asset `index-ClZjwYoe.js`. In a fresh production origin the first-visit
dialog was present and zero `googletagmanager.com` scripts existed. `Endast
nödvändiga` closed the dialog and kept the count at zero. Opening `Analys och
cookies` from the signed-out desktop Profile and choosing `Acceptera analys`
loaded exactly one Google tag and changed the profile subtitle to `Analys är
tillåten`. Choosing `Endast nödvändiga` from settings then triggered the strict
reload, removed the tag (count zero) and restored the `Endast nödvändiga`
subtitle. No account or sign-in was needed for any privacy control.

**Next agent should know:** validate `clip_impression`, `qualified_view`,
`video_start`, `video_progress`, `video_complete` and `watch_time` in GA4 after
consenting on production. Do not create GA audiences or join these events to
Clerk/recommendation data.

## UI21.1 — Compact delayed analytics prompt — DONE 2026-09-05

**Built:** `web/src/App.tsx` now waits for the browser's complete page-load event
and a short 900 ms settling period before showing the first-visit analytics
choice. `web/src/AnalyticsConsentBanner.tsx` removes the unnecessary reassurance
sentence, while `web/src/styles.css` reduces the desktop panel from 520 px to
440 px and tightens spacing, type and actions across desktop and mobile.

**Tests:** all 178 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and still precaches exactly nine app-shell entries. Full
repository gate green: 514 Python tests, 79 deselected, the known `audioop`
warning, Ruff clean and strict mypy clean over 83 source files.

**Visual verification:** in a fresh local browser origin the first captured
page state contained no consent panel. After the load-bound delay, the panel
appeared at 440 × 168 px in a 1280 × 720 viewport, with the complete shorter
copy and both consent choices visible without overflow.

**Contracts touched:** none. No analytics event, legal notice version, stored
choice, tag-loading rule or mobile navigation changed.

**Decisions made:**
- The delay begins only after `document.readyState` reaches `complete`; an
  already-loaded document takes the same 900 ms path, so neither timing branch
  flashes the prompt during the initial render.
- Opening analytics settings remains immediate. The delay applies only when no
  choice has ever been stored.
- Both choices retain equal size and prominence. The removed sentence does not
  change the ability to refuse analytics or the strict no-tag behavior after a
  refusal.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Production verification:** live at `pleni.se` from commit `8393649`. A direct
cache-bypassing read returned the new production assets `index-DnlSo_M_.js` and
`index-CNC7jF60.css`; they contain the shortened consent copy, the complete-page
load branch and both 440 px width rules, while the removed reassurance sentence
is absent. The earlier local browser check covers the fresh-origin reveal timing
because the production browser already holds the owner's prior refusal choice.

**Next agent should know:** the first-visit prompt intentionally appears about
one second after full page load; analytics settings opened from Profile should
continue to appear immediately.

## UI21.2 — Search Console linked to GA4 — DONE 2026-09-05

**Built:** Google Analytics property `Pleni` now links the verified Search
Console domain property `pleni.se` to the existing production web stream
`Pleni` (`https://www.pleni.se`). This is an external Google configuration;
no application code, tag behavior or consent rule changed.

**Verification:** GA4 reported `LINK CREATED` and its Search Console links table
showed `pleni.se`, property type `Domain`, web stream `Pleni` and stream id
`15719973648`. The Search Console collection appeared automatically under
Reports with both `Queries` and `Google organic search traffic`. Opening
`Queries` returned historical organic-search clicks, impressions, CTR and
average position for the Pleni stream, confirming that the data flow is live.

**Consent boundary:** Search Console continues to measure Google Search
impressions and outbound clicks independently. Pleni's GA4 tag remains in
strict Basic Consent Mode and still sends no onsite page or playback data until
the visitor grants analytics consent.

**Tests:** no repository tests required; this release changed Google product
link configuration only. The linked report was verified directly in GA4.

**Contracts touched:** none.

**Blocked / needs a decision:** none.

**Next agent should know:** the GA4 Reports navigation now contains a published
Search Console section. Do not enable Advanced Consent Mode to increase totals;
the released no-tag-before-consent boundary remains intentional.

## UI20.4b — Desktop account page — DONE 2026-09-05

**Built:** integrated `4602b2a` on top of the later profile-pagination, search
and UI21 analytics releases. `web/src/App.tsx` now uses the desktop account
masthead, Pleni-owned Clerk identity and sidebar row, real saved/followed facts,
quiet account actions, a primary/secondary settings layout and a signed-out
account panel. `web/src/styles.css` supplies the 380 px rail and account-specific
desktop treatment. `web/tests/desktop-account.test.mjs` covers the new surface.

**Tests:** all 189 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and still precaches exactly nine app-shell entries. Full
repository gate green: 514 Python tests, 79 deselected, the known `audioop`
warning, Ruff clean and strict mypy clean over 83 source files.

**Local verification:** desktop Chrome rendered the new masthead and split
account surface with the non-Clerk fallback, analytics controls and all legal
rows in the intended columns. A narrow in-app browser rendered the released
mobile structure, including its existing analytics entry. No browser-console
error was introduced; the expected network notice remained because this clean
release checkout has no production frontend environment values.

**Contracts touched:** none. No migration or dependency change.

**Decisions made:**
- Commits `651afbf` and `e8a05d5` were already ancestors of `main`; only the
  account commit needed integration.
- The newer *Analys och cookies* group was retained once and composed in both
  layouts. On desktop it is the first settings group in the right rail, before
  account-bound data actions.
- The destructive colour treatment is desktop-only. The source commit applied
  `tone="danger"` through a shared row and would therefore have changed the
  released mobile design; the merged version conditions that tone on the
  desktop presentation.
- Desktop export, reset and delete remain hidden while signed out because they
  require a Clerk-bound recommendation profile. The released mobile behavior
  is otherwise unchanged.

**Observations (not fixed, out of scope):** Clerk's own sign-in and account
modals retain their default theme. They can be themed separately without
changing this page architecture.

**Blocked / needs a decision:** none.

**Production verification:** InstaPods completed commit `aec098d` successfully
in 49 seconds. A cache-bypassing production read returned
`index-CGO6AbXG.js` and `index-CNr0THSH.css`; the stylesheet hash matches the
locally accepted build. Desktop Chrome at `pleni.se/profil/` rendered the new
signed-out masthead, the account panel, the analytics group before legal
information and no invented account totals.

**Next agent should know:** the production Chrome session was signed out, so a
real Clerk name, email and `user.imageUrl` were not visually exercised. Their
render paths are covered by the account and reactive-viewer tests; perform the
final visual smoke the next time the owner is already signed in.

## UI21.3 — Cookie panel and shared desktop sign-in card — DONE 2026-09-05

**Built:** `web/src/AnalyticsConsentBanner.tsx` and `web/src/styles.css` now use
a compact reference-led cookie panel with a direct policy link, two stacked
choices and Pleni navy (`#13284d`) for the analytics action. `web/src/App.tsx`
now composes the same `DesktopSignInPanel` on signed-out Profile and Following,
including the same action hierarchy and legal footer.

**Tests:** all 190 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and still precaches exactly nine app-shell entries. Full
repository gate green: 514 Python tests, 79 deselected, the known `audioop`
warning, Ruff clean and strict mypy clean over 83 source files.

**Visual verification:** a fresh-origin desktop Chrome visit showed the consent
panel only after the existing page-load delay, at the lower right with a 412 px
maximum width, stacked full-width buttons and the navy primary action. The same
panel fit a narrow in-app mobile viewport without horizontal clipping. Desktop
Following rendered the shared Profile sign-in card beside the existing value
explanation with aligned width, spacing and controls.

**Contracts touched:** none. No migration or dependency change.

**Decisions made:**
- The primary action says *Tillåt analyscookies*, not *Acceptera alla cookies*;
  Pleni requests analytics consent only and must not imply unrelated cookie
  categories.
- The full measurement disclosure remains visible when settings are opened
  from Profile. The first-visit panel keeps the necessary/analytics distinction
  and links directly to the cookie policy without an extra details accordion.
- Following passes its existing sign-in gate into the shared card; its mobile
  branch and its signed-in library remain unchanged.

**Observations (not fixed, out of scope):** local visual verification ran
without the production Clerk key, so the shared card's controls were disabled
there by design. Their enabled Clerk paths are unchanged and covered by the
existing account tests.

**Blocked / needs a decision:** none.

**Production verification:** commit `c654d4f` was pushed to `main`. A
cache-bypassing read changed from the prior stylesheet to
`index-DbxOIczf.css`, matching the accepted local production build. The live
signed-out `pleni.se/foljer/` route rendered the shared Profile sign-in card
with enabled Clerk actions and the terms/privacy footer.

**Next agent should know:** the production cookie prompt was accepted through
the fresh-origin local visual run and its exact stylesheet is live. Re-test the
first-visit delay only if the consent bootstrap or storage version changes.

## UI21.4 — Following action alignment and deterministic feed refresh — DONE 2026-09-06

**Built:** `web/src/App.tsx` gives *Öppna För dig* a dedicated desktop action
class and text wrapper so the label stays centred, unbroken and aligned with the
Following masthead facts. Feed loads and manual refreshes are now owned by their
specific mode, stale results cannot render under a newly selected mode, and both
mode changes and refreshes deterministically return playback to the first clip.
`web/src/supabase.ts` supports abort signals and an explicit cache policy; a
manual refresh bypasses the browser cache while ordinary feed loads retain their
normal caching. `web/src/styles.css`, `web/tests/desktop-following.test.mjs` and
the new `web/tests/feed-refresh.test.mjs` cover the presentation and refresh
invariants.

**Tests:** all 192 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and still precaches exactly nine app-shell entries. Full
repository gate green: 514 Python tests, 79 deselected, the known `audioop`
warning, Ruff clean and strict mypy clean over 83 source files.

**Functional verification:** with real public catalogue data, switching from
*För dig* to *Senaste* selected the chronological first clip `HD10556_32_c01`
at scroll position 0. A manual *För dig* refresh replaced
`HD10538_9c713b38-d36f-f111-bf27-6805cafeabf9_c01` with
`HD10535_43_c01` and also returned to position 0. The race case — starting a
manual refresh and immediately choosing *Senaste* — still ended on `/senaste/`
with `HD10556_32_c01`, no loading state, no refresh state and scroll position 0.
No browser error was recorded.

**Contracts touched:** none. No migration or dependency change.

**Decisions made:**
- A manual refresh belongs only to the mode in which it was requested. Changing
  mode cancels its UI ownership so a late completion cannot interfere with the
  destination feed.
- An explicit refresh uses `cache: "no-store"`; normal initial and mode loads do
  not, preserving the existing performance characteristics.
- The active clip is intentionally reset on a mode change or refresh. Reusing an
  overlapping clip ID made a successful data reload appear visually unchanged.
- Feed ranking and recommendation selection are unchanged.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Production verification:** commit `fc9817d` was pushed to `main`. A
cache-bypassing production read returned `index-DgfmjLUG.css`, matching the
accepted local build. On the live app, *Senaste* selected `HD10556_32_c01` at
scroll position 0; a manual *För dig* refresh changed the first clip from
`HD10537_160_c02` to
`HD10544_e4f5f5b0-066b-f111-bf27-6805cafeabf9_c02` and returned to position 0.
Starting another refresh and immediately selecting *Senaste* again completed on
`/senaste/` with `HD10556_32_c01`, no loading/refresh state and no browser error.

**Next agent should know:** the production browser session was signed out, so
the signed-in Following action could not be visually exercised against Clerk.
Its exact release stylesheet is live and its alignment is covered by the
desktop regression test.

## UI21.5 — Profile and party catalogue scale hardening — DONE 2026-09-06

**Built:** `web/src/App.tsx` now loads the main For You catalogue only while the
Home feed is actually mounted and reuses a completed load when a viewer returns
without refreshing. Direct politician, party, search and legal entries no
longer pay for the separate 240-row background catalogue. Politician/party
profile reads, roster reads and cursor pages now share abort signals so a quick
route change releases obsolete Supabase work instead of merely ignoring its
result. `web/src/supabase.ts` replaces profile `select=*` reads with an explicit
playback-safe projection. `migrations/032_profile_page_scale_indexes.*.sql`
adds four partial/join indexes for the catalogue paths, with Python migration
coverage and focused frontend regression coverage in
`web/tests/profile-scale.test.mjs`.

**Measured before/after:** the removed anonymous background catalogue was 240
rows / 437.2 KiB on a direct profile visit. The retained 60-row party payload
fell from 108.0 KiB to 102.9 KiB (4.7%). The remaining size is primarily the
clip transcript, intentionally retained because the desktop lead card and
collection inspector display it. Production profile galleries still mount zero
video elements; native lazy images decoded only the near-viewport subset.

**Tests:** all 195 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and still precaches exactly nine app-shell entries. Full
repository gate green: 516 Python tests, 79 deselected, the known `audioop`
warning, Ruff clean and strict mypy clean over 83 source files.

**Contracts touched:** none. No dependency change. Migration 032 was applied
to the production Supabase project after all prior migration checksums matched.

**Decisions made:**
- Kept the existing first-page size and stable cursor pagination. The measured
  profile response is modest and its thumbnails already use native lazy loading;
  reducing it would add more user-visible round trips without addressing the
  actual duplicate 240-row request.
- Kept transcript and source metadata in profile rows so opening the existing
  bounded collection player does not require a second detail request or lose
  desktop copy.
- Did not add DOM virtualization. No MP4 is mounted in a profile gallery, and
  the collection player still enforces its existing four-source maximum.
- The completed Home request cache is keyed by mode, refresh generation,
  personalization state and viewer identity; an explicit refresh still fetches
  fresh data and navigation never crosses account or mode boundaries.

**Production verification:** release commit `126637e` was pushed to `main` and
InstaPods changed the live script to `index-LrKKbcZH.js`. The live
Socialdemokraterna page rendered all 60 gallery cards with zero video elements;
a politician profile also rendered 60 cards with zero video elements. Starting
its normal collection route mounted three video sources and played exactly one
clip, preserving the bounded scheduler.

**Observations (not fixed, out of scope):** none.

**Blocked / needs a decision:** none.

**Next agent should know:** true DOM virtualization is deliberately deferred
until a measured long-session profile problem appears. The current scale guard
is data-request elimination, cancellation, index support and bounded media — do
not reintroduce unconditional video sources into gallery cards.

## UI21.6 — Google tag command delivery repair — DONE 2026-09-06

**Built:** `web/src/analytics.ts` now queues each analytics command with the
browser function's `arguments` object, matching Google's documented `gtag`
wrapper. The previous rest-parameter array reached `dataLayer` in a shape that
the loaded Google tag did not consume. `web/tests/analytics-consent.test.mjs`
now asserts the exact non-array command shape before checking consent and video
events, so the original failure cannot silently return.

**Tests:** all 195 frontend Node tests pass; TypeScript passes; the production
Vite/PWA build passes and precaches exactly nine app-shell entries. Full
repository gate green: 516 Python tests, 79 deselected, the known `audioop`
warning, Ruff clean and strict mypy clean over 83 source files.

**Contracts touched:** none. No dependency, consent rule, event name, event
payload, measurement id, GA4 property or service-worker behavior changed.

**Decisions made:**
- Kept Basic Consent Mode unchanged: the Google script still loads only after
  an explicit analytics grant.
- Kept measurement `G-STDL8RHDCX`; the production stream and source already
  matched, so changing Analytics configuration would have hidden the actual
  client-side defect.
- Made the regression test validate Google's wire shape rather than merely
  counting locally queued values.

**Production verification:** release commit `e60b70c` was pushed to `main` and
InstaPods changed the live bundle to `index-C7DZgXA-.js`. With analysis consent
already granted, a fresh production load appeared in GA4 Realtime as one active
user. The report received two `page_view` events plus `clip_impression`,
`qualified_view`, `scroll`, `first_visit` and `session_start`, proving the tag,
cookie/session and Pleni video-event paths are active end to end.

**Observations (not fixed, out of scope):** standard GA4 reports can take longer
to populate than Realtime; this is no longer a collection failure.

**Blocked / needs a decision:** none.

**Next agent should know:** GA4 collection is production-verified. Preserve the
`arguments` queue shape if the analytics wrapper is refactored.
