-- 012_video_comments
--
-- Public per-video discussion with private account identifiers. The browser can
-- execute narrowly scoped RPCs; it never receives a Clerk subject and has no
-- direct table privileges. Migrations 010 and 011 remain reserved for F1.

create table if not exists public.comment_profiles (
  clerk_user_id text primary key,
  username text not null unique,
  suspended_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comment_profiles_username_format
    check (username ~ '^[a-z0-9_]{3,24}$')
);

create table if not exists public.video_comments (
  id uuid primary key default gen_random_uuid(),
  clip_id text not null references public.clips(id) on delete cascade,
  author_user_id text not null references public.comment_profiles(clerk_user_id) on delete cascade,
  author_username text not null,
  body text not null,
  status text not null default 'visible',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint video_comments_body_length
    check (character_length(body) <= 500),
  constraint video_comments_status
    check (status in ('visible', 'hidden', 'deleted'))
);

create table if not exists public.comment_reports (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.video_comments(id) on delete cascade,
  reporter_user_id text references public.comment_profiles(clerk_user_id) on delete set null,
  reason text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint comment_reports_reason
    check (reason in ('spam', 'harassment', 'hate', 'private_information', 'illegal', 'other')),
  constraint comment_reports_status
    check (status in ('open', 'reviewed', 'dismissed'))
);

create table if not exists public.comment_moderation_events (
  id bigserial primary key,
  comment_id uuid references public.video_comments(id) on delete set null,
  author_user_id text references public.comment_profiles(clerk_user_id) on delete set null,
  action text not null,
  reason text not null,
  moderator text not null,
  created_at timestamptz not null default now()
);

create index if not exists video_comments_clip_visible_idx
  on public.video_comments (clip_id, created_at desc)
  where status = 'visible';
create index if not exists video_comments_author_rate_idx
  on public.video_comments (author_user_id, created_at desc);
create index if not exists comment_reports_open_idx
  on public.comment_reports (created_at)
  where status = 'open';
create unique index if not exists comment_reports_one_per_user_idx
  on public.comment_reports (comment_id, reporter_user_id)
  where reporter_user_id is not null;

alter table public.comment_profiles enable row level security;
alter table public.video_comments enable row level security;
alter table public.comment_reports enable row level security;
alter table public.comment_moderation_events enable row level security;

-- The tables deliberately have no public policies. SECURITY DEFINER RPCs below
-- are the complete public API and project only safe fields.
revoke all on public.comment_profiles from public, anon, authenticated;
revoke all on public.video_comments from public, anon, authenticated;
revoke all on public.comment_reports from public, anon, authenticated;
revoke all on public.comment_moderation_events from public, anon, authenticated;
grant all on public.comment_profiles, public.video_comments, public.comment_reports,
  public.comment_moderation_events to service_role;
grant usage, select on sequence public.comment_moderation_events_id_seq to service_role;

create or replace function public.get_my_comment_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  subject text := nullif(auth.jwt() ->> 'sub', '');
  profile_username text;
begin
  if subject is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select profile.username
  into profile_username
  from public.comment_profiles as profile
  where profile.clerk_user_id = subject;

  if profile_username is null then
    return null;
  end if;
  return jsonb_build_object('username', profile_username);
end;
$$;

create or replace function public.list_video_comments(
  p_clip_id text,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  subject text := nullif(auth.jwt() ->> 'sub', '');
  bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  visible_count integer := 0;
  comments_payload jsonb := '[]'::jsonb;
begin
  select count(*)::integer
  into visible_count
  from public.video_comments as comment
  join public.clips as clip on clip.id = comment.clip_id
  where comment.clip_id = p_clip_id
    and comment.status = 'visible'
    and clip.published_at is not null
    and clip.moderation <> 'rejected';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', comment.id,
        'clip_id', comment.clip_id,
        'author_username', comment.author_username,
        'body', comment.body,
        'created_at', comment.created_at,
        'is_own', subject is not null and comment.author_user_id = subject
      ) order by comment.created_at desc
    ),
    '[]'::jsonb
  )
  into comments_payload
  from (
    select row.id, row.clip_id, row.author_user_id, row.author_username, row.body, row.created_at
    from public.video_comments as row
    join public.clips as clip on clip.id = row.clip_id
    where row.clip_id = p_clip_id
      and row.status = 'visible'
      and clip.published_at is not null
      and clip.moderation <> 'rejected'
    order by row.created_at desc
    limit bounded_limit
  ) as comment;

  return jsonb_build_object('count', visible_count, 'comments', comments_payload);
