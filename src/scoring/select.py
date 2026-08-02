"""Portfolio selection for C7."""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

from src.contracts import Candidate, SelectedClip, Speech, Transcript
from src.scoring.archetypes import candidate_final_score, winning_archetype
from src.scoring.text_features import title_from_candidate_text, window_text_from_candidate

MAX_SELECTED_PER_SPEECH = 10
SECONDS_PER_CLIP_BUDGET = 55.0
ARCHETYPE_CEILING_FRACTION = 0.50


@dataclass(frozen=True)
class SelectionInput:
    """Candidate plus display text derived from C4 transcript."""

    candidate: Candidate
    text: str
    archetype: str
    score: float


def select_for_speech(
    *,
    speech: Speech,
    transcript: Transcript,
    candidates: Sequence[Candidate],
    max_overlap_frac: float,
) -> list[SelectedClip]:
    """Select the C7 portfolio for one speech."""

    admissible = [
        SelectionInput(
            candidate=candidate,
            text=window_text_from_candidate(candidate, transcript),
            archetype=winning_archetype(candidate),
            score=candidate_final_score(candidate),
        )
        for candidate in candidates
        if candidate.gate_passed
    ]
    target_count = selection_count(
        duration_s=float(speech.end_s - speech.start_s),
        passing_count=len(admissible),
    )
    if target_count == 0:
        return []

    ordered = sorted(
        admissible,
        key=lambda item: (-item.score, float(item.candidate.start_s), float(item.candidate.end_s)),
    )
    selected = _greedy_select(
        ordered,
        target_count=target_count,
        max_overlap_frac=max_overlap_frac,
        enforce_archetype_ceiling=True,
    )
    if len(selected) < target_count:
        selected = _greedy_select(
            ordered,
            target_count=target_count,
            max_overlap_frac=max_overlap_frac,
            enforce_archetype_ceiling=False,
        )
    return [
        _selected_clip(item, rank=index + 1, clip_number=index + 1)
        for index, item in enumerate(selected)
    ]


def selection_count(*, duration_s: float, passing_count: int) -> int:
    """Return the R4b per-speech clip count cap."""

    if passing_count <= 0:
        return 0
    supply_count = math.floor(duration_s / SECONDS_PER_CLIP_BUDGET)
    count = min(MAX_SELECTED_PER_SPEECH, supply_count, passing_count)
    return max(count, 1)


def overlap_fraction(first: Candidate, second: Candidate) -> float:
    """Return overlap as a fraction of the shorter candidate duration."""

    overlap_s = max(
        0.0,
        min(float(first.end_s), float(second.end_s))
        - max(float(first.start_s), float(second.start_s)),
    )
    shortest_s = min(
        float(first.end_s - first.start_s),
        float(second.end_s - second.start_s),
    )
    if shortest_s <= 0.0:
        return 1.0
    return overlap_s / shortest_s


def _greedy_select(
    ordered: Sequence[SelectionInput],
    *,
    target_count: int,
    max_overlap_frac: float,
    enforce_archetype_ceiling: bool,
) -> list[SelectionInput]:
    selected: list[SelectionInput] = []
    archetype_counts: Counter[str] = Counter()
    ceiling = max(1, math.ceil(target_count * ARCHETYPE_CEILING_FRACTION))
    for item in ordered:
        if len(selected) >= target_count:
            break
        if any(
            overlap_fraction(item.candidate, selected_item.candidate) > max_overlap_frac
            for selected_item in selected
        ):
            continue
        if enforce_archetype_ceiling and archetype_counts[item.archetype] >= ceiling:
            continue
        selected.append(item)
        archetype_counts[item.archetype] += 1
    return selected


def _selected_clip(item: SelectionInput, *, rank: int, clip_number: int) -> SelectedClip:
    title = title_from_candidate_text(item.text)
    return SelectedClip(
        clip_id=f"{item.candidate.speech_id}_c{clip_number:02d}",
        speech_id=item.candidate.speech_id,
        rank=rank,
        start_s=item.candidate.start_s,
        end_s=item.candidate.end_s,
        archetype=item.archetype,
        title=title,
        transcript=item.text,
        topic=None,
    )
