-- 018_recommendation_identity
--
-- Explicit political preferences are Article 9 data. Keep them outside the
-- PostgREST-exposed schemas and make consent an append-only ledger. Browser
-- roles receive no schema usage and no table privileges; the public RPCs below
-- are callable only by service_role after an Edge Function verifies Clerk.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.consent_notice_versions (
  id text primary key,
  purpose text not null,
  notice_text_sv text not null,
  activated_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint consent_notice_purpose
    check (purpose in ('personalization', 'analytics', 'email', 'model_training')),
  constraint consent_notice_id_length check (char_length(id) between 3 and 120)
);

insert into private.consent_notice_versions (id, purpose, notice_text_sv)
values (
  'personalization-2026-08-14-v1',
  'personalization',
  'Pleni sparar de partier och politiker du väljer och använder dem för att ordna För dig. Dina val kan avslöja politiska åsikter. Tittarhistorik används inte i denna version. Du kan när som helst stänga av personalisering och fortsätta använda Senaste.'
)
on conflict (id) do nothing;

create table if not exists private.consent_records (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  purpose text not null,
  granted boolean not null,
  article_6_basis text not null,
  article_9_condition text not null,
  notice_version text not null references private.consent_notice_versions(id),
  ui_source text not null,
  created_at timestamptz not null default now(),
  constraint consent_record_subject_length
    check (char_length(clerk_user_id) between 3 and 200),
  constraint consent_record_purpose
    check (purpose in ('personalization', 'analytics', 'email', 'model_training')),
  constraint consent_record_ui_source
    check (ui_source in ('onboarding', 'profile', 'account_delete', 'clerk_webhook'))
);

create index if not exists consent_records_current_idx
  on private.consent_records (clerk_user_id, purpose, created_at desc, id desc);

create table if not exists private.viewer_preferences (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  entity_type text not null,
  entity_id text not null,
  weight numeric not null,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decayed_at timestamptz,
  constraint viewer_preference_subject_length
    check (char_length(clerk_user_id) between 3 and 200),
  constraint viewer_preference_entity_type
    check (entity_type in ('party', 'politician')),
  constraint viewer_preference_source
    check (source in ('explicit', 'follow', 'inferred')),
  constraint viewer_preference_weight check (weight between -1 and 1),
  constraint viewer_preference_entity_length check (char_length(entity_id) between 1 and 200),
  unique (clerk_user_id, entity_type, entity_id, source)
);

create index if not exists viewer_preferences_subject_idx
  on private.viewer_preferences (clerk_user_id, entity_type, source);

create table if not exists private.data_subject_requests (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  request_type text not null,
  state text not null default 'requested',
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  detail jsonb not null default '{}'::jsonb,
  constraint data_subject_request_type
    check (request_type in ('export', 'reset', 'delete')),
  constraint data_subject_request_state
    check (state in ('requested', 'complete', 'failed'))
);

alter table private.consent_notice_versions enable row level security;
alter table private.consent_records enable row level security;
alter table private.viewer_preferences enable row level security;
alter table private.data_subject_requests enable row level security;

revoke all on all tables in schema private from public, anon, authenticated;
grant all on all tables in schema private to service_role;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private grant all on tables to service_role;

