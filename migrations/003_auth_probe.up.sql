-- 003_auth_probe
--
-- Proves the Clerk -> Supabase native third-party auth link actually works.
-- Prerequisite A-3 / A-4 in docs/RECOMMENDATION_PREREQUISITES.md.
--
-- Until now the integration was configured in two dashboards but never
-- exercised: no table or function existed that only a signed-in caller could
-- reach, so a successful request proved nothing. This migration adds the
-- smallest possible thing that does.
--
-- `public.auth_probe()` is SECURITY INVOKER (the default) and reads only the
-- caller's own verified JWT claims out of the PostgREST request context. It
-- grants no access to anything and leaks nothing the caller did not already
-- hold in their own browser. It is granted to `authenticated` and explicitly
-- revoked from `public` and `anon`, which makes the grant itself the second
-- half of the proof:
--
--   anon           -> 42501 permission denied for function auth_probe
--   authenticated  -> {"sub": "user_2abc...", "role": "authenticated", ...}
--
-- A non-null `sub` is the end-to-end evidence: PostgREST verified an RS256
-- signature against the Clerk JWKS, accepted the issuer, switched to the
-- `authenticated` role because of the `role` claim Clerk's Supabase
-- integration adds, and Postgres can now read the Clerk user id in SQL.
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
    'pg_role', pg_catalog.current_user::text,
    'pg_session_user', pg_catalog.session_user::text,
    'server_time', pg_catalog.now()
  );
end;
$$;

comment on function public.auth_probe() is
  'Diagnostic for the Clerk third-party auth link (prerequisite A-3/A-4). '
  'Returns only the calling session''s own verified JWT claims. '
  'SECURITY INVOKER by design; granted to authenticated only.';

revoke all on function public.auth_probe() from public;
revoke all on function public.auth_probe() from anon;
grant execute on function public.auth_probe() to authenticated;
grant execute on function public.auth_probe() to service_role;
