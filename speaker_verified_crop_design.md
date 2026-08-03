# Speaker-Verified Crop Design for riketTV

**Repository:** `Mulanger/riketTV`  
**Reviewed branch:** `main`  
**Reviewed commit:** `8d95d1fae30860af936b7e42aba54a5fae07cb32`  
**Date:** 2026-08-03

## Executive decision

The crop pipeline should stop trying to infer the speaker from geometry alone.

The system already knows the expected politician for every clip. The safest design is therefore:

1. detect real faces with YuNet;
2. identify which detected face is the expected politician with SFace;
3. build the crop only from identity-verified observations;
4. reject clips when the expected politician is absent, too small, ambiguous, or insufficiently observed;
5. run an end-to-end identity check on the rendered vertical file before publication.

Lip-motion correlation should not be the next major investment. At 5 fps it is too weak for reliable audio-visual synchronisation, and the two YuNet mouth-corner landmarks do not measure mouth opening. Identity verification provides much more value for this product because the speaker identity is already known.

A lower verified yield is the correct outcome. A clip with no verified target face must not degrade to a center crop, a previous crop, or the “best” unverified face.

---

## 1. Findings in the current repository

### 1.1 Synthetic observations enter the tracker as real faces

`src/vision/detect.py` defines `estimate_speaker_proxy()` and returns it whenever Haar detects nothing and `fallback=True`.

`src/stages/track.py` calls the detector with `fallback=True` on every frame, including the second pass used when a sign-language inset is configured.

That means a detector miss is not represented as missing evidence. It becomes a stable, centered, positive face observation and is then passed through scaling, tracking, scoring, interpolation, camera planning, rendering, and publication.

This must be removed before any scoring or detector tuning. No downstream heuristic can recover the distinction after fabricated observations have been mixed into the track.

### 1.2 The current “coverage floor” is fail-open

`src/vision/track.py::_long_enough_to_be_a_speaker()` returns all tracks when no candidate clears `MIN_COVERAGE_FRAC`.

That behavior is explicitly documented as degrading to a best guess rather than no face. For this product, that is the wrong default. If no candidate meets the evidence floor, C8 should emit no verified target track and the clip should become ineligible for publication.

### 1.3 Track stitching is not scene-cut aware

The current fragment merger uses time gap and IoU at the seam. It does not receive scene boundaries.

A cut can place a different person in approximately the same part of the frame. IoU across the seam is therefore not proof of identity. Tracks should terminate at every scene cut. The same politician can be re-associated across shots only through identity evidence, not geometric continuity.

### 1.4 C9 also fails open

`src/camera/plan.py` currently:

- holds `last_crop_x` when a shot contains no face samples;
- creates a center crop when the whole clip produces no keyframes.

Those are acceptable preview behaviors, but not publication behaviors. A shot with no verified target samples must be marked unsupported. C9 should not silently convert absence of evidence into a valid camera plan.

### 1.5 C8 marks every selected sample as speaking

`active_face_track()` sets `is_speaking=True` for every returned sample after selecting a track. This field does not currently reflect an audio-visual active-speaker decision.

That is misleading. Either remove the semantic claim, rename the field in a future contract, or populate it only from an actual active-speaker classifier. Identity, visibility, and speaking state are separate signals.

### 1.6 Existing seams are useful

The stage architecture is suitable for the fix:

- C2 already writes reusable frames, audio, and scene cuts.
- C8 already has a detector builder and an `ActiveSpeakerBackend` protocol.
- C9 consumes a disk artifact rather than internal C8 state.
- C10 renders per clip.
- C11 can be made conditional on a verification artifact.

The change should be implemented as explicit artifacts and gates rather than hidden scoring weights.

---

## 2. Recommended architecture

## 2.1 Proposed stage flow

```text
C2  Extract frames, audio, scene cuts
 |
 v
C8a Detect real faces with YuNet
 |
 v
C8b Track within each scene and compute identity observations with SFace
 |
 v
C8c Build expected-speaker track from identity-verified observations
 |
 v
C8d Decide source-track eligibility: accept / reject with reasons
 |
 v
C9  Build camera plan only from eligible verified track
 |
 v
C10 Render vertical MP4
 |
 v
C10v Verify the rendered output independently
 |
 v
C11 Publish only if both source verification and render verification pass
```

