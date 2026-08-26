-- 022_search_foundation
--
-- Private, derived keyword-search storage for published clips. This migration
-- does not call OpenAI, install semantic-search extensions, expose browser
-- tables, or change C11. Public catalogue writes synchronously maintain a
-- Swedish full-text document; later semantic indexing remains asynchronous.

do $preflight$
begin
  if to_regnamespace('private') is null then
    raise exception 'private schema is missing; apply migration 018 first';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_ts_config cfg
    join pg_catalog.pg_namespace n on n.oid = cfg.cfgnamespace
    where n.nspname = 'pg_catalog'
      and cfg.cfgname = 'swedish'
  ) then
    raise exception 'pg_catalog.swedish text-search configuration is unavailable';
  end if;
end;
$preflight$;

create table if not exists private.clip_search_documents (
  clip_id text primary key references public.clips(id) on delete cascade,
  speech_id text not null references public.speeches(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  politician_id uuid references public.politicians(id) on delete set null,
  speaker_name_at_speech text not null,
  party_at_speech text,
  anforandetyp text,
  debate_date date not null,
  source_title text not null,
  source_url text not null,
  title text not null,
  transcript text not null,
  source_hash text not null,
  search_vector tsvector generated always as (
    pg_catalog.setweight(
      pg_catalog.to_tsvector('pg_catalog.swedish'::regconfig, title),
      'A'
    ) ||
    pg_catalog.setweight(
      pg_catalog.to_tsvector('pg_catalog.swedish'::regconfig, transcript),
      'B'
    )
  ) stored,
  keyword_indexed_at timestamptz not null default now(),
  semantic_state text not null default 'pending',
  requested_index_version text,
  completed_index_version text,
  semantic_updated_at timestamptz,
  semantic_last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clip_search_documents_source_hash
    check (source_hash ~ '^[0-9a-f]{64}$'),
  constraint clip_search_documents_party
    check (party_at_speech is null or party_at_speech in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')),
  constraint clip_search_documents_semantic_state
    check (semantic_state in ('pending', 'processing', 'current', 'failed', 'disabled')),
  constraint clip_search_documents_version_pair
    check (completed_index_version is null or semantic_state = 'current')
);

create index if not exists clip_search_documents_vector_idx
  on private.clip_search_documents using gin (search_vector);
create index if not exists clip_search_documents_politician_date_idx
  on private.clip_search_documents (politician_id, debate_date desc, clip_id);
create index if not exists clip_search_documents_party_date_idx
  on private.clip_search_documents (party_at_speech, debate_date desc, clip_id);
create index if not exists clip_search_documents_source_date_idx
  on private.clip_search_documents (source_id, debate_date desc, clip_id);
create index if not exists clip_search_documents_date_idx
  on private.clip_search_documents (debate_date desc, clip_id);
create index if not exists clip_search_documents_semantic_state_idx
  on private.clip_search_documents (semantic_state, updated_at, clip_id)
  where semantic_state <> 'current';

create table if not exists private.search_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  canonical_label text not null,
  event_kind text not null,
  date_from date,
  date_to date,
  verified boolean not null default false,
  provenance text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint search_events_key_length check (char_length(event_key) between 3 and 200),
  constraint search_events_label_length check (char_length(canonical_label) between 1 and 240),
  constraint search_events_kind check (event_kind in ('source', 'curated')),
  constraint search_events_date_order
    check (date_from is null or date_to is null or date_from <= date_to),
  constraint search_events_verified_provenance
    check (not verified or char_length(provenance) > 0)
);

create table if not exists private.search_event_sources (
  event_id uuid not null references private.search_events(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, source_id)
);

create index if not exists search_event_sources_source_idx
  on private.search_event_sources (source_id, event_id);

create table if not exists private.search_event_aliases (
  id bigint generated always as identity primary key,
  event_id uuid not null references private.search_events(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  provenance text not null,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  constraint search_event_aliases_alias_length check (char_length(alias) between 1 and 240),
  constraint search_event_aliases_normalized_length
    check (char_length(normalized_alias) between 1 and 240),
  unique (event_id, normalized_alias)
);

create index if not exists search_event_aliases_lookup_idx
  on private.search_event_aliases (normalized_alias, event_id);

create table if not exists private.search_person_aliases (
  id bigint generated always as identity primary key,
  politician_id uuid not null references public.politicians(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  provenance text not null,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  constraint search_person_aliases_alias_length check (char_length(alias) between 1 and 240),
  constraint search_person_aliases_normalized_length
    check (char_length(normalized_alias) between 1 and 240),
  unique (politician_id, normalized_alias)
);

create index if not exists search_person_aliases_lookup_idx
  on private.search_person_aliases (normalized_alias, politician_id);

create table if not exists private.search_rate_limit_buckets (
  scope text not null,
  key_hash text not null,
  metric text not null,
  bucket_kind text not null,
  bucket_start timestamptz not null,
  counter bigint not null default 0,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (scope, key_hash, metric, bucket_kind, bucket_start),
  constraint search_rate_limit_scope check (scope in ('client', 'global')),
  constraint search_rate_limit_key check (
    (scope = 'client' and key_hash ~ '^[0-9a-f]{64}$')
    or (scope = 'global' and key_hash = 'global')
  ),
  constraint search_rate_limit_metric check (metric in ('requests', 'provider_tokens')),
  constraint search_rate_limit_bucket_kind check (bucket_kind in ('minute', 'day')),
  constraint search_rate_limit_counter check (counter >= 0),
  constraint search_rate_limit_expiry check (expires_at > bucket_start)
);

create index if not exists search_rate_limit_expiry_idx
  on private.search_rate_limit_buckets (expires_at);

create table if not exists private.search_system_state (
  singleton boolean primary key default true,
  keyword_version text not null,
  semantic_index_version text,
  provider_enabled boolean not null default false,
  provider_kill_switch boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint search_system_state_singleton check (singleton),
  constraint search_system_state_keyword_version
    check (char_length(keyword_version) between 3 and 120),
  constraint search_system_state_provider_gate
    check (not provider_enabled or not provider_kill_switch)
);

insert into private.search_system_state (
  singleton,
  keyword_version,
  semantic_index_version,
  provider_enabled,
  provider_kill_switch
)
values (true, 'pg_catalog.swedish:v1', null, false, true)
on conflict (singleton) do nothing;

alter table private.clip_search_documents enable row level security;
alter table private.search_events enable row level security;
alter table private.search_event_sources enable row level security;
alter table private.search_event_aliases enable row level security;
alter table private.search_person_aliases enable row level security;
alter table private.search_rate_limit_buckets enable row level security;
alter table private.search_system_state enable row level security;

revoke all on private.clip_search_documents from public, anon, authenticated;
revoke all on private.search_events from public, anon, authenticated;
revoke all on private.search_event_sources from public, anon, authenticated;
revoke all on private.search_event_aliases from public, anon, authenticated;
revoke all on private.search_person_aliases from public, anon, authenticated;
revoke all on private.search_rate_limit_buckets from public, anon, authenticated;
revoke all on private.search_system_state from public, anon, authenticated;

grant all on private.clip_search_documents to service_role;
grant all on private.search_events to service_role;
grant all on private.search_event_sources to service_role;
grant all on private.search_event_aliases to service_role;
grant all on private.search_person_aliases to service_role;
grant all on private.search_rate_limit_buckets to service_role;
grant all on private.search_system_state to service_role;

revoke all on sequence private.search_event_aliases_id_seq
  from public, anon, authenticated;
revoke all on sequence private.search_person_aliases_id_seq
  from public, anon, authenticated;
grant usage, select on sequence private.search_event_aliases_id_seq to service_role;
grant usage, select on sequence private.search_person_aliases_id_seq to service_role;

create or replace function private.clip_search_document_input(p_clip_id text default null)
returns table (
  clip_id text,
  speech_id text,
  source_id uuid,
  politician_id uuid,
  speaker_name_at_speech text,
  party_at_speech text,
  anforandetyp text,
  debate_date date,
  source_title text,
  source_url text,
  title text,
  transcript text,
  source_hash text
)
language sql
stable
set search_path = ''
as $function$
  select
    c.id,
    s.id,
    src.id,
    s.politician_id,
    s.speaker_name,
    case
      when pg_catalog.btrim(s.party) in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')
        then pg_catalog.btrim(s.party)
      else null
    end,
    nullif(pg_catalog.btrim(s.anforandetyp), ''),
    src.debate_date,
    src.title,
    src.source_url,
    coalesce(c.title, ''),
    coalesce(c.transcript, ''),
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          'clip-search-document-v1' || pg_catalog.chr(31) ||
          coalesce(c.title, '') || pg_catalog.chr(31) ||
          coalesce(c.transcript, ''),
          'UTF8'
        )
      ),
      'hex'
    )
  from public.clips c
  join public.speeches s on s.id = c.speech_id
  join public.sources src on src.id = s.source_id
  where (p_clip_id is null or c.id = p_clip_id)
    and c.published_at is not null
    and c.moderation <> 'rejected';
