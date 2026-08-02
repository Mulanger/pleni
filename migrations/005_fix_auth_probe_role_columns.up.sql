-- 005_fix_auth_probe_role_columns
--
-- Fixes a bug in migration 003.
--
-- `public.auth_probe()` built its result with `pg_catalog.current_user::text`
-- and `pg_catalog.session_user::text`. Those look like schema-qualified
-- function calls and are not: `current_user` and `session_user` are reserved
-- SQL keywords, so Postgres parsed `pg_catalog` as a table reference and the
-- function failed at runtime with
--
--   42P01  missing FROM-clause entry for table "pg_catalog"
--
-- PostgREST maps 42P01 (undefined_table) to HTTP 404, which made the failure
-- look exactly like "the function does not exist" — the one diagnosis that was
-- wrong. Worth remembering the next time a PostgREST 404 does not add up: a 404
-- can come from inside a function body, not just from routing.
--
-- 003 is already applied and recorded in `public.schema_migrations`, so it is
-- fixed forward rather than edited. Editing it would change its checksum and
-- `apply_pending_migrations()` would refuse to run, which is the intended
-- behaviour of the ledger.
--
-- Both keywords are safe unqualified: being reserved words, no schema on the
-- search_path can shadow them, so `search_path = pg_catalog, public` still
-- holds. Everything else about the function is unchanged.
--
-- Additive and idempotent: safe to re-apply.

create or replace function public.auth_probe()
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  raw_claims text := current_setting('request.jwt.claims', true);
  claims jsonb := coalesce(nullif(raw_claims, '')::jsonb, '{}'::jsonb);
  auth_jwt_sub text;
  auth_uid_text text;
begin
  -- A-7: private tables will key on `clerk_user_id text` and compare
  -- `(select auth.jwt()->>'sub')`. Confirm that helper resolves the same
  -- subject as the raw request setting, and that `auth.uid()` does NOT --
  -- Clerk subjects are strings like `user_2abc`, not UUIDs, so any code that
  -- reaches for auth.uid() is a bug waiting to happen.
  begin
    auth_jwt_sub := auth.jwt() ->> 'sub';
  exception
    when others then
      auth_jwt_sub := null;
  end;

  begin
    auth_uid_text := auth.uid()::text;
  exception
    when others then
      auth_uid_text := null;
  end;

  return jsonb_build_object(
    'sub', claims ->> 'sub',
    'role', claims ->> 'role',
    'iss', claims ->> 'iss',
    'azp', claims ->> 'azp',
    'aud', claims -> 'aud',
    'exp', claims ->> 'exp',
    'iat', claims ->> 'iat',
    'claim_keys', (
      select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
      from jsonb_object_keys(claims) as key
    ),
    'auth_jwt_sub', auth_jwt_sub,
    'auth_uid', auth_uid_text,
    'pg_role', current_user::text,
    'pg_session_user', session_user::text,
    'server_time', pg_catalog.now()
  );
end;
$$;

comment on function public.auth_probe() is
  'Diagnostic for the Clerk third-party auth link (prerequisite A-3/A-4). '
  'Returns only the calling session''s own verified JWT claims. '
  'SECURITY INVOKER by design; granted to authenticated only.';

-- CREATE OR REPLACE preserves the existing ACL, but re-assert it so a fresh
-- database that applies 005 without 003 still lands in the right place.
revoke all on function public.auth_probe() from public;
revoke all on function public.auth_probe() from anon;
grant execute on function public.auth_probe() to authenticated;
grant execute on function public.auth_probe() to service_role;
