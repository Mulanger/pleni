-- 019_rule_based_feed
--
-- F2a/F3a: a deterministic explicit-interest slate with an idempotent served
-- denominator. This migration deliberately creates no playback-event table and
-- no inferred viewer state.

create or replace view public.feed_clip_catalogue
with (security_invoker = true)
as
select
  c.id,
  c.speech_id,
  s.politician_id,
  p.name as politician_name,
  p.role as politician_role,
  p.avatar_url as politician_avatar_url,
  s.speaker_name,
  coalesce(p.party, s.party) as party,
  s.anforandetyp,
  c.archetype,
  c.title,
  c.transcript,
  c.topic,
  c.duration_s,
  c.url_540x960,
  c.thumb_url,
  src.title as source_title,
  src.source_url,
  src.debate_date,
  c.published_at,
  c.rank_in_speech
from public.clips c
join public.speeches s on s.id = c.speech_id
join public.sources src on src.id = s.source_id
left join public.politicians p on p.id = s.politician_id
where c.moderation <> 'rejected'
  and c.published_at is not null
  and c.url_540x960 <> '';

revoke all on public.feed_clip_catalogue from public;
grant select on public.feed_clip_catalogue to anon, authenticated, service_role;

create table if not exists private.feed_requests (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  client_request_id uuid not null,
  mode text not null default 'for_you',
  algorithm_version text not null,
  notice_version text not null references private.consent_notice_versions(id),
  created_at timestamptz not null default now(),
  constraint feed_request_subject_length check (char_length(clerk_user_id) between 3 and 200),
  constraint feed_request_mode check (mode = 'for_you'),
  constraint feed_request_algorithm_length check (char_length(algorithm_version) between 3 and 120),
  unique (clerk_user_id, client_request_id)
);

create index if not exists feed_requests_subject_created_idx
  on private.feed_requests (clerk_user_id, created_at desc);

create table if not exists private.feed_items (
  id uuid primary key default gen_random_uuid(),
  feed_request_id uuid not null references private.feed_requests(id) on delete cascade,
  clip_id text not null references public.clips(id) on delete cascade,
  position smallint not null,
  pool text not null,
  reason_code text not null,
  reason_label text not null,
  score numeric not null,
  score_components jsonb not null,
  exploration_probability numeric not null default 0,
  clip_payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint feed_item_position check (position between 1 and 60),
  constraint feed_item_pool check (
    pool in ('fresh_interest', 'fresh_general', 'back_catalog_interest', 'adjacent_interest')
  ),
  constraint feed_item_exploration_probability
    check (exploration_probability between 0 and 1),
  unique (feed_request_id, position),
  unique (feed_request_id, clip_id)
);

create index if not exists feed_items_clip_idx on private.feed_items (clip_id);

alter table private.feed_requests enable row level security;
alter table private.feed_items enable row level security;
revoke all on private.feed_requests, private.feed_items from public, anon, authenticated;
grant all on private.feed_requests, private.feed_items to service_role;