C8a–C8d may be one executable stage with multiple artifacts, but the concepts should remain separate.

## 2.2 Suggested artifacts

### `08_faces/<clip_id>.json`

All real YuNet detections, preserving scene and provenance.

```json
{
  "clip_id": "...",
  "observations": [
    {
      "t": 123.4,
      "scene_id": 17,
      "box": {"x": 500, "y": 110, "w": 155, "h": 180},
      "detector_score": 0.94,
      "landmarks": {
        "right_eye": [540, 160],
        "left_eye": [600, 158],
        "nose": [570, 190],
        "right_mouth": [550, 220],
        "left_mouth": [592, 218]
      },
      "source": "detected"
    }
  ]
}
```

There should be no synthetic observation type.

### `08_identity/<clip_id>.json`

Track-level and observation-level identity evidence.

```json
{
  "clip_id": "...",
  "expected_intressent_id": "...",
  "portrait_sha256": "...",
  "tracks": [
    {
      "track_id": "scene-017-track-002",
      "scene_id": 17,
      "quality_embeddings": 8,
      "target_cosine_median": 0.61,
      "target_cosine_p20": 0.54,
      "target_match_count": 7,
      "second_best_margin_median": 0.16,
      "decision": "target"
    }
  ]
}
```

### `08_verification/<clip_id>.json`

The publication decision and auditable reasons.

```json
{
  "clip_id": "...",
  "decision": "reject",
  "reasons": ["target_absent_during_voiced_shot"],
  "target_visible_voiced_frac": 0.72,
  "verified_observation_count": 19,
  "longest_unverified_voiced_gap_s": 4.8,
  "ambiguous_scene_count": 0,
  "unsupported_scene_count": 2
}
```

### `10_verify/<clip_id>.json`

End-to-end verification of the final rendered MP4.

```json
{
  "clip_id": "...",
  "decision": "accept",
  "target_visible_sample_frac": 0.97,
  "wrong_identity_sample_count": 0,
  "no_face_sample_count": 1,
  "face_containment_frac": 1.0
}
```

C11 should require both verification decisions to be `accept`.

---

## 3. Detector choice

## 3.1 Replace Haar with YuNet

YuNet is the correct next foundation under the stated constraints:

- it is exposed by the pinned OpenCV dependency through `cv2.FaceDetectorYN`;
- it is CPU-capable;
- it returns a confidence score and five landmarks;
- it handles poses and difficult faces better than a frontal Haar cascade;
- the ONNX model is small;
- it adds no Python dependency.

For OpenCV 4.11, use the OpenCV Zoo model compatible with OpenCV 4.x, such as `face_detection_yunet_2023mar.onnx`. Vendor the model in the repository or retrieve it through a controlled model-install step. Record:

- exact source;
- model license;
- file SHA-256;
- expected OpenCV version;
- a startup checksum assertion.

Do not download model files opportunistically during unattended production runs.

## 3.2 Recommended detection resolution

Use **960×540 at 5 fps** for the main debate-wide analysis pass.

Reasoning:

- the current 480×270 frames make a roughly 53 px podium face marginal;
- doubling each dimension makes the same face roughly 106 px wide;
- this materially improves detection, landmark stability, blur assessment, and SFace alignment;
- 5 fps remains sufficient for identity sampling, shot-level visibility, and crop position;
- the roughly 380 MB transient frame cost per debate is reasonable compared with publishing the wrong identity.

Do not increase the whole debate to 10 fps initially. It doubles storage and detector inference without addressing the principal failure, which is missing identity verification.

Use a selective higher-rate path only for ambiguous selected clips.

## 3.3 Detection thresholds

Treat detection as candidate generation, not the final trust decision.

A reasonable initial YuNet configuration for benchmarking is:

```text
score_threshold: 0.70
nms_threshold:   0.30
top_k:           500
```

