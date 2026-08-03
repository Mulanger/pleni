"""Unit tests for the C12b render fan-out and join barrier.

The barrier is the part worth testing hardest. The C12 chain enqueues one
successor on completion, which cannot express "after all 400 of these", and
getting the join wrong fails in two directions that both look fine in a happy
path: publishing a partial batch, or never publishing at all.
"""

from __future__ import annotations

from typing import Any

import pytest

from src.errors import ConfigurationError
from src.orchestrator.jobs import (
    STAGE_BY_KIND,
    advance_after,
    fan_out,
    idempotency_key,
    next_stage,
    stage_for,
)

DOKID = "HD10540"
CLIPS = [f"{DOKID}_anf1_c{i:02d}" for i in range(1, 5)]


class RecordingEnqueuer:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.keys: set[str] = set()

    def enqueue(self, **kwargs: Any) -> bool:
        self.calls.append(kwargs)
        key = str(kwargs["idempotency_key"])
        if key in self.keys:
            return False
        self.keys.add(key)
        return True

    @property
    def kinds(self) -> list[str]:
        return [str(call["kind"]) for call in self.calls]


class Counter:
    """Stands in for the queue's sibling count."""

    def __init__(self, outstanding: int) -> None:
        self.outstanding = outstanding
        self.queries: list[tuple[int, str]] = []

    def incomplete_siblings(self, *, parent_id: int, kind: str) -> int:
        self.queries.append((parent_id, kind))
        return self.outstanding


@pytest.fixture(autouse=True)
def stub_units(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "src.stages.render.selected_clip_ids", lambda dokid, work_dir: list(CLIPS)
    )


# -- graph shape ---------------------------------------------------------


def test_render_fans_out_to_render_clip() -> None:
    render = stage_for("render")

    assert render.fans_out_to == "render_clip"
    assert render.fan_out_units == "selected_clip_ids"
    assert stage_for("render_clip").joins_siblings is True


def test_the_fan_out_job_holds_a_short_lease() -> None:
    """It enqueues children and completes. The hours live in the children.

    A long lease here was the old failure: a six-hour render could outlive it,
    the reaper would reclaim it, and a second worker would start the same debate.
    """

    assert stage_for("render").lease_s <= 900
    assert stage_for("render_clip").lease_s <= 3600


def test_render_clip_runs_before_publish() -> None:
    assert next_stage("render").kind == "render_clip"
    assert next_stage("render_clip").kind == "publish"
    assert next_stage("publish") is None


# -- fan-out -------------------------------------------------------------


def test_fan_out_enqueues_one_child_per_clip() -> None:
    enqueuer = RecordingEnqueuer()

    units = fan_out(enqueuer, kind="render", dokid=DOKID, parent_id=10, work_dir="work")

    assert units == CLIPS
    assert enqueuer.kinds == ["render_clip"] * len(CLIPS)
    assert [call["entity_id"] for call in enqueuer.calls] == CLIPS


def test_each_child_carries_its_debate_and_its_parent() -> None:
    """The child's own entity_id is a clip; `publish` is per debate.

    Without `dokid` in the payload the barrier would have nothing to name, and
    without `parent_id` it would have no siblings to count.
    """

    enqueuer = RecordingEnqueuer()

    fan_out(enqueuer, kind="render", dokid=DOKID, parent_id=10, work_dir="work")

    for call in enqueuer.calls:
        assert call["payload"]["dokid"] == DOKID
        assert call["parent_id"] == 10


def test_children_have_per_clip_idempotency_keys() -> None:
    enqueuer = RecordingEnqueuer()

    fan_out(enqueuer, kind="render", dokid=DOKID, parent_id=1, work_dir="work")

    keys = [call["idempotency_key"] for call in enqueuer.calls]
    assert keys == [idempotency_key("render_clip", clip) for clip in CLIPS]
    assert len(set(keys)) == len(CLIPS), "keys must be distinct or clips collapse"


def test_fanning_out_twice_creates_no_duplicates() -> None:
    """A re-run fan-out — after a reap, say — must not double the work."""

    enqueuer = RecordingEnqueuer()

    fan_out(enqueuer, kind="render", dokid=DOKID, parent_id=1, work_dir="work")
    before = len(enqueuer.keys)
    fan_out(enqueuer, kind="render", dokid=DOKID, parent_id=1, work_dir="work")

    assert len(enqueuer.keys) == before