$function$;

create or replace function private.refresh_clip_search_document(p_clip_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_clip_id is null then
    return;
  end if;

  if exists (
    select 1 from private.clip_search_document_input(p_clip_id)
  ) then
    insert into private.clip_search_documents (
      clip_id,
      speech_id,
      source_id,
      politician_id,
      speaker_name_at_speech,
      party_at_speech,
      anforandetyp,
      debate_date,
      source_title,
      source_url,
      title,
      transcript,
      source_hash,
      keyword_indexed_at,
      updated_at
    )
    select
      input.clip_id,
      input.speech_id,
      input.source_id,
      input.politician_id,
      input.speaker_name_at_speech,
      input.party_at_speech,
      input.anforandetyp,
      input.debate_date,
      input.source_title,
      input.source_url,
      input.title,
      input.transcript,
      input.source_hash,
      now(),
      now()
    from private.clip_search_document_input(p_clip_id) input
    on conflict (clip_id) do update set
      speech_id = excluded.speech_id,
      source_id = excluded.source_id,
      politician_id = excluded.politician_id,
      speaker_name_at_speech = excluded.speaker_name_at_speech,
      party_at_speech = excluded.party_at_speech,
      anforandetyp = excluded.anforandetyp,
      debate_date = excluded.debate_date,
      source_title = excluded.source_title,
      source_url = excluded.source_url,
      title = excluded.title,
      transcript = excluded.transcript,
      semantic_state = case
        when private.clip_search_documents.source_hash is distinct from excluded.source_hash
          then 'pending'
        else private.clip_search_documents.semantic_state
      end,
      completed_index_version = case
        when private.clip_search_documents.source_hash is distinct from excluded.source_hash
          then null
        else private.clip_search_documents.completed_index_version
      end,
      semantic_last_error = case
        when private.clip_search_documents.source_hash is distinct from excluded.source_hash
          then null
        else private.clip_search_documents.semantic_last_error
      end,
      semantic_updated_at = case
        when private.clip_search_documents.source_hash is distinct from excluded.source_hash
          then now()
        else private.clip_search_documents.semantic_updated_at
      end,
      source_hash = excluded.source_hash,
      keyword_indexed_at = now(),
      updated_at = now();
  else
    delete from private.clip_search_documents where clip_id = p_clip_id;
  end if;
end;
$function$;

create or replace function private.sync_clip_search_document_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    delete from private.clip_search_documents where clip_id = old.id;
    return old;
  end if;

  perform private.refresh_clip_search_document(new.id);
  return new;
end;
$function$;

create or replace function private.sync_speech_search_documents_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected_clip_id text;
begin
  for affected_clip_id in
    select c.id from public.clips c where c.speech_id = new.id
  loop
    perform private.refresh_clip_search_document(affected_clip_id);
  end loop;
  return new;
end;
$function$;

create or replace function private.sync_source_search_documents_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected_clip_id text;
begin
  for affected_clip_id in
    select c.id
    from public.clips c
    join public.speeches s on s.id = c.speech_id
    where s.source_id = new.id
  loop
    perform private.refresh_clip_search_document(affected_clip_id);
  end loop;
  return new;
end;
$function$;

revoke all on function private.clip_search_document_input(text)
  from public, anon, authenticated;
revoke all on function private.refresh_clip_search_document(text)
  from public, anon, authenticated;
revoke all on function private.sync_clip_search_document_trigger()
  from public, anon, authenticated;
revoke all on function private.sync_speech_search_documents_trigger()
  from public, anon, authenticated;
revoke all on function private.sync_source_search_documents_trigger()
  from public, anon, authenticated;

grant execute on function private.clip_search_document_input(text) to service_role;
grant execute on function private.refresh_clip_search_document(text) to service_role;
grant execute on function private.sync_clip_search_document_trigger() to service_role;
grant execute on function private.sync_speech_search_documents_trigger() to service_role;
grant execute on function private.sync_source_search_documents_trigger() to service_role;

drop trigger if exists clips_sync_search_document on public.clips;
create trigger clips_sync_search_document
after insert or delete or update of
  speech_id,
  title,
  transcript,
  moderation,
  published_at
on public.clips
for each row execute function private.sync_clip_search_document_trigger();

drop trigger if exists speeches_sync_search_documents on public.speeches;
create trigger speeches_sync_search_documents
after update of
  source_id,
  politician_id,
  speaker_name,
  party,
  anforandetyp
on public.speeches
for each row execute function private.sync_speech_search_documents_trigger();

drop trigger if exists sources_sync_search_documents on public.sources;
create trigger sources_sync_search_documents
after update of
  title,
  debate_type,
  debate_date,
  source_url
on public.sources
for each row execute function private.sync_source_search_documents_trigger();

insert into private.clip_search_documents (
  clip_id,
  speech_id,
  source_id,
  politician_id,
  speaker_name_at_speech,
  party_at_speech,
  anforandetyp,
  debate_date,
  source_title,
  source_url,
  title,
  transcript,
  source_hash,
  keyword_indexed_at,
  updated_at
)
select
  input.clip_id,
  input.speech_id,
  input.source_id,
  input.politician_id,
  input.speaker_name_at_speech,
  input.party_at_speech,
  input.anforandetyp,
  input.debate_date,
  input.source_title,
  input.source_url,
  input.title,
  input.transcript,
  input.source_hash,
  now(),
  now()
from private.clip_search_document_input(null) input
on conflict (clip_id) do update set
  speech_id = excluded.speech_id,
  source_id = excluded.source_id,
  politician_id = excluded.politician_id,
  speaker_name_at_speech = excluded.speaker_name_at_speech,
  party_at_speech = excluded.party_at_speech,
  anforandetyp = excluded.anforandetyp,
  debate_date = excluded.debate_date,
  source_title = excluded.source_title,
  source_url = excluded.source_url,
  title = excluded.title,
  transcript = excluded.transcript,
  semantic_state = case
    when private.clip_search_documents.source_hash is distinct from excluded.source_hash
      then 'pending'
    else private.clip_search_documents.semantic_state
  end,
  completed_index_version = case
    when private.clip_search_documents.source_hash is distinct from excluded.source_hash
      then null
    else private.clip_search_documents.completed_index_version
  end,
  semantic_last_error = case
    when private.clip_search_documents.source_hash is distinct from excluded.source_hash
      then null
    else private.clip_search_documents.semantic_last_error
  end,
  semantic_updated_at = case
    when private.clip_search_documents.source_hash is distinct from excluded.source_hash
      then now()
    else private.clip_search_documents.semantic_updated_at
  end,
  source_hash = excluded.source_hash,
  keyword_indexed_at = now(),
  updated_at = now();

delete from private.clip_search_documents document
where not exists (
  select 1 from private.clip_search_document_input(document.clip_id)
);

create or replace function public.search_clip_keywords(
  p_query text,
  p_limit integer default 120,
  p_politician_id uuid default null,
  p_party text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_source_ids uuid[] default null
)
returns table (
  clip_id text,
  keyword_rank real
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  normalized_query text;
  parsed_query tsquery;
  effective_limit integer;
begin
  normalized_query := pg_catalog.btrim(p_query);
  if normalized_query is null
    or pg_catalog.char_length(normalized_query) < 2
    or pg_catalog.char_length(normalized_query) > 120 then
    raise exception 'query_must_be_2_to_120_characters' using errcode = '22023';
  end if;

  if p_party is not null
    and p_party not in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L', 'NONE') then
    raise exception 'invalid_party' using errcode = '22023';
  end if;

  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;

  effective_limit := greatest(1, least(coalesce(p_limit, 120), 120));
  parsed_query := pg_catalog.websearch_to_tsquery(
    'pg_catalog.swedish'::regconfig,
    normalized_query
  );

  if pg_catalog.numnode(parsed_query) = 0 then
    return;
  end if;

  return query
  select
    document.clip_id,
    pg_catalog.ts_rank_cd(document.search_vector, parsed_query, 32)::real as keyword_rank
  from private.clip_search_documents document
  join public.clips clip on clip.id = document.clip_id
  where document.search_vector @@ parsed_query
    and clip.published_at is not null
    and clip.moderation <> 'rejected'
    and nullif(pg_catalog.btrim(clip.url_540x960), '') is not null
    and (p_politician_id is null or document.politician_id = p_politician_id)
    and (
      p_party is null
      or coalesce(document.party_at_speech, 'NONE') = p_party
    )
    and (p_date_from is null or document.debate_date >= p_date_from)
    and (p_date_to is null or document.debate_date <= p_date_to)
    and (p_source_ids is null or document.source_id = any(p_source_ids))
  order by keyword_rank desc, document.debate_date desc, document.clip_id asc
  limit effective_limit;
end;
$function$;

revoke all on function public.search_clip_keywords(
  text, integer, uuid, text, date, date, uuid[]
) from public, anon, authenticated;
grant execute on function public.search_clip_keywords(
  text, integer, uuid, text, date, date, uuid[]
) to service_role;

comment on table private.clip_search_documents is
  'Derived keyword-search projection of eligible published clips; never browser-readable.';
comment on function public.search_clip_keywords(text, integer, uuid, text, date, date, uuid[]) is
  'Service-only Swedish keyword candidate retrieval. Query text is transient and never stored.';
