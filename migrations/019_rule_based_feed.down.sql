revoke all on function public.delete_recommendation_subject(text) from service_role;
revoke all on function public.record_recommendation_slate(text, uuid, text, jsonb)
  from service_role;
revoke all on function public.get_recommendation_context(text) from service_role;

drop function if exists public.delete_recommendation_subject(text);
drop function if exists public.record_recommendation_slate(text, uuid, text, jsonb);
drop function if exists public.get_recommendation_context(text);

drop table if exists private.feed_items;
drop table if exists private.feed_requests;

revoke all on public.feed_clip_catalogue from anon, authenticated, service_role;
drop view if exists public.feed_clip_catalogue;
