-- 016_verified_portrait_urls
--
-- The public avatar is either a verified Pleni CDN mirror or NULL. Riksdagen's
-- URL remains provenance in avatar_source_url, but an unverified source must
-- never be presented to the browser as though Pleni had mirrored it.

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

  -- Clip publication still carries the official source URL. Preserve a prior
  -- verified mirror when one exists; otherwise expose NULL and let the client
  -- render its deterministic fallback until the mirror job succeeds.
  if tg_op = 'UPDATE'
     and old.avatar_sha256 is not null
     and (
       nullif(btrim(new.avatar_url), '') is null
       or new.avatar_url like 'https://data.riksdagen.se/%'
     ) then
    new.avatar_url := old.avatar_url;
    new.avatar_sha256 := old.avatar_sha256;
    new.avatar_mirrored_at := old.avatar_mirrored_at;
  elsif new.avatar_url like 'https://data.riksdagen.se/%'
        or new.avatar_sha256 is null then
    new.avatar_url := null;
    new.avatar_sha256 := null;
    new.avatar_mirrored_at := null;
  end if;

  return new;
end;
$$;

revoke all on function public.set_politician_avatar_url() from public, anon, authenticated;

-- This invokes the replacement trigger function, clearing the two known 404
-- source URLs without touching any verified content-addressed Bunny URL.
update public.politicians
set avatar_url = null
where avatar_url like 'https://data.riksdagen.se/%'
  and avatar_sha256 is null;

