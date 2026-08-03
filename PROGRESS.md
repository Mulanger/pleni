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
