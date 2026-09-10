-- Anonymous search/suggestions use separate, bounded request budgets. No query storage.
create table private.search_v2_request_buckets (
  key_hash text not null, purpose text not null, bucket_start timestamptz not null,
  bucket_kind text not null, counter integer not null, expires_at timestamptz not null,
  primary key(key_hash,purpose,bucket_start,bucket_kind)
);
alter table private.search_v2_request_buckets enable row level security;
revoke all on private.search_v2_request_buckets from public,anon,authenticated;
grant all on private.search_v2_request_buckets to service_role;

create function private.consume_search_v2_limit(p_key text,p_purpose text) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare bucket record; amount integer; reason text; retry integer:=0;
begin
  if p_key !~ '^[0-9a-f]{64}$' or p_purpose not in ('search','suggest') then raise exception 'invalid_rate_key'; end if;
  perform pg_advisory_xact_lock(hashtextextended('search-v2-limits',0));
  delete from private.search_v2_request_buckets where expires_at<=now();
  for bucket in
    select * from (values
      (p_key,'minute',date_trunc('minute',now()),case when p_purpose='search' then 60 else 180 end),
      (p_key,'day',date_trunc('day',now() at time zone 'UTC') at time zone 'UTC',3000),
      ('global','minute',date_trunc('minute',now()),case when p_purpose='search' then 600 else 3000 end),
      ('global','day',date_trunc('day',now() at time zone 'UTC') at time zone 'UTC',case when p_purpose='search' then 20000 else 100000 end)
    ) v(key,kind,start,ceiling)
  loop
    insert into private.search_v2_request_buckets values(bucket.key,p_purpose,bucket.start,bucket.kind,1,bucket.start+interval '48 hours')
    on conflict(key_hash,purpose,bucket_start,bucket_kind) do update
      set counter=private.search_v2_request_buckets.counter+1 returning counter into amount;
    if amount>bucket.ceiling then reason:='request'; retry:=greatest(retry,case when bucket.kind='day' then 86400 else 60 end); end if;
  end loop;
  return jsonb_build_object('allowed',reason is null,'reason',reason,'retryAfterSeconds',retry);
end;
$fn$;

create function public.load_search_v2_catalog() returns jsonb
language sql stable security definer set search_path='' as $fn$
  with old as (select public.load_search_entity_catalog_cached() as data)
  select jsonb_build_object('people',(data->'people') || coalesce((
    select jsonb_agg(jsonb_build_object('id',p.id,'label',p.name,
      'party',case when p.party in ('S','M','SD','C','V','KD','MP','L') then p.party else 'NONE' end,
      'aliases',jsonb_build_array(jsonb_build_object('value',p.name,'verified',true))) order by p.name,p.id)
    from public.politicians p where exists(select 1 from private.clip_search_documents d where d.politician_id=p.id)
      and not exists(select 1 from jsonb_array_elements(data->'people') person where person->>'id'=p.id::text)
  ),'[]'::jsonb),'events',(data->'events') || coalesce((
    select jsonb_agg(jsonb_build_object('id',s.id,'label',s.title,
      'dateFrom',s.debate_date,'dateTo',s.debate_date,'dateLabel',s.debate_date::text,
      'verified',true,'aliases','[]'::jsonb,'sourceIds',jsonb_build_array(s.id)) order by s.debate_date desc,s.id)
    from public.sources s where exists(select 1 from private.clip_search_documents d where d.source_id=s.id)
      and not exists(select 1 from jsonb_array_elements(data->'events') e where e->>'id'=s.id::text)
  ),'[]'::jsonb)) from old;
$fn$;

create function public.prepare_search_v2(p_key text,p_catalog boolean default true,p_purpose text default 'search') returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare decision jsonb;
begin
  decision:=private.consume_search_v2_limit(p_key,p_purpose);
  return jsonb_build_object('rateLimit',decision,
    'indexVersion',(select semantic_index_version from private.search_system_state where singleton),
    'catalog',case when p_catalog and (decision->>'allowed')::boolean then public.load_search_v2_catalog() else null end);
end;
$fn$;

create function public.search_suggestions_v2(p_query text,p_kind text default null) returns jsonb
language sql stable security definer set search_path='' as $fn$
  with query as (select private.search_v2_fold(left(coalesce(p_query,''),300)) as value),
  catalogue as (select public.load_search_v2_catalog() as data),
  suggestions as (
    select 'person' as kind,p->>'id' as id,p->>'label' as label,p->>'party' as detail,
      private.search_v2_fold(p->>'label') as normalized,2 as priority
    from catalogue,jsonb_array_elements(data->'people') p
    union all
    select 'event',e->>'id',e->>'label',coalesce(e->>'dateLabel',''),
      private.search_v2_fold(e->>'label'),3 from catalogue,jsonb_array_elements(data->'events') e
    union all
    select 'year',extract(year from debate_date)::integer::text,
      extract(year from debate_date)::integer::text,'Debattår',extract(year from debate_date)::integer::text,1
      from private.clip_search_documents group by extract(year from debate_date)
    union all
    select 'party',v.code,v.label,'Parti',private.search_v2_fold(v.label || ' ' || v.code),2
      from (values ('S','Socialdemokraterna'),('M','Moderaterna'),('SD','Sverigedemokraterna'),
        ('C','Centerpartiet'),('V','Vänsterpartiet'),('KD','Kristdemokraterna'),
        ('MP','Miljöpartiet'),('L','Liberalerna'),('NONE','Partilös')) v(code,label)
      where exists(select 1 from private.clip_search_documents d where coalesce(d.party_at_speech,'NONE')=v.code)
  ), matched as (
    select s.* from suggestions s cross join query q
    where (p_kind is null or s.kind=p_kind) and (q.value='' or s.normalized like '%' || q.value || '%')
    order by (s.normalized=q.value) desc,(s.normalized like q.value || '%') desc,priority,
      case when kind='year' then -id::integer else 0 end,detail desc,label,id limit 12
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id,'label',label,'detail',detail)),'[]'::jsonb) from matched;
$fn$;

revoke all on function private.consume_search_v2_limit(text,text),public.load_search_v2_catalog(),
  public.prepare_search_v2(text,boolean,text),public.search_suggestions_v2(text,text) from public,anon,authenticated;
grant execute on function private.consume_search_v2_limit(text,text),public.load_search_v2_catalog(),
  public.prepare_search_v2(text,boolean,text),public.search_suggestions_v2(text,text) to service_role;
