-- 028_search_catalog_cache
--
-- Materialize the query-independent interpreter catalogue. Building its nested
-- 214 KiB JSON aggregate on every new Edge isolate produced multi-second
-- preflight outliers; entity mutations are rare and already transactional, so
-- statement triggers refresh one private copy at the source of truth.

do $preflight$
begin
  if to_regclass('private.search_system_state') is null
    or to_regprocedure('public.prepare_clip_search_request(text)') is null
    or to_regprocedure('public.load_search_entity_catalog()') is null then
    raise exception 'migration 027 search preflight is missing';
  end if;
end;
$preflight$;

alter table private.search_system_state
  add column if not exists entity_catalog jsonb,
  add column if not exists entity_catalog_refreshed_at timestamptz;

create or replace function private.refresh_search_entity_catalog_cache()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  next_catalog jsonb;
begin
  next_catalog := public.load_search_entity_catalog();
  update private.search_system_state
  set entity_catalog = next_catalog,
      entity_catalog_refreshed_at = now()
  where singleton;
  if not found then
    raise exception 'search_system_state_missing';
  end if;
end;
$function$;

create or replace function private.refresh_search_entity_catalog_cache_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.refresh_search_entity_catalog_cache();
  return null;
end;
$function$;

create or replace function public.load_search_entity_catalog_cached()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  cached jsonb;
begin
  select state.entity_catalog into cached
  from private.search_system_state state
  where state.singleton;
  if cached is null then
    raise exception 'search_entity_catalog_cache_missing';
  end if;
  return cached;
end;
$function$;

drop trigger if exists search_person_aliases_refresh_catalog
  on private.search_person_aliases;
create trigger search_person_aliases_refresh_catalog
after insert or update or delete on private.search_person_aliases
for each statement execute function private.refresh_search_entity_catalog_cache_trigger();

drop trigger if exists search_events_refresh_catalog on private.search_events;
create trigger search_events_refresh_catalog
after insert or update or delete on private.search_events
for each statement execute function private.refresh_search_entity_catalog_cache_trigger();

drop trigger if exists search_event_sources_refresh_catalog
  on private.search_event_sources;
create trigger search_event_sources_refresh_catalog
after insert or update or delete on private.search_event_sources
for each statement execute function private.refresh_search_entity_catalog_cache_trigger();

drop trigger if exists search_event_aliases_refresh_catalog
  on private.search_event_aliases;
create trigger search_event_aliases_refresh_catalog
after insert or update or delete on private.search_event_aliases
for each statement execute function private.refresh_search_entity_catalog_cache_trigger();

select private.refresh_search_entity_catalog_cache();

create or replace function public.prepare_clip_search_request(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  decision jsonb;
  catalog jsonb;
begin
  decision := public.consume_search_request_limit(p_key_hash);
  if coalesce((decision ->> 'allowed')::boolean, false) then
    catalog := public.load_search_entity_catalog_cached();
  else
    catalog := null;
  end if;
  return pg_catalog.jsonb_build_object(
    'rateLimit', decision,
    'catalog', catalog
  );
end;
$function$;

revoke all on function private.refresh_search_entity_catalog_cache()
  from public, anon, authenticated;
revoke all on function private.refresh_search_entity_catalog_cache_trigger()
  from public, anon, authenticated;
revoke all on function public.load_search_entity_catalog_cached()
  from public, anon, authenticated;
revoke all on function public.prepare_clip_search_request(text)
  from public, anon, authenticated;
grant execute on function public.load_search_entity_catalog_cached() to service_role;
grant execute on function public.prepare_clip_search_request(text) to service_role;

comment on function public.load_search_entity_catalog_cached()
  is 'UI16.9 private materialized interpreter catalogue; refreshed by entity mutation triggers';
