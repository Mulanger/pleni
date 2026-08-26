-- Roll back OPT2 by removing only its additive v3 RPC. Migrations 026 and 027
-- remain intact, so redeploying the previous Edge Function commit restores v2
-- retrieval immediately without reconstructing historical SQL.

revoke all on function public.search_clip_candidates_v3(
  text, text, integer, uuid, text, date, date, uuid[]
) from service_role;

drop function if exists public.search_clip_candidates_v3(
  text, text, integer, uuid, text, date, date, uuid[]
);
