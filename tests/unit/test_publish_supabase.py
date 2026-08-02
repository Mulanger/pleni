"""Tests for Supabase publish helpers."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from src.publish.bunny import HttpResponse
from src.publish.supabase import (
    SupabaseManagementClient,
    SupabasePublishBatch,
    SupabaseRestClient,
    parse_curl_headers,
    sql_jsonb_literal,
)


@dataclass(frozen=True)
class RecordedRequest:
    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes | None


class FakeTransport:
    def __init__(
        self,
        response_body: bytes = b'{"result":[{"published":{"clips_upserted":1}}]}',
    ) -> None:
        self.requests: list[RecordedRequest] = []
        self.response_body = response_body

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout_s: float,
    ) -> HttpResponse:
        del timeout_s
        self.requests.append(RecordedRequest(method, url, headers, body))
        return HttpResponse(200, {}, self.response_body)


def test_publish_batch_executes_one_management_query() -> None:
    transport = FakeTransport()
    client = SupabaseManagementClient(
        project_ref="abcdefghijklmnopqrst",
        access_token="pat-token",
        transport=transport,
        max_retries=0,
    )
    batch = SupabasePublishBatch(
        source={"dokid": "HD1"},
        politicians=[],
        speeches=[],
        clips=[{"id": "clip_1"}],
        clip_features=[],
        pipeline_run={"kind": "publish", "clip_count": 1},
    )

    client.publish_batch(batch)

    assert len(transport.requests) == 1
    request = transport.requests[0]
    assert request.method == "POST"
    assert request.url.endswith("/projects/abcdefghijklmnopqrst/database/query")
    assert request.headers["Authorization"] == "Bearer pat-token"
    assert request.body is not None
    body = request.body.decode("utf-8")
    assert "publish_clip_batch" in body
    assert '\\"clip_count\\": 1' in body
    assert '\\"id\\": \\"clip_1\\"' in body


def test_apply_migration_file_executes_sql(tmp_path: Path) -> None:
    migration = tmp_path / "migration.sql"
    migration.write_text("select 1;", encoding="utf-8")
    transport = FakeTransport()
    client = SupabaseManagementClient(
        project_ref="abcdefghijklmnopqrst",
        access_token="pat-token",
        transport=transport,
        max_retries=0,
    )

    client.apply_migration_file(migration)

    assert transport.requests[0].body is not None
    assert "select 1;" in transport.requests[0].body.decode("utf-8")


def test_execute_sql_accepts_array_response() -> None:
    transport = FakeTransport(response_body=b'[{"ok":1}]')
    client = SupabaseManagementClient(
        project_ref="abcdefghijklmnopqrst",
        access_token="pat-token",
        transport=transport,
        max_retries=0,
    )

    result = client.execute_sql("select 1 as ok;")

    assert result == {"result": [{"ok": 1}]}


def test_rest_publish_batch_posts_json_payload_without_authorization_header() -> None:
    transport = FakeTransport(response_body=b'{"clips_upserted":1}')
    client = SupabaseRestClient(
        project_ref="abcdefghijklmnopqrst",
        api_key="secret-key",
        transport=transport,
        max_retries=0,
    )
    batch = SupabasePublishBatch(
        source={"dokid": "HD1"},
        politicians=[],
        speeches=[],
        clips=[{"id": "clip_1"}],
        clip_features=[],
        pipeline_run={"kind": "publish"},
    )

    result = client.publish_batch(batch)

    assert result == {"clips_upserted": 1}
    request = transport.requests[0]
    assert request.url == (
        "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/publish_clip_batch"
    )
    assert request.headers["apikey"] == "secret-key"
    assert "Authorization" not in request.headers
    assert request.body is not None
    assert b'"payload"' in request.body


def test_sql_jsonb_literal_avoids_tag_collision() -> None:
    literal = sql_jsonb_literal({"text": "$riket_json_0$"})

    assert literal.startswith("$riket_json_1$")
    assert literal.endswith("$riket_json_1$::jsonb")


def test_parse_curl_headers_uses_final_response_block() -> None:
    status, headers = parse_curl_headers(
        "HTTP/1.1 100 Continue\r\n\r\n"
        "HTTP/2 200\r\n"
        "content-type: application/json\r\n"
        "content-length: 2\r\n\r\n"
    )

    assert status == 200
    assert headers["content-type"] == "application/json"
    assert headers["content-length"] == "2"


def test_publish_migration_contains_schema_rls_and_function() -> None:
    migration = Path("migrations/001_publish_schema.up.sql").read_text(encoding="utf-8")

    assert "create table if not exists public.clips" in migration
    assert "url_540x960 text not null" in migration
    assert "enable row level security" in migration
    assert "clips_public_read" in migration
    assert "publish_clip_batch" in migration
