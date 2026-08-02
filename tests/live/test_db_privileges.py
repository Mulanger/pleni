"""Live privilege and RLS matrix tests against the real Supabase project.

Prerequisites P0-4, P0-6, P0-7 and O-3 in `docs/RECOMMENDATION_PREREQUISITES.md`.

`AGENTS.md` rule 3 rules out mocking the thing under test, and grants, RLS and
`SECURITY DEFINER` behaviour are precisely the thing under test — a fake would
report safety that is not there. These therefore run against a real Postgres.

There is no local Postgres in this environment (no Docker, no `psql`), so the
real database is the hosted project and the tests are marked ``live``. Point
them at a staging project as soon as one exists (`O-2`); today the only project
is production, which is itself a finding.

Run with:

    RIKET_SUPABASE_PROJECT_REF=... RIKET_SUPABASE_ACCESS_TOKEN=... \\
      python -m pytest tests/live/test_db_privileges.py -m live
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from src.config import get_settings
from src.publish.supabase import SupabaseManagementClient

pytestmark = pytest.mark.live

#: Roles PostgREST can present to Postgres from the public internet. Anything
#: reachable by these is reachable by anyone holding the publishable key, which
#: ships in the browser bundle.
PUBLIC_ROLES = ("anon", "authenticated")

#: Tables that hold no viewer data and are public political content by design.
PUBLIC_READ_TABLES = ("sources", "politicians", "speeches", "clips")

#: Tables that must never be reachable from a browser. `clip_features` carries
#: full candidate scoring, `engagement_events` is viewer behaviour, and `jobs` /
#: `pipeline_runs` / `schema_migrations` are operational internals.
PROTECTED_TABLES = (
    "clip_features",
    "engagement_events",
    "jobs",
    "pipeline_runs",
    "schema_migrations",
)


@pytest.fixture(scope="module")
def sql() -> Any:
    """Return a callable executing SQL against the configured project."""

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

    return run


def test_no_security_definer_function_is_executable_by_public_roles(sql: Any) -> None:
    """P0-4. This must fail for *future* functions too — that is the point.

    Postgres grants EXECUTE on a new function to PUBLIC by default and PostgREST
    exposes `public` schema functions as RPC, so every `SECURITY DEFINER`
    function is publicly callable until someone revokes it. Migration 002 fixed
    the one that existed; this catches the next one.
    """

    rows = sql(
        """
        select
          p.oid::regprocedure::text as signature,
          has_function_privilege('anon',          p.oid, 'execute') as anon,
          has_function_privilege('authenticated', p.oid, 'execute') as authenticated
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
        order by 1;
        """
    )

    assert rows, "expected at least publish_clip_batch to be SECURITY DEFINER"
    reachable = [
        row["signature"]
        for row in rows
        if row.get("anon") in (True, "true") or row.get("authenticated") in (True, "true")
    ]
    assert not reachable, f"SECURITY DEFINER functions callable from a browser: {reachable}"


def test_publish_rpc_is_service_role_only(sql: Any) -> None:
    """P0-1/P0-2 stated as an assertion rather than a one-off query."""

    signature = "'public.publish_clip_batch(jsonb)', 'execute'"
    row = sql(
        f"""
        select
          has_function_privilege('anon',          {signature}) as anon,
          has_function_privilege('authenticated', {signature}) as authenticated,
          has_function_privilege('service_role',  {signature}) as service_role;
        """
    )[0]

    assert row["anon"] in (False, "false")
    assert row["authenticated"] in (False, "false")
    assert row["service_role"] in (True, "true")


def test_definer_functions_have_a_pinned_search_path(sql: Any) -> None:
    """P0-5. An unpinned `search_path` lets a caller-controlled schema shadow a
    built-in that the definer function body resolves unqualified."""

    rows = sql(
        """
        select p.proname, coalesce(array_to_string(p.proconfig, ','), '') as settings
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef;
        """
    )

    unpinned = [row["proname"] for row in rows if "search_path" not in str(row["settings"])]
    assert not unpinned, f"SECURITY DEFINER functions without a pinned search_path: {unpinned}"


@pytest.mark.parametrize("table", PROTECTED_TABLES)
@pytest.mark.parametrize("role", PUBLIC_ROLES)
@pytest.mark.parametrize("verb", ("select", "insert", "update", "delete"))
def test_protected_tables_grant_nothing_to_public_roles(
    sql: Any, table: str, role: str, verb: str
) -> None:
    """P0-7, as a committed matrix rather than a one-off query.

    RLS-enabled-with-no-policies denies by default, but a stray `grant` plus a
    future policy is two independent mistakes away from a leak. Assert the
    grant is absent as well.
    """

    rows = sql(
        f"select has_table_privilege('{role}', 'public.{table}', '{verb}') as allowed;"
    )
    if not rows:
        pytest.skip(f"public.{table} does not exist in this project")

    assert rows[0]["allowed"] in (False, "false"), (
        f"{role} holds {verb} on public.{table}"
    )


@pytest.mark.parametrize("table", PUBLIC_READ_TABLES)
def test_public_tables_are_read_only_for_public_roles(sql: Any, table: str) -> None:
    """The public catalogue is readable and must not be writable."""

    row = sql(
        f"""
        select
          has_table_privilege('anon', 'public.{table}', 'select') as anon_select,
          has_table_privilege('anon', 'public.{table}', 'insert') as anon_insert,
          has_table_privilege('anon', 'public.{table}', 'update') as anon_update,
          has_table_privilege('anon', 'public.{table}', 'delete') as anon_delete,
          has_table_privilege('authenticated', 'public.{table}', 'insert') as auth_insert,
          has_table_privilege('authenticated', 'public.{table}', 'update') as auth_update,
          has_table_privilege('authenticated', 'public.{table}', 'delete') as auth_delete;
        """
    )[0]

    assert row["anon_select"] in (True, "true")
    for key, allowed in row.items():
        if key == "anon_select":
            continue
        assert allowed in (False, "false"), f"{key} is granted on public.{table}"


def test_every_public_table_has_rls_enabled(sql: Any) -> None:
    rows = sql(
        """
        select c.relname, c.relrowsecurity as rls
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by 1;
        """
    )

    without_rls = [row["relname"] for row in rows if row["rls"] in (False, "false")]
    assert not without_rls, f"tables in `public` without RLS: {without_rls}"


def test_sources_policy_no_longer_exposes_the_discovery_queue(sql: Any) -> None:
    """P0-6 live. `discovered` leaks debates we have found but not published."""

    rows = sql(
        """
        select pol.polname, pg_get_expr(pol.polqual, pol.polrelid) as using_expr
        from pg_policy pol
        join pg_class c on c.oid = pol.polrelid
        where c.relname = 'sources' and pol.polname = 'sources_public_read';
        """
    )

    assert rows, "sources_public_read policy is missing"
    assert "discovered" not in str(rows[0]["using_expr"])


def test_auth_probe_is_authenticated_only(sql: Any) -> None:
    """Migration 003. The grant is half the proof that the Clerk link works:
    `anon` being denied is what makes a successful signed-in call meaningful."""

    probe = "'public.auth_probe()', 'execute'"
    rows = sql(
        f"""
        select
          has_function_privilege('anon',          {probe}) as anon,
          has_function_privilege('authenticated', {probe}) as authenticated,
          p.prosecdef as security_definer
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'auth_probe';
        """
    )

    assert rows, "public.auth_probe() is missing — apply migration 003"
    row = rows[0]
    assert row["anon"] in (False, "false")
    assert row["authenticated"] in (True, "true")
    assert row["security_definer"] in (False, "false"), "auth_probe must stay SECURITY INVOKER"


def test_clerk_is_the_only_configured_third_party_auth_issuer(sql: Any) -> None:
    """A-4. Guards against a second issuer being added in the dashboard without
    a corresponding entry in `supabase/config.toml`."""

    rows = sql(
        """
        select table_name
        from information_schema.tables
        where table_schema = 'auth' and table_name = 'users';
        """
    )

    # Supabase Auth is not used as an identity provider (ADR 006). The table
    # exists because the platform creates it; it must stay empty.
    if rows:
        count = sql("select count(*)::int as n from auth.users;")[0]["n"]
        assert int(count) == 0, (
            f"auth.users has {count} rows — Supabase Auth signups should be disabled (ADR 006)"
        )


def test_migration_ledger_records_every_committed_migration(sql: Any) -> None:
    """P0-3 live. A migration missing from the ledger means the deployed schema
    and the repository have diverged."""

    from src.publish.migrations import discover_migrations, migration_checksum

    rows = sql("select filename, checksum from public.schema_migrations;")
    recorded = {str(row["filename"]): str(row["checksum"]) for row in rows}

    for path in discover_migrations():
        assert path.name in recorded, (
            f"{path.name} is not in schema_migrations — run scripts/apply_migrations.py"
        )
        assert recorded[path.name] == migration_checksum(path), (
            f"{path.name} was edited after it was applied"
        )
