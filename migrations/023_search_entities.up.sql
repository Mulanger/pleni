-- 023_search_entities
--
-- Deterministic, catalogue-backed entity aliases for topic-search
-- interpretation. All rows remain private. Source events and politician aliases
-- are derived from public catalogue facts and synchronised on ordinary writes;
-- curated rows are preserved and must explicitly be marked verified before the
-- interpreter may use them as strict filters.

do $preflight$
begin
  if to_regclass('private.clip_search_documents') is null
    or to_regclass('private.search_events') is null
    or to_regclass('private.search_event_sources') is null
    or to_regclass('private.search_event_aliases') is null
    or to_regclass('private.search_person_aliases') is null then
    raise exception 'topic-search foundation is missing; apply migration 022 first';
  end if;
end;
$preflight$;

create or replace function private.normalize_search_entity(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select nullif(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.lower(p_value),
        '[^[:alnum:]åäö]+',
        ' ',
        'g'
      )
    ),
    ''
  );
$function$;

create or replace function private.strip_search_person_title(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  with without_party as (
    select pg_catalog.btrim(
      pg_catalog.regexp_replace(
        p_value,
        '[[:space:]]+[(](S|M|SD|C|V|KD|MP|L)[)][[:space:]]*$',
        '',
        'i'
      )
    ) as value
  ),
  without_title as (
    select pg_catalog.btrim(
      pg_catalog.regexp_replace(
        value,
        '^.*(ministern|minister|statsrådet|talmannen|talman|ordföranden|ordförande|partiledaren|partiledare)[[:space:]]+',
        '',
        'i'
      )
    ) as value
    from without_party
  )
  select nullif(value, '') from without_title;
$function$;

create or replace function private.refresh_search_person_aliases(
  p_politician_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_politician_id is null then
    return;
  end if;

  delete from private.search_person_aliases alias_row
  where alias_row.politician_id = p_politician_id
    and alias_row.provenance like 'automatic:%';

  with raw_aliases(alias, provenance, priority) as (
    select p.name, 'automatic:politicians.name', 1
    from public.politicians p
    where p.id = p_politician_id

    union all

    select private.strip_search_person_title(p.name),
           'automatic:politicians.name-clean',
           2
    from public.politicians p
    where p.id = p_politician_id

    union all

    select s.speaker_name, 'automatic:speeches.speaker_name', 3
    from public.speeches s
    where s.politician_id = p_politician_id

    union all

    select private.strip_search_person_title(s.speaker_name),
           'automatic:speeches.speaker_name-clean',
           4
    from public.speeches s
    where s.politician_id = p_politician_id
  ),
  normalized as (
    select
      pg_catalog.btrim(raw.alias) as alias,
      private.normalize_search_entity(raw.alias) as normalized_alias,
      raw.provenance,
      raw.priority
    from raw_aliases raw
    where nullif(pg_catalog.btrim(raw.alias), '') is not null
      and pg_catalog.char_length(pg_catalog.btrim(raw.alias)) <= 240
  ),
  deduplicated as (
    select distinct on (candidate.normalized_alias)
      candidate.alias,
      candidate.normalized_alias,
      candidate.provenance
    from normalized candidate
    where candidate.normalized_alias is not null
    order by candidate.normalized_alias, candidate.priority, candidate.alias
  )
  insert into private.search_person_aliases (
    politician_id,
    alias,
    normalized_alias,
    provenance,
    verified
  )
  select
    p_politician_id,
    candidate.alias,
    candidate.normalized_alias,
    candidate.provenance,
    true
  from deduplicated candidate
  on conflict (politician_id, normalized_alias) do nothing;
end;
$function$;

create or replace function private.refresh_source_search_event(p_source_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_event_key text;
  source_event_id uuid;
begin
  if p_source_id is null then
    return;
  end if;

  source_event_key := 'source:' || p_source_id::text;

  if not exists (
    select 1
    from public.sources source
    join public.speeches speech on speech.source_id = source.id
    join public.clips clip on clip.speech_id = speech.id
    where source.id = p_source_id
      and clip.published_at is not null
      and clip.moderation <> 'rejected'
  ) then
    delete from private.search_events event
    where event.event_key = source_event_key
      and event.event_kind = 'source'
      and event.provenance = 'automatic:public.sources';
    return;
  end if;

  insert into private.search_events (
    event_key,
    canonical_label,
    event_kind,
    date_from,
    date_to,
    verified,
    provenance,
    updated_at
  )
  select
    source_event_key,
    coalesce(
      nullif(pg_catalog.btrim(pg_catalog.left(source.title, 240)), ''),
      source.dokid
    ),
    'source',
    source.debate_date,
    source.debate_date,
    true,
    'automatic:public.sources',
    now()
  from public.sources source
  where source.id = p_source_id
  on conflict (event_key) do update set
    canonical_label = excluded.canonical_label,
    event_kind = excluded.event_kind,
    date_from = excluded.date_from,
    date_to = excluded.date_to,
    verified = excluded.verified,
    provenance = excluded.provenance,
    updated_at = now()
  returning id into source_event_id;

  delete from private.search_event_sources event_source
  where event_source.event_id = source_event_id
    and event_source.source_id <> p_source_id;

  insert into private.search_event_sources (event_id, source_id)
  values (source_event_id, p_source_id)
  on conflict (event_id, source_id) do nothing;

  delete from private.search_event_aliases alias_row
  where alias_row.event_id = source_event_id
    and alias_row.provenance like 'automatic:%';

  with raw_aliases(alias, provenance, priority) as (
    select source.title, 'automatic:sources.title', 1
    from public.sources source
    where source.id = p_source_id

    union all

    select source.dokid, 'automatic:sources.dokid', 2
    from public.sources source
    where source.id = p_source_id
  ),
  normalized as (
    select
      pg_catalog.btrim(raw.alias) as alias,
      private.normalize_search_entity(raw.alias) as normalized_alias,
      raw.provenance,
      raw.priority
    from raw_aliases raw
    where nullif(pg_catalog.btrim(raw.alias), '') is not null
      and pg_catalog.char_length(pg_catalog.btrim(raw.alias)) <= 240
  ),
  deduplicated as (
    select distinct on (candidate.normalized_alias)
      candidate.alias,
      candidate.normalized_alias,
      candidate.provenance
    from normalized candidate
    where candidate.normalized_alias is not null
    order by candidate.normalized_alias, candidate.priority, candidate.alias
  )
  insert into private.search_event_aliases (
    event_id,
    alias,
    normalized_alias,
    provenance,
    verified
  )
  select
    source_event_id,
    candidate.alias,
    candidate.normalized_alias,
    candidate.provenance,
    true
  from deduplicated candidate
  on conflict (event_id, normalized_alias) do nothing;
end;
$function$;

create or replace function private.sync_politician_search_aliases_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.refresh_search_person_aliases(new.id);
  return new;
end;
$function$;

create or replace function private.sync_speech_search_entities_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    perform private.refresh_search_person_aliases(old.politician_id);
    perform private.refresh_source_search_event(old.source_id);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.politician_id is distinct from new.politician_id then
      perform private.refresh_search_person_aliases(old.politician_id);
    end if;
    if old.source_id is distinct from new.source_id then
      perform private.refresh_source_search_event(old.source_id);
    end if;
  end if;

  perform private.refresh_search_person_aliases(new.politician_id);
  perform private.refresh_source_search_event(new.source_id);
  return new;
end;
$function$;

create or replace function private.sync_clip_search_event_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  old_source_id uuid;
  new_source_id uuid;
begin
  if tg_op <> 'INSERT' then
    select speech.source_id into old_source_id
    from public.speeches speech
    where speech.id = old.speech_id;
  end if;

  if tg_op <> 'DELETE' then
    select speech.source_id into new_source_id
    from public.speeches speech
    where speech.id = new.speech_id;
  end if;

  perform private.refresh_source_search_event(old_source_id);
  if new_source_id is distinct from old_source_id then
    perform private.refresh_source_search_event(new_source_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

create or replace function private.sync_source_search_event_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    perform private.refresh_source_search_event(old.id);
    return old;
  end if;

  perform private.refresh_source_search_event(new.id);
  return new;
end;
$function$;

revoke all on function private.normalize_search_entity(text)
  from public, anon, authenticated;
revoke all on function private.strip_search_person_title(text)
  from public, anon, authenticated;
revoke all on function private.refresh_search_person_aliases(uuid)
  from public, anon, authenticated;
revoke all on function private.refresh_source_search_event(uuid)
  from public, anon, authenticated;
revoke all on function private.sync_politician_search_aliases_trigger()
  from public, anon, authenticated;
revoke all on function private.sync_speech_search_entities_trigger()
  from public, anon, authenticated;
revoke all on function private.sync_clip_search_event_trigger()
  from public, anon, authenticated;
revoke all on function private.sync_source_search_event_trigger()
  from public, anon, authenticated;

grant execute on function private.normalize_search_entity(text) to service_role;
grant execute on function private.strip_search_person_title(text) to service_role;
grant execute on function private.refresh_search_person_aliases(uuid) to service_role;
grant execute on function private.refresh_source_search_event(uuid) to service_role;
grant execute on function private.sync_politician_search_aliases_trigger() to service_role;
grant execute on function private.sync_speech_search_entities_trigger() to service_role;
grant execute on function private.sync_clip_search_event_trigger() to service_role;
grant execute on function private.sync_source_search_event_trigger() to service_role;

drop trigger if exists politicians_sync_search_aliases on public.politicians;
create trigger politicians_sync_search_aliases
after insert or update of name
on public.politicians
for each row execute function private.sync_politician_search_aliases_trigger();

drop trigger if exists speeches_sync_search_entities on public.speeches;
create trigger speeches_sync_search_entities
after insert or delete or update of politician_id, speaker_name, source_id
on public.speeches
for each row execute function private.sync_speech_search_entities_trigger();

drop trigger if exists clips_sync_search_event on public.clips;
create trigger clips_sync_search_event
after insert or delete or update of speech_id, moderation, published_at
on public.clips
for each row execute function private.sync_clip_search_event_trigger();

drop trigger if exists sources_sync_search_event on public.sources;
create trigger sources_sync_search_event
after insert or delete or update of dokid, title, debate_type, debate_date
on public.sources
for each row execute function private.sync_source_search_event_trigger();

select private.refresh_search_person_aliases(politician.id)
from public.politicians politician;

select private.refresh_source_search_event(source.id)
from public.sources source;

comment on function private.normalize_search_entity(text) is
  'Swedish-preserving exact alias normalization; unaccented lookup is an interpreter concern.';
comment on function private.refresh_search_person_aliases(uuid) is
  'Synchronises verified current and historical official person aliases without overwriting manual rows.';
comment on function private.refresh_source_search_event(uuid) is
  'Synchronises one verified source-backed event for each source with an eligible published clip.';
