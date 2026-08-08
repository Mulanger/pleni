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
| V1 - YuNet replaces the Haar cascade | DONE | Completed 2026-08-07 |
| V2 - Speaker identity verification | DONE | Completed 2026-08-08 |
| V3 - Portrait recovery + framing-aware selection | DONE | Completed 2026-08-08 |
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