create or replace function public.get_recommendation_profile(p_subject text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_grant boolean := false;
  current_notice text;
begin
  if p_subject is null or char_length(p_subject) < 3 or char_length(p_subject) > 200 then
    raise exception 'invalid_subject' using errcode = '22023';
  end if;

  select cr.granted, cr.notice_version
    into current_grant, current_notice
  from private.consent_records cr
  where cr.clerk_user_id = p_subject
    and cr.purpose = 'personalization'
  order by cr.created_at desc, cr.id desc
  limit 1;

  return jsonb_build_object(
    'personalization', coalesce(current_grant, false),
    'noticeVersion', current_notice,
    'explicitParties', coalesce((
      select jsonb_agg(vp.entity_id order by vp.entity_id)
      from private.viewer_preferences vp
      where vp.clerk_user_id = p_subject
        and vp.entity_type = 'party'
        and vp.source = 'explicit'
    ), '[]'::jsonb),
    'followedParties', coalesce((
      select jsonb_agg(vp.entity_id order by vp.entity_id)
      from private.viewer_preferences vp
      where vp.clerk_user_id = p_subject
        and vp.entity_type = 'party'
        and vp.source = 'follow'
    ), '[]'::jsonb),
    'followedPoliticians', coalesce((
      select jsonb_agg(vp.entity_id order by vp.entity_id)
      from private.viewer_preferences vp
      where vp.clerk_user_id = p_subject
        and vp.entity_type = 'politician'
        and vp.source = 'follow'
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.set_recommendation_consent(
  p_subject text,
  p_granted boolean,
  p_notice_version text,
  p_ui_source text,
  p_explicit_parties text[],
  p_followed_parties text[],
  p_followed_politicians uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_subject is null or char_length(p_subject) < 3 or char_length(p_subject) > 200 then
    raise exception 'invalid_subject' using errcode = '22023';
  end if;
  if p_ui_source not in ('onboarding', 'profile') then
    raise exception 'invalid_ui_source' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from private.consent_notice_versions cnv
    where cnv.id = p_notice_version
      and cnv.purpose = 'personalization'
      and cnv.retired_at is null
  ) then
    raise exception 'unknown_or_retired_notice' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_explicit_parties, '{}'::text[])) > 8
    or cardinality(coalesce(p_followed_parties, '{}'::text[])) > 8
    or cardinality(coalesce(p_followed_politicians, '{}'::uuid[])) > 500 then
    raise exception 'preference_limit_exceeded' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_explicit_parties, '{}'::text[])) as selected(party)
    where party not in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')
  ) or exists (
    select 1 from unnest(coalesce(p_followed_parties, '{}'::text[])) as selected(party)
    where party not in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')
  ) then
    raise exception 'invalid_party' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_followed_politicians, '{}'::uuid[])) as selected(politician_id)
    left join public.politicians p on p.id = politician_id
    where p.id is null
  ) then
    raise exception 'unknown_politician' using errcode = '22023';
  end if;

  insert into private.consent_records (
    clerk_user_id, purpose, granted, article_6_basis, article_9_condition,
    notice_version, ui_source
  ) values (
    p_subject, 'personalization', p_granted, 'GDPR 6(1)(a)', 'GDPR 9(2)(a)',
    p_notice_version, p_ui_source
  );

  delete from private.viewer_preferences
  where clerk_user_id = p_subject
    and source in ('explicit', 'follow');

  if p_granted then
    insert into private.viewer_preferences (
      clerk_user_id, entity_type, entity_id, weight, source
    )
    select distinct p_subject, 'party', party, 1, 'explicit'
    from unnest(coalesce(p_explicit_parties, '{}'::text[])) as selected(party)
    on conflict (clerk_user_id, entity_type, entity_id, source) do update set
      weight = excluded.weight,
      updated_at = now();

    insert into private.viewer_preferences (
      clerk_user_id, entity_type, entity_id, weight, source
    )
    select distinct p_subject, 'party', party, 1, 'follow'
    from unnest(coalesce(p_followed_parties, '{}'::text[])) as selected(party)
    on conflict (clerk_user_id, entity_type, entity_id, source) do update set
      weight = excluded.weight,
      updated_at = now();

    insert into private.viewer_preferences (
      clerk_user_id, entity_type, entity_id, weight, source
    )
    select distinct p_subject, 'politician', politician_id::text, 1, 'follow'
    from unnest(coalesce(p_followed_politicians, '{}'::uuid[])) as selected(politician_id)
    on conflict (clerk_user_id, entity_type, entity_id, source) do update set
      weight = excluded.weight,
      updated_at = now();
  end if;

  return public.get_recommendation_profile(p_subject);
end;
$$;

create or replace function public.sync_recommendation_preferences(
  p_subject text,
  p_explicit_parties text[],
  p_followed_parties text[],
  p_followed_politicians uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_consent boolean := false;
begin
  select cr.granted into active_consent
  from private.consent_records cr
  where cr.clerk_user_id = p_subject
    and cr.purpose = 'personalization'
  order by cr.created_at desc, cr.id desc
  limit 1;

  if not coalesce(active_consent, false) then
    raise exception 'personalization_consent_required' using errcode = 'P0001';
  end if;

  if cardinality(coalesce(p_explicit_parties, '{}'::text[])) > 8
    or cardinality(coalesce(p_followed_parties, '{}'::text[])) > 8
    or cardinality(coalesce(p_followed_politicians, '{}'::uuid[])) > 500 then
    raise exception 'preference_limit_exceeded' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_explicit_parties, '{}'::text[])) as selected(party)
    where party not in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')
  ) or exists (
    select 1 from unnest(coalesce(p_followed_parties, '{}'::text[])) as selected(party)
    where party not in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')
  ) then
    raise exception 'invalid_party' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_followed_politicians, '{}'::uuid[])) as selected(politician_id)
    left join public.politicians p on p.id = politician_id
    where p.id is null
  ) then
    raise exception 'unknown_politician' using errcode = '22023';
  end if;

  delete from private.viewer_preferences
  where clerk_user_id = p_subject
    and source in ('explicit', 'follow');

  insert into private.viewer_preferences (clerk_user_id, entity_type, entity_id, weight, source)
  select distinct p_subject, 'party', party, 1, 'explicit'
  from unnest(coalesce(p_explicit_parties, '{}'::text[])) as selected(party);

  insert into private.viewer_preferences (clerk_user_id, entity_type, entity_id, weight, source)
  select distinct p_subject, 'party', party, 1, 'follow'
  from unnest(coalesce(p_followed_parties, '{}'::text[])) as selected(party);

  insert into private.viewer_preferences (clerk_user_id, entity_type, entity_id, weight, source)
  select distinct p_subject, 'politician', politician_id::text, 1, 'follow'
  from unnest(coalesce(p_followed_politicians, '{}'::uuid[])) as selected(politician_id);

  return public.get_recommendation_profile(p_subject);
end;
$$;

revoke all on function public.get_recommendation_profile(text)
  from public, anon, authenticated;
revoke all on function public.set_recommendation_consent(
  text, boolean, text, text, text[], text[], uuid[]
) from public, anon, authenticated;
revoke all on function public.sync_recommendation_preferences(
  text, text[], text[], uuid[]
) from public, anon, authenticated;

grant execute on function public.get_recommendation_profile(text) to service_role;
grant execute on function public.set_recommendation_consent(
  text, boolean, text, text, text[], text[], uuid[]
) to service_role;
grant execute on function public.sync_recommendation_preferences(
  text, text[], text[], uuid[]
) to service_role;
