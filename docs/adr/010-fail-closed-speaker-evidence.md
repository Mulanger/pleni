# ADR 010: Detector misses are missing evidence, and unverified clips are not published

Date: 2026-08-03

## Status

Accepted

## Context

C8 fabricated face observations. `HaarFaceDetector.detect()` was called with
`fallback=True`, and on any frame where Haar found nothing it returned
`estimate_speaker_proxy()` — a hardcoded box that in master coordinates was always
exactly `x=568, y=129.6, w=144, h=144` for a 1280x720 debate: centred, 28% down,
11.2% of frame width.

Measured on the 16 published clips: **1,133 of 2,032 selected face samples (56%) were
that one constant.** Because it is identical in every frame it chains into a perfectly
stable, perfectly centred track, so it outscores real detections under any heuristic
rewarding size, centrality or persistence — real Haar detections fragment whenever the
speaker turns their head, while the placeholder never does.

Two consequences, and the second is worse than the first.

**It put the crop on nobody.** For more than half of a typical clip the camera followed
a constant rather than a person, which is what the project owner observed as clips
"focusing on a person in the crowd" and "not centred on the speaker".

**It destroyed measurement.** Every downstream metric counted the placeholder as a real,
well-framed face. A previous session reported "16/16 plausible podium framing" from a
geometric check that the synthetic box satisfies by construction, and a scoring change
intended to fix the framing raised the synthetic share from 52% to 56% while appearing
to improve. The committed golden file had it baked in too: the recorded first
observation of fixture clip `c02` was the proxy box, exact to three decimals.

Every failure path downstream compounded it. `_long_enough_to_be_a_speaker()` fell open
to the full candidate set when nothing cleared the coverage floor. `plan_camera_for_clip()`
held the previous crop through shots with no samples and centre-cropped when a clip had
none at all. `_publish_local()` treated a missing render as an `ArtifactError` rather
than a legitimate rejection.

The product context that makes the answer easy: this is political content, where a clip
cropped onto the wrong person misattributes a statement to a face. And source material
is abundant — roughly 64 debates a month against a backlog of ~15,000 clips. Publishing
fewer, verified clips costs little; publishing a confident guess costs credibility.

## Decision

**A detector miss is represented as missing evidence, never as a synthesised
observation.** `estimate_speaker_proxy()` is deleted, along with the `fallback`
parameter and the unused `"proxy"` detector backend. There is no lower-weighted or
flagged variant: the value of the rule is that no code path can produce a face nobody
detected.

**Every stage fails closed rather than degrading to a guess.**

| Stage | Absence of evidence |
|---|---|
| C8 detection | a frame with no face yields `()` |
| C8 selection | no track clears `MIN_COVERAGE_FRAC` → `FaceTrack(track_id="no-face", samples=())` |
| C9 planning | a track with no samples → `CameraPlan(keyframes=())` |
| C10 render | a plan with no keyframes is not rendered; `render_clip` returns `None` |
| C11 publish | a clip with no keyframes is skipped, uploads nothing, writes no row |

**Rejection is a normal product outcome, not a pipeline failure.** It is logged with a
reason (`no_verified_speaker_evidence`) and must not be retried as an infrastructure
error.

**Genuine faults still fail loudly.** A clip that *had* evidence but whose render is
missing still raises `ArtifactError`. Fail-closed must not become a way to swallow real
bugs.

## Consequences

**Easier.** Every metric now means what it says. Detection coverage, track persistence
and framing statistics count only observations a detector actually made, so the YuNet
and identity-verification work planned next has a trustworthy baseline to be measured
against — which it did not have before.

**Harder.** Yield drops, deliberately. Measured on the 16 published clips, 15 retain
usable evidence at the 0.15 coverage floor and one (14% real detection coverage) is
rejected. Surviving clips will look *jumpier*, because the crop now follows fragmented
real detections instead of a smooth fabricated one. That is the honest picture of what
Haar actually provides and it should not be smoothed over by reintroducing invented
data.

**Riskier.** Nothing yet verifies that the face being tracked is the *right* face.
Fail-closed removes fabricated evidence; it does not establish identity. A large,
central, persistent face that is not the speaker still wins. That is what
`docs/speaker_verified_crop_design.md` Phases 1–2 address (YuNet at higher resolution,
then SFace identity matching against the speaker's official Riksdagen portrait, which is
retrievable by the `intressent_id` already present in `00_source.json`). This ADR is
deliberately the safety patch that precedes them.

**Not decided here.** Shot-level "target absent" marking inside an otherwise-good clip
is deferred, because knowing a target is absent requires identity. Phase 0 gates at clip
level only.

## Contracts Impact

**`src/contracts.py` is unchanged.** Absence was already representable:
`FaceTrack(track_id="no-face", samples=())` was an existing convention, and
`CameraPlan.keyframes` has no minimum length, so an empty tuple is a valid "no plan".

One internal signature changed outside the contracts module: `render_clip()` now returns
`Path | None` instead of `Path`. Consumers updated in the same change — `render_dokid()`
and the C10 CLI filter `None`; the orchestrator dispatches by name and does not inspect
the return value.

The golden file `tests/fixtures/golden/08_track_fixture_summary.json` was regenerated.
The diff is confined to fixture clip `c02`: its first recorded observation was the proxy
box and is now a real detection 7.8 seconds later, and 39 fabricated samples were
removed from a 192-sample track. Clip `c01` is unchanged.
