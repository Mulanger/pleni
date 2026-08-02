"""Typed exception hierarchy for the pipeline."""

from __future__ import annotations


class PipelineError(Exception):
    """Base class for all expected pipeline failures."""


class ConfigurationError(PipelineError):
    """Configuration is missing, invalid, or inconsistent."""


class ArtifactError(PipelineError):
    """A stage artifact is missing, invalid, or cannot be written."""


class ExternalServiceError(PipelineError):
    """An external dependency failed after retryable handling."""


class ContractValidationError(PipelineError):
    """Serialized data failed to validate against the shared contracts."""


class StageExecutionError(PipelineError):
    """A stage failed while producing its own artifact."""
