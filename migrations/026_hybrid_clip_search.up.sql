-- 026_hybrid_clip_search
--
-- Service-only retrieval, entity-catalogue and abuse-budget RPCs for the public
-- clip-search Edge Function. Query text is accepted only as a transient RPC
-- argument. The only persisted request identifier is a caller-supplied daily
-- HMAC; raw network addresses and search text have no storage column here.

do $preflight$
begin
  if to_regclass('private.clip_search_documents') is null
    or to_regclass('private.clip_search_chunks') is null
    or to_regclass('private.search_events') is null
    or to_regclass('private.search_rate_limit_buckets') is null
    or to_regclass('private.search_system_state') is null
    or to_regclass('public.feed_clip_catalogue') is null then
    raise exception 'topic-search dependencies are missing; apply migrations 022 through 025 first';
  end if;

  if to_regtype('extensions.halfvec') is null then
    raise exception 'pgvector halfvec is unavailable';
  end if;
end;
$preflight$;

create or replace function private.search_excerpt(
  p_value text,
  p_max_length integer default 220
)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $function$
declare
  normalized text;
  candidate text;
  shortened text;
  effective_max integer;
begin
  effective_max := greatest(1, least(coalesce(p_max_length, 220), 220));
  normalized := pg_catalog.btrim(
    pg_catalog.regexp_replace(coalesce(p_value, ''), '[[:space:]]+', ' ', 'g')
  );
  normalized := pg_catalog.regexp_replace(normalized, '<[^>]*>', '', 'g');
  if pg_catalog.char_length(normalized) <= effective_max then
    return normalized;
  end if;

  candidate := pg_catalog.left(normalized, effective_max + 1);
  shortened := pg_catalog.regexp_replace(candidate, '[[:space:]]+[^[:space:]]*$', '');
  if shortened = '' then
    shortened := pg_catalog.left(normalized, effective_max);
  end if;
  return pg_catalog.left(pg_catalog.btrim(shortened), effective_max);
end;
$function$;

create or replace function private.search_clip_result(
  p_clip_id text,
  p_excerpt text,
  p_match_kind text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'clip', pg_catalog.jsonb_build_object(
      'id', catalogue.id,
      'speechId', catalogue.speech_id,
      'politicianId', catalogue.politician_id,
      'politicianName', catalogue.politician_name,
      'politicianRole', catalogue.politician_role,
      'politicianAvatarUrl', catalogue.politician_avatar_url,
      'speakerName', catalogue.speaker_name,
      'party', case
        when catalogue.party in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')
          then catalogue.party
        else 'NONE'
      end,
      'anforandetyp', coalesce(catalogue.anforandetyp, ''),
      'archetype', coalesce(catalogue.archetype, ''),
      'title', catalogue.title,
      'transcript', coalesce(catalogue.transcript, ''),
      'topic', catalogue.topic,
      'durationS', catalogue.duration_s,
      'videoUrl', catalogue.url_540x960,
      'thumbUrl', coalesce(catalogue.thumb_url, ''),
      'sourceTitle', catalogue.source_title,
      'sourceUrl', catalogue.source_url,
      'debateDate', catalogue.debate_date,
      'publishedAt', catalogue.published_at,
      'rank', catalogue.rank_in_speech,
      'isSample', false
    ),
    'speakerNameAtSpeech', document.speaker_name_at_speech,
    'partyAtSpeech', coalesce(document.party_at_speech, 'NONE'),
    'matchExcerpt', private.search_excerpt(p_excerpt, 220),
    'matchKind', p_match_kind
  )
  from private.clip_search_documents document
  join public.feed_clip_catalogue catalogue on catalogue.id = document.clip_id
  where document.clip_id = p_clip_id
    and p_match_kind in ('keyword', 'context', 'both', 'filtered');
$function$;

