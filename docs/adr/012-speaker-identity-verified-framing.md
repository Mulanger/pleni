# ADR 012: Framing is anchored to a verified identity, and fails closed

Date: 2026-08-07

## Status

Accepted

## Context

ADR 010 stopped C8 fabricating faces. It did not make C8 point at the *right*
face, because nothing in the pipeline ever checked who was in frame.

Measured over the whole published catalogue — 1,746 clips, 87 debates, from
existing artifacts with no re-processing (`docs/CLIPPING_V2_DESIGN.md` §1):

| Defect | Share |
|---|---:|
| Crop centred on a box too large to be a face | 24.9% |
| ≥1 shot with zero face evidence, C9 holding a stale crop | 49.7% |
| Track covers <50% of the clip | 34.8% |
| **At least one** | **74.3%** |

Two published examples: 45 seconds of a seated bystander's lap while Erik
Slottner speaks off-frame, and a clip that is rows of empty chamber seats.

The decisive measurement is that **the face centre lies inside the planned crop
in 100% of samples**, p10 through p90. The camera obeys its target exactly. The
target was not a person. That rules out the entire smoothing family of fixes —
Kalman, EMA, one-euro, gesture-aware padded boxes — because they all act on a
signal that is already perfectly obeyed.

V1 replaced the Haar cascade with YuNet and removed the first defect
(15/22 → 0/22 impossible boxes on a stratified sample; coverage 0.58 → 0.86).
What V1 exposed is that the residual is not a detection problem at all:

| clip type | faces/frame | tracks | top-1 cov | top-2 cov |
|---|---:|---:|---:|---:|
| single-speaker podium | 1.00 | 1 | 1.00 | 0.00 |
| debate two-shot | 2.50 | 14 | 1.00 | **0.98** |

Two people, both tracked perfectly, and no signal saying which one is speaking.
`select_active_track` answers it with geometry — largest, most-covered, most
centred — which is a statement about framing, not about identity.

Worse, `merge_fragmented_tracks` is not scene-aware. On
`HD10392_ebe6af7e…_c01` it stitches Erik Slottner and a *different* speaker who
later uses the same lectern into one track, because a cut that swaps the person
while preserving screen position leaves a high seam IoU.

### What makes a better answer available

The pipeline already knows who is supposed to be speaking. `00_source.json`
carries `intressent_id` per anförande, and Riksdagen publishes an official
portrait at `filarkiv/bilder/ledamot/<intressent_id>_max.jpg`.

Measured before committing to the design — closed-set rank-1 identification
across three debates, ground truth from Riksdagen's own metadata, nothing
hand-labelled: **30/30**, with the expected speaker beating the runner-up by
+0.203 to +0.701 cosine.

Two findings from that probe shape the decision:

- **The absolute similarity is not a safe gate on its own.** A correct match
  landed at 0.366, essentially on top of OpenCV's documented 0.363 LFW
  threshold — yet its margin over the runner-up was +0.299. Margin separates far
  better than absolute score on this footage.
- **480×270 analysis frames are sufficient.** All 30 succeeded on ~46 px faces.
  `speaker_verified_crop_design.md` §3.2 assumed 960×540 would be required; it
  is not, for detection (V1) or for identity. The re-decode is cancelled.

## Decision

**The C8 target track is chosen by verified identity, not by geometry, and every
stage downstream fails closed when identity evidence is absent.**

1. **Tracks terminate at scene cuts.** A cut is a hard boundary. Two shots are
   re-associated into one speaker timeline only through identity, never through
   geometric continuity.
2. **The expected politician is enrolled from their official portrait** and each
   candidate track is scored against it, with the other participants of the same
   debate enrolled as hard negatives.
3. **Acceptance requires aggregate evidence and a margin**, never one pairwise
   match: a minimum count of quality embeddings, a median and a low-quantile
   similarity floor, and a margin over the best competing face.
4. **Absence of a verified target is represented, not smoothed over.** C9 no
   longer holds the previous crop through a shot with no verified samples; those
   spans are recorded on the track and the clip is unsupported.
5. **Interpolation is camera support, never evidence.** Interpolated samples may
   steer the crop between real observations but must not count toward coverage,
   identity or any acceptance threshold.
6. **Thresholds are calibrated on Pleni footage**, from the false-accept side.
   OpenCV's 0.363 LFW figure is a smoke test, not a production gate.

## Contracts Impact

This is the contract change rule 1 requires an ADR for.

```
+ ObservationSource      enum: detected | interpolated
+ VerificationDecision   enum: accepted | rejected_*
+ IdentityEvidence       per-track identity scores and provenance

  FaceSample
    + score              detector confidence, the model's own
    + source             ObservationSource
    - is_speaking        REMOVED

  FaceTrack
    + decision           VerificationDecision
    + identity           IdentityEvidence | None
    + unsupported_spans  tuple[TimeSpan, ...]
    + reasons            tuple[str, ...]
```

**`is_speaking` is removed rather than repurposed.** It was set to `True` for
every sample of the selected track and has never carried an active-speaker
decision — no consumer reads it; `src/camera/plan.py` ignores it entirely. A
field that asserts something the pipeline cannot establish is the same class of
defect as ADR 010's fabricated box, and identity, visibility and speaking state
are three separate signals. Per-sample `identity_verified` was considered and
rejected: SFace is sampled at roughly 1 Hz, so it would read `False` on most
samples of a properly verified track. Identity is a track-level property.

**Migration.** `ContractModel` sets `extra="forbid"`, so the 1,746 existing
`08_track/*.json` artifacts — which carry `is_speaking` and lack `score` and
`source` — no longer load. They are regenerated by re-running C8, which this
change requires anyway. Nothing published is affected until a re-render is
decided separately.

## Consequences

**Better.** The question "is this the person the byline names?" gets a recorded,
auditable answer per clip instead of being assumed. `08_track` carries the
evidence and the reasons, so a rejection is inspectable rather than mysterious.

**Harder.** C8 gains a network dependency on Riksdagen's portrait archive and a
second model. Portraits are cached on disk and hashed; a debate whose speaker has
no `intressent_id` — non-sitting ministers, a known open issue — cannot be
verified and its clips are rejected rather than published unverified.

**Yield will fall.** Clips that today publish with the wrong subject will be
rejected. That is the point, but it is a volume change and it must be measured
rather than assumed. Recovering it by letting framing quality inform *which*
window C7 selects is deliberately **not** in this ADR: it changes stage ordering,
and it should be decided on the measured yield rather than pre-emptively.

**Revisit if:** measured yield falls below roughly 40%, which
`speaker_verified_crop_design.md` §7.5 sets as the floor for a viable production
gate; or a false accept is found in audit, which is the failure this exists to
prevent and is worth more than any yield number.
