-- Restore migration 015's behavior, including its direct source fallback.

create or replace function public.set_politician_avatar_url()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  canonical_source text;
begin
  if nullif(btrim(new.intressent_id), '') is null then
    return new;
  end if;

  canonical_source := format(
    'https://data.riksdagen.se/filarkiv/bilder/ledamot/%s_192.jpg',
    new.intressent_id
  );

  if nullif(btrim(new.avatar_source_url), '') is null then
    if new.avatar_url like 'https://data.riksdagen.se/%' then
      new.avatar_source_url := new.avatar_url;
    else
      new.avatar_source_url := canonical_source;
    end if;
  end if;

  if tg_op = 'UPDATE'
     and old.avatar_sha256 is not null
     and (
       nullif(btrim(new.avatar_url), '') is null
       or new.avatar_url like 'https://data.riksdagen.se/%'
     ) then
    new.avatar_url := old.avatar_url;
    new.avatar_sha256 := old.avatar_sha256;
    new.avatar_mirrored_at := old.avatar_mirrored_at;
  elsif nullif(btrim(new.avatar_url), '') is null then
    new.avatar_url := new.avatar_source_url;
  end if;

  return new;
end;
$$;

revoke all on function public.set_politician_avatar_url() from public, anon, authenticated;

update public.politicians
set avatar_url = avatar_source_url
where nullif(btrim(avatar_url), '') is null
  and nullif(btrim(avatar_source_url), '') is not null;
