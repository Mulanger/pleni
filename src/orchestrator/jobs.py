"""The pipeline job graph: what runs, in what order, on which worker pool.

C12. See `docs/adr/009-python-native-job-queue.md` for the queue underneath.

**The graph is a chain, not a tree, and that is a finding rather than a choice.**
`docs/BUILD_PLAN.md` C12 calls for fan-out — debate to speeches, speech to clips —
because rendering 400 independent 50-second encodes is the one genuinely
parallelisable part of the pipeline and it dominates the runtime. But every stage
entrypoint in `src/stages/` is per-`dokid`: `render_dokid(dokid, work_dir)` renders
every selected clip for a debate in one call, and no stage accepts a `speech_id` or
a `clip_id`.

Fanning out would therefore mean changing eleven stage modules, which is outside
C12's declared file scope (`AGENTS.md` rule 2). So this chunk builds the machinery
that makes fan-out possible — `parent_id` on every job, pools, independent
concurrency — and runs the stages at the granularity they actually offer. The
per-clip split is recorded in `PROGRESS.md` as the next chunk's work.

Chaining rather than enqueuing everything upfront is deliberate: a job's successor
is enqueued when it completes, so the queue only ever holds work that is genuinely
runnable. There is no blocked state to reason about, and resuming after a crash is
just "claim whatever is queued".
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, Protocol

from src.errors import ConfigurationError

#: Bumped when a stage's output shape changes in a way that makes existing
#: artifacts invalid. It is part of every idempotency key, so bumping it makes
#: previously-completed work eligible to run again instead of being skipped.
GRAPH_VERSION = "v1"


class StageCallable(Protocol):
    """A stage entrypoint.

    Two shapes exist. Per-debate stages take `(dokid, *, work_dir)`; per-unit
    stages created by a fan-out take `(dokid, unit_id, *, work_dir)` — see
    `render_clip`. Positional args are left open rather than modelling both as
    an overload, because the caller is a single dispatch in `Worker._execute`
    that already branches on `joins_siblings`.
    """

    def __call__(self, *args: str, work_dir: Path | str) -> Any:
        """Run one stage for one debate, or one unit of one debate."""


@dataclass(frozen=True)
class StageJob:
    """One node in the pipeline graph."""

    kind: str
    module: str
    function: str
    pool: str
    #: Roughly how long one debate takes, from the throughput sketch in
    #: `docs/ARCHITECTURE.md`. Used to set a lease long enough that a slow job
    #: is not reaped out from under a healthy worker.
    lease_s: int
    description: str
    #: When set, completing this job enqueues one child of this kind per unit
    #: instead of running a stage — the C12b fan-out.
    fans_out_to: str | None = None
    #: Names the module attribute listing the units to fan out over. Called as
    #: `fn(dokid, work_dir)` and expected to return a list of entity IDs.
    fan_out_units: str | None = None
    #: True for a child kind whose successor may only run once *every* sibling
    #: has completed. The join barrier.
    joins_siblings: bool = False

    def resolve_units(self, dokid: str, work_dir: Any) -> list[str]:
        """List the entity IDs this job should fan out over."""

        if self.fan_out_units is None:
            raise ConfigurationError(f"{self.kind} has no fan_out_units")
        module = import_module(self.module)
        lister = getattr(module, self.fan_out_units, None)
        if lister is None:
            raise ConfigurationError(f"{self.module} has no attribute {self.fan_out_units}")
        return list(lister(dokid, work_dir))

    def resolve(self) -> StageCallable:
        """Import the stage entrypoint.

        Imported lazily and per-job so a worker in the IO pool never imports
        torch, and a missing optional dependency fails one job rather than the
        whole process at startup.
        """

        module = import_module(self.module)
        function = getattr(module, self.function, None)
        if function is None:
            raise ConfigurationError(f"{self.module} has no attribute {self.function}")
        return function  # type: ignore[no-any-return]


#: The pipeline, in order. Each entry's successor is the next one.
#:
#: Pools follow the hardware, not the stage numbering: transcription and vision
#: want the GPU, download and upload want bandwidth, everything else is CPU.
STAGE_GRAPH: tuple[StageJob, ...] = (
    StageJob(
        kind="discover",
        module="src.stages.discover",
        function="discover_dokid",
        pool="io",
        lease_s=600,
        description="C1 — Riksdagen metadata and official transcripts",
    ),
    StageJob(
        kind="acquire",
        module="src.stages.acquire",
        function="acquire_dokid",
        pool="io",
        lease_s=3600,
        description="C2 — download master, extract audio/frames, detect scenes",
    ),
    StageJob(
        kind="segment",
        module="src.stages.segment",
        function="segment_dokid",
        pool="cpu",
        lease_s=1800,
        description="C3 — speech segmentation and boundary refinement",
    ),
    StageJob(
        kind="transcribe",
        module="src.stages.transcribe",
        function="transcribe_dokid",
        pool="gpu",
        lease_s=7200,
        description="C4 — ASR and word alignment",
    ),
    StageJob(
        kind="audio_features",
        module="src.stages.audio_features",
        function="extract_audio_features_dokid",
        pool="cpu",
        lease_s=1800,
        description="C5 — energy, pitch, pauses, emphasis",
    ),
    StageJob(
        kind="candidates",
        module="src.stages.candidates",
        function="generate_candidates_dokid",
        pool="cpu",
        lease_s=1800,
        description="C6 — candidate windows and hard filters",
    ),
    StageJob(
        kind="select",
        module="src.stages.select",
        function="select_dokid",
        pool="cpu",
        lease_s=3600,
        description="C7 — scoring, gate and portfolio selection",
    ),
    StageJob(
        kind="track",
        module="src.stages.track",
        function="track_dokid",
        pool="gpu",
        lease_s=3600,
        description="C8 — face detection and active speaker",
    ),
    StageJob(
        kind="camera",
        module="src.stages.camera",
        function="plan_camera_dokid",
        pool="cpu",
        lease_s=1800,
        description="C9 — crop planning and smoothing",
    ),
    StageJob(
        kind="render",
        module="src.stages.render",
        function="render_dokid",
        pool="cpu",
        # Fans out and completes immediately, so the lease is short. The hours
        # of work live in the children.
        lease_s=600,
        description="C10 — fan out one render job per selected clip",
        fans_out_to="render_clip",
        fan_out_units="selected_clip_ids",
    ),
    StageJob(
        kind="render_clip",
        module="src.stages.render",
        function="render_clip",
        pool="cpu",
        # One 40-60s clip: seconds to a couple of minutes. Twenty minutes is
        # generous and still short enough that a dead worker is noticed the
        # same afternoon rather than six hours later.
        lease_s=1200,
        description="C10 — render one 540x960 clip and its thumbnail",
        joins_siblings=True,
    ),
    StageJob(
        kind="publish",
        module="src.stages.publish",
        function="publish_dokid",
        pool="io",
        lease_s=3600,
        description="C11 — upload to Bunny, then write Supabase rows",
    ),
)

STAGE_BY_KIND: Mapping[str, StageJob] = {stage.kind: stage for stage in STAGE_GRAPH}

#: Longest lease of any stage. The reaper uses this so it never reclaims a job
#: from a worker that is simply slow.
MAX_LEASE_S = max(stage.lease_s for stage in STAGE_GRAPH)


def first_stage() -> StageJob:
    """The stage a new debate enters at."""

    return STAGE_GRAPH[0]


def stage_for(kind: str) -> StageJob:
    """Look up a stage, failing loudly on an unknown kind."""

    stage = STAGE_BY_KIND.get(kind)
    if stage is None:
        known = ", ".join(STAGE_BY_KIND)
        raise ConfigurationError(f"Unknown job kind {kind!r}. Known kinds: {known}")
    return stage


def next_stage(kind: str) -> StageJob | None:
    """The stage that runs after `kind`, or None at the end of the chain."""

    stage = stage_for(kind)
    index = STAGE_GRAPH.index(stage)
    if index + 1 >= len(STAGE_GRAPH):
        return None
    return STAGE_GRAPH[index + 1]


def idempotency_key(kind: str, entity_id: str, *, version: str = GRAPH_VERSION) -> str:
    """Stable key for one unit of work.

    Follows the architecture's `render:clip_0123:v2` scheme. Enqueuing the same
    key twice is a no-op, which is what lets the discovery cron re-offer every
    debate it finds on every pass without piling up duplicates.
    """

    return f"{kind}:{entity_id}:{version}"


class Enqueuer(Protocol):
    """The subset of `JobQueue` this module needs."""

    def enqueue(
        self,
        *,
        kind: str,
        entity_id: str,
        idempotency_key: str,
        pool: str = ...,
        payload: Mapping[str, Any] | None = ...,
        priority: int = ...,
        max_attempts: int = ...,
        run_after: Any = ...,
        parent_id: int | None = ...,
    ) -> bool:
        """Add a job, returning False when the key already exists."""


def enqueue_debate(
    enqueuer: Enqueuer,
    dokid: str,
    *,
    priority: int = 0,
    payload: Mapping[str, Any] | None = None,
) -> bool:
    """Start a debate through the pipeline. Idempotent."""

    stage = first_stage()
    return enqueuer.enqueue(
        kind=stage.kind,
        entity_id=dokid,
        idempotency_key=idempotency_key(stage.kind, dokid),
        pool=stage.pool,
        priority=priority,
        payload=dict(payload or {}),
    )


def enqueue_successor(
    enqueuer: Enqueuer,
    *,
    kind: str,
    entity_id: str,
    parent_id: int | None = None,
    priority: int = 0,
    payload: Mapping[str, Any] | None = None,
) -> str | None:
    """Enqueue whatever runs after `kind`. Returns its kind, or None at the end.

    Called on successful completion, so the queue only ever holds runnable work.
    """

    successor = next_stage(kind)
    if successor is None:
        return None

    enqueuer.enqueue(
        kind=successor.kind,
        entity_id=entity_id,
        idempotency_key=idempotency_key(successor.kind, entity_id),
        pool=successor.pool,
        priority=priority,
        payload=dict(payload or {}),
        parent_id=parent_id,
    )
    return successor.kind


class SiblingCounter(Protocol):
    """The part of `JobQueue` the join barrier needs."""

    def incomplete_siblings(self, *, parent_id: int, kind: str) -> int:
        """Count sibling jobs of `kind` under `parent_id` that are not complete."""


def fan_out(
    enqueuer: Enqueuer,
    *,
    kind: str,
    dokid: str,
    parent_id: int,
    work_dir: Any,
    priority: int = 0,
) -> list[str]:
    """Enqueue one child job per unit. Returns the entity IDs enqueued (C12b).

    Children carry `dokid` in their payload because their own `entity_id` is a
    clip ID, while the job after the barrier — `publish` — is per debate.
    Without it the barrier would have nothing to name.
    """

    stage = stage_for(kind)
    if stage.fans_out_to is None:
        raise ConfigurationError(f"{kind} does not fan out")
    child = stage_for(stage.fans_out_to)

    units = stage.resolve_units(dokid, work_dir)
    for unit in units:
        enqueuer.enqueue(
            kind=child.kind,
            entity_id=unit,
            idempotency_key=idempotency_key(child.kind, unit),
            pool=child.pool,
            priority=priority,
            payload={"dokid": dokid},
            parent_id=parent_id,
        )
    return units


def advance_after(
    enqueuer: Enqueuer,
    counter: SiblingCounter,
    *,
    kind: str,
    entity_id: str,
    job_id: int,
    parent_id: int | None,
    payload: Mapping[str, Any],
    work_dir: Any,
) -> str | None:
    """Decide what runs next, now that this job has completed.

    Three shapes:

    - **Fan-out** — enqueue one child per unit instead of a single successor.
    - **Join** — a child whose successor may only run once every sibling is
      done. All but the last child return None.
    - **Chain** — the ordinary case: enqueue the next stage.

    The join is racy by construction and safe anyway. Two children finishing at
    once both see zero outstanding siblings and both enqueue `publish`; the
    idempotency key admits exactly one. Making it non-racy would need a lock,
    which would cost more than the duplicate insert it prevents.

    A **dead sibling counts as outstanding**, so a debate where one clip failed
    does not publish 399 of 400 and call it done. It stops, shows up in
    `pipeline status`, and waits for someone to retry the clip.
    """

    stage = stage_for(kind)

    if stage.fans_out_to is not None:
        units = fan_out(
            enqueuer, kind=kind, dokid=entity_id, parent_id=job_id, work_dir=work_dir
        )
        return f"{stage.fans_out_to} x{len(units)}"

    if stage.joins_siblings:
        dokid = _dokid_of(payload, entity_id)
        if parent_id is None:
            # A child with no parent cannot be part of a batch. Chain rather
            # than block forever.
            return enqueue_successor(enqueuer, kind=kind, entity_id=dokid)
        if counter.incomplete_siblings(parent_id=parent_id, kind=kind) > 0:
            return None
        return enqueue_successor(
            enqueuer, kind=kind, entity_id=dokid, parent_id=parent_id
        )

    return enqueue_successor(
        enqueuer, kind=kind, entity_id=entity_id, parent_id=job_id, payload=payload
    )


def _dokid_of(payload: Mapping[str, Any], fallback: str) -> str:
    """The debate a per-unit job belongs to."""

    dokid = payload.get("dokid")
    return dokid if isinstance(dokid, str) and dokid else fallback
