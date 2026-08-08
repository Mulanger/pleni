drop trigger if exists politicians_default_avatar_url on public.politicians;
drop function if exists public.set_politician_avatar_url();

alter table public.politicians
  drop column if exists profile_synced_at,
  drop column if exists riksdagen_data;