create or replace function public.load_search_entity_catalog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'people', coalesce((
      select pg_catalog.jsonb_agg(person_row.value order by person_row.label, person_row.id)
      from (
        select
          politician.id,
          politician.name as label,
          pg_catalog.jsonb_build_object(
            'id', politician.id,
            'label', politician.name,
            'party', case
              when politician.party in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')
                then politician.party
              else 'NONE'
            end,
            'aliases', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'value', alias_row.alias,
                  'verified', alias_row.verified,
                  'provenance', alias_row.provenance
                ) order by alias_row.normalized_alias, alias_row.id
              )
              from private.search_person_aliases alias_row
              where alias_row.politician_id = politician.id
                and alias_row.verified
            ), '[]'::jsonb)
          ) as value
        from public.politicians politician
        where exists (
          select 1
          from private.search_person_aliases alias_row
          where alias_row.politician_id = politician.id
            and alias_row.verified
        )
      ) person_row
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(event_row.value order by event_row.date_from, event_row.label, event_row.id)
      from (
        select
          event.id,
          event.canonical_label as label,
          event.date_from,
          pg_catalog.jsonb_build_object(
            'id', event.id,
            'label', event.canonical_label,
            'dateFrom', event.date_from,
            'dateTo', event.date_to,
            'dateLabel', case
              when event.date_from is null then 'Datum saknas'
              when event.date_to is not null and event.date_to <> event.date_from
                then event.date_from::text || '–' || event.date_to::text
              else event.date_from::text
            end,
            'verified', event.verified,
            'aliases', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'value', alias_row.alias,
                  'verified', alias_row.verified,
                  'provenance', alias_row.provenance
                ) order by alias_row.normalized_alias, alias_row.id
              )
              from private.search_event_aliases alias_row
              where alias_row.event_id = event.id
                and alias_row.verified
            ), '[]'::jsonb),
            'sourceIds', coalesce((
              select pg_catalog.jsonb_agg(event_source.source_id order by event_source.source_id)
              from private.search_event_sources event_source
              where event_source.event_id = event.id
            ), '[]'::jsonb)
          ) as value
        from private.search_events event
        where event.verified
          and exists (
            select 1
            from private.search_event_sources event_source
            join private.clip_search_documents document
              on document.source_id = event_source.source_id
            where event_source.event_id = event.id
          )
      ) event_row
    ), '[]'::jsonb)
  );
$function$;

create or replace function public.get_search_event_destination(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', event.id,
    'label', event.canonical_label,
    'dateLabel', case
      when event.date_from is null then 'Datum saknas'
      when event.date_to is not null and event.date_to <> event.date_from
        then event.date_from::text || '–' || event.date_to::text
      else event.date_from::text
    end,
    'sourceUrl', case
      when pg_catalog.count(distinct source.source_url) = 1
        then pg_catalog.min(source.source_url)
      else null
    end,
    'clipCount', pg_catalog.count(distinct document.clip_id)
  )
  from private.search_events event
  join private.search_event_sources event_source on event_source.event_id = event.id
  join public.sources source on source.id = event_source.source_id
  left join private.clip_search_documents document on document.source_id = source.id
  where event.id = p_event_id
    and event.verified
  group by event.id, event.canonical_label, event.date_from, event.date_to;
$function$;

create or replace function public.consume_search_request_limit(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  minute_start timestamptz;
  day_start timestamptz;
  client_minute bigint;
  client_day bigint;
  global_minute bigint;
  global_day bigint;
  allowed boolean;
  reason text;
  retry_after integer;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_search_rate_key' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('search-rate:' || p_key_hash, 0)
  );
  delete from private.search_rate_limit_buckets where expires_at <= now();

  minute_start := pg_catalog.date_trunc('minute', now());
  day_start := (
    pg_catalog.date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
  );

  insert into private.search_rate_limit_buckets (
    scope, key_hash, metric, bucket_kind, bucket_start, counter, expires_at, updated_at
  ) values (
    'client', p_key_hash, 'requests', 'minute', minute_start, 1,
    minute_start + interval '48 hours', now()
  )
  on conflict (scope, key_hash, metric, bucket_kind, bucket_start)
  do update set counter = private.search_rate_limit_buckets.counter + 1, updated_at = now()
  returning counter into client_minute;

  insert into private.search_rate_limit_buckets (
    scope, key_hash, metric, bucket_kind, bucket_start, counter, expires_at, updated_at
  ) values (
    'client', p_key_hash, 'requests', 'day', day_start, 1,
    day_start + interval '48 hours', now()
  )
  on conflict (scope, key_hash, metric, bucket_kind, bucket_start)
  do update set counter = private.search_rate_limit_buckets.counter + 1, updated_at = now()
  returning counter into client_day;

  insert into private.search_rate_limit_buckets (
    scope, key_hash, metric, bucket_kind, bucket_start, counter, expires_at, updated_at
  ) values (
    'global', 'global', 'requests', 'minute', minute_start, 1,
    minute_start + interval '48 hours', now()
  )
  on conflict (scope, key_hash, metric, bucket_kind, bucket_start)
  do update set counter = private.search_rate_limit_buckets.counter + 1, updated_at = now()
  returning counter into global_minute;

  insert into private.search_rate_limit_buckets (
    scope, key_hash, metric, bucket_kind, bucket_start, counter, expires_at, updated_at
  ) values (
    'global', 'global', 'requests', 'day', day_start, 1,
    day_start + interval '48 hours', now()
  )
  on conflict (scope, key_hash, metric, bucket_kind, bucket_start)
  do update set counter = private.search_rate_limit_buckets.counter + 1, updated_at = now()
  returning counter into global_day;

  allowed := client_minute <= 10
    and client_day <= 200
    and global_minute <= 120
    and global_day <= 5000;
  reason := case
    when client_minute > 10 then 'client_minute'
    when client_day > 200 then 'client_day'
    when global_minute > 120 then 'global_minute'
    when global_day > 5000 then 'global_day'
    else null
  end;
  retry_after := case
    when reason in ('client_day', 'global_day') then 86400
    when reason is not null then 60
    else 0
  end;

  return pg_catalog.jsonb_build_object(
    'allowed', allowed,
    'reason', reason,
    'retryAfterSeconds', retry_after
  );
