-- Additive search V2. Old RPCs, vectors and embedding hashes remain unchanged.
create extension if not exists pg_trgm with schema extensions;

create function private.search_v2_fold(value text) returns text
language sql immutable parallel safe set search_path = '' as $fn$
  select btrim(regexp_replace(lower(translate(coalesce(value,''),'åäöÅÄÖ','aaoAAO')),
    '[^[:alnum:]]+', ' ', 'g'));
$fn$;

alter table private.clip_search_documents add column context_vector tsvector
  generated always as (to_tsvector('pg_catalog.swedish'::regconfig, source_title)) stored;
create index search_v2_context_idx on private.clip_search_documents using gin(context_vector);

create table private.search_v2_words (
  word text primary key,
  folded text generated always as (private.search_v2_fold(word)) stored
);
alter table private.search_v2_words enable row level security;
create index search_v2_words_trgm_idx on private.search_v2_words using gin(folded extensions.gin_trgm_ops);
create index search_v2_words_folded_idx on private.search_v2_words(folded);
revoke all on private.search_v2_words from public, anon, authenticated;
grant select, insert, delete on private.search_v2_words to service_role;

create function private.search_v2_collect_words() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  insert into private.search_v2_words(word)
  select w from unnest(tsvector_to_array(to_tsvector('pg_catalog.simple',
    new.title || ' ' || new.transcript || ' ' || new.source_title))) w
  where char_length(w) between 3 and 64 on conflict do nothing;
  return new;
end;
$fn$;
create trigger search_v2_collect_words after insert or update of title,transcript,source_title
  on private.clip_search_documents for each row execute function private.search_v2_collect_words();
insert into private.search_v2_words(word)
select distinct w from private.clip_search_documents d,
  lateral unnest(tsvector_to_array(to_tsvector('pg_catalog.simple',
    d.title || ' ' || d.transcript || ' ' || d.source_title))) w
where char_length(w) between 3 and 64 on conflict do nothing;

-- Bounded edit distance prevents a distant compound being treated as a typo.
create function private.search_v2_edit_distance(a text,b text) returns integer
language plpgsql immutable strict parallel safe set search_path = '' as $fn$
declare previous integer[]; current_row integer[]; i integer; j integer;
begin
  if length(a)>64 or length(b)>64 then return 65; end if;
  previous := array(select generate_series(0,length(b)));
  for i in 1..length(a) loop
    current_row := array[i];
    for j in 1..length(b) loop
      current_row := array_append(current_row,least(previous[j+1]+1,current_row[j]+1,
        previous[j]+case when substr(a,i,1)=substr(b,j,1) then 0 else 1 end));
    end loop;
    previous := current_row;
  end loop;
  return previous[length(b)+1];
end;
$fn$;

create function private.search_v2_expanded_query(topic text) returns tsquery
language plpgsql stable set search_path = '' as $fn$
declare tokens text[]; token text; words_query tsquery; token_query tsquery;
  alternative record; position integer:=1; joined text; folded_token text; corrected text;
begin
  if topic ~ '["“”]' then return websearch_to_tsquery('pg_catalog.swedish',topic); end if;
  tokens := regexp_split_to_array(btrim(regexp_replace(lower(topic),'[^[:alnum:]]+',' ','g')),' +');
  while position <= cardinality(tokens) loop
    token := tokens[position];
    -- A split compound is joined only when that word exists in the catalogue.
    if position < cardinality(tokens) then
      joined := token || tokens[position+1];
      if exists(select 1 from private.search_v2_words where folded=private.search_v2_fold(joined)) then
        token := joined; position := position+1;
      end if;
    end if;
    position := position+1;
    token_query := plainto_tsquery('pg_catalog.swedish',token);
    if numnode(token_query)=0 then continue; end if;
    folded_token := private.search_v2_fold(token);
    -- Correct an absent spelling to its nearest real catalogue word before
    -- expanding that word's inflections (e.g. a typo plus a plural ending).
    if length(token)>=6 and not exists(select 1 from private.search_v2_words where folded=folded_token) then
      select folded into corrected from private.search_v2_words
      where folded operator(extensions.%) folded_token
        and extensions.similarity(folded,folded_token)>=0.6
        and private.search_v2_edit_distance(folded,folded_token)<=2
      order by private.search_v2_edit_distance(folded,folded_token),
        extensions.similarity(folded,folded_token) desc,word limit 1;
      folded_token := coalesce(corrected,folded_token);
    end if;
    for alternative in
      select word from private.search_v2_words
      where length(token)>=4 and folded operator(extensions.%) folded_token
        and extensions.similarity(folded,folded_token)>=0.5
        and abs(length(folded)-length(folded_token)) <= greatest(2,length(folded_token)/4)
        and private.search_v2_edit_distance(folded,folded_token) <= greatest(2,length(folded_token)/4)
      order by (folded=folded_token) desc,extensions.similarity(folded,folded_token) desc,word
      limit 4
    loop
      token_query := token_query || plainto_tsquery('pg_catalog.swedish',alternative.word);
    end loop;
    words_query := case when words_query is null then token_query else words_query && token_query end;
  end loop;
  return coalesce(words_query,websearch_to_tsquery('pg_catalog.swedish',topic));
