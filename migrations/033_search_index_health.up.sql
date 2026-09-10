-- Search V2: aggregate index health. Never contains viewer/query data.
create table private.search_index_health_samples (
  sampled_at timestamptz primary key default now(),
  eligible integer not null,
  keyword_current integer not null,
  semantic_current integer not null,
  pending integer not null,
  alerts text[] not null default '{}'
);
alter table private.search_index_health_samples enable row level security;
revoke all on private.search_index_health_samples from public, anon, authenticated;
grant select, insert, delete on private.search_index_health_samples to service_role;

create function public.search_index_health()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  with state as (select * from private.search_system_state where singleton),
  coverage as (
    select extract(year from c.debate_date)::integer as year,
      count(*)::integer as eligible,
      count(d.clip_id) filter (where d.source_hash=c.source_hash and d.debate_date=c.debate_date
        and d.source_title=c.source_title and d.politician_id is not distinct from c.politician_id
        and d.party_at_speech is not distinct from c.party_at_speech)::integer as keyword_current,
      count(*) filter (where d.semantic_state = 'current'
        and d.completed_index_version = s.semantic_index_version and d.source_hash=c.source_hash
        and exists (select 1 from private.clip_search_chunks ch
          where ch.clip_id = d.clip_id and ch.source_hash = d.source_hash
            and ch.index_version = s.semantic_index_version))::integer as semantic_current,
      count(*) filter (where d.semantic_state = 'failed')::integer as failed,
      min(coalesce(d.semantic_updated_at,d.keyword_indexed_at)) filter (where d.semantic_state in ('pending','processing')) as oldest_pending
    from private.clip_search_document_input() c cross join state s
    left join private.clip_search_documents d on d.clip_id = c.clip_id group by 1
  ), totals as (
    select coalesce(sum(eligible),0)::integer as eligible,
      coalesce(sum(keyword_current),0)::integer as keyword_current,
      coalesce(sum(semantic_current),0)::integer as semantic_current,
      coalesce(sum(failed),0)::integer as failed,
      min(oldest_pending) as oldest_pending from coverage
  ), previous as (
    select * from private.search_index_health_samples order by sampled_at desc limit 1
  )
  select jsonb_build_object(
    'indexVersion', s.semantic_index_version,
    'workerEnabled', s.provider_enabled and not s.provider_kill_switch,
    'eligible', t.eligible, 'keywordCurrent', t.keyword_current,
    'semanticCurrent', t.semantic_current, 'pending', t.eligible-t.semantic_current,
    'failed', t.failed, 'oldestPendingAt', t.oldest_pending,
    'years', coalesce((select jsonb_agg(to_jsonb(c) order by c.year) from coverage c),'[]'::jsonb),
    'alerts', to_jsonb(array_remove(array[
      case when t.eligible <> t.keyword_current then 'keyword_coverage_gap' end,
      case when t.eligible > t.semantic_current and (not s.provider_enabled or s.provider_kill_switch)
        then 'index_worker_stopped' end,
      case when t.failed > 0 then 'index_jobs_failed' end,
      case when t.oldest_pending < now()-interval '10 minutes' then 'index_queue_stale' end,
      case when t.eligible-t.semantic_current > coalesce((select pending from previous),t.eligible)
        then 'index_queue_growing' end,
      case when t.semantic_current < coalesce((select semantic_current from previous),0)
        then 'semantic_coverage_dropped' end
    ],null))
  ) from totals t cross join state s;
$fn$;
revoke all on function public.search_index_health() from public, anon, authenticated;
grant execute on function public.search_index_health() to service_role;

create function private.sample_search_index_health()
returns void language plpgsql security definer set search_path = '' as $fn$
declare health jsonb;
begin
  health := public.search_index_health();
  insert into private.search_index_health_samples
    (eligible,keyword_current,semantic_current,pending,alerts)
  values ((health->>'eligible')::integer,(health->>'keywordCurrent')::integer,
    (health->>'semanticCurrent')::integer,(health->>'pending')::integer,
    array(select jsonb_array_elements_text(health->'alerts')));
  delete from private.search_index_health_samples where sampled_at < now()-interval '14 days';
  if jsonb_array_length(health->'alerts') > 0 then
    raise warning 'search_index_health_alert: %', health->'alerts';
  end if;
end;
$fn$;
revoke all on function private.sample_search_index_health() from public, anon, authenticated;
grant execute on function private.sample_search_index_health() to service_role;
select cron.schedule('search-index-health-v1','*/5 * * * *','select private.sample_search_index_health();');

create function public.repair_search_index(p_clip_ids text[]) returns integer
language plpgsql security definer set search_path='' as $fn$
declare clip text; repaired integer:=0;
begin
  if cardinality(p_clip_ids)>200 then raise exception 'repair_batch_too_large'; end if;
  for clip in select distinct unnest(p_clip_ids) loop
    perform private.refresh_clip_search_document(clip);
    if private.enqueue_search_embedding_backfill(clip,false) is not null then repaired:=repaired+1; end if;
  end loop;
  return repaired;
end;
$fn$;
revoke all on function public.repair_search_index(text[]) from public,anon,authenticated;
grant execute on function public.repair_search_index(text[]) to service_role;
