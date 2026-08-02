"""Small smoothing helpers for C9 camera keyframes."""

from __future__ import annotations

from collections.abc import Sequence


def rate_limit_targets(
    targets: Sequence[tuple[float, float]],
    *,
    max_velocity_px_s: float,
) -> tuple[tuple[float, float], ...]:
    """Limit crop-x movement between target keyframes."""

    if not targets:
        return ()
    ordered = sorted(targets, key=lambda item: item[0])
    limited: list[tuple[float, float]] = [ordered[0]]
    for t, target_x in ordered[1:]:
        prev_t, prev_x = limited[-1]
        dt = t - prev_t
        if dt <= 0.0:
            continue
        max_delta = max_velocity_px_s * dt
        delta = target_x - prev_x
        if abs(delta) <= max_delta:
            limited.append((t, target_x))
            continue
        limited.append((t, prev_x + max_delta * (1.0 if delta > 0.0 else -1.0)))
    return tuple(limited)


def collapse_stable_targets(
    targets: Sequence[tuple[float, float]],
    *,
    epsilon_px: float = 0.5,
) -> tuple[tuple[float, float], ...]:
    """Remove consecutive targets that would not visibly move the crop."""

    collapsed: list[tuple[float, float]] = []
    for t, x in targets:
        if collapsed and abs(collapsed[-1][1] - x) <= epsilon_px:
            continue
        collapsed.append((t, x))
    return tuple(collapsed)
