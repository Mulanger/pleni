"""Supabase publish metadata writer and migration helper."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from typing import Any, cast

from src.errors import ExternalServiceError
from src.publish.bunny import HttpResponse, HttpTransport, UrllibTransport, request_with_retries

SUPABASE_MANAGEMENT_BASE = "https://api.supabase.com/v1"


@dataclass(frozen=True)
class SupabasePublishBatch:
    """Metadata payload inserted after Bunny assets have verified."""

    source: Mapping[str, object]
    politicians: Sequence[Mapping[str, object]]
    speeches: Sequence[Mapping[str, object]]
    clips: Sequence[Mapping[str, object]]
    clip_features: Sequence[Mapping[str, object]]
    pipeline_run: Mapping[str, object]

    def to_payload(self) -> dict[str, object]:
        """Return a JSON-compatible publish payload."""

        return {
            "source": dict(self.source),
            "politicians": [dict(row) for row in self.politicians],
            "speeches": [dict(row) for row in self.speeches],
            "clips": [dict(row) for row in self.clips],
            "clip_features": [dict(row) for row in self.clip_features],
            "pipeline_run": dict(self.pipeline_run),
        }


class SupabaseManagementClient:
    """Minimal Supabase Management API client for C11 schema and batch writes."""

    def __init__(
        self,
        *,
        project_ref: str,
        access_token: str,
        transport: HttpTransport | None = None,
        timeout_s: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self.project_ref = project_ref
        self.access_token = access_token
        self.transport = transport or default_management_transport()
        self.timeout_s = timeout_s
        self.max_retries = max_retries

    def execute_sql(self, query: str) -> Mapping[str, Any]:
        """Execute SQL through Supabase's HTTPS Management API."""

        body = json.dumps({"query": query}, ensure_ascii=False).encode("utf-8")
        response = request_with_retries(
            self.transport,
            "POST",
            f"{SUPABASE_MANAGEMENT_BASE}/projects/{self.project_ref}/database/query",
            headers={
                "Authorization": f"Bearer {self.access_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body=body,
            timeout_s=self.timeout_s,
            max_retries=self.max_retries,
        )
        if response.status not in {200, 201}:
            raise _http_error("Supabase SQL execution", response)
        parsed = json.loads(response.body.decode("utf-8") or "{}")
        if isinstance(parsed, list):
            return {"result": parsed}
        if not isinstance(parsed, Mapping):
            raise ExternalServiceError("Supabase SQL execution returned unsupported JSON")
        return cast(Mapping[str, Any], parsed)

    def apply_migration_file(self, migration_path: Path) -> Mapping[str, Any]:
        """Apply one committed SQL migration file."""

        return self.execute_sql(migration_path.read_text(encoding="utf-8"))

    def publish_batch(self, batch: SupabasePublishBatch) -> Mapping[str, Any]:
        """Insert all C11 rows through one Postgres function call."""

        payload_literal = sql_jsonb_literal(batch.to_payload())
        return self.execute_sql(
            f"select public.publish_clip_batch({payload_literal}) as published;"
        )


class SupabaseRestClient:
    """Supabase project REST API client for large publish RPC payloads."""

    def __init__(
        self,
        *,
        project_ref: str,
        api_key: str,
        transport: HttpTransport | None = None,
        timeout_s: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self.project_ref = project_ref
        self.api_key = api_key
        self.transport = transport or default_management_transport()
        self.timeout_s = timeout_s
        self.max_retries = max_retries

    def publish_batch(self, batch: SupabasePublishBatch) -> Mapping[str, Any]:
        """Call the transactional publish RPC with JSON in the request body."""

        body = json.dumps({"payload": batch.to_payload()}, ensure_ascii=False).encode("utf-8")
        response = request_with_retries(
            self.transport,
            "POST",
            f"https://{self.project_ref}.supabase.co/rest/v1/rpc/publish_clip_batch",
            headers={
                "apikey": self.api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body=body,
            timeout_s=self.timeout_s,
            max_retries=self.max_retries,
        )
        if response.status not in {200, 201, 204}:
            raise _http_error("Supabase publish RPC", response)
        if not response.body:
            return {}
        parsed = json.loads(response.body.decode("utf-8"))
        if isinstance(parsed, Mapping):
            return cast(Mapping[str, Any], parsed)
        return {"result": parsed}


@dataclass(frozen=True)
class SupabasePublishClient:
    """Client combining Management migrations with REST RPC publish writes."""

    management: SupabaseManagementClient
    rest: SupabaseRestClient

    def apply_migration_file(self, migration_path: Path) -> Mapping[str, Any]:
        """Apply one migration through the Management API."""

        return self.management.apply_migration_file(migration_path)

    def publish_batch(self, batch: SupabasePublishBatch) -> Mapping[str, Any]:
        """Write metadata through the project REST RPC."""

        return self.rest.publish_batch(batch)


def sql_jsonb_literal(payload: object) -> str:
    """Render a JSON payload as a safely dollar-quoted SQL jsonb literal."""

    raw_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    tag_index = 0
    while True:
        tag = f"$riket_json_{tag_index}$"
        if tag not in raw_json:
            return f"{tag}{raw_json}{tag}::jsonb"
        tag_index += 1


class CurlTransport:
    """HTTP transport backed by curl for endpoints that reject Python TLS fingerprints."""

    def __init__(self, executable: str | None = None) -> None:
        resolved = executable or shutil.which("curl.exe") or shutil.which("curl")
        if resolved is None:
            raise ExternalServiceError("curl executable was not found")
        self.executable = resolved

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout_s: float,
    ) -> HttpResponse:
        header_path = _temp_path()
        output_path = _temp_path()
        body_path: Path | None = None
        try:
            args = [
                self.executable,
                "-sS",
                "-X",
                method,
                url,
                "-D",
                str(header_path),
                "-o",
                str(output_path),
                "--max-time",
                str(timeout_s),
            ]
            for key, value in headers.items():
                args.extend(["-H", f"{key}: {value}"])
            if body is not None:
                body_path = _temp_path()
                body_path.write_bytes(body)
                args.extend(["--data-binary", f"@{body_path}"])
            completed = subprocess.run(args, capture_output=True, check=False)
            if completed.returncode != 0:
                stderr = completed.stderr.decode("utf-8", errors="replace")
                raise ExternalServiceError(f"curl HTTP request failed: {stderr}")
            raw_headers = header_path.read_text(encoding="utf-8", errors="replace")
            status, parsed_headers = parse_curl_headers(raw_headers)
            return HttpResponse(
                status=status,
                headers=parsed_headers,
                body=output_path.read_bytes(),
            )
        finally:
            _unlink_if_exists(header_path)
            _unlink_if_exists(output_path)
            if body_path is not None:
                _unlink_if_exists(body_path)


def default_management_transport() -> HttpTransport:
    """Prefer curl for Supabase Management API calls when available."""

    if shutil.which("curl.exe") is not None or shutil.which("curl") is not None:
        return CurlTransport()
    return UrllibTransport()


def parse_curl_headers(raw_headers: str) -> tuple[int, dict[str, str]]:
    """Parse curl's response header dump and return the final response block."""

    lines = raw_headers.splitlines()
    status_indexes = [index for index, line in enumerate(lines) if line.startswith("HTTP/")]
    if not status_indexes:
        raise ExternalServiceError("curl response did not contain an HTTP status line")
    start = status_indexes[-1]
    status_parts = lines[start].split()
    if len(status_parts) < 2:
        raise ExternalServiceError(f"Invalid HTTP status line: {lines[start]}")
    try:
        status = int(status_parts[1])
    except ValueError as exc:
        raise ExternalServiceError(f"Invalid HTTP status code: {lines[start]}") from exc
    headers: dict[str, str] = {}
    for line in lines[start + 1 :]:
        if not line.strip():
            break
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip()] = value.strip()
    return status, headers


def _http_error(context: str, response: HttpResponse) -> ExternalServiceError:
    body_preview = response.body[:300].decode("utf-8", errors="replace")
    return ExternalServiceError(f"{context} failed with HTTP {response.status}: {body_preview}")


def _temp_path() -> Path:
    with tempfile.NamedTemporaryFile(delete=False) as handle:
        return Path(handle.name)


def _unlink_if_exists(path: PathLike[str] | Path) -> None:
    with suppress(OSError):
        Path(path).unlink(missing_ok=True)