The official examples commonly use a stricter score threshold, but a moderately lower candidate threshold is reasonable here because SFace and track-level evidence will reject false detections. These values must be calibrated on riketTV footage rather than adopted as permanent constants.

Record raw detector scores. Do not transform size and centrality into a fake detector confidence as the current Haar wrapper does.

## 3.4 Is there a better dependency-light CPU detector?

Possibly, but not as the first step.

SCRFD and some face-specific YOLO models may outperform YuNet in difficult small-face cases, but they add model-runtime, licensing, packaging, or dependency questions. The first benchmark should compare:

1. Haar at 480×270;
2. YuNet at 480×270;
3. YuNet at 960×540.

If YuNet at 960×540 still fails to produce usable identity observations on an unacceptable share of close and medium speaker shots, then benchmark one alternative detector through OpenCV DNN or ONNX Runtime. Do not add a larger stack before measuring the built-in option.

---

## 4. Identity verification

## 4.1 Use SFace as the primary automatic verification signal

The expected politician’s official portrait should be enrolled with the same YuNet + SFace path used for video faces:

1. retrieve the official portrait by `intressent_id`;
2. validate content type and cache it;
3. detect the portrait face with YuNet;
4. align it with `FaceRecognizerSF.alignCrop`;
5. extract an SFace feature vector;
6. store the portrait hash and embedding metadata.

For video observations:

1. keep only sufficiently large, sharp, non-truncated detections;
2. align with YuNet landmarks;
3. extract SFace embeddings from a sampled subset;
4. compare each feature to the expected portrait;
5. aggregate scores robustly at track and scene level.

Do not run SFace on every face in every 5 fps frame. A practical schedule is:

- first high-quality observation in a track;
- then at most one observation per second;
- additional observations after a large pose, scale, or lighting change;
- first and last high-quality observations in every scene.

This limits CPU cost while preserving independent evidence.

## 4.2 Do not accept on one pairwise match

A single official portrait versus a single video crop has substantial domain shift:

- portrait age may differ;
- glasses, facial hair, hairstyle, and weight may change;
- the portrait is well lit and frontal;
- debate frames include profile pose, motion blur, compression, and occlusion;
- the detected crop may include only a small face.

Use multiple observations and robust summaries.

A starting track rule should require all of the following:

```text
quality embedding count >= 5
median target similarity >= calibrated T_accept
20th-percentile target similarity >= calibrated T_floor
at least 60% of quality observations above T_frame
median margin over competing faces >= calibrated M_accept
```

These are structural requirements. The numerical thresholds must be learned from riketTV data.

## 4.3 Do not use OpenCV’s published threshold as the publication threshold

OpenCV documents an SFace cosine threshold of 0.363 on LFW. That is a useful smoke-test reference, not a production acceptance threshold for this footage.

The threshold should be selected from a riketTV validation set at the required false-accept operating point. Optimizing overall accuracy or equal-error rate is inappropriate because false acceptance is much more costly than false rejection.

## 4.4 Use margins, not only absolute similarity

When multiple faces are visible, compute:

```text
target_similarity(candidate)
minus
best_target_similarity(other_face_in_same_scene)
```

The expected face should be both:

- sufficiently similar to the target portrait; and
- clearly more similar than competing visible faces.

A low margin is an ambiguity signal even when the absolute score passes.

## 4.5 Enroll the other debate participants where cheap

The metadata already identifies the speakers in the debate. Fetching their portraits creates a small closed-set gallery.

This supports two strong rejection signals:

- the chosen face matches another named politician better than the expected speaker;
- two identities are too close to distinguish reliably.

Audience members will remain outside the gallery, so closed-set identification does not replace the target threshold. It is an additional hard-negative check.

## 4.6 Add a carefully controlled video gallery later

One official portrait is a weak enrollment set. After a clip has passed strict automated checks and a human audit, save a small set of high-quality in-chamber embeddings for that politician.

Future comparisons can use:

```text
max or robust top-k similarity against:
- official portrait embedding
- 3–10 audited video exemplar embeddings
```

Do not bootstrap the gallery from merely auto-accepted clips at the beginning. A false acceptance could contaminate a politician’s gallery and create repeated future false acceptances.

