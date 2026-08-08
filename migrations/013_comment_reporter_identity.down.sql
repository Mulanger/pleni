alter table public.comment_reports
  add constraint comment_reports_reporter_user_id_fkey
  foreign key (reporter_user_id)
  references public.comment_profiles(clerk_user_id)
  on delete set null
  not valid;
