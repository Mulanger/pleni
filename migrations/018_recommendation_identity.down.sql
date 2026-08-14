revoke all on function public.sync_recommendation_preferences(
  text, text[], text[], uuid[]
) from service_role;
revoke all on function public.set_recommendation_consent(
  text, boolean, text, text, text[], text[], uuid[]
) from service_role;
revoke all on function public.get_recommendation_profile(text) from service_role;

drop function if exists public.sync_recommendation_preferences(
  text, text[], text[], uuid[]
);
drop function if exists public.set_recommendation_consent(
  text, boolean, text, text, text[], text[], uuid[]
);
drop function if exists public.get_recommendation_profile(text);

alter default privileges in schema private revoke all on tables from service_role;
drop table if exists private.data_subject_requests;
drop table if exists private.viewer_preferences;
drop table if exists private.consent_records;
drop table if exists private.consent_notice_versions;
drop schema if exists private;