## 4.7 False-accept risks

The principal identity false-accept risks are:

- visually similar politicians;
- relatives or look-alikes;
- low-resolution faces where embeddings collapse toward generic features;
- extreme profile views;
- old portraits;
- a face displayed on an in-frame monitor;
- sign-language interpreter insets;
- track contamination across scene cuts;
- one incorrect high-confidence observation dominating an average;
- threshold calibration on easy close-ups only;
- accidental gallery contamination.

Mitigations:

- minimum face size and quality;
- multiple observations;
- low-quantile score requirements;
- same-scene competitor margins;
- hard reset at cuts;
- explicit inset and screen-region handling;
- calibrated thresholds on hard cases;
- immutable portrait hashes;
- audited exemplar promotion.

---

## 5. Tracking and camera planning

## 5.1 Track only within a scene

Every C2 scene cut is a hard tracking boundary.

Within a scene, associate detections using a combination of:

- IoU;
- center displacement normalized by face size;
- scale change;
- landmark geometry;
- identity similarity when available.

The number of faces per chamber frame is low enough that a deterministic greedy matcher is acceptable initially. A Hungarian assignment algorithm is not required unless benchmarked failures justify it.

## 5.2 Rejoin across shots by identity, not IoU

The expected politician may appear in multiple separate shots. Those observations can be combined into one logical speaker timeline, but each shot retains its own track identifier and quality decision.

Do not interpolate boxes across a scene cut.

## 5.3 Interpolation is camera support, not evidence

Short interpolation can smooth a verified same-scene track, but interpolated samples must carry provenance and must not count toward:

- identity coverage;
- detector coverage;
- verification sample count;
- acceptance thresholds.

Recommended maximum interpolation gap:

```text
0.6–1.0 seconds within the same scene
```

A longer gap should be unsupported unless a separate visual tracker is introduced and validated.

## 5.4 C9 must consume only verified target samples

C9 should never receive the largest or most centered generic face as the selected track.

For every shot:

- verified target samples exist: plan the crop;
- brief supported interpolation exists: use it but retain low confidence;
- target absent or unsupported: reject the clip or choose a different clip window.

Holding the previous crop through a reaction shot does not keep the crop on the speaker. It merely keeps the camera pointed at where the speaker was in the previous shot.

## 5.5 Prefer changing the clip window over forcing bad footage

C6/C7 generate many candidate windows within one speech. Vision eligibility should feed back into candidate selection.

A speech may contain:

- a clean 45-second podium segment;
- a 5-second reaction cut;
- a later wide shot.

Instead of rendering the original textual winner, select the highest-ranked 38–62 second candidate that also passes speaker-visibility verification. This preserves clip volume without weakening the identity gate.

---

## 6. Active-speaker detection and lip motion

## 6.1 Simple RMS-to-lip correlation is not worth prioritizing

A direct correlation between audio RMS and lip motion is weak because:

- speech amplitude is not proportional to mouth opening;
- plosives, fricatives, and vowels produce different visual motion for similar energy;
- the chamber audio may include room sound, applause, or microphone processing;
- mouth movement can precede or lag envelope peaks;
- profile pose and hand occlusion break the visual measurement;
- 5 fps samples only every 200 ms.

At 5 fps, aliasing is severe for phoneme-scale motion. The system may detect that a face moves sometimes, but not reliably establish audio-visual synchrony.

## 6.2 YuNet’s landmarks are insufficient for mouth aperture

YuNet returns the two mouth corners, but not upper- and lower-lip landmarks. The distance between mouth corners mostly measures mouth width, not opening and closing.

A handcrafted lip signal would need one of:

- a denser landmark model;
- optical-flow or frame-difference energy in a normalized mouth ROI;
- a trained audio-visual model.

Each adds complexity and requires its own validation.

## 6.3 Frame rates by use case

```text
5 fps:
- face detection
- identity sampling
- shot-level target visibility
- crop-position anchors
- final rendered identity sampling

10 fps:
- coarse mouth-region motion versus voiced/pause intervals
- still not reliable lip synchronisation

15 fps:
- practical minimum for handcrafted mouth-motion experiments

25 fps:
- appropriate for SyncNet/TalkNet-style audio-visual temporal models
```

