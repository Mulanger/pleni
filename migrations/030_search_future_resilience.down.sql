-- Reverse 030_search_future_resilience.
-- Incident rollback should redeploy the previous worker instead. This reviewed
-- schema down path removes only OPT5 objects and the isolated backlog queue.

revoke all on function public.search_embedding_future_lag_sample(timestamptz, integer)
  from service_role;
revoke all on function public.search_embedding_index_status_v2()
  from service_role;
revoke all on function public.claim_search_embedding_jobs_v2(integer, integer)
  from service_role;
revoke all on function public.enqueue_search_embedding_backfill_batch(text[], boolean)
  from service_role;
revoke all on function private.enqueue_search_embedding_backfill(text, boolean)
  from service_role;

drop function if exists public.search_embedding_future_lag_sample(timestamptz, integer);
drop function if exists public.search_embedding_index_status_v2();
drop function if exists public.claim_search_embedding_jobs_v2(integer, integer);
drop function if exists public.enqueue_search_embedding_backfill_batch(text[], boolean);
drop function if exists private.enqueue_search_embedding_backfill(text, boolean);

do $queue$
begin
  if exists (
    select 1 from pgmq.meta where queue_name = 'search_embeddings_backfill'
  ) then
    perform pgmq.drop_queue('search_embeddings_backfill');
  end if;
end;
$queue$;