end;
$$;

create or replace function public.create_video_comment(
  p_clip_id text,
  p_body text,
  p_username text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  subject text := nullif(auth.jwt() ->> 'sub', '');
  requested_username text := lower(regexp_replace(btrim(coalesce(p_username, '')), '^@', ''));
  resolved_username text;
  normalized_body text := btrim(regexp_replace(coalesce(p_body, ''), E'\r\n?', E'\n', 'g'));
  new_comment public.video_comments%rowtype;
begin
  if subject is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  -- Serialise first posts and rate checks for one account. Concurrent taps must
  -- not claim two handles or step around the per-minute limit.
  perform pg_advisory_xact_lock(hashtext(subject)::bigint);

  select profile.username
  into resolved_username
  from public.comment_profiles as profile
  where profile.clerk_user_id = subject
  for update;

  if resolved_username is null then
    if requested_username !~ '^[a-z0-9_]{3,24}$' then
      raise exception using errcode = 'P0001', message = 'username_invalid';
    end if;
    if requested_username in ('admin', 'administrator', 'moderator', 'pleni', 'riksdagen', 'support') then
      raise exception using errcode = 'P0001', message = 'username_reserved';
    end if;

    begin
      insert into public.comment_profiles (clerk_user_id, username)
      values (subject, requested_username)
      returning username into resolved_username;
    exception
      when unique_violation then
        raise exception using errcode = 'P0001', message = 'username_taken';
    end;
  end if;

  if exists (
    select 1
    from public.comment_profiles as profile
    where profile.clerk_user_id = subject
      and profile.suspended_until is not null
      and profile.suspended_until > now()
  ) then
    raise exception using errcode = 'P0001', message = 'comment_account_suspended';
  end if;

  if normalized_body = '' then
    raise exception using errcode = 'P0001', message = 'comment_body_required';
  end if;
  if character_length(normalized_body) > 500 then
    raise exception using errcode = 'P0001', message = 'comment_too_long';
  end if;
  if normalized_body ~* '(https?://|www\.)' then
    raise exception using errcode = 'P0001', message = 'comment_links_not_allowed';
  end if;
  if not exists (
    select 1
    from public.clips as clip
    where clip.id = p_clip_id
      and clip.published_at is not null
      and clip.moderation <> 'rejected'
  ) then
    raise exception using errcode = 'P0001', message = 'comment_clip_unavailable';
  end if;

  if (
    select count(*)
    from public.video_comments as comment
    where comment.author_user_id = subject
      and comment.created_at >= now() - interval '1 minute'
  ) >= 3 or (
    select count(*)
    from public.video_comments as comment
    where comment.author_user_id = subject
      and comment.created_at >= now() - interval '1 day'
  ) >= 100 then
    raise exception using errcode = 'P0001', message = 'comment_rate_limited';
  end if;

  insert into public.video_comments (clip_id, author_user_id, author_username, body)
  values (p_clip_id, subject, resolved_username, normalized_body)
  returning * into new_comment;

  return jsonb_build_object(
    'id', new_comment.id,
    'clip_id', new_comment.clip_id,
    'author_username', new_comment.author_username,
    'body', new_comment.body,
    'created_at', new_comment.created_at,
    'is_own', true
  );
end;
$$;

create or replace function public.delete_video_comment(p_comment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  subject text := nullif(auth.jwt() ->> 'sub', '');
  changed integer := 0;
begin
  if subject is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  update public.video_comments
  set body = '', status = 'deleted', deleted_at = now()
  where id = p_comment_id
    and author_user_id = subject
    and status = 'visible';
  get diagnostics changed = row_count;

  if changed = 0 then
    raise exception using errcode = 'P0001', message = 'comment_not_owned_or_missing';
  end if;
  return true;
end;
$$;

create or replace function public.report_video_comment(
  p_comment_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  subject text := nullif(auth.jwt() ->> 'sub', '');
begin
  if p_reason not in ('spam', 'harassment', 'hate', 'private_information', 'illegal', 'other') then
    raise exception using errcode = 'P0001', message = 'report_reason_invalid';
  end if;
  if not exists (
    select 1 from public.video_comments
    where id = p_comment_id and status = 'visible'
  ) then
    raise exception using errcode = 'P0001', message = 'comment_missing';
  end if;

  if subject is not null and exists (
    select 1 from public.comment_reports
    where comment_id = p_comment_id and reporter_user_id = subject
  ) then
    return true;
  end if;

  insert into public.comment_reports (comment_id, reporter_user_id, reason)
  values (p_comment_id, subject, p_reason);
  return true;
end;
$$;

create or replace function public.moderate_video_comment(
  p_comment_id uuid,
  p_action text,
  p_reason text,
  p_moderator text default 'operator'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  comment_author text;
begin
  if p_action not in ('hide', 'restore', 'delete') or btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'moderation_action_invalid';
  end if;

  select author_user_id into comment_author
  from public.video_comments
  where id = p_comment_id
  for update;
  if comment_author is null then
    raise exception using errcode = 'P0001', message = 'comment_missing';
  end if;

  if p_action = 'hide' then
    update public.video_comments set status = 'hidden' where id = p_comment_id and status <> 'deleted';
  elsif p_action = 'restore' then
    update public.video_comments set status = 'visible', deleted_at = null where id = p_comment_id and status = 'hidden';
  else
    update public.video_comments set body = '', status = 'deleted', deleted_at = now() where id = p_comment_id;
  end if;

  update public.comment_reports
  set status = 'reviewed', reviewed_at = now()
  where comment_id = p_comment_id and status = 'open';

  insert into public.comment_moderation_events (
    comment_id, author_user_id, action, reason, moderator
  ) values (
    p_comment_id, comment_author, p_action, btrim(p_reason), btrim(p_moderator)
  );
  return true;
end;
$$;

create or replace function public.set_comment_user_suspension(
  p_author_user_id text,
  p_until timestamptz,
  p_reason text,
  p_moderator text default 'operator'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer := 0;
begin
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'moderation_reason_required';
  end if;

  update public.comment_profiles
  set suspended_until = p_until, updated_at = now()
  where clerk_user_id = p_author_user_id;
  get diagnostics changed = row_count;
  if changed = 0 then
    raise exception using errcode = 'P0001', message = 'comment_author_missing';
  end if;

  insert into public.comment_moderation_events (
    author_user_id, action, reason, moderator
  ) values (
    p_author_user_id,
    case when p_until is null or p_until <= now() then 'unsuspend' else 'suspend' end,
    btrim(p_reason),
    btrim(p_moderator)
  );
  return true;
end;
$$;

revoke all on function public.get_my_comment_profile() from public, anon, authenticated;
revoke all on function public.list_video_comments(text, integer) from public, anon, authenticated;
revoke all on function public.create_video_comment(text, text, text) from public, anon, authenticated;
revoke all on function public.delete_video_comment(uuid) from public, anon, authenticated;
revoke all on function public.report_video_comment(uuid, text) from public, anon, authenticated;
revoke all on function public.moderate_video_comment(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.set_comment_user_suspension(text, timestamptz, text, text) from public, anon, authenticated;

grant execute on function public.list_video_comments(text, integer) to anon, authenticated;
grant execute on function public.report_video_comment(uuid, text) to anon, authenticated;
grant execute on function public.get_my_comment_profile() to authenticated;
grant execute on function public.create_video_comment(text, text, text) to authenticated;
grant execute on function public.delete_video_comment(uuid) to authenticated;
grant execute on function public.get_my_comment_profile() to service_role;
grant execute on function public.list_video_comments(text, integer) to service_role;
grant execute on function public.create_video_comment(text, text, text) to service_role;
grant execute on function public.delete_video_comment(uuid) to service_role;
grant execute on function public.report_video_comment(uuid, text) to service_role;
grant execute on function public.moderate_video_comment(uuid, text, text, text) to service_role;
grant execute on function public.set_comment_user_suspension(text, timestamptz, text, text) to service_role;

comment on table public.video_comments is
  'Public clip discussion. Clerk subjects and moderation state are exposed only through bounded RPCs.';
comment on function public.list_video_comments(text, integer) is
  'Public safe projection of visible comments; never returns Clerk subjects.';

