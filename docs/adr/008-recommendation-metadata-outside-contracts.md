# ADR 008: Recommendation metadata lives outside `src/contracts.py`

Date: 2026-08-02

## Status

Accepted

## Context

Prerequisite `Q-5`.

The recommender needs per-clip metadata the pipeline does not produce: a
calibrated quality prior, a `content_at` derived from the debate date, a
`temporal_class` of `current` / `evergreen` / `historical`, normalized topics and
later an embedding.

The tempting place to put these is `src/contracts.py`, next to `SelectedClip` and
`Candidate`. It would be one file, already typed, already validated.

It is also the one file `AGENTS.md` rule 1 protects: contracts are the interface
between chunks written in different sessions by different agents, and changing a
field silently breaks code nobody in the room can see. Every addition needs an
ADR, every consumer needs updating, and every golden file needs regenerating.

The deeper problem is that these fields do not belong to the pipeline at all. A
`temporal_class` is a serving judgement about how an old clip should be presented
today. It has no meaning to C7, which decides whether a moment is worth
publishing, and it would change without any pipeline stage rerunning.

## Decision

Recommendation metadata is **derived downstream and stored separately**. It never
enters `src/contracts.py`.

- Per-clip serving features live in `public.clip_reco_features`, keyed by
  `clip_id`, written by a job that reads published rows. `public` because it is
  metadata about public political content, not about a viewer.
- Viewer-side state lives in `private` (ADR 007).
- The feed DTO is defined in `web/src/types.ts` and in the Edge Function, not by
  reusing a pipeline contract. It carries what the client needs to render and
  report — `feed_request_id`, `feed_item_id`, `position`, `reason`,
  `event_token`, `politician_id`, `content_at` — and nothing else (`FE-13`).
- `content_at` derives from `sources.debate_date`. `clips.published_at` is
  availability only. A debate backfilled today must never look like breaking news
  (`Q-4`).
- The two exploration flags stay distinct (`Q-7`). `clip_features.was_explore` is
  **publishing** exploration — did C7 pick something outside its own top rank —
  and C11 always writes `false`. **Serving** exploration is a different event
  entirely, recorded on the served item together with its selection probability.
  One boolean cannot honestly represent both, and conflating them would corrupt
  any later off-policy evaluation.

## Consequences

There is a join between `clips` and `clip_reco_features` on the serving path. At
this catalogue size that is free; if it ever stops being free, the answer is a
materialized view, not a contract change.

Two places now describe a clip. The pipeline's view (what was produced) and the
serving view (how it should be presented) can disagree, and that is correct —
they are answering different questions and change on different schedules.

Pipeline chunks C1–C13 stay closed to recommendation work. A session working on
the feed never has to touch `src/contracts.py`, so it never has to regenerate a
golden file or reason about a stage it did not read.

## Contracts Impact

None, by construction. That is the entire point of the decision.