def test_fanning_out_a_stage_that_does_not_fan_out_is_an_error() -> None:
    with pytest.raises(ConfigurationError, match="does not fan out"):
        fan_out(RecordingEnqueuer(), kind="segment", dokid=DOKID, parent_id=1, work_dir="w")


# -- the join barrier ----------------------------------------------------


def _advance(enqueuer: Any, counter: Any, *, kind: str, entity_id: str, **kw: Any) -> str | None:
    return advance_after(
        enqueuer,
        counter,
        kind=kind,
        entity_id=entity_id,
        job_id=kw.get("job_id", 99),
        parent_id=kw.get("parent_id", 10),
        payload=kw.get("payload", {"dokid": DOKID}),
        work_dir="work",
    )


def test_a_child_with_outstanding_siblings_enqueues_nothing() -> None:
    enqueuer = RecordingEnqueuer()
    counter = Counter(outstanding=3)

    successor = _advance(enqueuer, counter, kind="render_clip", entity_id=CLIPS[0])

    assert successor is None
    assert enqueuer.calls == []
    assert counter.queries == [(10, "render_clip")]


def test_the_last_child_through_enqueues_publish_for_the_debate() -> None:
    enqueuer = RecordingEnqueuer()

    successor = _advance(enqueuer, Counter(outstanding=0), kind="render_clip", entity_id=CLIPS[3])

    assert successor == "publish"
    assert enqueuer.calls[0]["kind"] == "publish"
    assert enqueuer.calls[0]["entity_id"] == DOKID, "publish is per debate, not per clip"
    assert enqueuer.calls[0]["idempotency_key"] == idempotency_key("publish", DOKID)


def test_two_children_racing_to_the_barrier_publish_once() -> None:
    """Both see zero outstanding and both enqueue. The key admits exactly one.

    Making this non-racy would need a lock, which costs more than the duplicate
    insert it prevents.
    """

    enqueuer = RecordingEnqueuer()
    counter = Counter(outstanding=0)

    first = _advance(enqueuer, counter, kind="render_clip", entity_id=CLIPS[2])
    second = _advance(enqueuer, counter, kind="render_clip", entity_id=CLIPS[3])

    assert (first, second) == ("publish", "publish")
    assert enqueuer.kinds == ["publish", "publish"]
    assert len(enqueuer.keys) == 1, "only one publish job exists"


def test_a_child_without_a_parent_chains_rather_than_blocking_forever() -> None:
    """Hand-enqueued single clips must not wedge on a batch that never existed."""

    enqueuer = RecordingEnqueuer()

    successor = _advance(
        enqueuer, Counter(outstanding=5), kind="render_clip", entity_id=CLIPS[0], parent_id=None
    )

    assert successor == "publish"


def test_a_child_falls_back_to_its_own_id_when_the_payload_lost_the_dokid() -> None:
    enqueuer = RecordingEnqueuer()

    _advance(
        enqueuer, Counter(outstanding=0), kind="render_clip", entity_id=CLIPS[0], payload={}
    )

    assert enqueuer.calls[0]["entity_id"] == CLIPS[0]


# -- fan-out through advance_after --------------------------------------


def test_completing_the_fan_out_job_enqueues_the_children() -> None:
    enqueuer = RecordingEnqueuer()

    successor = _advance(enqueuer, Counter(outstanding=0), kind="render", entity_id=DOKID)

    assert successor == f"render_clip x{len(CLIPS)}"
    assert enqueuer.kinds == ["render_clip"] * len(CLIPS)
    assert "publish" not in enqueuer.kinds, "publish waits for the barrier"


def test_an_ordinary_stage_still_chains() -> None:
    enqueuer = RecordingEnqueuer()

    successor = _advance(enqueuer, Counter(outstanding=0), kind="segment", entity_id=DOKID)

    assert successor == "transcribe"
    assert enqueuer.calls[0]["entity_id"] == DOKID


def test_every_stage_that_joins_has_a_producer_that_fans_out_to_it() -> None:
    """A join with no fan-out would wait for siblings that never arrive."""

    fan_out_targets = {
        stage.fans_out_to for stage in STAGE_BY_KIND.values() if stage.fans_out_to
    }
    joiners = {kind for kind, stage in STAGE_BY_KIND.items() if stage.joins_siblings}

    assert joiners <= fan_out_targets, f"orphaned join stages: {joiners - fan_out_targets}"
