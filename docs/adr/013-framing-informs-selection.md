# ADR 013: Framing quality is a selection input, not a rendering afterthought

Date: 2026-08-08

## Status

Accepted

## Context

ADR 012 made C8 refuse to frame a clip it cannot verify. That is correct and it
is what stopped the pipeline publishing a bystander's lap under a minister's
byline — but on its own it only converts a mis-framed clip into no clip.

Measured over 319 published clips across 14 debates, the identity gate accepted
**40.8%**. The dominant cause of the rest is a shot inside the chosen window
where the expected speaker is simply not on screen. Per-shot analysis of the two
worst debates found 83–96% of those shots have *no face detected at all*, and the
gap lengths are real — median 5.7 s, minimum 2.6 s — so nothing is recoverable by
relaxing the tolerance. The windows themselves are the problem.

And they were chosen blind. C7 ranked candidates on text and audio only, then C8
discovered afterwards whether the picture supported the window it had picked. A
six-minute speech yields hundreds of admissible 38–62 s windows, most of which do
*not* straddle a cutaway. C7 had no way to prefer one of those.

Two facts make the fix cheap:

- The expensive part of vision is per **frame**, not per candidate. Running it
  once for a whole speech answers the question for every candidate window in that
  speech at the same cost as answering it for one.
- `face_height_frac` — the feature `ARCHITECTURE.md` §R2 always specified as
  "framing quality, feeds back into ranking" — has been **hardcoded to `1.0`** in
  `compute_text_features` since C7 shipped, checked against a gate constant of
  `0.0`. The framing half of the publish gate has never been able to fire. The
  seam was designed; it was never connected.

## Decision

**Add a per-speech speaker-visibility pass (C6v) between C6 and C7, and let its
output gate candidate selection.**

1. `06_vision/<speech_id>.json` records, per shot of the speech, whether the
   expected politician is identity-verified on screen, their median similarity,
   and their apparent face size.
2. C7 scores each candidate window against that timeline and admits it only if
   the speaker is verified for nearly all of it **and** it contains no single
   long absence — because C8 rejects on the longest gap, not the total, and
   selection must be judged by the rule it will later be judged by.
3. `face_height_frac` finally carries the measured value.
4. C6v and C8 share one per-shot verification rule (`build_speech_visibility`
   and `select_verified_track` apply the same `IdentityThresholds`), so the two
   cannot drift into disagreeing about which windows are usable.

**C8 remains the authority.** It re-verifies the selected window independently
and is still the only thing that decides what may be published. C6v does not
weaken the gate; it stops C7 proposing windows that were never going to pass.

## Consequences

**Measured on `HD10342`**, an interpellation debate — the hardest format, with
three people trading turns and constant cutting:

| | before | after |
|---|---:|---:|
| windows C7 proposed | 22 | 15 |
| clips C8 accepted | 8 | **14** |
| survival rate of C7's picks | 36.4% | **93.3%** |

Usable clips rose 75% while the identity gate was left exactly as strict. C7
proposes fewer windows and nearly all of them survive. The fixture shows the same
effect in miniature: clip `c02` moved from `rejected_no_evidence` to `accepted`
with 189 detected samples, because C7 shifted the window past an eight-second
region where nobody was detectable.

**Cost.** Vision now runs over whole speeches rather than only selected clips —
roughly 120 s for a 28-minute debate at three threads. Some of that is repaid by
C8 no longer being the first place detection happens, but it is a real increase
and the stage sits in the `gpu` pool for scheduling.

**Additive, not required.** A work directory without `06_vision` selects exactly
as before: the framing features are absent and the gate skips them. Older work
dirs and any caller that has not run C6v keep working.

**Not addressed.** C8 still re-detects the selected window rather than slicing
C6v's result. That duplicate work is the obvious next optimisation, and it also
preserves an independent second check, so it is deliberately left.

## Contracts Impact

None. The timeline is a new artifact with its own plain-JSON shape, and the
framing values travel in `Candidate.features`, which is an open `dict[str, float]`
exactly so that new signals do not need a contract change.
