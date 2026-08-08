alter table public.politicians
  add column if not exists riksdagen_data jsonb not null default '{}'::jsonb,
  add column if not exists profile_synced_at timestamptz;

comment on column public.politicians.riksdagen_data is
  'Complete person record returned by Riksdagen personlista for future profile features.';
comment on column public.politicians.profile_synced_at is
  'When riksdagen_data and its derived public profile fields were last refreshed.';

create or replace function public.set_politician_avatar_url()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if nullif(btrim(new.intressent_id), '') is not null
     and nullif(btrim(new.avatar_url), '') is null then
    new.avatar_url := format(
      'https://data.riksdagen.se/filarkiv/bilder/ledamot/%s_192.jpg',
      new.intressent_id
    );
  end if;
  return new;
end;
$$;

revoke all on function public.set_politician_avatar_url() from public, anon, authenticated;

drop trigger if exists politicians_default_avatar_url on public.politicians;
create trigger politicians_default_avatar_url
before insert or update of intressent_id, avatar_url on public.politicians
for each row execute function public.set_politician_avatar_url();

update public.politicians
set avatar_url = format(
  'https://data.riksdagen.se/filarkiv/bilder/ledamot/%s_192.jpg',
  intressent_id
)
where nullif(btrim(intressent_id), '') is not null
  and nullif(btrim(avatar_url), '') is null;
