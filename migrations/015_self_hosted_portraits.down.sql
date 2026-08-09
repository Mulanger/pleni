drop trigger if exists politicians_default_avatar_url on public.politicians;

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

alter table public.politicians
  drop constraint if exists politicians_avatar_sha256_format;
alter table public.politicians
  drop column if exists avatar_mirrored_at,
  drop column if exists avatar_sha256,
  drop column if exists avatar_source_url;

create trigger politicians_default_avatar_url
before insert or update of intressent_id, avatar_url on public.politicians
for each row execute function public.set_politician_avatar_url();
