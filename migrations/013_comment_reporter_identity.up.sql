-- 013_comment_reporter_identity
--
-- A signed-in viewer may report before posting their first comment. Such a
-- viewer has a verified Clerk subject but no comment_profiles row yet, so the
-- optional reporter id cannot be a foreign key to comment_profiles. The table
-- is inaccessible to public roles; the subject remains private operator data.

alter table public.comment_reports
  drop constraint if exists comment_reports_reporter_user_id_fkey;