end;
$fn$;

create function public.search_clips_v2(
  p_topic text default null, p_embedding text default null, p_limit integer default 20,
  p_person uuid default null, p_party text default null, p_from date default null,
  p_to date default null, p_sources uuid[] default null, p_sort text default 'relevance',
  p_after jsonb default null, p_snapshot timestamptz default now()
) returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
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
      (select count(*)::real / greatest(1,cardinality(tsvector_to_array(to_tsvector('pg_catalog.swedish',coalesce(topic,'')))))
        from (select unnest(tsvector_to_array(d.search_vector)) intersect
          select unnest(tsvector_to_array(to_tsvector('pg_catalog.swedish',coalesce(topic,''))))) common_terms) as lexical_coverage,
      topic is not null and private.search_v2_fold(d.title)=private.search_v2_fold(topic) as title_match,
      -- Literal quotes must occur in the actual title/transcript/source, never just a vector.
      not exists(select 1 from regexp_matches(coalesce(topic,''),'["“]([^"”]+)["”]','g') q
        where position(private.search_v2_fold(q[1]) in
          private.search_v2_fold(d.title || ' ' || d.transcript || ' ' || d.source_title))=0) as quotes_match
    from eligible d
  ), semantic as materialized (
    -- Exact distance inside the filtered eligible set is the correctness baseline.
    -- Existing HNSW and v3 remain available for measured ANN comparison/rollback.
    select d.clip_id,max(1-(ch.embedding operator(extensions.<=>) vector))::real as similarity,
      (array_agg(ch.passage order by ch.embedding operator(extensions.<=>) vector,ch.chunk_no))[1] as passage
    from eligible d join private.clip_search_chunks ch on ch.clip_id=d.clip_id
    where vector is not null and topic is not null and topic !~ '["“”]'
      and d.semantic_state='current' and d.completed_index_version=search_v2.index_version
      and ch.index_version=search_v2.index_version and ch.source_hash=d.source_hash
    group by d.clip_id
  ), confidence as (
    select exists(select 1 from lexical where exact_match) as anchor,
      coalesce(max(similarity),0) as top_similarity,
      coalesce((select max(l.lexical_coverage) from lexical l join semantic s using(clip_id)
        where s.similarity>=0.35),0) as top_coverage from semantic
  ), admitted as (
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
        and (s.similarity>=0.50 or d.lexical_coverage>=0.67)))
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

revoke all on function private.search_v2_fold(text),private.search_v2_collect_words(),
  private.search_v2_edit_distance(text,text),private.search_v2_expanded_query(text)
  from public,anon,authenticated;
grant execute on function private.search_v2_fold(text),private.search_v2_collect_words(),
  private.search_v2_edit_distance(text,text),private.search_v2_expanded_query(text) to service_role;
revoke all on function public.search_clips_v2(text,text,integer,uuid,text,date,date,uuid[],text,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function public.search_clips_v2(text,text,integer,uuid,text,date,date,uuid[],text,jsonb,timestamptz)
  to service_role;
