"""Live UI16.1 privilege, lifecycle and Swedish keyword-search checks.

The read-only checks may run after migration 022 is deployed. The lifecycle
fixture writes clearly prefixed catalogue rows and cleans them up, but remains
disabled unless ``RIKET_TOPIC_SEARCH_LIVE_MUTATIONS=1`` is explicitly set. The
current production project is not a staging environment, so UI16.1 implementation
does not run the mutating test automatically.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator, Mapping
from typing import Any

import pytest

from src.config import get_settings
from src.publish.supabase import SupabaseManagementClient

pytestmark = pytest.mark.live

PRIVATE_TABLES = (
    "clip_search_documents",
    "search_events",
    "search_event_sources",
    "search_event_aliases",
    "search_person_aliases",
    "search_rate_limit_buckets",
    "search_system_state",
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
        "where filename = '022_search_foundation.up.sql';"
    )
    if not ledger:
        pytest.skip("migration 022 is not deployed")
    return run


def test_private_search_tables_have_rls_and_no_browser_privileges(sql: Any) -> None:
    schema = sql(
        """
        select
          has_schema_privilege('anon', 'private', 'usage') as anon_usage,
          has_schema_privilege('authenticated', 'private', 'usage') as auth_usage;
        """
    )[0]
    assert schema["anon_usage"] in (False, "false")
    assert schema["auth_usage"] in (False, "false")

    rows = sql(
        """
        select
          c.relname as table_name,
          c.relrowsecurity as rls,
          has_table_privilege('anon', c.oid, 'select') as anon_select,
          has_table_privilege('authenticated', c.oid, 'select') as auth_select,
          (
            has_table_privilege('anon', c.oid, 'insert')
            or has_table_privilege('anon', c.oid, 'update')
            or has_table_privilege('anon', c.oid, 'delete')
          ) as anon_write,
          (
            has_table_privilege('authenticated', c.oid, 'insert')
            or has_table_privilege('authenticated', c.oid, 'update')
            or has_table_privilege('authenticated', c.oid, 'delete')
          ) as auth_write
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private'
          and (c.relname like 'search_%' or c.relname = 'clip_search_documents')
        order by c.relname;
        """
    )
    by_name = {str(row["table_name"]): row for row in rows}

    assert set(PRIVATE_TABLES).issubset(by_name)
    for table in PRIVATE_TABLES:
        row = by_name[table]
        assert row["rls"] in (True, "true")
        assert row["anon_select"] in (False, "false")
        assert row["auth_select"] in (False, "false")
        assert row["anon_write"] in (False, "false")
        assert row["auth_write"] in (False, "false")


def test_private_search_helpers_are_not_executable_by_browser_roles(sql: Any) -> None:
    rows = sql(
        """
        select
          p.oid::regprocedure::text as signature,
          has_function_privilege('anon', p.oid, 'execute') as anon,
          has_function_privilege('authenticated', p.oid, 'execute') as authenticated
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname like '%search%'
        order by 1;
        """
    )

    assert rows
    for row in rows:
        assert row["anon"] in (False, "false"), row["signature"]
        assert row["authenticated"] in (False, "false"), row["signature"]


def test_keyword_rpc_is_service_only_and_has_an_empty_search_path(sql: Any) -> None:
    rows = sql(
        """
        select
          has_function_privilege(
            'anon',
            'public.search_clip_keywords(text,integer,uuid,text,date,date,uuid[])',
            'execute'
          ) as anon,
          has_function_privilege(
            'authenticated',
            'public.search_clip_keywords(text,integer,uuid,text,date,date,uuid[])',
            'execute'
          ) as authenticated,
          has_function_privilege(
            'service_role',
            'public.search_clip_keywords(text,integer,uuid,text,date,date,uuid[])',
            'execute'
          ) as service_role,
          coalesce(array_to_string(p.proconfig, ','), '') as settings
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'search_clip_keywords';
        """
    )

    assert len(rows) == 1
    row = rows[0]
    assert row["anon"] in (False, "false")
    assert row["authenticated"] in (False, "false")
    assert row["service_role"] in (True, "true")
    assert 'search_path=""' in str(row["settings"]) or "search_path=" in str(row["settings"])


def test_keyword_document_coverage_matches_exact_public_eligibility(sql: Any) -> None:
    row = sql(
        """
        select
          (select count(*)::int
           from public.clips c
           where c.published_at is not null and c.moderation <> 'rejected') as eligible,
          (select count(*)::int from private.clip_search_documents) as documents;
        """
    )[0]

    assert int(row["documents"]) == int(row["eligible"])


def test_swedish_configuration_stems_inflected_words(sql: Any) -> None:
    row = sql(
        """
        select (
          to_tsvector('pg_catalog.swedish'::regconfig, 'Skatterna finansierar välfärden')
          @@ plainto_tsquery('pg_catalog.swedish'::regconfig, 'skatt')
        ) as matches;
        """
    )[0]

    assert row["matches"] in (True, "true")


@pytest.fixture
def catalogue_probe(sql: Any) -> Iterator[dict[str, str]]:
    if os.environ.get("RIKET_TOPIC_SEARCH_LIVE_MUTATIONS") != "1":
        pytest.skip("set RIKET_TOPIC_SEARCH_LIVE_MUTATIONS=1 for catalogue lifecycle writes")

    suffix = uuid.uuid4().hex[:12]
    ids = {
        "dokid": f"livetest-search-{suffix}",
        "speech": f"livetest-search-{suffix}-speech",
        "clip_a": f"livetest-search-{suffix}-a",
        "clip_b": f"livetest-search-{suffix}-b",
    }
    sql(
        f"""
        insert into public.sources (
          dokid, title, debate_type, debate_date, source_url, status
        ) values (
          '{ids["dokid"]}', 'Livetest sökdebatt', 'livetest', date '2024-04-03',
          'https://example.invalid/livetest-search', 'published'
        );

        insert into public.speeches (
          id, source_id, anforande_id, speaker_name, party, anforandetyp,
          start_s, end_s, official_text, status
        ) values (
          '{ids["speech"]}',
          (select id from public.sources where dokid = '{ids["dokid"]}'),
          '{ids["speech"]}', 'Livetest Talare', 'S', 'Anförande',
          0, 120, 'Skatterna finansierar välfärden.', 'published'
        );

        insert into public.clips (
          id, speech_id, rank_in_speech, start_s, end_s, duration_s,
          title, transcript, url_540x960, thumb_url, moderation, published_at
        ) values
          ('{ids["clip_a"]}', '{ids["speech"]}', 1, 0, 45, 45,
           'Skatterna och välfärden', 'Skatterna finansierar välfärden.',
           'https://example.invalid/a.mp4', 'https://example.invalid/a.webp', 'auto', now()),
          ('{ids["clip_b"]}', '{ids["speech"]}', 2, 45, 90, 45,
           'Skatterna och välfärden', 'Skatterna finansierar välfärden.',
           'https://example.invalid/b.mp4', 'https://example.invalid/b.webp', 'auto', now());
        """
    )
    try:
        yield ids
    finally:
        sql(f"delete from public.sources where dokid = '{ids['dokid']}';")


def test_publish_update_reject_unpublish_delete_lifecycle(
    sql: Any, catalogue_probe: dict[str, str]
) -> None:
    ids = catalogue_probe
    rows = sql(
        f"""
        select clip_id
        from public.search_clip_keywords('skatt', 120, null, 'S', null, null, null)
        where clip_id in ('{ids["clip_a"]}', '{ids["clip_b"]}');
        """
    )
    assert [row["clip_id"] for row in rows] == [ids["clip_a"], ids["clip_b"]]

    before = sql(
        f"select source_hash from private.clip_search_documents where clip_id = '{ids['clip_a']}';"
    )[0]["source_hash"]
    sql(f"update public.clips set title = 'Förändrad skattetitel' where id = '{ids['clip_a']}';")
    after = sql(
        f"select source_hash from private.clip_search_documents where clip_id = '{ids['clip_a']}';"
    )[0]["source_hash"]
    assert before != after

    sql(f"update public.speeches set party = 'M' where id = '{ids['speech']}';")
    row = sql(
        "select party_at_speech from private.clip_search_documents "
        f"where clip_id = '{ids['clip_a']}';"
    )[0]
    assert row["party_at_speech"] == "M"

    sql(
        f"update public.sources set debate_date = date '2024-04-04' where dokid = '{ids['dokid']}';"
    )
    row = sql(
        "select debate_date::text from private.clip_search_documents "
        f"where clip_id = '{ids['clip_a']}';"
    )[0]
    assert row["debate_date"] == "2024-04-04"

    sql(f"update public.clips set moderation = 'rejected' where id = '{ids['clip_a']}';")
    assert not sql(
        f"select 1 from private.clip_search_documents where clip_id = '{ids['clip_a']}';"
    )

    sql(f"update public.clips set moderation = 'auto' where id = '{ids['clip_a']}';")
    assert sql(f"select 1 from private.clip_search_documents where clip_id = '{ids['clip_a']}';")

    sql(f"update public.clips set published_at = null where id = '{ids['clip_a']}';")
    assert not sql(
        f"select 1 from private.clip_search_documents where clip_id = '{ids['clip_a']}';"
    )

    sql(f"update public.clips set published_at = now() where id = '{ids['clip_a']}';")
    assert sql(f"select 1 from private.clip_search_documents where clip_id = '{ids['clip_a']}';")

    sql(f"delete from public.clips where id = '{ids['clip_a']}';")
    assert not sql(
        f"select 1 from private.clip_search_documents where clip_id = '{ids['clip_a']}';"
    )
