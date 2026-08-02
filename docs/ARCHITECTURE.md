# Riksdagen Shorts — Processing Pipeline Architecture

**Scope:** From "a new debate video appeared on Riksdagen webb-tv" → "10 vertical, subtitled, speaker-centred clips per speech are live in Bunny + Supabase."

---

## 0. The three decisions that shape everything

Before the steps, three things that change the design more than any tool choice.

### 0.1 You probably don't need speaker diarization

Riksdagen publishes speaker segmentation as open data. The `mhs-vodapi` endpoint returns, per debate, the media files **and a speaker list with start times and durations**. The National Library's own lab (KBLab) built the RixVox dataset on exactly this: they split debate audio into per-speech files using Riksdagen's metadata timestamps, and used ASR + fuzzy matching only to *verify and correct* those boundaries.

So the architecture is **metadata-first, ASR-second**:

```
Riksdagen metadata  →  approximate speech boundaries (free, instant)
        ↓
ASR + forced alignment  →  snap boundaries to actual words (accurate)
        ↓
Scene detection  →  snap to the camera cut (visually clean)
```

Diarization (pyannote) becomes a *fallback* for when metadata is missing or the alignment confidence is low — not the primary mechanism. This removes the single most expensive and error-prone component from your critical path.

### 0.2 Timecodes first, pixels last

Your description has a nested loop: cut speaker → cut clips → reframe → next speaker. That means the video gets encoded **twice** (once to make the speech file, once to make the clip), which costs double the CPU and loses a generation of quality.

Invert it. Nothing touches video pixels until the very last step:

| Stage | Output | Cost |
|---|---|---|
| Segment speakers | JSON: `{speaker, start, end}` | seconds |
| Transcribe | JSON: word-level timestamps | minutes (GPU) |
| Build + rank candidates | JSON: `{start, end, score}` | seconds |
| Plan the crop | JSON: `{t, crop_x}` keyframes | ~1 min |
| **Render** | **10 MP4 files** | **the only encode** |

One ffmpeg pass per final clip, seeking directly into the **master file**. You render ~10 minutes of video per speech instead of the full 8–40 minutes. That's roughly a 4–10× reduction in encode time and it's lossless-by-one-generation.

### 0.3 Stages are queues, not a loop

Don't nest the work in a `for candidate in candidates` loop. Make each stage a job type on a queue that fans out:

```
ingest_debate (1 job)
   └─ fan out → segment_speech      (N jobs, N = speakers)
                   └─ transcribe_speech  (1 job, GPU)
                        └─ rank_speech    (1 job, LLM/CPU)
                             └─ fan out → render_clip (10 jobs, CPU)
                                             └─ publish_clip (10 jobs, network)
```

Why this matters concretely: a single crashed clip render doesn't kill the whole debate. GPU jobs (transcription) and CPU jobs (encoding) can run on different machines with different concurrency. And a 6-hour debate day becomes ~400 small resumable jobs instead of one 9-hour process that fails at 88%.

---

## PROCESS A — Ingest and speaker segmentation

### Step A1 — Discover new debates

> **⚠ Partially verified, 2026-08-01.** Checked against `hd01sfu35` ("En ny mottagandelag", 3 June 2026): the webb-tv page renders all 26 anföranden with second-precision start offsets, speaker names and parties. **The speaker-segmentation assumption holds.** What remains unverified is whether `mhs-vodapi` itself serves that array, or whether the page assembles it from another source. C1 must confirm the API response shape directly and capture it as a fixture. If the API doesn't carry it, the fallback is the webb-tv page or the `talarlista` document — not diarization.

**Trigger:** cron, every 30 min during session days.

1. Poll Riksdagen's open data for new video documents (`dokid` / `rel_dok_id`) since the last watermark.
2. For each new `dokid`, call `https://data.riksdagen.se/api/mhs-vodapi?<dokid>`.
3. Parse out:
   - media stream URLs (video, and the separate audio if offered)
   - debate title, date, chamber, debate type
   - **the speaker list**: name, party, start offset, duration
   - the official speech text if present
4. Insert a `sources` row with `status='discovered'`. Deduplicate on `dokid` — this is your idempotency key for the whole pipeline.

**Also pull** `anforandelista` for the same date. It gives you `anforande_id`, `talare`, `parti`, `anforandetyp` (Anförande / Replik / Svar), and the official transcript. That transcript is your ground truth for alignment and your safety net when ASR mishears a name.

### Step A2 — Fetch the master

1. Download the highest-quality stream to object storage. If it's HLS, remux to MP4 with `-c copy` (no re-encode).
2. Store `sha256`. If the checksum matches an existing `sources` row, stop — already processed.
3. **Extract the analysis audio once**, and reuse it for every downstream audio task:
   ```bash
   ffmpeg -i master.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le analysis.wav
   ```
