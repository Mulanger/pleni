revoke all on function public.set_comment_user_suspension(text, timestamptz, text, text) from public, anon, authenticated, service_role;
revoke all on function public.moderate_video_comment(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.report_video_comment(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_video_comment(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_video_comment(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.list_video_comments(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_my_comment_profile() from public, anon, authenticated, service_role;

drop function if exists public.set_comment_user_suspension(text, timestamptz, text, text);
drop function if exists public.moderate_video_comment(uuid, text, text, text);
drop function if exists public.report_video_comment(uuid, text);
drop function if exists public.delete_video_comment(uuid);
drop function if exists public.create_video_comment(text, text, text);
drop function if exists public.list_video_comments(text, integer);
drop function if exists public.get_my_comment_profile();

drop table if exists public.comment_moderation_events;
drop table if exists public.comment_reports;
drop table if exists public.video_comments;
drop table if exists public.comment_profiles;
