create extension if not exists pgcrypto;

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  dokid text unique not null,
  title text not null,
  debate_type text,
  debate_date date not null,
  source_url text not null,
  duration_s numeric,
  master_path text,
  master_sha256 text,
  status text not null default 'discovered',
  discovered_at timestamptz default now()
);

create table if not exists public.politicians (
  id uuid primary key default gen_random_uuid(),
  intressent_id text unique,
  name text not null,
  party text,
  constituency text,
  role text,
  avatar_url text
);

create table if not exists public.speeches (
  id text primary key,
  source_id uuid references public.sources(id) on delete cascade,
  anforande_id text,
  politician_id uuid references public.politicians(id),
  speaker_name text not null,
  party text,
  anforandetyp text,
  start_s numeric not null,
  end_s numeric not null,
  official_text text,
  asr_text text,
  words jsonb,
  alignment_confidence numeric,
  status text not null default 'pending',
  needs_review boolean default false,
  unique (source_id, anforande_id)
);

create table if not exists public.clips (
  id text primary key,
  speech_id text references public.speeches(id) on delete cascade,
  rank_in_speech int not null,
  start_s numeric not null,
  end_s numeric not null,
  duration_s numeric not null,
  title text,
  hook_text text,
  transcript text,
  topic text,
  archetype text,
  final_score numeric,
  sub_scores jsonb,
  url_540x960 text not null,
  url_360x640 text,
  thumb_url text not null,
  vtt_url text,
  moderation text not null default 'auto',
  published_at timestamptz,
  unique (speech_id, rank_in_speech)
);

create table if not exists public.clip_features (
  id bigserial primary key,
  speech_id text references public.speeches(id) on delete cascade,
  selected_clip_id text references public.clips(id) on delete set null,
  start_s numeric,
  end_s numeric,
  features jsonb not null,
  archetype_scores jsonb,
  sub_scores jsonb,
  llm_scores jsonb,
  final_score numeric,
  gate_passed boolean,
  reject_reason text,
  was_selected boolean default false,
  was_explore boolean default false,
  created_at timestamptz default now(),
  unique (speech_id, start_s, end_s)
);

create table if not exists public.engagement_events (
  id bigserial primary key,
  clip_id text references public.clips(id) on delete cascade,
  session_id text,
  watch_ms int,
  completed boolean,
  replayed boolean,
  liked boolean,
  shared boolean,
  created_at timestamptz default now()
);

create table if not exists public.jobs (
  id bigserial primary key,
  kind text not null,
  entity_id text not null,
  idempotency_key text unique not null,
  state text not null default 'queued',
  attempts int default 0,
  last_error text,
  payload jsonb,
  updated_at timestamptz default now()
);

create table if not exists public.pipeline_runs (
  id bigserial primary key,
  kind text not null,
  entity_id text not null,
  idempotency_key text,
  status text not null,
  payload jsonb,
  created_at timestamptz default now()
);

create index if not exists clips_published_at_idx on public.clips (published_at desc);
create index if not exists clips_speech_id_idx on public.clips (speech_id);
create index if not exists speeches_source_id_idx on public.speeches (source_id);
create index if not exists engagement_events_clip_id_idx on public.engagement_events (clip_id);
alter table public.pipeline_runs add column if not exists idempotency_key text;
create unique index if not exists pipeline_runs_idempotency_key_idx
  on public.pipeline_runs (idempotency_key);

alter table public.sources enable row level security;
alter table public.politicians enable row level security;
alter table public.speeches enable row level security;
alter table public.clips enable row level security;
alter table public.clip_features enable row level security;
alter table public.engagement_events enable row level security;
alter table public.jobs enable row level security;
alter table public.pipeline_runs enable row level security;

drop policy if exists sources_public_read on public.sources;
create policy sources_public_read
  on public.sources for select to anon, authenticated
  using (status in ('published', 'processed', 'discovered'));

drop policy if exists politicians_public_read on public.politicians;
create policy politicians_public_read
  on public.politicians for select to anon, authenticated
  using (true);

drop policy if exists speeches_public_read on public.speeches;
create policy speeches_public_read
  on public.speeches for select to anon, authenticated
  using (status in ('published', 'processed'));

