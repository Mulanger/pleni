-- 024_search_embeddings
--
-- Versioned, asynchronous semantic indexing for private topic search. Public
-- catalogue writes only enqueue Postgres work; OpenAI is called later by a
-- secret-authenticated Edge worker. Existing documents are intentionally not
-- enqueued here: UI16.5 owns the measured, separately approved paid backfill.

do $preflight$
begin
  if to_regclass('private.clip_search_documents') is null
    or to_regclass('private.search_system_state') is null then
    raise exception 'topic-search foundation is missing; apply migration 022 first';
  end if;

  if not exists (select 1 from pg_available_extensions where name = 'vector')
    or not exists (select 1 from pg_available_extensions where name = 'pgmq')
    or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise exception 'vector, pgmq and pg_net must be available before migration 024';
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron must be installed before migration 024';
  end if;

  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault is required for the search worker dispatcher';
  end if;
end;
$preflight$;

create extension if not exists vector with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_net with schema extensions;

do $extension_contract$
begin
  if to_regtype('extensions.halfvec') is null
    or to_regprocedure('pgmq.read(text,integer,integer,jsonb)') is null
    or to_regprocedure('pgmq.set_vt(text,bigint,integer)') is null
    or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'hosted extension APIs do not match the migration 024 contract';
  end if;
end;
$extension_contract$;

do $queue$
begin
  if not exists (
    select 1 from pgmq.meta where queue_name = 'search_embeddings'
  ) then
    perform pgmq.create('search_embeddings');
  end if;
end;
$queue$;

create table private.clip_search_chunks (
  clip_id text not null
    references private.clip_search_documents(clip_id) on delete cascade,
  chunk_no integer not null,
  passage text not null,
  char_start integer not null,
  char_end integer not null,
  content_hash text not null,
  source_hash text not null,
  index_version text not null,
  embedding extensions.halfvec(1024) not null,
  created_at timestamptz not null default now(),
  primary key (clip_id, chunk_no),
  constraint clip_search_chunks_number check (chunk_no >= 0),
  constraint clip_search_chunks_passage
    check (char_length(passage) between 1 and 700),
  constraint clip_search_chunks_offsets
    check (char_start >= 0 and char_end > char_start),
  constraint clip_search_chunks_content_hash
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint clip_search_chunks_source_hash
    check (source_hash ~ '^[0-9a-f]{64}$'),
  constraint clip_search_chunks_index_version
    check (char_length(index_version) between 3 and 120)
);

create index clip_search_chunks_embedding_hnsw_idx
  on private.clip_search_chunks
  using hnsw (embedding extensions.halfvec_cosine_ops);
create index clip_search_chunks_version_clip_idx
  on private.clip_search_chunks (index_version, clip_id, chunk_no);
create index clip_search_chunks_source_hash_idx
  on private.clip_search_chunks (clip_id, source_hash, index_version);

alter table private.clip_search_chunks enable row level security;
revoke all on private.clip_search_chunks from public, anon, authenticated;
grant all on private.clip_search_chunks to service_role;

revoke all on schema pgmq from public, anon, authenticated;
revoke all on table pgmq.q_search_embeddings from public, anon, authenticated;
revoke all on table pgmq.a_search_embeddings from public, anon, authenticated;
revoke all on sequence pgmq.q_search_embeddings_msg_id_seq
  from public, anon, authenticated;

