-- 004_revoke_default_table_grants
--
-- Prerequisite P0-7 in docs/RECOMMENDATION_PREREQUISITES.md, confirmed live on
-- 2026-08-02 against project nlooigmwuqqhhnontlgp.
--
-- WHAT WAS FOUND
--
-- A Supabase project ships with
--   alter default privileges in schema public grant all on tables to anon, authenticated;
-- so every table created in `public` is automatically granted ALL privileges to
-- both browser-reachable roles. Migration 001 never revoked that.
--
-- Probed from outside with nothing but the publishable key that ships in the
-- browser bundle:
--
--   GET  /rest/v1/clip_features      -> 200 []      (authorized, RLS filtered)
--   GET  /rest/v1/jobs               -> 200 []      (authorized, RLS filtered)
--   POST /rest/v1/clips              -> 42501 "new row violates row-level
--                                       security policy for table clips"
--
-- That last message is the important one. `permission denied` would mean no
-- grant. `violates row-level security policy` means the grant IS there and the
-- statement got as far as the policy check. Compare `schema_migrations`, which
-- migration 002 revoked explicitly and which answers `permission denied`.
--
-- So nothing is exploitable today, and the only thing standing between an
-- anonymous caller and an INSERT into public.clips is RLS having no INSERT
-- policy. One permissive policy, one `alter table ... disable row level
-- security` during a debugging session, and it is a write endpoint. Defence in
-- depth means the grant should not be there either.
--
-- WHAT THIS CHANGES
--
-- Public content tables keep SELECT and lose everything else. Operational and
-- telemetry tables lose all access from both public roles. Future tables in
-- `public` no longer inherit a grant, so a new table is unreachable until
-- someone grants it deliberately.
--
-- CONSEQUENCE FOR FUTURE WORK: after `create table public.foo`, add an explicit
-- `grant select on public.foo to anon` if the browser is meant to read it.
-- Silence is now denial. That is the intent.
--
-- Additive and idempotent: safe to re-apply.

-- 1. Public political content: readable, never writable.
--
--    SELECT is granted before anything is revoked, and the write privileges are
--    named individually rather than using `revoke all`, so there is no instant
--    in which the live feed loses read access.
grant select on
  public.sources, public.politicians, public.speeches, public.clips
  to anon, authenticated;

revoke insert, update, delete, truncate, references, trigger on
  public.sources, public.politicians, public.speeches, public.clips
  from anon, authenticated;

-- 2. Operational and telemetry tables: no access from a browser at all.
--
--    `engagement_events` is the one that matters most going forward. It is
--    viewer behaviour, it is currently empty, and F2 is about to start writing
--    to it. Writes arrive through an Edge Function on the service-role
--    connection (ADR 005), never from the client.
revoke all on
  public.clip_features, public.engagement_events, public.jobs, public.pipeline_runs
  from public, anon, authenticated;

-- 3. Stop the bleeding at the source: new tables must not inherit a grant.
--
--    Applies to objects created by the role running this migration, which is
--    the role the Management API and the SQL editor use. Existing objects are
--    unaffected, which is why step 1 and 2 exist.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;

alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

-- 4. Same reasoning for functions. Postgres grants EXECUTE to PUBLIC on every
--    new function, and PostgREST publishes `public` functions as RPC. Migration
--    002 cleaned up the SECURITY DEFINER functions that existed; this makes the
--    next one deny-by-default instead of relying on somebody remembering.
--
--    Explicit grants still work and are still required — see
--    `public.auth_probe()` in migration 003.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
