"""Small stdlib task runner mirroring the Makefile targets."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field


@dataclass(frozen=True)
class TaskCommand:
    """One subprocess command for a task target."""

    argv: tuple[str, ...]
    env: Mapping[str, str] = field(default_factory=dict)


Runner = Callable[[TaskCommand], int]

PYTHON = sys.executable
TARGETS: dict[str, tuple[TaskCommand, ...]] = {
    "test": (TaskCommand((PYTHON, "-m", "pytest", "-m", "not live and not slow")),),
    "lint": (TaskCommand((PYTHON, "-m", "ruff", "check", ".")),),
    "typecheck": (TaskCommand((PYTHON, "-m", "mypy", "src")),),
    "format": (
        TaskCommand((PYTHON, "-m", "ruff", "format", ".")),
        TaskCommand((PYTHON, "-m", "ruff", "check", "--fix", ".")),
    ),
    "golden": (
        TaskCommand(
            (PYTHON, "-m", "pytest", "-m", "not live and not slow"),
            env={"UPDATE_GOLDEN": "1"},
        ),
    ),
    "fixture": (TaskCommand((PYTHON, "scripts/generate_synthetic_fixture.py")),),
    "run-fixture": (TaskCommand((PYTHON, "-m", "src.stages.run_fixture")),),
}


def run_targets(targets: Sequence[str], *, runner: Runner | None = None) -> int:
    """Run task targets in order and stop at the first non-zero exit code."""

    command_runner = runner or _run_command
    for target in targets:
        commands = TARGETS[target]
        for command in commands:
            exit_code = command_runner(command)
            if exit_code != 0:
                return exit_code
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Parse CLI args and execute named targets."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="+", choices=sorted(TARGETS))
    args = parser.parse_args(argv)
    return run_targets(args.targets)


def _run_command(command: TaskCommand) -> int:
    env = os.environ.copy()
    env.update(command.env)
    completed = subprocess.run(command.argv, env=env, check=False)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