Do not increase all debate extraction to 25 fps. If an ambiguity resolver is later justified, decode only the selected clip or ambiguous scenes at 25 fps directly from the master.

## 6.4 Cheaper useful signals

Before lip synchrony, use:

1. **expected identity present during voiced time**;
2. **target is the dominant face in the shot**;
3. **target face is close or medium, not tiny**;
4. **target is continuous through the scene**;
5. **shot begins near a transcript/speech boundary**;
6. **reaction or wide-shot duration is low**;
7. **mouth-region motion is higher during voiced spans than long pauses**, as a weak diagnostic only.

Because the clip maps to one known speech, identity presence during the aligned speech is already a strong product-specific signal.

## 6.5 When to revisit TalkNet

Revisit a trained active-speaker model only if identity verification still accepts a meaningful number of clips where:

- the expected politician is visible but not actually speaking;
- multiple on-screen speakers create persistent ambiguity;
- transcript boundaries frequently overlap hand-offs.

Do not introduce TalkNet merely because the protocol seam exists. CPU throughput, 25 fps decoding, face-track preparation, model packaging, and validation cost are not justified until this residual failure is measured.

---

## 7. Rejection policy

## 7.1 Publication should be fail-closed

Use three internal outcomes:

```text
ACCEPT_AUTO
REJECT_AMBIGUOUS
REJECT_UNSUPPORTED
```

Only `ACCEPT_AUTO` is publishable. There is no “best guess” publication path.

## 7.2 Initial source-level acceptance rule

The exact thresholds require calibration, but the first policy should have this form:

### Identity

- valid portrait enrollment;
- at least 5 quality target embeddings overall;
- target identity passes the calibrated high-precision threshold;
- target wins over other visible faces by the calibrated margin;
- no scene classified as a conflicting identity.

### Visibility

- target visible and identity-verified for at least **90–95% of voiced sampled time**;
- no unsupported voiced gap longer than **1.0 second**;
- no reaction shot with another dominant face during voiced speech;
- no shot where the target is known to be absent but C9 continues to hold the old crop.

### Framing

- target face center lies inside the planned horizontal crop for at least **98% of verified samples**;
- target box is not materially clipped by the crop;
- target face is large enough for identity and acceptable presentation;
- pan velocity and shot-boundary jumps remain within product constraints.

### Render verification

- target identity is found in the final vertical MP4 at the expected sampled times;
- no sampled frame contains a conflicting dominant face;
- final crop containment passes;
- no coordinate, sendcmd, scaling, or stale-artifact error is detected.

## 7.3 Clips that should be dropped

Drop rather than fix when:

- the expected politician is not visible for a speech-active reaction shot;
- the only target face is too small for reliable identity;
- all usable observations are extreme profile or occluded;
- the identity score is near the threshold or lacks margin;
- the track crosses a scene cut without fresh identity confirmation;
- a sign-language inset or monitor image creates ambiguity;
- the target appears only briefly while another face dominates;
- the final render cannot independently verify the target;
- the official portrait cannot be enrolled reliably;
- source footage itself does not contain a usable 38–62 second verified window.

These are source-evidence failures, not camera-smoothing problems.

## 7.4 Clips that can be fixed

Potentially fixable:

- a short same-shot detector dropout;
- modest speaker movement inside one shot;
- crop lag while the identity track remains valid;
- a bad candidate window when another window in the same speech has continuous target visibility;
- detector misses solved by 960×540 YuNet;
- an old portrait solved by an audited in-chamber exemplar gallery.

## 7.5 Expected yield

A defensible yield cannot be calculated from the current 16 clips because the current metric was contaminated by synthetic observations and the set is not a representative validation corpus.

For planning, budget for an initial **40–70% auto-verified yield**. This is an engineering estimate, not a measured result. The main losses will likely come from target-absent reaction shots, wide shots, low-quality identity observations, and intentionally strict thresholds.

Interpretation:

