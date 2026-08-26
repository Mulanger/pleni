-- Restore UI16.9 preflight to migration 027's live catalogue build.

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
    catalog := public.load_search_entity_catalog();
  else
    catalog := null;
  end if;
  return pg_catalog.jsonb_build_object(
    'rateLimit', decision,
    'catalog', catalog
  );
end;
$function$;

revoke all on function public.prepare_clip_search_request(text)
  from public, anon, authenticated;
grant execute on function public.prepare_clip_search_request(text) to service_role;

drop trigger if exists search_event_aliases_refresh_catalog
  on private.search_event_aliases;
drop trigger if exists search_event_sources_refresh_catalog
  on private.search_event_sources;
drop trigger if exists search_events_refresh_catalog on private.search_events;
drop trigger if exists search_person_aliases_refresh_catalog
  on private.search_person_aliases;

revoke all on function public.load_search_entity_catalog_cached() from service_role;
drop function if exists public.load_search_entity_catalog_cached();
drop function if exists private.refresh_search_entity_catalog_cache_trigger();
drop function if exists private.refresh_search_entity_catalog_cache();

alter table private.search_system_state
  drop column if exists entity_catalog_refreshed_at,
  drop column if exists entity_catalog;