4. **Extract analysis frames once** (for scene + face work), at 5 fps, small:
   ```bash
   ffmpeg -i master.mp4 -vf "fps=5,scale=480:-2" -q:v 4 frames/%06d.jpg
   ```
   Decode once, analyse many times. Never re-decode the master per stage.

### Step A3 — Scene / camera-cut detection

Run PySceneDetect (content detector) over the master once, store the cut list. You'll use it in three separate places later, so compute it here:

- to snap speech boundaries to the camera change,
- to decide when the vertical crop is allowed to jump vs. pan,
- to reject clip candidates that start 0.3s before a cut.

The chamber feed cuts to the new speaker within about a second of them starting, which makes cuts a strong, cheap boundary signal.

### Step A4 — Refine the speech boundaries

For each speaker entry from metadata:

1. Take metadata `start` and `start + duration` as a rough window. Widen by ±15s.
2. Run VAD (Silero or pyannote VAD) on that window of `analysis.wav`.
3. Run ASR on the widened window (see B1 for the model).
4. Fuzzy-match the ASR output against the **official transcript** for that speech. The match start/end give you accurate word-level boundaries — this is exactly the technique KBLab used to build RixVox.
5. Snap the final start to the nearest scene cut within 2s, if one exists.
6. Compute `alignment_confidence` = normalised similarity between ASR and official text.

**Confidence routing:**

| Confidence | Action |
|---|---|
| > 0.85 | Accept, continue |
| 0.60–0.85 | Accept, flag `needs_review` |
| < 0.60 | Run pyannote diarization on the window and re-match; if still low, park the speech and skip it |

7. Write a `speeches` row per speaker with `start_s`, `end_s`, `speaker_name`, `party`, `anforandetyp`, `alignment_confidence`, `official_text`.

**Validate this step against published ground truth.** KBLab released their corrected speech timestamps as metadata in `kb-labb/riksdagen_anforanden/tree/main/metadata`. Pick a handful of 2022 debates, run A4 over them, and diff your boundaries against theirs. Agreement within a second or two means your implementation is correct. The corpus is stale for production use — RixVox's modern portion ends around 2023–24, and RixVox-v2 expanded backwards into pre-2003 material rather than forwards — but as a regression fixture it's exactly what you want, and there is no equivalent for 2025–26.

**Do not cut a video file here.** The speech is a pair of numbers pointing into the master.

**Skip rules:** talman/procedural announcements, speeches shorter than your minimum (see open question), voting sessions, and any segment where the official transcript is absent *and* confidence is low.

---

## PROCESS B — Per speech: transcribe, section, rank

### Step B1 — Transcription with word-level timestamps

**Model: `KBLab/kb-whisper-large`.** This is the National Library of Sweden's Whisper fine-tuned on 50,000 hours of Swedish. Reported WER on FLEURS is 5.4 vs 7.8 for `openai/whisper-large-v3`, on CommonVoice 4.1 vs 9.5, on NST 5.2 vs 11.3 — roughly a 47% average reduction. KBLab also notes `kb-whisper-small` beats `openai/whisper-large-v3` despite being six times smaller, which matters if you're GPU-poor.