- below 30%: improve detector resolution, portrait enrollment, and candidate-window selection;
- 40–70%: plausible first production gate;
- above 80% immediately: audit aggressively for an acceptance threshold that is too permissive.

Given the available source volume, even a lower yield may be commercially preferable to uncertain identity attribution.

---

## 8. End-to-end verification after rendering

This is the highest-value independent safety stage.

C10v should sample the actual `540×960` output, not reuse C8 boxes or assume C9 and ffmpeg applied the plan correctly.

For example:

```text
sample at 2 fps
plus:
- first frame after every source scene cut
- one frame before every source scene cut
- first and last second
```

For each rendered sample:

1. run YuNet;
2. run SFace on quality faces;
3. verify the expected politician;
4. record face position and containment;
5. classify no-face, target, other, or ambiguous.

Advantages:

- catches wrong track selection;
- catches stale C9 artifacts;
- catches crop coordinate mistakes;
- catches ffmpeg sendcmd timing errors;
- catches target being outside the final crop;
- operates on larger apparent faces after vertical scaling;
- audits the exact media that C11 would publish.

This stage shares models with C8, so it is not statistically independent. It is operationally independent of the crop plan and catches an important class of end-to-end failures. Manual auditing remains necessary for model common-mode errors.

---

## 9. Measurement and validation

## 9.1 There is no fully self-validating metric

No automatic proxy can prove the verifier is correct without some independent truth. The previous geometric metric failed precisely because it measured a property the synthetic box was designed to satisfy.

Identity similarity is much closer to the actual requirement, but thresholds and model failure modes still require labeled validation.

The goal is not zero labeling. It is a small, high-information audit set.

## 9.2 Label shots, not every frame

Use C2 scene cuts to reduce annotation effort.

Build a validation set of approximately:

```text
50–100 clips
300–600 shots
3 audit frames per shot: start, middle, end
```

For each shot label:

- expected politician visible: yes/no/uncertain;
- expected politician speaking on screen: yes/no/uncertain;
- correct face box or approximate center x;
- close / medium / wide;
- frontal / profile / occluded;
- other dominant face present;
- sign-language inset or monitor;
- whether the shot is publishable under the product requirement.

This is far cheaper than frame-level labeling and directly matches the scene-aware design.

Stratify by:

- debate type;
- camera framing;
- gender and age;
- glasses and facial hair;
- profile pose;
- lighting and compression;
- party;
- multiple-face shots;
- reaction shots;
- wide chamber shots.

## 9.3 Calibrate identity with positives and hard negatives

Positive pairs:

- official portrait versus manually confirmed target frames.

Hard negative pairs:

- expected portrait versus other visible politicians;
- expected portrait versus audience faces;
- visually similar politicians;
- another participant’s portrait versus the candidate;
- same-frame competing faces.

Choose thresholds from the false-accept side of the curve, not maximum accuracy.

Report:

- false accept rate;
- false reject rate;
- precision among accepted clips;
- accepted-clip yield;
- shot-level target visibility coverage;
- worst unverified voiced gap;
- render-level precision.

## 9.4 The primary product metric

The primary metric should be:

> **Among auto-published clips, the fraction with no speech-active interval in which the crop attributes the speech to the wrong visible person.**

A clip fails if any material speech-active interval is cropped onto a non-target face.

This is stricter and more relevant than average box overlap, average coverage, or “plausible podium framing.”

## 9.5 Statistical interpretation of zero observed failures

If an audit finds zero failures, the true failure rate is not proven to be zero.

A useful approximation is the rule of three:

```text
95% upper bound on failure rate ≈ 3 / audited accepted clips
```

Examples:

```text
0 failures in 100 accepted clips  -> upper bound about 3%
0 failures in 300 accepted clips  -> upper bound about 1%
0 failures in 1,000 accepted clips -> upper bound about 0.3%
```

This makes the audit requirement explicit and prevents another “16/16” result from being mistaken for production proof.

## 9.6 Continuous audit

After launch:

