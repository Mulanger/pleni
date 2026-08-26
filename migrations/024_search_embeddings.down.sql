-- 024_search_embeddings rollback
--
-- Removes the semantic lifecycle only. Keyword documents/search remain live.
-- Shared hosted extensions stay installed because another feature may use them.

do $unschedule$
begin
  if exists (
    select 1 from cron.job where jobname = 'search-embed-dispatch-v1'
  ) then
    perform cron.unschedule('search-embed-dispatch-v1');
  end if;
end;
$unschedule$;

drop trigger if exists clip_search_documents_queue_embedding
  on private.clip_search_documents;

drop function if exists public.search_embedding_index_status();
drop function if exists public.fail_search_embedding_job(
  bigint, text, text, text, text, boolean
);
drop function if exists public.complete_search_embedding_job(
  bigint, text, text, text, jsonb
);
drop function if exists public.claim_search_embedding_jobs(integer, integer);
drop function if exists public.enqueue_search_embedding_batch(text[], boolean);
drop function if exists private.dispatch_search_embedding_worker();
drop function if exists private.queue_search_embedding_trigger();
drop function if exists private.enqueue_search_embedding(text, boolean);
drop function if exists private.normalize_search_embedding_text(text);

drop table if exists private.clip_search_chunks;

do $queue$
begin
  if to_regclass('pgmq.q_search_embeddings') is not null then
    perform pgmq.drop_queue('search_embeddings');
  end if;
end;
$queue$;

update private.clip_search_documents
set
  semantic_state = 'pending',
  requested_index_version = null,
  completed_index_version = null,
  semantic_last_error = null,
  semantic_updated_at = now();

update private.search_system_state
set
  semantic_index_version = null,
  provider_enabled = false,
  provider_kill_switch = true,
  updated_at = now()
where singleton;