drop policy if exists clips_public_read on public.clips;
create policy clips_public_read
  on public.clips for select to anon, authenticated
  using (moderation <> 'rejected' and published_at is not null);

grant select on public.sources, public.politicians, public.speeches, public.clips
  to anon, authenticated;
grant all on public.sources, public.politicians, public.speeches, public.clips,
  public.clip_features, public.engagement_events, public.jobs, public.pipeline_runs
  to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.publish_clip_batch(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_payload jsonb := payload->'source';
  source_uuid uuid;
  clip_count int := 0;
  feature_count int := 0;
begin
  insert into public.sources (
    dokid, title, debate_type, debate_date, source_url, duration_s,
    master_path, master_sha256, status
  )
  values (
    source_payload->>'dokid',
    source_payload->>'title',
    nullif(source_payload->>'debate_type', ''),
    (source_payload->>'debate_date')::date,
    source_payload->>'source_url',
    nullif(source_payload->>'duration_s', '')::numeric,
    nullif(source_payload->>'master_path', ''),
    nullif(source_payload->>'master_sha256', ''),
    coalesce(nullif(source_payload->>'status', ''), 'published')
  )
  on conflict (dokid) do update set
    title = excluded.title,
    debate_type = excluded.debate_type,
    debate_date = excluded.debate_date,
    source_url = excluded.source_url,
    duration_s = excluded.duration_s,
    master_path = excluded.master_path,
    master_sha256 = excluded.master_sha256,
    status = excluded.status
  returning id into source_uuid;

  insert into public.politicians (intressent_id, name, party, constituency, role, avatar_url)
  select
    p.intressent_id,
    p.name,
    p.party,
    p.constituency,
    p.role,
    p.avatar_url
  from jsonb_to_recordset(coalesce(payload->'politicians', '[]'::jsonb)) as p(
    intressent_id text,
    name text,
    party text,
    constituency text,
    role text,
    avatar_url text
  )
  where p.intressent_id is not null and p.intressent_id <> ''
  on conflict (intressent_id) do update set
    name = excluded.name,
    party = excluded.party,
    constituency = excluded.constituency,
    role = excluded.role,
    avatar_url = excluded.avatar_url;

  insert into public.speeches (
    id, source_id, anforande_id, politician_id, speaker_name, party, anforandetyp,
    start_s, end_s, official_text, asr_text, words, alignment_confidence, status, needs_review
  )
  select
    s.id,
    source_uuid,
    s.anforande_id,
    pol.id,
    s.speaker_name,
    s.party,
    s.anforandetyp,
    s.start_s,
    s.end_s,
    s.official_text,
    s.asr_text,
    s.words,
    s.alignment_confidence,
    s.status,
    s.needs_review
  from jsonb_to_recordset(coalesce(payload->'speeches', '[]'::jsonb)) as s(
    id text,
    anforande_id text,
    intressent_id text,
    speaker_name text,
    party text,
    anforandetyp text,
    start_s numeric,
    end_s numeric,
    official_text text,
    asr_text text,
    words jsonb,
    alignment_confidence numeric,
    status text,
    needs_review boolean
  )
  left join public.politicians pol
    on pol.intressent_id = s.intressent_id
  on conflict (id) do update set
    source_id = excluded.source_id,
    anforande_id = excluded.anforande_id,
    politician_id = excluded.politician_id,
    speaker_name = excluded.speaker_name,
    party = excluded.party,
    anforandetyp = excluded.anforandetyp,
    start_s = excluded.start_s,
    end_s = excluded.end_s,
    official_text = excluded.official_text,
    asr_text = excluded.asr_text,
    words = excluded.words,
    alignment_confidence = excluded.alignment_confidence,
    status = excluded.status,
    needs_review = excluded.needs_review;

  insert into public.clips (
    id, speech_id, rank_in_speech, start_s, end_s, duration_s, title, hook_text,
    transcript, topic, archetype, final_score, sub_scores, url_540x960, url_360x640,
    thumb_url, vtt_url, moderation, published_at
  )
  select
    c.id,
    c.speech_id,
    c.rank_in_speech,
    c.start_s,
    c.end_s,
    c.duration_s,
    c.title,
    c.hook_text,
    c.transcript,
    c.topic,
    c.archetype,
    c.final_score,
    c.sub_scores,
    c.url_540x960,
    c.url_360x640,
    c.thumb_url,
    c.vtt_url,
    coalesce(c.moderation, 'auto'),
    c.published_at
  from jsonb_to_recordset(coalesce(payload->'clips', '[]'::jsonb)) as c(
    id text,
    speech_id text,
    rank_in_speech int,
    start_s numeric,
    end_s numeric,
    duration_s numeric,
    title text,
    hook_text text,
    transcript text,
    topic text,
    archetype text,
    final_score numeric,
    sub_scores jsonb,
    url_540x960 text,
    url_360x640 text,
    thumb_url text,
    vtt_url text,
    moderation text,
    published_at timestamptz
  )
  on conflict (id) do update set
    speech_id = excluded.speech_id,
    rank_in_speech = excluded.rank_in_speech,
    start_s = excluded.start_s,
    end_s = excluded.end_s,
    duration_s = excluded.duration_s,
    title = excluded.title,
    hook_text = excluded.hook_text,
    transcript = excluded.transcript,
    topic = excluded.topic,
    archetype = excluded.archetype,
    final_score = excluded.final_score,
    sub_scores = excluded.sub_scores,
    url_540x960 = excluded.url_540x960,
    url_360x640 = excluded.url_360x640,
    thumb_url = excluded.thumb_url,
    vtt_url = excluded.vtt_url,
    moderation = excluded.moderation,
    published_at = excluded.published_at;

  get diagnostics clip_count = row_count;

  insert into public.clip_features (
    speech_id, selected_clip_id, start_s, end_s, features, archetype_scores,
    sub_scores, llm_scores, final_score, gate_passed, reject_reason,
    was_selected, was_explore
  )
  select
    f.speech_id,
    f.selected_clip_id,
    f.start_s,
    f.end_s,
    f.features,
    f.archetype_scores,
    f.sub_scores,
    f.llm_scores,
    f.final_score,
    f.gate_passed,
    f.reject_reason,
    coalesce(f.was_selected, false),
    coalesce(f.was_explore, false)
  from jsonb_to_recordset(coalesce(payload->'clip_features', '[]'::jsonb)) as f(
    speech_id text,
    selected_clip_id text,
    start_s numeric,
    end_s numeric,
    features jsonb,
    archetype_scores jsonb,
    sub_scores jsonb,
    llm_scores jsonb,
    final_score numeric,
    gate_passed boolean,
    reject_reason text,
    was_selected boolean,
    was_explore boolean
  )
  on conflict (speech_id, start_s, end_s) do update set
    selected_clip_id = excluded.selected_clip_id,
    features = excluded.features,
    archetype_scores = excluded.archetype_scores,
    sub_scores = excluded.sub_scores,
    llm_scores = excluded.llm_scores,
    final_score = excluded.final_score,
    gate_passed = excluded.gate_passed,
    reject_reason = excluded.reject_reason,
    was_selected = excluded.was_selected,
    was_explore = excluded.was_explore;

  get diagnostics feature_count = row_count;

  insert into public.pipeline_runs (kind, entity_id, idempotency_key, status, payload)
  values (
    coalesce(payload->'pipeline_run'->>'kind', 'publish'),
    coalesce(payload->'pipeline_run'->>'entity_id', source_payload->>'dokid'),
    coalesce(
      payload->'pipeline_run'->>'idempotency_key',
      'publish:' || (source_payload->>'dokid') || ':v1'
    ),
    coalesce(payload->'pipeline_run'->>'status', 'complete'),
    payload->'pipeline_run'
  )
  on conflict (idempotency_key) do update set
    kind = excluded.kind,
    entity_id = excluded.entity_id,
    status = excluded.status,
    payload = excluded.payload,
    created_at = now();

  return jsonb_build_object(
    'source_id', source_uuid,
    'clips_upserted', clip_count,
    'features_upserted', feature_count
  );
end;
$$;

grant execute on function public.publish_clip_batch(jsonb) to service_role;