- manually review a random sample of accepted clips every week;
- oversample clips near thresholds;
- oversample new politicians and new debate types;
- save contact sheets with target portrait, source frames, rendered frames, boxes, scores, and reasons;
- freeze the validation set and rerun it on every model or threshold change;
- never tune and report on the same small set without a holdout.

## 9.7 Useful automatic hard-rejection metrics

These are auditable and difficult for a placeholder to fake:

- zero synthetic observation count, enforced structurally;
- target identity score distribution;
- target-versus-competitor margin;
- verified target coverage during voiced time;
- longest unsupported voiced gap;
- count of scenes with no verified target;
- count of scenes matching another known politician;
- final-render target identity coverage;
- final-render wrong-identity count;
- crop containment of identity-verified boxes.

Geometry remains a framing metric, not an identity metric.

---

## 10. Concrete order of work

## Phase 0 — Immediate safety patch

Do this before further publishing or backfill.

1. Change both C8 detector calls to `fallback=False`.
2. Remove `estimate_speaker_proxy()` from production behavior.
3. Replace `test_speaker_proxy_is_centered_and_positive` with a test that a detector miss returns an empty tuple.
4. Change `_long_enough_to_be_a_speaker()` so no eligible track returns no selection.
5. Make C8 write a no-face or rejected artifact rather than a guessed face.
6. Make C9 refuse to create a publishable plan from no-face evidence.
7. Make C11 refuse clips lacking an explicit verification acceptance.
8. Add a migration or publish-state reason if rejected clips must be visible operationally.

This patch will reduce yield immediately. That is expected.

## Phase 1 — YuNet benchmark

1. Add a `FaceDetector` protocol rather than typing C8 specifically as `HaarFaceDetector`.
2. Implement `YuNetFaceDetector`.
3. Vendor the OpenCV 4.x-compatible ONNX model with license and checksum.
4. Run the same clips at:
   - Haar, 480×270, 5 fps;
   - YuNet, 480×270, 5 fps;
   - YuNet, 960×540, 5 fps.
5. Measure real detection coverage on manually confirmed target shots.
6. Adopt 960×540 only if the measured gain justifies the transient disk increase.

Expected result: YuNet at 960×540 becomes default.

## Phase 2 — SFace identity verification

1. Add portrait retrieval and caching by `intressent_id`.
2. Add portrait enrollment validation.
3. Add SFace feature extraction for sampled high-quality observations.
4. Generate per-track score distributions and competitor margins.
5. Reset all tracks at scene cuts.
6. Select target tracks by identity, not geometry.
7. Create `08_identity` and `08_verification` artifacts.
8. Calibrate thresholds on the shot-labeled validation set.

Do not hard-code the OpenCV LFW threshold as the production gate.

## Phase 3 — Vision-aware candidate selection

1. Evaluate every C7 candidate window for verified target coverage.
2. Reject candidates with unsupported target-absent shots.
3. Choose the highest text-scoring candidate among vision-eligible windows.
4. Permit a speech to produce no clip.

This is likely to recover substantial yield without weakening precision.

## Phase 4 — Final-render verifier

1. Add C10v after rendering.
2. Sample the rendered MP4 at 2 fps plus shot boundaries.
3. Verify target identity and crop containment.
4. Write explicit accept/reject reasons.
5. Require C10v acceptance in C11.

## Phase 5 — Optional ambiguity resolver

Only after residual errors are measured:

1. selectively decode ambiguous scenes at 15 or 25 fps;
2. test mouth-ROI motion versus voiced/pause spans;
3. benchmark a trained ASD model if the simple signal adds insufficient value;
4. retain identity as a mandatory gate regardless of ASD score.

---

## 11. Required ADR and contract changes

An ADR is justified because the change alters failure semantics and publication eligibility.

Suggested ADR title:

```text
ADR: Speaker identity verification and fail-closed crop publication
```

Record these decisions:

- detector misses are empty evidence;
- synthetic face observations are prohibited;
- scene cuts terminate tracks;
- cross-shot association requires identity;
- C9 cannot create a publishable camera plan without verified target evidence;
- C11 requires source-level and rendered-output verification;
- rejected clips are normal product outcomes, not pipeline failures;
- model files are pinned by hash and license;
- thresholds are calibrated on riketTV footage.

