"""Tests for golden-file comparison helpers."""

from __future__ import annotations

import pytest

from tests.conftest import assert_json_close, assert_matches_golden


def test_json_close_allows_small_float_differences() -> None:
    assert_json_close({"value": [1.0, 2.0000001]}, {"value": [1.0, 2.0]}, tolerance=1e-5)


def test_json_close_rejects_structure_mismatch() -> None:
    with pytest.raises(AssertionError):
        assert_json_close({"value": 1.0}, {"other": 1.0})


def test_matches_golden_reads_expected_file(tmp_path) -> None:  # type: ignore[no-untyped-def]
    golden_path = tmp_path / "example.json"
    golden_path.write_text('{"value": 1.0}\n', encoding="utf-8")

    assert_matches_golden({"value": 1.0000001}, golden_path, tolerance=1e-5)


def test_matches_golden_fails_when_file_missing(tmp_path) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(AssertionError, match="Missing golden file"):
        assert_matches_golden({"value": 1.0}, tmp_path / "missing.json")