create or replace function private.normalize_search_embedding_text(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select pg_catalog.btrim(
    pg_catalog.regexp_replace(coalesce(p_value, ''), '[[:space:] ]+', ' ', 'g')
  );
$function$;

create or replace function private.enqueue_search_embedding(
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

  select state.semantic_index_version
  into target_version
  from private.search_system_state state
  where state.singleton;

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
      select 1
      from private.clip_search_chunks chunk
      where chunk.clip_id = document.clip_id
        and chunk.source_hash = document.source_hash
        and chunk.index_version = target_version
    ) then
    return null;
  end if;

  select queue_message.msg_id
  into existing_message_id
  from pgmq.q_search_embeddings queue_message
  where queue_message.message ->> 'clipId' = document.clip_id
    and queue_message.message ->> 'sourceHash' = document.source_hash
    and queue_message.message ->> 'indexVersion' = target_version
  order by queue_message.msg_id
  limit 1;

  if existing_message_id is null then
    select sent.msg_id into queued_message_id
    from pgmq.send(
      'search_embeddings',
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
  set
    semantic_state = 'pending',
    requested_index_version = target_version,
    completed_index_version = null,
    semantic_last_error = null,
    semantic_updated_at = now()
  where search_document.clip_id = document.clip_id;

  return queued_message_id;
end;
$function$;

create or replace function private.queue_search_embedding_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT'
    or old.source_hash is distinct from new.source_hash then
    perform private.enqueue_search_embedding(new.clip_id, false);
  end if;
  return new;
end;
$function$;

drop trigger if exists clip_search_documents_queue_embedding
  on private.clip_search_documents;
create trigger clip_search_documents_queue_embedding
after insert or update of source_hash
on private.clip_search_documents
for each row execute function private.queue_search_embedding_trigger();

create or replace function public.enqueue_search_embedding_batch(
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
    if private.enqueue_search_embedding(requested_clip_id, p_force) is not null then
      accepted := accepted + 1;
    end if;
  end loop;
  return accepted;
end;
$function$;

create or replace function public.claim_search_embedding_jobs(
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
  state private.search_system_state%rowtype;
  queued_message pgmq.message_record;
  document private.clip_search_documents%rowtype;
  message_clip_id text;
  message_source_hash text;
  message_index_version text;
begin
  effective_limit := pg_catalog.greatest(1, pg_catalog.least(coalesce(p_limit, 5), 10));
  effective_visibility := pg_catalog.greatest(
    30,
    pg_catalog.least(coalesce(p_visibility_timeout_seconds, 120), 900)
  );

  select * into state
  from private.search_system_state system_state
  where system_state.singleton;
  if not state.provider_enabled
    or state.provider_kill_switch
    or state.semantic_index_version is null then
    return;
  end if;

  for queued_message in
    select * from pgmq.read(
      'search_embeddings',
      effective_visibility,
      effective_limit,
      '{}'::jsonb
    )
  loop
    message_clip_id := queued_message.message ->> 'clipId';
    message_source_hash := queued_message.message ->> 'sourceHash';
    message_index_version := queued_message.message ->> 'indexVersion';

    if nullif(message_clip_id, '') is null
      or coalesce(message_source_hash, '') !~ '^[0-9a-f]{64}$'
      or nullif(message_index_version, '') is null then
      perform pgmq.archive('search_embeddings', queued_message.msg_id);
      continue;
    end if;

    select * into document
    from private.clip_search_documents search_document
    where search_document.clip_id = message_clip_id
    for update;

    if not found or not exists (
      select 1
      from public.clips clip
      where clip.id = message_clip_id
        and clip.published_at is not null
        and clip.moderation <> 'rejected'
    ) then
      delete from private.clip_search_documents where clip_id = message_clip_id;
      perform pgmq.delete('search_embeddings', queued_message.msg_id);
      continue;
    end if;

    if message_source_hash <> document.source_hash
      or message_index_version <> state.semantic_index_version then
      perform pgmq.delete('search_embeddings', queued_message.msg_id);
      perform private.enqueue_search_embedding(document.clip_id, false);
      continue;
    end if;

    if queued_message.read_ct > 5 then
      perform pgmq.archive('search_embeddings', queued_message.msg_id);
      update private.clip_search_documents search_document
      set
        semantic_state = 'failed',
        requested_index_version = message_index_version,
        completed_index_version = null,
        semantic_last_error = 'worker_visibility_expired',
        semantic_updated_at = now()
      where search_document.clip_id = document.clip_id;
      continue;
    end if;

    if document.semantic_state = 'current'
      and document.completed_index_version = message_index_version
      and exists (
        select 1
        from private.clip_search_chunks chunk
        where chunk.clip_id = document.clip_id
          and chunk.source_hash = document.source_hash
          and chunk.index_version = message_index_version
      ) then
      perform pgmq.delete('search_embeddings', queued_message.msg_id);
      continue;
    end if;

    update private.clip_search_documents search_document
    set
      semantic_state = 'processing',
      requested_index_version = message_index_version,
      completed_index_version = null,
      semantic_last_error = null,
      semantic_updated_at = now()
    where search_document.clip_id = document.clip_id;

    msg_id := queued_message.msg_id;
    read_ct := queued_message.read_ct;
    clip_id := document.clip_id;
    source_hash := document.source_hash;
    index_version := message_index_version;
    title := document.title;
    transcript := document.transcript;
    return next;
  end loop;
end;
$function$;

create or replace function public.complete_search_embedding_job(
  p_msg_id bigint,
  p_clip_id text,
  p_source_hash text,
  p_index_version text,
  p_chunks jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  document private.clip_search_documents%rowtype;
  target_version text;
  candidate jsonb;
  expected_chunk_no integer := 0;
  candidate_chunk_no integer;
  candidate_start integer;
  candidate_end integer;
  previous_end integer := null;
  normalized_title text;
  normalized_document text;
  expected_content_hash text;
  parsed_embedding extensions.halfvec(1024);
begin
  if not exists (
    select 1 from pgmq.q_search_embeddings queue_message
    where queue_message.msg_id = p_msg_id
    for update
  ) then
    return 'missing';
  end if;

  select * into document
  from private.clip_search_documents search_document
  where search_document.clip_id = p_clip_id
  for update;
  select state.semantic_index_version into target_version
  from private.search_system_state state
  where state.singleton;

  if document.clip_id is null
    or document.source_hash <> p_source_hash
    or target_version is distinct from p_index_version then
    perform pgmq.delete('search_embeddings', p_msg_id);
    if document.clip_id is not null then
      perform private.enqueue_search_embedding(document.clip_id, false);
    end if;
    return 'stale';
  end if;

  if p_chunks is null
    or pg_catalog.jsonb_typeof(p_chunks) <> 'array'
    or pg_catalog.jsonb_array_length(p_chunks) < 1
    or pg_catalog.jsonb_array_length(p_chunks) > 64 then
    raise exception 'invalid_search_embedding_chunks' using errcode = '22023';
  end if;

  normalized_title := private.normalize_search_embedding_text(document.title);
  normalized_document := private.normalize_search_embedding_text(document.transcript);
  if normalized_document = '' then
    normalized_document := normalized_title;
  end if;

  for candidate in select value from pg_catalog.jsonb_array_elements(p_chunks)
  loop
    if pg_catalog.jsonb_typeof(candidate) is distinct from 'object'
      or coalesce(candidate ->> 'chunkNo', '') !~ '^[0-9]+$'
      or coalesce(candidate ->> 'charStart', '') !~ '^[0-9]+$'
      or coalesce(candidate ->> 'charEnd', '') !~ '^[0-9]+$'
      or pg_catalog.jsonb_typeof(candidate -> 'passage') is distinct from 'string'
      or coalesce(candidate ->> 'contentHash', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(candidate -> 'embedding') is distinct from 'array'
      or pg_catalog.jsonb_array_length(candidate -> 'embedding') <> 1024
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(candidate -> 'embedding') component
        where pg_catalog.jsonb_typeof(component) <> 'number'
      ) then
      raise exception 'invalid_search_embedding_chunk' using errcode = '22023';
    end if;

    candidate_chunk_no := (candidate ->> 'chunkNo')::integer;
    candidate_start := (candidate ->> 'charStart')::integer;
    candidate_end := (candidate ->> 'charEnd')::integer;
    if candidate_chunk_no <> expected_chunk_no
      or candidate_start < 0
      or candidate_end <= candidate_start
      or candidate_end > pg_catalog.char_length(normalized_document)
      or pg_catalog.char_length(candidate ->> 'passage') > 700
      or candidate ->> 'passage' <> pg_catalog.substr(
        normalized_document,
        candidate_start + 1,
        candidate_end - candidate_start
      )
      or (expected_chunk_no = 0 and candidate_start <> 0)
      or (
        expected_chunk_no > 0
        and (candidate_start >= previous_end or candidate_end <= previous_end)
      ) then
      raise exception 'invalid_search_embedding_chunk_offsets' using errcode = '22023';
    end if;

    expected_content_hash := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          p_index_version || pg_catalog.chr(31) ||
          case
            when normalized_title = '' then candidate ->> 'passage'
            else normalized_title || E'\n\n' || (candidate ->> 'passage')
          end,
          'UTF8'
        )
      ),
      'hex'
    );
    if candidate ->> 'contentHash' <> expected_content_hash then
      raise exception 'invalid_search_embedding_chunk_hash' using errcode = '22023';
    end if;

    begin
      parsed_embedding := (candidate -> 'embedding')::text::extensions.halfvec(1024);
      if extensions.vector_dims(parsed_embedding) <> 1024 then
        raise exception 'wrong_dimensions';
      end if;
    exception when others then
      raise exception 'invalid_search_embedding_vector' using errcode = '22023';
    end;

    previous_end := candidate_end;
    expected_chunk_no := expected_chunk_no + 1;
  end loop;

  if previous_end <> pg_catalog.char_length(normalized_document) then
    raise exception 'incomplete_search_embedding_chunks' using errcode = '22023';
  end if;

  delete from private.clip_search_chunks chunk where chunk.clip_id = p_clip_id;
  insert into private.clip_search_chunks (
    clip_id,
    chunk_no,
    passage,
    char_start,
    char_end,
    content_hash,
    source_hash,
    index_version,
    embedding,
    created_at
  )
  select
    p_clip_id,
    (candidate.value ->> 'chunkNo')::integer,
    candidate.value ->> 'passage',
    (candidate.value ->> 'charStart')::integer,
    (candidate.value ->> 'charEnd')::integer,
    candidate.value ->> 'contentHash',
    p_source_hash,
    p_index_version,
    (candidate.value -> 'embedding')::text::extensions.halfvec(1024),
    now()
  from pg_catalog.jsonb_array_elements(p_chunks) with ordinality candidate(value, position)
  order by candidate.position;

  update private.clip_search_documents search_document
  set
    semantic_state = 'current',
    requested_index_version = p_index_version,
    completed_index_version = p_index_version,
    semantic_last_error = null,
    semantic_updated_at = now()
  where search_document.clip_id = p_clip_id
    and search_document.source_hash = p_source_hash;

  perform pgmq.delete('search_embeddings', p_msg_id);
  return 'completed';
end;
$function$;

create or replace function public.fail_search_embedding_job(
  p_msg_id bigint,
  p_clip_id text,
  p_source_hash text,
  p_index_version text,
  p_error_code text,
  p_retryable boolean default true
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  message_read_count integer;
  document private.clip_search_documents%rowtype;
  target_version text;
  retry_delay_seconds integer;
  safe_error_code text;
begin
  select queue_message.read_ct into message_read_count
  from pgmq.q_search_embeddings queue_message
  where queue_message.msg_id = p_msg_id
  for update;
  if not found then
    return 'missing';
  end if;

  select * into document
  from private.clip_search_documents search_document
  where search_document.clip_id = p_clip_id
  for update;
  select state.semantic_index_version into target_version
  from private.search_system_state state
  where state.singleton;

  if document.clip_id is null
    or document.source_hash <> p_source_hash
    or target_version is distinct from p_index_version then
    perform pgmq.delete('search_embeddings', p_msg_id);
    if document.clip_id is not null then
      perform private.enqueue_search_embedding(document.clip_id, false);
    end if;
    return 'stale';
  end if;

  safe_error_code := case
    when coalesce(p_error_code, '') ~ '^[a-z0-9_:-]{1,120}$' then p_error_code
    else 'worker_error'
  end;

  if not coalesce(p_retryable, true) or message_read_count >= 5 then
    perform pgmq.archive('search_embeddings', p_msg_id);
    update private.clip_search_documents search_document
    set
      semantic_state = 'failed',
      requested_index_version = p_index_version,
      completed_index_version = null,
      semantic_last_error = safe_error_code,
      semantic_updated_at = now()
    where search_document.clip_id = p_clip_id
      and search_document.source_hash = p_source_hash;
    return 'failed';
  end if;

  retry_delay_seconds := pg_catalog.least(
    900,
    (30 * pg_catalog.power(2, pg_catalog.greatest(message_read_count - 1, 0)))::integer
  );
  perform pgmq.set_vt('search_embeddings', p_msg_id, retry_delay_seconds);
  update private.clip_search_documents search_document
  set
    semantic_state = 'pending',
    requested_index_version = p_index_version,
    completed_index_version = null,
    semantic_last_error = safe_error_code,
    semantic_updated_at = now()
  where search_document.clip_id = p_clip_id
    and search_document.source_hash = p_source_hash;
  return 'retry_scheduled';
end;
$function$;

create or replace function public.search_embedding_index_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  state private.search_system_state%rowtype;
  queue_status pgmq.metrics_result;
  archived_count bigint;
begin
  select * into state
  from private.search_system_state system_state
  where system_state.singleton;
  select * into queue_status from pgmq.metrics('search_embeddings');
  select pg_catalog.count(*) into archived_count
  from pgmq.a_search_embeddings;

  return pg_catalog.jsonb_build_object(
    'indexVersion', state.semantic_index_version,
    'providerEnabled', state.provider_enabled,
    'killSwitch', state.provider_kill_switch,
    'documents', (select pg_catalog.count(*) from private.clip_search_documents),
    'currentDocuments', (
      select pg_catalog.count(*)
      from private.clip_search_documents document
      where document.semantic_state = 'current'
        and document.completed_index_version = state.semantic_index_version
        and exists (
          select 1 from private.clip_search_chunks chunk
          where chunk.clip_id = document.clip_id
            and chunk.source_hash = document.source_hash
            and chunk.index_version = state.semantic_index_version
        )
    ),
    'pendingDocuments', (
      select pg_catalog.count(*) from private.clip_search_documents
      where semantic_state = 'pending'
    ),
    'processingDocuments', (
      select pg_catalog.count(*) from private.clip_search_documents
      where semantic_state = 'processing'
    ),
    'failedDocuments', (
      select pg_catalog.count(*) from private.clip_search_documents
      where semantic_state = 'failed'
    ),
    'chunks', (select pg_catalog.count(*) from private.clip_search_chunks),
    'queuedMessages', queue_status.queue_length,
    'visibleMessages', queue_status.queue_visible_length,
    'archivedMessages', archived_count
  );
end;
$function$;

create or replace function private.dispatch_search_embedding_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  state private.search_system_state%rowtype;
  function_url text;
  worker_secret text;
  request_id bigint;
begin
  select * into state
  from private.search_system_state system_state
  where system_state.singleton;
  if not state.provider_enabled or state.provider_kill_switch then
    return null;
  end if;

  select secret.decrypted_secret into function_url
  from vault.decrypted_secrets secret
  where secret.name = 'search_embed_function_url'
  limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets secret
  where secret.name = 'search_embed_worker_secret'
  limit 1;
  if nullif(function_url, '') is null or nullif(worker_secret, '') is null then
    return null;
  end if;

  select net.http_post(
    url := function_url,
    body := '{}'::jsonb,
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Search-Worker-Secret', worker_secret
    ),
    timeout_milliseconds := 5000
  ) into request_id;
  return request_id;
end;
$function$;

revoke all on function private.normalize_search_embedding_text(text)
  from public, anon, authenticated;
revoke all on function private.enqueue_search_embedding(text, boolean)
  from public, anon, authenticated;
revoke all on function private.queue_search_embedding_trigger()
  from public, anon, authenticated;
revoke all on function private.dispatch_search_embedding_worker()
  from public, anon, authenticated;
revoke all on function public.enqueue_search_embedding_batch(text[], boolean)
  from public, anon, authenticated;
revoke all on function public.claim_search_embedding_jobs(integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_search_embedding_job(
  bigint, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_search_embedding_job(
  bigint, text, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.search_embedding_index_status()
  from public, anon, authenticated;

grant execute on function private.normalize_search_embedding_text(text)
  to service_role;
grant execute on function private.enqueue_search_embedding(text, boolean)
  to service_role;
grant execute on function private.queue_search_embedding_trigger()
  to service_role;
grant execute on function private.dispatch_search_embedding_worker()
  to service_role;
grant execute on function public.enqueue_search_embedding_batch(text[], boolean)
  to service_role;
grant execute on function public.claim_search_embedding_jobs(integer, integer)
  to service_role;
grant execute on function public.complete_search_embedding_job(
  bigint, text, text, text, jsonb
) to service_role;
grant execute on function public.fail_search_embedding_job(
  bigint, text, text, text, text, boolean
) to service_role;
grant execute on function public.search_embedding_index_status()
  to service_role;

update private.search_system_state
set
  semantic_index_version = 'openai:text-embedding-3-large:1024:v1',
  provider_enabled = false,
  provider_kill_switch = true,
  updated_at = now()
where singleton;

do $schedule$
begin
  if exists (
    select 1 from cron.job where jobname = 'search-embed-dispatch-v1'
  ) then
    perform cron.unschedule('search-embed-dispatch-v1');
  end if;
  perform cron.schedule(
    'search-embed-dispatch-v1',
    '* * * * *',
    'select private.dispatch_search_embedding_worker();'
  );
end;
$schedule$;

comment on table private.clip_search_chunks is
  'Versioned private semantic passages. Browser roles have no access.';
comment on function public.claim_search_embedding_jobs(integer, integer) is
  'Service-only PGMQ claim path; returns no work while the provider gate is off.';
comment on function public.complete_search_embedding_job(bigint, text, text, text, jsonb) is
  'Service-only all-or-nothing validation and replacement of one clip semantic index.';
