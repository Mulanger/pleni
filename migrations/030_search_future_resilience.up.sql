-- 030_search_future_resilience
--
-- Keep normal publication indexing ahead of arbitrarily large historical
-- backfills. Fresh C11 lifecycle work remains in search_embeddings. Operator
-- backfill is isolated in search_embeddings_backfill and promoted in bounded
-- batches only after the fresh queue has no claimable work.

do $preflight$
begin
  if to_regprocedure('public.claim_search_embedding_jobs(integer,integer)') is null
    or to_regprocedure('private.enqueue_search_embedding(text,boolean)') is null
    or to_regprocedure('pgmq.create(text)') is null
    or to_regprocedure('pgmq.read(text,integer,integer,jsonb)') is null then
    raise exception 'search embedding queue prerequisites are missing';
  end if;
end;
$preflight$;

do $queue$
begin
  if not exists (
    select 1 from pgmq.meta where queue_name = 'search_embeddings_backfill'
  ) then
    perform pgmq.create('search_embeddings_backfill');
  end if;
end;
$queue$;

create or replace function private.enqueue_search_embedding_backfill(
  p_clip_id text,
  p_force boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  document private.clip_search_documents%rowtype;
  target_version text;
  existing_message_id bigint;
  queued_message_id bigint;
begin
  if p_clip_id is null then
    return null;
  end if;

  select state.semantic_index_version into target_version
  from private.search_system_state state where state.singleton;
  if target_version is null then
    return null;
  end if;

  select * into document
  from private.clip_search_documents search_document
  where search_document.clip_id = p_clip_id
  for update;
  if not found then
    return null;
  end if;

  if not p_force
    and document.semantic_state = 'current'
    and document.completed_index_version = target_version
    and exists (
      select 1 from private.clip_search_chunks chunk
      where chunk.clip_id = document.clip_id
        and chunk.source_hash = document.source_hash
        and chunk.index_version = target_version
    ) then
    return null;
  end if;

  select message_id into existing_message_id
  from (
    select queue_message.msg_id as message_id
    from pgmq.q_search_embeddings queue_message
    where queue_message.message ->> 'clipId' = document.clip_id
      and queue_message.message ->> 'sourceHash' = document.source_hash
      and queue_message.message ->> 'indexVersion' = target_version
    union all
    select queue_message.msg_id
    from pgmq.q_search_embeddings_backfill queue_message
    where queue_message.message ->> 'clipId' = document.clip_id
      and queue_message.message ->> 'sourceHash' = document.source_hash
      and queue_message.message ->> 'indexVersion' = target_version
  ) queued
  order by message_id
  limit 1;

  if existing_message_id is null then
    select sent.msg_id into queued_message_id
    from pgmq.send(
      'search_embeddings_backfill',
      pg_catalog.jsonb_build_object(
        'clipId', document.clip_id,
        'sourceHash', document.source_hash,
        'indexVersion', target_version
      )
    ) sent(msg_id);
  else
    queued_message_id := existing_message_id;
  end if;

  update private.clip_search_documents search_document
  set semantic_state = 'pending',
      requested_index_version = target_version,
      completed_index_version = null,
      semantic_last_error = null,
      semantic_updated_at = now()
  where search_document.clip_id = document.clip_id;

  return queued_message_id;
end;
$function$;

create or replace function public.enqueue_search_embedding_backfill_batch(
  p_clip_ids text[],
  p_force boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  requested_clip_id text;
  accepted integer := 0;
begin
  if p_clip_ids is null
    or pg_catalog.cardinality(p_clip_ids) = 0
    or pg_catalog.cardinality(p_clip_ids) > 200 then
    raise exception 'clip_id_batch_must_contain_1_to_200_items'
      using errcode = '22023';
  end if;

  for requested_clip_id in
    select distinct candidate
    from pg_catalog.unnest(p_clip_ids) candidate
    where nullif(pg_catalog.btrim(candidate), '') is not null
    order by candidate
  loop
    if private.enqueue_search_embedding_backfill(requested_clip_id, p_force) is not null then
      accepted := accepted + 1;
    end if;
  end loop;
  return accepted;
end;
$function$;

create or replace function public.claim_search_embedding_jobs_v2(
  p_limit integer default 5,
  p_visibility_timeout_seconds integer default 120
)
returns table (
  msg_id bigint,
  read_ct integer,
  clip_id text,
  source_hash text,
  index_version text,
  title text,
  transcript text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  effective_limit integer;
  effective_visibility integer;
  fresh_count integer := 0;
  remaining integer;
  state private.search_system_state%rowtype;
  backlog_message pgmq.message_record;
begin
  effective_limit := greatest(1, least(coalesce(p_limit, 5), 10));
  effective_visibility := greatest(
    30,
    least(coalesce(p_visibility_timeout_seconds, 120), 900)
  );

  select * into state
  from private.search_system_state system_state
  where system_state.singleton;
  if not state.provider_enabled
    or state.provider_kill_switch
    or state.semantic_index_version is null then
    return;
  end if;

  return query
  select * from public.claim_search_embedding_jobs(
    effective_limit,
    effective_visibility
  );
  get diagnostics fresh_count = row_count;
  remaining := effective_limit - fresh_count;
  if remaining <= 0 then
    return;
  end if;

  for backlog_message in
    select * from pgmq.read(
      'search_embeddings_backfill',
      effective_visibility,
      remaining,
      '{}'::jsonb
    )
  loop
    perform private.enqueue_search_embedding(
      backlog_message.message ->> 'clipId',
      false
    );
    perform pgmq.delete('search_embeddings_backfill', backlog_message.msg_id);
  end loop;

  return query
  select * from public.claim_search_embedding_jobs(
    remaining,
    effective_visibility
  );
end;
$function$;

create or replace function public.search_embedding_index_status_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  base_status jsonb;
  backlog_status pgmq.metrics_result;
begin
  select public.search_embedding_index_status() into base_status;
  select * into backlog_status from pgmq.metrics('search_embeddings_backfill');
  return base_status || pg_catalog.jsonb_build_object(
    'eligibleDocuments', (
      select pg_catalog.count(*) from public.clips clip
      where clip.published_at is not null and clip.moderation <> 'rejected'
    ),
    'keywordCoverageComplete', (
      (base_status ->> 'documents')::bigint = (
        select pg_catalog.count(*) from public.clips clip
        where clip.published_at is not null and clip.moderation <> 'rejected'
      )
    ),
    'freshQueuedMessages', base_status -> 'queuedMessages',
    'freshVisibleMessages', base_status -> 'visibleMessages',
    'backfillQueuedMessages', backlog_status.queue_length,
    'backfillVisibleMessages', backlog_status.queue_visible_length
  );
end;
$function$;

create or replace function public.search_embedding_future_lag_sample(
  p_published_after timestamptz,
  p_limit integer default 20
)
returns table (
  clip_id text,
  index_version text,
  published_at timestamptz,
  keyword_current_at timestamptz,
  semantic_current_at timestamptz,
  keyword_lag_ms bigint,
  semantic_lag_ms bigint,
  semantic_state text,
  has_current_chunks boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    document.clip_id,
    state.semantic_index_version,
    clip.published_at,
    document.keyword_indexed_at,
    case when document.semantic_state = 'current'
      and document.completed_index_version = state.semantic_index_version
      and exists (
        select 1 from private.clip_search_chunks chunk
        where chunk.clip_id = document.clip_id
          and chunk.source_hash = document.source_hash
          and chunk.index_version = state.semantic_index_version
      ) then document.semantic_updated_at else null end,
    greatest(
      0,
      (extract(epoch from (document.keyword_indexed_at - clip.published_at)) * 1000)::bigint
    ),
    case when document.semantic_state = 'current'
      and document.completed_index_version = state.semantic_index_version
      and exists (
        select 1 from private.clip_search_chunks chunk
        where chunk.clip_id = document.clip_id
          and chunk.source_hash = document.source_hash
          and chunk.index_version = state.semantic_index_version
      ) then greatest(
        0,
        (extract(epoch from (document.semantic_updated_at - clip.published_at)) * 1000)::bigint
      ) else null end,
    document.semantic_state,
    exists (
      select 1 from private.clip_search_chunks chunk
      where chunk.clip_id = document.clip_id
        and chunk.source_hash = document.source_hash
        and chunk.index_version = state.semantic_index_version
    )
  from public.clips clip
  join private.clip_search_documents document on document.clip_id = clip.id
  cross join private.search_system_state state
  where state.singleton
    and p_published_after is not null
    and clip.published_at >= p_published_after
    and clip.moderation <> 'rejected'
  order by clip.published_at, clip.id
  limit greatest(1, least(coalesce(p_limit, 20), 200));
$function$;

revoke all on function private.enqueue_search_embedding_backfill(text, boolean)
  from public, anon, authenticated;
revoke all on function public.enqueue_search_embedding_backfill_batch(text[], boolean)
  from public, anon, authenticated;
revoke all on function public.claim_search_embedding_jobs_v2(integer, integer)
  from public, anon, authenticated;
revoke all on function public.search_embedding_index_status_v2()
  from public, anon, authenticated;
revoke all on function public.search_embedding_future_lag_sample(timestamptz, integer)
  from public, anon, authenticated;

grant execute on function private.enqueue_search_embedding_backfill(text, boolean)
  to service_role;
grant execute on function public.enqueue_search_embedding_backfill_batch(text[], boolean)
  to service_role;
grant execute on function public.claim_search_embedding_jobs_v2(integer, integer)
  to service_role;
grant execute on function public.search_embedding_index_status_v2()
  to service_role;
grant execute on function public.search_embedding_future_lag_sample(timestamptz, integer)
  to service_role;