create or replace function public.get_recommendation_context(p_subject text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile jsonb;
begin
  profile := public.get_recommendation_profile(p_subject);
  return profile || jsonb_build_object(
    'recentClipIds', coalesce((
      select jsonb_agg(recent.clip_id order by recent.last_served desc)
      from (
        select fi.clip_id, max(fr.created_at) as last_served
        from private.feed_requests fr
        join private.feed_items fi on fi.feed_request_id = fr.id
        where fr.clerk_user_id = p_subject
          and fr.created_at >= now() - interval '30 days'
        group by fi.clip_id
        order by max(fr.created_at) desc
        limit 500
      ) recent
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.record_recommendation_slate(
  p_subject text,
  p_client_request_id uuid,
  p_algorithm_version text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_consent boolean := false;
  active_notice text;
  request_id uuid;
  created_request boolean := false;
  item_count integer;
  response_items jsonb;
begin
  if p_subject is null or char_length(p_subject) < 3 or char_length(p_subject) > 200 then
    raise exception 'invalid_subject' using errcode = '22023';
  end if;
  if p_algorithm_version is null
    or char_length(p_algorithm_version) < 3
    or char_length(p_algorithm_version) > 120 then
    raise exception 'invalid_algorithm_version' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items_must_be_an_array' using errcode = '22023';
  end if;
  item_count := jsonb_array_length(p_items);
  if item_count > 60 then
    raise exception 'feed_limit_exceeded' using errcode = '22023';
  end if;

  select cr.granted, cr.notice_version into active_consent, active_notice
  from private.consent_records cr
  where cr.clerk_user_id = p_subject
    and cr.purpose = 'personalization'
  order by cr.created_at desc, cr.id desc
  limit 1;

  if not coalesce(active_consent, false) then
    raise exception 'personalization_consent_required' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(clip_id text, position integer)
    left join public.clips c on c.id = item.clip_id
    where c.id is null
      or c.published_at is null
      or c.moderation = 'rejected'
      or item.position < 1
      or item.position > 60
  ) then
    raise exception 'invalid_feed_item' using errcode = '22023';
  end if;
  if (
    select count(*)
    from (
      select distinct item.position
      from jsonb_to_recordset(p_items) as item(position integer)
    ) positions
  ) <> item_count or (
    select count(*)
    from (
      select distinct item.clip_id
      from jsonb_to_recordset(p_items) as item(clip_id text)
    ) clips
  ) <> item_count then
    raise exception 'duplicate_feed_item' using errcode = '22023';
  end if;

  insert into private.feed_requests (
    clerk_user_id, client_request_id, mode, algorithm_version, notice_version
  ) values (
    p_subject, p_client_request_id, 'for_you', p_algorithm_version, active_notice
  )
  on conflict (clerk_user_id, client_request_id) do nothing
  returning id into request_id;

  if request_id is not null then
    created_request := true;
  else
    select fr.id into request_id
    from private.feed_requests fr
    where fr.clerk_user_id = p_subject
      and fr.client_request_id = p_client_request_id;
  end if;

  if created_request then
    insert into private.feed_items (
      feed_request_id, clip_id, position, pool, reason_code, reason_label,
      score, score_components, exploration_probability, clip_payload
    )
    select
      request_id,
      item.clip_id,
      item.position,
      item.pool,
      item.reason_code,
      item.reason_label,
      item.score,
      item.score_components,
      0,
      item.clip_payload
    from jsonb_to_recordset(p_items) as item(
      clip_id text,
      position integer,
      pool text,
      reason_code text,
      reason_label text,
      score numeric,
      score_components jsonb,
      clip_payload jsonb
    );
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'feedItemId', fi.id,
      'position', fi.position,
      'pool', fi.pool,
      'reasonCode', fi.reason_code,
      'reason', fi.reason_label,
      'score', fi.score,
      'scoreComponents', fi.score_components,
      'clip', fi.clip_payload
    ) order by fi.position
  ), '[]'::jsonb)
  into response_items
  from private.feed_items fi
  where fi.feed_request_id = request_id;

  return jsonb_build_object(
    'feedRequestId', request_id,
    'algorithmVersion', (
      select fr.algorithm_version from private.feed_requests fr where fr.id = request_id
    ),
    'items', response_items
  );
end;
$$;

create or replace function public.delete_recommendation_subject(p_subject text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  consent_count integer;
  preference_count integer;
  request_count integer;
begin
  delete from private.feed_requests where clerk_user_id = p_subject;
  get diagnostics request_count = row_count;
  delete from private.viewer_preferences where clerk_user_id = p_subject;
  get diagnostics preference_count = row_count;
  delete from private.consent_records where clerk_user_id = p_subject;
  get diagnostics consent_count = row_count;
  delete from private.data_subject_requests where clerk_user_id = p_subject;

  return jsonb_build_object(
    'deletedConsentRecords', consent_count,
    'deletedPreferences', preference_count,
    'deletedFeedRequests', request_count
  );
end;
$$;

revoke all on function public.get_recommendation_context(text)
  from public, anon, authenticated;
revoke all on function public.record_recommendation_slate(text, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.delete_recommendation_subject(text)
  from public, anon, authenticated;

grant execute on function public.get_recommendation_context(text) to service_role;
grant execute on function public.record_recommendation_slate(text, uuid, text, jsonb)
  to service_role;
grant execute on function public.delete_recommendation_subject(text) to service_role;
