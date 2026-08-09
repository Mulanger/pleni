-- 015_self_hosted_portraits
--
-- Keep Riksdagen's official portrait location as provenance while serving a
-- byte-for-byte mirror from Pleni's verified Bunny CDN.

alter table public.politicians
  add column if not exists avatar_source_url text,
  add column if not exists avatar_sha256 text,
  add column if not exists avatar_mirrored_at timestamptz;

comment on column public.politicians.avatar_source_url is
  'Official Riksdagen portrait URL used as the source for the Pleni CDN mirror.';
comment on column public.politicians.avatar_sha256 is
  'Lowercase SHA-256 of the exact source portrait bytes currently mirrored.';
comment on column public.politicians.avatar_mirrored_at is
  'Last time the portrait was successfully verified in Pleni Bunny Storage/CDN.';

alter table public.politicians
  drop constraint if exists politicians_avatar_sha256_format;
alter table public.politicians
  add constraint politicians_avatar_sha256_format
  check (avatar_sha256 is null or avatar_sha256 ~ '^[0-9a-f]{64}$');

update public.politicians
set avatar_source_url = case
  when avatar_url like 'https://data.riksdagen.se/%' then avatar_url
  else format(
    'https://data.riksdagen.se/filarkiv/bilder/ledamot/%s_192.jpg',
    intressent_id
  )
end
where nullif(btrim(intressent_id), '') is not null
  and nullif(btrim(avatar_source_url), '') is null;

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

  -- The clip-publish RPC still carries Riksdagen's source URL. Once a row has
  -- a verified mirror, later clip publication must not regress it back to that
  -- external dependency. Explicit CDN replacements still pass through.
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

drop trigger if exists politicians_default_avatar_url on public.politicians;
create trigger politicians_default_avatar_url
before insert or update of intressent_id, avatar_url, avatar_source_url,
  avatar_sha256, avatar_mirrored_at on public.politicians
for each row execute function public.set_politician_avatar_url();
