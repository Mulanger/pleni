"""Tests for the stdlib task runner."""

from __future__ import annotations

import tasks


def test_run_targets_runs_each_named_target() -> None:
    calls: list[tasks.TaskCommand] = []

    def runner(command: tasks.TaskCommand) -> int:
        calls.append(command)
        return 0

    exit_code = tasks.run_targets(["test", "lint", "typecheck"], runner=runner)

    assert exit_code == 0
    assert [command.argv for command in calls] == [
        tasks.TARGETS["test"][0].argv,
        tasks.TARGETS["lint"][0].argv,
        tasks.TARGETS["typecheck"][0].argv,
    ]


def test_run_targets_propagates_non_zero_exit_code() -> None:
    calls: list[tasks.TaskCommand] = []

    def runner(command: tasks.TaskCommand) -> int:
        calls.append(command)
        return 7 if command == tasks.TARGETS["lint"][0] else 0

    exit_code = tasks.run_targets(["test", "lint", "typecheck"], runner=runner)

    assert exit_code == 7
    assert [command.argv for command in calls] == [
        tasks.TARGETS["test"][0].argv,
        tasks.TARGETS["lint"][0].argv,
    ]


def test_run_fixture_target_is_exposed() -> None:
    assert tasks.TARGETS["run-fixture"][0].argv == (
        tasks.PYTHON,
        "-m",
        "src.stages.run_fixture",
    )
