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


class NotClippableError(PipelineError):
    """This source has no clippable content, and never will.

    Distinct from a failure. A Riksdagen document can legitimately carry no
    video and no speakers — an interpellation answered in writing, a session
    during summer recess, a procedural item — and retrying that three times
    before dead-lettering buries real failures under normal gaps. Especially
    during a backfill, where hundreds of such documents are expected.

    The orchestrator treats this as terminal-but-not-failed: the job is marked
    `skipped` and the chain stops there.
    """
