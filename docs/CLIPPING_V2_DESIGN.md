# Clipping v2 — speaker-anchored framing

**Status:** proposed, 2026-08-07. Not implemented.
**Scope:** C2 frame extraction, C8 vision, C9 camera, C10 render verification, and
the C7 seam that consumes framing evidence. Nothing else in the project.

This supersedes the *diagnosis* in `speaker_verified_crop_design.md` (2026-08-03)
where the two disagree, and adopts most of its recommended architecture. That
document reasoned from code; this one reasons from 1,746 measured live clips.

---

## 1. What is actually wrong

Measured over the whole published catalogue: **87 debates, 1,746 clips** with a
C8 track and a C9 plan, read straight from `D:/riketvideos`. No re-processing.

| Defect | Clips | Share |
|---|---:|---:|
| Tracked box too large to be a face (>205 px on a 1280 px frame) | 435 | **24.9%** |
| …grossly so (>256 px) | 215 | 12.3% |
| ≥1 shot inside the clip with **zero** face evidence, C9 holding a stale crop | 867 | **49.7%** |
| ≥2 such shots | 369 | 21.1% |
| Track covers <50% of the clip's frames | 607 | **34.8%** |
| **At least one of the above** | **1,297** | **74.3%** |
| Clean on all three | 449 | 25.7% |

A further 64 clips were correctly rejected by C8 as `no-face` and never published.

### 1.1 The camera is not the problem. The evidence is.

The single most important number:

```
face centre inside the planned crop   p10 = 1.000   p50 = 1.000   p90 = 1.000
…of those, sitting in the outer 15%   mean = 0.002
```

**The crop contains its target in 100% of samples.** C9's dead zone, rate limit,
scene-jump logic and clamping all work exactly as designed. The virtual camera
obeys its target perfectly — and the target is frequently not a person.

This rules out an entire class of fix. Smoothing (Kalman, EMA, one-euro),
padding margins, aspect-ratio-aware bounding boxes and trajectory optimisation
all act on a signal that is already 100% obeyed. None of them can move the
number, because none of them changes *what the camera is pointed at*.

### 1.2 What the detector is actually finding

Two published clips, drawn on their own C2 analysis frames. Green is the box C8
selected as the speaker; yellow is the 9:16 window C9 built from it.

- **`HD10392_ebe6af7e…_c01`** — Erik Slottner (KD) is speaking at the podium on
  the left, lower-third and all. Haar locked onto a **seated bystander's lap**,
  30% of frame width. The published vertical clip is 45 seconds of that person's
  crossed legs while Slottner speaks off-frame.
- **`HDC120260305fs_35dc833f…_c01`** — a wide chamber shot. Haar returned a box
  40% of frame width containing **rows of empty blue seats**. The published clip
  is empty furniture.

Both scored perfectly on every metric the pipeline currently computes.

The cause is the detector. `haarcascade_frontalface_default` is a 2001 cascade
that returns square boxes and **no confidence** — `src/vision/detect.py` invents
a score from area and centrality, so a large central false positive is *promoted*
by the very number meant to filter it. It also cannot see a profile, which is why
median coverage is 62%: the speaker vanishes from the evidence every time they
turn to address the chamber or look down at notes.

### 1.3 The gap-filling rule then publishes the failure

`src/camera/plan.py:65-69` — when a shot inside the clip has no samples, the plan
appends the *previous* crop position and moves on. Half the catalogue hits this.
Holding the old crop through a reaction shot does not keep the camera on the
speaker; it keeps it pointed at where the speaker used to stand, in a shot that
is now framing somebody else.

### 1.4 Vertical composition is unmanaged, but it is third-order

`crop_size_for_media()` returns `406 × 720` for a 1280×720 source — the **full
source height** — and `render_primary_clip()` hardcodes `crop=…:…:x:0`. The
`sendcmd` file only ever emits `crop x`. There is no vertical crop at all, so
subject height in the output is whatever the 16:9 broadcast chose.

