-- Roll back UI16.9 by removing only its additive v2/preflight RPCs. Migration
-- 026 remains intact for an immediate Edge Function rollback.

revoke all on function public.search_clip_candidates_v2(
  text, text, integer, uuid, text, date, date, uuid[]
) from service_role;
revoke all on function public.prepare_clip_search_request(text) from service_role;

drop function if exists public.search_clip_candidates_v2(
  text, text, integer, uuid, text, date, date, uuid[]
);
drop function if exists public.prepare_clip_search_request(text);
