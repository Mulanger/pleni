-- 002_security_hardening
--
-- Closes the P0 privilege gap described in docs/RECOMMENDATION_PREREQUISITES.md.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and PostgREST
-- exposes functions in the `public` schema as RPC endpoints. Migration 001
-- granted EXECUTE on `publish_clip_batch` to `service_role` but never revoked
-- the default, so the transactional publishing RPC was reachable with the
-- project's publishable key.
--
-- Additive and idempotent: safe to re-apply.

-- 1. Migration ledger. Recorded here rather than in 001 so an existing
--    database converges without being rebuilt.
create table if not exists public.schema_migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from public, anon, authenticated;
grant all on public.schema_migrations to service_role;

-- 2. Revoke the default PUBLIC execute grant on the publishing RPC.
revoke all on function public.publish_clip_batch(jsonb) from public;
revoke all on function public.publish_clip_batch(jsonb) from anon;
revoke all on function public.publish_clip_batch(jsonb) from authenticated;
grant execute on function public.publish_clip_batch(jsonb) to service_role;

-- 3. Pin the definer function's search_path to an empty string is not possible
--    without rewriting every unqualified identifier in the body, so pin it to
--    pg_catalog first: a caller-controlled schema can no longer shadow a
--    built-in that the function body relies on.
alter function public.publish_clip_batch(jsonb) set search_path = pg_catalog, public;

-- 4. Blanket revoke for any future SECURITY DEFINER function added to `public`
--    without its own grant. Re-run this block after adding one.
do $$
declare
  fn record;
begin
  for fn in
    select
      p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
    execute format('grant execute on function %s to service_role', fn.signature);
  end loop;
end;
$$;

-- 5. Stop exposing debates that have merely been discovered. Public readers
--    should only see sources behind published clips.
drop policy if exists sources_public_read on public.sources;
create policy sources_public_read
  on public.sources for select to anon, authenticated
  using (status in ('published', 'processed'));
