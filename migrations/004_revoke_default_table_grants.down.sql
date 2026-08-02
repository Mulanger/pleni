-- Reverse 004_revoke_default_table_grants.
--
-- Restores the Supabase defaults. Applying this re-opens the privilege posture
-- described in the up migration; it exists for completeness, not as an option.

alter default privileges in schema public
  grant all on tables to anon, authenticated;

alter default privileges in schema public
  grant all on sequences to anon, authenticated;

alter default privileges in schema public
  grant execute on functions to public, anon, authenticated;

grant all on
  public.sources, public.politicians, public.speeches, public.clips,
  public.clip_features, public.engagement_events, public.jobs, public.pipeline_runs
  to anon, authenticated;
