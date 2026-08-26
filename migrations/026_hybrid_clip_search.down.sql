-- Roll back UI16.4 service RPCs without changing the UI16.1–UI16.3 index.

revoke all on function public.search_clip_candidates(
  text, text, integer, uuid, text, date, date, uuid[]
) from service_role;
revoke all on function public.reserve_search_provider_tokens(integer) from service_role;
revoke all on function public.consume_search_request_limit(text) from service_role;
revoke all on function public.get_search_event_destination(uuid) from service_role;
revoke all on function public.load_search_entity_catalog() from service_role;
revoke all on function private.search_clip_result(text, text, text) from service_role;
revoke all on function private.search_excerpt(text, integer) from service_role;

drop function if exists public.search_clip_candidates(
  text, text, integer, uuid, text, date, date, uuid[]
);
drop function if exists public.reserve_search_provider_tokens(integer);
drop function if exists public.consume_search_request_limit(text);
drop function if exists public.get_search_event_destination(uuid);
drop function if exists public.load_search_entity_catalog();
drop function if exists private.search_clip_result(text, text, text);
drop function if exists private.search_excerpt(text, integer);