Suggested contract additions:

```text
FaceObservation
FaceLandmarks
ObservationSource
IdentityEvidence
SpeakerVerification
VerificationDecision
VerificationReason
RenderVerification
```

Keep detected observations separate from interpolated camera support.

---

## 12. Tests that should exist

### Detection

- detector miss returns no faces;
- no production path calls the synthetic proxy;
- YuNet rows map correctly to box, confidence, and five landmarks;
- model checksum mismatch fails startup.

### Tracking

- tracks never cross a scene cut;
- same position across a cut does not merge;
- same target in two scenes can be logically associated by identity;
- interpolation never counts as verified coverage;
- no eligible track returns no selection.

### Identity

- larger wrong face loses to verified target face;
- longer wrong track loses to verified target face;
- one high score cannot override poor low-quantile scores;
- another known politician match forces rejection;
- ambiguous margin forces rejection;
- portrait enrollment failure forces rejection.

### Camera

- no verified samples in a shot makes the clip ineligible;
- C9 does not hold the previous crop through a target-absent reaction shot;
- every verified target box is contained with configured margin;
- no-face clip does not receive a center publish plan.

### Render verification

- wrong-face rendered fixture rejects;
- target outside crop rejects;
- stale camera-plan fixture rejects;
- correctly cropped target fixture accepts;
- no-face rendered fixture rejects.

### Publication

- C11 cannot publish without both acceptance artifacts;
- rejection is recorded as a terminal skipped state, not retried as an infrastructure failure.

---

## 13. What is not worth doing now

Do not spend more time tuning the current geometric track score. It cannot establish identity.

Do not retain the synthetic fallback with a lower weight. Its mere presence corrupts coverage, persistence, interpolation, and audit metrics.

Do not implement whole-debate 25 fps extraction for lip analysis.

Do not deploy a simple 5 fps RMS/lip correlation as a publication signal.

Do not add TalkNet before measuring errors that remain after identity verification.

Do not report success through face size, centrality, podium geometry, or track persistence.

Do not force every selected speech to produce a clip.

---

## 14. Recommended first pull request

A safe first PR should be intentionally small:

```text
Title:
C8/C9: remove synthetic face fallback and fail closed on missing evidence
```

Scope:

- `src/vision/detect.py`
  - remove production proxy fallback;
  - detector misses return `()`.
- `src/stages/track.py`
  - pass no fallback;
  - emit no-face when there are no valid candidates.
- `src/vision/track.py`
  - remove the fail-open candidate fallback.
- `src/camera/plan.py`
  - expose unsupported shots instead of silently holding/centering.
- `src/stages/publish.py`
  - skip unverified clips.
- tests
  - replace proxy expectations with fail-closed behavior.
- ADR
  - record precision-over-recall and rejection semantics.

Do not mix YuNet, SFace, threshold calibration, and contract redesign into this first safety PR. Remove known fabrication first, then add the new foundation with measurable before/after evidence.

---

## Sources

### Repository

- `README.md`
- `pyproject.toml`
- `PROGRESS.md`
- `src/config.py`
- `src/media/extract.py`
- `src/vision/detect.py`
- `src/vision/track.py`
- `src/vision/asd.py`
- `src/stages/track.py`
- `src/stages/camera.py`
- `src/camera/plan.py`
- `tests/unit/test_vision_detect.py`
- commit `8d95d1fae30860af936b7e42aba54a5fae07cb32`

### External primary references

- OpenCV 4.11 DNN face detection and recognition tutorial:  
  `https://docs.opencv.org/4.11.0/d0/dd4/tutorial_dnn_face.html`
- OpenCV Zoo YuNet model documentation:  
  `https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet`
- OpenCV Zoo SFace model documentation:  
  `https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface`
- TalkNet paper:  
  `https://arxiv.org/abs/2107.06592`
- AVA ActiveSpeaker dataset paper:  
  `https://arxiv.org/abs/1901.01342`
- Target Speaker TalkNet paper:  
  `https://arxiv.org/abs/2305.12831`