Practical notes:
- ctranslate2 checkpoints exist, so it drops into **faster-whisper / WhisperX** directly. Use WhisperX for the wav2vec2 forced-alignment pass that gives you real word-level timestamps (plain Whisper's timestamps are too loose for caption timing and for cutting).
- There are `subtitle` (condensed) and `strict` (verbatim) checkpoint variants. Use **`strict` for ranking** (you want disfluencies and repetitions — they're excitement signal) and **`subtitle` for burned-in captions**. Or run `strict` once and post-process for captions.
- Feed it only the speech window, not the whole debate.
- Prompt/initial_prompt with the speaker's name and the debate topic to improve proper-noun accuracy.

**Optional accuracy upgrade:** you already have the official transcript. Run forced alignment (`aeneas`, or WhisperX's aligner) between official text and audio. Then your caption text is **the official parliamentary record**, timed by machine — better text than ASR, with ASR-quality timing. KBLab does exactly this. Downside: the official record is lightly edited, so it won't match the audio word-for-word during heckling or self-correction.

Output per speech:
```json
{
  "words": [{"w": "Herr", "t0": 12.44, "t1": 12.61, "p": 0.98}, ...],
  "sentences": [{"i": 0, "t0": 12.44, "t1": 19.02, "text": "..."}, ...]
}
```

### Step B2 — Audio feature extraction

Same 16 kHz wav, one pass, frame-level features stored as arrays:

- **RMS energy** per 20ms frame → mean, p90, variance, and local peaks
- **F0 / pitch** (parselmouth/Praat) → range, std, contour slope
- **Speech rate** → words per second, computed per rolling 5s window
- **Pauses** → gaps > 400ms from VAD, with their durations and positions
- **Emphasis events** → syllables > 1.5 SD above the local energy mean
- **Audio events** (optional) → PANNs/YAMNet for laughter, desk noise, gavel, interruption

These are per-speech-normalised later. A quiet speaker's loudest moment should score as high as a loud speaker's loudest moment.

### Step B3 — Candidate window generation

Not a fixed grid. Generate **overlapping candidates that start and end on sentence boundaries**:

```python
candidates = []
for i, s_start in enumerate(sentences):
    for j in range(i, len(sentences)):
        dur = sentences[j].t1 - s_start.t0
        if dur < MIN_SEC:   continue          # e.g. 38
        if dur > MAX_SEC:   break             # e.g. 62
        candidates.append(Window(i, j, s_start.t0, sentences[j].t1))
```

An 8-minute speech yields roughly 80–150 candidates. Then apply **hard filters** before any scoring, because they're free:

- **Dangling opener** — first sentence begins with `Och`, `Men`, `Det`, `Den`, `Därför`, `Som sagt`, or a bare pronoun with no antecedent. A clip that opens mid-thought dies in the feed.
- **Procedural boilerplate** — first sentence contains `Herr/Fru talman`, `Jag yrkar bifall till`, `Jag vill börja med att tacka`, `Med detta yrkar jag`, reservation numbers, or committee report numbers.
- **Dead air** — more than 20% of the window is non-speech.
- **Cut collision** — the window opens within 0.4s of a camera cut.
- **Confidence** — mean ASR word probability below threshold (mic problems, crosstalk).

Typically this removes 40–60% of candidates for almost no compute.

### Step B4 — The ranking algorithm

Three layers, cheapest first. Full design and the open questions are in **Section R** below.

### Step B5 — Selection

Greedy selection with constraints, not a plain top-10:

```python
selected = []
for c in sorted(candidates, key=lambda x: -x.final_score):
    if len(selected) == 10: break
    if any(overlap(c, s) > MAX_OVERLAP_SEC for s in selected): continue
    if topic_count[c.topic] >= MAX_PER_TOPIC: continue
    if c.final_score < QUALITY_FLOOR: break
    selected.append(c)
```

Store **every** candidate's features in `clip_features`, not just the winners. You cannot train a ranker later on winners alone — you need the ones you rejected as negatives.

---

## PROCESS C — Vertical reframe and speaker centring

Runs **per selected clip**, not per speech. Ten jobs, parallelisable.

### Step C1 — Detect and track faces

On the pre-extracted 5 fps frames, restricted to the clip's time range:

1. **Face detection** — YOLOv8-face or RetinaFace. 5 fps is plenty; the podium barely moves.
2. **Track** — IoU-based tracking (ByteTrack) to keep identities stable across frames.
3. **Pick the active speaker.** Three options in increasing cost:
   - *Heuristic (start here):* the largest face nearest the frame centre. For Riksdagen this is right the large majority of the time, because the director already framed the speaker.
   - *TalkNet-ASD:* audio-visual model that answers "is this face speaking?" — ~90.8 mAP on AVA-ActiveSpeaker. Use `sieve-community/fast-asd`, a productionised TalkNet that's faster and handles variable frame rates, rather than the research repo.
   - *Both:* heuristic by default, ASD only when 2+ faces are detected in the shot.

### Step C2 — Plan the virtual camera

This is where most auto-reframe tools look cheap. The fix is to exploit the fact that **the Riksdagen feed is a cut-based, mostly-static broadcast**, not a handheld vlog.

Per **shot** (segment between two scene cuts):

1. Take the median x-centre of the active speaker's face across that shot.
2. Bias it downward-weighted: target the face at ~38% from the top of the vertical frame, not dead centre. Faces at exact centre read as amateur.
3. Clamp so the crop window stays inside the source frame.
4. **Hold that x for the whole shot.** No panning.
5. At a scene cut, **jump** to the new shot's x. Never pan across a cut.

Only if the speaker's face drifts more than a dead-zone threshold (say 12% of frame width) *within* a shot do you enable motion — and then it's a rate-limited ease, not a follow:

```
one-euro filter or Kalman on x_target
max pan velocity ≈ 60 px/s at 1080p
dead zone ±12% of frame width
ease-in/ease-out, never linear
```

Output is a small keyframe list: `[{t: 0.0, x: 620}, {t: 14.2, x: 705}, ...]`

### Step C3 — Render

**Source resolution: 1280×720. Confirmed ceiling — no higher rendition exists** for the IDs checked in C2. The download is `mhdownload.riksdagen.se/VOD1/HD/<media_id>_720p.mp4`, with 480p and audio-only as the other variants.

**Decision: full-bleed 9:16 anyway.** A full-screen vertical feed is the product; letterboxing or a caption-block layout is a different app. So the crop is `crop=406:720` — the largest 9:16 region the source allows — and output is upscaled.

The scaling chain is roughly 405 source px → output → panel resolution on device. Mitigations, in order of effect:

1. **Output 540×960. Decided.** The 720×1280 alternative contains no additional information — the extra pixels are interpolated either way, and the phone resamples to panel resolution regardless. 540×960 is a 1.33× upscale from the 406×720 crop instead of 1.78×, at roughly 40% less bitrate for the same real detail. Keep output dimensions in `config.py`; this is a value to tune, not an architectural commitment.
2. **`flags=lanczos` then `unsharp=5:5:0.8:3:3:0.4`.** Recovers a large share of perceived sharpness after upscale.
3. **CRF 20, not 24.** The source is already compressed; don't stack a second generation of loss on top of the upscale.
4. **Captions are rendered at output resolution, not upscaled.** Since burned-in text is where the eye goes, this carries more of the perceived quality than the video itself.
5. **Probe for an HLS manifest.** C2 checked direct MP4 downloads only. Streaming variants sometimes expose renditions the download does not. A 1080p variant would remove this problem entirely.

**Rendition ladder.** With 540×960 primary, the old 720/480 ladder no longer applies. At ~50s a clip lands around 2–4 MB, so a second rendition may not earn its complexity. Suggest 540×960 alone to start, adding 360×640 only if connection telemetry shows it's needed.

**Consequence for C8.** At 406px of a 1280px frame you keep under a third of the width, so active-speaker detection is load-bearing rather than optional — a tracking error clips the speaker out of frame rather than merely off-centre. TalkNet stays in scope and C9's dead zone matters.

**Static-per-shot (recommended default).** Use an ffmpeg `sendcmd` file to change `crop x` at each cut:

```
0.000  crop x 620;
14.200 crop x 705;
31.900 crop x 588;
```

```bash
ffmpeg -ss 132.40 -i master.mp4 -t 47.20 \
  -filter_complex "[0:v]sendcmd=f=cam.cmd,crop=406:720:620:0,scale=540:960:flags=lanczos,unsharp=5:5:0.8:3:3:0.4,\
     subtitles=clip.ass[v]" \
  -map "[v]" -map 0:a \
  -c:v libx264 -profile:v high -crf 20 -preset slow -g 125 \
  -c:a aac -b:a 96k -ac 1 \
  -movflags +faststart clip_0123_540x960.mp4
```

**Smooth panning (when needed).** ffmpeg expressions get unmanageable for per-frame values. Do the crop in Python (PyAV/OpenCV), pipe raw frames to ffmpeg for encoding. Slower, but full control.

**When the speaker is too small** (wide chamber shots): don't crop to a postage stamp. Either
(a) pad with a blurred, scaled copy of the source as background, or
(b) crop tighter and accept upscaling, or
(c) reject the candidate at ranking time by adding a "speaker face height" feature.

Option (c) is cheapest and gives the best-looking output — bad framing becomes a ranking signal instead of a rendering problem.

### Step C4 — Captions and branding

Burned-in captions are the single biggest retention lever in short-form. Build an ASS file from word timings with active-word highlighting:

- Big, high-contrast, 2–3 lines max, safe-area margins (bottom 15% is covered by platform UI)
- Word-level karaoke highlight using `\k` timing
- Speaker name + party as a lower-third for the first 3 seconds
- Small persistent source attribution (`Riksdagen • 2026-05-14`)

**Also store the plain VTT separately** in Supabase even though you burn in. You'll want it for search, accessibility, and any future re-render at a different size.

### Step C5 — Renditions

Start with one 540×960 progressive MP4, `+faststart`, GOP 4–5s, mono AAC. Add a 360×640 low-bandwidth rendition only if connection telemetry shows it is needed. Plus a WebP thumbnail pulled from a frame ~1.5s in where the speaker's eyes are open and the face is largest.

---

## PROCESS D — Publish

### Step D1 — Upload to Bunny

1. `PUT` each rendition to the Bunny **Storage Zone** (Falkenstein/Frankfurt), immutable path:
   ```
   /clips/2026/07/clip_0123_540x960.mp4
   /thumbs/2026/07/clip_0123.webp
   ```
2. Never overwrite. A re-cut gets a new clip ID. This is what lets you cache forever.
3. Verify with a `HEAD` and byte-length check before writing the DB row.
4. `Cache-Control: public, max-age=31536000, immutable`

### Step D2 — Write to Supabase

Write clip rows **last**, in a single transaction, only after upload verification. The DB is the source of truth for what's live; a row must never point at a missing file.

Then flip the speech to `status='published'` and emit a `pipeline_runs` completion record.

---

## Data model (Supabase / Postgres)

```sql
create table sources (
  id             uuid primary key default gen_random_uuid(),
  dokid          text unique not null,       -- Riksdagen document id
  title          text not null,
  debate_type    text,                        -- interpellation, betänkande, frågestund
  debate_date    date not null,
  source_url     text not null,
  duration_s     int,
  master_path    text,
  master_sha256  text,
  status         text not null default 'discovered',
  discovered_at  timestamptz default now()
);

create table politicians (
  id            uuid primary key default gen_random_uuid(),
  intressent_id text unique,                  -- Riksdagen's own id
  name          text not null,
  party         text,
  constituency  text,
  role          text,                          -- minister, ledamot, talman
  avatar_url    text
);

create table speeches (
  id                   uuid primary key default gen_random_uuid(),
  source_id            uuid references sources(id) on delete cascade,
  anforande_id         text,
  politician_id        uuid references politicians(id),
  speaker_name         text not null,
  party                text,
  anforandetyp         text,                   -- Anförande | Replik | Svar
  start_s              numeric not null,
  end_s                numeric not null,
  official_text        text,
  asr_text             text,
  words                jsonb,                  -- word-level timestamps
  alignment_confidence numeric,
  status               text not null default 'pending',
  needs_review         boolean default false,
  unique (source_id, anforande_id)
);

create table clips (
  id             text primary key,             -- "clip_0123"
  speech_id      uuid references speeches(id) on delete cascade,
  rank_in_speech int not null,                 -- 1..10
  start_s        numeric not null,             -- offset into the MASTER
  end_s          numeric not null,
  duration_s     numeric not null,
  title          text,
  hook_text      text,
  transcript     text,
  topic          text,
  final_score    numeric,
  sub_scores     jsonb,
  url_720        text not null,
  url_480        text,
  thumb_url      text not null,
  vtt_url        text,
  moderation     text not null default 'auto', -- auto | approved | rejected
  published_at   timestamptz,
  unique (speech_id, rank_in_speech)
);

-- Every candidate, selected or not. This is your future training set.
create table clip_features (
  id           bigserial primary key,
  speech_id    uuid references speeches(id) on delete cascade,
  start_s      numeric,
  end_s        numeric,
  features     jsonb not null,
  llm_scores   jsonb,
  final_score  numeric,
  was_selected boolean default false,
  was_explore  boolean default false,          -- see R4
  created_at   timestamptz default now()
);

create table engagement_events (
  id         bigserial primary key,
  clip_id    text references clips(id) on delete cascade,
  session_id text,
  watch_ms   int,
  completed  boolean,
  replayed   boolean,
  liked      boolean,
  shared     boolean,
  created_at timestamptz default now()
);

create table jobs (
  id            bigserial primary key,
  kind          text not null,                 -- ingest|segment|transcribe|rank|render|publish
  entity_id     text not null,
  idempotency_key text unique not null,
  state         text not null default 'queued',
  attempts      int default 0,
  last_error    text,
  payload       jsonb,
  updated_at    timestamptz default now()
);

create index on clips (published_at desc);
create index on clips (speech_id);
create index on speeches (source_id);
create index on engagement_events (clip_id);
```

**RLS:** public `select` on `clips where moderation != 'rejected' and published_at is not null`, and on `speeches`/`politicians`. Everything else service-role only.

**Optional:** `pgvector` column on `clips.transcript` embeddings for search and "more like this."

---

## Orchestration

**Queue:** since you're already on Postgres, use **pg-boss** or **Graphile Worker**. No extra infrastructure, transactional enqueue with your data writes, and you can inspect the queue with SQL. Only move to Redis/Temporal if you outgrow it.

**Rules:**
- Every job carries an `idempotency_key` (e.g. `render:clip_0123:v2`). Re-running is a no-op.
- Every stage writes its output artifact to storage before marking complete. A crash resumes at the last completed stage, never from the top.
- Exponential backoff, max 3 attempts, then dead-letter with the error in `jobs.last_error`.
- Separate worker pools: **GPU pool** (transcribe, ASD), **CPU pool** (render), **IO pool** (download, upload). Different concurrency limits, different machines.
- Global rate limit on Riksdagen requests. Be a polite client.

**Throughput sketch, one 6-hour debate day:**

| Stage | Est. time | Where |
|---|---|---|
| Download + audio/frame extract | ~15 min | IO |
| Scene detect | ~5 min | CPU |
| ASR, 6h audio, kb-whisper-large batched | ~20–35 min | 1 GPU |
| Ranking (heuristics + LLM on ~25/speech) | ~10 min | CPU + API |
| Render 40 speeches × 10 clips = 400 clips | ~2–4 h | CPU, parallel |
| Upload | ~20 min | IO |

Rendering dominates. It's also the most parallelisable — it's 400 independent 50-second encodes.

---

## Failure modes to design for now

| Situation | Handling |
|---|---|
| Metadata start time is wrong by 30s+ | Widened search window + fuzzy match catches it; confidence gate rejects the rest |
| Two speakers visible during a replik | ASD picks the talker; heuristic alone will get this wrong — this is where you actually need TalkNet |
| Sign-language interpreter inset | Detect and exclude that region from face candidates; hard-code the inset bounds if it's fixed |
| Wide chamber shot, speaker tiny | Face-height feature penalises the candidate at ranking time |
| Speech shorter than 40s | Skip entirely, or emit a single short clip — open question |
| Mic failure / crosstalk | Low ASR confidence → skip speech |
| Interrupted speech (talman intervenes) | Detect a speaker change inside the window via diarization; split or reject |
| Riksdagen re-publishes an edited video | Checksum differs → new `sources` row, new clip IDs, old clips soft-retired |
| Same speech processed twice | Unique constraint on `(source_id, anforande_id)` |
| Name in captions is misspelled by ASR | Use the official transcript text where alignment confidence is high |

---

## Section R — The ranking algorithm

### R1 — Layer 1: hard filters (free)

Covered in B3. These are rules, not scores. They're binary because "starts mid-sentence" isn't a matter of degree — it's disqualifying.

### R2 — Layer 2: feature scoring (cheap, ~100 candidates)

Every feature **z-scored within the speech**, so you're finding the best moments *of this speaker*, not comparing a soft-spoken Centre Party MP against a shouting one.

**A. Delivery / energy**
| Feature | Signal |
|---|---|
| `energy_p90_z` | Peak loudness |
| `energy_var_z` | Dynamic range — monotone is death |
| `pitch_range_z` | Melodic variation |
| `rate_var_z` | Changes of pace |
| `emphasis_count_z` | Stressed syllables per second |
| `pause_before_punchline` | Longest internal pause, position-weighted |
| `end_intensity_slope` | Do they land it or trail off |

**B. Content**
| Feature | Signal |
|---|---|
| `second_person_density` | "ni", "du", "ni säger" → direct confrontation |
| `question_count` | Rhetorical questions |
| `negation_density` | "inte", "aldrig", "varken" |
| `superlative_count` | "värsta", "störst", "aldrig tidigare" |
| `number_density` | Concrete claims — kronor, percentages, years |
| `ner_density` | Named entities (KB-BERT NER for Swedish) |
| `anaphora_score` | Repeated sentence-initial n-grams |
| `sentiment_intensity` | **Absolute** value, not polarity |
| `novelty_z` | Embedding distance from the speech's own centroid — rewards the part that isn't boilerplate |
| `boilerplate_sim` | Cosine similarity to a corpus of procedural phrases (negative weight) |

**C. Structure**
| Feature | Signal |
|---|---|
| `self_contained` | Opens with subject+verb, closes on a full stop, not a subordinate clause |
| `hook_density` | Feature weight of the first ~10 words |
| `has_claim_and_reason` | Presence of `därför`, `eftersom`, `det betyder att` |
| `face_height_frac` | Framing quality — from C1, feeds back into ranking |

**D. Context (free, from metadata)**
| Feature | Signal |
|---|---|
| `is_replik` | Rebuttals are structurally spicier than prepared remarks |
| `debate_type` | Interpellation / frågestund > committee report |
| `names_opponent` | Text mentions another politician by name |
| `applause_after` | Official transcript carries a literal `(Applåder)` marker at the end of applauded anföranden. Direct audience-reaction signal, free, no audio event detection needed. Verified present in `hd01sfu35`. |
| `talman_intervention` | `(TALMANNEN: ...)` in the transcript means the chair stepped in — the speaker went far enough to be reprimanded. Strong CONFRONT signal. |

### R3 — Layer 3: LLM judge (expensive, top ~25 only)

After Layer 2, keep the top 25 by heuristic score and send only those to an LLM. Include one sentence of context before and after so it can judge self-containment.

Ask for strict JSON:

```json
{
  "hook": 0-10,
  "self_contained": 0-10,
  "stakes": 0-10,
  "clarity_for_layperson": 0-10,
  "quotability": 0-10,
  "controversy": 0-10,
  "disqualify": false,
  "disqualify_reason": null,
  "topic": "sjukvård",
  "title": "≤60 chars, no clickbait punctuation",
  "why_it_matters": "one sentence"
}
```

The `disqualify` flag is the highest-value field. Heuristics can't reliably catch "this clip is incomprehensible without the previous speaker's question." An LLM can.

Cost: ~25 calls × maybe 600 tokens each per speech. At 40 speeches a day that's roughly 1,000 calls/day. Budget accordingly, or drop to Haiku-class for the first pass and a stronger model for the final 10.

**Decision: heuristics now, LLM later.** Two consequences to handle in Phase 1.

*You lose the disqualifier.* Compensate with three extra structural filters in B3, which are cheap and catch most of what the LLM would have caught:

| Filter | Rule |
|---|---|
| Orphan demonstrative | Window opens with `det här`, `den här`, `detta`, `sådana` and the referenced noun appears nowhere inside the window |
| Unbound pronoun | `han`, `hon`, `de`, `hen` in the first sentence with no named entity earlier in the window |
| External reference | First sentence contains `som jag sa`, `som ledamoten nämnde`, `enligt förslaget` with no in-window antecedent |

*You lose title generation.* Phase 1 fallback: `title = first sentence, truncated at 60 chars on a word boundary`. It's mediocre but honest, and it beats a bad LLM title. Consider a human writing titles for the first few hundred clips — that corpus becomes your few-shot examples when the LLM lands.

**Build the seam now.** Make the scorer return a `sub_scores` dict and have the selector read from it. Adding the LLM later is then a new producer of keys in that dict, not a rewrite of the selector. Log full features on every candidate from day one so you can retroactively score your back catalogue and measure exactly what the LLM adds before you pay for it at scale.

### R4 — Final score: three archetypes, not one blend

**Decision: "mix — let the model decide."** With no engagement data yet there is no model, so the honest reading is: don't commit to a single definition of "vital" — ship all three and let the data choose.

But do **not** implement that as one averaged score. Averaging three different qualities means a clip that's mediocre at all three beats a clip that's outstanding at one. Outstanding-at-one is exactly what performs in a feed.

Instead, score each candidate three times and select a **portfolio**.

```python
CONFRONT = (0.30*z.second_person_density + 0.20*z.names_opponent
          + 0.15*z.energy_p90        + 0.15*z.negation_density
          + 0.10*z.is_replik         + 0.10*z.pitch_range)

EXPLAIN  = (0.30*z.has_claim_and_reason + 0.25*z.number_density
          + 0.20*z.self_contained       + 0.15*z.novelty
          + 0.10*(-z.rate_var))          # steady pace reads as authoritative

QUOTABLE = (0.30*z.anaphora_score   + 0.25*z.superlative_count
          + 0.20*z.pause_before_punchline
          + 0.15*z.sentiment_intensity + 0.10*z.end_intensity_slope)
```

**Universal gate** — regardless of archetype, a candidate is rejected if `self_contained` or `face_height_frac` falls below threshold. Framing and comprehensibility are not tradeable against energy.

**Portfolio target per speech:** 4 CONFRONT, 3 EXPLAIN, 3 QUOTABLE. Store the winning archetype on the clip row (`clips.archetype`).

Three things this buys you that a blended score doesn't:

1. Every speech ships all three types, so your feed **A/B tests the archetypes for you** from day one, at no extra cost.
2. After ~2,000 clips you can compare completion rate *by archetype* and shift the 4/3/3 split to whatever actually retains.
3. When the LLM judge arrives (R3), its sub-scores map cleanly onto the same three buckets — `controversy`→CONFRONT, `clarity_for_layperson`+`stakes`→EXPLAIN, `quotability`+`hook`→QUOTABLE. No rewrite, just better inputs to the same selector.

### R4b — Clip count: 10 as a cap

**Decision (revised): 10 is a ceiling, not a quota.** The arithmetic below is what drove the change.

Ten non-overlapping clips at 40–60s need **400–600 seconds** — 6m40s to 10m of speech. Against typical Riksdagen speech lengths:

| Speech type | Typical length | Max non-overlapping 50s clips | Overlap needed for 10 |
|---|---|---|---|
| Replik | 1–2 min | 1–2 | ~76% — not viable |
| Anförande | 4–8 min | 4–9 | 0–40% |
| Ministerial / opening | 10–20 min | 12–24 | none |

So for a large share of your corpus, "always 10" means publishing near-duplicates: two clips containing the same 35 seconds with different edges. In a swipe feed that reads as a bug.

**The rule:**

```python
n = min(10,                                              # hard cap
        floor(duration_s / 55),                          # supply constraint
        count(c for c in candidates if c.passes_gate))   # quality constraint
n = max(n, 1 if any_admissible else 0)                   # never silently drop a speaker
```

Whichever constraint binds first, wins. A 2-minute replik yields 1–2 clips, an 8-minute anförande yields up to 8, a 20-minute ministerial statement is capped at 10. Overlap stays capped at 20% and becomes a rare edge case rather than a structural necessity.

**Why a cap rather than a quota:**

- **Supply is not the constraint.** A full chamber day runs to dozens of speeches. Even at 5 clips average that's a few hundred clips per sitting day, against a heavy user consuming maybe 30/day. You will out-produce demand either way.
- **Rendering is the pipeline's dominant cost.** A quota spends roughly half of it on material the ranker scored at the bottom.
- **It keeps the training signal clean.** Forced filler gets bad engagement because it was forced, not because it was mis-ranked. Under a cap, the decision to publish is itself a quality label.

**The counter-argument, and where to answer it.** Clip count scaling with speech length means ministers and party leaders get systematically more feed presence than backbenchers, who mostly give repliker. That's real, and it compounds with R5. Answer it at the **feed layer** with per-speaker quotas at serving time — not by manufacturing filler at ranking time. Same principle as R5: don't corrupt the ranker to fix a distribution problem.

**Consequence for the scoring scale.** R2 z-scores every feature *within* the speech. That's correct for ordering, but it makes scores non-comparable across speeches — 0.8 on a dull speech and 0.8 on a strong one mean different things. A forced quota never exposed this, because it only ever needed within-speech ranking. A quality gate does. So separate the two:

| Purpose | Scale | Features |
|---|---|---|
| **Ordering** within a speech | z-scored per speech | all of R2 |
| **Publish gate** | absolute | `self_contained`, `face_height_frac`, raw pause structure, number/entity density, LLM score once available |

Relative score decides the order; absolute score decides how many survive.

**Portfolio ratio goes soft.** With a variable `n`, a hard 4/3/3 no longer makes sense. Fill greedily by score with a ceiling of ~50% from any one archetype, relaxing that ceiling only if nothing else clears the gate.

### R4c — The feedback loop

1. Log every candidate's features to `clip_features` — winners *and* losers, with all three archetype scores.
2. Log watch %, completion, replay, swipe-away time from the app to `engagement_events`.
3. After ~2,000 published clips, train a LightGBM model on `features → completion_rate`. Replace the hand weights with learned ones, per archetype.

**The trap, and the fix.** If you only ever publish what the ranker chose, your training data only contains the ranker's own preferences and you can never learn that it was wrong. So reserve **10–15% of published slots for exploration**: publish some clips the model ranked 15th–40th, marked `was_explore=true`. Their engagement data is the only unbiased signal you'll have. Without this, the ranker's initial biases become permanent and invisible.

### R5 — A design issue worth deciding deliberately

An excitement-optimised ranker on political speech will not distribute its picks evenly. Confrontational rhetorical styles score higher than measured ones, and rhetorical style correlates with party. Left to itself, the pipeline will over-represent some parties and under-represent others — not because you chose that, but because "energy variance" and "second-person density" are proxies for a style.

You have three places to intervene, and they have different consequences:

1. **In the ranker** — penalise/boost by party. Simple, and it corrupts your ranking signal.
2. **In the feed** — rank freely, then balance at serving time with per-party quotas or round-robin. Keeps the ranking honest, gives you a dial you can tune per session.
3. **Nowhere** — measure and publish the distribution, let the ranking stand.

I'd suggest **(2)**, plus a dashboard query showing clips-per-party over the last 7 days regardless of which you pick. You want to know the number even if you decide not to act on it.

Worth noting on timing: the next Swedish general election falls on or before 13 September 2026. If you're launching before then, the party-distribution question stops being theoretical.

---

## Open questions

### Ranking
1. ~~What makes a clip "vital"?~~ **Decided: mix → three-archetype portfolio, 4/3/3. See R4.**
2. ~~LLM judge or heuristics?~~ **Decided: heuristics now, LLM later. See R3.**
3. ~~Always exactly 10?~~ **Decided: 10 is a cap, gated on quality and speech length. See R4b.**
4. ~~Maximum overlap between clips?~~ **Largely moot under a cap — default 20%, revisit only if it bites.**
5. **New, from R4b:** where does the absolute publish gate sit? Too high and thin speeches vanish entirely; too low and the cap does nothing. Suggest calibrating it as a percentile over the first ~500 speeches rather than picking a number now.
5. Enforce topic diversity across the 10, or take the 10 best even if they're all about the same thing?
6. Boost `Replik` over `Anförande`?
7. Titles and hooks: LLM-generated, or written by hand?
8. Party balance — ranker, feed, or nowhere?

### Human in the loop
9. Auto-publish, or an approval queue in Supabase before clips go live?
10. If a clip is flagged as misleading after publish, what's the takedown path?

### Technical
11. Compute: your own machine (as in the earlier hosting plan), or cloud GPU for transcription?
12. Confirming Bunny **Storage** rather than Stream?
13. Burn subtitles in, or ship VTT and render in Flutter? (I'd burn in and *also* store the VTT.)
14. 720 + 480 ladder, as previously planned?
15. Backfill historical debates, or only new ones from launch?
16. Freshness target — same-day, or next-morning is fine?
17. Do talman and ministers get clipped, or only MPs?
18. Keep the master after processing, or delete it? (Keeping means cheap re-cuts later.)
19. Minimum speech length worth processing?
20. Vertical only, or keep the 16:9 version too for a web view?

### One flag on a previous decision
The earlier hosting plan settled on **16:9 letterboxed, no cropping** — the reasoning was that cropping cuts context and letterboxing saves battery. You're now asking for 9:16 with speaker tracking, which reverses that. That's a legitimate call for a Reels-style feed, but it adds the whole of Process C: face detection, active-speaker detection, camera planning, and a much heavier render. Roughly 60% of the pipeline's complexity lives in that one decision. Worth confirming it's the right trade before building it.
