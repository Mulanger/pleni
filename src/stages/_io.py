"""JSON helpers shared by lightweight stage entrypoints."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, TypeVar, cast

from pydantic import BaseModel, ValidationError

from src.errors import ArtifactError, ContractValidationError

ModelT = TypeVar("ModelT", bound=BaseModel)


def read_json_object(path: Path, artifact_name: str) -> Mapping[str, Any]:
    """Read a JSON object artifact."""

    if not path.exists():
        raise ArtifactError(f"{artifact_name} is missing: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ContractValidationError(f"{artifact_name} is not a JSON object: {path}")
    return cast(Mapping[str, Any], payload)


def read_model(path: Path, model: type[ModelT], artifact_name: str) -> ModelT:
    """Read one Pydantic model artifact."""

    if not path.exists():
        raise ArtifactError(f"{artifact_name} is missing: {path}")
    try:
        return model.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError as exc:
        raise ContractValidationError(f"{artifact_name} failed validation: {exc}") from exc


def read_model_list(path: Path, model: type[ModelT], artifact_name: str) -> list[ModelT]:
    """Read a JSON array of Pydantic models."""

    if not path.exists():
        raise ArtifactError(f"{artifact_name} is missing: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ContractValidationError(f"{artifact_name} is not a JSON array: {path}")
    try:
        return [model.model_validate(item) for item in payload]
    except ValidationError as exc:
        raise ContractValidationError(f"{artifact_name} failed validation: {exc}") from exc


def write_json(path: Path, payload: object) -> None:
    """Write a deterministic UTF-8 JSON artifact."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