On the 1,291 clips whose box is a plausible face, head height lands at
p25 = 0.294, p50 = 0.328, p75 = 0.370 — that band is fine, and close to the 38%
target §C2 of `ARCHITECTURE.md` always wanted. The tail is not: p90 = 0.765. So
this is a real defect worth fixing, but it is **not** what the owner is seeing.
Fix it after the evidence layer, not before.

---

## 2. Assessment of the advice received externally

Recorded because it was the starting point for this session, and because two of
its load-bearing claims are false for this codebase.

| Claim | Verdict |
|---|---|
| "Segment into scenes so the crop doesn't whip across cuts" | **Already done.** C2 runs PySceneDetect; C9 plans per shot and jumps at cuts. |
| "Your 9:16 crop truncates the chest because you anchor to a face" | **Structurally impossible here.** The crop is full source height, `y=0`, fixed. Nothing is cut off vertically. The real defect is the opposite: no vertical control at all. |
| "Apply a Kalman filter / EMA as a virtual steadicam" | **Cannot help.** Containment is 1.000 and edge-fraction 0.002; the camera already tracks its target exactly. Smoothing a perfectly-obeyed wrong target changes nothing. |
| "Use pyannote for VAD + diarization to find the active speaker" | **Solves a problem already solved better.** C1 gets speaker identity and timing from Riksdagen's own open data; C3 refines the boundary with VAD at ~0.84 confidence. Diarization would replace authoritative metadata with an inference, and it is a GPU-shaped dependency on a CPU-only box. |
| "Use ASDNet / TalkNet to link voice to lips" | **Not yet viable.** Analysis frames are 5 fps; audio-visual sync models need ~25 fps. Already assessed in `speaker_verified_crop_design.md` §6. |
| "`auto-vertical-reframe`, `pyautoflip` / AutoFlip" | **Wrong tool.** Generic vlog reframers that discard this project's two biggest assets — known speaker identity and real broadcast cut points. AutoFlip's saliency would have centred on the empty blue seats too. |
| **"Stop anchoring on faces; track the body"** | **Right, for a reason the advice did not give.** Not for gesture framing — for *continuity*. A torso does not disappear when the head turns, which is the fix for the 34.8% of clips with <50% coverage. |

---

## 3. The architectural change

> The pipeline currently decides **what** to clip from text and audio, then
> discovers whether the picture supports it. Framing must become a **selection
> input**, not a rendering afterthought.

Today C7 picks a window blind, C8 looks for a face inside exactly that window,
and if the picture is bad the only outcomes are *publish it anyway* (74%) or
*reject the whole speech* (the 64 `no-face` clips). A 6-minute speech contains
hundreds of admissible 38–62 s windows. Choosing the one that is *both* well
spoken and well shot costs nothing extra — the vision pass is per-speech, not
per-candidate.

```
                        ── current ──
C6/C7  text+audio ──► window ──► C8 look for a face ──► C9 ──► C10 ──► C11
                                        │
                                        └── bad picture ──► publish anyway | drop speech

                        ── proposed ──
C2   frames @ 960×540
  │
  ├─► C8a  detect people + faces, whole speech, once
  ├─► C8b  identity-lock to the expected politician (portrait + SFace)
  └─► C8c  framing-quality timeline for the whole speech
                    │
C6/C7  text + audio + framing ──► window ──► C9 compose ──► C10 ──► C10v verify ──► C11
```

Five components, in dependency order. Each is independently measurable, which is
the point — the current failure went unseen for two backfills because every
metric in the pipeline was one the defect satisfies by construction.

### 3.1 Detector — replace Haar (fixes §1.2)

Two layers, because they answer different questions.

**Faces — YuNet** (`cv2.FaceDetectorYN`, ships with the pinned OpenCV 4.11).
Real confidence scores, five landmarks, tolerates pose. **No new Python
dependency**; it needs one vendored ~230 KB ONNX file, pinned by SHA-256 and
licence, asserted at startup, never fetched during an unattended run.

**People — an upper-body/person detector** as the continuity anchor. This is the
one genuinely useful idea from §2. A face is absent for 38% of frames; a torso
is not. It gives C9 something to hold onto through a head-turn instead of
freezing the crop, and it supplies the body extent that §3.5 composition needs.
`onnxruntime` is **already installed**, so this can also be a vendored ONNX
model with no new Python dependency.

