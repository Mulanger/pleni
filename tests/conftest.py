"""Shared pytest fixtures and golden-file comparison helpers."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

FLOAT_TOLERANCE = 1e-6


@pytest.fixture
def fixtures_dir() -> Path:
    return Path(__file__).parent / "fixtures"


def assert_json_close(actual: Any, expected: Any, *, tolerance: float = FLOAT_TOLERANCE) -> None:
    """Recursively compare JSON-compatible values with float tolerance."""

    if isinstance(actual, bool) or isinstance(expected, bool):
        assert actual == expected
        return
    if isinstance(actual, int | float) and isinstance(expected, int | float):
        assert abs(float(actual) - float(expected)) <= tolerance
        return
    if isinstance(actual, Mapping) and isinstance(expected, Mapping):
        assert set(actual.keys()) == set(expected.keys())
        for key in actual:
            assert_json_close(actual[key], expected[key], tolerance=tolerance)
        return
    if isinstance(actual, Sequence) and not isinstance(actual, str | bytes):
        assert isinstance(expected, Sequence)
        assert not isinstance(expected, str | bytes)
        assert len(actual) == len(expected)
        for actual_item, expected_item in zip(actual, expected, strict=True):
            assert_json_close(actual_item, expected_item, tolerance=tolerance)
        return
    assert actual == expected


def assert_matches_golden(
    actual: Any, golden_path: Path, *, tolerance: float = FLOAT_TOLERANCE
) -> None:
    """Compare a JSON-compatible object to a golden file, or update it via UPDATE_GOLDEN=1."""

    if os.environ.get("UPDATE_GOLDEN") == "1":
        golden_path.parent.mkdir(parents=True, exist_ok=True)
        golden_path.write_text(
            json.dumps(actual, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return

    assert golden_path.exists(), f"Missing golden file: {golden_path}"
    expected = json.loads(golden_path.read_text(encoding="utf-8"))
    assert_json_close(actual, expected, tolerance=tolerance)
