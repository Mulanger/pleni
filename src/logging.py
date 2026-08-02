"""Structured logging setup for stage entrypoints."""

from __future__ import annotations

import logging
import sys
from typing import Any, cast

import structlog


def configure_logging(log_level: str = "INFO") -> None:
    """Configure JSON logs for command-line stages."""

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, log_level.upper(), logging.INFO),
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, log_level.upper(), logging.INFO)
        ),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def stage_logger(stage: str, dokid: str | None = None, **context: Any) -> structlog.BoundLogger:
    """Return a logger bound with required stage context."""

    logger = structlog.get_logger().bind(stage=stage, **context)
    if dokid is not None:
        logger = logger.bind(dokid=dokid)
    return cast(structlog.BoundLogger, logger)