Raw detector confidence gets recorded as-is. The current practice of
synthesising a score from area and centrality is what promoted the empty seats,
and it must not survive.

**Frames at 960×540.** A podium face is ~53 px at the current 480×270 — marginal
for detection and far too small for identity. Doubling each dimension makes it
~106 px, which is where YuNet and SFace actually work. Costs ~380 MB transient
disk per debate and a re-decode of every master.

**Measurement before adoption:** Haar@480 vs YuNet@480 vs YuNet@960 on the same
clips. Report real-face coverage and the >0.16-frame-width false-positive rate.
Adopt 960 only if it earns the decode.

### 3.2 Identity lock — the expected politician (fixes §1.2's second half)

The pipeline already knows who should be on screen. It has never checked.

`intressent_id` → official Riksdagen portrait → YuNet → `alignCrop` → SFace
embedding, cached and hashed. Video observations are sampled (first quality
observation per track, then ≤1/second) and compared. A track becomes the target
only on **aggregate** evidence — ≥5 quality embeddings, median and 20th-percentile
similarity above calibrated thresholds, and a margin over competing faces — never
one pairwise match.

Enroll the other participants of the same debate as a closed-set of hard
negatives; they are already listed in `03_speeches.json`. If a candidate matches
another named politician better than the expected speaker, reject.

Do **not** adopt OpenCV's documented 0.363 LFW cosine threshold as the production
gate. Calibrate on Pleni footage, from the false-accept side of the curve.

This is what rejects the Slottner lap and the empty seats: neither is a face, and
neither is Erik Slottner.

### 3.3 Scene cuts terminate tracks

`merge_fragmented_tracks()` stitches on time-gap plus IoU at the seam and is
never given the scene list. A cut can place a different person at the same screen
position; IoU across a cut is not evidence of identity. Hard-reset every track at
every C2 cut, and re-associate across shots only through §3.2.

### 3.4 Framing-quality timeline → selection (fixes §1.3, recovers yield)

C8 emits, for the whole speech, a per-shot record: target verified-present,
target box, apparent size, competing faces, shot class (close / medium / wide /
multi-person). From it, two numbers per candidate window:

- `target_visible_frac` — share of the window where the target is verified-visible
- `face_height_frac` — real value at last. It has been **hardcoded to `1.0`** in
  `src/scoring/text_features.py:108` since C7 shipped, against a gate constant of
  `MIN_FACE_HEIGHT_FRAC = 0.0` in `src/scoring/gate.py:14` — a check that has
  never been able to fire.

C7 then picks the highest text/audio-scoring window **among the visually clean
ones**, instead of picking blind and hoping. A shot where the target is absent
makes a window ineligible rather than making the clip stale-cropped.

C9 loses the hold-the-last-crop rule entirely. No verified samples in a shot
means the window was not eligible; if one slips through anyway, the clip is
unsupported and not rendered.

### 3.5 Composition — two axes and a zoom (fixes §1.4)

Only after the above. Today: `crop_x` alone, fixed 406×720, `y=0`.

- **Vertical:** place the eye-line at ~38% from the top. Requires a crop shorter
  than the source, i.e. a tighter crop and more upscale.
- **Zoom:** punch in on a wide chamber shot where the subject is small; stay wide
  on a close-up. Currently a distant speaker either fills 32% of the width with
  chamber furniture or gets rejected.
- **Horizontal:** anchor on the head but respect the body box, with look-room in
  the direction the subject faces.

**The trade-off must be stated, not hidden.** A 406×720 crop upscales 1.33× to
540×960. A 304×540 crop that buys 180 px of vertical travel and a punch-in
upscales 1.78×. Source is only 720p, so this is real detail against real
composition, and it is a product judgement.

### 3.6 Verify the render (catches the next one)

Sample the actual `540×960` MP4 at 2 fps plus shot boundaries; run YuNet + SFace;
confirm the target is present and contained. C11 publishes only on acceptance.

