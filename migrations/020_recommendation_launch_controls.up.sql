-- 020_recommendation_launch_controls
--
-- Production lifecycle controls for the explicit-interest rule feed. This
-- adds no playback telemetry and no inferred interests. Browser roles remain
-- unable to reach these RPCs; Clerk-authenticated Edge Functions call them
-- with service_role after deriving the subject from a verified JWT.

insert into private.consent_notice_versions (id, purpose, notice_text_sv)
values (
  'personalization-2026-08-14-v2',
  'personalization',
  'Pleni sparar de partier och politiker du väljer och använder dem för att ordna För dig. Dina val kan avslöja politiska åsikter. Tittarhistorik, gillningar och sparade klipp används inte i denna version. Servern sparar visade rekommendationslistor i 30 dagar för att undvika upprepningar. Du kan när som helst stänga av, exportera, återställa eller radera rekommendationsdata och fortsätta använda Senaste.'
)
on conflict (id) do update set
  notice_text_sv = excluded.notice_text_sv,
  retired_at = null;

update private.consent_notice_versions
set retired_at = coalesce(retired_at, now())
where id = 'personalization-2026-08-14-v1';

create or replace function public.export_recommendation_subject_data(p_subject text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_id uuid;
  exported jsonb;
begin
  if p_subject is null or char_length(p_subject) < 3 or char_length(p_subject) > 200 then
    raise exception 'invalid_subject' using errcode = '22023';
  end if;

  insert into private.data_subject_requests (
    clerk_user_id, request_type, state
  ) values (
    p_subject, 'export', 'requested'
  ) returning id into request_id;

  exported := jsonb_build_object(
    'subject', p_subject,
    'generatedAt', now(),
    'consentRecords', coalesce((
      select jsonb_agg(jsonb_build_object(
        'purpose', cr.purpose,
        'granted', cr.granted,
        'article6Basis', cr.article_6_basis,
        'article9Condition', cr.article_9_condition,
        'noticeVersion', cr.notice_version,
        'uiSource', cr.ui_source,
        'createdAt', cr.created_at
      ) order by cr.created_at, cr.id)
      from private.consent_records cr
      where cr.clerk_user_id = p_subject
    ), '[]'::jsonb),
    'preferences', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entityType', vp.entity_type,
        'entityId', vp.entity_id,
        'weight', vp.weight,
        'source', vp.source,
        'createdAt', vp.created_at,
        'updatedAt', vp.updated_at
      ) order by vp.entity_type, vp.entity_id, vp.source)
      from private.viewer_preferences vp
      where vp.clerk_user_id = p_subject
    ), '[]'::jsonb),
    'feedRequests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', fr.id,
        'clientRequestId', fr.client_request_id,
        'mode', fr.mode,
        'algorithmVersion', fr.algorithm_version,
        'noticeVersion', fr.notice_version,
        'createdAt', fr.created_at,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'clipId', fi.clip_id,
            'position', fi.position,
            'pool', fi.pool,
            'reasonCode', fi.reason_code,
            'reason', fi.reason_label,
            'score', fi.score,
            'scoreComponents', fi.score_components,
            'createdAt', fi.created_at
          ) order by fi.position)
          from private.feed_items fi
          where fi.feed_request_id = fr.id
        ), '[]'::jsonb)
      ) order by fr.created_at, fr.id)
      from private.feed_requests fr
      where fr.clerk_user_id = p_subject
    ), '[]'::jsonb)
  );

  update private.data_subject_requests
  set state = 'complete', completed_at = now(), detail = jsonb_build_object(
    'format', 'application/json',
    'consentRecords', jsonb_array_length(exported -> 'consentRecords'),
    'preferences', jsonb_array_length(exported -> 'preferences'),
    'feedRequests', jsonb_array_length(exported -> 'feedRequests')
  )
  where id = request_id;

  return exported;
end;
$$;

create or replace function public.reset_recommendation_subject(p_subject text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_id uuid;
  preference_count integer;
  feed_request_count integer;
begin
  if p_subject is null or char_length(p_subject) < 3 or char_length(p_subject) > 200 then
    raise exception 'invalid_subject' using errcode = '22023';
  end if;

  insert into private.data_subject_requests (
    clerk_user_id, request_type, state
  ) values (
    p_subject, 'reset', 'requested'
  ) returning id into request_id;

  insert into private.consent_records (
    clerk_user_id, purpose, granted, article_6_basis, article_9_condition,
    notice_version, ui_source
  ) values (
    p_subject, 'personalization', false, 'GDPR 6(1)(a)', 'GDPR 9(2)(a)',
    'personalization-2026-08-14-v2', 'profile'
  );

  delete from private.feed_requests where clerk_user_id = p_subject;
  get diagnostics feed_request_count = row_count;
  delete from private.viewer_preferences where clerk_user_id = p_subject;
  get diagnostics preference_count = row_count;

  update private.data_subject_requests
  set state = 'complete', completed_at = now(), detail = jsonb_build_object(
    'deletedPreferences', preference_count,
    'deletedFeedRequests', feed_request_count
  )
  where id = request_id;

  return public.get_recommendation_profile(p_subject);
end;
$$;

create or replace function public.purge_expired_recommendation_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  feed_request_count integer;
  consent_count integer;
  rights_request_count integer;
begin
  delete from private.feed_requests
  where created_at < now() - interval '30 days';
  get diagnostics feed_request_count = row_count;

  with ranked as (
    select
      cr.id,
      row_number() over (
        partition by cr.clerk_user_id, cr.purpose
        order by cr.created_at desc, cr.id desc
      ) as recency
    from private.consent_records cr
  )
  delete from private.consent_records cr
  using ranked
  where cr.id = ranked.id
    and ranked.recency > 1
    and cr.created_at < now() - interval '730 days';
  get diagnostics consent_count = row_count;

  delete from private.data_subject_requests
  where requested_at < now() - interval '730 days';
  get diagnostics rights_request_count = row_count;

  return jsonb_build_object(
    'deletedFeedRequests', feed_request_count,
    'deletedConsentRecords', consent_count,
    'deletedDataSubjectRequests', rights_request_count
  );
end;
$$;

revoke all on function public.export_recommendation_subject_data(text)
  from public, anon, authenticated;
revoke all on function public.reset_recommendation_subject(text)
  from public, anon, authenticated;
revoke all on function public.purge_expired_recommendation_data()
  from public, anon, authenticated;

grant execute on function public.export_recommendation_subject_data(text) to service_role;
grant execute on function public.reset_recommendation_subject(text) to service_role;

create extension if not exists pg_cron with schema extensions;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job
  from cron.job
  where jobname = 'pleni-recommendation-retention-v1';
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
end;
$$;

select cron.schedule(
  'pleni-recommendation-retention-v1',
  '23 3 * * *',
  'select public.purge_expired_recommendation_data();'
);
