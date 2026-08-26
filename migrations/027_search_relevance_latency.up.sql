-- 027_search_relevance_latency
--
-- Additive v2 retrieval and a one-round-trip cold preflight. Migration 026 is
-- intentionally left immutable and callable so rollback can switch the Edge
-- Function back without reconstructing historical SQL.

do $preflight$
begin
  if to_regprocedure(
    'public.search_clip_candidates(text,text,integer,uuid,text,date,date,uuid[])'
  ) is null
    or to_regprocedure('public.consume_search_request_limit(text)') is null
    or to_regprocedure('public.load_search_entity_catalog()') is null then
    raise exception 'migration 026 search RPCs are missing';
  end if;
end;
$preflight$;

create or replace function public.prepare_clip_search_request(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  decision jsonb;
  catalog jsonb;
begin
  decision := public.consume_search_request_limit(p_key_hash);
  if coalesce((decision ->> 'allowed')::boolean, false) then
    catalog := public.load_search_entity_catalog();
  else
    catalog := null;
  end if;
  return pg_catalog.jsonb_build_object(
    'rateLimit', decision,
    'catalog', catalog
  );
end;
$function$;

create or replace function public.search_clip_candidates_v2(
  p_topic text default null,
  p_query_embedding text default null,
  p_limit integer default 20,
  p_politician_id uuid default null,
  p_party text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_source_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  normalized_topic text;
  parsed_topic tsquery;
  query_embedding extensions.halfvec(1024);
  effective_limit integer;
  target_index_version text;
  semantic_available boolean;
  result_rows jsonb;
begin
  normalized_topic := nullif(pg_catalog.btrim(p_topic), '');
  if normalized_topic is not null
    and pg_catalog.char_length(normalized_topic) > 120 then
    raise exception 'topic_must_be_at_most_120_characters' using errcode = '22023';
  end if;
  if p_query_embedding is not null and normalized_topic is null then
    raise exception 'embedding_requires_topic' using errcode = '22023';
  end if;
  if p_party is not null
    and p_party not in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L', 'NONE') then
    raise exception 'invalid_party' using errcode = '22023';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;

  effective_limit := greatest(1, least(coalesce(p_limit, 20), 60));
  select state.semantic_index_version into target_index_version
  from private.search_system_state state
  where state.singleton;

  if p_query_embedding is not null then
    begin
      query_embedding := p_query_embedding::extensions.halfvec(1024);
    exception when others then
      raise exception 'invalid_query_embedding' using errcode = '22023';
    end;
  end if;

  semantic_available := target_index_version is not null and exists (
    select 1
    from private.clip_search_chunks chunk
    join private.clip_search_documents document on document.clip_id = chunk.clip_id
    where document.semantic_state = 'current'
      and document.completed_index_version = target_index_version
      and chunk.index_version = target_index_version
      and chunk.source_hash = document.source_hash
  );

  if normalized_topic is null then
    select coalesce(pg_catalog.jsonb_agg(
      private.search_clip_result(filtered.clip_id, filtered.transcript, 'filtered')
      order by filtered.debate_date desc, filtered.rank_in_speech, filtered.clip_id
    ), '[]'::jsonb)
    into result_rows
    from (
      select
        document.clip_id,
        document.transcript,
        document.debate_date,
        catalogue.rank_in_speech
      from private.clip_search_documents document
      join public.feed_clip_catalogue catalogue on catalogue.id = document.clip_id
      where (p_politician_id is null or document.politician_id = p_politician_id)
        and (p_party is null or coalesce(document.party_at_speech, 'NONE') = p_party)
        and (p_date_from is null or document.debate_date >= p_date_from)
        and (p_date_to is null or document.debate_date <= p_date_to)
        and (p_source_ids is null or document.source_id = any(p_source_ids))
      order by document.debate_date desc, catalogue.rank_in_speech, document.clip_id
      limit effective_limit
    ) filtered;
  else
    parsed_topic := pg_catalog.websearch_to_tsquery(
      'pg_catalog.swedish'::regconfig,
      normalized_topic
    );

    with eligible as (
      select document.*, catalogue.rank_in_speech
      from private.clip_search_documents document
      join public.feed_clip_catalogue catalogue on catalogue.id = document.clip_id
      where (p_politician_id is null or document.politician_id = p_politician_id)
        and (p_party is null or coalesce(document.party_at_speech, 'NONE') = p_party)
        and (p_date_from is null or document.debate_date >= p_date_from)
        and (p_date_to is null or document.debate_date <= p_date_to)
        and (p_source_ids is null or document.source_id = any(p_source_ids))
    ),
    query_terms as (
      select pg_catalog.tsvector_to_array(
        pg_catalog.to_tsvector(
          'pg_catalog.swedish'::regconfig,
          normalized_topic
        )
      ) as lexemes
    ),
    keyword_candidates as (
      select
        document.clip_id,
        pg_catalog.ts_rank_cd(document.search_vector, parsed_topic, 32)::real as strength,
        private.search_excerpt(
          pg_catalog.ts_headline(
            'pg_catalog.swedish'::regconfig,
            document.title || '. ' || document.transcript,
            parsed_topic,
            'MaxWords=35, MinWords=12, ShortWord=2, HighlightAll=false, MaxFragments=1'
          ),
          220
        ) as excerpt,
        document.debate_date,
        document.rank_in_speech
      from eligible document
      where pg_catalog.numnode(parsed_topic) > 0
        and document.search_vector @@ parsed_topic
      order by strength desc, document.debate_date desc, document.clip_id
      limit 120
    ),
    keyword_ranked as (
      select candidate.*,
        pg_catalog.row_number() over (
          order by candidate.strength desc, candidate.debate_date desc, candidate.clip_id
        ) as retrieval_rank
      from keyword_candidates candidate
    ),
    semantic_passages as (
      select
        document.clip_id,
        chunk.chunk_no,
        chunk.passage,
        document.search_vector,
        (1 - (chunk.embedding operator(extensions.<=>) query_embedding))::real as similarity,
        document.debate_date,
        document.rank_in_speech
      from eligible document
      join private.clip_search_chunks chunk on chunk.clip_id = document.clip_id
      where query_embedding is not null
        and target_index_version is not null
        and document.semantic_state = 'current'
        and document.completed_index_version = target_index_version
        and chunk.index_version = target_index_version
        and chunk.source_hash = document.source_hash
        and (1 - (chunk.embedding operator(extensions.<=>) query_embedding)) >= 0.35
      order by
        chunk.embedding operator(extensions.<=>) query_embedding,
        document.debate_date desc,
        document.clip_id,
        chunk.chunk_no
      limit 120
    ),
    semantic_best as (
      select ranked.*
      from (
        select passage.*,
          pg_catalog.row_number() over (
            partition by passage.clip_id
            order by passage.similarity desc, passage.chunk_no
          ) as clip_passage_rank
        from semantic_passages passage
      ) ranked
      where ranked.clip_passage_rank = 1
    ),
    semantic_ranked as (
      select candidate.*,
        case
          when pg_catalog.cardinality(query_terms.lexemes) = 0 then 0::real
          else (
            pg_catalog.cardinality(array(
              select lexeme
              from pg_catalog.unnest(
                pg_catalog.tsvector_to_array(candidate.search_vector)
              ) as document_lexemes(lexeme)
              intersect
              select lexeme
              from pg_catalog.unnest(query_terms.lexemes) as query_lexemes(lexeme)
            ))::real / pg_catalog.cardinality(query_terms.lexemes)
          )
        end as lexical_coverage,
        pg_catalog.row_number() over (
          order by candidate.similarity desc, candidate.debate_date desc, candidate.clip_id
        ) as retrieval_rank
      from semantic_best candidate
      cross join query_terms
    ),
    semantic_confidence as (
      select
        exists(select 1 from keyword_ranked) as has_keyword_anchor,
        coalesce(pg_catalog.max(candidate.similarity), -1::real) as top_similarity,
        coalesce(pg_catalog.max(candidate.lexical_coverage), 0::real) as top_lexical_coverage
      from semantic_ranked candidate
    ),
    semantic_admitted as (
      select candidate.*
      from semantic_ranked candidate
      cross join semantic_confidence confidence
      where confidence.has_keyword_anchor
        or confidence.top_similarity >= 0.53
        or confidence.top_lexical_coverage >= 0.67
    ),
    fused as (
      select
        coalesce(keyword.clip_id, semantic.clip_id) as clip_id,
        keyword.excerpt as keyword_excerpt,
        semantic.passage as semantic_excerpt,
        keyword.retrieval_rank as keyword_retrieval_rank,
        semantic.retrieval_rank as semantic_retrieval_rank,
        coalesce(keyword.debate_date, semantic.debate_date) as debate_date,
        coalesce(keyword.rank_in_speech, semantic.rank_in_speech) as rank_in_speech,
        (
          case when keyword.retrieval_rank is null then 0
            else 1.5 / (50 + keyword.retrieval_rank) end
          + case when semantic.retrieval_rank is null then 0
            else 1.0 / (50 + semantic.retrieval_rank) end
        )::double precision as fusion_score
      from keyword_ranked keyword
      full join semantic_admitted semantic on semantic.clip_id = keyword.clip_id
    ),
    ranked_results as (
      select fused.*
      from fused
      order by
        fused.fusion_score desc,
        fused.debate_date desc,
        fused.rank_in_speech,
        fused.clip_id
      limit effective_limit
    )
    select coalesce(pg_catalog.jsonb_agg(
      private.search_clip_result(
        ranked.clip_id,
        coalesce(ranked.semantic_excerpt, ranked.keyword_excerpt, ''),
        case
          when ranked.keyword_retrieval_rank is not null
            and ranked.semantic_retrieval_rank is not null then 'both'
          when ranked.keyword_retrieval_rank is not null then 'keyword'
          else 'context'
        end
      )
      order by
        ranked.fusion_score desc,
        ranked.debate_date desc,
        ranked.rank_in_speech,
        ranked.clip_id
    ), '[]'::jsonb)
    into result_rows
    from ranked_results ranked;
  end if;

  return pg_catalog.jsonb_build_object(
    'indexVersion', coalesce(target_index_version, 'semantic-index-unavailable'),
    'semanticAvailable', semantic_available,
    'results', coalesce(result_rows, '[]'::jsonb)
  );
end;
$function$;

comment on function public.search_clip_candidates_v2(
  text, text, integer, uuid, text, date, date, uuid[]
) is 'UI16.9 hybrid retrieval with semantic confidence admission; no score is returned';

revoke all on function public.prepare_clip_search_request(text)
  from public, anon, authenticated;
revoke all on function public.search_clip_candidates_v2(
  text, text, integer, uuid, text, date, date, uuid[]
) from public, anon, authenticated;
grant execute on function public.prepare_clip_search_request(text) to service_role;
grant execute on function public.search_clip_candidates_v2(
  text, text, integer, uuid, text, date, date, uuid[]
) to service_role;