This is the stage whose absence let 74% of the catalogue ship. It is the only
check that reads the bytes a viewer would actually see, and it is independent of
every coordinate transform, `sendcmd` timing and stale artifact between C8 and
the file.

---

## 4. Order of work

Each phase is independently measurable and independently shippable.

| # | Work | Fixes | Measure |
|---|---|---|---|
| **1** | Vendor YuNet; `FaceDetector` protocol; Haar/YuNet@480/YuNet@960 bake-off | §1.2 | real-face coverage; >0.16-width false-positive rate |
| **2** | Portrait enrollment + SFace; scene-terminated tracks; closed-set negatives | §1.2, §1.3 | the two named clips reject; false-accept rate on a labelled set |
| **3** | Framing timeline; real `face_height_frac`; vision-eligible window selection in C7 | §1.3 | clips with a zero-evidence shot → target 0%; yield vs today |
| **4** | Two-axis composition + punch-in | §1.4 | head-height spread p10–p90; owner review |
| **5** | `C10v` render verification; C11 gate | future regressions | accepted-clip precision on an audit sample |

Phases 1–2 are where the owner's complaint lives. Phase 3 is where the yield lost
to phases 1–2 comes back. Phases 4–5 are quality and safety.

**Validation set.** Per `speaker_verified_crop_design.md` §9.2: label ~50–100
clips at shot level, 3 frames per shot, stratified by shot type, party, pose and
framing. Freeze it; re-run it on every threshold change; never tune and report on
the same set. With zero failures in *N* audited clips the 95% upper bound on the
failure rate is about 3/*N* — 100 clips buys "under 3%", not "perfect".

---

## 5. Consequences

**Contracts.** `FaceSample`/`FaceTrack` cannot express detector confidence,
landmarks, provenance (detected vs interpolated), scene id, or identity evidence.
Phase 2 needs an ADR under rule 1, and new models rather than overloaded ones.
Keep detected observations separate from interpolated camera support:
interpolation is camera smoothing, never evidence, and must never count toward a
coverage or acceptance threshold.

`FaceSample.is_speaking` is set to `True` for every sample of the selected track
(`src/vision/track.py:217-227`). It has never carried an active-speaker decision.
Either populate it from a real classifier or drop the claim.

**The live catalogue.** All 1,762 published clips came from this pipeline; ~74%
carry at least one of the three defects. Re-render and re-publish is the owner's
call, and is a separate decision from building the fix.

**Cost.** Vision goes from Haar-per-clip to a per-speech pass with a heavier
detector, plus sampled SFace. Estimated +5–12 min per debate against the current
~9 min end to end, on 12 CPU cores with no GPU. Re-analysing the 87-debate
backfill is an overnight job; re-rendering is ~8 CPU-hours, ~1.5 h across 6
workers.

**Yield will drop before it recovers.** Phase 2 rejects clips that today publish
with the wrong subject. Phase 3 is what turns those rejections back into clips by
moving the window instead of dropping the speech. Shipping 2 without 3 will look
like a regression in volume; it is not.

---

## 6. Phase 1 result — measured 2026-08-07

22 clips, stratified by current tracked-box width (10 broken >0.20, 5 marginal
0.16–0.20, 7 healthy 0.09–0.14). Every config was pushed through the **real**
`build_face_tracks` → `merge_fragmented_tracks` → `select_active_track` path, so
what is compared is the track the pipeline would have chosen.

| config | frames w/ a face | track chosen | median box width | track coverage | box >0.16 |
|---|---:|---:|---:|---:|---:|
| `haar480` (current) | 0.925 | 22/22 | **0.176** | 0.581 | **15/22** |
| `yunet480` | 0.974 | 22/22 | 0.099 | **0.858** | **0/22** |
| `yunet960` | 1.000 | 22/22 | 0.097 | **0.858** | **0/22** |

**Adopt YuNet at 480×270.** Every impossible box in the sample is gone, and the
width distribution collapses from a bimodal 0.176 — real faces at ~0.11 mixed
with torsos and furniture above 0.20 — to a tight 0.097. Track coverage rises
48% relative.

### 6.1 960×540 does not earn the re-decode — for detection

`speaker_verified_crop_design.md` §3.2 predicted "YuNet at 960×540 becomes
default". Measured, it does not. Frame-level detection improves 2.6 pp, but
**median box width and track coverage are identical to 480×270** — the same
track gets chosen either way. Re-extracting frames for 87 debates buys nothing
at the only level that matters.

This is a detection finding only. SFace needs pixels *on the face*: a 0.097
box is ~124 px at master scale but only ~46 px on a 480-wide analysis frame,
which is marginal for identity. Re-open 960×540 as a **Phase 2 identity**
question, decided on identity accuracy, not detection coverage.

### 6.2 A person/body detector is not the fix for the coverage gap

The gap was assumed to be missing detections — a face vanishing when the speaker
turns their head, which a torso would have survived. It is not. YuNet detects a
face in 97–100% of frames. On the clips that still show low track coverage:

| clip | faces/frame | tracks | top-1 cov | top-2 cov |
|---|---:|---:|---:|---:|
| single-speaker podium ×3 | 1.00 | **1** | **1.00** | 0.00 |
| debate two-shot | 2.50 | 14 | 1.00 | **0.98** |
| debate, alternating | 2.00 | 10 | 0.65 | 0.37 |

The residual is **two people on screen, both tracked perfectly, and no signal
saying which one is speaking**. A body detector adds evidence where evidence is
already complete. It cannot answer the question that is actually being asked.

Single-speaker podium — the majority case — is fully solved by the detector
swap alone: one track, coverage 1.00.

### 6.3 New finding: the merger fuses two people at the same podium

On `HD10392_ebe6af7e…_c01` the selected track alternates between Erik Slottner
and a different speaker who uses the **same podium** later in the clip.
`merge_fragmented_tracks` is not scene-aware, so a cut that replaces the person
while preserving screen position produces a high seam IoU and the two are
stitched into one identity. This is §3.3 confirmed against live footage, and it
is now the *dominant* residual defect rather than a theoretical risk.

### 6.4 Implementation notes discovered

- **YuNet returns boxes extending past the frame edge.** `FaceSample.x/y` are
  `NonNegativeFloat`, so an unclamped box raises `ValidationError`. Clamp to the
  frame and drop degenerate boxes.
- **Confidence is real and well separated:** podium faces score 0.89–0.95,
  background faces 0.75–0.92. A 0.70 threshold is sane; calibrate later.
  `detect.py`'s synthesised area+centrality score must be deleted, not reused —
  it is what promoted the furniture.
- **OpenCV Zoo NanoDet is not a drop-in.** Its ONNX emits GFL distribution bins,
  not `xyxy`; it needs DFL decoding. Irrelevant given §6.2, but recorded.

### 6.5 Revised order of work

Phase 1 stands as adopted (YuNet @ 480). Phases 2 and 3 merge in priority: after
the detector swap, **every remaining measured defect is an identity or
scene-continuity problem**, and both are §3.2 + §3.3. The body detector is
dropped from the plan. 960×540 is deferred to a Phase 2 identity decision.

---

## 7. Phase 2 result — measured 2026-08-08

Identity verification shipped as ADR 012. Yield measured by running the real C8
path read-only over 319 published clips across 14 randomly chosen debates.

| Outcome | Clips | Share |
|---|---:|---:|
| **accepted** | **130** | **40.8%** |
| rejected — no verified speaker in a long shot | 161 | 50.5% |
| rejected — no official portrait to enrol | 27 | 8.5% |
| rejected — identity mismatch | 1 | 0.3% |

**40.8%, sitting exactly on the 40% floor §7.5 set for a viable gate.**

### 7.0 A first measurement of 67.4% was wrong, and why

The first run of this audit reported **67.4%**. It was counting a decision that
did not survive contact with the renderer.

C8 accepted any clip clearing `min_verified_frac`, *even when it had recorded an
unsupported span longer than the tolerated cutaway* — while C9 refuses to plan a
camera across exactly such a span. The two gates disagreed, so `08_track`
asserted `accepted` for clips that silently never rendered. A full run of
`HD10342` exposed it: **C8 reported 15 accepted, C10 emitted 8**, and the other
seven vanished with no record anywhere.

That is the same defect class as ADR 010's fabricated face box — an artifact
claiming a success that never happened — and it is worth noting that it survived
a green unit suite and was only caught by processing one real debate end to end.
The long span now decides and `min_verified_frac` is a backstop;
`test_an_accepted_clip_never_carries_a_span_c9_will_refuse` pins it.

Every yield figure in this document is the post-fix one.

### 7.1 The rejections are real absences, not a mechanical fault

The largest single cause is a shot with no identity evidence, which could mean
either "the speaker genuinely is not on screen" (correct) or "faces were there
and the sampling lost them" (a defect). Measured per shot on the two debates
where it fires most:

| | `HD10384` | `HDC120260319fs` |
|---|---:|---:|
| no faces detected at all | 83.3% | 95.6% |
| track below the per-shot coverage floor | 16.7% | 4.4% |
| **track fine but no embedding produced** | **0** | **0** |

Zero cases of the defect mode. The coverage-floor cases were single detections
in 1 of 26 and 1 of 47 frames — spurious, correctly dropped. **The clips being
rejected are clips where the expected speaker is genuinely off screen**, which
is exactly the complaint this work exists to fix.

### 7.2 The dominant cause is a real absence, not a mis-set threshold

`unsupported_span_exceeds_1.0s` fires on 160 of the 189 rejections, so the
obvious question is whether the 1.0 s cutaway tolerance is simply too strict.
Measured on `HD10342`'s rejected clips, the **longest** unsupported span in each:

```
2.6  3.5  3.6  4.0  4.4  4.6  5.2  6.2  6.2  8.6  18.2  20.8  32.5  37.1
```

Median 5.7 s, and the shortest is 2.6 s. Raising the tolerance to 3 s recovers
1 of 14; to 5 s recovers 6, but a five-second stretch is roughly an eighth of a
45-second clip spent on somebody else, which is the defect this exists to stop.

**The tolerance is not what is costing yield — the footage genuinely cuts away.**
Loosening it would buy volume by re-admitting the original complaint.

### 7.3 Yield varies by debate type, and the floor is structural

Debate format predicts yield far better than any threshold:

| format | example | yield |
|---|---|---:|
| single speaker at the lectern | committee debates | approaching 100% |
| interpellation, two people trading turns | `HD10342` | **36.4%** |
| frågestund, many short ministerial answers | `HDC120260319fs` | **34.5%** |

Interpellation and frågestund cut constantly between questioner, minister and
chamber, and carry a high share of wide shots where no face is detectable at
all. Those formats are where the old pipeline's mis-framing was worst, so the low
yield is the gate working, not failing.

### 7.4 The cheapest remaining yield is not a vision problem

**27 clips (8.5%) were rejected only because no portrait could be enrolled** —
`intressent_id` is absent for ministers who are not sitting members, a gap
already recorded in the March and February backfill notes. Riksdagen does
publish these ids; the default `anforandelista` query omits them and
`personlista?...&rdlstatus=samtliga` returns them.

**Closing that alone takes yield from 40.8% to 49.3%**, and it is a C1 metadata
fix with no vision work in it — the best return available per unit of effort.

It is no longer, however, a *substitute* for vision-aware window selection
(§3.4). At 40.8% the gate is on the floor rather than comfortably above it, and
§3.4 is the one remaining lever that raises yield without weakening the identity
gate: a speech contains hundreds of admissible windows, and choosing one that is
also visually clean costs nothing extra because the vision pass is per speech.
The earlier reading of this document — that §3.4 could probably be skipped —
rested on the 67.4% figure and does not survive its correction.

### 7.5 What is not yet established

Yield is not precision. These numbers say how many clips survive the gate, not
how many surviving clips are correctly framed. Under the rule of three, zero
observed failures in an audit of *N* accepted clips bounds the true failure rate
at about 3/*N* — so the shot-level validation set of §9.2 is still owed, and
until it exists the honest claim is "the known failure modes are fixed and the
gate rejects real absences", not "the output is verified correct".
