-- Reverse of 002_security_hardening.
--
-- Note: this restores the *permissive* pre-002 state, including the default
-- PUBLIC execute grant on publish_clip_batch. Only run it to reproduce the
-- original vulnerability in a test database — never against production.

drop policy if exists sources_public_read on public.sources;
create policy sources_public_read
  on public.sources for select to anon, authenticated
  using (status in ('published', 'processed', 'discovered'));

alter function public.publish_clip_batch(jsonb) set search_path = public;

grant execute on function public.publish_clip_batch(jsonb) to public;

drop table if exists public.schema_migrations;
