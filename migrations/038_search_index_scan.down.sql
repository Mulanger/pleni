-- Bound semantic candidate work before lexical coverage scoring. Keyword and year traversal stay complete.
create or replace function public.search_clips_v2(
  p_topic text default null, p_embedding text default null, p_limit integer default 20,
  p_person uuid default null, p_party text default null, p_from date default null,
  p_to date default null, p_sources uuid[] default null, p_sort text default 'relevance',
  p_after jsonb default null, p_snapshot timestamptz default now()
) returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $fn$
<<search_v2>>
declare topic text:=nullif(btrim(p_topic),''); exact_query tsquery; expanded tsquery;
  vector extensions.halfvec(1024); index_version text; rows jsonb; total integer;
  covered integer; page_size integer:=greatest(1,least(coalesce(p_limit,20),40));
begin
  if length(topic)>300 then raise exception 'query_too_long' using errcode='22023'; end if;
  if p_sort not in ('relevance','newest','oldest') then raise exception 'invalid_sort'; end if;
  if p_from>p_to then raise exception 'invalid_dates'; end if;
  if p_party is not null and p_party not in ('S','M','SD','C','V','KD','MP','L','NONE')
    then raise exception 'invalid_party'; end if;
  select semantic_index_version into index_version from private.search_system_state where singleton;
  vector := p_embedding::extensions.halfvec(1024);
  exact_query := websearch_to_tsquery('pg_catalog.swedish',coalesce(topic,''));
  expanded := private.search_v2_expanded_query(coalesce(topic,''));

  with eligible as materialized (
    select d.* from private.clip_search_documents d
    join public.feed_clip_catalogue c on c.id=d.clip_id
    where (p_person is null or d.politician_id=p_person)
      and (p_party is null or coalesce(d.party_at_speech,'NONE')=p_party)
      and (p_from is null or d.debate_date>=p_from)
      and (p_to is null or d.debate_date<=p_to)
      and (p_sources is null or d.source_id=any(p_sources))
      and c.published_at<=p_snapshot
  ), lexical as materialized (
    select d.*,
      topic is not null and d.search_vector @@ exact_query as exact_match,
      topic is not null and d.search_vector @@ expanded as word_match,
      topic is not null and d.context_vector @@ expanded as context_match,
      topic is not null and private.search_v2_fold(d.title)=private.search_v2_fold(topic) as title_match,
      -- Literal quotes must occur in the actual title/transcript/source, never just a vector.
      not exists(select 1 from regexp_matches(coalesce(topic,''),'["“]([^"”]+)["”]','g') q
        where position(private.search_v2_fold(q[1]) in
          private.search_v2_fold(d.title || ' ' || d.transcript || ' ' || d.source_title))=0) as quotes_match
    from eligible d
  ), semantic_nearest as materialized (
    select ch.clip_id,ch.passage,ch.chunk_no,
      (1-(ch.embedding operator(extensions.<=>) vector))::real as similarity
    from private.clip_search_chunks ch
    join eligible d on d.clip_id=ch.clip_id
    where vector is not null and topic is not null and topic !~ '["“”]'
      and d.semantic_state='current' and d.completed_index_version=search_v2.index_version
      and ch.index_version=search_v2.index_version and ch.source_hash=d.source_hash
    order by (ch.embedding operator(extensions.<=>) vector)+0
    limit 240
  ), semantic as materialized (
    select n.*,
      (select count(*)::real / greatest(1,cardinality(tsvector_to_array(to_tsvector('pg_catalog.swedish',coalesce(topic,'')))))
        from (select unnest(tsvector_to_array(d.search_vector)) intersect
          select unnest(tsvector_to_array(to_tsvector('pg_catalog.swedish',coalesce(topic,''))))) common_terms) as lexical_coverage
    from (select distinct on (clip_id) clip_id,similarity,passage
      from semantic_nearest order by clip_id,similarity desc,chunk_no) n
    join eligible d using(clip_id)
  ), confidence as (
    select exists(select 1 from lexical where exact_match) as anchor,
      coalesce(max(similarity),0) as top_similarity,
      coalesce(max(lexical_coverage) filter(where similarity>=0.35),0) as top_coverage from semantic  ), admitted as (
    select d.*,s.similarity,s.passage,
      case when topic is null then 0
        when d.title_match then 5000
        when topic ~ '["“”]' and d.quotes_match then 4000
        when d.exact_match then 3000
        when d.word_match then 2000
        when d.context_match then 1000 else 0 end
        + coalesce(ts_rank_cd(d.search_vector,exact_query,32),0)*10
        + coalesce(ts_rank_cd(d.search_vector,expanded,32),0)*5
        + coalesce(s.similarity,0) as relevance
    from lexical d left join semantic s on s.clip_id=d.clip_id cross join confidence cf
    where d.quotes_match and (topic is null or d.exact_match or d.word_match or d.context_match
      or (s.similarity>=0.35 and (cf.anchor or cf.top_similarity>=0.53 or cf.top_coverage>=0.67)
        and (s.similarity>=0.50 or s.lexical_coverage>=0.67)))
  ), ordered as (
    select a.*,
      case when p_sort='relevance' then -a.relevance else 0 end::double precision as sort_score,
      case when p_sort='oldest' then extract(epoch from a.debate_date)
        else -extract(epoch from a.debate_date) end::bigint as sort_date
    from admitted a
  ), page as (
    select * from ordered o where p_after is null or
      (o.sort_score,o.sort_date,o.clip_id) >
      ((p_after->>'score')::double precision,(p_after->>'date')::bigint,p_after->>'id')
    order by sort_score,sort_date,clip_id limit page_size+1
  )
  select coalesce(jsonb_agg(
    private.search_clip_result(clip_id,
      case when topic is null then transcript
        when not word_match and not exact_match and context_match then source_title
        when not word_match and not exact_match then coalesce(passage,transcript)
        else ts_headline('pg_catalog.swedish',title || '. ' || transcript,expanded,
          'MaxWords=35, MinWords=12, ShortWord=2, MaxFragments=1') end,
      case when topic is null then 'filtered'
        when word_match or exact_match or context_match then 'keyword' else 'context' end)
      || jsonb_build_object('matchSource',case when not word_match and not exact_match and context_match
          then 'debate' else 'clip' end,
        '_cursor',jsonb_build_object('score',sort_score,'date',sort_date,'id',clip_id))
      order by sort_score,sort_date,clip_id),'[]'::jsonb),
    (select count(*) from eligible),
    (select count(*) from eligible d where d.semantic_state='current'
      and d.completed_index_version=search_v2.index_version and exists(select 1 from private.clip_search_chunks ch
        where ch.clip_id=d.clip_id and ch.source_hash=d.source_hash and ch.index_version=search_v2.index_version))
  into rows,total,covered from page;
  return jsonb_build_object('results',rows,'indexVersion',index_version,
    'semanticCoverage',case when total=0 then 'complete' when covered=total then 'complete'
      when covered=0 then 'none' else 'partial' end);
end;
$fn$;