end;
$function$;

create or replace function public.reserve_search_provider_tokens(p_token_count integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  day_start timestamptz;
  global_tokens bigint;
begin
  if p_token_count is null or p_token_count < 1 or p_token_count > 4096 then
    raise exception 'invalid_search_provider_token_reservation' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('search-provider-tokens', 0)
  );
  delete from private.search_rate_limit_buckets where expires_at <= now();
  day_start := (
    pg_catalog.date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
  );

  insert into private.search_rate_limit_buckets (
    scope, key_hash, metric, bucket_kind, bucket_start, counter, expires_at, updated_at
  ) values (
    'global', 'global', 'provider_tokens', 'day', day_start, p_token_count,
    day_start + interval '48 hours', now()
  )
  on conflict (scope, key_hash, metric, bucket_kind, bucket_start)
  do update set
    counter = private.search_rate_limit_buckets.counter + excluded.counter,
    updated_at = now()
  returning counter into global_tokens;

  return pg_catalog.jsonb_build_object(
    'allowed', global_tokens <= 1000000,
    'reason', case when global_tokens > 1000000 then 'global_provider_tokens' else null end,
    'retryAfterSeconds', case when global_tokens > 1000000 then 86400 else 0 end
  );
end;
$function$;

create or replace function public.search_clip_candidates(
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
        pg_catalog.row_number() over (
          order by candidate.similarity desc, candidate.debate_date desc, candidate.clip_id
        ) as retrieval_rank
      from semantic_best candidate
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
      full join semantic_ranked semantic on semantic.clip_id = keyword.clip_id
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

revoke all on function private.search_excerpt(text, integer)
  from public, anon, authenticated;
revoke all on function private.search_clip_result(text, text, text)
  from public, anon, authenticated;
revoke all on function public.load_search_entity_catalog()
  from public, anon, authenticated;
revoke all on function public.get_search_event_destination(uuid)
  from public, anon, authenticated;
revoke all on function public.consume_search_request_limit(text)
  from public, anon, authenticated;
revoke all on function public.reserve_search_provider_tokens(integer)
  from public, anon, authenticated;
revoke all on function public.search_clip_candidates(
  text, text, integer, uuid, text, date, date, uuid[]
) from public, anon, authenticated;

grant execute on function private.search_excerpt(text, integer) to service_role;
grant execute on function private.search_clip_result(text, text, text) to service_role;
grant execute on function public.load_search_entity_catalog() to service_role;
grant execute on function public.get_search_event_destination(uuid) to service_role;
grant execute on function public.consume_search_request_limit(text) to service_role;
grant execute on function public.reserve_search_provider_tokens(integer) to service_role;
grant execute on function public.search_clip_candidates(
  text, text, integer, uuid, text, date, date, uuid[]
) to service_role;

comment on function public.search_clip_candidates(text, text, integer, uuid, text, date, date, uuid[]) is
  'Service-only hybrid/keyword/filtered retrieval. Topic text and embeddings are transient and never stored.';
comment on function public.consume_search_request_limit(text) is
  'Consumes HMAC-only client and global request budgets; no raw address or query is accepted.';
comment on function public.reserve_search_provider_tokens(integer) is
  'Conservatively reserves the global daily provider-token budget before an embedding call.';
