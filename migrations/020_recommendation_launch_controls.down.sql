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

revoke all on function public.reset_recommendation_subject(text) from service_role;
revoke all on function public.export_recommendation_subject_data(text) from service_role;

drop function if exists public.purge_expired_recommendation_data();
drop function if exists public.reset_recommendation_subject(text);
drop function if exists public.export_recommendation_subject_data(text);

update private.consent_notice_versions
set retired_at = null
where id = 'personalization-2026-08-14-v1';

update private.consent_notice_versions
set retired_at = coalesce(retired_at, now())
where id = 'personalization-2026-08-14-v2';
