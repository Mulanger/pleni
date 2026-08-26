"""Read-only production contract checks for UI16.4/UI16.9 search RPCs.

The module skips until migration 027 is deployed. It never calls OpenAI and
never consumes an abuse bucket; paid/provider behavior belongs to the Edge
Function tests and the separately approved backfill smoke.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from src.config import get_settings
from src.publish.supabase import SupabaseManagementClient

pytestmark = pytest.mark.live

RPC_SIGNATURES = (
    "load_search_entity_catalog()",
    "get_search_event_destination(uuid)",
    "consume_search_request_limit(text)",
    "reserve_search_provider_tokens(integer)",
    "search_clip_candidates(text,text,integer,uuid,text,date,date,uuid[])",
    "prepare_clip_search_request(text)",
    "search_clip_candidates_v2(text,text,integer,uuid,text,date,date,uuid[])",
    "load_search_entity_catalog_cached()",
)


@pytest.fixture(scope="module")
def sql() -> Any:
    settings = get_settings()
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        pytest.skip("Set RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN")
    client = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )

    def run(query: str) -> list[Mapping[str, Any]]:
        response = client.execute_sql(query)
        rows = response.get("result", response)
        return list(rows) if isinstance(rows, list) else []

    ledger = run(
        "select 1 as applied from public.schema_migrations "
        "where filename = '028_search_catalog_cache.up.sql';"
    )
    if not ledger:
        pytest.skip("migration 028 is not deployed")
    return run


def test_ui164_rpcs_are_service_only_and_pin_search_path(sql: Any) -> None:
    rows = sql(
        """
        select
          p.oid::regprocedure::text as signature,
          has_function_privilege('anon', p.oid, 'execute') as anon,
          has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
          has_function_privilege('service_role', p.oid, 'execute') as service_role,
          coalesce(array_to_string(p.proconfig, ','), '') as settings
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'load_search_entity_catalog',
            'get_search_event_destination',
            'consume_search_request_limit',
            'reserve_search_provider_tokens',
            'search_clip_candidates',
            'prepare_clip_search_request',
            'search_clip_candidates_v2',
            'load_search_entity_catalog_cached'
          )
        order by 1;
        """
    )
    by_signature = {str(row["signature"]): row for row in rows}
    assert set(RPC_SIGNATURES) == set(by_signature)
    for signature, row in by_signature.items():
        assert row["anon"] in (False, "false"), signature
        assert row["authenticated"] in (False, "false"), signature
        assert row["service_role"] in (True, "true"), signature
        assert "search_path=" in str(row["settings"]), signature


def test_rate_limit_storage_cannot_store_query_or_address(sql: Any) -> None:
    columns = sql(
        """
        select column_name
        from information_schema.columns
        where table_schema = 'private'
          and table_name = 'search_rate_limit_buckets'
        order by ordinal_position;
        """
    )
    names = {str(row["column_name"]) for row in columns}
    assert "key_hash" in names
    assert not names.intersection({"query", "address", "ip", "ip_address"})


def test_catalog_and_filtered_retrieval_return_private_rpc_envelopes(sql: Any) -> None:
    row = sql(
        """
        select
          public.load_search_entity_catalog() as catalog,
          public.search_clip_candidates_v2(
            null, null, 1, null, null, null, null, null
          ) as filtered;
        """
    )[0]
    catalog = row["catalog"]
    filtered = row["filtered"]
    assert isinstance(catalog, dict)
    assert isinstance(catalog.get("people"), list)
    assert isinstance(catalog.get("events"), list)
    assert isinstance(filtered, dict)
    assert isinstance(filtered.get("indexVersion"), str)
    assert isinstance(filtered.get("semanticAvailable"), bool)
    assert isinstance(filtered.get("results"), list)
    assert len(filtered["results"]) <= 1


def test_materialized_catalog_matches_live_entities(sql: Any) -> None:
    row = sql(
        """
        select
          public.load_search_entity_catalog_cached()
            = public.load_search_entity_catalog() as matches,
          entity_catalog_refreshed_at is not null as refreshed
        from private.search_system_state
        where singleton;
        """
    )[0]
    assert row["matches"] in (True, "true")
    assert row["refreshed"] in (True, "true")
