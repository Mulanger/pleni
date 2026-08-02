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
